"use strict";

class PacketActivityMotionDetector {
  constructor(platform, config, metrics) {
    this.platform = platform;
    this.config = config;
    this.metrics = metrics;
    this.enabled = config.motionDetection === true;
    this.windowMs = Math.max(Number(config.motionWindowMs || 1000), 250);
    this.cooldownMs = Math.max(Number(config.motionCooldownMs ?? (Number(config.motionCooldownSeconds || 10) * 1000)), 0);
    this.minPackets = Math.max(Number(config.motionMinPackets || 12), 1);
    this.minBytes = Math.max(Number(config.motionMinBytes || 160 * 1024), 1024);
    this.activityRatio = Math.max(Number(config.motionActivityRatio || 2.5), 1.1);
    this.baselineAlpha = Math.min(Math.max(Number(config.motionBaselineAlpha || 0.05), 0.001), 1);
    this.warmupMs = Math.max(Number(config.motionWarmupMs || 30000), 0);
    this.samples = [];
    this.lastMotionAt = 0;
    this.startedAt = Date.now();
    this.baselineBytes = null;
    this.lastWindowBytes = 0;
    this.lastThresholdBytes = null;
    this.motionSink = null;
  }

  setMotionSink(motionSink) {
    this.motionSink = typeof motionSink === "function" ? motionSink : null;
  }

  observePacket(packet) {
    if (!this.enabled || packet?.codec !== "h264" || !packet.payload?.length) {
      return false;
    }

    const now = Date.now();
    this.samples.push({ at: now, bytes: packet.payload.length });
    this.trim(now);

    if (now - this.lastMotionAt < this.cooldownMs) {
      return false;
    }

    const packets = this.samples.length;
    const bytes = this.samples.reduce((sum, sample) => sum + sample.bytes, 0);
    this.lastWindowBytes = bytes;

    if (Date.now() - this.startedAt < this.warmupMs) {
      this.updateBaseline(bytes);
      return false;
    }

    const baseline = this.baselineBytes || bytes;
    const thresholdBytes = Math.max(this.minBytes, baseline * this.activityRatio);
    this.lastThresholdBytes = Math.round(thresholdBytes);

    if (packets < this.minPackets || bytes < thresholdBytes) {
      this.updateBaseline(bytes);
      return false;
    }

    this.lastMotionAt = now;
    this.metrics?.increment("motion_detector_events_total");
    this.platform.log.info(`motion.detector.triggered camera=${this.cameraName()} backend=packet-activity packets=${packets} bytes=${bytes} baselineBytes=${Math.round(baseline)} thresholdBytes=${Math.round(thresholdBytes)}`);
    this.motionSink?.({
      source: "packet-activity",
      durationMs: this.config.hsvMotionDurationMs,
      packets,
      bytes,
      baselineBytes: Math.round(baseline),
      thresholdBytes: Math.round(thresholdBytes),
    });
    return true;
  }

  updateBaseline(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return;
    }
    if (this.baselineBytes === null) {
      this.baselineBytes = bytes;
      return;
    }
    this.baselineBytes = (this.baselineBytes * (1 - this.baselineAlpha)) + (bytes * this.baselineAlpha);
  }

  trim(now = Date.now()) {
    const cutoff = now - this.windowMs;
    while (this.samples.length && this.samples[0].at < cutoff) {
      this.samples.shift();
    }
  }

  getStatusSnapshot() {
    this.trim();
    return {
      enabled: this.enabled,
      backend: "packet-activity",
      windowMs: this.windowMs,
      cooldownMs: this.cooldownMs,
      minPackets: this.minPackets,
      minBytes: this.minBytes,
      activityRatio: this.activityRatio,
      baselineAlpha: this.baselineAlpha,
      warmupMs: this.warmupMs,
      bufferedSamples: this.samples.length,
      windowBytes: this.lastWindowBytes,
      baselineBytes: this.baselineBytes === null ? null : Math.round(this.baselineBytes),
      thresholdBytes: this.lastThresholdBytes,
      warmingUp: Date.now() - this.startedAt < this.warmupMs,
      lastMotionAt: this.lastMotionAt || null,
      hasMotionSink: Boolean(this.motionSink),
    };
  }

  cameraName() {
    return this.config.name || this.config.did || "hikvision-camera";
  }
}

module.exports = {
  PacketActivityMotionDetector,
};
