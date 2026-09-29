"use strict";

const dgram = require("dgram");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const net = require("net");
const os = require("os");
const { spawn } = require("child_process");
const { PassThrough } = require("stream");
const {
  DEFAULT_PRIVATE_PORT,
  openHikvisionPrivateTalkback,
} = require("./hikvision-private-transport");
const {
  G711_AUDIO_FRAME_BYTES,
  PCM16LE_16KHZ_TO_G711_GROUP_BYTES,
  buildPrivateG711VoicePacket,
  downsample16kPcmTo8kMulaw,
  linearToMulaw,
} = require("./hikvision-private-voice-media");

const TALKBACK_AUDIO_IDLE_TIMEOUT_MS = 2500;
const DEFAULT_TALKBACK_PCM_GAIN = 1.4;
const TALKBACK_DIAGNOSTIC_TONE_FLAG = "/tmp/homebridge-hikvision-doorbell-talkback-tone";

class HomeKitTalkback {
  constructor(platform, config, metrics, stateMachine) {
    this.platform = platform;
    this.config = config;
    this.metrics = metrics;
    this.stateMachine = stateMachine;
    this.enabled = config.twoWayAudio === true || config.talkback === true;
    if (this.enabled && !this.config.talkbackTransport) {
      this.config.talkbackTransport = "private";
    }
    this.state = "TALK_INACTIVE";
    this.sessions = new Map();
    this.jitterBuffer = [];
    this.maxBufferedPackets = Math.max(Number(config.talkbackJitterBufferPackets || 12), 1);
    this.startedAt = null;
    this.lastPacketAt = null;
    this.lastError = null;
    this.privateHandshake = null;
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
      audioReturnPortReservedAt: Date.now(),
      audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
      process: null,
      speakerProcess: null,
      startedAt: null,
      codec: null,
      sampleRate: null,
      payloadType: null,
      decodedBytes: 0,
      decodedChunks: 0,
      receiverError: null,
      receiverExit: null,
      receiverExited: false,
      speakerIdleTimer: null,
      speakerLastPcmAt: 0,
      firstDecodedPcmLogged: false,
      firstPrivateMediaFrameQueuedLogged: false,
      firstPrivateMediaFrameSentLogged: false,
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
    const sdpAddress = this.talkbackSdpListenAddress(session);
    const rtpProfile = String(this.config.talkbackRtpProfile || "RTP/SAVP");
    const aacFmtpMode = this.config.talkbackAacFmtp === false
      ? "disabled"
      : (this.config.talkbackAacFmtp ? "custom" : "default");
    const sdp = buildReturnAudioSdp({
      address: sdpAddress,
      ipv6: session.ipv6,
      port: session.audioReturnPort,
      payloadType,
      codec,
      sampleRate,
      srtp: session.audioSRTP,
      rtpProfile,
      aacFmtp: this.config.talkbackAacFmtp,
    });

    const ffmpeg = this.config.ffmpeg || "ffmpeg";
    const args = [
      "-hide_banner",
      "-loglevel",
      this.config.talkbackFfmpegDebug === true ? "info" : "warning",
      // HomeKit may keep the return-audio RTP stream silent until the user
      // starts speaking. Keep the receiver alive for the whole talk session;
      // stopStream() owns the process lifetime.
      "-rw_timeout",
      "0",
      "-protocol_whitelist",
      "pipe,udp,rtp,srtp,file,crypto",
      "-f",
      "sdp",
    ];
    const inputDecoder = String(this.config.talkbackInputAudioDecoder || "libfdk_aac").trim();
    if (inputDecoder) {
      args.push("-c:a", inputDecoder);
    }
    args.push(
      "-i",
      "pipe:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-acodec",
      "pcm_s16le",
      "-f",
      "s16le",
      "pipe:1",
    );

    const proc = spawn(ffmpeg, args, { stdio: ["pipe", "pipe", "pipe"] });
    session.process = proc;
    session.startedAt = Date.now();
    session.receiverStartDelayMs = session.audioReturnPortReservedAt
      ? session.startedAt - session.audioReturnPortReservedAt
      : null;
    session.stateMachineActive = false;
    session.codec = codec;
    session.sampleRate = sampleRate;
    session.payloadType = payloadType;
    this.state = "TALK_STARTING";
    this.startedAt = session.startedAt;
    this.jitterBuffer = [];
    this.metrics?.increment("talk_sessions_total");
    this.metrics?.setGauge("talk_sessions_active", 1);
    this.platform.log.info(`homekit.talk.receiver.started camera=${this.cameraName()} session=${request.sessionID} codec=${codec} sampleRate=${sampleRate} payloadType=${payloadType} port=${session.audioReturnPort} sdpAddress=${sdpAddress} rtpProfile=${rtpProfile} aacFmtp=${aacFmtpMode} inputDecoder=${inputDecoder || "auto"} startDelayMs=${session.receiverStartDelayMs ?? "unknown"}`);

    let speaker = null;
    let receiverStderr = "";

    proc.stdout.on("data", (chunk) => {
      if (this.sessions.get(session.sessionID) !== session) return;
      this.markActive(session);
      this.pushDecodedAudio(session, chunk);
      if (!speaker || speaker.closed) {
        speaker = this.startSpeakerProcess(session);
      }
      session.speakerLastPcmAt = Date.now();
      this.armSpeakerIdleTimer(session);
      if (speaker?.writePcm) {
        speaker.writePcm(chunk);
      } else if (speaker?.stdin?.writable && !speaker.stdin.destroyed) {
        speaker.stdin.write(chunk);
      }
    });
    proc.stderr.on("data", (chunk) => {
      const line = redactLog(chunk.toString()).trim();
      if (line) {
        receiverStderr = `${receiverStderr}\n${line}`.slice(-4096);
      }
      if (line && this.config.talkbackFfmpegDebug === true) {
        this.platform.log.info(`[ffmpeg talkback] ${line}`);
      }
    });
    proc.on("error", (error) => {
      session.receiverError = redactLog(error.message);
      this.lastError = error.message;
      this.platform.log.warn(`homekit.talk.receiver.error camera=${this.cameraName()} session=${request.sessionID} error=${error.message}`);
    });
    proc.on("exit", (code, signal) => {
      session.receiverExited = true;
      session.receiverExit = {
        code,
        signal,
        exitedAt: Date.now(),
        decodedChunks: session.decodedChunks,
        decodedBytes: session.decodedBytes,
      };
      if (session.decodedBytes === 0 && receiverStderr.trim()) {
        this.platform.log.warn(`homekit.talk.receiver.no-audio camera=${this.cameraName()} session=${request.sessionID} ffmpeg=${receiverStderr.trim()}`);
      }
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
      this.clearSpeakerIdleTimer(session);
      session.process?.kill("SIGTERM");
    } catch (_error) {
      // Ignore process cleanup races.
    }
    this.closeSpeaker(session, reason);
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

    this.platform.log.info(`homekit.talk.stopped camera=${this.cameraName()} session=${sessionID} reason=${reason} durationMs=${durationMs} decodedChunks=${session.decodedChunks} decodedBytes=${session.decodedBytes} isapiBytesSent=${session.isapiBytesSent || 0} privateMediaFramesSent=${session.privateMediaFramesSent || 0} privateMediaBytesSent=${session.privateMediaBytesSent || 0} privateMediaFramesDropped=${session.privateMediaFramesDropped || 0}`);
    return {
      ok: true,
      state: this.state,
      durationMs,
    };
  }

  armSpeakerIdleTimer(session) {
    this.clearSpeakerIdleTimer(session);
    session.speakerIdleTimer = setTimeout(() => {
      if (this.sessions.get(session.sessionID) !== session || !session.speakerLastPcmAt) {
        return;
      }
      if (Date.now() - session.speakerLastPcmAt >= TALKBACK_AUDIO_IDLE_TIMEOUT_MS) {
        this.closeSpeaker(session, "homekit-audio-idle");
      } else {
        this.armSpeakerIdleTimer(session);
      }
    }, TALKBACK_AUDIO_IDLE_TIMEOUT_MS);
  }

  clearSpeakerIdleTimer(session) {
    if (session?.speakerIdleTimer) {
      clearTimeout(session.speakerIdleTimer);
      session.speakerIdleTimer = null;
    }
  }

  closeSpeaker(session, reason) {
    this.clearSpeakerIdleTimer(session);
    for (const timer of session.diagnosticToneTimers || []) {
      clearTimeout(timer);
    }
    session.diagnosticToneTimers = [];
    const speaker = session.speakerProcess;
    if (!speaker) {
      return;
    }
    speaker.kill?.(reason);
    session.speakerProcess = null;
    session.isapiInput = null;
    session.isapiUpload = null;
    this.platform.log.info(`homekit.talk.speaker.stopped camera=${this.cameraName()} session=${session.sessionID} reason=${reason}`);
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

    if (this.config.talkbackTransport === "isapi") {
      return this.startIsapiSpeakerProcess(session);
    }

    if (this.config.talkbackTransport === "private") {
      return this.startPrivateSpeakerProcess(session);
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

  startIsapiSpeakerProcess(session) {
    const input = new PassThrough();
    let pcmRemainder = Buffer.alloc(0);
    let g711Remainder = Buffer.alloc(0);
    const speaker = {
      closed: false,
      stdin: input,
      writePcm: (chunk) => {
        if (!input.destroyed && input.writable) {
          const pcm = pcmRemainder.length ? Buffer.concat([pcmRemainder, chunk]) : chunk;
          const incompleteGroupBytes = pcm.length % PCM16LE_16KHZ_TO_G711_GROUP_BYTES;
          pcmRemainder = incompleteGroupBytes ? pcm.subarray(pcm.length - incompleteGroupBytes) : Buffer.alloc(0);
          const encoded = downsample16kPcmTo8kMulaw(
            pcm.subarray(0, pcm.length - pcmRemainder.length),
            DEFAULT_TALKBACK_PCM_GAIN,
          );
          const audio = g711Remainder.length ? Buffer.concat([g711Remainder, encoded]) : encoded;
          let offset = 0;
          while (audio.length - offset >= 160) {
            const frame = audio.subarray(offset, offset + 160);
            session.isapiBytesSent = (session.isapiBytesSent || 0) + frame.length;
            input.write(frame);
            offset += frame.length;
          }
          g711Remainder = audio.subarray(offset);
        }
      },
      kill: () => {
        if (speaker.closed) {
          return;
        }
        speaker.closed = true;
        for (const timer of session.diagnosticToneTimers || []) {
          clearTimeout(timer);
        }
        session.diagnosticToneTimers = [];
        input.end();
        session.isapiUpload?.destroy();
        this.closeIsapiAudio(session).catch(() => {});
      },
    };
    session.speakerProcess = speaker;
    session.isapiInput = input;
    this.openIsapiAudio(session).then(({ request }) => {
      if (speaker.closed || session.speakerProcess !== speaker || this.sessions.get(session.sessionID) !== session) {
        request.destroy();
        this.closeIsapiAudio(session).catch(() => {});
        return;
      }
      session.isapiUpload = request;
      input.pipe(request);
      this.platform.log.info(`homekit.talk.isapi.response camera=${this.cameraName()} session=${session.sessionID} status=${request.isapiStatusCode}`);
      if ((request.isapiStatusCode || 0) < 200 || (request.isapiStatusCode || 0) >= 300) {
        this.platform.log.warn(`homekit.talk.isapi.error camera=${this.cameraName()} session=${session.sessionID} status=${request.isapiStatusCode}`);
      }
      request.on("error", (error) => {
        this.lastError = error.message;
        this.platform.log.warn(`homekit.talk.isapi.error camera=${this.cameraName()} session=${session.sessionID} error=${redactLog(error.message)}`);
      });
      if (consumeDiagnosticToneFlag()) {
        this.sendDiagnosticTone(session, speaker);
      }
    }).catch((error) => {
      this.lastError = error.message;
      session.isapiUpload?.destroy();
      input.destroy();
      this.closeIsapiAudio(session).catch(() => {});
      this.platform.log.warn(`homekit.talk.isapi.open-error camera=${this.cameraName()} session=${session.sessionID} error=${redactLog(error.message)}`);
    });
    this.platform.log.info(`homekit.talk.speaker.starting camera=${this.cameraName()} session=${session.sessionID} transport=isapi channel=${this.config.twoWayAudioChannel || 1}`);
    return speaker;
  }

  async openIsapiAudio(session) {
    const channel = Number(this.config.twoWayAudioChannel || 1);
    const pathName = `/ISAPI/System/TwoWayAudio/channels/${channel}/open`;
    session.isapiChannel = channel;
    await this.prepareTalkOutputVolume(session);
    await isapiRequest(this.config, "PUT", `/ISAPI/System/TwoWayAudio/channels/${channel}/close`).catch(() => {});
    const opened = await isapiRequest(this.config, "PUT", pathName);
    const sessionID = xmlTag(opened.body, "sessionId");
    session.isapiSessionID = sessionID || null;
    const audioPathBase = `/ISAPI/System/TwoWayAudio/channels/${channel}/audioData`;
    const audioPath = sessionID
      ? `${audioPathBase}?sessionId=${encodeURIComponent(sessionID)}`
      : audioPathBase;
    const authorization = await isapiAuthorization(this.config, "PUT", audioPath);
    if (!authorization) {
      throw new Error("ISAPI audio endpoint did not provide a Digest challenge");
    }
    const upload = await openIsapiAudioSocket(this.config, audioPath, authorization);
    this.platform.log.info(`homekit.talk.speaker.started camera=${this.cameraName()} session=${session.sessionID} transport=isapi channel=${channel} codec=G.711ulaw wire=digest-raw`);
    return { request: upload };
  }

  sendDiagnosticTone(session, speaker) {
    const input = session.isapiInput;
    if (!input || speaker.closed) {
      return;
    }
    const frames = [];
    const sampleRate = 8000;
    const frameSamples = 160;
    for (let frameIndex = 0; frameIndex < 10; frameIndex += 1) {
      const frame = Buffer.alloc(frameSamples);
      for (let sample = 0; sample < frameSamples; sample += 1) {
        const phase = ((frameIndex * frameSamples) + sample) / sampleRate;
        frame[sample] = linearToMulaw(Math.round(Math.sin(2 * Math.PI * 440 * phase) * 1400));
      }
      frames.push(frame);
    }
    session.diagnosticToneTimers = [];
    frames.forEach((frame, index) => {
      const timer = setTimeout(() => {
        if (!speaker.closed && !input.destroyed && input.writable) {
          session.isapiBytesSent = (session.isapiBytesSent || 0) + frame.length;
          input.write(frame);
        }
      }, index * 20);
      session.diagnosticToneTimers.push(timer);
    });
    this.platform.log.info(`homekit.talk.diagnostic-tone camera=${this.cameraName()} session=${session.sessionID} durationMs=200`);
  }

  async closeIsapiAudio(session) {
    if (!session.isapiChannel) {
      return;
    }
    if (session.isapiClosePromise) {
      return session.isapiClosePromise;
    }

    session.isapiClosePromise = (async () => {
      const query = session.isapiSessionID ? `?sessionId=${encodeURIComponent(session.isapiSessionID)}` : "";
      await isapiRequest(this.config, "PUT", `/ISAPI/System/TwoWayAudio/channels/${session.isapiChannel}/close${query}`).catch((error) => {
        this.platform.log.debug(`homekit.talk.isapi.close-error camera=${this.cameraName()} error=${redactLog(error.message)}`);
      });
      await this.restoreTalkOutputVolume(session);
    })();
    return session.isapiClosePromise;
  }

  async prepareTalkOutputVolume(session) {
    const path = `/ISAPI/System/Audio/AudioOut/channels/${session.isapiChannel}`;
    const currentResponse = await isapiRequest(this.config, "GET", path);
    const current = currentResponse.body;
    const match = current.match(/(<TalkOutVolume\b[^>]*>[\s\S]*?<volume>)\s*(\d+)\s*(<\/volume>[\s\S]*?<\/TalkOutVolume>)/i);
    if (!match || Number(match[2]) > 0) {
      return;
    }

    const mainVolume = Number(current.match(/<AudioOutVolume\b[^>]*>[\s\S]*?<volume>\s*(\d+)\s*<\/volume>/i)?.[1]);
    const targetVolume = Number.isInteger(mainVolume) && mainVolume > 0 ? mainVolume : 7;
    const updated = current.replace(match[0], `${match[1]}${targetVolume}${match[3]}`);
    await isapiRequest(this.config, "PUT", path, updated, "application/xml");
    session.previousTalkOutputVolume = Number(match[2]);
    session.talkOutputVolumeChanged = true;
    this.platform.log.info(`homekit.talk.audio-output-temporary camera=${this.cameraName()} channel=${session.isapiChannel} from=${match[2]} to=${targetVolume}`);
  }

  async restoreTalkOutputVolume(session) {
    if (!session.talkOutputVolumeChanged) {
      return;
    }
    if (session.talkOutputVolumeRestorePromise) {
      return session.talkOutputVolumeRestorePromise;
    }

    const path = `/ISAPI/System/Audio/AudioOut/channels/${session.isapiChannel}`;
    session.talkOutputVolumeRestorePromise = (async () => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const currentResponse = await isapiRequest(this.config, "GET", path);
          const current = currentResponse.body;
          const match = current.match(/(<TalkOutVolume\b[^>]*>[\s\S]*?<volume>)\s*\d+\s*(<\/volume>[\s\S]*?<\/TalkOutVolume>)/i);
          if (match) {
            const updated = current.replace(match[0], `${match[1]}${session.previousTalkOutputVolume}${match[2]}`);
            await isapiRequest(this.config, "PUT", path, updated, "application/xml");
            session.talkOutputVolumeChanged = false;
            this.platform.log.info(`homekit.talk.audio-output-restored camera=${this.cameraName()} channel=${session.isapiChannel} volume=${session.previousTalkOutputVolume} attempt=${attempt}`);
          }
          return;
        } catch (error) {
          if (attempt === 3) {
            this.platform.log.warn(`homekit.talk.audio-output-restore-error camera=${this.cameraName()} error=${redactLog(error.message)}`);
            return;
          }
          await delay(250 * attempt);
        }
      }
    })();
    return session.talkOutputVolumeRestorePromise;
  }

