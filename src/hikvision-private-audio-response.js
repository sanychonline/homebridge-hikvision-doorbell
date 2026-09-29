"use strict";

const HIK_AUDIO_REDIRECT_STATUS = 0x3bb;

function parseHikAudioStartResponse(response = {}) {
  const status = normalizeU32(response.status ?? response.commandStatus ?? response.statusCode);
  const body = response.body === undefined || response.body === null ? Buffer.alloc(0) : toBuffer(response.body, "response body");
  if (status !== HIK_AUDIO_REDIRECT_STATUS) {
    return {
      status,
      redirect: false,
      ok: status === 0,
    };
  }

  if (body.length < 0x20) {
    throw new RangeError("HikAudioStart redirect response body must be at least 32 bytes");
  }

  return {
    status,
    redirect: true,
    ok: false,
    host: `${body[0]}.${body[1]}.${body[2]}.${body[3]}`,
    port: body.readUInt16BE(0x18),
    linkId: body.readUInt32BE(0x1c),
    variants: {
      portBE: body.readUInt16BE(0x18),
      portLE: body.readUInt16LE(0x18),
      linkIdBE: body.readUInt32BE(0x1c),
      linkIdLE: body.readUInt32LE(0x1c),
      raw0x18: body.subarray(0x18, 0x20).toString("hex"),
    },
  };
}

function normalizeU32(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return parsed >>> 0;
}

function toBuffer(value, name) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (Array.isArray(value)) {
    return Buffer.from(value);
  }
  if (typeof value === "string") {
    return Buffer.from(value, "hex");
  }
  throw new TypeError(`${name} must be a Buffer-compatible value`);
}

module.exports = {
  HIK_AUDIO_REDIRECT_STATUS,
  parseHikAudioStartResponse,
};
