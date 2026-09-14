'use strict';

const { HikvisionCameraAccessory } = require('./hikvision-camera-accessory');

const PLATFORM_NAME = 'HikvisionDoorbell';
const PLUGIN_NAME = 'homebridge-hikvision-doorbell';

class HikvisionDoorbellPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = new Map();
    this.cameraConfigs = (this.config.cameras || []).map((cameraConfig) => {
      if (!cameraConfig || typeof cameraConfig !== "object") {
        return cameraConfig;
      }
      return {
        ...cameraConfig,
        ip: expandEnv(cameraConfig.ip),
        username: expandEnv(cameraConfig.username),
        password: expandEnv(cameraConfig.password),
        did: expandEnv(cameraConfig.did),
      };
    });

    this.api.on('didFinishLaunching', () => this.discoverDevices());
  }

  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  discoverDevices() {
    for (const cameraConfig of this.cameraConfigs) {
      if (!cameraConfig.did) {
        this.log.warn('Skipping Hikvision camera without did.');
        continue;
      }

      this.configureCameraAccessory(cameraConfig);
      this.unregisterPowerAccessory(cameraConfig);
      this.unregisterLegacyCameraAccessory(cameraConfig);
    }
  }

  configureCameraAccessory(cameraConfig) {
    const uuid = this.api.hap.uuid.generate(`${cameraConfig.did}:camera`);
    const external = cameraConfig.external !== false && cameraConfig.hsv === true;
    const category = cameraConfig.doorbellService === true
      ? this.api.hap.Categories.VIDEO_DOORBELL
      : this.api.hap.Categories.CAMERA;
    let existing = this.accessories.get(uuid);

    if (external) {
      if (existing) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existing]);
        this.accessories.delete(uuid);
      }

      this.log.warn(`Publishing ${cameraConfig.name || cameraConfig.did} as an HSV external camera accessory. Add it to Apple Home separately with the Homebridge PIN.`);

      const accessory = new this.api.platformAccessory(
        cameraConfig.name || `Hikvision Camera ${cameraConfig.did}`,
        uuid,
        category,
      );
      new HikvisionCameraAccessory(this, accessory, cameraConfig);
      this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
      return;
    }

    if (existing && existing.category !== category) {
      existing.category = category;
      existing._associatedHAPAccessory.category = category;
      this.api.updatePlatformAccessories([existing]);
    }

    if (existing) {
      new HikvisionCameraAccessory(this, existing, cameraConfig);
      return;
    }

    const accessory = new this.api.platformAccessory(cameraConfig.name || `Hikvision Camera ${cameraConfig.did}`, uuid, category);
    new HikvisionCameraAccessory(this, accessory, cameraConfig);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
  }

  unregisterPowerAccessory(cameraConfig) {
    const powerUuid = this.api.hap.uuid.generate(`${cameraConfig.did}:power`);
    const power = this.accessories.get(powerUuid);
    if (power) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [power]);
      this.accessories.delete(powerUuid);
    }
  }

  unregisterLegacyCameraAccessory(cameraConfig) {
    const legacyUuid = this.api.hap.uuid.generate(String(cameraConfig.did));
    const legacy = this.accessories.get(legacyUuid);
    if (legacy) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [legacy]);
      this.accessories.delete(legacyUuid);
    }
  }
}

function expandEnv(value) {
  if (!value || typeof value !== 'string') {
    return value;
  }
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] || '');
}

module.exports = {
  HikvisionDoorbellPlatform,
  PLATFORM_NAME,
  PLUGIN_NAME,
};