  startHcnetSpeakerProcess(session) {
    this.lastError = "HCNetSDK talkback transport is disabled in the SDK-free package";
    this.platform.log.warn(`homekit.talk.speaker.unavailable camera=${this.cameraName()} session=${session.sessionID} transport=hcnet-sdk reason=sdk-transport-disabled`);
    return null;
  }

  startPrivateSpeakerProcess(session) {
    let pcmRemainder = Buffer.alloc(0);
    let g711Remainder = Buffer.alloc(0);
    session.privateMediaQueue = [];
    session.privateMediaBytesSent = 0;
    session.privateMediaFramesSent = 0;
    session.privateMediaFramesDropped = 0;
    session.privateMediaConnected = false;
    this.beginPrivateTalkbackHandshake(session);
    const speaker = {
      closed: false,
      killed: false,
      bytesReceived: 0,
      writePcm: (chunk) => {
        if (speaker.closed || !chunk?.length) {
          return false;
        }
        speaker.bytesReceived += chunk.length;
        session.privatePcmBytesReceived = (session.privatePcmBytesReceived || 0) + chunk.length;
        if (Array.isArray(session.privateMediaQueue)) {
          const pcm = pcmRemainder.length ? Buffer.concat([pcmRemainder, chunk]) : chunk;
          const incompleteGroupBytes = pcm.length % PCM16LE_16KHZ_TO_G711_GROUP_BYTES;
          pcmRemainder = incompleteGroupBytes ? pcm.subarray(pcm.length - incompleteGroupBytes) : Buffer.alloc(0);
          const encoded = downsample16kPcmTo8kMulaw(pcm.subarray(0, pcm.length - pcmRemainder.length));
          const audio = g711Remainder.length ? Buffer.concat([g711Remainder, encoded]) : encoded;
          const frameBytes = G711_AUDIO_FRAME_BYTES;
          let offset = 0;
          while (offset + frameBytes <= audio.length) {
            const frame = audio.subarray(offset, offset + frameBytes);
            const voicePacket = buildPrivateG711VoicePacket(frame);
            this.enqueuePrivateVoiceMediaFrame(session, voicePacket);
            offset += frameBytes;
          }
          g711Remainder = audio.subarray(offset);
        }
        return true;
      },
      kill: (reason = "stop") => {
        if (speaker.closed) {
          return;
        }
        speaker.closed = true;
        speaker.killed = true;
        this.clearPrivateVoiceMediaQueue(session);
        session.privateMediaSocket?.destroy();
        session.privateControlSocket?.destroy();
        session.privateMediaSocket = null;
        session.privateControlSocket = null;
        session.privateMediaConnected = false;
        this.platform.log.info(`homekit.talk.speaker.exited camera=${this.cameraName()} session=${session.sessionID} transport=private reason=${reason} pcmBytes=${speaker.bytesReceived}`);
      },
    };
    session.speakerProcess = speaker;
    this.lastError = null;
    this.platform.log.info(`homekit.talk.speaker.starting camera=${this.cameraName()} session=${session.sessionID} transport=private port=${this.config.privatePort || DEFAULT_PRIVATE_PORT}`);
    return speaker;
  }

