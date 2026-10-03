"use strict";

const { spawn } = require("child_process");
const { MotionEventManager } = require("./motion-event-manager");
const { HKSV_PREBUFFER_LENGTH_MS } = require("./hksv-recording-constants");

const RECORDING_PACKET_KIND = Object.freeze({
  INITIALIZATION: "initialization",
  MEDIA_FRAGMENT: "media-fragment",
});

class HikvisionCameraRecordingDelegate {
  constructor(platform, config, streamingDelegate, metrics, stateMachine) {
    this.platform = platform;
    this.config = config;
    this.streamingDelegate = streamingDelegate;
    this.metrics = metrics;
    this.stateMachine = stateMachine;
    this.recordingActive = false;
    this.recordingConfiguration = null;
    this.recordingManagement = null;
    this.motionService = null;
    this.streams = new Map();
    this.lastRecordingStreamRequestedAt = 0;
    this.lastRecordingStream = null;
    this.lastCloseReason = null;
    this.lastRecordingTrigger = null;
    this.lastFinalFragmentGate = null;
    this.recordingWindowUntil = 0;
    this.prebufferSession = null;
    this.motionEventManager = new MotionEventManager(platform, config, metrics);
  }

  updateRecordingActive(active) {
    this.recordingActive = Boolean(active);
    this.platform.log.info(
      `Hikvision HKSV recording ${this.recordingActive ? "enabled" : "disabled"} for ${this.cameraName()}`,
    );

    if (!this.recordingActive) {
      for (const streamId of this.streams.keys()) {
        this.closeRecordingStream(streamId, "recording-disabled");
      }
      this.stopPrebuffer();
    } else {
      this.ensurePrebuffer();
    }
  }

  updateRecordingConfiguration(configuration) {
    this.recordingConfiguration = configuration || null;
    this.platform.log.info(
      `Hikvision HKSV recording configuration ${configuration ? "selected" : "cleared"} for ${this.cameraName()}`,
    );
    if (configuration) {
      this.ensurePrebuffer();
    } else {
      this.stopPrebuffer();
    }
  }

  ensurePrebuffer() {
    if (!this.recordingActive || !this.recordingConfiguration || this.prebufferSession) {
      return;
    }
    const session = this.startSession(`prebuffer-${Date.now()}`, null, { prebuffer: true });
    this.prebufferSession = session;
    this.platform.log.info(
      `Hikvision HKSV main prebuffer started for ${this.cameraName()}: channel=${this.hksvRtspChannel()}`,
    );
  }

  stopPrebuffer() {
    const session = this.prebufferSession;
    if (!session) {
      return;
    }
    this.prebufferSession = null;
    session.prebufferStopping = true;
    this.finishSession(session.streamId, "prebuffer-stop");
  }

  setMotionService(motionService) {
    this.motionService = motionService || null;
    this.motionEventManager.setMotionService(this.motionService);
  }

  setRecordingManagement(recordingManagement) {
    this.recordingManagement = recordingManagement || null;
  }

  logReadiness() {
    if (!this.recordingConfiguration) {
      this.platform.log.warn(
        `Hikvision HKSV is advertised for ${this.cameraName()}, but Apple Home has not selected a recording configuration. Set the doorbell to Stream & Allow Recording in Home.`,
      );
      return;
    }

    this.platform.log.info(
      `Hikvision HKSV is configured for ${this.cameraName()}: recordingActive=${this.recordingActive}`,
    );
  }

  getStatusSnapshot() {
    return {
      enabled: true,
      active: this.recordingActive,
      hasRecordingConfiguration: Boolean(this.recordingConfiguration),
      activeStreams: this.streams.size,
      lastRecordingStreamRequestedAt: this.lastRecordingStreamRequestedAt || null,
      lastRecordingStream: this.lastRecordingStream,
      recordingDiagnosis: this.recordingDiagnosis(),
      lastCloseReason: this.lastCloseReason,
      lastRecordingTrigger: this.lastRecordingTrigger,
      lastFinalFragmentGate: this.lastFinalFragmentGate,
      recordingWindowUntil: this.recordingWindowUntil || null,
      recordingWindowRemainingMs: this.recordingWindowUntil ? Math.max(0, this.recordingWindowUntil - Date.now()) : 0,
      input: {
        transport: "rtsp",
        channel: this.hksvRtspChannel(),
        rtspUrl: this.redact(this.rtspUrl()),
        audio: this.isRecordingAudioActive(),
        advertisedAudio: this.hksvAudioSupported(),
        audioExpected: this.isRecordingAudioActive(),
        advertisedPrebufferMs: this.hksvPrebufferLengthMs(),
        minFragments: this.minimumMediaFragments(),
        minBytes: this.minimumMediaBytes(),
        audioFinalWaitMs: this.audioFinalWaitMs(),
        minimumCounters: "mdat",
      },
      motion: this.motionEventManager.getStatusSnapshot(),
    };
  }

  triggerRecordingEvent(motionService, durationMs) {
    return this.triggerMotionEvent({
      motionService,
      durationMs,
      source: "homekit-switch",
    });
  }

  triggerMotionEvent(options = {}) {
    if (options.motionActive === false) {
      return this.clearMotionEvent(options);
    }

    const durationMs = Math.max(
      Number(options.durationMs || this.config.hsvMotionDurationMs || this.config.motionHoldMs || 60000),
      1000,
    );
    this.recordingWindowUntil = Math.max(this.recordingWindowUntil, Date.now() + durationMs);
    this.lastRecordingTrigger = {
      source: options.source || "unknown",
      reason: options.reason || "motion-detected",
      durationMs,
      forced: options.force === true,
      triggeredAt: Date.now(),
    };
    const triggered = this.motionEventManager.trigger(durationMs, {
      force: options.force === true,
      reason: options.reason || "motion-detected",
    });

    return {
      ok: triggered,
      source: options.source || "unknown",
      durationMs,
      forced: options.force === true,
      recordingActive: this.recordingActive,
      hasRecordingConfiguration: Boolean(this.recordingConfiguration),
    };
  }

