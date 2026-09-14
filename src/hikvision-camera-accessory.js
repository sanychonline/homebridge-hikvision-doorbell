"use strict";

const { HikvisionCameraStreamingDelegate } = require("./hikvision-camera-streaming-delegate");
const { HikvisionCameraRecordingDelegate } = require("./hikvision-camera-recording-delegate");
const { CameraStateMachine } = require("./camera-state-machine");
const { CameraMetrics } = require("./camera-metrics");
const { HomeKitTalkback } = require("./homekit-talkback");
const { LocalHttpApi } = require("./local-http-api");
const { HikvisionNativeEventListener } = require("./hikvision-native-event-listener");
const { HikvisionHikConnectCallListener } = require("./hikvision-hikconnect-call-listener");

class HikvisionCameraAccessory {
  constructor(platform, accessory, config) {
    this.platform = platform;
    this.accessory = accessory;
    this.config = config;
    this.doorbellCallSession = null;
    this.doorbellSuppressUntil = 0;

    const { Service, Characteristic } = platform.api.hap;

    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, "Hikvision")
      .setCharacteristic(Characteristic.Model, config.model || "hikvision.camera.v3")
      .setCharacteristic(Characteristic.SerialNumber, String(config.did));

    const powerService = accessory.getServiceById?.(Service.Switch, "power");
    if (powerService) {
      accessory.removeService(powerService);
    }

    this.metrics = new CameraMetrics(config);
    this.stateMachine = new CameraStateMachine(platform, config, this.metrics);
    this.talkback = new HomeKitTalkback(platform, config, this.metrics, this.stateMachine);
    this.streamingDelegate = new HikvisionCameraStreamingDelegate(platform, null, config, this.metrics, this.stateMachine, this.talkback);
    this.streamingDelegate.setLiveStreamSink((event) => this.handleLiveStreamStarted(event));
    this.recordingDelegate = config.hsv === true
      ? new HikvisionCameraRecordingDelegate(platform, config, this.streamingDelegate, this.metrics, this.stateMachine)
      : null;

    this.doorbellService = this.configureDoorbellService(Service, Characteristic);

    const controllerOptions = {
      cameraStreamCount: normalizedMaxStreams(config.maxStreams),
      delegate: this.streamingDelegate,
      streamingOptions: this.streamingDelegate.streamingOptions(),
    };

    if (this.recordingDelegate) {
      controllerOptions.recording = {
        options: recordingOptions(platform.api.hap, config),
        delegate: this.recordingDelegate,
      };
      controllerOptions.sensors = {
        motion: true,
      };
    }

    if (this.doorbellService && platform.api.hap.DoorbellController) {
      controllerOptions.name = `${config.name || "Hikvision Camera"} Doorbell`;
      controllerOptions.externalDoorbellService = this.doorbellService;
      this.controller = new platform.api.hap.DoorbellController(controllerOptions);
    } else {
      this.controller = new platform.api.hap.CameraController(controllerOptions);
    }

    accessory.configureController(this.controller);

    this.motionService = this.configureMotionSensor(Service, Characteristic);

    if (this.recordingDelegate) {
      platform.log.info(`HomeKit Secure Video enabled for ${config.name || config.did}`);
      this.recordingDelegate.setMotionService(this.controller.motionService);
      this.configureHsvTriggerSwitch(Service, Characteristic);
      setTimeout(() => this.recordingDelegate.logReadiness(), Number(config.hsvReadinessLogDelayMs || 30000)).unref?.();
    }
    this.streamingDelegate.setMotionSink((event) => this.handleMotionEvent(event, Characteristic));

    this.localHttpApi = new LocalHttpApi(
      platform,
      config,
      this.streamingDelegate,
      this.recordingDelegate,
      this.metrics,
      this.talkback,
      this.stateMachine,
      null,
      null,
      (event) => this.handleMotionEvent(event, Characteristic),
      (event) => this.triggerDoorbellEvent(event),
    );
    this.localHttpApi.start();

