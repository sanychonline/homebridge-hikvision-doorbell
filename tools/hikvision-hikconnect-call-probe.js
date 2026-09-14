#!/usr/bin/env node
"use strict";

// API reference: https://github.com/tomasbedrich/hikconnect
// Read-only diagnostic. Does not answer, reject, unlock, or forward calls.
const fs = require("node:fs");
const crypto = require("node:crypto");
const { setTimeout: sleep } = require("node:timers/promises");

function apiOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port
      || !(url.hostname === "hik-connect.com" || url.hostname.endsWith(".hik-connect.com"))) {
    throw new Error("invalid-hikconnect-api-origin");
  }
  return url.origin;
}

class HikConnectCallProbe {
  constructor(config, fetchImpl = fetch) {
    if (!config.username || !config.password) {
      throw new Error("missing-hikconnect-account-credentials");
    }
    this.config = config;
    this.fetch = fetchImpl;
    this.origin = apiOrigin(config.baseUrl || "https://api.hik-connect.com");
    this.featureCode = crypto.randomBytes(16).toString("hex");
    this.session = null;
    this.refreshSession = null;
    this.expiresAt = 0;
    this.serial = config.indoorStationSerial || null;
    this.lastStatus = null;
  }

  async request(path, options = {}) {
    const headers = options.queryAuth ? {} : {
      clientType: "55", lang: "en-US", featureCode: this.featureCode,
      ...(this.session && !options.noSession ? { sessionId: this.session } : {}),
    };
    const url = new URL(path, this.origin);
    if (options.queryAuth) {
      url.search = new URLSearchParams({
        sessionId: this.session, clientType: "55", lang: "en-US", featureCode: this.featureCode,
      }).toString();
    }
    let response;
    try {
      response = await this.fetch(url, {
        method: options.method || "GET",
        headers: {
          ...headers,
          ...(options.json ? { "content-type": "application/json" } : {}),
        },
        redirect: "error",
        ...(options.form ? { body: new URLSearchParams(options.form) } : {}),
        ...(options.json ? { body: JSON.stringify(options.json) } : {}),
        signal: AbortSignal.timeout(5000),
      });
    } catch (_) {
      // Fetch errors can include a URL with sessionId; never propagate them.
      throw new Error("hikconnect-network-error");
    }
    if (!response.ok) throw new Error(`hikconnect-http-${response.status}`);
    try {
      return await response.json();
    } catch (_) {
      throw new Error("hikconnect-invalid-json");
    }
  }

  setSession(session, refreshSession) {
    if (typeof session !== "string" || !session || typeof refreshSession !== "string" || !refreshSession) {
      throw new Error("hikconnect-invalid-login-response");
    }
    this.session = session;
    this.refreshSession = refreshSession;
    this.expiresAt = Date.now() + 30 * 60 * 1000;
    try {
      const exp = JSON.parse(Buffer.from(session.split(".")[1], "base64url")).exp;
      if (Number.isFinite(exp)) this.expiresAt = exp * 1000;
    } catch (_) { /* Refresh conservatively if the token is opaque. */ }
  }

  async login() {
    for (let redirects = 0; redirects < 3; redirects += 1) {
      const result = await this.request("/v3/users/login/v2", {
        method: "POST", noSession: true,
        form: { account: this.config.username, password: crypto.createHash("md5").update(this.config.password).digest("hex") },
      });
      const code = result.meta?.code;
      if (code === 1100) {
        this.origin = apiOrigin(`https://${result.loginArea?.apiDomain}`);
        continue;
      }
      if (code !== 200) throw new Error(`hikconnect-login-${Number.isInteger(code) ? code : "failed"}`);
      this.setSession(result.loginSession?.sessionId, result.loginSession?.rfSessionId);
      return;
    }
    throw new Error("hikconnect-region-redirect-limit");
  }

  async ensureSession() {
    if (!this.session) return this.login();
    if (Date.now() < this.expiresAt - 60000) return;
    const result = await this.request("/v3/apigateway/login", {
      method: "PUT", noSession: true,
      form: { refreshSessionId: this.refreshSession, featureCode: this.featureCode },
    });
    this.setSession(result.sessionInfo?.sessionId, result.sessionInfo?.refreshSessionId);
  }

  async selectIndoorStation() {
    if (this.serial) return;
    const devices = [];
    for (let offset = 0; offset < 1000; offset += 50) {
      const result = await this.request(`/v3/userdevices/v1/devices/pagelist?groupId=-1&limit=50&offset=${offset}&filter=CONNECTION,STATUS,WIFI`);
      if (result.meta?.code !== 200 || !Array.isArray(result.deviceInfos)) {
        throw new Error("hikconnect-device-list-unavailable");
      }
      for (const device of result.deviceInfos) {
        devices.push({ ...device, localIp: result.connectionInfos?.[device.deviceSerial]?.localIp
          || result.wifiInfos?.[device.deviceSerial]?.address });
      }
      if (!result.page?.hasNext) break;
      if (offset === 950) throw new Error("hikconnect-device-list-too-large");
    }
    const atHost = this.config.indoorStationHost
      ? devices.filter(d => d.localIp === this.config.indoorStationHost) : [];
    const candidates = atHost.length ? atHost
      : devices.filter(d => d.deviceType === (this.config.indoorStationModel || "DS-KH6310-W"));
    if (candidates.length !== 1 || !candidates[0].deviceSerial) {
      throw new Error("set-explicit-indoorStationSerial-in-private-config");
    }
    this.serial = candidates[0].deviceSerial;
  }

