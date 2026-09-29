"use strict";

const net = require("net");
const crypto = require("crypto");
const os = require("os");
const {
  computePrivateCommandChecksum,
} = require("./hikvision-private-command-checksum");

const DEFAULT_PRIVATE_PORT = 8000;
const DEFAULT_CONNECT_TIMEOUT_MS = 4000;
const DEFAULT_REPLY_TIMEOUT_MS = 6000;
const MAX_PRIVATE_REPLY_BYTES = 1024 * 1024;
const PRIVATE_LOGIN_MARKER = 0x05013d4b;
const PRIVATE_LOGIN_REQUEST_BYTES = 224;
const PRIVATE_LOGIN_PROOF_BYTES = 84;
const PRIVATE_LOGIN_CHALLENGE_BYTES = 144;
const PRIVATE_RSA_PUBLIC_KEY_DER_BYTES = 140;
const PRIVATE_SESSION_ENCRYPTION_KEY_BYTES = 16;
const PRIVATE_AUDIO_CAPABILITIES_REQUEST_BYTES = 68;
const PRIVATE_AUDIO_CAPABILITIES_REPLY_BYTES = 24;
const PRIVATE_AUDIO_CAPABILITIES_COMMAND_ID = 0x00110044;
const PRIVATE_AUDIO_CAPABILITIES_DEVICE_AUDIO_UNAVAILABLE = 30;
const PRIVATE_AUDIO_CHANNEL = 1;
const PRIVATE_VOICE_SETUP_BYTES = 36;
const PRIVATE_VOICE_ACK_BYTES = 16;
const PRIVATE_VOICE_SETUP_MESSAGE_TYPE = 0x63;
const PRIVATE_VOICE_START_COMMAND_ID = 0x00111030;
const PRIVATE_VOICE_COMMAND_ACCEPTED = 1;
const PRIVATE_VOICE_CHANNEL_READY = 1;
const PRIVATE_VOICE_ACK_NO_ERROR = 0;

async function sendPrivateProtocolFrame(config = {}, frame, options = {}) {
  const host = privateProtocolHost(config, options);
  const port = privateProtocolPort(config, options);
  const payload = toBuffer(frame, "frame");
  const connectTimeoutMs = normalizeTimeout(options.connectTimeoutMs ?? config.privateConnectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
  const replyTimeoutMs = normalizeTimeout(options.replyTimeoutMs ?? config.privateReplyTimeoutMs, DEFAULT_REPLY_TIMEOUT_MS);

  return withPrivateSocket({
    host,
    port,
    connectTimeoutMs,
    replyTimeoutMs,
  }, async (socket) => {
    socket.write(payload);
    return readPrivateProtocolReply(socket, { replyTimeoutMs });
  });
}

async function executePrivateLoginTransaction(config = {}, transaction, options = {}) {
  if (!transaction?.frame) {
    throw new TypeError("private login transaction with frame is required");
  }
  const reply = await sendPrivateProtocolFrame(config, transaction.frame, options);
  return {
    reply,
    parsed: typeof transaction.parseReply === "function"
      ? transaction.parseReply(reply.parsed)
      : null,
  };
}

function withPrivateSocket(connection, fn) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: connection.host,
      port: connection.port,
    });
    let settled = false;
    const connectTimer = setTimeout(() => {
      finish(new Error(`Hikvision private protocol connect timeout after ${connection.connectTimeoutMs}ms`));
    }, connection.connectTimeoutMs);

    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(connectTimer);
      socket.removeAllListeners();
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    socket.once("error", finish);
    socket.once("connect", () => {
      clearTimeout(connectTimer);
      Promise.resolve()
        .then(() => fn(socket))
        .then((value) => finish(null, value))
        .catch(finish);
    });
  });
}

