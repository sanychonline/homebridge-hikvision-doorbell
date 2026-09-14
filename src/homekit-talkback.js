"use strict";

const dgram = require("dgram");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

class HomeKitTalkback {
  constructor(platform, config, metrics, stateMachine) {
    this.platform = platform;
    this.config = config;
    this.metrics = metrics;
    this.stateMachine = stateMachine;
    this.enabled = config.twoWayAudio === true || config.talkback === true;
    this.state = "TALK_INACTIVE";
    this.sessions = new Map();
    this.jitterBuffer = [];
    this.maxBufferedPackets = Math.max(Number(config.talkbackJitterBufferPackets || 12), 1);
    this.startedAt = null;
    this.lastPacketAt = null;
    this.lastError = null;
    this.totalDecodedBytes = 0;
    this.totalDecodedChunks = 0;
  }

  async prepareStream(request) {
    if (!this.enabled || !request?.audio) {
      return null;
    }

    const audioReturnPort = await reserveUdpPort();
    const session = {
      sessionID: request.sessionID,
      address: request.targetAddress,
      ipv6: request.addressVersion === "ipv6",
      audioReturnPort,
      audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
      process: null,
      speakerProcess: null,
      startedAt: null,
      codec: null,
      sampleRate: null,
      payloadType: null,
      decodedBytes: 0,
      decodedChunks: 0,
    };

    this.sessions.set(request.sessionID, session);
    this.platform.log.info(`homekit.talk.prepared camera=${this.cameraName()} session=${request.sessionID} port=${audioReturnPort}`);
    return session;
  }

  startStream(request) {
    if (!this.enabled || !request?.audio) {
      return { ok: false, error: "talkback-disabled" };
    }

    const session = this.sessions.get(request.sessionID);
    if (!session) {
      return { ok: false, error: "talkback-session-not-prepared" };
    }

    if (session.process) {
      return { ok: true, state: this.state, alreadyActive: true };
    }

    const audio = request.audio;
    const sampleRate = streamingAudioSampleRate(audio.sample_rate, this.config.homeKitAudioSampleRate);
    const payloadType = Number(audio.pt || 110);
    const codec = String(audio.codec || "AAC-eld");
    const sdp = buildReturnAudioSdp({
      address: session.address,
      ipv6: session.ipv6,
      port: session.audioReturnPort,
      payloadType,
      codec,
      sampleRate,
      srtp: session.audioSRTP,
    });

    const ffmpeg = this.config.ffmpeg || "ffmpeg";
    const args = [
      "-hide_banner",
      "-loglevel",
      this.config.talkbackFfmpegDebug === true ? "info" : "warning",
      "-protocol_whitelist",
      "pipe,udp,rtp,file,crypto",
      "-f",
      "sdp",
      "-c:a",
      "libfdk_aac",
      "-i",
      "pipe:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(normalizeDeviceAudioSampleRate(this.config.rtspAudioSampleRate)),
      "-acodec",
      "pcm_s16le",
      "-f",
      "s16le",
      "pipe:1",
    ];

    const proc = spawn(ffmpeg, args, { stdio: ["pipe", "pipe", "pipe"] });
    session.process = proc;
    session.startedAt = Date.now();
    session.stateMachineActive = false;
    session.codec = codec;
    session.sampleRate = sampleRate;
    session.payloadType = payloadType;
    this.state = "TALK_STARTING";
    this.startedAt = session.startedAt;
    this.jitterBuffer = [];
    this.metrics?.increment("talk_sessions_total");
    this.metrics?.setGauge("talk_sessions_active", 1);
    this.platform.log.info(`homekit.talk.receiver.started camera=${this.cameraName()} session=${request.sessionID} codec=${codec} sampleRate=${sampleRate} payloadType=${payloadType} port=${session.audioReturnPort}`);

    const speaker = this.startSpeakerProcess(session);

    proc.stdout.on("data", (chunk) => {
      this.markActive(session);
      this.pushDecodedAudio(session, chunk);
      if (speaker?.stdin?.writable && !speaker.stdin.destroyed) {
        speaker.stdin.write(chunk);
      }
    });
    proc.stderr.on("data", (chunk) => {
      const line = redactLog(chunk.toString()).trim();
      if (line && this.config.talkbackFfmpegDebug === true) {
        this.platform.log.info(`[ffmpeg talkback] ${line}`);
      }
    });
    proc.on("error", (error) => {
      this.lastError = error.message;
      this.platform.log.warn(`homekit.talk.receiver.error camera=${this.cameraName()} session=${request.sessionID} error=${error.message}`);
    });
    proc.on("exit", (code, signal) => {
      this.platform.log.info(`homekit.talk.receiver.exited camera=${this.cameraName()} session=${request.sessionID} code=${code} signal=${signal} decodedChunks=${session.decodedChunks} decodedBytes=${session.decodedBytes}`);
    });

    proc.stdin.end(sdp);
    return { ok: true, state: this.state };
  }

