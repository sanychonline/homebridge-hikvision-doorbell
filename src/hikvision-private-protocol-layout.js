"use strict";

const { computePrivateCommandChecksum } = require("./hikvision-private-command-checksum");

const PROTOCOL_SELECTOR_COMPACT = new Set([0x10000, 0x10010]);

function resolvePrivateProtocolLayout(protocol) {
  const buffer = fixedBuffer(protocol, "protocol");
  const selector = buffer.readUInt32LE(0x000);
  const extendedCompact = buffer.readUInt32LE(0x130) !== 0;
  const extendedNormal = buffer[0x17a] === 1;
  const alternateNormal = buffer[0x17d] === 1;
  const compact = PROTOCOL_SELECTOR_COMPACT.has(selector);

  if (compact) {
    return {
      selector,
      builder: "compact",
      headerLength: extendedCompact ? 0x34 : 0x24,
      payloadOffset: 0x138,
      payloadLengthOffset: 0x144,
      extendedCompact,
      extendedNormal: false,
      alternateNormal: false,
    };
  }

  if (alternateNormal) {
    return {
      selector,
      builder: "normal-alternate",
      headerLength: 0x20,
      payloadOffset: 0x138,
      payloadLengthOffset: 0x144,
      extendedCompact,
      extendedNormal,
      alternateNormal,
    };
  }

  return {
    selector,
    builder: "normal",
    headerLength: extendedCompact
      ? (extendedNormal ? 0x84 : 0x30)
      : (extendedNormal ? 0x64 : 0x20),
    payloadOffset: 0x138,
    payloadLengthOffset: 0x144,
    extendedCompact,
    extendedNormal,
    alternateNormal,
  };
}

function privateProtocolPayloadLength(protocol) {
  const buffer = fixedBuffer(protocol, "protocol");
  return buffer.readUInt32LE(0x144);
}

function privateProtocolFrameLength(protocol) {
  const layout = resolvePrivateProtocolLayout(protocol);
  return layout.headerLength + privateProtocolPayloadLength(protocol);
}

function buildCompactPrivateProtocolHeader(protocol, options = {}) {
  const buffer = fixedBuffer(protocol, "protocol");
  const layout = resolvePrivateProtocolLayout(buffer);
  if (layout.builder !== "compact") {
    throw new Error(`compact protocol header cannot build ${layout.builder} layout`);
  }

  const encodeUint32 = typeof options.encodeUint32 === "function"
    ? options.encodeUint32
    : hprHtonl;
  const payloadLength = privateProtocolPayloadLength(buffer);
  const header = Buffer.alloc(layout.headerLength, 0);
  writeCallbackUint32(header, 0x00, layout.headerLength + payloadLength, encodeUint32);
  header[4] = buffer.readUInt32LE(0x004) > 0x0300209b ? 0x63 : 0x5a;
  header[5] = layout.extendedCompact ? 0x01 : 0x00;

  writeCallbackUint32(header, 0x0c, buffer.readUInt32LE(0x000), encodeUint32);
  writeCallbackUint32(header, 0x10, buffer.readUInt32LE(0x150), encodeUint32);

  if (layout.extendedCompact) {
    buffer.copy(header, 0x1c, 0x124, 0x12a);
    buffer.copy(header, 0x24, 0x114, 0x124);
    if (buffer[0x17c] === 1) {
      header[0x22] |= 0x04;
      if (buffer[0x17b] === 1) {
        header[0x22] |= 0x08;
      }
    }
    header[0x22] |= 0x40;
  } else {
    header[0x22] = 0x01 | 0x02 | 0x20;
    if (buffer[0x17c] === 1) {
      header[0x22] |= 0x04;
      if (buffer[0x17b] === 1) {
        header[0x22] |= 0x08;
      }
    }
    header[0x22] |= 0x40;
    buffer.copy(header, 0x18, 0x12c, 0x130);
    buffer.copy(header, 0x1c, 0x124, 0x12a);
  }

  header[0x16] |= buffer[0x17e];
  header[0x17] |= 0x01;
  return header;
}

