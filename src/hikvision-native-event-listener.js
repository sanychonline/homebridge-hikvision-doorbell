"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const BUTTON_DOWN_COMMAND = 0x1152;
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];

class HikvisionNativeEventListener {
  constructor(platform, config, handlers = {}) {
    this.platform = platform;
    this.config = config;
    this.handlers = handlers;
    this.process = null;
    this.restartTimer = null;
    this.stopping = false;
    this.reconnectAttempt = 0;
    this.lastDoorbellAt = 0;
    this.state = "disabled";
    this.lastError = null;
  }

  start() {
    if (this.config.nativeEvents !== true) {
      return;
    }

    this.stopping = false;
    this.spawnBridge();
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
    this.state = "stopped";
  }

  status() {
    return {
      enabled: this.config.nativeEvents === true,
      state: this.state,
      lastError: this.lastError,
      reconnectAttempt: this.reconnectAttempt,
      lastDoorbellAt: this.lastDoorbellAt || null,
    };
  }

  spawnBridge() {
    const sdkLibrary = this.config.hcnetSdkLibrary || "/homebridge/hikvision-hcnet-sdk/lib/libhcnetsdk.so";
    if (!fs.existsSync(sdkLibrary)) {
      this.state = "sdk-missing";
      this.lastError = `HCNetSDK library not found at ${sdkLibrary}`;
      this.platform.log.warn(`native.events.unavailable camera=${this.cameraName()} reason=sdk-missing path=${sdkLibrary}`);
      return;
    }

    const bridgePath = path.resolve(__dirname, "../tools/hikvision-hcnet-alarm.py");
    const python = this.config.hcnetPython || "python3";
    const args = [bridgePath, "--sdk-library", sdkLibrary];
    if (this.config.dumpNativeEvents === true) {
      args.push("--dump-events");
    }

    const libraryDir = path.dirname(sdkLibrary);
    const componentDir = this.config.hcnetSdkComponentPath || path.join(libraryDir, "HCNetSDKCom");
    const env = {
      ...process.env,
      HIKVISION_HOST: String(this.config.ip || ""),
      HIKVISION_PORT: String(this.config.hcnetPort || 8000),
      HIKVISION_USERNAME: String(this.config.username || ""),
      HIKVISION_PASSWORD: String(this.config.password || ""),
      HIKVISION_DOORBELL_DEBOUNCE_MS: String(this.config.doorbellDebounceMs ?? 2000),
      HIKVISION_MOTION_HOLD_MS: String(this.config.motionHoldMs || this.config.hsvMotionDurationMs || 15000),
      HIKVISION_MOTION_DEBOUNCE_MS: String(this.config.motionDebounceMs || 1000),
      HIKVISION_EVENT_HOST: String(this.config.ip || ""),
      HIKVISION_EVENT_PORT: String(this.config.hcnetPort || 8000),
      HIKVISION_EVENT_USERNAME: String(this.config.username || ""),
      HIKVISION_EVENT_PASSWORD: String(this.config.password || ""),
      LD_LIBRARY_PATH: [libraryDir, componentDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
    };

    this.state = this.reconnectAttempt ? "reconnecting" : "connecting";
    this.lastError = null;
    const child = spawn(python, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    this.process = child;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let bridgeError = "";

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        const error = this.handleBridgeLine(line);
        if (error) {
          bridgeError = error;
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBuffer = (stderrBuffer + chunk.toString("utf8")).slice(-4096);
    });

    child.on("error", (error) => {
      this.lastError = error.message;
      this.platform.log.warn(`native.events.error camera=${this.cameraName()} error=${safeLog(error.message)}`);
    });

    child.on("exit", (code, signal) => {
      if (this.process === child) {
        this.process = null;
      }
      if (this.stopping) {
        return;
      }
      this.lastError = bridgeError || stderrBuffer.trim() || `bridge exited code=${code} signal=${signal || "none"}`;
      this.scheduleReconnect();
    });
  }

  handleBridgeLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.platform.log.warn(`native.events.invalid-json camera=${this.cameraName()} error=${safeLog(error.message)}`);
      return;
    }