    this.nativeEventListener = new HikvisionNativeEventListener(platform, config, {
      onDoorbell: (event) => this.triggerDoorbellEvent(event),
      onMotion: (event) => this.handleMotionEvent(event, Characteristic),
    });
    this.nativeEventListener.start();
    this.hikConnectCallListener = new HikvisionHikConnectCallListener(platform, config, {
      onDoorbell: (event) => this.triggerDoorbellEvent(event),
      onCallState: (event) => this.handleDoorbellCallState(event),
    });
    this.hikConnectCallListener.start();
    platform.api.on("shutdown", () => {
      this.nativeEventListener.stop();
      this.hikConnectCallListener.stop();
    });
  }

  configureHsvTriggerSwitch(Service, Characteristic) {
    if (this.config.hsvTriggerSwitch === false) {
      return;
    }

    const service = this.accessory.getServiceById?.(Service.Switch, "hsv-trigger")
      || this.accessory.addService(Service.Switch, `${this.config.name || "Hikvision Camera"} HSV Trigger`, "hsv-trigger");

    const onCharacteristic = service.getCharacteristic(Characteristic.On);
    const triggerReadyAt = Date.now() + Number(this.config.hsvTriggerStartupIgnoreMs ?? 10000);
    onCharacteristic.updateValue(false);
    onCharacteristic
      .onSet((value) => {
        if (!value) {
          return;
        }
        if (Date.now() < triggerReadyAt) {
          this.platform.log.info(`Ignoring stale HSV trigger switch restore for ${this.config.name || this.config.did} during startup.`);
          setTimeout(() => service.updateCharacteristic(Characteristic.On, false), 100).unref?.();
          return;
        }
        this.recordingDelegate.triggerRecordingEvent(this.controller.motionService, this.config.hsvMotionDurationMs);
        setTimeout(() => service.updateCharacteristic(Characteristic.On, false), 500).unref?.();
      });
  }

  configureMotionSensor(Service, Characteristic) {
    if (this.config.motionSensor === false) {
      const motionService = this.accessory.getServiceById?.(Service.MotionSensor, "motion");
      if (motionService && !this.controller?.motionService) {
        this.accessory.removeService(motionService);
      }
      return this.controller?.motionService || null;
    }

    const motionService = this.controller?.motionService
      || this.accessory.getServiceById?.(Service.MotionSensor, "motion")
      || this.accessory.addService(Service.MotionSensor, `${this.config.name || "Hikvision Camera"} Motion`, "motion");

    motionService.updateCharacteristic(Characteristic.MotionDetected, false);
    return motionService;
  }

  configureDoorbellService(Service, Characteristic) {
    if (this.config.doorbellService !== true) {
      const existing = this.accessory.getServiceById?.(Service.Doorbell, "doorbell");
      if (existing) {
        this.accessory.removeService(existing);
      }
      return null;
    }

    const service = this.accessory.getServiceById?.(Service.Doorbell, "doorbell")
      || this.accessory.addService(Service.Doorbell, `${this.config.name || "Hikvision Camera"} Doorbell`, "doorbell");
    service.getCharacteristic(Characteristic.ProgrammableSwitchEvent);
    return service;
  }

  handleMotionEvent(event, Characteristic) {
    const durationMs = Math.max(Number(event?.durationMs || this.config.motionHoldMs || this.config.hsvMotionDurationMs || 15000), 1000);
    this.metrics?.increment("homekit_motion_events_total");
    this.platform.log.info(`motion.detected camera=${this.config.name || this.config.did} source=${event?.source || "unknown"} durationMs=${durationMs}`);
    this.stateMachine?.motionDetected(durationMs, `motion:${event?.source || "unknown"}`, event);

    if (this.motionService) {
      this.motionService.updateCharacteristic(Characteristic.MotionDetected, true);
      clearTimeout(this.motionClearTimer);
      this.motionClearTimer = setTimeout(() => {
        this.motionService?.updateCharacteristic(Characteristic.MotionDetected, false);
        this.stateMachine?.motionCleared("homekit-motion-clear");
        this.platform.log.info(`motion.cleared camera=${this.config.name || this.config.did}`);
      }, durationMs);
      this.motionClearTimer.unref?.();
    }

    if (this.recordingDelegate) {
      this.recordingDelegate.triggerMotionEvent(event);
    }

    return {
      ok: true,
      source: event?.source || "unknown",
      durationMs,
      hasMotionService: Boolean(this.motionService),
      hksvForwarded: Boolean(this.recordingDelegate),
    };
  }

  triggerDoorbellEvent(event = {}) {
    if (!this.doorbellService) {
      return {
        ok: false,
        error: "doorbell-service-not-enabled",
      };
    }

    const { Characteristic } = this.platform.api.hap;
    if (this.shouldSuppressDoorbellEvent()) {
      this.platform.log.info(`doorbell.suppressed camera=${this.config.name || this.config.did} source=${event?.source || "unknown"} reason=${event?.reason || "local-event"} callState=${this.doorbellCallSession?.state || "unknown"}`);
      return {
        ok: true,
        suppressed: true,
        source: event?.source || "unknown",
        reason: event?.reason || "local-event",
      };
    }

    this.markDoorbellRinging(event);
    if (typeof this.controller?.ringDoorbell === "function") {
      this.controller.ringDoorbell();
    } else {
      this.doorbellService
        .getCharacteristic(Characteristic.ProgrammableSwitchEvent)
        .updateValue(Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
    }

    this.metrics?.increment("doorbell_events_total");
    this.platform.log.info(`doorbell.ring camera=${this.config.name || this.config.did} source=${event?.source || "unknown"} reason=${event?.reason || "local-event"}`);

    return {
      ok: true,
      source: event?.source || "unknown",
      reason: event?.reason || "local-event",
    };
  }

  shouldSuppressDoorbellEvent() {
    return this.config.doorbellAnswerOnStreamStart === true && Date.now() < this.doorbellSuppressUntil;
  }

  markDoorbellRinging(event = {}) {
    this.doorbellCallSession = {
      state: "ringing",
      source: event?.source || "unknown",
      reason: event?.reason || "local-event",
      callingId: event?.callingId || event?.call?.callingId || null,
      call: event?.call || null,
      ringingAt: Date.now(),
      answeredAt: null,
    };
  }

  handleDoorbellCallState(event = {}) {
    if (event.status === "ringing" && this.doorbellCallSession) {
      this.doorbellCallSession.callingId = event?.callingId || event?.call?.callingId || this.doorbellCallSession.callingId;
      this.doorbellCallSession.call = event?.call || this.doorbellCallSession.call;
      return;
    }
    if (event.status === "call-in-progress" && this.doorbellCallSession) {
      this.doorbellCallSession.state = "answered";
      this.doorbellCallSession.callingId = event?.callingId || event?.call?.callingId || this.doorbellCallSession.callingId;
      this.doorbellCallSession.call = event?.call || this.doorbellCallSession.call;
      return;
    }
    if (event.status !== "idle") {
      return;
    }
    if (this.doorbellCallSession) {
      this.platform.log.info(`doorbell.call.idle camera=${this.config.name || this.config.did} previousState=${this.doorbellCallSession.state}`);
    }
    this.doorbellCallSession = null;
    this.doorbellSuppressUntil = 0;
  }

  handleLiveStreamStarted(event = {}) {
    if (this.config.doorbellAnswerOnStreamStart !== true) {
      return;
    }
    const call = this.doorbellCallSession;
    const answerWindowMs = Math.max(Number(this.config.doorbellAnswerWindowMs ?? 90000), 1000);
    if (!call || call.state !== "ringing" || Date.now() - call.ringingAt > answerWindowMs) {
      return;
    }

    const suppressMs = Math.max(Number(this.config.doorbellSuppressAfterAnswerMs ?? 60000), 1000);
    call.state = "answered";
    call.answeredAt = Date.now();
    call.streamSessionID = event.sessionID;
    this.doorbellSuppressUntil = call.answeredAt + suppressMs;
    this.platform.log.info(`doorbell.call.answered camera=${this.config.name || this.config.did} session=${event.sessionID} source=${call.source} suppressMs=${suppressMs}`);
    if (this.config.hikConnectAnswerOnStreamStart === true && this.hikConnectCallListener) {
      this.hikConnectCallListener.answerCurrentCall(call).catch((error) => {
        this.platform.log.warn(`hikconnect.call-signal camera=${this.config.name || this.config.did} action=answer error=${safeHikConnectAnswerError(error)}`);
      });
    }
  }

}

