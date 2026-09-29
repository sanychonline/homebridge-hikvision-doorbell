"use strict";

const CALL_STATUS_ENDPOINTS = [
  "/ISAPI/VideoIntercom/callStatus?format=json&channelType=tripartitePlatform",
  "/ISAPI/VideoIntercom/callStatus?format=json",
  "/ISAPI/VideoIntercom/callStatus?channelType=tripartitePlatform",
  "/ISAPI/VideoIntercom/callStatus",
];

class HikvisionDoorbellCallStatusPoller {
  constructor(platform, config, client, handlers = {}) {
    this.platform = platform;
    this.config = config;
    this.client = client;
    this.handlers = handlers;
    this.timer = null;
    this.inFlight = false;
    this.stopped = true;
    this.disabled = false;
    this.initialized = false;
    this.lastState = null;
    this.endpointIndex = 0;
    this.lastErrorAt = 0;
    this.lastPollAt = null;
  }

  start() {
    if (!this.stopped || this.disabled) return;
    this.stopped = false;
    this.poll();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
  }

  async poll() {
    if (this.stopped || this.disabled || this.inFlight) return;
    this.inFlight = true;
    this.lastPollAt = Date.now();
    const endpoint = CALL_STATUS_ENDPOINTS[this.endpointIndex];
    try {
      const body = await this.client.get(endpoint);
      const state = parseCallStatus(body);
      if (!state) {
        throw new Error("VideoIntercom callStatus did not contain CallStatus.status");
      }

      if (!this.initialized) {
        this.initialized = true;
        this.lastState = state;
        this.platform.log.info(`doorbell.call-status.armed camera=${this.cameraName()} state=${state} endpoint=${endpoint}`);
      } else if (this.lastState !== state) {
        const previous = this.lastState;
        this.lastState = state;
        this.platform.log.info(`doorbell.call-status.state camera=${this.cameraName()} from=${previous} to=${state}`);
        if (state === "ring" && previous !== "ring") {
          this.handlers.onDoorbell?.({
            source: "hikvision-call-status-poll",
            reason: "video-intercom-call-status-ring",
            state,
            previousState: previous,
          });
        }
      }
    } catch (error) {
      if (this.endpointIndex < CALL_STATUS_ENDPOINTS.length - 1 && shouldTryNextEndpoint(error)) {
        const previousEndpoint = CALL_STATUS_ENDPOINTS[this.endpointIndex];
        this.endpointIndex += 1;
        this.platform.log.info(`doorbell.call-status.fallback camera=${this.cameraName()} from=${previousEndpoint} to=${CALL_STATUS_ENDPOINTS[this.endpointIndex]}`);
      } else if (isUnsupportedError(error)) {
        this.disabled = true;
        this.platform.log.info(`doorbell.call-status.disabled camera=${this.cameraName()} endpoint=${endpoint} reason=unsupported`);
      } else if (Date.now() - this.lastErrorAt > 30000) {
        this.lastErrorAt = Date.now();
        this.platform.log.warn(`doorbell.call-status.error camera=${this.cameraName()} endpoint=${endpoint} error=${safeError(error)}`);
      }
    } finally {
      this.inFlight = false;
      if (!this.stopped && !this.disabled) {
        this.timer = setTimeout(() => this.poll(), 500);
        this.timer.unref?.();
      }
    }
  }

  getStatusSnapshot() {
    return {
      enabled: !this.disabled,
      active: !this.stopped,
      endpoint: CALL_STATUS_ENDPOINTS[this.endpointIndex],
      initialized: this.initialized,
      state: this.lastState,
      lastPollAt: this.lastPollAt,
    };
  }

  cameraName() {
    return this.config.name || this.config.did || "hikvision-doorbell";
  }
}

function parseCallStatus(body) {
  try {
    const parsed = JSON.parse(String(body || ""));
    const status = parsed?.CallStatus?.status;
    if (typeof status === "string") return status.trim().toLowerCase();
  } catch (_error) {
    // Some older firmware returns XML despite format=json.
  }
  const match = String(body || "").match(/<status\b[^>]*>\s*([^<]+?)\s*<\/status>/i);
  return match ? match[1].trim().toLowerCase() : null;
}

function shouldTryNextEndpoint(error) {
  return /HTTP (400|403|404|405|501)\b|Invalid Operation|not supported/i.test(String(error?.message || ""));
}

function isUnsupportedError(error) {
  return /HTTP (403|404|405|501)\b|Invalid Operation|not supported/i.test(String(error?.message || ""));
}

function safeError(error) {
  return String(error?.message || "unknown").replace(/(password|token|authorization)=?[^ ]*/gi, "$1=[redacted]");
}

module.exports = { HikvisionDoorbellCallStatusPoller };
