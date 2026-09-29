# homebridge-hikvision-doorbell

Homebridge video doorbell plugin for the Hikvision DS-KB8112-IM outdoor door station.

## Current status: 0.1.10

The verified local implementation provides:

- HomeKit live video from Hikvision RTSP channel `101`.
- Camera microphone audio in live view.
- SDK-free two-way audio through the Hikvision private voice protocol.
- Still images extracted from the shared channel `101` stream.
- HomeKit Secure Video recording with video and audio.
- Motion analysis from the technical/sub stream `102`.
- One shared physical RTSP upstream for live view, snapshots, and HSV consumers.
- Internal motion and recording handling without a separate published Motion Sensor tile.

The physical doorbell button is **not implemented**. The DS-KB8112-IM reference
firmware does not expose a reliable local button event, so the HomeKit Doorbell
service cannot currently be triggered automatically by pressing CALL.

Verified reference device:

- Model: `DS-KB8112-IM`.
- Firmware: `V1.4.5 build 170921`.
- Deployment: Homebridge in Docker on Synology.

The plugin is local. It does not require a cloud account for live video, snapshots,
audio, motion detection, or HSV recording.

## Requirements

- Homebridge with Node.js 18 or newer.
- `ffmpeg` available in the Homebridge environment.
- Hikvision DS-KB8112-IM reachable over the local network.
- RTSP enabled on the door station.
- A HomeKit hub and an iCloud plan that supports HomeKit Secure Video.

## Installation from npm

Install the published package in the same environment where Homebridge runs:

```bash
npm install -g homebridge-hikvision-doorbell@0.1.10
```

For the official Homebridge Docker image, install into the persistent `/homebridge`
directory and restart the container:

```bash
docker exec homebridge npm install --prefix /homebridge --save homebridge-hikvision-doorbell@0.1.10
docker restart homebridge
```

Do not copy this repository into a local-plugin directory. The plugin is intended
to be loaded from npm.

## Recommended configuration

Use the Homebridge UI where possible. The minimal configuration is:

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
      "talkbackTransport": "private",
      "doorbellService": true,
      "hsv": true
    }
  ]
}
```

Do not put real passwords, verification codes, tokens, or private device URLs in
the repository, screenshots, issues, or example files.

## Media paths

The plugin uses the Hikvision streams as follows:

- Channel `101`: shared main stream for live view, snapshots, and HKSV recording.
- Channel `102`: technical/sub stream for local motion analysis only.

The technical stream is never used as the HSV recording source. The shared relay
prevents each HomeKit client from opening another physical main-stream connection
to the door station.

If `rtspUrl` is omitted, the plugin builds the main-stream URL from the device
credentials:

```text
rtsp://<username>:<password>@<ip>:554/Streaming/Channels/101
```

## Still images

Snapshots are captured from the shared RTSP `101` relay with FFmpeg. This avoids
a second camera connection and avoids the unreliable ISAPI JPEG endpoint on this
device. Snapshot capture is independent from the HKSV recording path.

## Motion and HomeKit Secure Video

The DS-KB8112-IM firmware does not expose a reliable local motion event stream.
The plugin decodes channel `102` at low resolution and performs local frame-
difference analysis across the image, excluding only the changing clock overlay
in the upper-left corner.

When motion is detected:

1. The internal camera state changes to motion/recording.
2. HomeKit receives the motion event without a separate published Motion Sensor.
3. HKSV opens a dedicated continuous recording session from channel `101`.
4. The recording continues through the configured motion/post-motion window.

The rolling prebuffer is separate from the live recording transport. A recording
never reuses the prebuffer process as its live stream; this prevents cached MP4
fragments from being delivered in a burst and then stopping.

The HomeKit Doorbell service is published for the accessory, but physical CALL
button events are not currently available to trigger it automatically.

## Two-way audio

The DS-KB8112-IM speaker uplink is not part of RTSP. Set:

```json
{
  "twoWayAudio": true,
  "talkbackTransport": "private",
  "privatePort": 8000
}
```

The plugin performs the Hikvision private login and voice setup directly using the
configured device address and credentials. HCNetSDK, SDK binaries, captured keys,
and external material files are not required or bundled.

Runtime stop logs distinguish the pipeline stages:

```text
decodedBytes=<n> privateMediaFramesSent=<n> privateMediaBytesSent=<n>
```

Non-zero values prove transport delivery to the device. Audible sound at the
door station remains the final physical acceptance check.

## Doorbell button limitation

The physical CALL button is the only unresolved core feature in `0.1.10`. The
reference firmware was tested with local event interfaces, but it did not provide
a reliable local button event. The plugin therefore does not claim automatic
Doorbell notifications from a physical button press.

## Security and package contents

- Keep Homebridge configuration and credentials outside git.
- Keep SDK downloads and reverse-engineering captures outside this repository.
- HCNetSDK binaries and SDK wrapper scripts are not included in the npm package.
- `npm pack` runs a safety check that rejects SDK binaries and wrapper artifacts.
- Runtime state, captures, logs, pcap files, tarballs, and research material are excluded by `.gitignore`.

## Troubleshooting

If live view fails:

- Confirm the door station answers RTSP on port `554`.
- Confirm `ffmpeg` is installed inside the Homebridge container.
- Confirm the device account can read RTSP.
- Confirm Homebridge is not running an old local-plugin copy.

If HSV does not create a recording:

- Confirm the camera is set to `Stream & Allow Recording` in Apple Home.
- Confirm the HomeKit hub and iCloud HSV plan are available.
- Look for `motion.analysis.triggered` in the Homebridge log.
- Look for `Hikvision HKSV RTSP recording requested` and subsequent fragments.
- A healthy fragment reports `hasVideo=true`, `hasAudio=true`, and non-zero media bytes.

If two-way audio fails:

- Confirm `twoWayAudio` is `true` and `talkbackTransport` is `private`.
- Confirm TCP port `8000` is reachable from Homebridge.
- Check `decodedBytes`, `privateMediaFramesSent`, and `privateMediaBytesSent` in the stop log.
- Do not enable HCNetSDK or add SDK binaries to the plugin installation.

## Development

The repository contains small SDK-free protocol probes for controlled local
diagnostics. They use private config files and must not be run with credentials
committed to git:

```bash
npm run probe:hikvision-private-login -- --config /private/path/to/private-login.json
npm run probe:hikvision-private-audio-start -- --config /private/path/to/private-audio-start.json
npm run probe:hikvision-private-voice-media -- --config /private/path/to/private-voice-media.json
```

Run the package safety check before publishing:

```bash
npm run prepack
```