  stopStream(sessionID, reason = "stop") {
    const session = this.sessions.get(sessionID);
    if (!session) {
      return { ok: true, state: this.state, alreadyStopped: true };
    }

    const durationMs = session.startedAt ? Date.now() - session.startedAt : 0;
    try {
      session.process?.kill("SIGTERM");
    } catch (_error) {
      // Ignore process cleanup races.
    }
    try {
      session.speakerProcess?.stdin?.end();
      session.speakerProcess?.kill("SIGTERM");
    } catch (_error) {
      // Ignore process cleanup races.
    }
    this.sessions.delete(sessionID);

    if (!this.sessions.size) {
      this.state = "TALK_INACTIVE";
      this.startedAt = null;
      this.jitterBuffer = [];
      this.metrics?.setGauge("talk_sessions_active", 0);
      if (session.stateMachineActive) {
        this.stateMachine?.talkStopped(`homekit-talk:${reason}`);
      }
    }

    this.platform.log.info(`homekit.talk.stopped camera=${this.cameraName()} session=${sessionID} reason=${reason} durationMs=${durationMs} decodedChunks=${session.decodedChunks} decodedBytes=${session.decodedBytes}`);
    return {
      ok: true,
      state: this.state,
      durationMs,
    };
  }

  start(source = "unknown") {
    if (!this.enabled) {
      this.metrics?.increment("talk_sessions_rejected_total");
      return {
        ok: false,
        error: "talkback-disabled",
        state: this.state,
      };
    }

    this.markActive();
    this.platform.log.info(`homekit.talk.started camera=${this.cameraName()} source=${source}`);
    return {
      ok: true,
      state: this.state,
    };
  }

  stop(reason = "stop") {
    for (const sessionID of Array.from(this.sessions.keys())) {
      this.stopStream(sessionID, reason);
    }
    return {
      ok: true,
      state: this.state,
    };
  }

  markActive(session) {
    if (this.state !== "TALK_ACTIVE") {
      this.state = "TALK_ACTIVE";
      if (session && !session.stateMachineActive) {
        session.stateMachineActive = true;
        this.stateMachine?.talkStarted(`homekit-talk:${session.sessionID}`);
      }
      this.platform.log.info(`homekit.talk.active camera=${this.cameraName()}`);
    }
  }

  startSpeakerProcess(session) {
    if (this.config.talkbackTransport === "hcnet-sdk") {
      return this.startHcnetSpeakerProcess(session);
    }

    const command = String(this.config.talkbackSpeakerCommand || "").trim();
    if (!command) {
      return null;
    }

    const proc = spawn(command, {
      shell: true,
      stdio: ["pipe", "ignore", "pipe"],
    });
    session.speakerProcess = proc;
    proc.stderr.on("data", (chunk) => {
      const line = redactLog(chunk.toString()).trim();
      if (line) {
        this.platform.log.warn(`[talkback speaker] ${line}`);
      }
    });
    proc.on("exit", (code, signal) => {
      this.platform.log.info(`homekit.talk.speaker.exited camera=${this.cameraName()} session=${session.sessionID} code=${code} signal=${signal}`);
    });
    this.platform.log.info(`homekit.talk.speaker.started camera=${this.cameraName()} session=${session.sessionID}`);
    return proc;
  }

