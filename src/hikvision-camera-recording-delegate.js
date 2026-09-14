"use strict";

const { spawn } = require("child_process");
const { MotionEventManager } = require("./motion-event-manager");

class HikvisionCameraRecordingDelegate {
  constructor(platform, config, streamingDelegate, metrics, stateMachine) {
    this.platform = platform;
    this.config = config;
    this.streamingDelegate = streamingDelegate;
    this.metrics = metrics;
    this.stateMachine = stateMachine;
    this.recordingActive = false;
    this.recordingConfiguration = null;
    this.motionService = null;
    this.streams = new Map();
    this.lastRecordingStreamRequestedAt = 0;
    this.lastRecordingStream = null;
    this.recordingWindowUntil = 0;
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
    }
  }

  updateRecordingConfiguration(configuration) {
    this.recordingConfiguration = configuration || null;
    this.platform.log.info(
      `Hikvision HKSV recording configuration ${configuration ? "selected" : "cleared"} for ${this.cameraName()}`,
    );
  }

  setMotionService(motionService) {
    this.motionService = motionService || null;
    this.motionEventManager.setMotionService(this.motionService);
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
      recordingWindowUntil: this.recordingWindowUntil || null,
      input: {
        transport: "rtsp",
        channel: this.config.rtspChannel || 101,
        audio: this.config.audio !== false,
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
    const durationMs = Math.max(
      Number(options.durationMs || this.config.hsvMotionDurationMs || this.config.motionHoldMs || 15000),
      1000,
    );
    this.recordingWindowUntil = Math.max(this.recordingWindowUntil, Date.now() + durationMs);
    const triggered = this.motionEventManager.trigger(durationMs);

    return {
      ok: triggered,
      source: options.source || "unknown",
      durationMs,
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

    const session = this.startSession(streamId, signal);
    this.streams.set(streamId, session);
    this.motionEventManager.recordingStarted(streamId);
    this.metrics?.recordHksvStarted?.();
    this.stateMachine?.recordingStarted?.(`hksv:${streamId}`);
    this.platform.log.info(`Hikvision HKSV RTSP recording requested for ${this.cameraName()}: stream=${streamId}`);

    let emitted = 0;
    let emittedBytes = 0;
    let finalFragmentSent = false;

    try {
      for await (const chunk of session.proc.stdout) {
        if (session.closed) {
          break;
        }

        for (const fragment of session.parser.push(chunk)) {
          emitted += 1;
          emittedBytes += fragment.length;
          session.firstFragmentSeen = true;
          clearTimeout(session.startupTimer);

          const isLast = this.shouldEndRecording(signal);
          finalFragmentSent = isLast;
          this.lastRecordingStream = {
            ...this.lastRecordingStream,
            status: isLast ? "completed" : "streaming",
            startedAt: this.lastRecordingStream.startedAt || Date.now(),
            fragments: emitted,
            bytes: emittedBytes,
            finalFragmentSent: isLast,
          };
          this.metrics?.increment?.("hksv_fragments_total");

          if (emitted <= 3 || isLast || this.config.hsvFfmpegDebug === true) {
            this.platform.log.info(
              `Hikvision HKSV fragment for ${this.cameraName()}: stream=${streamId}, index=${emitted}, bytes=${fragment.length}, isLast=${isLast}`,
            );
          }

          yield { data: fragment, isLast };
          if (isLast) {
            return;
          }
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
        finalFragmentSent,
      };
    }
  }

  acknowledgeStream(streamId) {
    this.platform.log.info(`Hikvision HKSV recording acknowledged for ${this.cameraName()}: stream=${streamId}`);
    this.closeRecordingStream(streamId, "acknowledged");
  }

  closeRecordingStream(streamId, reason) {
    this.finishSession(streamId, reasonName(reason));
  }

  startSession(streamId, signal) {
    const ffmpeg = this.config.ffmpeg || "/usr/local/bin/ffmpeg";
    const fragmentLengthMs = Math.max(Number(this.config.hsvFragmentLengthMs || 4000), 1000);
    const audioSampleRate = selectedAudioSampleRate(this.recordingConfiguration);
    const audioBitrateKbps = Math.max(Number(this.config.hsvAudioBitrateKbps || 32), 16);
    const args = [
      "-hide_banner",
      "-loglevel",
      this.config.hsvFfmpegDebug === true ? "info" : "warning",
      "-rtsp_transport",
      this.config.rtspTransport || "tcp",
      "-i",
      this.rtspUrl(),
      "-map",
      "0:v:0",
    ];

    if (this.config.audio !== false) {
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

    args.push(
      "-c:v",
      this.config.hsvVideoCodec || "copy",
      "-dn",
      "-sn",
      "-movflags",
      "frag_keyframe+empty_moov+default_base_moof",
      "-frag_duration",
      String(fragmentLengthMs * 1000),
      "-min_frag_duration",
      String(fragmentLengthMs * 1000),
      "-f",
      "mp4",
      "pipe:1",
    );

    const proc = spawn(ffmpeg, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const session = {
      streamId,
      abortSignal: signal,
      proc,
      parser: new FragmentedMp4Parser(),
      closed: false,
      stderr: [],
      exitError: null,
      firstFragmentSeen: false,
      abortHandler: null,
      startupTimer: null,
    };

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
    });

    session.abortHandler = () => this.finishSession(streamId, "aborted");
    signal?.addEventListener?.("abort", session.abortHandler, { once: true });

    const startupTimeoutMs = Math.max(Number(this.config.hsvStartupTimeoutMs || 20000), 5000);
    session.startupTimer = setTimeout(() => {
      if (!session.firstFragmentSeen && !session.closed) {
        session.exitError = `Hikvision HKSV FFmpeg produced no fragment within ${startupTimeoutMs}ms.`;
        this.finishSession(streamId, "startup-timeout");
      }
    }, startupTimeoutMs);
    session.startupTimer.unref?.();

    return session;
  }

  finishSession(streamId, reason) {
    const session = this.streams.get(streamId);
    if (!session || session.closed) {
      return;
    }

    session.closed = true;
    clearTimeout(session.startupTimer);
    session.abortSignal?.removeEventListener?.("abort", session.abortHandler);
    this.streams.delete(streamId);

    try {
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

  shouldEndRecording(signal) {
    if (signal?.aborted) {
      return true;
    }
    return Date.now() >= this.recordingWindowUntil && !this.isMotionActive();
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
    const configured = this.config.rtspUrl;
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
    const channel = String(this.config.rtspChannel || 101);
    const streamPath = this.config.rtspPath || `/Streaming/Channels/${channel}`;
    const url = new URL(`rtsp://${host}:${port}${streamPath.startsWith("/") ? streamPath : `/${streamPath}`}`);
    url.username = this.config.username || "admin";
    url.password = this.config.password || "";
    return url.toString();
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
    this.firstFragment = true;
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
          const parts = this.firstFragment
            ? [...this.initialization, ...this.fragment]
            : this.fragment;
          completed.push(Buffer.concat(parts));
          this.firstFragment = false;
          this.fragment = null;
        }
        continue;
      }

      this.prefix.push(box);
    }

    return completed;
  }
}

function selectedAudioSampleRate(configuration) {
  const samplerate = Number(configuration?.audioCodec?.samplerate);
  const rates = {
    0: 8000,
    1: 16000,
    2: 24000,
    3: 32000,
    4: 44100,
    5: 48000,
  };
  return rates[samplerate] || 32000;
}

function reasonName(reason) {
  if (reason === undefined || reason === null) {
    return "closed";
  }
  return String(reason);
}

module.exports = { HikvisionCameraRecordingDelegate };
