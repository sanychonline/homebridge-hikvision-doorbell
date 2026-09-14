"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_LOG_FILE = "/homebridge/hikvision-camera-debug.log";

function diagnosticLog(config, message) {
  const enabled = config?.diagnosticLog !== false;
  if (!enabled) {
    return;
  }
  const file = config?.diagnosticLogFile || process.env.HIKVISION_CAMERA_DIAGNOSTIC_LOG || DEFAULT_LOG_FILE;
  const clean = redact(String(message || ""));
  const line = `${new Date().toISOString()} ${clean}\n`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line, { mode: 0o600 });
  } catch (_) {
    // Diagnostics must never affect Homebridge runtime.
  }
}

function redact(value) {
  return value
    .replace(/[a-f0-9]{64,}/gi, "***")
    .replace(/(serviceToken|ssecurity|deviceKey|token|sign|uid)[:=][^,\s}]+/gi, "$1=***");
}

module.exports = { diagnosticLog };
