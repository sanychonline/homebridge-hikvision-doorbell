"use strict";

const SBOX = Buffer.from(
  "637c777bf26b6fc53001672bfed7ab76" +
  "ca82c97dfa5947f0add4a2af9ca472c0" +
  "b7fd9326363ff7cc34a5e5f171d83115" +
  "04c723c31896059a071280e2eb27b275" +
  "09832c1a1b6e5aa0523bd6b329e32f84" +
  "53d100ed20fcb15b6acbbe394a4c58cf" +
  "d0efaafb434d338545f9027f503c9fa8" +
  "51a3408f929d38f5bcb6da2110fff3d2" +
  "cd0c13ec5f974417c4a77e3d645d1973" +
  "60814fdc222a908846eeb814de5e0bdb" +
  "e0323a0a4906245cc2d3ac629195e479" +
  "e7c8376d8dd54ea96c56f4ea657aae08" +
  "ba78252e1ca6b4c6e8dd741f4bbd8b8a" +
  "703eb5664803f60e613557b986c11d9e" +
  "e1f8981169d98e949b1e87e9ce5528df" +
  "8ca1890dbfe6426841992d0fb054bb16",
  "hex",
);

function computePrivateCommandChecksum(fields) {
  if (!fields || typeof fields !== "object") {
    throw new TypeError("Session descriptor fields are required");
  }
  const deviceUserId = uint32(fields.deviceUserId, "deviceUserId");
  const randomSeed = uint32(fields.randomSeed, "randomSeed");
  const commandId = uint32(fields.commandId, "commandId");
  const currentDeviceTime = uint32(fields.currentDeviceTime, "currentDeviceTime");
  const localMacAddress = fixedBuffer(fields.localMacAddress, 6, "localMacAddress");
  const sessionEncryptionKey = fixedBuffer(fields.sessionEncryptionKey, 16, "sessionEncryptionKey");

  let checksumSeed = (randomSeed + 2 * commandId) >>> 0;
  for (let index = 0; index < 6; index += 1) {
    checksumSeed = (checksumSeed + (localMacAddress[index] & (deviceUserId >>> (5 * index)))) >>> 0;
  }

  const block = Buffer.alloc(16);
  let encryptedChecksumBlock = null;
  try {
    block.writeUInt32LE(checksumSeed, 0);
    encryptedChecksumBlock = encryptFourRounds(block, sessionEncryptionKey);
    const folded = encryptedChecksumBlock.readUInt32LE(0) ^ encryptedChecksumBlock.readUInt32LE(4)
      ^ encryptedChecksumBlock.readUInt32LE(8) ^ encryptedChecksumBlock.readUInt32LE(12);
    return ((folded >>> 0) + currentDeviceTime) >>> 0;
  } finally {
    block.fill(0);
    encryptedChecksumBlock?.fill(0);
  }
}

function encryptFourRounds(block, key) {
  const expanded = expandFourRoundKey(key);
  const state = Buffer.from(block);
  const shifted = Buffer.alloc(16);
  try {
    for (let index = 0; index < 16; index += 1) {
      state[index] ^= expanded[index];
    }
    for (let round = 1; round <= 4; round += 1) {
      for (let column = 0; column < 4; column += 1) {
        for (let row = 0; row < 4; row += 1) {
          shifted[4 * column + row] = SBOX[state[4 * ((column + row) % 4) + row]];
        }
      }
      shifted.copy(state);
      if (round < 4) {
        for (let offset = 0; offset < 16; offset += 4) {
          const a = state[offset];
          const b = state[offset + 1];
          const c = state[offset + 2];
          const d = state[offset + 3];
          const sum = a ^ b ^ c ^ d;
          state[offset] = a ^ sum ^ xtime(a ^ b);
          state[offset + 1] = b ^ sum ^ xtime(b ^ c);
          state[offset + 2] = c ^ sum ^ xtime(c ^ d);
          state[offset + 3] = d ^ sum ^ xtime(d ^ a);
        }
      }
      for (let index = 0; index < 16; index += 1) {
        state[index] ^= expanded[16 * round + index];
      }
    }
    return Buffer.from(state);
  } finally {
    expanded.fill(0);
    state.fill(0);
    shifted.fill(0);
  }
}

function expandFourRoundKey(key) {
  const expanded = Buffer.alloc(80);
  key.copy(expanded);
  let rcon = 1;
  for (let offset = 16; offset < expanded.length; offset += 4) {
    let a = expanded[offset - 4];
    let b = expanded[offset - 3];
    let c = expanded[offset - 2];
    let d = expanded[offset - 1];
    if (offset % 16 === 0) {
      const first = a;
      a = SBOX[b] ^ rcon;
      b = SBOX[c];
      c = SBOX[d];
      d = SBOX[first];
      rcon = xtime(rcon);
    }
    expanded[offset] = expanded[offset - 16] ^ a;
    expanded[offset + 1] = expanded[offset - 15] ^ b;
    expanded[offset + 2] = expanded[offset - 14] ^ c;
    expanded[offset + 3] = expanded[offset - 13] ^ d;
  }
  return expanded;
}

function xtime(value) {
  return ((value << 1) ^ ((value & 0x80) ? 0x1b : 0)) & 0xff;
}

function uint32(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer`);
  }
  return parsed >>> 0;
}

function fixedBuffer(value, length, name) {
  if (!Buffer.isBuffer(value) || value.length !== length) {
    throw new TypeError(`${name} must be a ${length}-byte Buffer`);
  }
  return value;
}

module.exports = {
  computePrivateCommandChecksum,
};