function buildCompactPrivateProtocolFrame(protocol, payload, options = {}) {
  const buffer = fixedBuffer(protocol, "protocol");
  const body = toBuffer(payload, "payload");
  const expectedLength = privateProtocolPayloadLength(buffer);
  if (body.length !== expectedLength) {
    throw new RangeError(`payload length ${body.length} does not match protocol payload length ${expectedLength}`);
  }
  return Buffer.concat([buildCompactPrivateProtocolHeader(buffer, options), body]);
}

function buildPrivateProtocolHeader(protocol, options = {}) {
  const buffer = fixedBuffer(protocol, "protocol");
  const layout = resolvePrivateProtocolLayout(buffer);
  if (layout.builder === "compact") {
    return buildCompactPrivateProtocolHeader(buffer, options);
  }
  if (layout.builder === "normal") {
    return buildNormalPrivateProtocolHeader(buffer, options);
  }
  if (layout.builder === "normal-alternate") {
    return buildNormalAlternatePrivateProtocolHeader(buffer, options);
  }
  throw new Error(`private protocol header cannot build ${layout.builder} layout`);
}

function buildPrivateProtocolFrame(protocol, payload, options = {}) {
  const buffer = fixedBuffer(protocol, "protocol");
  const body = toBuffer(payload, "payload");
  const expectedLength = privateProtocolPayloadLength(buffer);
  if (body.length !== expectedLength) {
    throw new RangeError(`payload length ${body.length} does not match protocol payload length ${expectedLength}`);
  }
  return Buffer.concat([buildPrivateProtocolHeader(buffer, options), body]);
}

function buildNormalPrivateProtocolHeader(protocol, options = {}) {
  const buffer = fixedBuffer(protocol, "protocol");
  const layout = resolvePrivateProtocolLayout(buffer);
  if (layout.builder !== "normal") {
    throw new Error(`normal protocol header cannot build ${layout.builder} layout`);
  }

  const encodeUint32 = typeof options.encodeUint32 === "function"
    ? options.encodeUint32
    : hprHtonl;
  const encodeUint16 = typeof options.encodeUint16 === "function"
    ? options.encodeUint16
    : hprHtons;
  const callbackValue = options.callbackValue === undefined
    ? privateProtocolCallbackValue(buffer)
    : requireUint32(options.callbackValue, "callbackValue");
  const payloadLength = privateProtocolPayloadLength(buffer);
  const header = Buffer.alloc(layout.headerLength, 0);

  if (layout.extendedCompact && layout.extendedNormal) {
    writeNormalProtocolFirstHeader(header, buffer, {
      baseOffset: 0,
      headerLength: 0x84,
      nestedPayloadHeaderLength: 0x30,
      firstSelector: 0x50000,
      firstCommandOffset: 0x158,
      firstCommandTargetOffset: 0x30,
      firstMarkerOffset: 0x08,
      firstInfoOffset: 0x114,
      firstBytesOffset: 0x124,
      firstFlagsOffset: 0x07,
      firstGeneratedOffset: 0x08,
      payloadLength,
      callbackValue,
      encodeUint32,
    });
    writeNormalProtocolSecondHeader(header, buffer, {
      baseOffset: 0x54,
      headerLength: 0x30,
      commandOffset: 0x000,
      markerOffset: 0x15c,
      infoOffset: 0x164,
      bytesOffset: 0x174,
      flagsOffset: 0x07,
      generatedOffset: 0x08,
      extendedLength: true,
      payloadLength,
      callbackValue,
      encodeUint32,
    });
    return header;
  }

  if (layout.extendedCompact) {
    writeNormalProtocolSimpleHeader(header, buffer, {
      headerLength: 0x30,
      commandOffset: 0x000,
      markerOffset: 0x08,
      bytesOffset: 0x124,
      infoOffset: 0x114,
      flagsOffset: 0x07,
      generatedOffset: 0x08,
      payloadLength,
      callbackValue,
      encodeUint32,
      encodeUint16,
    });
    return header;
  }

  if (layout.extendedNormal) {
    writeNormalProtocolFirstHeader(header, buffer, {
      baseOffset: 0,
      headerLength: 0x64,
      nestedPayloadHeaderLength: 0x20,
      firstSelector: 0x50000,
      firstCommandOffset: 0x158,
      firstMarkerOffset: 0x08,
      firstBytesOffset: 0x124,
      firstFlagsOffset: 0x4b,
      firstGeneratedOffset: 0x08,
      payloadLength,
      callbackValue,
      encodeUint32,
    });
    writeNormalProtocolSecondHeader(header, buffer, {
      baseOffset: 0x48,
      headerLength: 0x20,
      commandOffset: 0x000,
      markerOffset: 0x15c,
      bytesOffset: 0x174,
      headerVariantOffset: 0x14c,
      word160Offset: 0x160,
      flagsOffset: 0x03,
      generatedOffset: 0x04,
      payloadLength,
      callbackValue,
      encodeUint32,
    });
    return header;
  }

  writeNormalProtocolSimpleHeader(header, buffer, {
    headerLength: 0x20,
    commandOffset: 0x000,
    markerOffset: 0x08,
    bytesOffset: 0x124,
    headerVariantOffset: 0x14c,
    commandContextOffset: 0x12c,
    flagsOffset: 0x07,
    generatedOffset: 0x08,
    payloadLength,
    callbackValue,
    encodeUint32,
    encodeUint16,
  });
  return header;
}