  startHcnetSpeakerProcess(session) {
    const sdkLibrary = this.config.hcnetSdkLibrary || "/homebridge/hikvision-hcnet-sdk/lib/libhcnetsdk.so";
    if (!fs.existsSync(sdkLibrary)) {
      this.lastError = `HCNetSDK library not found at ${sdkLibrary}`;
      this.platform.log.warn(`homekit.talk.speaker.unavailable camera=${this.cameraName()} reason=sdk-missing path=${sdkLibrary}`);
      return null;
    }

    const bridgePath = path.resolve(__dirname, "../tools/hikvision-hcnet-talkback.py");
    const python = this.config.hcnetPython || "python3";
    const libraryDir = path.dirname(sdkLibrary);
    const componentDir = this.config.hcnetSdkComponentPath || path.join(libraryDir, "HCNetSDKCom");
    const env = {
      ...process.env,
      HIKVISION_TALKBACK_HOST: String(this.config.ip || ""),
      HIKVISION_TALKBACK_PORT: String(this.config.hcnetPort || 8000),
      HIKVISION_TALKBACK_USERNAME: String(this.config.username || ""),
      HIKVISION_TALKBACK_PASSWORD: String(this.config.password || ""),
      LD_LIBRARY_PATH: [libraryDir, componentDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
    };
    const proc = spawn(python, [
      bridgePath,
      "--sdk-library",
      sdkLibrary,
      "--voice-channel",
      String(this.config.hcnetVoiceChannel || 1),
    ], {
      env,
      stdio: ["pipe", "ignore", "pipe"],
    });

    session.speakerProcess = proc;
    proc.stderr.on("data", (chunk) => {
      const line = redactLog(chunk.toString()).trim();
      if (line) {
        this.lastError = line;
        this.platform.log.warn(`[hcnet talkback] ${line}`);
      }
    });
    proc.on("error", (error) => {
      this.lastError = error.message;
      this.platform.log.warn(`homekit.talk.speaker.error camera=${this.cameraName()} error=${redactLog(error.message)}`);
    });
    proc.on("exit", (code, signal) => {
      this.platform.log.info(`homekit.talk.speaker.exited camera=${this.cameraName()} session=${session.sessionID} transport=hcnet-sdk code=${code} signal=${signal}`);
    });
    this.platform.log.info(`homekit.talk.speaker.started camera=${this.cameraName()} session=${session.sessionID} transport=hcnet-sdk channel=${this.config.hcnetVoiceChannel || 1}`);
    return proc;
  }

  pushDecodedAudio(session, payload) {
    if (!payload?.length) {
      return false;
    }

    this.lastPacketAt = Date.now();
    this.totalDecodedChunks += 1;
    this.totalDecodedBytes += payload.length;
    session.decodedChunks += 1;
    session.decodedBytes += payload.length;
    this.jitterBuffer.push({
      receivedAt: this.lastPacketAt,
      payload,
    });
    if (this.jitterBuffer.length > this.maxBufferedPackets) {
      this.jitterBuffer.splice(0, this.jitterBuffer.length - this.maxBufferedPackets);
      this.metrics?.increment("talk_jitter_dropped_packets_total");
    }
    this.metrics?.increment("talk_incoming_packets_total");
    this.metrics?.increment("talk_incoming_bytes_total", payload.length);
    return true;
  }

  pushIncomingPacket(packet) {
    return this.pushDecodedAudio({ decodedChunks: 0, decodedBytes: 0 }, packet?.payload);
  }

  getStatusSnapshot() {
    return {
      enabled: this.enabled,
      state: this.state,
      startedAt: this.startedAt,
      lastPacketAt: this.lastPacketAt,
      jitterBufferPackets: this.jitterBuffer.length,
      maxBufferedPackets: this.maxBufferedPackets,
      sessions: Array.from(this.sessions.values()).map((session) => ({
        sessionID: session.sessionID,
        port: session.audioReturnPort,
        codec: session.codec,
        sampleRate: session.sampleRate,
        payloadType: session.payloadType,
        startedAt: session.startedAt,
        decodedChunks: session.decodedChunks,
        decodedBytes: session.decodedBytes,
        receiverActive: Boolean(session.process && !session.process.killed),
        speakerActive: Boolean(session.speakerProcess && !session.speakerProcess.killed),
      })),
      decodedChunks: this.totalDecodedChunks,
      decodedBytes: this.totalDecodedBytes,
      lastError: this.lastError,
      speakerOutput: this.config.talkbackTransport === "hcnet-sdk"
        ? "hcnet-sdk"
        : (this.config.talkbackSpeakerCommand ? "command" : "not-configured"),
      aec: {
        enabled: this.config.talkbackAec === true,
        backend: this.config.talkbackAecBackend || "none",
      },
    };
  }

  cameraName() {
    return this.config.name || this.config.did || "hikvision-camera";
  }
}

function reserveUdpPort() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const cleanup = () => {
      socket.off("error", onError);
      socket.off("listening", onListening);
    };
    const onError = (error) => {
      cleanup();
      try {
        socket.close();
      } catch (_error) {
        // Ignore close races.
      }
      reject(error);
    };
    const onListening = () => {
      const port = socket.address().port;
      cleanup();
      socket.close(() => resolve(port));
    };
    socket.once("error", onError);
    socket.once("listening", onListening);
    socket.bind(0, "0.0.0.0");
  });
}