function readPrivateProtocolReply(socket, options = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let expectedBytes = null;
    let settled = false;
    const replyTimeoutMs = normalizeTimeout(options.replyTimeoutMs, DEFAULT_REPLY_TIMEOUT_MS);
    const timer = setTimeout(() => {
      finish(new Error(`Hikvision private protocol reply timeout after ${replyTimeoutMs}ms`));
    }, replyTimeoutMs);

    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", finish);
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    const onData = (chunk) => {
      chunks.push(chunk);
      totalBytes += chunk.length;
      if (totalBytes > MAX_PRIVATE_REPLY_BYTES) {
        finish(new Error(`Hikvision private protocol reply exceeded ${MAX_PRIVATE_REPLY_BYTES} bytes`));
        return;
      }

      const buffered = Buffer.concat(chunks, totalBytes);
      if (expectedBytes === null && buffered.length >= 4) {
        expectedBytes = inferPrivateReplyLength(buffered);
      }
      if (expectedBytes !== null && buffered.length >= expectedBytes) {
        const raw = buffered.subarray(0, expectedBytes);
        finish(null, {
          raw,
          expectedBytes,
          parsed: parsePrivateProtocolWireReply(raw),
        });
      }
    };

    socket.on("data", onData);
    socket.once("error", finish);
  });
}

function inferPrivateReplyLength(buffer) {
  const be = buffer.readUInt32BE(0);
  if (be >= 4 && be <= MAX_PRIVATE_REPLY_BYTES) {
    return be;
  }
  const le = buffer.readUInt32LE(0);
  if (le >= 4 && le <= MAX_PRIVATE_REPLY_BYTES) {
    return le;
  }
  throw new Error(`Invalid Hikvision private protocol reply length: be=${be}, le=${le}`);
}

function parsePrivateProtocolWireReply(raw) {
  const frame = toBuffer(raw, "raw reply");
  const totalLength = inferPrivateReplyLength(frame);
  const marker = frame[4];
  const flags = frame[5];
  const compactHeaderLength = flags & 0x01 ? 0x34 : 0x24;
  const headerLength = frame.length >= compactHeaderLength ? compactHeaderLength : Math.min(frame.length, 4);
  const body = frame.subarray(headerLength, totalLength);

  return {
    totalLength,
    marker,
    flags,
    headerLength,
    command: readU32BE(frame, 0x0c),
    checksum: readU32BE(frame, 0x08),
    version: readU32BE(frame, 0x10),
    protocolVersion: readU32BE(frame, 0x10),
    bodyLength: body.length,
    body,
    wireHeader: frame.subarray(0, headerLength),
  };
}

function readU32BE(buffer, offset) {
  if (buffer.length < offset + 4) {
    return 0;
  }
  return buffer.readUInt32BE(offset) >>> 0;
}

function privateProtocolHost(config, options) {
  const host = String(options.host || config.ip || config.host || config.ipAddress || config.address || "").trim();
  if (!host) {
    throw new Error("Hikvision private protocol host is unavailable.");
  }
  return host;
}

function privateProtocolPort(config, options) {
  const parsed = Number(options.port || config.privatePort || DEFAULT_PRIVATE_PORT);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new RangeError("Hikvision private protocol port must be a valid TCP port");
  }
  return parsed;
}

function normalizeTimeout(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(250, Math.floor(parsed));
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
  throw new TypeError(`${name} must be a Buffer-compatible value`);
}

