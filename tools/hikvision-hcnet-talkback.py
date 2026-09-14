#!/usr/bin/env python3
"""Send 8 kHz mono signed 16-bit PCM from stdin to Hikvision HCNetSDK voice talk."""

import argparse
import ctypes
import os
import signal
import sys
import time
import warnings

warnings.filterwarnings("ignore", category=DeprecationWarning)
import audioop  # noqa: E402  Python 3.12 runtime provides the required G.711 codec.


def required_env(name):
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"missing-env:{name}")
    return value


def configure_sdk(sdk):
    long_t = ctypes.c_int32
    dword_t = ctypes.c_uint32
    bool_t = ctypes.c_int32
    voice_callback_t = ctypes.CFUNCTYPE(None, long_t, ctypes.c_void_p, dword_t, ctypes.c_ubyte, ctypes.c_void_p)

    sdk.NET_DVR_Init.argtypes = []
    sdk.NET_DVR_Init.restype = bool_t
    sdk.NET_DVR_Cleanup.argtypes = []
    sdk.NET_DVR_Cleanup.restype = bool_t
    sdk.NET_DVR_GetLastError.argtypes = []
    sdk.NET_DVR_GetLastError.restype = dword_t
    sdk.NET_DVR_SetConnectTime.argtypes = [dword_t, dword_t]
    sdk.NET_DVR_SetConnectTime.restype = bool_t
    sdk.NET_DVR_SetReconnect.argtypes = [dword_t, bool_t]
    sdk.NET_DVR_SetReconnect.restype = bool_t
    sdk.NET_DVR_Login_V30.argtypes = [ctypes.c_char_p, ctypes.c_ushort, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p]
    sdk.NET_DVR_Login_V30.restype = long_t
    sdk.NET_DVR_Logout.argtypes = [long_t]
    sdk.NET_DVR_Logout.restype = bool_t
    sdk.NET_DVR_StartVoiceCom_MR_V30.argtypes = [long_t, dword_t, voice_callback_t, ctypes.c_void_p]
    sdk.NET_DVR_StartVoiceCom_MR_V30.restype = long_t
    sdk.NET_DVR_VoiceComSendData.argtypes = [long_t, ctypes.c_void_p, dword_t]
    sdk.NET_DVR_VoiceComSendData.restype = bool_t
    sdk.NET_DVR_StopVoiceCom.argtypes = [long_t]
    sdk.NET_DVR_StopVoiceCom.restype = bool_t
    return voice_callback_t


def main():
    parser = argparse.ArgumentParser(description="Hikvision HCNetSDK talkback sink")
    parser.add_argument("--sdk-library", required=True)
    parser.add_argument("--voice-channel", type=int, default=1)
    args = parser.parse_args()

    host = required_env("HIKVISION_TALKBACK_HOST")
    username = required_env("HIKVISION_TALKBACK_USERNAME")
    password = required_env("HIKVISION_TALKBACK_PASSWORD")
    port = int(os.environ.get("HIKVISION_TALKBACK_PORT", "8000"))

    sdk = ctypes.CDLL(args.sdk_library)
    voice_callback_t = configure_sdk(sdk)
    if not sdk.NET_DVR_Init():
        raise RuntimeError(f"sdk-init-failed:{int(sdk.NET_DVR_GetLastError())}")

    sdk.NET_DVR_SetConnectTime(3000, 1)
    sdk.NET_DVR_SetReconnect(5000, 1)

    running = True
    user_id = -1
    voice_handle = -1

    def stop_handler(_signum, _frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop_handler)
    signal.signal(signal.SIGINT, stop_handler)

    @voice_callback_t
    def voice_callback(_voice_handle, _data, _size, _audio_flag, _user):
        return

    try:
        device_info = ctypes.create_string_buffer(512)
        user_id = int(sdk.NET_DVR_Login_V30(
            host.encode("utf-8"),
            port,
            username.encode("utf-8"),
            password.encode("utf-8"),
            ctypes.byref(device_info),
        ))
        if user_id < 0:
            raise RuntimeError(f"login-failed:{int(sdk.NET_DVR_GetLastError())}")

        voice_handle = int(sdk.NET_DVR_StartVoiceCom_MR_V30(user_id, args.voice_channel, voice_callback, None))
        if voice_handle < 0:
            raise RuntimeError(f"voice-start-failed:{int(sdk.NET_DVR_GetLastError())}")

        pcm_buffer = bytearray()
        next_frame_at = time.monotonic()
        consecutive_failures = 0
        while running:
            chunk = sys.stdin.buffer.read(4096)
            if not chunk:
                break
            pcm_buffer.extend(chunk)

            while running and len(pcm_buffer) >= 320:
                pcm_frame = audioop.mul(bytes(pcm_buffer[:320]), 2, 1.4125)
                del pcm_buffer[:320]
                ulaw_frame = audioop.lin2ulaw(pcm_frame, 2)
                send_buffer = ctypes.create_string_buffer(ulaw_frame, len(ulaw_frame))

                now = time.monotonic()
                if next_frame_at > now:
                    time.sleep(next_frame_at - now)
                if sdk.NET_DVR_VoiceComSendData(voice_handle, send_buffer, len(ulaw_frame)):
                    consecutive_failures = 0
                else:
                    consecutive_failures += 1
                    if consecutive_failures >= 5:
                        raise RuntimeError(f"voice-send-failed:{int(sdk.NET_DVR_GetLastError())}")
                next_frame_at = max(next_frame_at + 0.020, time.monotonic())
        return 0
    finally:
        if voice_handle >= 0:
            sdk.NET_DVR_StopVoiceCom(voice_handle)
        if user_id >= 0:
            sdk.NET_DVR_Logout(user_id)
        sdk.NET_DVR_Cleanup()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"hcnet-talkback:{error}", file=sys.stderr, flush=True)
        raise SystemExit(1)