function buildReturnAudioSdp(options) {
  const ipVersion = options.ipv6 ? "IP6" : "IP4";
  const codec = String(options.codec || "AAC-eld");
  const codecLine = codec.toUpperCase() === "OPUS"
    ? `a=rtpmap:${options.payloadType} opus/${options.sampleRate}/1\r\n`
    : `a=rtpmap:${options.payloadType} MPEG4-GENERIC/${options.sampleRate}/1\r\n`
      + `a=fmtp:${options.payloadType} profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3; config=F8F0212C00BC00\r\n`;

  return "v=0\r\n"
    + `o=- 0 0 IN ${ipVersion} ${options.address}\r\n`
    + "s=Talk\r\n"
    + `c=IN ${ipVersion} ${options.address}\r\n`
    + "t=0 0\r\n"
    + `m=audio ${options.port} RTP/AVP ${options.payloadType}\r\n`
    + "b=AS:24\r\n"
    + codecLine
    + `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${options.srtp.toString("base64")}\r\n`;
}

function streamingAudioSampleRate(value, fallback) {
  const parsed = Number(value);
  if (parsed === 0) {
    return 8000;
  }
  if (parsed === 1) {
    return 16000;
  }
  if (parsed === 2) {
    return 24000;
  }
  const fallbackParsed = Number(fallback);
  if (Number.isFinite(fallbackParsed) && fallbackParsed > 1000) {
    return Math.floor(fallbackParsed);
  }
  return 16000;
}

function normalizeDeviceAudioSampleRate(value) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  if (model === "hikvision.camera.v3") {
    return 8000;
  }
  return 8000;
}

function redactLog(message) {
  return message
    .replace(/https?:\/\/[^\s]+/g, "[URL]")
    .replace(/rtsp:\/\/[^\s]+/g, "[URL]");
}

module.exports = {
  HomeKitTalkback,
};
