#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const {
  buildPrivateLoginTransaction,
} = require("../src/hikvision-private-login-transaction");
const {
  executePrivateLoginTransaction,
} = require("../src/hikvision-private-transport");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config) {
    throw new Error("usage: hikvision-private-login-probe --config /private/path/config.json [--step 1|2] [--send]");
  }

  const configPath = path.resolve(args.config);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const step = Number(args.step || config.step || 1);
  const challenge = optionalBuffer(config.challenge);
  const transaction = buildPrivateLoginTransaction({
    ...config,
    step,
    primary: requiredBuffer(config.primary, "primary"),
    secondary: requiredBuffer(config.secondary, "secondary"),
    key: requiredBuffer(config.key, "key"),
    ...(challenge ? { challenge } : {}),
    mac: config.mac || config.macAddress,
    ip: config.ip || config.host,
    mode: config.mode ?? 3,
    oemMode: config.oemMode,
    customOem: config.customOem,
    protocolFlag17e: config.protocolFlag17e ?? 0,
  });

  const summary = {
    ok: true,
    action: args.send ? "send" : "build",
    host: config.ip || config.host || null,
    port: Number(config.privatePort || 8000),
    step,
    frameBytes: transaction.frame.length,
    layout: transaction.layout,
    rsa1024: summarizeRsa(transaction.rsaCallbacks.rsa1024),
    rsa2048: summarizeRsa(transaction.rsaCallbacks.rsa2048),
    rsa3072: summarizeRsa(transaction.rsaCallbacks.rsa3072),
  };

  if (!args.send) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const result = await executePrivateLoginTransaction(config, transaction, {
    connectTimeoutMs: args.connectTimeoutMs || config.privateConnectTimeoutMs,
    replyTimeoutMs: args.replyTimeoutMs || config.privateReplyTimeoutMs,
  });

  console.log(JSON.stringify({
    ...summary,
    reply: {
      rawBytes: result.reply.raw.length,
      expectedBytes: result.reply.expectedBytes,
      parsed: summarizeReply(result.reply.parsed),
    },
    parsedLogin: summarizeParsedLogin(result.parsed),
  }, null, 2));
}

function summarizeRsa(context) {
  return {
    modulusLength: context.modulusLength,
    publicKeyBytes: context.publicKeyDer.length,
    privateKeyBytes: context.privateKeyDer.length,
    requestFirstLength: context.request.firstLength,
    requestSecondLength: context.request.secondLength,
  };
}

function summarizeReply(reply) {
  if (!reply) {
    return null;
  }
  return {
    totalLength: reply.totalLength,
    marker: reply.marker,
    flags: reply.flags,
    headerLength: reply.headerLength,
    command: reply.command,
    checksum: reply.checksum,
    version: reply.version,
    bodyLength: reply.bodyLength,
  };
}

function summarizeParsedLogin(parsed) {
  if (!parsed) {
    return null;
  }
  return {
    ok: parsed.ok,
    step: parsed.step,
    success: parsed.success,
    failure: parsed.failure,
    preparse: parsed.preparse ? {
      ok: parsed.preparse.ok,
      reason: parsed.preparse.reason || null,
      highCommandByte: parsed.preparse.highCommandByte,
      bodyLength: parsed.preparse.bodyLength,
      challengeBytes: parsed.preparse.challenge?.length || 0,
      useHmac32: parsed.preparse.useHmac32,
    } : null,
    descriptor: parsed.descriptor ? {
      protocolVersion: parsed.descriptor.protocolVersion,
      bodyLength: parsed.descriptor.bodyLength,
      legacyMode: parsed.descriptor.legacyMode,
      deviceUserId: parsed.descriptor.deviceUserId,
    } : null,
  };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--send") {
      result.send = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      result[key] = argv[index + 1];
      index += 1;
    }
  }
  return result;
}

function requiredBuffer(value, name) {
  const buffer = optionalBuffer(value);
  if (!buffer?.length) {
    throw new Error(`missing-${name}`);
  }
  return buffer;
}

function optionalBuffer(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return Buffer.from(value);
  }
  if (typeof value === "string") {
    const compact = value.replace(/[^a-fA-F0-9]/g, "");
    if (compact.length && compact.length % 2 === 0 && compact.length === value.replace(/\s+/g, "").length) {
      return Buffer.from(compact, "hex");
    }
    return Buffer.from(value, "utf8");
  }
  throw new Error("buffer-value-must-be-string-or-array");
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: safeError(error),
  }, null, 2));
  process.exit(1);
});

function safeError(error) {
  return String(error?.message || "unknown")
    .replace(/password[^,\s}]*/gi, "password=[redacted]")
    .replace(/token[^,\s}]*/gi, "token=[redacted]");
}