function buildNormalPrivateProtocolFrame(protocol, payload, options = {}) {
  const buffer = fixedBuffer(protocol, "protocol");
  const body = toBuffer(payload, "payload");
  const expectedLength = privateProtocolPayloadLength(buffer);
  if (body.length !== expectedLength) {
    throw new RangeError(`payload length ${body.length} does not match protocol payload length ${expectedLength}`);
  }
  return Buffer.concat([buildNormalPrivateProtocolHeader(buffer, options), body]);
}

function buildNormalAlternatePrivateProtocolHeader(protocol, options = {}) {
  const buffer = fixedBuffer(protocol, "protocol");
  const layout = resolvePrivateProtocolLayout(buffer);
  if (layout.builder !== "normal-alternate") {
    throw new Error(`normal-alternate protocol header cannot build ${layout.builder} layout`);
  }

  const encodeUint32 = typeof options.encodeUint32 === "function"
    ? options.encodeUint32
    : hprHtonl;
  const callbackValue = options.callbackValue === undefined
    ? privateProtocolCallbackValue(buffer)
    : requireUint32(options.callbackValue, "callbackValue");
  const payloadLength = privateProtocolPayloadLength(buffer);
  const bodyLength = buffer.readUInt32LE(0x148) || payloadLength;
  const header = Buffer.alloc(layout.headerLength, 0);
  writeCallbackUint32(header, 0x00, bodyLength + layout.headerLength, encodeUint32);
  header[0x04] = buffer.readUInt32LE(0x004) > 0x0300209b ? 0x63 : 0x5a;
  header[0x05] = 0x00;
  header[0x06] = buffer[0x14c];
  writeCallbackUint32(header, 0x08, callbackValue, encodeUint32);
  writeCallbackUint32(header, 0x0c, buffer.readUInt32LE(0x000), encodeUint32);
  writeRawUint32(header, 0x10, buffer.readUInt32LE(0x12c));
  writeCallbackUint32(header, 0x14, buffer.readUInt32LE(0x008), encodeUint32);
  buffer.copy(header, 0x18, 0x124, 0x12a);
  header[0x1e] = 0xff;
  return header;
}

