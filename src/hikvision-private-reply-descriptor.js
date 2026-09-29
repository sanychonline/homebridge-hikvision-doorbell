"use strict";

function mapNativeGenericReplyDescriptor(input, options = {}) {
  const descriptor = toBuffer(input?.descriptor ?? input?.genericDescriptor ?? input, "generic reply descriptor");
  if (descriptor.length < 0x28) {
    throw new RangeError("generic reply descriptor must be at least 0x28 bytes");
  }
  const body = input?.body ?? options.body;
  if (body === undefined || body === null) {
    throw new TypeError("generic reply descriptor mapping requires a reply body Buffer");
  }

  const bodyBuffer = toBuffer(body, "reply body");
  const bodyLength = descriptor.readUInt32LE(0x24);
  return {
    command: descriptor.readUInt32LE(0x0c),
    checksum: descriptor.readUInt32LE(0x08),
    version: descriptor.readUInt32LE(0x10),
    protocolVersion: descriptor.readUInt32LE(0x10),
    bodyLength,
    body: bodyBuffer.subarray(0, Math.min(bodyLength, bodyBuffer.length)),
  };
}

function preparsePrivateLoginReply(reply) {
  const normalized = normalizeReply(reply);
  const highCommandByte = (normalized.command >>> 24) & 0xff;
  const hmac32Flag = (normalized.command >>> 25) & 0x01;
  const useHmac32 = highCommandByte === 0x63 ? false : Boolean(hmac32Flag);
  if ((highCommandByte & 0x01) === 0) {
    if (highCommandByte !== 0) {
      return {
        ok: false,
        reason: "unsupported-command-flag",
        highCommandByte,
        useHmac32,
        reply: normalized,
        bodyLength: normalized.bodyLength,
        challenge: null,
      };
    }
    return {
      ok: true,
      highCommandByte,
      useHmac32,
      reply: normalized,
      bodyLength: normalized.bodyLength,
      challenge: null,
    };
  }

  if (normalized.version <= 0x4f || normalized.bodyLength <= 0x3f || normalized.body.length < normalized.bodyLength) {
    return {
      ok: false,
      reason: "challenge-reply-too-short",
      highCommandByte,
      useHmac32,
      reply: normalized,
      bodyLength: normalized.bodyLength,
      challenge: null,
    };
  }

  const bodyLength = normalized.bodyLength - 0x40;
  const challengeStart = normalized.bodyLength - 0x40;
  return {
    ok: true,
    highCommandByte,
    useHmac32,
    reply: {
      ...normalized,
      command: normalized.command & 0x00ffffff,
      bodyLength,
      body: normalized.body.subarray(0, bodyLength),
    },
    bodyLength,
    challenge: Buffer.from(normalized.body.subarray(challengeStart, normalized.bodyLength)),
  };
}

function normalizeReply(reply) {
  if (reply?.genericDescriptor || reply?.descriptor) {
    return mapNativeGenericReplyDescriptor(reply);
  }
  const body = reply?.body === undefined || reply?.body === null ? Buffer.alloc(0) : toBuffer(reply.body, "reply body");
  return {
    command: normalizeU32(reply?.command ?? reply?.commandId),
    checksum: normalizeU32(reply?.checksum),
    version: normalizeU32(reply?.version ?? reply?.protocolVersion),
    protocolVersion: normalizeU32(reply?.version ?? reply?.protocolVersion),
    bodyLength: normalizeU32(reply?.bodyLength ?? body.length),
    body,
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
  throw new TypeError(`${name} must be Buffer-compatible`);
}

module.exports = {
  mapNativeGenericReplyDescriptor,
  preparsePrivateLoginReply,
};