  isSessionActive(session) {
    return Boolean(session?.sessionID && this.sessions.get(session.sessionID) === session);
  }

  beginPrivateTalkbackHandshake(session) {
    this.privateHandshake = {
      ok: false,
      stage: "connecting",
      updatedAt: Date.now(),
    };
    openHikvisionPrivateTalkback(this.config, {
      connectTimeoutMs: this.config.privateConnectTimeoutMs,
      replyTimeoutMs: this.config.privateReplyTimeoutMs,
    }).then(({ socket, controlSocket, deviceUserId }) => {
      if (!this.isSessionActive(session)) {
        socket.destroy();
        controlSocket?.destroy();
        return;
      }
      session.privateMediaSocket = socket;
      session.privateControlSocket = controlSocket;
      session.privateMediaConnected = true;
      this.privateHandshake = {
        ok: true,
        stage: "voice-ready",
        deviceUserId,
        updatedAt: Date.now(),
      };
      this.lastError = null;
      this.armPrivateVoiceMediaQueue(session);
      socket.once("error", (error) => {
        this.lastError = error.message;
        this.platform.log.warn(`homekit.talk.private.voice-media.error camera=${this.cameraName()} session=${session.sessionID} error=${redactLog(error.message)}`);
      });
      socket.once("close", () => {
        this.clearPrivateVoiceMediaQueue(session);
        session.privateMediaConnected = false;
        if (session.privateMediaSocket === socket) session.privateMediaSocket = null;
        controlSocket?.destroy();
        if (session.privateControlSocket === controlSocket) session.privateControlSocket = null;
      });
      this.platform.log.info(`homekit.talk.private.voice-ready camera=${this.cameraName()} session=${session.sessionID} deviceUserId=${deviceUserId}`);
    }).catch((error) => {
      if (!this.isSessionActive(session)) {
        return;
      }
      this.privateHandshake = {
        ok: false,
        stage: "error",
        error: error.message,
        updatedAt: Date.now(),
      };
      this.lastError = error.message;
      this.platform.log.warn(`homekit.talk.private.handshake.error camera=${this.cameraName()} session=${session.sessionID} error=${redactLog(error.message)}`);
    });
  }

