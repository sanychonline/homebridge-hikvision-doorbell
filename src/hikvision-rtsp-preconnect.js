"use strict";

const net = require("net");

const PRECONNECT_TIMEOUT_MS = 5000;
const sockets = new Map();

function rtspTarget(config) {
  const candidates = [
    config.rtspUrl,
    config.mainStreamUrl,
    config.streamUrl,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.startsWith("rtsp://")) {
      continue;
    }
    try {
      const parsed = new URL(candidate);
      return {
        host: parsed.hostname,
        port: Number(parsed.port || 554),
      };
    } catch (_error) {
      // Fall through to the explicit camera host below.
    }
  }

  const host = config.host || config.ip || config.ipAddress || config.address;
  if (!host) {
    return null;
  }
  return {
    host,
    port: Number(config.rtspPort || 554),
  };
}

function preconnectRtsp(config, log, sessionID) {
  if (config.preconnectOnPrepareStream === false) {
    return;
  }

  const target = rtspTarget(config);
  if (!target || !Number.isFinite(target.port)) {
    log.debug?.(`RTSP preconnect skipped: no valid target for session ${sessionID}`);
    return;
  }

  closePreconnect(sessionID);

  const socket = net.createConnection(target);
  const entry = { socket, timer: null };
  sockets.set(sessionID, entry);
  socket.unref();
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 1000);

  const close = () => {
    if (sockets.get(sessionID) !== entry) {
      return;
    }
    sockets.delete(sessionID);
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    socket.destroy();
  };

  entry.timer = setTimeout(close, PRECONNECT_TIMEOUT_MS);
  entry.timer.unref?.();

  socket.once("connect", () => {
    log.info(`RTSP preconnect ready for session ${sessionID}: target=${target.host}:${target.port}`);
  });
  socket.once("error", (error) => {
    log.warn(`RTSP preconnect failed for session ${sessionID}: ${error.message}`);
    close();
  });
  socket.once("close", close);
}

function closePreconnect(sessionID) {
  const entry = sockets.get(sessionID);
  if (!entry) {
    return;
  }
  sockets.delete(sessionID);
  if (entry.timer) {
    clearTimeout(entry.timer);
  }
  entry.socket.destroy();
}

module.exports = {
  preconnectRtsp,
  closePreconnect,
};