  async poll() {
    await this.ensureSession();
    await this.selectIndoorStation();
    const result = await this.request(`/v3/devconfig/v1/call/${encodeURIComponent(this.serial)}/status`, { queryAuth: true });
    if (result.meta?.code !== 200) {
      throw new Error(`hikconnect-call-status-${Number.isInteger(result.meta?.code) ? result.meta.code : "unavailable"}`);
    }
    let data;
    try { data = typeof result.data === "string" ? JSON.parse(result.data) : result.data; }
    catch (_) { throw new Error("hikconnect-invalid-call-status"); }
    const status = { 1: "idle", 2: "ringing", 3: "call-in-progress" }[data?.callStatus];
    if (!status) throw new Error("hikconnect-unknown-call-status");
    const previousStatus = this.lastStatus;
    this.lastStatus = status;
    const call = extractCallDetails(data);
    return {
      status, previousStatus, changed: status !== previousStatus,
      call,
      callingId: call.callingId || null,
      // The first result is a baseline, never a synthetic button press.
      incomingCall: previousStatus === "idle" && status === "ringing",
    };
  }

  async sendCallSignal(action = "answer", call = {}) {
    await this.ensureSession();
    await this.selectIndoorStation();
    const targetSerial = this.config.callSignalSerial
      || this.config.outdoorStationSerial
      || this.config.doorbellSerial
      || this.serial;
    if (!targetSerial) throw new Error("hikconnect-missing-call-signal-serial");
    const cmdType = callSignalCommand(action);
    const callSignal = {
      cmdType,
      ...(call.callingId ? { CallingId: String(call.callingId) } : {}),
    };
    const attempts = [
      { method: "PUT", json: { value: { CallSignal: callSignal } }, variant: "put-value-call-signal" },
      { method: "PUT", json: { CallSignal: callSignal }, variant: "put-call-signal" },
      { method: "POST", json: { value: callSignal }, variant: "value" },
      { method: "PUT", json: { value: callSignal }, variant: "put-value" },
      { method: "PUT", json: callSignal, variant: "put-flat" },
    ];
    let lastCode = "unavailable";
    for (const attempt of attempts) {
      try {
        const result = await this.request(`/v3/iot-feature/action/${encodeURIComponent(targetSerial)}/global/0/CallSignalMgr/CallSignal`, {
          method: attempt.method,
          json: attempt.json,
        });
        const code = result.meta?.code;
        if (code === 200) {
          return {
            ok: true,
            action,
            cmdType,
            targetSerial,
            variant: attempt.variant,
            metaCode: code,
          };
        }
        lastCode = Number.isInteger(code) ? String(code) : "unavailable";
      } catch (error) {
        lastCode = String(error?.message || "request-failed").replace(/^hikconnect-/, "");
      }
    }
    throw new Error(`hikconnect-call-signal-${lastCode}`);
  }
}

function callSignalCommand(action) {
  const commands = {
    cancel: 0,
    answer: 1,
    reject: 2,
    called: 3,
    "ring-timeout": 4,
    "end-call": 5,
    hangup: 5,
    "device-calling": 6,
    "client-calling": 7,
    "indoor-offline": 8,
  };
  if (Number.isInteger(action)) return action;
  return commands[String(action || "answer")] ?? 1;
}

function extractCallDetails(data) {
  const callingId = findFirstString(data, ["callingId", "CallingId", "callingID", "szCallingId", "callId", "callID"]);
  return {
    callingId: callingId || null,
    callStatus: Number.isFinite(Number(data?.callStatus)) ? Number(data.callStatus) : null,
  };
}

function findFirstString(value, names) {
  if (!value || typeof value !== "object") return null;
  const wanted = new Set(names.map(name => name.toLowerCase()));
  const seen = new Set();
  const queue = [value];
  while (queue.length) {
    const item = queue.shift();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    for (const [key, nested] of Object.entries(item)) {
      if (wanted.has(key.toLowerCase()) && typeof nested === "string" && nested) return nested;
      if (nested && typeof nested === "object") queue.push(nested);
    }
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf("--config");
  if (index < 0 || !args[index + 1]) throw new Error("usage: --config /private/path/hikconnect.json [--once]");
  const config = JSON.parse(fs.readFileSync(args[index + 1], "utf8"));
  const probe = new HikConnectCallProbe(config);
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  const emit = fields => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...fields }) + "\n");
  while (!stopping) {
    // Stop on errors. This diagnostic must not hammer login or replay calls.
    const state = await probe.poll();
    if (state.changed) emit({ event: "call-status", ...state });
    if (args.includes("--once")) break;
    await sleep(3000);
  }
}

module.exports = { HikConnectCallProbe, apiOrigin };
if (require.main === module) {
  main().catch(error => {
    const message = String(error.message);
    const safe = /^(hikconnect-|missing-hikconnect-|invalid-hikconnect-|set-explicit-|usage:)/.test(message)
      ? message : "unable-to-read-private-hikconnect-config";
    process.stderr.write(JSON.stringify({ event: "fatal", error: safe }) + "\n");
    process.exitCode = 1;
  });
}