function safeHikConnectAnswerError(error) {
  const message = String(error?.message || "");
  return /^(hikconnect|missing-hikconnect|invalid-hikconnect|set-explicit)-[a-z0-9-]+$/.test(message)
    ? message : "hikconnect-call-signal-error";
}

function normalizedMaxStreams(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 2;
  }
  return Math.floor(parsed);
}

function recordingOptions(hap, config) {
  const fps = Number(config.hsvFps || config.fps || 30);
  const bitrate = Number(config.hsvBitrateKbps || config.videoBitrateKbps || 1200);
  const resolutions = config.hsvAdvertiseLowResolutionOnly === true
    ? lowResolutionRecordingResolutions(fps)
    : cameraUiRecordingResolutions(fps);
  const prebufferLength = Math.max(
    Number(config.hsvPrebufferLengthMs || 0)
      || Number(config.prebufferLength || 0) * 1000
      || 4000,
    4000,
  );

  return {
    overrideEventTriggerOptions: [
      hap.EventTriggerOption.MOTION,
      hap.EventTriggerOption.DOORBELL,
    ],
    prebufferLength,
    mediaContainerConfiguration: [
      {
        type: hap.MediaContainerType.FRAGMENTED_MP4,
        fragmentLength: Number(config.hsvFragmentLengthMs || 4000),
      },
    ],
    video: {
      type: hap.VideoCodecType.H264,
      parameters: {
        profiles: [
          hap.H264Profile.BASELINE,
          hap.H264Profile.MAIN,
          hap.H264Profile.HIGH,
        ],
        levels: [
          hap.H264Level.LEVEL3_1,
          hap.H264Level.LEVEL3_2,
          hap.H264Level.LEVEL4_0,
        ],
      },
      resolutions,
    },
    audio: {
      codecs: [
        {
          type: hap.AudioRecordingCodecType.AAC_LC,
          bitrateMode: 0,
          samplerate: [
            hap.AudioRecordingSamplerate.KHZ_32,
          ],
          audioChannels: 1,
        },
      ],
    },
  };
}

function cameraUiRecordingResolutions(fps) {
  return [
    [320, 180, fps],
    [320, 240, 15],
    [320, 240, fps],
    [480, 270, fps],
    [480, 360, fps],
    [640, 360, fps],
    [640, 480, fps],
    [1280, 720, fps],
    [1280, 960, fps],
    [1920, 1080, fps],
    [1600, 1200, fps],
  ];
}

function lowResolutionRecordingResolutions(fps) {
  return [
    [320, 180, fps],
    [320, 240, 15],
    [320, 240, fps],
    [480, 270, fps],
    [480, 360, fps],
    [640, 360, fps],
  ];
}

module.exports = { HikvisionCameraAccessory };
