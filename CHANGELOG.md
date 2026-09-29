# Changelog

## 0.1.8 - 2026-09-29

- Document the verified local DS-KB8112-IM feature set.
- Use channel `101` as the shared source for live view, snapshots, and HSV recording.
- Use channel `102` only for internal motion analysis.
- Keep HSV recording sessions independent from the rolling prebuffer so recordings receive a continuous stream.
- Keep HSV video and audio enabled for the verified recording path.
- Keep SDK-free private talkback as the supported speaker transport.
- Remove unsupported cloud call polling and answer-command code.
- Exclude research captures, logs, tarballs, and temporary diagnostics from git and npm publication.

## 0.1.7 and earlier

See git history for development changes and experimental protocol work. Those
experiments are not part of the supported feature claims for `0.1.8`.