function buildNormalAlternatePrivateProtocolFrame(protocol, payload, options = {}) {
  const buffer = fixedBuffer(protocol, "protocol");
  const body = toBuffer(payload, "payload");
  const expectedLength = privateProtocolPayloadLength(buffer);
  if (body.length !== expectedLength) {
    throw new RangeError(`payload length ${body.length} does not match protocol payload length ${expectedLength}`);
  }
  return Buffer.concat([buildNormalAlternatePrivateProtocolHeader(buffer, options), body]);
}

function computePrivateProtocolChecksum(protocol) {
  const buffer = fixedBuffer(protocol, "protocol");
  return computePrivateCommandChecksum({
    deviceUserId: buffer.readUInt32LE(0x08),
    randomSeed: buffer.readUInt32LE(0x10),
    commandId: buffer.readUInt32LE(0x00),
    currentDeviceTime: buffer.readUInt32LE(0x0c),
    localMacAddress: buffer.subarray(0x124, 0x12a),
    sessionEncryptionKey: buffer.subarray(0x14, 0x24),
  });
}

function writeNormalProtocolFirstHeader(header, protocol, fields) {
  const marker = protocol.readUInt32LE(0x004) > 0x0300209b ? 0x63 : 0x5a;
  const base = fields.baseOffset;
  writeCallbackUint32(header, base + 0x00, fields.headerLength + fields.payloadLength, fields.encodeUint32);
  header[base + 0x04] = marker;
  header[base + 0x05] = 0x00;
  writeCallbackUint32(header, base + 0x0c, fields.firstSelector, fields.encodeUint32);
  writeCallbackUint32(header, base + 0x14, protocol.readUInt32LE(fields.firstMarkerOffset), fields.encodeUint32);
  if (fields.firstInfoOffset !== undefined) {
    protocol.copy(header, base + 0x20, fields.firstInfoOffset, fields.firstInfoOffset + 0x10);
  }
  writeCallbackUint32(header, base + (fields.firstCommandTargetOffset ?? 0x20), protocol.readUInt32LE(fields.firstCommandOffset), fields.encodeUint32);
  protocol.copy(header, base + 0x18, fields.firstBytesOffset, fields.firstBytesOffset + 6);
  writeCallbackUint32(header, base + fields.firstGeneratedOffset, fields.callbackValue, fields.encodeUint32);

  const nestedBodyLength = protocol.readUInt32LE(0x148) || fields.payloadLength;
  writeCallbackUint32(header, base + 0x44, nestedBodyLength + fields.nestedPayloadHeaderLength, fields.encodeUint32);
  applyNormalProtocolFlags(header, base + fields.firstFlagsOffset, protocol);
}

function writeNormalProtocolSecondHeader(header, protocol, fields) {
  const marker = protocol.readUInt32LE(0x004) > 0x0300209b ? 0x63 : 0x5a;
  const base = fields.baseOffset;
  if (fields.extendedLength) {
    writeCallbackUint32(header, base + 0x00, fields.headerLength + fields.payloadLength, fields.encodeUint32);
    header[base + 0x04] = marker;
    header[base + 0x05] = 0x01;
    writeCallbackUint32(header, base + 0x0c, protocol.readUInt32LE(fields.commandOffset), fields.encodeUint32);
    writeRawUint32(header, base + 0x14, protocol.readUInt32LE(fields.markerOffset));
  } else {
    header[base + 0x00] = marker;
    header[base + 0x01] = 0x00;
    writeCallbackUint32(header, base + 0x08, protocol.readUInt32LE(fields.commandOffset), fields.encodeUint32);
    writeRawUint32(header, base + 0x10, protocol.readUInt32LE(fields.markerOffset));
  }
  if (fields.headerVariantOffset !== undefined) {
    header[base + 0x02] = protocol[fields.headerVariantOffset];
  }
  if (fields.word160Offset !== undefined) {
    writeCallbackUint32(header, base + 0x0c, protocol.readUInt32LE(fields.word160Offset), fields.encodeUint32);
  }
  if (fields.infoOffset !== undefined) {
    protocol.copy(header, base + 0x20, fields.infoOffset, fields.infoOffset + 0x10);
  }
  protocol.copy(header, base + (fields.extendedLength ? 0x18 : 0x14), fields.bytesOffset, fields.bytesOffset + 6);
  writeCallbackUint32(header, base + fields.generatedOffset, fields.callbackValue, fields.encodeUint32);
  applyNormalProtocolFlags(header, base + fields.flagsOffset, protocol);
}

