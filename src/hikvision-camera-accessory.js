"use strict";

const { HikvisionCameraStreamingDelegate } = require("./hikvision-camera-streaming-delegate");
const { HikvisionCameraRecordingDelegate } = require("./hikvision-camera-recording-delegate");
const { CameraStateMachine } = require("./camera-state-machine");
const { CameraMetrics } = require("./camera-metrics");
const { HomeKitTalkback } = require("./homekit-talkback");
const { LocalHttpApi } = require("./local-http-api");
const { HikvisionIsapiEventListener } = require("./hikvision-isapi-event-listener");
const { HikvisionIsapiClient } = require("./hikvision-isapi-client");
const { HKSV_PREBUFFER_LENGTH_MS } = require("./hksv-recording-constants");

class HikvisionCameraAccessory {
  constructor(platform, accessory, config) {
    this.platform = platform;
    this.accessory = accessory;
    this.config = config;

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
    this.recordingDelegate = config.hsv === true
      ? new HikvisionCameraRecordingDelegate(platform, config, this.streamingDelegate, this.metrics, this.stateMachine)
      : null;

    this.doorbellService = this.configureDoorbellService(Service, Characteristic);

    this.motionService = null;
    if (this.recordingDelegate) {
      this.motionService = accessory.getServiceById(Service.MotionSensor, "motion")
        || accessory.addService(Service.MotionSensor, `${config.name || "Camera"} Motion`, "motion");
      this.motionService.setHiddenService(true);
    }

    const controllerOptions = {
      cameraStreamCount: normalizedMaxStreams(config.maxStreams),
      delegate: this.streamingDelegate,
      streamingOptions: this.streamingDelegate.streamingOptions(),
    };

    if (this.recordingDelegate) {
      platform.log.info(`HKSV recording options for ${config.name || config.did}: channel=${config.hsvRtspChannel || config.hksvRtspChannel || 101}, audio=${hksvAudioEnabled(config)}, prebufferMs=${hksvPrebufferLengthMs(config)}, fragmentMs=${Number(config.hsvFragmentLengthMs || 4000)}`);
      controllerOptions.sensors = { motion: this.motionService };
      controllerOptions.recording = {
        options: recordingOptions(platform.api.hap, config),
        delegate: this.recordingDelegate,
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

    if (this.recordingDelegate) {
      this.recordingDelegate.setRecordingManagement(this.controller.recordingManagement);
    }

    const triggerSwitch = accessory.getServiceById?.(Service.Switch, "hsv-trigger");
    if (triggerSwitch) accessory.removeService(triggerSwitch);

    if (this.recordingDelegate) {
      platform.log.info(`HomeKit Secure Video enabled for ${config.name || config.did}`);
      this.recordingDelegate.setMotionService(this.motionService);
      setTimeout(() => this.recordingDelegate.logReadiness(), Number(config.hsvReadinessLogDelayMs || 30000)).unref?.();
    }
    this.streamingDelegate.setMotionSink((event) => this.handleMotionEvent(event, Characteristic));
    this.streamingDelegate.startMotionAnalysis();

    this.isapiEventListener = new HikvisionIsapiEventListener(platform, config, {
      onMotion: (event) => this.handleMotionEvent(event, Characteristic),
    });
    this.configureDeviceMotionDetectionArea();
    if (supportsStableIsapiAlertStream(config)) {
      this.isapiEventListener.start();
    } else {
      platform.log.info(`isapi.events.disabled camera=${config.name || config.did || "unknown"} reason=unsupported-door-station-alert-stream`);
    }

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

    platform.api.on("shutdown", () => {
      this.streamingDelegate.stopMotionAnalysis();
      this.streamingDelegate.stopSharedMainInput("homebridge-shutdown");
      this.isapiEventListener.stop();
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
        this.recordingDelegate.triggerRecordingEvent(null, this.config.hsvMotionDurationMs);
        setTimeout(() => service.updateCharacteristic(Characteristic.On, false), 500).unref?.();
      });
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
    if (event?.motionActive === false) {
      clearTimeout(this.motionClearTimer);
      this.stateMachine?.motionCleared("device-motion-inactive");
      this.platform.log.info(`motion.cleared camera=${this.config.name || this.config.did} source=${event?.source || "unknown"}`);
      if (this.recordingDelegate) {
        this.recordingDelegate.clearMotionEvent(event);
      }
      return {
        ok: true,
        source: event?.source || "unknown",
        durationMs: 0,
        hasMotionService: Boolean(this.motionService),
        hksvForwarded: Boolean(this.recordingDelegate),
      };
    }

    this.platform.log.info(`motion.detected camera=${this.config.name || this.config.did} source=${event?.source || "unknown"} durationMs=${durationMs}`);
    this.stateMachine?.motionDetected(durationMs, `motion:${event?.source || "unknown"}`, event);

    clearTimeout(this.motionClearTimer);
    this.motionClearTimer = setTimeout(() => {
      this.stateMachine?.motionCleared("device-motion-clear");
      this.platform.log.info(`motion.cleared camera=${this.config.name || this.config.did}`);
    }, durationMs);
    this.motionClearTimer.unref?.();

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
    if (this.recordingDelegate && this.config.doorbellTriggersHsv !== false) {
      this.recordingDelegate.triggerMotionEvent({
        source: event?.source || "doorbell",
        reason: "doorbell-ring",
        durationMs: Number(this.config.doorbellHsvDurationMs || this.config.hsvMotionDurationMs || 60000),
        force: true,
      });
    }

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

  configureDeviceMotionDetectionArea() {
    if (this.config.configureMotionDetectionArea === false || !this.config.ip) {
      return;
    }
    const model = String(this.config.model || "").trim().toLowerCase();
    if (model.includes("ds-kb8112-im")) {
      return;
    }

    const delayMs = Math.max(Number(this.config.motionDetectionAreaApplyDelayMs ?? 15000), 1000);
    setTimeout(() => {
      this.applyFullFrameMotionDetectionArea().catch((error) => {
        this.platform.log.warn(`hikvision.motion-area.failed camera=${this.config.name || this.config.did} error=${safeDeviceConfigError(error)}`);
      });
    }, delayMs).unref?.();
  }

  async applyFullFrameMotionDetectionArea() {
    const client = new HikvisionIsapiClient(this.config);
    const channel = String(this.config.motionDetectionChannel || 1);
    const path = `/ISAPI/System/Video/inputs/channels/${channel}/motionDetection`;
    const current = await client.get(path);
    const updated = enableFullFrameMotionDetection(current);
    if (!updated || updated === current) {
      this.platform.log.warn(`hikvision.motion-area.unsupported camera=${this.config.name || this.config.did} reason=no-grid-map`);
      return;
    }
    await client.put(path, updated);
    this.platform.log.info(`hikvision.motion-area.applied camera=${this.config.name || this.config.did} channel=${channel} area=full-frame`);
  }

}

function supportsStableIsapiAlertStream(config = {}) {
  const model = String(config.model || "").trim().toLowerCase();
  return !model.includes("ds-kb8112-im");
}

function safeDeviceConfigError(error) {
  return String(error?.message || "unknown").replace(/(password|token|authorization)=?[^ ]*/gi, "$1=[redacted]");
}

function enableFullFrameMotionDetection(xml) {
  if (!/<gridMap\b/i.test(xml)) {
    return null;
  }

  let updated = xml;
  if (/<enabled\b[^>]*>[\s\S]*?<\/enabled>/i.test(updated)) {
    updated = updated.replace(/<enabled\b([^>]*)>[\s\S]*?<\/enabled>/i, "<enabled$1>true</enabled>");
  }

  updated = updated.replace(/<gridMap\b([^>]*)>([\s\S]*?)<\/gridMap>/i, (_match, attrs, value) => {
    const fullFrame = String(value).replace(/[0-9a-f]/gi, (char) => (/\s/.test(char) ? char : "f"));
    return `<gridMap${attrs}>${fullFrame}</gridMap>`;
  });

  return updated;
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
  const prebufferLength = hksvPrebufferLengthMs(config);

  const options = {
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
  };

  if (hksvAudioEnabled(config)) {
    options.audio = {
      codecs: [
        {
          type: hap.AudioRecordingCodecType.AAC_LC,
          bitrateMode: hap.AudioBitrate.VARIABLE,
          samplerate: [
            hap.AudioRecordingSamplerate.KHZ_32,
          ],
          audioChannels: 1,
        },
      ],
    };
  }

  return options;
}

function hksvAudioEnabled(config) {
  return config.hsvAudio !== false && config.hksvAudio !== false;
}

function hksvPrebufferLengthMs(config) {
  return HKSV_PREBUFFER_LENGTH_MS;
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