    if (message.type === "status" || message.type === "state") {
      this.state = message.state || this.state;
      if (message.state === "armed" || message.state === "CONNECTED") {
        this.state = "armed";
        this.reconnectAttempt = 0;
        this.lastError = null;
        this.platform.log.info(`native.events.armed camera=${this.cameraName()} transport=hcnet-sdk alarmApi=${message.alarmApi || "unknown"}`);
      } else if (message.state === "error") {
        this.lastError = `${message.error || "unknown"}${message.sdkError === undefined ? "" : ` sdkError=${message.sdkError}`}`;
        this.platform.log.warn(`native.events.bridge-error camera=${this.cameraName()} error=${safeLog(this.lastError)}`);
      }
      return;
    }

    if (message.type === "fatal") {
      const error = [message.error, message.detail].filter(Boolean).join(": ") || "unknown bridge failure";
      this.lastError = error;
      this.platform.log.warn(`native.events.bridge-error camera=${this.cameraName()} error=${safeLog(error)}`);
      return error;
    }

    if (message.type === "motion-forward" && message.ok === false) {
      this.platform.log.warn(`native.events.motion-forward-failed camera=${this.cameraName()} error=${safeLog(message.error || message.status)}`);
      return;
    }

    if (message.type === "native-motion" || message.type === "motion-forward") {
      this.platform.log.debug(`native.events.motion camera=${this.cameraName()} event=${message.type} command=${message.command || "unknown"} ok=${message.ok ?? "n/a"}`);
      return;
    }

    if (message.type === "raw-event") {
      if (this.config.dumpNativeEvents === true) {
        this.platform.log.info(`native.events.raw camera=${this.cameraName()} event=${safeLog(JSON.stringify(message))}`);
      }
      return;
    }

    if (message.type !== "alarm" && message.type !== "doorbell") {
      return;
    }

    this.platform.log.debug(`native.events.alarm camera=${this.cameraName()} command=${message.commandHex || message.command} event=${message.event || "unknown"} bytes=${message.bytes || 0}`);
    if (this.config.dumpNativeEvents === true) {
      this.platform.log.info(`native.events.raw camera=${this.cameraName()} event=${safeLog(JSON.stringify(message))}`);
    }

    if (message.type !== "doorbell" && Number(message.command) !== BUTTON_DOWN_COMMAND) {
      return;
    }

    const now = Date.now();
    const debounceMs = Math.max(Number(this.config.doorbellDebounceMs ?? 2000), 0);
    if (now - this.lastDoorbellAt < debounceMs) {
      this.platform.log.debug(`native.events.debounced camera=${this.cameraName()} command=0x1152 debounceMs=${debounceMs}`);
      return;
    }

    this.lastDoorbellAt = now;
    this.handlers.onDoorbell?.({
      source: "hcnet-sdk",
      reason: "button-down",
      command: BUTTON_DOWN_COMMAND,
      receivedAt: message.receivedAt || message.timestamp || now,
    });
  }

  scheduleReconnect() {
    const index = Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1);
    const delayMs = RECONNECT_DELAYS_MS[index];
    this.reconnectAttempt += 1;
    this.state = "reconnecting";
    this.platform.log.warn(`native.events.reconnect camera=${this.cameraName()} delayMs=${delayMs} error=${safeLog(this.lastError || "bridge-exited")}`);
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.spawnBridge(), delayMs);
    this.restartTimer.unref?.();
  }

  cameraName() {
    return this.config.name || this.config.did || "unknown";
  }
}

function safeLog(value) {
  return String(value || "unknown")
    .replace(/rtsp:\/\/[^@\s]+@/gi, "rtsp://***@")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 1024);
}

module.exports = {
  HikvisionNativeEventListener,
  BUTTON_DOWN_COMMAND,
};