async function openHikvisionPrivateTalkback(config = {}, options = {}) {
  const host = privateProtocolHost(config, options);
  const port = privateProtocolPort(config, options);
  const username = String(config.username || "");
  const password = String(config.password || "");
  if (!username || !password) {
    throw new Error("Hikvision username and password are required for private talkback");
  }

  const connectTimeoutMs = normalizeTimeout(options.connectTimeoutMs ?? config.privateConnectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
  const replyTimeoutMs = normalizeTimeout(options.replyTimeoutMs ?? config.privateReplyTimeoutMs, DEFAULT_REPLY_TIMEOUT_MS);
  let controlSocket;
  let audioCapabilitiesSocket;
  let voiceSocket;
  try {
    controlSocket = await connectPrivateSocket(host, port, connectTimeoutMs);
    const localAddress = encodePrivateProtocolIpv4Address(controlSocket.localAddress);
    const rsa = crypto.generateKeyPairSync("rsa", {
      modulusLength: 1024,
      publicExponent: 0x10001,
    });
    const publicKey = rsa.publicKey.export({ type: "pkcs1", format: "der" });
    if (publicKey.length !== PRIVATE_RSA_PUBLIC_KEY_DER_BYTES) {
      throw new Error(`Unexpected Hikvision RSA-1024 public key length: ${publicKey.length}`);
    }

    const loginHeader = buildPrivateLoginHandshakeHeader(localAddress, PRIVATE_LOGIN_REQUEST_BYTES);
    const login = Buffer.alloc(PRIVATE_LOGIN_REQUEST_BYTES, 0);
    loginHeader.copy(login, 0);
    writeFixedUtf8(login, username, 36, 48, "username");
    publicKey.copy(login, 84);
    controlSocket.write(login);

    const challengeReply = await readExact(controlSocket, PRIVATE_LOGIN_CHALLENGE_BYTES, replyTimeoutMs);
    const authenticationChallengeReceivedAt = Date.now();
    if (challengeReply.readUInt32BE(0) !== PRIVATE_LOGIN_CHALLENGE_BYTES) {
      throw new Error("Invalid Hikvision private login challenge response");
    }
    const decryptedSessionKeyPayload = crypto.privateDecrypt({
      key: rsa.privateKey,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    }, challengeReply.subarray(16, 144));
    const sessionKeyTerminator = decryptedSessionKeyPayload.indexOf(0);
    const sessionKeyMaterial = decryptedSessionKeyPayload.subarray(
      0,
      sessionKeyTerminator >= 0 ? sessionKeyTerminator : decryptedSessionKeyPayload.length,
    );
    const sessionKeyText = sessionKeyMaterial.toString("ascii");
    if (!/^[a-fA-F0-9]{32}$/.test(sessionKeyText)) {
      throw new Error("Invalid Hikvision private login challenge payload");
    }

    const proof = Buffer.alloc(PRIVATE_LOGIN_PROOF_BYTES, 0);
    buildPrivateLoginHandshakeHeader(localAddress, PRIVATE_LOGIN_PROOF_BYTES).copy(proof, 0);
    crypto.createHmac("md5", sessionKeyText).update(username, "utf8").digest().copy(proof, 36);
    crypto.createHmac("md5", sessionKeyText).update(password, "utf8").digest().copy(proof, 68);
    controlSocket.write(proof);

    const loginReplyFrame = await readPrivateProtocolReply(controlSocket, { replyTimeoutMs });
    const loginReply = loginReplyFrame.raw;
    const deviceUserId = loginReply.readUInt32BE(16);
    const randomSeed = loginReply.readUInt32BE(4);
    const protocolVersion = loginReply.readUInt32BE(12);
    if (loginReply.readUInt32BE(0) !== loginReply.length
      || protocolVersion !== PRIVATE_LOGIN_MARKER
      || !deviceUserId) {
      throw new Error("Hikvision private login was rejected or returned an invalid session");
    }
    controlSocket.destroy();
    controlSocket = null;

    const deviceTimeAtAuthenticationChallenge = challengeReply.readUInt32BE(4);
    const currentAuthenticatedDeviceTime = () => {
      const elapsedAuthenticationSeconds = Math.floor((Date.now() - authenticationChallengeReceivedAt) / 1000);
      return (deviceTimeAtAuthenticationChallenge + elapsedAuthenticationSeconds) >>> 0;
    };
    const sessionEncryptionKey = sessionKeyMaterial.subarray(0, PRIVATE_SESSION_ENCRYPTION_KEY_BYTES);

    audioCapabilitiesSocket = await connectPrivateSocket(host, port, connectTimeoutMs);
    const audioCapabilitiesLocalAddress = encodePrivateProtocolIpv4Address(audioCapabilitiesSocket.localAddress);
    const localMacAddress = resolveLocalMacAddress(audioCapabilitiesSocket.localAddress);
    const audioCapabilitiesChecksum = computePrivateCommandChecksum({
      commandId: PRIVATE_AUDIO_CAPABILITIES_COMMAND_ID,
      deviceUserId,
      randomSeed,
      currentDeviceTime: currentAuthenticatedDeviceTime(),
      localMacAddress,
      sessionEncryptionKey,
    });
    const audioCapabilitiesRequest = buildPrivateAudioCapabilitiesRequest({
      commandChecksum: audioCapabilitiesChecksum,
      localAddress: audioCapabilitiesLocalAddress,
      deviceUserId,
      localMacAddress,
    });
    audioCapabilitiesSocket.setNoDelay(true);
    audioCapabilitiesSocket.write(audioCapabilitiesRequest);
    const audioCapabilitiesReply = await readExact(
      audioCapabilitiesSocket,
      PRIVATE_AUDIO_CAPABILITIES_REPLY_BYTES,
      replyTimeoutMs,
    );
    const capabilityStatus = audioCapabilitiesReply.readUInt32BE(4);
    const capabilityChannelStatus = audioCapabilitiesReply.readUInt32BE(8);
    const capabilityErrorCode = audioCapabilitiesReply.readUInt32BE(12);
    const deviceReportsAudioUnavailable = capabilityStatus === PRIVATE_AUDIO_CAPABILITIES_DEVICE_AUDIO_UNAVAILABLE
      && capabilityChannelStatus === PRIVATE_AUDIO_CAPABILITIES_DEVICE_AUDIO_UNAVAILABLE
      && capabilityErrorCode === 0;
    if (audioCapabilitiesReply.readUInt32BE(0) !== PRIVATE_AUDIO_CAPABILITIES_REPLY_BYTES
      || (!deviceReportsAudioUnavailable
        && (capabilityStatus !== 2 || capabilityChannelStatus !== 1 || capabilityErrorCode !== 0))) {
      throw new Error(`Hikvision private audio capabilities request failed: ${audioCapabilitiesReply.toString("hex")}`);
    }
    if (deviceReportsAudioUnavailable) {
      // DS-KB8112-IM reports the host-audio status here even though its voice
      // channel can still be opened by the following voice setup command.
    }
    audioCapabilitiesSocket.destroy();
    audioCapabilitiesSocket = null;

    voiceSocket = await connectPrivateSocket(host, port, connectTimeoutMs);
    const voiceLocalAddress = encodePrivateProtocolIpv4Address(voiceSocket.localAddress);
    const commandChecksum = computePrivateCommandChecksum({
      commandId: PRIVATE_VOICE_START_COMMAND_ID,
      deviceUserId,
      randomSeed,
      currentDeviceTime: currentAuthenticatedDeviceTime(),
      localMacAddress,
      sessionEncryptionKey,
    });
    const voiceSetupRequest = buildPrivateVoiceSetupRequest({
      commandChecksum,
      voiceLocalAddress,
      deviceUserId,
      localMacAddress,
    });
    voiceSocket.setNoDelay(true);
    voiceSocket.write(voiceSetupRequest);

    const voiceSetupReply = await readExact(voiceSocket, PRIVATE_VOICE_ACK_BYTES, replyTimeoutMs);
    const replyLength = voiceSetupReply.readUInt32BE(0);
    const commandAcceptanceStatus = voiceSetupReply.readUInt32BE(4);
    const voiceChannelReadinessStatus = voiceSetupReply.readUInt32BE(8);
    const voiceSetupErrorCode = voiceSetupReply.readUInt32BE(12);
    if (replyLength !== PRIVATE_VOICE_ACK_BYTES
      || commandAcceptanceStatus !== PRIVATE_VOICE_COMMAND_ACCEPTED
      || voiceChannelReadinessStatus !== PRIVATE_VOICE_CHANNEL_READY
      || voiceSetupErrorCode !== PRIVATE_VOICE_ACK_NO_ERROR) {
      throw new Error(`Hikvision private voice setup returned an invalid acknowledgement: ${voiceSetupReply.toString("hex")}`);
    }

    return { socket: voiceSocket, controlSocket: null, deviceUserId, voiceSetupReply };
  } catch (error) {
    voiceSocket?.destroy();
    audioCapabilitiesSocket?.destroy();
    controlSocket?.destroy();
    throw error;
  }
}

function buildPrivateLoginHandshakeHeader(localAddress, totalLength) {
  const header = Buffer.alloc(36, 0);
  header.writeUInt32BE(totalLength, 0);
  header[4] = 0x5a;
  header.writeUInt32BE(0x00010000, 12);
  header.writeUInt32BE(PRIVATE_LOGIN_MARKER, 16);
  header.writeUInt32BE(1, 20);
  localAddress.copy(header, 24);
  header.writeUInt32BE(0x02000000, 28);
  header.writeUInt32BE(0x0000ef00, 32);
  return header;
}

function buildPrivateVoiceSetupRequest(fields) {
  return buildAuthenticatedPrivateCommandRequest({
    commandId: PRIVATE_VOICE_START_COMMAND_ID,
    commandChecksum: fields.commandChecksum,
    localAddress: fields.voiceLocalAddress,
    deviceUserId: fields.deviceUserId,
    localMacAddress: fields.localMacAddress,
  });
}

function buildPrivateAudioCapabilitiesRequest(fields) {
  const requestBody = Buffer.alloc(32, 0);
  requestBody[0] = PRIVATE_AUDIO_CHANNEL;
  const request = buildAuthenticatedPrivateCommandRequest({
    commandId: PRIVATE_AUDIO_CAPABILITIES_COMMAND_ID,
    commandChecksum: fields.commandChecksum,
    localAddress: fields.localAddress,
    deviceUserId: fields.deviceUserId,
    localMacAddress: fields.localMacAddress,
    body: requestBody,
  });
  if (request.length !== PRIVATE_AUDIO_CAPABILITIES_REQUEST_BYTES) {
    throw new Error(`Unexpected Hikvision private audio capabilities request length: ${request.length}`);
  }
  return request;
}

function buildAuthenticatedPrivateCommandRequest(fields) {
  const body = fields.body || Buffer.alloc(0);
  const request = Buffer.alloc(PRIVATE_VOICE_SETUP_BYTES + body.length, 0);
  request.writeUInt32BE(request.length, 0);
  request[4] = PRIVATE_VOICE_SETUP_MESSAGE_TYPE;
  request.writeUInt32BE(fields.commandChecksum, 8);
  request.writeUInt32BE(fields.commandId, 12);
  fields.localAddress.copy(request, 16);
  request.writeUInt32BE(fields.deviceUserId, 20);
  fields.localMacAddress.copy(request, 24);
  body.copy(request, PRIVATE_VOICE_SETUP_BYTES);
  return request;
}

function encodePrivateProtocolIpv4Address(value) {
  const address = String(value || "").replace(/^::ffff:/, "");
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error(`Hikvision private protocol requires an IPv4 local address, got ${address || "unknown"}`);
  }
  return Buffer.from(parts.reverse());
}

