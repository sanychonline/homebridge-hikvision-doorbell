"use strict";

function buildSdkAudioFrame(payload, options = {}) {
  const audio = toBuffer(payload);
  const headerValue = options.lengthPrefixed === true ? audio.length : normalizeUint32(options.marker, 1);
  const frame = Buffer.alloc(4 + audio.length);
  frame.writeUInt32BE(headerValue, 0);
  audio.copy(frame, 4);
  return frame;
}

function buildG711UlawFrame(payload) {
  return buildSdkAudioFrame(payload, { marker: 1 });
}

function normalizeUint32(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
    return fallback;
  }
  return parsed >>> 0;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (Array.isArray(value)) {
    return Buffer.from(value);
  }
  return Buffer.from(String(value || ""), "binary");
}

module.exports = {
  buildSdkAudioFrame,
  buildG711UlawFrame,
};
