"use strict";

const LOGIN_PARSE = {
  NONE: 0,
  PASSWORD_OR_USER_ERROR: 1,
  CHECKSUM_FAILURE_RESULT: 2,
  LOCKED_OR_RETRY_LIMIT: 3,
  UNSUPPORTED: 4,
  CHECKSUM_MISMATCH: 5,
  BAD_LENGTH: 6,
  BAD_STATUS: 7,
  SUCCESS: 8,
  NEEDS_SECOND_STEP: 9,
};

function parseFirstLoginSuccess(reply) {
  const descriptor = normalizeReplyDescriptor(reply);
  if (!descriptor.body) {
    return LOGIN_PARSE.NONE;
  }
  if (descriptor.body.length !== 0x3c) {
    return LOGIN_PARSE.BAD_LENGTH;
  }

  const status = descriptor.body.readUInt32BE(0);
  if (isBadLoginStatus(status, descriptor.version)) {
    return LOGIN_PARSE.BAD_STATUS;
  }
  if (descriptor.body[0x34] === 0x14 && descriptor.version === 0x02011a0e) {
    return LOGIN_PARSE.SUCCESS;
  }
  if (descriptor.version > 0x02011a0d) {
    return LOGIN_PARSE.UNSUPPORTED;
  }
  return checksumMatches(descriptor, 0x44)
    ? LOGIN_PARSE.SUCCESS
    : LOGIN_PARSE.CHECKSUM_MISMATCH;
}

function parseSecondLoginSuccess(reply, mode = 0) {
  const descriptor = normalizeReplyDescriptor(reply);
  if (!descriptor.body) {
    return LOGIN_PARSE.NONE;
  }

  const status = descriptor.body.length >= 4 ? descriptor.body.readUInt32BE(0) : 0;
  if (isBadLoginStatus(status, descriptor.version)) {
    return LOGIN_PARSE.BAD_STATUS;
  }

  if ((mode === 1 || mode === 9)) {
    return descriptor.version > 0x0300209b
      ? LOGIN_PARSE.SUCCESS
      : LOGIN_PARSE.UNSUPPORTED;
  }

  if (mode !== 2) {
    return LOGIN_PARSE.NONE;
  }

  if (isSecondLoginSuccessBody(descriptor)) {
    return checksumMatches(descriptor, 0x80)
      ? LOGIN_PARSE.SUCCESS
      : LOGIN_PARSE.CHECKSUM_MISMATCH;
  }

  return LOGIN_PARSE.UNSUPPORTED;
}

function parseFirstLoginFailed(reply) {
  const descriptor = normalizeReplyDescriptor(reply);
  switch (descriptor.command) {
    case 0x64:
      return descriptor.version > 0x0300209b
        ? LOGIN_PARSE.PASSWORD_OR_USER_ERROR
        : LOGIN_PARSE.UNSUPPORTED;
    case 0x63:
      return LOGIN_PARSE.NEEDS_SECOND_STEP;
    case 0x27:
      return checksumMatches(descriptor, 0x80)
        ? LOGIN_PARSE.CHECKSUM_FAILURE_RESULT
        : LOGIN_PARSE.CHECKSUM_MISMATCH;
    case 0x03:
    case 0x06:
      return LOGIN_PARSE.LOCKED_OR_RETRY_LIMIT;
    default:
      return LOGIN_PARSE.NONE;
  }
}

function normalizeReplyDescriptor(reply) {
  if (!reply || typeof reply !== "object") {
    return {
      command: 0,
      checksum: 0,
      version: 0,
      bodyLength: 0,
      body: null,
    };
  }
  const body = reply.body === undefined || reply.body === null ? null : toBuffer(reply.body);
  return {
    command: normalizeU32(reply.command ?? reply.commandId),
    checksum: normalizeU32(reply.checksum),
    version: normalizeU32(reply.version ?? reply.protocolVersion),
    bodyLength: normalizeU32(reply.bodyLength ?? body?.length ?? 0),
    body,
  };
}

function checksumMatches(descriptor, scratchSize) {
  if (!descriptor.body) {
    return false;
  }
  const length = Math.min(Number(descriptor.bodyLength || descriptor.body.length), descriptor.body.length);
  const scratch = Buffer.alloc(Math.max(scratchSize, length + 8), 0);
  scratch.writeUInt32LE(descriptor.command >>> 0, 0);
  scratch.writeUInt32LE(descriptor.version >>> 0, 4);
  descriptor.body.copy(scratch, 8, 0, length);
  const calculated = checkByteSum(scratch.subarray(0, length + 8));
  return calculated === descriptor.checksum || calculated === swap32(descriptor.checksum);
}

function checkByteSum(buffer) {
  let sum = 0;
  for (const byte of toBuffer(buffer)) {
    sum = (sum + byte) >>> 0;
  }
  return sum >>> 0;
}

function isBadLoginStatus(status, version) {
  if (version > 0x0300209b) {
    return false;
  }
  return status <= 0xffff || status > 0x1007f;
}

function isSecondLoginSuccessBody(descriptor) {
  if (descriptor.version > 0x02011a0d && descriptor.version <= 0x0300209b) {
    return true;
  }
  if (descriptor.version === 0x01061a0e) {
    return true;
  }
  const marker = descriptor.body?.[0x34];
  return marker === 0xac
    || marker === 0xaf
    || marker === 0xb0
    || marker === 0x42
    || marker === 0x43
    || marker === 0xab;
}

function swap32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer.readUInt32BE(0);
}

function normalizeU32(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) {
    return 0;
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
  LOGIN_PARSE,
  parseFirstLoginSuccess,
  parseSecondLoginSuccess,
  parseFirstLoginFailed,
  checkByteSum,
};
