"use strict";

const crypto = require("crypto");

const RSA_PUBLIC_EXPONENT = 0x10001;
const RSA1024_BITS = 1024;
const RSA2048_BITS = 2048;
const RSA3072_BITS = 3072;
const RSA_PKCS1_PADDING = crypto.constants.RSA_PKCS1_PADDING;

function createPrivateRsaCallbackContext(options = {}) {
  const modulusLength = normalizeRsaModulusLength(options.modulusLength || options.bits || (options.rsa2048 ? RSA2048_BITS : RSA1024_BITS));
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength,
    publicExponent: RSA_PUBLIC_EXPONENT,
  });
  const publicKeyDer = publicKey.export({
    type: "pkcs1",
    format: "der",
  });
  const privateKeyDer = privateKey.export({
    type: "pkcs1",
    format: "der",
  });

  return {
    modulusLength,
    publicExponent: RSA_PUBLIC_EXPONENT,
    publicKey,
    privateKey,
    publicKeyDer,
    privateKeyDer,
    request: buildPrivateRsaRequestCallbackOutput(publicKeyDer, privateKeyDer, modulusLength),
    decrypt: (payload, decryptOptions = {}) => decryptPrivateRsaCallbackPayload(payload, {
      ...decryptOptions,
      privateKey,
    }),
  };
}

function buildPrivateRsaRequestCallbackOutput(publicKeyDer, privateKeyDer, modulusLength = RSA1024_BITS) {
  const publicBuffer = toBuffer(publicKeyDer, "publicKeyDer");
  const privateBuffer = toBuffer(privateKeyDer, "privateKeyDer");
  const maxPublicLength = modulusLength === RSA3072_BITS ? 0x300 : modulusLength === RSA2048_BITS ? 0x200 : 0x100;
  const maxPrivateLength = modulusLength === RSA3072_BITS ? 0xc00 : modulusLength === RSA2048_BITS ? 0x800 : 0x400;

  if (publicBuffer.length > maxPublicLength) {
    throw new RangeError(`RSA public key material is ${publicBuffer.length} bytes, max native callback buffer is ${maxPublicLength}`);
  }
  if (privateBuffer.length > maxPrivateLength) {
    throw new RangeError(`RSA private key material is ${privateBuffer.length} bytes, max native callback buffer is ${maxPrivateLength}`);
  }

  return {
    first: publicBuffer,
    firstLength: publicBuffer.length,
    second: privateBuffer,
    secondLength: privateBuffer.length,
    modulusLength,
  };
}

function decryptPrivateRsaCallbackPayload(payload, options = {}) {
  const input = toBuffer(payload, "payload");
  const privateKey = options.privateKey || crypto.createPrivateKey({
    key: toBuffer(options.privateKeyDer, "privateKeyDer"),
    type: "pkcs1",
    format: "der",
  });
  return crypto.privateDecrypt({
    key: privateKey,
    padding: normalizeRsaPadding(options.padding),
  }, input);
}

function normalizeRsaModulusLength(value) {
  const parsed = Number(value);
  if (parsed === RSA1024_BITS || parsed === RSA2048_BITS || parsed === RSA3072_BITS) {
    return parsed;
  }
  throw new RangeError("private RSA callback modulus length must be 1024 or 2048 bits");
}

function normalizeRsaPadding(value) {
  if (value === undefined || value === null) {
    return RSA_PKCS1_PADDING;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new RangeError("RSA padding must be a crypto.constants padding integer");
  }
  return parsed;
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
  RSA_PUBLIC_EXPONENT,
  RSA1024_BITS,
  RSA2048_BITS,
  RSA3072_BITS,
  createPrivateRsaCallbackContext,
  buildPrivateRsaRequestCallbackOutput,
  decryptPrivateRsaCallbackPayload,
};