  clearMotionEvent(options = {}) {
    const tailMs = Math.max(
      Number(
        options.tailMs
        || this.config.hsvPostMotionTailMs
        || this.config.hsvMinimumClipDurationMs
        || this.config.hsvMotionDurationMs
        || 15000,
      ),
      Number(this.config.hsvFragmentLengthMs || 4000),
      1000,
    );
    this.recordingWindowUntil = Math.max(this.recordingWindowUntil, Date.now() + tailMs);
    const cleared = this.motionEventManager.clear(options.reason || "motion-inactive");
    return {
      ok: cleared,
      source: options.source || "unknown",
      durationMs: tailMs,
      recordingActive: this.recordingActive,
      hasRecordingConfiguration: Boolean(this.recordingConfiguration),
    };
  }

  async *handleRecordingStreamRequest(streamId, signal) {
    if (!this.recordingActive) {
      throw new Error("Hikvision HKSV recording is not active.");
    }
    if (!this.recordingConfiguration) {
      throw new Error("Hikvision HKSV recording configuration is missing.");
    }

    const requestedAt = Date.now();
    const minimumClipMs = Math.max(
      Number(this.config.hsvMinimumClipDurationMs || this.config.hsvMotionDurationMs || 15000),
      4000,
    );
    this.recordingWindowUntil = Math.max(this.recordingWindowUntil, requestedAt + minimumClipMs);
    this.lastRecordingStreamRequestedAt = requestedAt;
    this.lastRecordingStream = {
      streamId,
      status: "starting",
      requestedAt,
      fragments: 0,
      bytes: 0,
      finalFragmentSent: false,
      error: null,
    };

    // The prebuffer is a rolling cache, not a live recording transport. Reusing
    // it here can flush a few cached fragments in one burst and then leave
    // HomeKit without a continuous stream. Start a dedicated session for the
    // recording so fragments keep arriving until the motion window ends.
    const session = this.startSession(streamId, signal);
    session.streamId = streamId;
    session.consumerActive = true;
    this.lastRecordingStream = {
      ...this.lastRecordingStream,
      audioExpected: session.audioEnabled,
    };
    this.streams.set(streamId, session);
    this.motionEventManager.recordingStarted(streamId);
    this.metrics?.recordHksvStarted?.();
    this.stateMachine?.recordingStarted?.(`hksv:${streamId}`);
    this.platform.log.info(`Hikvision HKSV RTSP recording requested for ${this.cameraName()}: stream=${streamId}`);

    let emitted = 0;
    let emittedBytes = 0;
    let emittedMediaFragments = 0;
    let emittedMediaBytes = 0;
    let emittedVideoFragments = 0;
    let emittedVideoBytes = 0;
    let emittedAudioFragments = 0;
    let emittedAudioBytes = 0;
    let finalFragmentSent = false;

    try {
      const packetSource = session.prebuffer
        ? this.prebufferPacketIterator(session, signal)
        : this.packetIterator(session);
      for await (const recordingPacket of packetSource) {
        if (session.closed || session.consumerActive === false) {
          break;
        }

          if (recordingPacket.kind === RECORDING_PACKET_KIND.INITIALIZATION) {
            this.platform.log.info(
              `Hikvision HKSV initialization packet for ${this.cameraName()}: stream=${streamId}, bytes=${recordingPacket.data.length}, videoTrackIds=${Array.from(session.parser.videoTrackIds || []).join(",") || "unknown"}, audioTrackIds=${Array.from(session.parser.audioTrackIds || []).join(",") || "none"}`,
            );
            yield { data: recordingPacket.data, isLast: false };
            continue;
          }

          const fragment = recordingPacket.data;
          const fragmentSummary = summarizeMp4Fragment(fragment, session.parser.videoTrackIds, session.parser.audioTrackIds);
          emitted += 1;
          emittedBytes += fragment.length;
          if (fragmentSummary.mediaDataBytes > 0) {
            emittedMediaFragments += 1;
            emittedMediaBytes += fragmentSummary.mediaDataBytes;
          }
          if (fragmentSummary.videoMediaBytes > 0) {
            emittedVideoFragments += 1;
            emittedVideoBytes += fragmentSummary.videoMediaBytes;
          }
          if (fragmentSummary.audioMediaBytes > 0) {
            emittedAudioFragments += 1;
            emittedAudioBytes += fragmentSummary.audioMediaBytes;
          }
          session.firstFragmentSeen = true;
          clearTimeout(session.startupTimer);
          this.armFragmentWatchdog(streamId, session);

          const isLast = this.shouldEndRecording(signal, {
            streamId,
            fragments: emittedVideoFragments,
            bytes: emittedVideoBytes,
            audioFragments: emittedAudioFragments,
            audioBytes: emittedAudioBytes,
            audioExpected: session.audioEnabled,
            requestedAt,
          });
          finalFragmentSent = isLast;
          this.lastRecordingStream = {
            ...this.lastRecordingStream,
            status: isLast ? "completed" : "streaming",
            startedAt: this.lastRecordingStream.startedAt || Date.now(),
            fragments: emitted,
            bytes: emittedBytes,
            mediaFragments: emittedMediaFragments,
            mediaBytes: emittedMediaBytes,
            videoFragments: emittedVideoFragments,
            videoBytes: emittedVideoBytes,
            audioFragments: emittedAudioFragments,
            audioBytes: emittedAudioBytes,
            videoTrackIds: Array.from(session.parser.videoTrackIds || []),
            audioTrackIds: Array.from(session.parser.audioTrackIds || []),
            videoPresent: emittedVideoBytes > 0,
            audioPresent: emittedAudioBytes > 0,
            audioDetected: emittedAudioBytes > 0,
            audioExpected: session.audioEnabled,
            finalFragmentSent: isLast,
          };
          this.metrics?.increment?.("hksv_fragments_total");

          if (emitted <= 3 || isLast || this.config.hsvFfmpegDebug === true) {
            this.platform.log.info(
              `Hikvision HKSV fragment for ${this.cameraName()}: stream=${streamId}, index=${emitted}, bytes=${fragment.length}, mediaIndex=${emittedMediaFragments}, mediaBytes=${fragmentSummary.mediaDataBytes}, videoBytes=${fragmentSummary.videoMediaBytes}, audioBytes=${fragmentSummary.audioMediaBytes}, totalMediaBytes=${emittedMediaBytes}, totalVideoBytes=${emittedVideoBytes}, totalAudioBytes=${emittedAudioBytes}, videoTrackIds=${Array.from(session.parser.videoTrackIds || []).join(",") || "unknown"}, audioTrackIds=${Array.from(session.parser.audioTrackIds || []).join(",") || "unknown"}, boxes=${fragmentSummary.boxes.join("+") || "unknown"}, hasMedia=${fragmentSummary.hasMedia}, hasVideo=${fragmentSummary.hasVideo}, hasAudio=${fragmentSummary.hasAudio}, isLast=${isLast}`,
            );
          }

          yield { data: fragment, isLast };
          if (isLast) {
            return;
          }
      }

      if (!session.closed && emitted === 0) {
        throw new Error(session.exitError || "Hikvision HKSV FFmpeg ended before producing a fragment.");
      }
      if (!session.closed && !finalFragmentSent) {
        throw new Error(session.exitError || "Hikvision HKSV FFmpeg ended unexpectedly.");
      }
    } catch (error) {
      this.lastRecordingStream = {
        ...this.lastRecordingStream,
        status: "failed",
        error: this.redact(error.message),
      };
      this.metrics?.increment?.("hksv_failures_total");
      throw error;
    } finally {
      this.finishSession(streamId, "generator-finished");
      this.motionEventManager.recordingStopped(streamId);
      this.metrics?.recordHksvEnded?.();
      this.stateMachine?.recordingStopped?.(`hksv:${streamId}`);
      this.lastRecordingStream = {
        ...this.lastRecordingStream,
        completedAt: Date.now(),
        durationMs: Date.now() - requestedAt,
        fragments: emitted,
        bytes: emittedBytes,
        mediaFragments: emittedMediaFragments,
        mediaBytes: emittedMediaBytes,
        videoFragments: emittedVideoFragments,
        videoBytes: emittedVideoBytes,
        audioFragments: emittedAudioFragments,
        audioBytes: emittedAudioBytes,
        videoTrackIds: Array.from(session.parser.videoTrackIds || []),
        audioTrackIds: Array.from(session.parser.audioTrackIds || []),
        videoPresent: emittedVideoBytes > 0,
        audioPresent: emittedAudioBytes > 0,
        audioDetected: emittedAudioBytes > 0,
        audioExpected: session.audioEnabled,
        finalFragmentSent,
        closeReason: this.lastCloseReason?.streamId === streamId ? this.lastCloseReason.reason : this.lastRecordingStream?.closeReason,
        exitError: this.lastCloseReason?.streamId === streamId ? this.lastCloseReason.exitError : this.lastRecordingStream?.exitError,
      };
      if (this.recordingActive) {
        setTimeout(() => this.ensurePrebuffer(), 1000).unref?.();
      }
    }
  }

