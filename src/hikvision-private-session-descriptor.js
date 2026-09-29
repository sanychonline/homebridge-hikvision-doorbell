"use strict";

function extractPrivateSessionDescriptor(reply, options = {}) {
  const body = toBuffer(reply?.body ?? reply, "reply body");
  const bodyLength = Math.min(body.length, 0xfc);
  const scratch = Buffer.alloc(0xfc, 0);
  body.copy(scratch, 0, 0, bodyLength);

  const protocolVersion = normalizeU32(reply?.version ?? reply?.protocolVersion ?? options.protocolVersion);
  const descriptor = {
    protocolVersion,
    bodyLength,
    raw: Buffer.from(scratch),
    deviceUserId: scratch.readUInt32LE(0),
    deviceMetadata: Buffer.from(scratch.subarray(4, 0x34)),
    unresolvedKeyMaterial: Buffer.from(scratch.subarray(0x5c, 0x7c)),
    legacyMode: bodyLength <= 0x3a,
    commandHeader: null,
  };

  const commandFields = commandHeaderFieldsFromOptions(descriptor, options);
  if (commandFields) {
    descriptor.commandHeader = commandFields;
  }

  scratch.fill(0);
  return descriptor;
}

function commandHeaderFieldsFromOptions(descriptor, options) {
  if (!options || typeof options !== "object" || !options.commandHeaderFields) {
    return null;
  }
  const fields = options.commandHeaderFields;
  if (!fields.localMacAddress || !fields.commandContextBytes || !fields.sessionEncryptionKey) {
    return null;
  }
  return {
    protocolVersion: descriptor.protocolVersion,
    protocolHeaderVariant: normalizeU32(fields.protocolHeaderVariant),
    commandContextBytes: fixedBuffer(fields.commandContextBytes, 4, "commandContextBytes"),
    deviceUserId: normalizeU32(fields.deviceUserId),
    randomSeed: normalizeU32(fields.randomSeed),
    currentDeviceTime: normalizeU32(fields.currentDeviceTime),
    localMacAddress: fixedBuffer(fields.localMacAddress, 6, "localMacAddress"),
    sessionEncryptionKey: fixedBuffer(fields.sessionEncryptionKey, 16, "sessionEncryptionKey"),
  };
}

function fixedBuffer(value, length, name) {
  const buffer = toBuffer(value, name);
  if (buffer.length !== length) {
    throw new TypeError(`${name} must be ${length} bytes`);
  }
  return buffer;
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
  throw new TypeError(`${name} must be Buffer-compatible`);
}

module.exports = {
  extractPrivateSessionDescriptor,
};
