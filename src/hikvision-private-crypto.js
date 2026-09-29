"use strict";

const crypto = require("crypto");

const MD5_BLOCK_SIZE = 64;
const SHA256_BLOCK_SIZE = 64;
const DEFAULT_LEVEL_THREE_INNER_PAD = 0x36;
const DEFAULT_LEVEL_THREE_OUTER_PAD = 0x5c;

function encryptPrivateLoginProof(input, key, options = {}) {
  const innerPad = normalizeByte(options.innerPad, DEFAULT_LEVEL_THREE_INNER_PAD);
  const outerPad = normalizeByte(options.outerPad, DEFAULT_LEVEL_THREE_OUTER_PAD);
  return computeMd5ChallengeResponse(input, key, innerPad, outerPad);
}

function encryptOemPrivateLoginProof(input, key, selector, salt) {
  return computeMd5ChallengeResponse(input, key, normalizeByte(selector, DEFAULT_LEVEL_THREE_INNER_PAD), normalizeByte(salt, DEFAULT_LEVEL_THREE_OUTER_PAD));
}

function computeMd5ChallengeResponse(input, key, innerPadByte, outerPadByte) {
  const normalizedKey = normalizeHmacKey(key);
  const innerPad = Buffer.alloc(MD5_BLOCK_SIZE, innerPadByte);
  const outerPad = Buffer.alloc(MD5_BLOCK_SIZE, outerPadByte);

  for (let index = 0; index < normalizedKey.length; index += 1) {
    innerPad[index] ^= normalizedKey[index];
    outerPad[index] ^= normalizedKey[index];
  }

  const inner = md5(Buffer.concat([innerPad, toBuffer(input)]));
  return md5(Buffer.concat([outerPad, inner]));
}

function computeSha256ChallengeResponse(input, key, keyLength = null) {
  const keyBuffer = toBuffer(key);
  const copiedLength = normalizeKeyLength(keyLength, keyBuffer.length, SHA256_BLOCK_SIZE);
  const innerPad = Buffer.alloc(SHA256_BLOCK_SIZE, DEFAULT_LEVEL_THREE_INNER_PAD);
  const outerPad = Buffer.alloc(SHA256_BLOCK_SIZE, DEFAULT_LEVEL_THREE_OUTER_PAD);

  for (let index = 0; index < copiedLength; index += 1) {
    innerPad[index] ^= keyBuffer[index];
    outerPad[index] ^= keyBuffer[index];
  }

  const inner = sha256(Buffer.concat([innerPad, toBuffer(input)]));
  return sha256(Buffer.concat([outerPad, inner]));
}

function normalizeHmacKey(key) {
  const buffer = toBuffer(key);
  if (buffer.length > MD5_BLOCK_SIZE) {
    return md5(buffer);
  }
  return buffer;
}

function md5(value) {
  return crypto.createHash("md5").update(value).digest();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest();
}

function md5Hex(value) {
  return crypto.createHash("md5").update(value).digest("hex");
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function loginChallengeDigest(primary, secondary, challenge) {
  const challengeBuffer = toBuffer(challenge);
  if (challengeBuffer.length !== 64) {
    throw new TypeError("login challenge must be exactly 64 bytes");
  }
  const primaryBuffer = toBuffer(primary);
  const secondaryBuffer = toBuffer(secondary);
  if (primaryBuffer.length > 32) {
    throw new TypeError("primary login value must be at most 32 bytes");
  }
  if (secondaryBuffer.length > 65) {
    throw new TypeError("secondary login value must be at most 65 bytes");
  }
  return sha256Hex(Buffer.concat([primaryBuffer, challengeBuffer, secondaryBuffer]));
}

function buildPrivateLoginCredentialProofs(options = {}) {
  const primary = toBuffer(options.primary);
  const secondary = toBuffer(options.secondary);
  const key = toBuffer(options.key);
  const challenge = options.challenge === undefined ? null : toBuffer(options.challenge);
  const oemMode = normalizeOemMode(options.oemMode);
  const customOem = options.customOem || null;
  const useHmac32 = Boolean(options.useHmac32);

  if (!key.length) {
    throw new TypeError("LevelThree login key is required");
  }

  let secondInput = secondary;
  let secondInputLength = Math.min(secondInput.length, 32);
  if (challenge) {
    secondInput = Buffer.from(loginChallengeDigest(primary, secondary, challenge), "utf8");
    secondInputLength = Math.min(secondInput.length, 64);
  }

  const firstInputLength = Math.min(primary.length, 32);
  const encrypt = (input) => {
    if (useHmac32) {
      return computeSha256ChallengeResponse(input, key, options.keyLength);
    }
    if (customOem && oemMode !== 4) {
      return encryptOemPrivateLoginProof(input, key, customOem.selector, customOem.salt);
    }
    if (oemMode === 1) {
      return encryptOemPrivateLoginProof(input, key, 0x37, 0x5c);
    }
    if (oemMode === 2) {
      return encryptOemPrivateLoginProof(input, key, 0x39, 0x5c);
    }
    if (oemMode === 3) {
      return encryptOemPrivateLoginProof(input, key, 0x38, 0x5c);
    }
    return encryptPrivateLoginProof(input, key);
  };

  return {
    first: encrypt(primary.subarray(0, firstInputLength)),
    second: encrypt(secondInput.subarray(0, secondInputLength)),
    digestLength: useHmac32 ? 32 : 16,
    secondInputLength,
    challengeApplied: Boolean(challenge),
    oemMode,
    useHmac32,
  };
}

function normalizeKeyLength(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return Math.min(fallback, max);
  }
  return Math.min(parsed, fallback, max);
}

function normalizeOemMode(value) {
  const parsed = Number(value || 0);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
    return 0;
  }
  return parsed;
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
  return Buffer.from(String(value || ""), "utf8");
}

function normalizeByte(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
    return fallback;
  }
  return parsed;
}

module.exports = {
  encryptPrivateLoginProof,
  encryptOemPrivateLoginProof,
  computeMd5ChallengeResponse,
  computeSha256ChallengeResponse,
  md5Hex,
  sha256Hex,
  loginChallengeDigest,
  buildPrivateLoginCredentialProofs,
};
