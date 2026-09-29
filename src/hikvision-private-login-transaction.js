"use strict";

const {
  LOGIN_PARSE,
  parseFirstLoginFailed,
  parseFirstLoginSuccess,
  parseSecondLoginSuccess,
} = require("./hikvision-private-login-parser");
const {
  buildPrivateLoginFrame,
} = require("./hikvision-private-login-request");
const {
  extractPrivateSessionDescriptor,
} = require("./hikvision-private-session-descriptor");
const {
  mapNativeGenericReplyDescriptor,
  preparsePrivateLoginReply,
} = require("./hikvision-private-reply-descriptor");
const {
  createPrivateRsaCallbackContext,
  RSA1024_BITS,
  RSA2048_BITS,
  RSA3072_BITS,
} = require("./hikvision-private-rsa-callback");

function buildPrivateLoginTransaction(options = {}) {
  const step = normalizeLoginStep(options.step);
  const rsaCallbacks = normalizePrivateLoginRsaCallbacks(options.rsaCallbacks);
  const request = buildPrivateLoginFrame({
    ...options,
    rsaCallbacks,
    protocolSelector: options.protocolSelector ?? (step === 2 ? 0x10010 : 0x10000),
  });

  return {
    step,
    rsaCallbacks,
    request,
    frame: request.frame,
    layout: request.layout,
    parseReply: (reply, parseOptions = {}) => parsePrivateLoginReply(reply, {
      ...parseOptions,
      step,
      mode: parseOptions.mode ?? options.mode,
    }),
  };
}

function parsePrivateLoginReply(reply, options = {}) {
  const step = normalizeLoginStep(options.step);
  const normalizedReply = normalizePrivateLoginReply(reply, options);
  const preparse = preparsePrivateLoginReply(normalizedReply);
  const parserReply = preparse.reply;
  const success = step === 2
    ? parseSecondLoginSuccess(parserReply, options.mode)
    : parseFirstLoginSuccess(parserReply);
  const failure = success === LOGIN_PARSE.SUCCESS
    ? LOGIN_PARSE.NONE
    : parseFirstLoginFailed(parserReply);
  const descriptor = success === LOGIN_PARSE.SUCCESS
    ? extractPrivateSessionDescriptor(parserReply, options)
    : null;

  return {
    step,
    preparse,
    reply: parserReply,
    challenge: preparse.challenge,
    useHmac32: preparse.useHmac32,
    success,
    failure: preparse.ok ? failure : LOGIN_PARSE.UNSUPPORTED,
    ok: preparse.ok && success === LOGIN_PARSE.SUCCESS,
    descriptor,
  };
}

function normalizePrivateLoginReply(reply, options = {}) {
  if (reply?.genericDescriptor || reply?.descriptor) {
    return mapNativeGenericReplyDescriptor(reply, options);
  }
  return reply;
}

function normalizeLoginStep(value) {
  const parsed = Number(value ?? 1);
  if (parsed === 1 || parsed === 2) {
    return parsed;
  }
  throw new RangeError("private login step must be 1 or 2");
}

function createPrivateLoginRsaCallbacks(options = {}) {
  return {
    rsa1024: createPrivateRsaCallbackContext({
      ...options,
      modulusLength: RSA1024_BITS,
    }),
    rsa2048: createPrivateRsaCallbackContext({
      ...options,
      modulusLength: RSA2048_BITS,
    }),
    rsa3072: createPrivateRsaCallbackContext({
      ...options,
      modulusLength: RSA3072_BITS,
    }),
  };
}

function normalizePrivateLoginRsaCallbacks(value) {
  if (value?.rsa1024 && value?.rsa2048 && value?.rsa3072) {
    return value;
  }
  return createPrivateLoginRsaCallbacks();
}

module.exports = {
  buildPrivateLoginTransaction,
  parsePrivateLoginReply,
  normalizePrivateLoginReply,
  createPrivateLoginRsaCallbacks,
  preparsePrivateLoginReply,
};
