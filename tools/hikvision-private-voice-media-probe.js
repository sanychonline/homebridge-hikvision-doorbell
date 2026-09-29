#!/usr/bin/env node
"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");
const {
  buildPrivateVoiceMediaPreamble,
  buildMulawTone,
  splitVoiceMediaFrames,
  framePrivateVoiceMediaPayload,
} = require("../src/hikvision-private-voice-media");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config) {
    throw new Error("usage: hikvision-private-voice-media-probe --config /private/path/config.json [--send --yes]");
  }

  const configPath = path.resolve(args.config);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const redirectTarget = selectedRedirectTarget(config);
  const host = String(args.host || config.privateVoiceMediaHost || redirectTarget.host || config.host || config.redirectHost || "").trim();
  const port = requiredPort(args.port || config.privateVoiceMediaPort || redirectTarget.port || config.port || config.redirectPort, "privateVoiceMediaPort");
  const linkId = requiredUint32(args.linkId ?? config.privateVoiceMediaLinkId ?? redirectTarget.linkId ?? config.linkId, "privateVoiceMediaLinkId");
  const preambleMode = String(args.preamble || config.privateVoiceMediaPreamble || "none").toLowerCase();
  const frameHeader = String(args.frameHeader || config.privateVoiceMediaFrameHeader || "sdk-one-be");
  const frameBytes = positiveInteger(args.frameBytes || config.privateVoiceMediaFrameBytes, 160, 1);
  const durationMs = positiveInteger(args.durationMs || config.durationMs, 1000, 20);
  const sampleRate = positiveInteger(args.sampleRate || config.sampleRate, 8000, 8000);
  const toneHz = positiveInteger(args.toneHz || config.toneHz, 440, 20);
  const amplitude = nonNegativeInteger(args.amplitude || config.amplitude, 1400);
  if (!host) {
    throw new Error("missing-privateVoiceMediaHost");
  }

  const preamble = buildPrivateVoiceMediaPreamble(linkId, preambleMode);
  const audio = buildMulawTone({ durationMs, sampleRate, toneHz, amplitude });
  const frames = splitVoiceMediaFrames(audio, frameBytes);
  const summary = {
    ok: true,
    action: args.send ? "send" : "build",
    host: args.showHost ? host : "[redacted]",
    port,
    linkId,
    byteOrder: redirectTarget.byteOrder,
    preambleMode,
    preambleBytes: preamble.length,
    frameHeader,
    frameBytes,
    frameCount: frames.length,
    audioBytes: audio.length,
    durationMs,
    codec: "G.711ulaw",
  };

  if (!args.send) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (!args.yes) {
    throw new Error("refusing-to-send-without---yes");
  }

  const result = await sendVoiceMediaProbe({
    host,
    port,
    connectTimeoutMs: args.connectTimeoutMs || config.privateVoiceMediaConnectTimeoutMs || config.privateConnectTimeoutMs,
    preamble,
    frames: frames.map((frame) => framePrivateVoiceMediaPayload(frame, frameHeader)),
    frameDelayMs: nonNegativeInteger(args.frameDelayMs ?? config.privateVoiceMediaFrameDelayMs, 20),
  });
  console.log(JSON.stringify({
    ...summary,
    sent: result,
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
    if (arg === "--show-host") {
      result.showHost = true;
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

function sendVoiceMediaProbe(options) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: options.host, port: options.port });
    let bytesSent = 0;
    let settled = false;
    const connectTimeoutMs = Math.max(Number(options.connectTimeoutMs || 4000), 250);
    const timer = setTimeout(() => {
      finish(new Error(`private voice media connect timeout after ${connectTimeoutMs}ms`));
    }, connectTimeoutMs);

    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    socket.once("error", finish);
    socket.once("connect", async () => {
      clearTimeout(timer);
      try {
        if (options.preamble.length) {
          socket.write(options.preamble);
          bytesSent += options.preamble.length;
        }
        for (const frame of options.frames) {
          socket.write(frame);
          bytesSent += frame.length;
          if (options.frameDelayMs > 0) {
            await delay(options.frameDelayMs);
          }
        }
        finish(null, {
          connected: true,
          bytesSent,
          framesSent: options.frames.length,
        });
      } catch (error) {
        finish(error);
      }
    });
  });
}

function requiredPort(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`missing-or-invalid-${name}`);
  }
  return parsed;
}

function requiredUint32(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
    throw new Error(`missing-or-invalid-${name}`);
  }
  return parsed >>> 0;
}

function positiveInteger(value, fallback, minimum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    return fallback;
  }
  return parsed;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function selectedRedirectTarget(config = {}) {
  const variants = config.redirectVariants || config.variants || {};
  const byteOrder = String(config.privateAudioRedirectByteOrder || config.privateVoiceMediaRedirectByteOrder || "be").toLowerCase();
  const host = config.privateVoiceMediaHost || config.redirectHost || config.host || "";
  if (byteOrder === "le" || byteOrder === "little" || byteOrder === "little-endian") {
    return {
      byteOrder: "le",
      host,
      port: variants.portLE ?? config.redirectPort,
      linkId: variants.linkIdLE ?? config.redirectLinkId ?? config.linkId,
    };
  }
  return {
    byteOrder: "be",
    host,
    port: variants.portBE ?? config.redirectPort,
    linkId: variants.linkIdBE ?? config.redirectLinkId ?? config.linkId,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
