"use strict";

const crypto = require("crypto");
const http = require("http");
const https = require("https");

class HikvisionIsapiEventListener {
  constructor(platform, config, handlers = {}) {
    this.platform = platform;
    this.config = config;
    this.handlers = handlers;
    this.request = null;
    this.reconnectTimer = null;
    this.stopped = false;
    this.buffer = "";
    this.lastMotionAt = 0;
    this.reconnectDelayMs = 30000;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.request?.destroy();
    this.request = null;
  }

  connect() {
    if (this.stopped || this.request) {
      return;
    }

    this.openRequest().catch((error) => {
      this.request?.destroy();
      this.request = null;
      if (this.stopped) return;
      this.platform.log.warn(`isapi.events.error camera=${this.cameraName()} error=${safeLog(error.message)}`);
      if (error.statusCode === 404 || error.statusCode === 405 || error.statusCode === 501) {
        this.stopped = true;
        this.platform.log.warn(`isapi.events.unsupported camera=${this.cameraName()} status=${error.statusCode}; automatic retries disabled`);
        return;
      }
      this.scheduleReconnect();
    });
  }

  async openRequest() {
    const first = await this.requestOnce();
    if (this.stopped) {
      first.response.destroy();
      return;
    }
    if (first.statusCode !== 401) {
      this.requireSuccess(first);
      this.consumeResponse(first.response);
      return;
    }

    const challenge = first.response.headers["www-authenticate"];
    first.response.resume();
    if (!challenge) {
      throw new Error(`ISAPI alertStream returned HTTP 401 without authentication challenge`);
    }

    const authorization = this.authorizationHeader(challenge);
    const authenticated = await this.requestOnce(authorization);
    if (this.stopped) {
      authenticated.response.destroy();
      return;
    }
    this.requireSuccess(authenticated);
    this.consumeResponse(authenticated.response);
  }

  requireSuccess({ response, statusCode }) {
    if (statusCode >= 200 && statusCode < 300) return;
    response.destroy();
    const error = new Error(`ISAPI alertStream returned HTTP ${statusCode}`);
    error.statusCode = statusCode;
    throw error;
  }

