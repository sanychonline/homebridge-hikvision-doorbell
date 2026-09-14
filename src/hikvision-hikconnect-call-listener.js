"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { HikConnectCallProbe, apiOrigin } = require("../tools/hikvision-hikconnect-call-probe");

class HikvisionHikConnectCallListener {
  constructor(platform, config, hooks = {}) {
    this.platform = platform;
    this.config = config;
    this.hooks = hooks;
    this.running = false;
    this.client = null;
    this.timer = null;
    this.lastSuccessAt = 0;
    this.failures = 0;
    this.lastError = null;
    this.fileStamp = null;
    this.savedSessionKey = null;
    this.lastAnswerKey = null;
    this.intervalMs = boundedNumber(config.hikConnectPollIntervalMs, 2000, 1000, 10000);
    this.maxSampleGapMs = Math.max(10000, this.intervalMs * 3);
    const storage = platform.api.user?.storagePath?.() || process.cwd();
    this.credentialsFile = expandEnv(config.hikConnectCredentialsFile);
    this.cacheFile = this.credentialsFile
      ? `${this.credentialsFile}.session`
      : path.join(storage, ".hikvision-doorbell", `${safeFilePart(config.did || config.name || "doorbell")}.hikconnect.session`);
  }

  start() {
    if (this.config.hikConnectDoorbell !== true || this.running) return;
    if (this.config.doorbellService !== true) {
      this.platform.log.warn("Hik-Connect call monitoring requires doorbellService=true.");
      return;
    }
    if (this.credentialsFile && !path.isAbsolute(this.credentialsFile)) {
      this.platform.log.error("Hik-Connect credentials must use an absolute private file path.");
      return;
    }
    this.running = true;
    this.platform.log.info(`Hik-Connect doorbell monitoring enabled; interval=${this.intervalMs}ms.`);
    this.schedule(0);
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(delayMs) {
    if (!this.running) return;
    this.timer = setTimeout(() => { void this.tick(); }, delayMs);
    this.timer.unref?.();
  }

  async loadClient() {
    const { credentials, stamp } = await this.loadCredentials();
    if (this.client && stamp === this.fileStamp) return;
    if (!credentials.indoorStationSerial) {
      throw new Error("hikconnect-missing-indoor-station-serial");
    }
    const client = new HikConnectCallProbe(credentials);
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify([
      credentials.username, credentials.password, client.origin, credentials.indoorStationSerial,
    ])).digest("hex");
    try {
      const cached = JSON.parse(await fs.readFile(this.cacheFile, "utf8"));
      if (cached.fingerprint === fingerprint && /^[a-f0-9]{32}$/i.test(cached.featureCode || "")) {
        client.origin = apiOrigin(cached.baseUrl);
        client.featureCode = cached.featureCode;
        client.setSession(cached.sessionId, cached.refreshSessionId);
      }
    } catch (_) {
      // Missing, expired or malformed cache is recoverable through our own login.
    }
    this.client = client;
    this.fingerprint = fingerprint;
    this.fileStamp = stamp;
    this.lastSuccessAt = 0;
    this.savedSessionKey = null;
  }

  async loadCredentials() {
    if (this.config.hikConnectUsername || this.config.hikConnectPassword || this.config.indoorStationSerial) {
      const credentials = {
        username: this.config.hikConnectUsername || this.config.hikConnectLogin || this.config.hikConnectAccount,
        password: this.config.hikConnectPassword,
        baseUrl: this.config.hikConnectBaseUrl,
        indoorStationSerial: this.config.indoorStationSerial || this.config.hikConnectIndoorStationSerial,
        indoorStationHost: this.config.indoorStationHost,
        indoorStationModel: this.config.indoorStationModel,
        callSignalSerial: this.config.callSignalSerial,
        outdoorStationSerial: this.config.outdoorStationSerial,
        doorbellSerial: this.config.doorbellSerial,
      };
      return {
        credentials,
        stamp: crypto.createHash("sha256").update(JSON.stringify(credentials)).digest("hex"),
      };
    }

    if (!this.credentialsFile) {
      throw new Error("missing-hikconnect-account-credentials");
    }
    const stat = await fs.stat(this.credentialsFile);
    return {
      credentials: JSON.parse(await fs.readFile(this.credentialsFile, "utf8")),
      stamp: `${stat.mtimeMs}:${stat.size}`,
    };
  }