  acknowledgeStream(streamId) {
    this.platform.log.info(`Hikvision HKSV recording acknowledged for ${this.cameraName()}: stream=${streamId}`);
    this.closeRecordingStream(streamId, "acknowledged");
  }

  closeRecordingStream(streamId, reason) {
    this.finishSession(streamId, reasonName(reason));
  }

  startSession(streamId, signal, options = {}) {
    const ffmpeg = this.config.ffmpeg || "/usr/local/bin/ffmpeg";
    const videoCodecConfiguration = this.recordingConfiguration?.videoCodec || {};
    const videoParameters = videoCodecConfiguration.parameters || {};
    const mediaContainerConfiguration = this.recordingConfiguration?.mediaContainerConfiguration || {};
    const fragmentLengthMs = Math.max(Number(mediaContainerConfiguration.fragmentLength || 4000), 1000);
    // Every HomeKit media fragment must start with a key frame. Keep the
    // muxer fragment duration aligned with the selected HomeKit duration so
    // the keyframe boundary and the fMP4 boundary cannot diverge.
    const outputFragmentLengthMs = fragmentLengthMs;
    const resolution = Array.isArray(videoCodecConfiguration.resolution) ? videoCodecConfiguration.resolution : [];
    const width = Math.max(Number(resolution[0] || this.config.hsvEncodeWidth || this.config.hsvWidth || 1280), 160);
    const height = Math.max(Number(resolution[1] || this.config.hsvEncodeHeight || this.config.hsvHeight || 720), 120);
    const fps = Math.max(Number(resolution[2] || this.config.hsvFps || 20), 1);
    const bitrateKbps = Math.max(Number(videoParameters.bitRate || this.config.hsvBitrateKbps || 1200), 256);
    const iFrameIntervalMs = Math.max(Number(videoParameters.iFrameInterval || fragmentLengthMs), 1000);
    const keyframeInterval = Math.max(Math.round(fps * fragmentLengthMs / 1000), 1);
    const selectedVideoProfile = selectedH264Profile(this.platform.api.hap, videoParameters.profile);
    const selectedVideoLevel = selectedH264Level(this.platform.api.hap, videoParameters.level);
    const audioSampleRate = selectedAudioSampleRate(this.platform.api.hap, this.recordingConfiguration);
    const audioBitrateKbps = Math.max(Number(this.recordingConfiguration?.audioCodec?.bitrate || 32), 16);
    const audioEnabled = this.isRecordingAudioActive();
    const sharedInput = this.streamingDelegate.createSharedMainInput(`hksv:${streamId}`);
    const args = [
      "-hide_banner",
      "-loglevel",
      this.config.hsvFfmpegDebug === true ? "info" : "warning",
      "-probesize",
      "262144",
      "-analyzeduration",
      "1000000",
      "-fflags",
      "+genpts",
    ];
    if (this.config.hsvUseWallclockTimestamps === true) {
      args.push("-use_wallclock_as_timestamps", "1");
    }
    args.push(
      "-i",
      "pipe:0",
      "-map",
      "0:v:0",
    );

    if (audioEnabled) {
      args.push(
        "-map",
        "0:a:0?",
        "-c:a",
        "aac",
        "-profile:a",
        "aac_low",
        "-ar",
        String(audioSampleRate),
        "-ac",
        "1",
        "-b:a",
        `${audioBitrateKbps}k`,
      );
    } else {
      args.push("-an");
    }

    const videoCodec = normalizeHksvVideoCodec(this.config.hsvVideoCodec, this.config);
    args.push("-c:v", videoCodec);
    if (videoCodec !== "copy") {
      args.push(
        "-preset",
        String(this.config.hsvVideoPreset || "faster"),
        "-tune",
        "zerolatency",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        selectedVideoProfile,
        "-level:v",
        selectedVideoLevel,
        "-x264-params",
        "repeat-headers=1:scenecut=0",
        "-r",
        String(fps),
        "-g",
        String(keyframeInterval),
        "-keyint_min",
        String(keyframeInterval),
        "-sc_threshold",
        "0",
        "-bf",
        "0",
        "-s",
        `${width}x${height}`,
        "-b:v",
        `${bitrateKbps}k`,
        "-force_key_frames",
        `expr:gte(t,n_forced*${fragmentLengthMs / 1000})`,
      );
    }
    args.push(
      "-dn",
      "-sn",
      "-movflags",
      "frag_keyframe+empty_moov+default_base_moof",
      "-frag_duration",
      String(outputFragmentLengthMs * 1000),
      "-min_frag_duration",
      String(outputFragmentLengthMs * 1000),
      "-flush_packets",
      "1",
      "-muxdelay",
      "0",
      "-muxpreload",
      "0",
      "-video_track_timescale",
      "90000",
      "-avoid_negative_ts",
      "make_zero",
      "-f",
      "mp4",
      "pipe:1",
    );

    const proc = spawn(ffmpeg, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    sharedInput.pipe(proc.stdin);
    const session = {
      streamId,
      abortSignal: signal,
      proc,
      parser: new FragmentedMp4Parser(),
      audioEnabled,
      fragmentLengthMs,
      iFrameIntervalMs,
      closed: false,
      stderr: [],
      exitError: null,
      firstFragmentSeen: false,
      abortHandler: null,
      startupTimer: null,
      fragmentTimer: null,
      prebuffer: options.prebuffer === true,
      consumerActive: options.prebuffer !== true,
      prebufferQueue: [],
      prebufferWaiters: [],
      prebufferParser: options.prebuffer === true ? new FragmentedMp4Parser() : null,
      prebufferStopping: false,
      prebufferLoggedInitialization: false,
      prebufferLoggedMedia: false,
      sharedInput,
    };
    if (session.prebuffer) {
      session.parser = session.prebufferParser;
    }
    this.platform.log.info(`Hikvision HKSV FFmpeg configured for ${this.cameraName()}: channel=${this.hksvRtspChannel()}, source=shared-upstream-101, audio=${audioEnabled}, audioSampleRate=${audioEnabled ? audioSampleRate : "disabled"}, audioBitrate=${audioEnabled ? `${audioBitrateKbps}k` : "disabled"}, ${width}x${height}@${fps}, bitrate=${bitrateKbps}k, fragmentLengthMs=${fragmentLengthMs}, outputFragmentLengthMs=${outputFragmentLengthMs}, iFrameIntervalMs=${iFrameIntervalMs}, keyframeInterval=${keyframeInterval}, videoCodec=${videoCodec}, videoProfile=${selectedVideoProfile}, videoLevel=${selectedVideoLevel}`);

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (data) => {
      const lines = String(data).split(/\r?\n/).filter(Boolean).map((line) => this.redact(line));
      session.stderr.push(...lines);
      if (session.stderr.length > 20) {
        session.stderr.splice(0, session.stderr.length - 20);
      }
      if (this.config.hsvFfmpegDebug === true) {
        for (const line of lines) {
          this.platform.log.debug(`Hikvision HKSV FFmpeg: ${line}`);
        }
      }
    });

    proc.once("error", (error) => {
      session.exitError = this.redact(error.message);
    });
    proc.once("exit", (code, exitSignal) => {
      if (!session.closed && code !== 0) {
        session.exitError = `Hikvision HKSV FFmpeg exited code=${code} signal=${exitSignal || "none"}: ${session.stderr.slice(-4).join(" | ")}`;
      }
      if (session.prebuffer) {
        const detail = session.stderr.slice(-4).join(" | ") || "no stderr";
        this.platform.log.warn(
          `Hikvision HKSV main prebuffer exited for ${this.cameraName()}: code=${code}, signal=${exitSignal || "none"}, detail=${detail}`,
        );
        if (!session.prebufferStopping && this.prebufferSession === session && this.recordingActive) {
          this.prebufferSession = null;
          setTimeout(() => this.ensurePrebuffer(), 2000).unref?.();
        }
      }
    });

    if (session.prebuffer) {
      proc.stdout.on("data", (chunk) => this.enqueuePrebufferPackets(session, chunk));
    }

    session.abortHandler = () => this.finishSession(streamId, "aborted");
    signal?.addEventListener?.("abort", session.abortHandler, { once: true });

    if (!session.prebuffer) {
      const startupTimeoutMs = Math.max(Number(this.config.hsvStartupTimeoutMs || 20000), 5000);
      session.startupTimer = setTimeout(() => {
        if (!session.firstFragmentSeen && !session.closed) {
          session.exitError = `Hikvision HKSV FFmpeg produced no fragment within ${startupTimeoutMs}ms.`;
          this.finishSession(streamId, "startup-timeout");
        }
      }, startupTimeoutMs);
      session.startupTimer.unref?.();
      this.armFragmentWatchdog(streamId, session);
    }

    return session;
  }