function resolveLocalMacAddress(localIpv4Address) {
  const normalizedAddress = String(localIpv4Address || "").replace(/^::ffff:/, "");
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      const family = typeof address.family === "string" ? address.family : (address.family === 4 ? "IPv4" : "IPv6");
      if (family === "IPv4" && address.address === normalizedAddress) {
        const encoded = String(address.mac || "").replace(/[^a-fA-F0-9]/g, "");
        if (encoded.length === 12 && encoded !== "000000000000") {
          return Buffer.from(encoded, "hex");
        }
      }
    }
  }
  throw new Error(`Unable to resolve the local MAC address for Hikvision private talkback interface ${normalizedAddress || "unknown"}`);
}

function writeFixedUtf8(buffer, value, offset, capacity, name) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > capacity) {
    throw new Error(`Hikvision ${name} exceeds ${capacity} bytes`);
  }
  encoded.copy(buffer, offset);
}

function connectPrivateSocket(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => socket.destroy(new Error(`Hikvision private protocol connect timeout after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function readExact(socket, byteLength, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error(`Hikvision private protocol reply timeout after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= byteLength) {
        if (buffer.length > byteLength) socket.unshift(buffer.subarray(byteLength));
        finish(null, buffer.subarray(0, byteLength));
      }
    };
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error("Hikvision private protocol socket closed before reply completed"));
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error); else resolve(value);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

module.exports = {
  DEFAULT_PRIVATE_PORT,
  sendPrivateProtocolFrame,
  executePrivateLoginTransaction,
  readPrivateProtocolReply,
  parsePrivateProtocolWireReply,
  openHikvisionPrivateTalkback,
};