  enqueuePrivateVoiceMediaFrame(session, frame) {
    if (!frame?.length) {
      return false;
    }
    const maxQueuedFrames = Math.max(Number(this.config.privateVoiceMediaMaxQueuedFrames ?? 50), 1);
    if (!Array.isArray(session.privateMediaQueue)) {
      session.privateMediaQueue = [];
    }
    while (session.privateMediaQueue.length >= maxQueuedFrames) {
      session.privateMediaQueue.shift();
      session.privateMediaFramesDropped = (session.privateMediaFramesDropped || 0) + 1;
    }
    session.privateMediaQueue.push(Buffer.from(frame));
    if (!session.firstPrivateMediaFrameQueuedLogged) {
      session.firstPrivateMediaFrameQueuedLogged = true;
      this.platform.log.info(`homekit.talk.private.voice-media.first-frame-queued camera=${this.cameraName()} session=${session.sessionID} frameBytes=${frame.length} queuedFrames=${session.privateMediaQueue.length}`);
    }
    this.armPrivateVoiceMediaQueue(session);
    return true;
  }

  armPrivateVoiceMediaQueue(session) {
    if (session.privateMediaTimer) {
      return;
    }
    const delayMs = this.privateVoiceMediaFrameDelayMs();
    const pump = () => {
      session.privateMediaTimer = null;
      const socket = session.privateMediaSocket;
      if (!session.privateMediaConnected || !socket || socket.destroyed || !socket.writable) {
        return;
      }
      const frame = session.privateMediaQueue?.shift();
      if (frame?.length) {
        socket.write(frame);
        session.privateMediaBytesSent = (session.privateMediaBytesSent || 0) + frame.length;
        session.privateMediaFramesSent = (session.privateMediaFramesSent || 0) + 1;
        if (!session.firstPrivateMediaFrameSentLogged) {
          session.firstPrivateMediaFrameSentLogged = true;
          this.platform.log.info(`homekit.talk.private.voice-media.first-packet-sent camera=${this.cameraName()} session=${session.sessionID} audioFrameBytes=${G711_AUDIO_FRAME_BYTES} wirePacketBytes=${frame.length} packetsSent=${session.privateMediaFramesSent} bytesSent=${session.privateMediaBytesSent}`);
        }
      }
      if (session.privateMediaQueue?.length) {
        session.privateMediaTimer = setTimeout(pump, delayMs);
        session.privateMediaTimer.unref?.();
      }
    };
    session.privateMediaTimer = setTimeout(pump, 0);
    session.privateMediaTimer.unref?.();
  }

