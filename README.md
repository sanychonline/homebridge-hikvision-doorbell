# homebridge-hikvision-doorbell

Homebridge video doorbell plugin for Hikvision DS-KB8112-IM style door stations.

The plugin is designed around a practical local setup:

- RTSP video and camera microphone audio are used for HomeKit live view and HomeKit Secure Video.
- Hik-Connect polling can detect an incoming doorbell call and trigger a real HomeKit Doorbell notification.
- Hikvision HCNetSDK can provide HomeKit Talk/two-way audio to the door station speaker.
- HCNetSDK binaries, Homebridge config, verification codes, and credentials must stay outside the repository.

## Status

Version `0.1.0` is an early plugin release. The core flow is implemented, but Hikvision devices and firmware vary a lot, so treat this as hardware-specific until you verify it with your own installation.

Known working in the reference setup:

- RTSP live video from `/Streaming/Channels/101`
- Camera microphone audio in HomeKit live view
- HomeKit Secure Video recording
- HCNetSDK two-way audio/talkback
- Hik-Connect call-state polling for HomeKit Doorbell notifications

Known limitation:

- Sending a Hik-Connect command to stop/answer the original indoor-panel ring is still experimental and disabled from the recommended config.

## Requirements

- Homebridge with Node.js 18 or newer
- `ffmpeg` available to Homebridge
- A Hikvision door station reachable from the Homebridge host
- RTSP enabled on the door station
- Optional: Hik-Connect account with the indoor panel added, if you want doorbell button notifications
- Optional: Hikvision Linux HCNetSDK runtime installed on the Homebridge host/container, if you want two-way audio

## Recommended Homebridge config

Use Homebridge UI where possible. A minimal JSON configuration looks like this:

```json
{
  "platform": "HikvisionDoorbell",
  "name": "Hikvision DS-KB8112-IM",
  "cameras": [
    {
      "name": "Doorbell",
      "did": "hikvision-ds-kb8112im",
      "model": "DS-KB8112-IM",
      "ip": "192.168.1.50",
      "username": "admin",
      "password": "your-device-password",
      "audio": true,
      "twoWayAudio": true,
      "doorbellService": true,
      "motionSensor": true,
      "hsv": true,
      "nativeEvents": true,
      "hikConnectDoorbell": true,
      "hikConnectUsername": "your-hik-connect-account",
      "hikConnectPassword": "your-hik-connect-password",
      "indoorStationSerial": "your-indoor-panel-serial",
      "talkbackTransport": "hcnet-sdk",
      "hcnetSdkLibrary": "/homebridge/hikvision-hcnet-sdk/lib/libhcnetsdk.so"
    }
  ]
}
```

Do not put real passwords in screenshots, issues, commits, or example files.

## RTSP

If `rtspUrl` is not set, the plugin builds the standard Hikvision main-stream URL from `ip`, `username`, and `password`:

```text
rtsp://<username>:<password>@<ip>:554/Streaming/Channels/101
```

You can still provide `rtspUrl` as an advanced override for non-standard stream paths, but the recommended config avoids duplicating the camera password.

## Doorbell button notifications

Enable:

```json
{
  "doorbellService": true,
  "hikConnectDoorbell": true,
  "hikConnectUsername": "your-hik-connect-account",
  "hikConnectPassword": "your-hik-connect-password",
  "indoorStationSerial": "your-indoor-panel-serial"
}
```

The plugin polls Hik-Connect call status for the indoor panel. A fresh `idle` to `ringing` transition triggers the HomeKit Doorbell service.

This is currently the most reliable path found for DS-KB8112-IM button events when local HCNetSDK alarm callbacks do not expose the CALL button.

## Two-way audio

Enable:

```json
{
  "twoWayAudio": true,
  "talkbackTransport": "hcnet-sdk",
  "hcnetSdkLibrary": "/homebridge/hikvision-hcnet-sdk/lib/libhcnetsdk.so"
}
```

Install Hikvision HCNetSDK separately on the Homebridge host or inside the Homebridge container. Do not commit SDK archives, extracted libraries, or vendor binaries to this repository.

For Docker, the SDK path must be visible inside the container. The runtime usually also needs its companion `HCNetSDKCom` directory on `LD_LIBRARY_PATH`.

## HomeKit Secure Video

Enable:

```json
{
  "hsv": true,
  "motionSensor": true
}
```

When HSV is enabled, Homebridge may publish the doorbell as an external camera accessory. Add it to Apple Home separately with the Homebridge PIN and set recording options in the Apple Home app.

## Security notes

- Keep Homebridge config private.
- Keep Hik-Connect and device passwords out of git.
- Keep HCNetSDK binaries out of git.
- Use a stable `did` value, but it does not need to be a real Hikvision serial number.
- Session caches are runtime state and should not be committed.

## Troubleshooting

If live view fails:

- Confirm RTSP works from the Homebridge host/container.
- Confirm `ffmpeg` is installed.
- Check that the door station user has RTSP permission.

If doorbell notifications do not appear:

- Confirm the indoor panel receives the call.
- Confirm the indoor panel appears in Hik-Connect.
- Confirm `indoorStationSerial` is the indoor panel serial, not the outdoor station serial.
- Watch Homebridge logs for `hikconnect.call-state`.

If two-way audio does not work:

- Confirm HCNetSDK is installed where `hcnetSdkLibrary` points.
- Confirm the companion SDK libraries are in the runtime library path.
- Confirm the device account can open a voice/talk channel.

## Development

Useful diagnostics:

```bash
npm run probe:hikvision-events
npm run probe:hikvision-talkback
npm run probe:hikconnect-call -- --config /private/path/to/hikconnect.json --once
```

Diagnostics must not print passwords, session tokens, verification codes, or full authenticated stream URLs.