  async *packetIterator(session) {
    const stdout = session.proc.stdout;
    if (!stdout) {
      return;
    }
    for await (const chunk of stdout) {
      if (session.closed || session.consumerActive === false) {
        return;
      }
      for (const packet of session.parser.push(chunk)) {
        yield packet;
      }
    }
  }

  enqueuePrebufferPackets(session, chunk) {
    if (session.closed || session.prebufferStopping) {
      return;
    }
    for (const packet of session.prebufferParser.push(chunk)) {
      if (packet.kind === RECORDING_PACKET_KIND.INITIALIZATION) {
        if (!session.prebufferLoggedInitialization) {
          session.prebufferLoggedInitialization = true;
          this.platform.log.info(
            `Hikvision HKSV main prebuffer initialization ready for ${this.cameraName()}: bytes=${packet.data.length}`,
          );
        }
        session.prebufferQueue = session.prebufferQueue.filter(
          (queued) => queued.kind !== RECORDING_PACKET_KIND.INITIALIZATION,
        );
        session.prebufferQueue.unshift(packet);
      } else {
        if (!session.prebufferLoggedMedia) {
          session.prebufferLoggedMedia = true;
          this.platform.log.info(
            `Hikvision HKSV main prebuffer media ready for ${this.cameraName()}: bytes=${packet.data.length}`,
          );
        }
        session.prebufferQueue.push(packet);
      }
      while (session.prebufferQueue.length > 8) {
        const mediaIndex = session.prebufferQueue.findIndex(
          (queued) => queued.kind === RECORDING_PACKET_KIND.MEDIA_FRAGMENT,
        );
        if (mediaIndex < 0) break;
        session.prebufferQueue.splice(mediaIndex, 1);
      }
    }
    while (session.prebufferWaiters.length && session.prebufferQueue.length) {
      session.prebufferWaiters.shift()(session.prebufferQueue.shift());
    }
  }

