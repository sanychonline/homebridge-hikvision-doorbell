"use strict";

const { computePrivateCommandChecksum } = require("./hikvision-private-command-checksum");

function buildPrivateCommandPacket(fields) {
  const header = buildPrivateCommandHeader({
    ...fields,
    checksum: fields.checksum ?? computePrivateCommandChecksum(fields),
  });
  const body = toBuffer(fields.body || Buffer.alloc(0), "body");
  return Buffer.concat([header, body]);
}

function buildPrivateCommandHeader(fields) {
  if (!fields || typeof fields !== "object") {
    throw new TypeError("Private command fields are required");
  }

  const body = toBuffer(fields.body || Buffer.alloc(0), "body");
  const bodyLength = uint32(fields.bodyLength ?? body.length, "bodyLength");
  if (bodyLength > 0xffffffff - 32) {
    throw new RangeError("Private command body is too large");
  }

  const protocolVersion = uint32(fields.protocolVersion, "protocolVersion");
  const header = Buffer.alloc(32);
  header.writeUInt32BE(bodyLength + 32, 0);
  header[4] = protocolVersion > 0x0300209b ? 0x63 : 0x5a;
  header[5] = 0;
  header[6] = uint8(fields.protocolHeaderVariant ?? 0, "protocolHeaderVariant");
  header[7] = (fields.primaryCommandFlag === true ? 1 : 0) | (fields.parameterizedCommandFlag === true ? 2 : 0);
  header.writeUInt32BE(uint32(fields.checksum, "checksum"), 8);
  header.writeUInt32BE(uint32(fields.commandId, "commandId"), 12);
  fixedBuffer(fields.commandContextBytes, 4, "commandContextBytes").copy(header, 16);
  header.writeUInt32BE(uint32(fields.deviceUserId, "deviceUserId"), 20);
  fixedBuffer(fields.localMacAddress, 6, "localMacAddress").copy(header, 24);
  if (fields.parameterizedCommandFlag === true) {
    header.writeUInt16BE(uint16(fields.flagParameter, "flagParameter"), 30);
  }
  return header;
}

function uint8(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xff) {
    throw new RangeError(`${name} must be an unsigned 8-bit integer`);
  }
  return parsed;
}

function uint16(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff) {
    throw new RangeError(`${name} must be an unsigned 16-bit integer`);
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
  buildPrivateCommandPacket,
  buildPrivateCommandHeader,
};