function writeNormalProtocolSimpleHeader(header, protocol, fields) {
  const marker = protocol.readUInt32LE(0x004) > 0x0300209b ? 0x63 : 0x5a;
  const bodyLength = protocol.readUInt32LE(0x148) || fields.payloadLength;
  writeCallbackUint32(header, 0x00, bodyLength + fields.headerLength, fields.encodeUint32);
  header[0x04] = marker;
  header[0x05] = fields.headerLength === 0x30 ? 0x01 : 0x00;
  writeCallbackUint32(header, 0x0c, protocol.readUInt32LE(fields.commandOffset), fields.encodeUint32);
  writeCallbackUint32(header, 0x14, protocol.readUInt32LE(fields.markerOffset), fields.encodeUint32);
  if (fields.headerVariantOffset !== undefined) {
    header[0x06] = protocol[fields.headerVariantOffset];
  }
  if (fields.commandContextOffset !== undefined) {
    writeRawUint32(header, 0x10, protocol.readUInt32LE(fields.commandContextOffset));
  }
  protocol.copy(header, 0x18, fields.bytesOffset, fields.bytesOffset + 6);
  if (fields.infoOffset !== undefined) {
    protocol.copy(header, 0x20, fields.infoOffset, fields.infoOffset + 0x10);
  }
  applyNormalProtocolFlags(header, fields.flagsOffset, protocol);
  if (protocol[0x14f] === 1 && fields.headerLength === 0x20) {
    header.writeUInt16LE(fields.encodeUint16(protocol.readUInt32LE(0x158) & 0xffff), 0x1e);
  }
  writeCallbackUint32(header, fields.generatedOffset, fields.callbackValue, fields.encodeUint32);
}

function applyNormalProtocolFlags(header, offset, protocol) {
  if (protocol[0x14e] === 1) {
    header[offset] |= 0x01;
  }
  if (protocol[0x14f] === 1) {
    header[offset] |= 0x02;
  }
}

function writeCallbackUint32(target, offset, value, encodeUint32) {
  target.writeUInt32LE(encodeUint32(value >>> 0), offset);
}

function writeRawUint32(target, offset, value) {
  target.writeUInt32LE(value >>> 0, offset);
}

function hprHtonl(value) {
  const normalized = value >>> 0;
  return (((normalized & 0x000000ff) << 24)
    | ((normalized & 0x0000ff00) << 8)
    | ((normalized & 0x00ff0000) >>> 8)
    | ((normalized & 0xff000000) >>> 24)) >>> 0;
}

function hprHtons(value) {
  const normalized = value & 0xffff;
  return (((normalized & 0x00ff) << 8) | ((normalized & 0xff00) >>> 8)) & 0xffff;
}

function requireUint32(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer`);
  }
  return parsed >>> 0;
}

function fixedBuffer(value, name) {
  if (!Buffer.isBuffer(value)) {
    throw new TypeError(`${name} must be a Buffer`);
  }
  if (value.length < 0x198) {
    throw new RangeError(`${name} must be at least 0x198 bytes`);
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
  resolvePrivateProtocolLayout,
  privateProtocolPayloadLength,
  privateProtocolFrameLength,
  buildPrivateProtocolHeader,
  buildPrivateProtocolFrame,
  buildCompactPrivateProtocolHeader,
  buildCompactPrivateProtocolFrame,
  buildNormalPrivateProtocolHeader,
  buildNormalPrivateProtocolFrame,
  buildNormalAlternatePrivateProtocolHeader,
  buildNormalAlternatePrivateProtocolFrame,
  privateProtocolCallbackValue,
  hprHtonl,
  hprHtons,
};