  async *prebufferPacketIterator(session, signal) {
    while (!session.closed && !session.prebufferStopping) {
      if (signal?.aborted || session.consumerActive === false) {
        return;
      }
      if (session.prebufferQueue.length) {
        yield session.prebufferQueue.shift();
        continue;
      }
      const packet = await new Promise((resolve) => {
        const waiter = (value) => {
          signal?.removeEventListener?.("abort", onAbort);
          resolve(value);
        };
        const onAbort = () => {
          const index = session.prebufferWaiters.indexOf(waiter);
          if (index >= 0) session.prebufferWaiters.splice(index, 1);
          resolve(null);
        };
        session.prebufferWaiters.push(waiter);
        signal?.addEventListener?.("abort", onAbort, { once: true });
      });
      if (!packet) return;
      yield packet;
    }
  }

  armFragmentWatchdog(streamId, session) {
    clearTimeout(session.fragmentTimer);
    if (session.closed) {
      return;
    }

    const timeoutMs = Math.max(
      Number(this.config.hsvFragmentTimeoutMs || this.config.hsvStartupTimeoutMs || 20000),
      Number(session.fragmentLengthMs || 4000) * 2,
      5000,
    );
    session.fragmentTimer = setTimeout(() => {
      if (session.closed || session.consumerActive === false) {
        return;
      }
      const state = session.firstFragmentSeen ? "stalled" : "startup";
      session.exitError = `Hikvision HKSV FFmpeg ${state} without a media fragment for ${timeoutMs}ms.`;
      this.platform.log.warn(`Hikvision HKSV recording ${state} for ${this.cameraName()}: stream=${streamId}, timeoutMs=${timeoutMs}`);
      this.finishSession(streamId, `fragment-${state}-timeout`);
    }, timeoutMs);
    session.fragmentTimer.unref?.();
  }

  finishSession(streamId, reason) {
    if (!this.streams.get(streamId)) {
      if (this.prebufferSession?.streamId === streamId && this.prebufferSession.prebufferStopping) {
        this.streams.set(streamId, this.prebufferSession);
      } else {
        return;
      }
    }
    const activeSession = this.streams.get(streamId);
    if (!activeSession || (activeSession.closed && !activeSession.prebufferStopping)) {
      return;
    }

    if (activeSession.prebuffer && !activeSession.prebufferStopping) {
      activeSession.consumerActive = false;
      activeSession.prebufferStopping = true;
      activeSession.closed = true;
      clearTimeout(activeSession.startupTimer);
      clearTimeout(activeSession.fragmentTimer);
      try {
        activeSession.sharedInput?.destroy();
        activeSession.proc.stdin?.end();
        activeSession.proc.stdout?.destroy();
        activeSession.proc.stderr?.destroy();
        activeSession.proc.kill("SIGTERM");
      } catch (_error) {
        // Process may already be gone.
      }
      if (this.prebufferSession === activeSession) {
        this.prebufferSession = null;
      }
      this.streams.delete(streamId);
      for (const waiter of activeSession.prebufferWaiters.splice(0)) waiter(null);
      this.platform.log.info(`Hikvision HKSV recording closed for ${this.cameraName()}: stream=${streamId}, reason=${reason}`);
      return;
    }

    const session = activeSession;
    session.closed = true;
    this.lastCloseReason = {
      streamId,
      reason: reasonName(reason),
      closedAt: Date.now(),
      exitError: session.exitError ? this.redact(session.exitError) : null,
    };
    if (this.lastRecordingStream?.streamId === streamId) {
      this.lastRecordingStream = {
        ...this.lastRecordingStream,
        status: session.exitError ? "failed" : this.lastRecordingStream.status,
        closeReason: this.lastCloseReason.reason,
        exitError: this.lastCloseReason.exitError,
      };
    }
    clearTimeout(session.startupTimer);
    clearTimeout(session.fragmentTimer);
    session.abortSignal?.removeEventListener?.("abort", session.abortHandler);
    this.streams.delete(streamId);

      try {
      session.sharedInput?.destroy();
      session.proc.stdin?.end();
      session.proc.stdout?.destroy();
      session.proc.stderr?.destroy();
      session.proc.kill("SIGTERM");
    } catch (_error) {
      // Process may already be gone.
    }

    const pid = session.proc.pid;
    setTimeout(() => {
      if (!pid) {
        return;
      }
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch (_error) {
        // Process exited normally.
      }
    }, Math.max(Number(this.config.hsvStreamKillTimeoutMs || 3000), 500)).unref?.();

    this.platform.log.info(`Hikvision HKSV recording closed for ${this.cameraName()}: stream=${streamId}, reason=${reason}`);
  }

