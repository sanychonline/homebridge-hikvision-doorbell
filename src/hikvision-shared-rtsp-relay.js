"use strict";

const { PassThrough } = require("stream");
const { spawn } = require("child_process");

class HikvisionSharedRtspRelay {
  constructor(platform, config, getSourceUrl) {
    this.platform = platform;
    this.config = config;
    this.getSourceUrl = getSourceUrl;
    this.source = null;
    this.consumers = new Set();
    this.generation = 0;
    this.restartTimer = null;
    this.stopping = false;
  }

  createConsumer(label) {
    const consumer = new PassThrough({ highWaterMark: 1024 * 1024 });
    consumer.relayLabel = label;
    this.consumers.add(consumer);
    consumer.once("close", () => this.consumers.delete(consumer));
    consumer.once("error", () => this.consumers.delete(consumer));
    this.ensureSource();
    return consumer;
  }

  ensureSource() {
    if (this.source && !this.source.killed) {
      return;
    }

    const sourceUrl = this.getSourceUrl();
    if (!sourceUrl) {
      throw new Error("RTSP source URL is unavailable.");
    }

    const ffmpeg = this.config.ffmpeg || "/usr/local/bin/ffmpeg";
    const args = [
      "-hide_banner",
      "-loglevel",
      this.config.ffmpegDebug ? "info" : "warning",
      "-rtsp_transport",
      String(this.config.rtspTransport || "tcp"),
      "-fflags",
      "+genpts",
      "-probesize",
      "1048576",
      "-analyzeduration",
      "2000000",
      "-i",
      sourceUrl,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-b:a",
      "64k",
      "-mpegts_flags",
      "+resend_headers",
      "-f",
      "mpegts",
      "pipe:1",
    ];

    const generation = ++this.generation;
    const source = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.source = source;
    this.platform.log.info(`Hikvision shared RTSP upstream started: channel=101 consumers=${this.consumers.size} audio=transcoded-aac`);

    source.stderr.setEncoding("utf8");
    source.stderr.on("data", (data) => {
      if (this.config.ffmpegDebug) {
        for (const line of String(data).split(/\r?\n/).filter(Boolean)) {
          this.platform.log.debug(`[shared rtsp] ${line}`);
        }
      }
    });

    source.stdout.on("data", (chunk) => {
      for (const consumer of Array.from(this.consumers)) {
        if (!consumer.destroyed) {
          consumer.write(chunk);
        }
      }
    });

    source.once("error", (error) => {
      this.platform.log.warn(`Hikvision shared RTSP upstream error: ${error.message}`);
    });
    source.once("exit", (code, signal) => {
      if (this.source === source) {
        this.source = null;
      }
      for (const consumer of Array.from(this.consumers)) {
        if (!consumer.destroyed) {
          consumer.emit("relay-gap");
        }
      }
      this.platform.log.warn(`Hikvision shared RTSP upstream ended: generation=${generation} code=${code} signal=${signal || "none"}`);
      if (!this.stopping && this.consumers.size) {
        clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          try {
            this.ensureSource();
          } catch (error) {
            this.platform.log.warn(`Hikvision shared RTSP upstream restart failed: ${error.message}`);
          }
        }, 2000);
        this.restartTimer.unref?.();
      }
    });
  }

  stop(reason = "shutdown") {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    for (const consumer of Array.from(this.consumers)) {
      consumer.destroy();
    }
    this.consumers.clear();
    const source = this.source;
    this.source = null;
    if (source && !source.killed) {
      source.expectedStopReason = reason;
      source.kill("SIGTERM");
    }
  }
}

module.exports = { HikvisionSharedRtspRelay };
