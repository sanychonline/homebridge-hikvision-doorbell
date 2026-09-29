# Changelog

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
