'use strict';

const UINT32_MODULUS = 0x1_0000_0000;

function toUint32(value) {
  return Number(value) >>> 0;
}

class PrivateSessionSecurityContext {
  constructor({
    deviceProtocolVersion,
    deviceUserId,
    deviceTimeAtLogin,
    randomSeed,
    challengeBytes,
    localMonotonicTimeAtLogin = performance.now(),
  }) {
    if (!Buffer.isBuffer(challengeBytes) || challengeBytes.length !== 64) {
      throw new TypeError('challengeBytes must be a 64-byte Buffer');
    }

    this.deviceProtocolVersion = toUint32(deviceProtocolVersion);
    this.deviceUserId = toUint32(deviceUserId);
    this.deviceTimeAtLogin = toUint32(deviceTimeAtLogin);
    this.randomSeed = toUint32(randomSeed);
    this.challengeBytes = Buffer.from(challengeBytes);
    this.localMonotonicTimeAtLogin = Number(localMonotonicTimeAtLogin);
  }

  currentDeviceTime(localMonotonicTime = performance.now()) {
    const elapsedMilliseconds = Math.max(
      0,
      Math.floor(Number(localMonotonicTime) - this.localMonotonicTimeAtLogin),
    );

    return (this.deviceTimeAtLogin + elapsedMilliseconds) % UINT32_MODULUS;
  }

  sessionEncryptionKey() {
    return Buffer.from(this.challengeBytes.subarray(0, 16));
  }
}

module.exports = {
  PrivateSessionSecurityContext,
};
