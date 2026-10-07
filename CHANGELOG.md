# Changelog

## 0.1.13 - 2026-10-07

- Reap timed-out shared snapshot `ffmpeg` processes with a graceful shutdown and hard-kill deadline.
- Destroy snapshot pipes and shared RTSP input during every completion path.
- Prevent orphan snapshot processes from blocking live video, HSV, and talkback sessions.

## 0.1.12 - 2026-10-03

- Use H.264 passthrough from RTSP channel `101` for HSV instead of software `libx264` video encoding.
- Keep audio transcoding to the HomeKit-compatible recording codec.
- Document the measured low-load runtime profile after the passthrough change.

## 0.1.11 - 2026-10-03

- Limit default concurrent HomeKit live `ffmpeg` sessions to two.
- Force-stop stalled stream, recording, shared relay, and motion-analysis processes after graceful shutdown timeouts.
- Destroy recording pipes and shared RTSP consumers during cleanup to prevent orphaned processes and memory growth.
- Document the process lifecycle protections and current release version.

## 0.1.10 - 2026-09-29

- Publish the verified npm release used by the Synology deployment.
- Document the current supported local video, audio, HSV, and motion behavior.
- Keep the physical doorbell CALL button explicitly documented as unsupported.

## 0.1.9 - 2026-09-29

- Document the verified local DS-KB8112-IM feature set.
- Use channel `101` as the shared source for live view, snapshots, and HSV recording.
- Use channel `102` only for internal motion analysis.
- Keep HSV recording sessions independent from the rolling prebuffer so recordings receive a continuous stream.
- Keep HSV video and audio enabled for the verified recording path.
- Keep SDK-free private talkback as the supported speaker transport.
- Remove unsupported cloud call polling and answer-command code.
- Exclude research captures, logs, tarballs, and temporary diagnostics from git and npm publication.
