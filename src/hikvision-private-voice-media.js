"use strict";

const G711_AUDIO_FRAME_BYTES = 80;
const PRIVATE_G711_PACKET_HEADER_BYTES = 4;
const PRIVATE_G711_MEDIA_KIND = 1;
const PCM16LE_16KHZ_TO_G711_GROUP_BYTES = 4;

function buildPrivateVoiceMediaPreamble(linkId, mode = "none") {
  const normalized = String(mode || "none").toLowerCase();
  if (normalized === "none") {
    return Buffer.alloc(0);
  }
  const buffer = Buffer.alloc(4);
  if (normalized === "linkid-le") {
    buffer.writeUInt32LE((Number(linkId) || 0) >>> 0, 0);
  } else {
    buffer.writeUInt32BE((Number(linkId) || 0) >>> 0, 0);
  }
  return buffer;
}

function downsample16kPcmTo8kMulaw(pcm, gain = 1) {
  const input = toBuffer(pcm);
  const output = Buffer.alloc(Math.floor(input.length / PCM16LE_16KHZ_TO_G711_GROUP_BYTES));
  const normalizedGain = Number.isFinite(Number(gain)) && Number(gain) > 0 ? Number(gain) : 1;
  for (
    let inputOffset = 0, outputOffset = 0;
    inputOffset + 1 < input.length;
    inputOffset += PCM16LE_16KHZ_TO_G711_GROUP_BYTES, outputOffset += 1
  ) {
    output[outputOffset] = linearToMulaw(Math.round(input.readInt16LE(inputOffset) * normalizedGain));
  }
  return output;
}

function buildMulawTone(options = {}) {
  const sampleRate = positiveInteger(options.sampleRate, 8000, 8000);
  const durationMs = positiveInteger(options.durationMs, 1000, 20);
  const toneHz = positiveInteger(options.toneHz, 440, 20);
  const amplitude = nonNegativeInteger(options.amplitude, 1400);
  const samples = Math.max(Math.floor(sampleRate * durationMs / 1000), 1);
  const output = Buffer.alloc(samples);
  for (let index = 0; index < samples; index += 1) {
    const phase = index / sampleRate;
    output[index] = linearToMulaw(Math.round(Math.sin(2 * Math.PI * toneHz * phase) * amplitude));
  }
  return output;
}

function splitVoiceMediaFrames(buffer, frameBytes = 160) {
  const input = toBuffer(buffer);
  const size = positiveInteger(frameBytes, 160, 1);
  const frames = [];
  for (let offset = 0; offset < input.length; offset += size) {
    frames.push(input.subarray(offset, Math.min(offset + size, input.length)));
  }
  return frames;
}

function framePrivateVoiceMediaPayload(payload, mode = "sdk-one-be") {
  const input = toBuffer(payload);
  const normalized = String(mode || "sdk-one-be").toLowerCase();
  if (normalized === "none") {
    return input;
  }

  const header = Buffer.alloc(4);
  if (normalized === "length-le") {
    header.writeUInt32LE(input.length >>> 0, 0);
  } else if (normalized === "length-be") {
    header.writeUInt32BE(input.length >>> 0, 0);
  } else if (normalized === "sdk-one-le" || normalized === "one-le") {
    header.writeUInt32LE(1, 0);
  } else {
    header.writeUInt32BE(1, 0);
  }
  return Buffer.concat([header, input]);
}

function buildPrivateG711VoicePacket(audioFrame) {
  const input = toBuffer(audioFrame);
  if (input.length !== G711_AUDIO_FRAME_BYTES) {
    throw new RangeError(
      `Private G.711 audio frame must contain exactly ${G711_AUDIO_FRAME_BYTES} bytes; received ${input.length}.`,
    );
  }

  const packet = Buffer.allocUnsafe(PRIVATE_G711_PACKET_HEADER_BYTES + G711_AUDIO_FRAME_BYTES);
  packet.writeUInt32BE(PRIVATE_G711_MEDIA_KIND, 0);
  input.copy(packet, PRIVATE_G711_PACKET_HEADER_BYTES);
  return packet;
}

function linearToMulaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  let value = sample;
  if (sign) {
    value = -value;
  }
  if (value > CLIP) {
    value = CLIP;
  }
  value += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (value & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent -= 1;
  }
  const mantissa = (value >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
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
  throw new TypeError("voice media buffer must be Buffer-compatible");
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

module.exports = {
  G711_AUDIO_FRAME_BYTES,
  PCM16LE_16KHZ_TO_G711_GROUP_BYTES,
  buildPrivateVoiceMediaPreamble,
  buildPrivateG711VoicePacket,
  downsample16kPcmTo8kMulaw,
  buildMulawTone,
  splitVoiceMediaFrames,
  framePrivateVoiceMediaPayload,
  linearToMulaw,
};
