"use strict";

const { spawn } = require("child_process");
const { analyzeMotionFrame } = require("./motion-frame-detector");

class HikvisionSubstreamMotionAnalyzer {
  constructor(platform, config, metrics, rtspUrlProvider, motionSink) {
    this.platform = platform;
    this.config = config;
    this.metrics = metrics;
    this.rtspUrlProvider = rtspUrlProvider;
    this.motionSink = typeof motionSink === "function" ? motionSink : null;
    this.enabled = config.hsv === true && config.motionVideoAnalysis !== false;
    this.width = 160;
    this.height = 90;
    this.fps = 2;
    this.difference = 5;
    // The door station sees a visitor only in a relatively small part of the
    // 640x480 technical frame.  A 1.5% full-frame threshold misses people who
    // stop at the entrance after walking into view.
    this.changedPercentThreshold = 0.45;
    this.consecutiveFramesRequired = 2;
    this.warmupFrames = 4;
    this.minimumRegionPixels = 8;
    this.noiseMultiplier = 4;
    this.process = null;
    this.outputRemainder = Buffer.alloc(0);
    this.previousFrame = null;
    this.frames = 0;
    this.consecutiveFrames = 0;
    this.triggers = 0;
    this.lastTriggerAt = 0;
    this.lastFrameAt = null;
    this.lastChangedPercent = null;
    this.lastError = null;
    this.restartTimer = null;
    this.stopped = true;
  }

  start() {
    if (!this.enabled || this.process || !this.stopped) return;
    this.stopped = false;
    this.startProcess();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.process?.kill("SIGTERM");
    this.process = null;
    this.outputRemainder = Buffer.alloc(0);
    this.previousFrame = null;
  }

  startProcess() {
    if (this.stopped || this.process) return;
    const url = this.rtspUrlProvider?.();
    if (!url) {
      this.lastError = "technical RTSP URL unavailable";
      this.scheduleRestart();
      return;
    }

    const ffmpeg = this.config.ffmpeg || "ffmpeg";
    const args = [
      "-hide_banner", "-loglevel", "warning",
      "-rtsp_transport", "tcp",
      "-rtsp_flags", "prefer_tcp",
      "-fflags", "+discardcorrupt+nobuffer+genpts",
      "-flags", "low_delay",
      "-analyzeduration", "5000000",
      "-probesize", "1048576",
      "-i", url,
      "-an",
      "-vf", `fps=${this.fps},scale=${this.width}:${this.height},format=gray`,
      "-pix_fmt", "gray",
      "-f", "rawvideo",
      "-flush_packets", "1",
      "pipe:1",
    ];

    const proc = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.process = proc;
    this.outputRemainder = Buffer.alloc(0);
    this.previousFrame = null;
    this.consecutiveFrames = 0;
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      if (this.process === proc) this.consumeOutput(chunk);
    });
    proc.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    proc.on("error", (error) => {
      if (this.process !== proc) return;
      this.lastError = error.message;
      this.metrics?.increment("motion_analysis_errors_total");
    });
    proc.on("exit", (code, signal) => {
      if (this.process !== proc) return;
      this.process = null;
      this.previousFrame = null;
      this.outputRemainder = Buffer.alloc(0);
      if (code !== 0 && stderr.trim()) this.lastError = stderr.trim();
      if (!this.stopped) this.scheduleRestart();
    });

    this.metrics?.increment("motion_analysis_starts_total");
    this.platform.log.info(`motion.analysis.started camera=${this.cameraName()} source=rtsp-substream channel=102 size=${this.width}x${this.height} fps=${this.fps}`);
  }

  scheduleRestart() {
    if (this.stopped || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.startProcess();
    }, 5000);
    this.restartTimer.unref?.();
  }

  consumeOutput(chunk) {
    this.outputRemainder = Buffer.concat([this.outputRemainder, chunk]);
    const frameSize = this.width * this.height;
    while (this.outputRemainder.length >= frameSize) {
      const frame = Buffer.from(this.outputRemainder.subarray(0, frameSize));
      this.outputRemainder = this.outputRemainder.subarray(frameSize);
      this.processFrame(frame);
    }
    if (this.outputRemainder.length > frameSize * 2) {
      this.outputRemainder = this.outputRemainder.subarray(-frameSize);
    }
  }

  processFrame(frame) {
    const now = Date.now();
    this.frames += 1;
    this.lastFrameAt = now;
    if (!this.previousFrame || this.frames <= this.warmupFrames) {
      this.previousFrame = frame;
      return;
    }

    const analysis = analyzeMotionFrame(frame, this.previousFrame, {
      width: this.width,
      height: this.height,
      difference: this.difference,
      minimumRegionPixels: this.minimumRegionPixels,
      noiseMultiplier: this.noiseMultiplier,
      // Hikvision burns the clock into the upper-left corner of channel 102.
      // Exclude that small changing overlay from motion calculations.
      ignoredTopRows: Math.floor(this.height * 0.16),
      ignoredLeftColumns: Math.floor(this.width * 0.55),
    });
    this.previousFrame = frame;
    this.lastChangedPercent = Math.round(analysis.changedPercent * 100) / 100;
    if (!analysis.valid || analysis.changedPercent < this.changedPercentThreshold) {
      this.consecutiveFrames = 0;
      return;
    }

    this.consecutiveFrames += 1;
    if (this.consecutiveFrames < this.consecutiveFramesRequired) return;
    this.consecutiveFrames = 0;
    if (now - this.lastTriggerAt < 2000) return;
    this.lastTriggerAt = now;
    this.triggers += 1;
    this.metrics?.increment("motion_analysis_triggers_total");
    this.platform.log.info(`motion.analysis.triggered camera=${this.cameraName()} source=rtsp-substream changedPercent=${this.lastChangedPercent} thresholdPercent=${this.changedPercentThreshold}`);
    this.motionSink?.({
      source: "hikvision-substream-analysis",
      durationMs: this.config.hsvMotionDurationMs,
      changedPercent: this.lastChangedPercent,
      thresholdPercent: this.changedPercentThreshold,
    });
  }

  getStatusSnapshot() {
    return {
      enabled: this.enabled,
      active: Boolean(this.process),
      source: "rtsp-substream-102",
      frames: this.frames,
      triggers: this.triggers,
      lastFrameAt: this.lastFrameAt,
      lastChangedPercent: this.lastChangedPercent,
      lastError: this.lastError,
    };
  }

  cameraName() {
    return this.config.name || this.config.did || "hikvision-camera";
  }
}

module.exports = { HikvisionSubstreamMotionAnalyzer };