  shouldEndRecording(signal, progress = {}) {
    if (signal?.aborted) {
      this.lastFinalFragmentGate = {
        streamId: progress.streamId || null,
        allowed: true,
        reason: "homekit-abort",
        fragments: Number(progress.fragments || 0),
        bytes: Number(progress.bytes || 0),
        updatedAt: Date.now(),
      };
      return true;
    }
    if (!this.hasMinimumMediaForFinalFragment(progress)) {
      if (Date.now() >= this.recordingWindowUntil && !this.isMotionActive()) {
        this.lastFinalFragmentGate = {
          streamId: progress.streamId || null,
          allowed: false,
          reason: "waiting-for-minimum-media",
          fragments: Number(progress.fragments || 0),
          bytes: Number(progress.bytes || 0),
          audioFragments: Number(progress.audioFragments || 0),
          audioBytes: Number(progress.audioBytes || 0),
          audioExpected: progress.audioExpected === true,
          audioRequired: this.audioRequiredForFinalFragment(progress),
          minFragments: this.minimumMediaFragments(),
          minBytes: this.minimumMediaBytes(),
          updatedAt: Date.now(),
        };
      }
      return false;
    }
    if (!this.hasMinimumAudioForFinalFragment(progress)) {
      const waitUntil = Number(progress.requestedAt || 0) + this.audioFinalWaitMs();
      if (Date.now() < waitUntil) {
        this.lastFinalFragmentGate = {
          streamId: progress.streamId || null,
          allowed: false,
          reason: "waiting-for-audio-media",
          fragments: Number(progress.fragments || 0),
          bytes: Number(progress.bytes || 0),
          audioFragments: Number(progress.audioFragments || 0),
          audioBytes: Number(progress.audioBytes || 0),
          audioExpected: progress.audioExpected === true,
          audioRequired: this.audioRequiredForFinalFragment(progress),
          minFragments: this.minimumMediaFragments(),
          minBytes: this.minimumMediaBytes(),
          audioWaitRemainingMs: Math.max(0, waitUntil - Date.now()),
          updatedAt: Date.now(),
        };
        return false;
      }
    }
    const shouldEnd = Date.now() >= this.recordingWindowUntil && !this.isMotionActive();
    this.lastFinalFragmentGate = {
      streamId: progress.streamId || null,
      allowed: shouldEnd,
      reason: shouldEnd ? "recording-window-complete" : "recording-window-active",
      fragments: Number(progress.fragments || 0),
      bytes: Number(progress.bytes || 0),
      minFragments: this.minimumMediaFragments(),
      minBytes: this.minimumMediaBytes(),
      audioFragments: Number(progress.audioFragments || 0),
      audioBytes: Number(progress.audioBytes || 0),
      audioExpected: progress.audioExpected === true,
      audioRequired: this.audioRequiredForFinalFragment(progress),
      updatedAt: Date.now(),
    };
    return shouldEnd;
  }

  hasMinimumMediaForFinalFragment(progress = {}) {
    const fragments = Number(progress.fragments || 0);
    const bytes = Number(progress.bytes || 0);
    return fragments >= this.minimumMediaFragments() && bytes >= this.minimumMediaBytes();
  }

  minimumMediaFragments() {
    return Math.max(Number(this.config.hsvMinimumMediaFragments || 2), 1);
  }

  minimumMediaBytes() {
    return Math.max(Number(this.config.hsvMinimumMediaBytes || 256 * 1024), 0);
  }

  hasMinimumAudioForFinalFragment(progress = {}) {
    if (!this.audioRequiredForFinalFragment(progress)) {
      return true;
    }
    return Number(progress.audioFragments || 0) > 0 && Number(progress.audioBytes || 0) > 0;
  }

  audioRequiredForFinalFragment(progress = {}) {
    return progress.audioExpected === true && this.config.hsvRequireAudioForFinal !== false;
  }

  audioFinalWaitMs() {
    return Math.max(
      Number(this.config.hsvAudioFinalWaitMs || this.config.hksvAudioFinalWaitMs || 0)
        || Number(this.config.hsvFragmentLengthMs || 4000) * 2,
      1000,
    );
  }

  isMotionActive() {
    try {
      const Characteristic = this.platform.api?.hap?.Characteristic;
      if (this.motionService && Characteristic?.MotionDetected) {
        return Boolean(this.motionService.getCharacteristic(Characteristic.MotionDetected).value);
      }
    } catch (_error) {
      // Fall through to the motion manager state.
    }

    const motion = this.motionEventManager.getStatusSnapshot();
    return Boolean(motion?.motionActiveUntil && Date.now() < Number(motion.motionActiveUntil));
  }

  rtspUrl() {
    const configured = this.config.hsvRtspUrl || this.config.hksvRtspUrl;
    if (configured) {
      const url = new URL(configured);
      if (!url.username && this.config.username) {
        url.username = this.config.username;
      }
      if (!url.password && this.config.password) {
        url.password = this.config.password;
      }
      return url.toString();
    }

    const host = this.config.ip || this.config.host;
    const port = Number(this.config.rtspPort || 554);
    const channel = String(this.hksvRtspChannel());
    const streamPath = this.config.hsvRtspPath || this.config.hksvRtspPath || `/Streaming/Channels/${channel}`;
    const url = new URL(`rtsp://${host}:${port}${streamPath.startsWith("/") ? streamPath : `/${streamPath}`}`);
    url.username = this.config.username || "admin";
    url.password = this.config.password || "";
    return url.toString();
  }

  hksvRtspChannel() {
    const channel = Number(this.config.hsvRtspChannel || this.config.hksvRtspChannel || 101);
    if (Number.isInteger(channel) && channel > 0) {
      return channel;
    }
    return 101;
  }

  hksvAudioSupported() {
    return this.config.hsvAudio !== false && this.config.hksvAudio !== false;
  }

  isRecordingAudioActive() {
    if (!this.hksvAudioSupported()) {
      return false;
    }

    const Characteristic = this.platform.api?.hap?.Characteristic;
    const operatingModeService = this.recordingManagement?.operatingModeService;
    if (!this.recordingConfiguration) {
      return false;
    }
    if (!Characteristic?.RecordingAudioActive || !operatingModeService) {
      return true;
    }
    if (
      typeof operatingModeService.testCharacteristic === "function"
      && !operatingModeService.testCharacteristic(Characteristic.RecordingAudioActive)
    ) {
      return true;
    }

    return Boolean(
      operatingModeService
        .getCharacteristic(Characteristic.RecordingAudioActive)
        .value,
    );
  }

  hksvPrebufferLengthMs() {
    return HKSV_PREBUFFER_LENGTH_MS;
  }

