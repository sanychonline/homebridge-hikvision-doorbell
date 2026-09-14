"use strict";

const { HikvisionDoorbellPlatform } = require("./platform");

module.exports = (api) => {
  api.registerPlatform("homebridge-hikvision-doorbell", "HikvisionDoorbell", HikvisionDoorbellPlatform);
};
