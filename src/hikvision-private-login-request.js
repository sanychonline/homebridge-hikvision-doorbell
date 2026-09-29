"use strict";

const {
  buildPrivateProtocolFrame,
  resolvePrivateProtocolLayout,
} = require("./hikvision-private-protocol-layout");
const { buildPrivateLoginCredentialProofs } = require("./hikvision-private-crypto");

const PRIVATE_LOGIN_PROTOCOL_LENGTH = 0x198;
const PRIVATE_LOGIN_DEFAULT_SELECTOR = 0x10000;
const PRIVATE_LOGIN_DEFAULT_VERSION = 0x020220ce;
const PRIVATE_LOGIN_MARKER = 0x05013d4b;
const PRIVATE_LOGIN_SESSION_INFO_LENGTH = 0x20;
const PRIVATE_LOGIN_IP_ADDR_INFO_LENGTH = 0x20;
const PRIVATE_LOGIN_DIGEST_LENGTH = 0x10;
const PRIVATE_LOGIN_DIGEST_BLOCK_LENGTH = 0x20;

function buildPrivateLoginCredentialProofBlock(options = {}) {
  const digests = buildPrivateLoginCredentialProofs(options);
  if (digests.digestLength !== PRIVATE_LOGIN_DIGEST_LENGTH) {
    throw new Error(`LevelThree login digest block requires 16-byte digests, got ${digests.digestLength}`);
  }

  const first = fixedBuffer(digests.first, PRIVATE_LOGIN_DIGEST_LENGTH, "first digest");
  const second = fixedBuffer(digests.second, PRIVATE_LOGIN_DIGEST_LENGTH, "second digest");
  const block = Buffer.alloc(PRIVATE_LOGIN_DIGEST_BLOCK_LENGTH, 0);
  first.copy(block, 0x00);
  second.copy(block, 0x10);

  return {
    block,
    length: block.length,
    digestLength: PRIVATE_LOGIN_DIGEST_LENGTH,
    secondInputLength: digests.secondInputLength,
    challengeApplied: digests.challengeApplied,
    oemMode: digests.oemMode,
    useHmac32: false,
  };
}

function buildPrivateLoginPayload(options = {}) {
  const mode = Number(options.mode ?? options.workMode ?? 3);
  if (mode !== 2 && mode !== 3) {
    throw new Error(`private login payload supports only confirmed LevelThree modes 2/3, got ${mode}`);
  }
  if (options.useHmac32 === true) {
    throw new Error("private login payload does not yet support the 32-byte 0xc54b8/HMAC-SHA256 branch");
  }

  const digestBlock = buildPrivateLoginCredentialProofBlock(options);
  return {
    payload: digestBlock.block,
    payloadLength: digestBlock.length,
    digestLength: digestBlock.digestLength,
    mode,
    challengeApplied: digestBlock.challengeApplied,
    oemMode: digestBlock.oemMode,
  };
}

function buildPrivateLoginProtocol(options = {}) {
  const payload = toBuffer(options.payload, "payload");
  const sessionInfo = options.sessionInfo === undefined
    ? buildPrivateLoginIpAddrInfo(options)
    : normalizePrivateLoginSessionInfo(options.sessionInfo);
  const protocol = Buffer.alloc(PRIVATE_LOGIN_PROTOCOL_LENGTH, 0);
  protocol.writeUInt32LE(uint32(options.protocolSelector ?? PRIVATE_LOGIN_DEFAULT_SELECTOR, "protocolSelector"), 0x000);
  protocol.writeUInt32LE(uint32(options.protocolVersion ?? PRIVATE_LOGIN_DEFAULT_VERSION, "protocolVersion"), 0x004);
  sessionInfo.copy(protocol, 0x114);
  protocol.writeUInt32LE(uint32(options.loginContextIdentifier ?? 0, "loginContextIdentifier"), 0x12c);
  if (options.localMacAddress !== undefined) {
    fixedBuffer(toBuffer(options.localMacAddress, "localMacAddress"), 6, "localMacAddress").copy(protocol, 0x124);
  }
  protocol.writeUInt32LE(uint32(options.payloadCapacity ?? payload.length, "payloadCapacity"), 0x140);
  protocol.writeUInt32LE(payload.length, 0x144);
  protocol.writeUInt32LE(uint32(options.marker ?? PRIVATE_LOGIN_MARKER, "marker"), 0x150);
  protocol[0x17e] = uint8(options.protocolFlag17e ?? 0, "protocolFlag17e");
  return protocol;
}

function normalizePrivateLoginSessionInfo(value) {
  return fixedBuffer(toBuffer(value, "sessionInfo"), PRIVATE_LOGIN_SESSION_INFO_LENGTH, "sessionInfo");
}

function buildPrivateLoginIpAddrInfo(options = {}) {
  const info = Buffer.alloc(PRIVATE_LOGIN_IP_ADDR_INFO_LENGTH, 0);
  const mac = normalizeMacAddress(options.mac ?? options.macAddress);
  mac.copy(info, 0x10);

  if (options.ipv6 || options.ipVersion === 6) {
    const ipv6 = fixedBuffer(toBuffer(options.ipv6, "ipv6"), 16, "ipv6");
    ipv6.copy(info, 0x00);
    info[0x1c] = 1;
    return info;
  }

  const ipv4 = normalizeIpv4Address(options.ipv4 ?? options.ip ?? options.host);
  ipv4.copy(info, 0x18);
  info[0x1c] = 0;
  return info;
}

function normalizeMacAddress(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || Array.isArray(value)) {
    return fixedBuffer(Buffer.from(value), 6, "mac");
  }
  const hex = String(value || "")
    .trim()
    .replace(/[^a-fA-F0-9]/g, "");
  if (hex.length !== 12) {
    throw new TypeError("mac must contain 6 bytes");
  }
  return Buffer.from(hex, "hex");
}

function normalizeIpv4Address(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || Array.isArray(value)) {
    return fixedBuffer(Buffer.from(value), 4, "ipv4");
  }
  const parts = String(value || "")
    .trim()
    .split(".")
    .map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new TypeError("ipv4 must be a dotted IPv4 address or 4-byte Buffer");
  }
  return Buffer.from(parts);
}

function buildPrivateLoginFrame(options = {}) {
  const loginPayload = buildPrivateLoginPayload(options);
  const protocol = buildPrivateLoginProtocol({
    ...options,
    payload: loginPayload.payload,
  });
  const layout = resolvePrivateProtocolLayout(protocol);
  return {
    ...loginPayload,
    protocol,
    layout,
    frame: buildPrivateProtocolFrame(protocol, loginPayload.payload, options),
  };
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
  if (!Buffer.isBuffer(value) || value.length !== length) {
    throw new TypeError(`${name} must be a ${length}-byte Buffer`);
  }
  return value;
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
  PRIVATE_LOGIN_PROTOCOL_LENGTH,
  PRIVATE_LOGIN_DEFAULT_SELECTOR,
  PRIVATE_LOGIN_DEFAULT_VERSION,
  PRIVATE_LOGIN_MARKER,
  PRIVATE_LOGIN_SESSION_INFO_LENGTH,
  PRIVATE_LOGIN_IP_ADDR_INFO_LENGTH,
  PRIVATE_LOGIN_DIGEST_LENGTH,
  PRIVATE_LOGIN_DIGEST_BLOCK_LENGTH,
  normalizePrivateLoginSessionInfo,
  buildPrivateLoginIpAddrInfo,
  buildPrivateLoginCredentialProofBlock,
  buildPrivateLoginPayload,
  buildPrivateLoginProtocol,
  buildPrivateLoginFrame,
};
