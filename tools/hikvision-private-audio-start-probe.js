#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const {
  buildHikAudioStartFrame,
} = require("../src/hikvision-private-audio-start");
const {
  parseHikAudioStartResponse,
} = require("../src/hikvision-private-audio-response");
const {
  sendPrivateProtocolFrame,
} = require("../src/hikvision-private-transport");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config) {
    throw new Error("usage: hikvision-private-audio-start-probe --config /private/path/config.json [--send --yes] [--follow-redirect]");
  }

  const configPath = path.resolve(args.config);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const request = buildHikAudioStartFrame({
    protocolSelector: requiredUint32(config.privateAudioProtocolSelector ?? config.protocolSelector, "privateAudioProtocolSelector"),
    protocolInfo: requiredBuffer(config.privateAudioProtocolInfo ?? config.protocolInfo, "privateAudioProtocolInfo"),
    sessionInfo: requiredBuffer(config.privateAudioSessionInfo ?? config.sessionInfo, "privateAudioSessionInfo"),
    packedSelector: requiredUint32(config.privateAudioPackedSelector ?? config.packedSelector, "privateAudioPackedSelector"),
    supportExtendedAudioStart: config.privateAudioStartExtended === true || config.supportExtendedAudioStart === true,
    extendedAudioStartByte: config.privateAudioStartExtendedByte ?? config.extendedAudioStartByte ?? 0,
  });

  const summary = {
    ok: true,
    action: args.send ? "send" : "build",
    host: config.ip || config.host || null,
    port: Number(config.privatePort || 8000),
    frameBytes: request.frame.length,
    extraLength: request.extraLength,
    extraCapacity: request.extraCapacity,
    marker: request.marker,
    layout: sanitizeLayout(request.layout),
  };

  if (!args.send) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (!args.yes) {
    throw new Error("refusing-to-send-without---yes");
  }

  const reply = await sendPrivateProtocolFrame(config, request.frame, {
    connectTimeoutMs: args.connectTimeoutMs || config.privateConnectTimeoutMs,
    replyTimeoutMs: args.replyTimeoutMs || config.privateReplyTimeoutMs,
  });
  const audioStart = parseHikAudioStartResponse({
    status: reply.parsed?.command,
    body: reply.parsed?.body,
  });
  const redirectTarget = audioStart.redirect ? selectedRedirectTarget(audioStart, config) : null;
  const redirectFollow = args.followRedirect && audioStart.redirect
    ? await sendPrivateProtocolFrame(config, request.frame, {
      host: audioStart.host,
      port: redirectTarget.port,
      connectTimeoutMs: args.connectTimeoutMs || config.privateConnectTimeoutMs,
      replyTimeoutMs: args.replyTimeoutMs || config.privateReplyTimeoutMs,
    }).then((followReply) => ({
      byteOrder: redirectTarget.byteOrder,
      port: redirectTarget.port,
      linkId: redirectTarget.linkId,
      rawBytes: followReply.raw.length,
      expectedBytes: followReply.expectedBytes,
      parsed: summarizeWireReply(followReply.parsed),
      audioStart: summarizeAudioStart(parseHikAudioStartResponse({
        status: followReply.parsed?.command,
        body: followReply.parsed?.body,
      })),
    }))
    : null;
  console.log(JSON.stringify({
    ...summary,
    followRedirect: Boolean(args.followRedirect),
    reply: {
      rawBytes: reply.raw.length,
      expectedBytes: reply.expectedBytes,
      parsed: summarizeWireReply(reply.parsed),
      audioStart: summarizeAudioStart(audioStart),
    },
    redirectFollow,
  }, null, 2));
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--send") {
      result.send = true;
      continue;
    }
    if (arg === "--yes") {
      result.yes = true;
      continue;
    }
    if (arg === "--follow-redirect") {
      result.followRedirect = true;
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

function requiredUint32(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
    throw new Error(`missing-or-invalid-${name}`);
  }
  return parsed >>> 0;
}

function sanitizeLayout(layout) {
  return {
    selector: layout.selector,
    builder: layout.builder,
    headerLength: layout.headerLength,
    payloadOffset: layout.payloadOffset,
    payloadLengthOffset: layout.payloadLengthOffset,
    extendedCompact: Boolean(layout.extendedCompact),
    extendedNormal: Boolean(layout.extendedNormal),
    alternateNormal: Boolean(layout.alternateNormal),
  };
}

function summarizeWireReply(reply) {
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

function summarizeAudioStart(parsed) {
  if (!parsed) {
    return null;
  }
  return {
    status: parsed.status,
    ok: parsed.ok,
    redirect: parsed.redirect,
    host: parsed.redirect ? parsed.host : undefined,
    port: parsed.redirect ? parsed.port : undefined,
    linkId: parsed.redirect ? parsed.linkId : undefined,
    variants: parsed.redirect ? parsed.variants : undefined,
  };
}

function selectedRedirectTarget(parsed, config = {}) {
  const byteOrder = String(config.privateAudioRedirectByteOrder || config.privateVoiceMediaRedirectByteOrder || "be").toLowerCase();
  const variants = parsed.variants || {};
  if (byteOrder === "le" || byteOrder === "little" || byteOrder === "little-endian") {
    return {
      byteOrder: "le",
      host: parsed.host,
      port: variants.portLE ?? parsed.port,
      linkId: variants.linkIdLE ?? parsed.linkId,
    };
  }
  return {
    byteOrder: "be",
    host: parsed.host,
    port: variants.portBE ?? parsed.port,
    linkId: variants.linkIdBE ?? parsed.linkId,
  };
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