  clearPrivateVoiceMediaQueue(session) {
    if (session?.privateMediaTimer) {
      clearTimeout(session.privateMediaTimer);
      session.privateMediaTimer = null;
    }
    if (session) {
      session.privateMediaQueue = [];
    }
  }

  privateVoiceMediaFrameDelayMs() {
    return 20;
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
    if (session.sessionID && !session.firstDecodedPcmLogged) {
      session.firstDecodedPcmLogged = true;
      this.platform.log.info(`homekit.talk.receiver.first-pcm camera=${this.cameraName()} session=${session.sessionID} bytes=${payload.length}`);
    }
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
        portReservedAt: session.audioReturnPortReservedAt,
        receiverStartDelayMs: session.receiverStartDelayMs,
        codec: session.codec,
        sampleRate: session.sampleRate,
        payloadType: session.payloadType,
        startedAt: session.startedAt,
        decodedChunks: session.decodedChunks,
        decodedBytes: session.decodedBytes,
        receiverError: session.receiverError,
        receiverExit: session.receiverExit,
        privateMediaBytesSent: session.privateMediaBytesSent || 0,
        privateMediaFramesSent: session.privateMediaFramesSent || 0,
        privateMediaFramesDropped: session.privateMediaFramesDropped || 0,
        privateMediaQueuedFrames: session.privateMediaQueue?.length || 0,
        privateMediaConnected: Boolean(session.privateMediaConnected && session.privateMediaSocket && !session.privateMediaSocket.destroyed),
        receiverActive: Boolean(session.process && !session.process.killed && !session.receiverExited),
        speakerActive: Boolean(session.speakerProcess && !session.speakerProcess.killed),
        diagnosis: this.sessionTalkbackDiagnosis(session),
      })),
      decodedChunks: this.totalDecodedChunks,
      decodedBytes: this.totalDecodedBytes,
      lastError: this.lastError ? redactLog(this.lastError) : null,
      privateHandshake: sanitizePrivateStatus(this.privateHandshake, {
        showRedirectHost: this.config.privateStatusShowRedirectHost === true,
      }),
      speakerOutput: this.speakerOutputName(),
      aec: {
        enabled: this.config.talkbackAec === true,
        backend: this.config.talkbackAecBackend || "none",
      },
    };
  }

  cameraName() {
    return this.config.name || this.config.did || "hikvision-camera";
  }

  speakerOutputName() {
    if (this.config.talkbackTransport === "hcnet-sdk") {
      return "hcnet-sdk-disabled";
    }
    if (this.config.talkbackTransport === "isapi") {
      return "isapi";
    }
    if (this.config.talkbackTransport === "private") {
      return "private";
    }
    return this.config.talkbackSpeakerCommand ? "command" : "not-configured";
  }

  talkbackSdpListenAddress(session) {
    const configured = String(this.config.talkbackSdpAddress || this.config.talkbackListenAddress || "").trim();
    if (configured) {
      return configured;
    }
    if (session?.ipv6) {
      return "::";
    }
    return selectLocalIpv4Address(session?.address);
  }

  sessionTalkbackDiagnosis(session) {
    if (session.receiverError) {
      return { stage: "receiver-error", detail: session.receiverError };
    }
    if (session.receiverExit && !session.decodedChunks) {
      return { stage: "receiver-exited-no-pcm", detail: `code=${session.receiverExit.code} signal=${session.receiverExit.signal || "none"}` };
    }
    if (!session.decodedChunks) {
      return { stage: "waiting-for-homekit-pcm" };
    }
    if (!session.privateMediaQueue && !session.privateMediaSocket && this.config.talkbackTransport === "private") {
      return { stage: "pcm-before-private-media" };
    }
    if ((session.privateMediaFramesSent || 0) > 0) {
      return { stage: "private-media-sent", framesSent: session.privateMediaFramesSent, bytesSent: session.privateMediaBytesSent || 0 };
    }
    if ((session.privateMediaQueue?.length || 0) > 0) {
      return { stage: "private-media-queued-not-sent", queuedFrames: session.privateMediaQueue.length, connected: Boolean(session.privateMediaConnected) };
    }
    if (this.config.talkbackTransport === "private") {
      return { stage: "pcm-decoded-waiting-private-media", decodedChunks: session.decodedChunks, decodedBytes: session.decodedBytes };
    }
    return { stage: "pcm-decoded", decodedChunks: session.decodedChunks, decodedBytes: session.decodedBytes };
  }
}