  async persistSession() {
    const client = this.client;
    const sessionKey = `${client.session}:${client.refreshSession}`;
    if (!client.session || sessionKey === this.savedSessionKey) return;
    // Attempt once per token rotation; a read-only cache must not spam the log.
    this.savedSessionKey = sessionKey;
    const temp = `${this.cacheFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.cacheFile), { recursive: true, mode: 0o700 });
      await fs.writeFile(temp, JSON.stringify({
        fingerprint: this.fingerprint,
        baseUrl: client.origin,
        featureCode: client.featureCode,
        sessionId: client.session,
        refreshSessionId: client.refreshSession,
      }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await fs.rename(temp, this.cacheFile);
    } catch (_) {
      this.platform.log.warn("Hik-Connect session cache could not be saved; monitoring continues in memory.");
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }

  async tick() {
    let delayMs = this.intervalMs;
    try {
      await this.loadClient();
      if (!this.running) return;
      // A fresh baseline after startup or a long outage must never ring the bell.
      if (!this.lastSuccessAt || Date.now() - this.lastSuccessAt > this.maxSampleGapMs) {
        this.client.lastStatus = null;
      }
      const state = await this.client.poll();
      if (!this.running) return;
      this.lastSuccessAt = Date.now();
      if (this.failures) this.platform.log.info("Hik-Connect doorbell monitoring recovered.");
      this.failures = 0;
      this.lastError = null;
      if (state.changed) {
        this.platform.log.info(`hikconnect.call-state camera=${this.config.name || this.config.did} state=${state.status}`);
        this.hooks.onCallState?.({ source: "hik-connect", status: state.status, call: state.call, callingId: state.callingId });
      }
      if (state.incomingCall) {
        this.hooks.onDoorbell?.({ source: "hik-connect", reason: "incoming-call", call: state.call, callingId: state.callingId });
      }
      await this.persistSession();
    } catch (error) {
      if (!this.running) return;
      const code = safeError(error);
      this.failures += 1;
      delayMs = Math.min(60000, this.intervalMs * 2 ** Math.min(this.failures, 6));
      if (isAuthenticationError(code)) {
        // Do not hammer credentials or rotate the Mac application's session.
        if (this.client) {
          this.client.session = null;
          this.client.refreshSession = null;
        }
        delayMs = Math.max(delayMs, 300000);
      }
      if (code !== this.lastError || this.failures === 1 || this.failures % 20 === 0) {
        this.platform.log.warn(`Hik-Connect doorbell monitoring: ${code}; retry in ${delayMs}ms.`);
      }
      this.lastError = code;
    } finally {
      this.schedule(delayMs);
    }
  }

  async answerCurrentCall(call = {}) {
    await this.loadClient();
    const callingId = call.callingId || call.call?.callingId || null;
    const answerKey = `${callingId || "latest"}:${Math.floor(Date.now() / 5000)}`;
    if (answerKey === this.lastAnswerKey) {
      return { ok: true, skipped: true, reason: "duplicate-answer-window" };
    }
    this.lastAnswerKey = answerKey;
    const result = await this.client.sendCallSignal("answer", { callingId });
    await this.persistSession();
    this.platform.log.info(`hikconnect.call-signal camera=${this.config.name || this.config.did} action=answer variant=${result.variant}`);
    return result;
  }
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function expandEnv(value) {
  return typeof value === "string" ? value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] || "") : "";
}

function safeFilePart(value) {
  return String(value || "doorbell").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "doorbell";
}

function safeError(error) {
  const message = String(error?.message || "");
  return /^(hikconnect|missing-hikconnect|invalid-hikconnect|set-explicit)-[a-z0-9-]+$/.test(message)
    ? message : "hikconnect-private-config-or-listener-error";
}

function isAuthenticationError(code) {
  return code.startsWith("hikconnect-login-")
    || code === "hikconnect-invalid-login-response"
    || /^hikconnect-http-(401|403)$/.test(code)
    || (/^hikconnect-call-status-\d+$/.test(code) && !/^hikconnect-call-status-(2003|2009)$/.test(code));
}

module.exports = { HikvisionHikConnectCallListener };
