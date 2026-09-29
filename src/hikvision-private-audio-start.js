"use strict";

const {
  buildCompactPrivateProtocolFrame,
  buildPrivateProtocolFrame,
  resolvePrivateProtocolLayout,
} = require("./hikvision-private-protocol-layout");

const HIK_AUDIO_START_MARKER = 0x05013d4b;
const AUDIO_START_PROTOCOL_LENGTH = 0x198;
const AUDIO_START_PROTOCOL_INFO_LENGTH = 0x110;
const AUDIO_START_SESSION_INFO_LENGTH = 0x20;
const AUDIO_START_EXTRA_CAPACITY = 0x40;

function buildHikAudioStartRequest(fields = {}) {
  const protocolSelector = uint32(fields.protocolSelector, "protocolSelector");
  const packedSelector = uint32(fields.packedSelector, "packedSelector");
  const protocolInfo = fixedBuffer(fields.protocolInfo, AUDIO_START_PROTOCOL_INFO_LENGTH, "protocolInfo");
  const sessionInfo = fixedBuffer(fields.sessionInfo, AUDIO_START_SESSION_INFO_LENGTH, "sessionInfo");
  const supportExtendedAudioStart = Boolean(fields.supportExtendedAudioStart);
  const extendedAudioStartByte = uint8(fields.extendedAudioStartByte ?? 0, "extendedAudioStartByte");

  const protocol = Buffer.alloc(AUDIO_START_PROTOCOL_LENGTH, 0);
  protocol.writeUInt32LE(protocolSelector, 0x000);
  protocolInfo.copy(protocol, 0x004);
  sessionInfo.copy(protocol, 0x114);
  protocol.writeUInt32LE(HIK_AUDIO_START_MARKER, 0x150);

  const extraData = packHikAudioStartExtraData({
    packedSelector,
    supportExtendedAudioStart,
    extendedAudioStartByte,
  });
  protocol.writeUInt32LE(AUDIO_START_EXTRA_CAPACITY, 0x140);
  protocol.writeUInt32LE(extraData.length, 0x144);

  return {
    protocol,
    extraData,
    extraCapacity: AUDIO_START_EXTRA_CAPACITY,
    extraLength: extraData.length,
    marker: HIK_AUDIO_START_MARKER,
  };
}

function buildCompactHikAudioStartFrame(fields = {}) {
  const request = buildHikAudioStartRequest(fields);
  const layout = resolvePrivateProtocolLayout(request.protocol);
  if (layout.builder !== "compact") {
    throw new Error(`HikAudioStart compact frame requires compact protocol layout, got ${layout.builder}`);
  }

  return {
    ...request,
    layout,
    frame: buildCompactPrivateProtocolFrame(request.protocol, request.extraData, fields),
  };
}

function buildHikAudioStartFrame(fields = {}) {
  const request = buildHikAudioStartRequest(fields);
  const layout = resolvePrivateProtocolLayout(request.protocol);

  return {
    ...request,
    layout,
    frame: buildPrivateProtocolFrame(request.protocol, request.extraData, fields),
  };
}

function packHikAudioStartExtraData(fields = {}) {
  const packedSelector = uint32(fields.packedSelector, "packedSelector");
  if (fields.supportExtendedAudioStart === true) {
    const extra = Buffer.alloc(AUDIO_START_EXTRA_CAPACITY, 0);
    extra.writeUInt32LE(packedSelector, 0);
    extra[4] = uint8(fields.extendedAudioStartByte ?? 0, "extendedAudioStartByte");
    return extra;
  }

  const extra = Buffer.alloc(4);
  extra.writeUInt32LE(packedSelector, 0);
  return extra;
}

function uint8(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xff) {
    throw new RangeError(`${name} must be an unsigned 8-bit integer`);
  }
  return parsed;
}

function uint32(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer`);
  }
  return parsed >>> 0;
}

function fixedBuffer(value, length, name) {
  const buffer = toBuffer(value, name);
  if (buffer.length !== length) {
    throw new TypeError(`${name} must be a ${length}-byte Buffer`);
  }
  return buffer;
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
  HIK_AUDIO_START_MARKER,
  AUDIO_START_PROTOCOL_LENGTH,
  AUDIO_START_PROTOCOL_INFO_LENGTH,
  AUDIO_START_SESSION_INFO_LENGTH,
  AUDIO_START_EXTRA_CAPACITY,
  buildHikAudioStartRequest,
  buildHikAudioStartFrame,
  buildCompactHikAudioStartFrame,
  packHikAudioStartExtraData,
};