  requestOnce(authorization) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.alertStreamUrl());
      const transport = url.protocol === "https:" ? https : http;
      const headers = { Accept: "application/xml" };
      if (authorization) {
        headers.Authorization = authorization;
      }

      const request = transport.request(url, {
        method: "GET",
        headers,
        rejectUnauthorized: false,
        timeout: Number(this.config.isapiEventTimeoutMs || 15000),
      }, (response) => resolve({ response, statusCode: response.statusCode || 0 }));
      this.request = request;
      request.once("error", reject);
      request.once("timeout", () => request.destroy(new Error("ISAPI alertStream timeout")));
      request.end();
    });
  }

  consumeResponse(response) {
    this.buffer = "";
    this.platform.log.info(`isapi.events.armed camera=${this.cameraName()} endpoint=${this.alertStreamUrl()}`);
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      if (this.stopped) return;
      this.reconnectDelayMs = 30000;
      this.consumeChunk(chunk);
    });
    response.on("error", (error) => this.handleDisconnect(error));
    response.on("end", () => this.handleDisconnect(new Error("ISAPI alertStream ended")));
  }

  consumeChunk(chunk) {
    this.buffer = (this.buffer + chunk).slice(-256 * 1024);
    const pattern = /<EventNotificationAlert[\s\S]*?<\/EventNotificationAlert>/gi;
    let match;
    while ((match = pattern.exec(this.buffer))) {
      this.handleAlert(match[0]);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      pattern.lastIndex = 0;
    }
  }

  handleAlert(xml) {
    const eventType = xmlValue(xml, "eventType").toLowerCase();
    const eventState = xmlValue(xml, "eventState").toLowerCase();
    const motion = eventType.includes("motion") || eventType.includes("vmd") || eventType === "fielddetection";
    if (!motion) {
      return;
    }

    const now = Date.now();
    const motionActive = !eventState || eventState === "active" || eventState === "detected";
    const motionInactive = eventState === "inactive" || eventState === "idle" || eventState === "stopped";
    if (!motionActive && !motionInactive) {
      return;
    }

    const debounceMs = Number(this.config.motionDebounceMs || 1000);
    if (motionActive && now - this.lastMotionAt < debounceMs) {
      return;
    }
    if (motionActive) {
      this.lastMotionAt = now;
    }
    this.platform.log.debug(`isapi.events.motion camera=${this.cameraName()} eventType=${eventType || "unknown"} state=${eventState || "active"}`);
    this.handlers.onMotion?.({
      source: "hikvision-isapi",
      reason: "isapi-motion",
      eventType,
      eventState: eventState || "active",
      motionActive,
      durationMs: Number(this.config.motionHoldMs || this.config.hsvMotionDurationMs || 60000),
      receivedAt: now,
    });
  }

  handleDisconnect(error) {
    this.request?.destroy();
    this.request = null;
    this.buffer = "";
    if (!this.stopped) {
      this.platform.log.warn(`isapi.events.reconnect camera=${this.cameraName()} error=${safeLog(error.message)}`);
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 300000);
    this.reconnectTimer.unref?.();
  }

  authorizationHeader(challenge) {
    const values = parseAuthenticateChallenge(challenge);
    if (!values.nonce) {
      return `Basic ${Buffer.from(`${this.config.username || ""}:${this.config.password || ""}`).toString("base64")}`;
    }

    const username = String(this.config.username || "");
    const password = String(this.config.password || "");
    const uri = new URL(this.alertStreamUrl()).pathname;
    const nc = "00000001";
    const cnonce = crypto.randomBytes(8).toString("hex");
    const qop = normalizeDigestQop(values.qop);
    const algorithm = normalizeDigestAlgorithm(values.algorithm);
    const baseHa1 = digestHash(algorithm.hash, `${username}:${values.realm || ""}:${password}`);
    const ha1 = algorithm.session ? digestHash(algorithm.hash, `${baseHa1}:${values.nonce}:${cnonce}`) : baseHa1;
    const ha2 = digestHash(algorithm.hash, `GET:${uri}`);
    const response = qop
      ? digestHash(algorithm.hash, `${ha1}:${values.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
      : digestHash(algorithm.hash, `${ha1}:${values.nonce}:${ha2}`);
    const parts = [`username="${username}"`, `realm="${values.realm || ""}"`, `nonce="${values.nonce}"`, `uri="${uri}"`, `response="${response}"`];
    if (values.algorithm) parts.push(`algorithm=${values.algorithm}`);
    if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
    if (values.opaque) parts.push(`opaque="${values.opaque}"`);
    return `Digest ${parts.join(", ")}`;
  }

  alertStreamUrl() {
    const protocol = String(this.config.httpProtocol || (this.config.https ? "https" : "http")).replace(/:$/, "");
    const port = Number(this.config.httpPort || (protocol === "https" ? 443 : 80));
    return `${protocol}://${this.config.ip}:${port}/ISAPI/Event/notification/alertStream`;
  }

  cameraName() {
    return this.config.name || this.config.did || this.config.ip || "hikvision";
  }
}

function xmlValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i"));
  return match ? match[1].trim() : "";
}

function normalizeDigestAlgorithm(value) {
  const normalized = String(value || "MD5").toUpperCase();
  return {
    hash: normalized.includes("SHA-256") ? "sha256" : "md5",
    session: normalized.includes("-SESS"),
  };
}

function digestHash(algorithm, value) {
  return crypto.createHash(algorithm).update(value).digest("hex");
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

function safeLog(value) {
  return String(value || "unknown").replace(/(password|token|authorization)=?[^ ]*/gi, "$1=[redacted]");
}

module.exports = { HikvisionIsapiEventListener };