function selectLocalIpv4Address(peerAddress) {
  const interfaces = os.networkInterfaces();
  const addresses = Object.values(interfaces)
    .flatMap((entries) => entries || [])
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  if (!addresses.length) {
    return "127.0.0.1";
  }

  const peerOctets = String(peerAddress || "").split(".");
  if (peerOctets.length === 4) {
    const sameSubnet = addresses.find((address) => {
      const octets = address.split(".");
      return octets.length === 4 && octets.slice(0, 3).join(".") === peerOctets.slice(0, 3).join(".");
    });
    if (sameSubnet) {
      return sameSubnet;
    }
  }
  return addresses[0];
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function buildReturnAudioSdp(options) {
  const ipVersion = options.ipv6 ? "IP6" : "IP4";
  const codec = String(options.codec || "AAC-eld");
  const rtpProfile = String(options.rtpProfile || "RTP/SAVP");
  const aacFmtp = options.aacFmtp === false
    ? ""
    : String(options.aacFmtp || "profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3; config=F8F0212C00BC00");
  const codecLine = codec.toUpperCase() === "OPUS"
    ? `a=rtpmap:${options.payloadType} opus/${options.sampleRate}/1\r\n`
    : `a=rtpmap:${options.payloadType} MPEG4-GENERIC/${options.sampleRate}/1\r\n`
      + (aacFmtp ? `a=fmtp:${options.payloadType} ${aacFmtp}\r\n` : "");

  return "v=0\r\n"
    + `o=- 0 0 IN ${ipVersion} ${options.address}\r\n`
    + "s=Talk\r\n"
    + `c=IN ${ipVersion} ${options.address}\r\n`
    + "t=0 0\r\n"
    + `m=audio ${options.port} ${rtpProfile} ${options.payloadType}\r\n`
    + "b=AS:24\r\n"
    + codecLine
    + `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${options.srtp.toString("base64")}\r\n`
    + "a=recvonly\r\n";
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
  return 8000;
}

function consumeDiagnosticToneFlag() {
  try {
    if (!fs.existsSync(TALKBACK_DIAGNOSTIC_TONE_FLAG)) {
      return false;
    }
    fs.unlinkSync(TALKBACK_DIAGNOSTIC_TONE_FLAG);
    return true;
  } catch (_error) {
    return false;
  }
}

function isapiUrl(config, pathName) {
  const protocol = String(config.httpProtocol || (config.https ? "https" : "http")).replace(/:$/, "");
  const port = Number(config.httpPort || (protocol === "https" ? 443 : 80));
  return `${protocol}://${config.ip}:${port}${pathName}`;
}

function cookieHeaderFromHeaders(headers = {}) {
  const values = headers["set-cookie"] || headers["Set-Cookie"] || [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const cookie = String(value || "").split(";", 1)[0].trim();
    if (/^WebSession(?:_|=)/i.test(cookie)) {
      return cookie;
    }
  }
  return "";
}

async function openIsapiAudioSocket(config, pathName, authorization) {
  const target = new URL(isapiUrl(config, pathName));
  if (target.protocol !== "http:") {
    throw new Error("ISAPI raw audio transport currently requires HTTP");
  }
  const port = Number(target.port || 80);
  const hostHeader = target.port && Number(target.port) !== 80 ? `${target.hostname}:${target.port}` : target.hostname;
  const requestHead = [
    `PUT ${target.pathname}${target.search} HTTP/1.1`,
    `HOST: ${hostHeader}`,
    `Authorization: ${authorization}`,
    "Connection: keep-alive",
    "Content-Length: 0",
    "Content-Type: application/octet-stream",
    "",
    "",
  ].join("\r\n");

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: target.hostname, port });
    let settled = false;
    let responseBuffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      if (!settled) {
        socket.destroy();
        reject(new Error("ISAPI audio socket handshake timeout"));
      }
    }, 8000);
    const finish = (error, statusCode = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        socket.destroy();
        reject(error);
        return;
      }
      socket.isapiStatusCode = statusCode;
      resolve(socket);
    };
    socket.setNoDelay(true);
    socket.on("connect", () => socket.write(requestHead));
    socket.on("data", (chunk) => {
      if (settled) return;
      responseBuffer = Buffer.concat([responseBuffer, chunk]);
      const headerEnd = responseBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = responseBuffer.subarray(0, headerEnd).toString("latin1");
      const match = header.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
      const statusCode = match ? Number(match[1]) : 0;
      if (statusCode < 200 || statusCode >= 300) {
        finish(new Error(`ISAPI audio upload returned HTTP ${statusCode}`));
        return;
      }
      finish(null, statusCode);
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => finish(new Error("ISAPI audio socket closed during handshake")));
  });
}