  recordingDiagnosis() {
    if (!this.recordingActive) {
      return { stage: "recording-not-active" };
    }
    if (!this.recordingConfiguration) {
      return { stage: "recording-configuration-missing" };
    }
    if (!this.lastRecordingStream) {
      return { stage: "waiting-for-recording-request" };
    }
    if (this.lastRecordingStream.error || this.lastRecordingStream.exitError) {
      return {
        stage: "recording-error",
        error: this.lastRecordingStream.error || this.lastRecordingStream.exitError,
      };
    }
    const videoBytes = Number(this.lastRecordingStream.videoBytes || 0);
    const audioExpected = this.lastRecordingStream.audioExpected === true;
    const audioBytes = Number(this.lastRecordingStream.audioBytes || 0);
    const audioTrackIds = Array.isArray(this.lastRecordingStream.audioTrackIds)
      ? this.lastRecordingStream.audioTrackIds
      : [];
    if (videoBytes <= 0) {
      return {
        stage: "recording-no-video-media",
        audioExpected,
        videoTrackIds: Array.isArray(this.lastRecordingStream.videoTrackIds)
          ? this.lastRecordingStream.videoTrackIds
          : [],
        audioTrackIds,
        videoPresent: false,
        audioPresent: audioBytes > 0,
        audioDetected: !audioExpected || audioBytes > 0,
      };
    }
    if (audioExpected && !audioTrackIds.length) {
      return {
        stage: "recording-audio-track-not-detected",
        videoBytes,
        audioExpected,
        videoTrackIds: Array.isArray(this.lastRecordingStream.videoTrackIds)
          ? this.lastRecordingStream.videoTrackIds
          : [],
        audioTrackIds,
        videoPresent: true,
        audioPresent: false,
        audioDetected: false,
      };
    }
    if (audioExpected && audioBytes <= 0) {
      return {
        stage: "recording-audio-track-no-media",
        videoBytes,
        videoTrackIds: Array.isArray(this.lastRecordingStream.videoTrackIds)
          ? this.lastRecordingStream.videoTrackIds
          : [],
        audioTrackIds,
        audioExpected,
        videoPresent: true,
        audioPresent: false,
        audioDetected: false,
      };
    }
    if (this.lastRecordingStream.finalFragmentSent) {
      return {
        stage: "recording-complete",
        videoBytes,
        audioBytes,
        audioExpected,
        videoTrackIds: Array.isArray(this.lastRecordingStream.videoTrackIds)
          ? this.lastRecordingStream.videoTrackIds
          : [],
        audioTrackIds,
        videoPresent: videoBytes > 0,
        audioPresent: audioBytes > 0,
        audioDetected: !audioExpected || audioBytes > 0,
      };
    }
    return {
      stage: "recording-media-flowing",
      videoBytes,
      audioBytes,
      audioExpected,
      videoTrackIds: Array.isArray(this.lastRecordingStream.videoTrackIds)
        ? this.lastRecordingStream.videoTrackIds
        : [],
      audioTrackIds,
      videoPresent: videoBytes > 0,
      audioPresent: audioBytes > 0,
      audioDetected: !audioExpected || audioBytes > 0,
    };
  }

  redact(message) {
    let value = String(message || "");
    if (this.config.password) {
      value = value.split(String(this.config.password)).join("***");
    }
    return value.replace(/rtsp:\/\/[^@\s]+@/gi, "rtsp://***@");
  }

  cameraName() {
    return this.config.name || this.config.ip || "hikvision-doorbell";
  }
}

class FragmentedMp4Parser {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.initialization = [];
    this.prefix = [];
    this.fragment = null;
    this.initializationSent = false;
    this.videoTrackIds = new Set([1]);
    this.audioTrackIds = new Set();
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    const completed = [];

    while (this.buffer.length >= 8) {
      let boxSize = this.buffer.readUInt32BE(0);
      let headerSize = 8;
      if (boxSize === 1) {
        if (this.buffer.length < 16) {
          break;
        }
        const extendedSize = this.buffer.readBigUInt64BE(8);
        if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error("HKSV MP4 box is too large.");
        }
        boxSize = Number(extendedSize);
        headerSize = 16;
      }
      if (boxSize === 0 || boxSize < headerSize || this.buffer.length < boxSize) {
        break;
      }

      const box = this.buffer.subarray(0, boxSize);
      this.buffer = this.buffer.subarray(boxSize);
      const type = box.toString("ascii", 4, 8);

      if (type === "ftyp" || type === "moov") {
        this.initialization.push(box);
        if (type === "moov") {
          this.videoTrackIds = mp4VideoTrackIds(box);
          if (!this.videoTrackIds.size) {
            this.videoTrackIds.add(1);
          }
          this.audioTrackIds = mp4AudioTrackIds(box);
          if (!this.initializationSent) {
            completed.push({
              kind: RECORDING_PACKET_KIND.INITIALIZATION,
              data: Buffer.concat(this.initialization),
            });
            this.initialization = [];
            this.initializationSent = true;
          }
        }
        continue;
      }
      if (type === "moof") {
        this.fragment = [...this.prefix, box];
        this.prefix = [];
        continue;
      }
      if (this.fragment) {
        this.fragment.push(box);
        if (type === "mdat") {
          completed.push({
            kind: RECORDING_PACKET_KIND.MEDIA_FRAGMENT,
            data: Buffer.concat(this.fragment),
          });
          this.fragment = null;
        }
        continue;
      }

      this.prefix.push(box);
    }

    return completed;
  }
}

function selectedAudioSampleRate(hap, configuration) {
  switch (configuration?.audioCodec?.samplerate) {
    case hap.AudioRecordingSamplerate.KHZ_8:
      return 8000;
    case hap.AudioRecordingSamplerate.KHZ_16:
      return 16000;
    case hap.AudioRecordingSamplerate.KHZ_24:
      return 24000;
    case hap.AudioRecordingSamplerate.KHZ_32:
      return 32000;
    case hap.AudioRecordingSamplerate.KHZ_44_1:
      return 44100;
    case hap.AudioRecordingSamplerate.KHZ_48:
      return 48000;
    default:
      return 32000;
  }
}

function selectedH264Profile(hap, profile) {
  switch (profile) {
    case hap.H264Profile.BASELINE:
      return "baseline";
    case hap.H264Profile.HIGH:
      return "high";
    case hap.H264Profile.MAIN:
    default:
      return "main";
  }
}

function selectedH264Level(hap, level) {
  switch (level) {
    case hap.H264Level.LEVEL3_1:
      return "3.1";
    case hap.H264Level.LEVEL3_2:
      return "3.2";
    case hap.H264Level.LEVEL4_0:
    default:
      return "4.0";
  }
}