async function isapiAuthorization(config, method, pathName, body = null) {
  const target = new URL(isapiUrl(config, pathName));
  const transport = target.protocol === "https:" ? https : http;
  const challenge = await new Promise((resolve, reject) => {
    const request = transport.request(target, {
      method,
      headers: { "Content-Length": "0" },
      rejectUnauthorized: false,
    }, (response) => {
      const value = response.headers["www-authenticate"];
      response.resume();
      resolve({ statusCode: response.statusCode || 0, challenge: value });
    });
    request.once("error", reject);
    request.setTimeout(4000, () => request.destroy(new Error("ISAPI authentication timeout")));
    request.end();
  });
  if (challenge.statusCode !== 401 || !challenge.challenge) {
    return null;
  }
  return digestAuthorization(config, method, pathName, challenge.challenge, body);
}

async function isapiRequest(config, method, pathName, body = null, contentType = null) {
  const authorization = await isapiAuthorization(config, method, pathName, body);
  const target = new URL(isapiUrl(config, pathName));
  const transport = target.protocol === "https:" ? https : http;
  const result = await new Promise((resolve, reject) => {
    const request = transport.request(target, {
      method,
      headers: {
        Authorization: authorization || undefined,
        "Content-Length": body ? Buffer.byteLength(body) : 0,
        ...(contentType ? { "Content-Type": contentType } : {}),
      },
      rejectUnauthorized: false,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        statusCode: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.setTimeout(4000, () => request.destroy(new Error("ISAPI control request timeout")));
    request.end(body || undefined);
  });
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(`ISAPI ${method} ${pathName} returned HTTP ${result.statusCode}`);
  }
  return result;
}

function digestAuthorization(config, method, pathName, challenge, body = null) {
  const values = parseAuthenticateChallenge(challenge);
  if (!values.nonce) {
    return `Basic ${Buffer.from(`${config.username || ""}:${config.password || ""}`).toString("base64")}`;
  }
  const username = String(config.username || "");
  const password = String(config.password || "");
  const nc = "00000001";
  const cnonce = crypto.randomBytes(8).toString("hex");
  const qop = normalizeDigestQop(values.qop);
  const algorithm = normalizeDigestAlgorithm(values.algorithm);
  const baseHa1 = digestHash(algorithm.hash, `${username}:${values.realm || ""}:${password}`);
  const ha1 = algorithm.session ? digestHash(algorithm.hash, `${baseHa1}:${values.nonce}:${cnonce}`) : baseHa1;
  const ha2 = qop === "auth-int"
    ? digestHash(algorithm.hash, `${method}:${pathName}:${digestHash(algorithm.hash, normalizeDigestBody(body))}`)
    : digestHash(algorithm.hash, `${method}:${pathName}`);
  const response = qop
    ? digestHash(algorithm.hash, `${ha1}:${values.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : digestHash(algorithm.hash, `${ha1}:${values.nonce}:${ha2}`);
  const parts = [`username="${username}"`, `realm="${values.realm || ""}"`, `nonce="${values.nonce}"`, `uri="${pathName}"`, `response="${response}"`];
  if (values.algorithm) parts.push(`algorithm=${values.algorithm}`);
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (values.opaque) parts.push(`opaque="${values.opaque}"`);
  return `Digest ${parts.join(", ")}`;
}

function parseAuthenticateChallenge(challenge) {
  const header = String(challenge || "");
  const digest = header.match(/(?:^|,\s*)Digest\s+(.+?)(?=,\s*(?:Basic|Bearer|Negotiate)\s+|$)/i)?.[1] || header;
  const values = {};
  for (const match of digest.matchAll(/([a-z][a-z0-9_-]*)\s*=\s*(?:"([^"]*)"|([^,\s]+))/gi)) {
    values[match[1].toLowerCase()] = match[2] ?? match[3] ?? "";
  }
  return values;
}

function normalizeDigestQop(value) {
  const modes = String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!modes.length) {
    return "";
  }
  return modes.includes("auth") ? "auth" : modes[0];
}

function normalizeDigestAlgorithm(value) {
  const normalized = String(value || "MD5").toUpperCase();
  return {
    hash: normalized.includes("SHA-512-256") ? "sha512-256" : normalized.includes("SHA-256") ? "sha256" : "md5",
    session: normalized.includes("-SESS"),
  };
}

function digestHash(algorithm, value) {
  return crypto.createHash(algorithm).update(value).digest("hex");
}

function normalizeDigestBody(body) {
  if (body === undefined || body === null) {
    return "";
  }
  return Buffer.isBuffer(body) ? body : String(body);
}

function xmlTag(xml, tag) {
  const match = String(xml || "").match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i"));
  return match ? match[1].trim() : "";
}

function sanitizePrivateStatus(value, options = {}) {
  if (!value || typeof value !== "object") {
    return value || null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePrivateStatus(item, options));
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      if (key === "host" && options.showRedirectHost !== true) {
        result[key] = "[redacted]";
        continue;
      }
      result[key] = key.toLowerCase().includes("error")
        ? redactLog(item)
        : item;
      continue;
    }
    result[key] = item && typeof item === "object"
      ? sanitizePrivateStatus(item, options)
      : item;
  }
  return result;
}

function redactLog(message) {
  return message
    .replace(/https?:\/\/[^\s]+/g, "[URL]")
    .replace(/rtsp:\/\/[^\s]+/g, "[URL]");
}

module.exports = {
  HomeKitTalkback,
};