function normalizeHksvVideoCodec(value, config = {}) {
  const requested = String(value || "libx264").trim().toLowerCase();
  if (requested === "copy" && config.hsvAllowVideoCopy !== true) {
    return "libx264";
  }
  return requested || "libx264";
}

function summarizeMp4Fragment(fragment, videoTrackIds = new Set([1]), audioTrackIds = new Set()) {
  const boxes = [];
  let hasMediaMetadata = false;
  let mediaDataBytes = 0;
  let videoMediaBytes = 0;
  let audioMediaBytes = 0;
  let currentFragmentHasVideo = false;
  let currentFragmentHasAudio = false;
  let offset = 0;

  while (offset + 8 <= fragment.length) {
    let boxSize = fragment.readUInt32BE(offset);
    let headerSize = 8;
    if (boxSize === 1) {
      if (offset + 16 > fragment.length) {
        break;
      }
      const extendedSize = fragment.readBigUInt64BE(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        break;
      }
      boxSize = Number(extendedSize);
      headerSize = 16;
    }
    if (boxSize === 0 || boxSize < headerSize || offset + boxSize > fragment.length) {
      break;
    }

    const box = fragment.subarray(offset, offset + boxSize);
    const type = fragment.toString("ascii", offset + 4, offset + 8);
    if (boxes.length < 12) {
      boxes.push(type);
    }
    if (type === "moof" || type === "mdat") {
      hasMediaMetadata = true;
    }
    if (type === "moof") {
      currentFragmentHasVideo = mp4MoofHasVideoTrack(box, videoTrackIds);
      currentFragmentHasAudio = mp4MoofHasAudioTrack(box, audioTrackIds);
    }
    if (type === "mdat") {
      mediaDataBytes += Math.max(boxSize - headerSize, 0);
      if (currentFragmentHasVideo) {
        videoMediaBytes += Math.max(boxSize - headerSize, 0);
      }
      if (currentFragmentHasAudio) {
        audioMediaBytes += Math.max(boxSize - headerSize, 0);
      }
    }
    offset += boxSize;
  }

  return {
    boxes,
    hasMedia: mediaDataBytes > 0,
    hasVideo: videoMediaBytes > 0,
    hasAudio: audioMediaBytes > 0,
    hasMediaMetadata,
    mediaDataBytes,
    videoMediaBytes,
    audioMediaBytes,
  };
}

function mp4MoofHasVideoTrack(moof, videoTrackIds = new Set([1])) {
  if (!videoTrackIds?.size) {
    return true;
  }
  const trafBoxes = mp4ChildBoxes(moof, 8).filter((box) => box.type === "traf");
  let sawTrackId = false;
  for (const traf of trafBoxes) {
    const tfhd = mp4ChildBoxes(traf.data, 8).find((box) => box.type === "tfhd");
    if (!tfhd || tfhd.data.length < 16) {
      continue;
    }
    const trackId = tfhd.data.readUInt32BE(12);
    sawTrackId = true;
    if (videoTrackIds.has(trackId)) {
      return true;
    }
  }
  return !trafBoxes.length || !sawTrackId;
}

function mp4MoofHasAudioTrack(moof, audioTrackIds = new Set()) {
  if (!audioTrackIds?.size) {
    return false;
  }
  const trafBoxes = mp4ChildBoxes(moof, 8).filter((box) => box.type === "traf");
  for (const traf of trafBoxes) {
    const tfhd = mp4ChildBoxes(traf.data, 8).find((box) => box.type === "tfhd");
    if (!tfhd || tfhd.data.length < 16) {
      continue;
    }
    const trackId = tfhd.data.readUInt32BE(12);
    if (audioTrackIds.has(trackId)) {
      return true;
    }
  }
  return false;
}

function mp4VideoTrackIds(moov) {
  return mp4TrackIdsByHandler(moov, "vide");
}

function mp4AudioTrackIds(moov) {
  return mp4TrackIdsByHandler(moov, "soun");
}

function mp4TrackIdsByHandler(moov, expectedHandlerType) {
  const ids = new Set();
  for (const trak of mp4ChildBoxes(moov, 8).filter((box) => box.type === "trak")) {
    const children = mp4ChildBoxes(trak.data, 8);
    const tkhd = children.find((box) => box.type === "tkhd");
    const mdia = children.find((box) => box.type === "mdia");
    if (!tkhd || !mdia) {
      continue;
    }
    const handler = mp4FindChildBox(mdia.data, 8, "hdlr");
    if (!handler || handler.data.length < 20) {
      continue;
    }
    const handlerType = handler.data.toString("ascii", 16, 20);
    if (handlerType !== expectedHandlerType) {
      continue;
    }
    const version = tkhd.data[8];
    const trackIdOffset = version === 1 ? 28 : 20;
    if (tkhd.data.length >= trackIdOffset + 4) {
      ids.add(tkhd.data.readUInt32BE(trackIdOffset));
    }
  }
  return ids;
}

function mp4FindChildBox(buffer, startOffset, type) {
  return mp4ChildBoxes(buffer, startOffset).find((box) => box.type === type) || null;
}

function mp4ChildBoxes(buffer, startOffset) {
  const boxes = [];
  let offset = startOffset;
  while (offset + 8 <= buffer.length) {
    let boxSize = buffer.readUInt32BE(offset);
    let headerSize = 8;
    if (boxSize === 1) {
      if (offset + 16 > buffer.length) {
        break;
      }
      const extendedSize = buffer.readBigUInt64BE(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        break;
      }
      boxSize = Number(extendedSize);
      headerSize = 16;
    }
    if (boxSize === 0 || boxSize < headerSize || offset + boxSize > buffer.length) {
      break;
    }
    boxes.push({
      type: buffer.toString("ascii", offset + 4, offset + 8),
      start: offset,
      headerSize,
      size: boxSize,
      data: buffer.subarray(offset, offset + boxSize),
    });
    offset += boxSize;
  }
  return boxes;
}

function reasonName(reason) {
  if (reason === undefined || reason === null) {
    return "closed";
  }
  return String(reason);
}

module.exports = { HikvisionCameraRecordingDelegate };
