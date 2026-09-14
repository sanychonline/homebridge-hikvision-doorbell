#!/usr/bin/env python3
"""HCNetSDK alarm bridge for Hikvision video intercom devices.

The helper keeps secrets in environment/config, emits JSON Lines for the Node
supervisor, and forwards documented motion alarms to the protected loopback API.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import queue
import signal
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

COMM_ALARM = 0x1100
COMM_ALARM_BUTTON_DOWN_EXCEPTION = 0x1152
COMM_ALARM_V30 = 0x4000
COMM_ALARM_V40 = 0x4007
MOTION_ALARM_TYPE = 3

EVENT_QUEUE: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=256)
STOP_EVENT = threading.Event()


class NET_DVR_SETUPALARM_PARAM(ctypes.Structure):
    _fields_ = [
        ("dwSize", ctypes.c_uint32),
        ("byLevel", ctypes.c_ubyte),
        ("byAlarmInfoType", ctypes.c_ubyte),
        ("byRetAlarmTypeV40", ctypes.c_ubyte),
        ("byRetDevInfoVersion", ctypes.c_ubyte),
        ("byRetVQDAlarmType", ctypes.c_ubyte),
        ("byFaceAlarmDetection", ctypes.c_ubyte),
        ("bySupport", ctypes.c_ubyte),
        ("byBrokenNetHttp", ctypes.c_ubyte),
        ("wTaskNo", ctypes.c_uint16),
        ("byDeployType", ctypes.c_ubyte),
        ("byRes1", ctypes.c_ubyte * 3),
        ("byAlarmTypeURL", ctypes.c_ubyte),
        ("byCustomCtrl", ctypes.c_ubyte),
    ]


def emit(event_type: str, **fields: Any) -> None:
    payload = {"type": event_type, "timestamp": int(time.time() * 1000), **fields}
    print(json.dumps(payload, separators=(",", ":"), ensure_ascii=True), flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Hikvision HCNetSDK native alarm listener")
    parser.add_argument("--sdk-library", default=os.getenv("HIKVISION_HCNET_SDK_LIBRARY", "/homebridge/hikvision-hcnet-sdk/lib/libhcnetsdk.so"))
    parser.add_argument("--component-path", default=os.getenv("HIKVISION_HCNET_SDK_COMPONENT_PATH", ""))
    parser.add_argument("--host", default=os.getenv("HIKVISION_HOST", ""))
    parser.add_argument("--port", type=int, default=int(os.getenv("HIKVISION_PORT", os.getenv("HIKVISION_HCNET_PORT", "8000"))))
    parser.add_argument("--username", default=os.getenv("HIKVISION_USERNAME", "admin"))
    parser.add_argument("--doorbell-debounce-ms", type=int, default=int(os.getenv("HIKVISION_DOORBELL_DEBOUNCE_MS", "2000")))
    parser.add_argument("--motion-hold-ms", type=int, default=int(os.getenv("HIKVISION_MOTION_HOLD_MS", "15000")))
    parser.add_argument("--motion-debounce-ms", type=int, default=int(os.getenv("HIKVISION_MOTION_DEBOUNCE_MS", "1000")))
    parser.add_argument("--dump-events", "--dump-raw", action="store_true", default=os.getenv("HIKVISION_DUMP_NATIVE_EVENTS", "").lower() in {"1", "true", "yes"})
    args, _unknown = parser.parse_known_args()
    return args


def get_last_error(sdk: ctypes.CDLL) -> int:
    try:
        sdk.NET_DVR_GetLastError.restype = ctypes.c_uint32
        return int(sdk.NET_DVR_GetLastError())
    except Exception:
        return -1


def load_local_api_settings(host: str) -> tuple[str | None, int]:
    token = os.getenv("HIKVISION_LOCAL_HTTP_TOKEN")
    port = int(os.getenv("HIKVISION_LOCAL_HTTP_PORT", "8782"))
    if token:
        return token, port

    config_path = Path(os.getenv("HIKVISION_HOMEBRIDGE_CONFIG", "/homebridge/config.json"))
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        platform = next(
            item for item in config.get("platforms", [])
            if item.get("platform") == "HikvisionDoorbell"
        )
        cameras = platform.get("cameras") or []
        camera = next(
            (item for item in cameras if str(item.get("ip") or item.get("host") or "") == host),
            cameras[0] if cameras else {},
        )
        token = camera.get("localHttpToken") or platform.get("localHttpToken")
        port = int(camera.get("localHttpPort") or platform.get("localHttpPort") or port)
    except Exception as error:
        emit("diagnostic", component="local-http-config", ok=False, error=str(error))
        return None, port

    return str(token) if token else None, port


def forward_motion(token: str | None, port: int, duration_ms: int, command: int) -> None:
    if not token:
        emit("motion-forward", ok=False, error="local-http-token-unavailable")
        return

    body = json.dumps({
        "source": "hikvision-hcnet-sdk",
        "durationMs": duration_ms,
        "alarmCommand": f"0x{command:04x}",
        "alarmType": MOTION_ALARM_TYPE,
    }).encode("utf-8")
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/v1/motion?durationMs={duration_ms}",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            response.read(4096)
            emit("motion-forward", ok=200 <= response.status < 300, status=response.status)
    except urllib.error.HTTPError as error:
        emit("motion-forward", ok=False, status=error.code, error="http-error")
    except Exception as error:
        emit("motion-forward", ok=False, error=type(error).__name__)


def enqueue_event(event: dict[str, Any]) -> None:
    try:
        EVENT_QUEUE.put_nowait(event)
    except queue.Full:
        emit("diagnostic", component="alarm-queue", ok=False, error="queue-full")


def configure_sdk(sdk: ctypes.CDLL, component_path: str) -> None:
    if component_path and hasattr(sdk, "NET_DVR_SetSDKInitCfg"):
        encoded = os.fsencode(component_path)
        component_buffer = ctypes.create_string_buffer(encoded + b"\0")
        sdk.NET_DVR_SetSDKInitCfg.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
        sdk.NET_DVR_SetSDKInitCfg.restype = ctypes.c_bool
        sdk.NET_DVR_SetSDKInitCfg(2, ctypes.cast(component_buffer, ctypes.c_void_p))

    sdk.NET_DVR_Init.argtypes = []
    sdk.NET_DVR_Init.restype = ctypes.c_bool
    if not sdk.NET_DVR_Init():
        raise RuntimeError(f"NET_DVR_Init failed error={get_last_error(sdk)}")

    sdk.NET_DVR_SetConnectTime.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
    sdk.NET_DVR_SetConnectTime.restype = ctypes.c_bool
    sdk.NET_DVR_SetConnectTime(3000, 1)
    sdk.NET_DVR_SetReconnect.argtypes = [ctypes.c_uint32, ctypes.c_bool]
    sdk.NET_DVR_SetReconnect.restype = ctypes.c_bool
    sdk.NET_DVR_SetReconnect(10000, True)


def main() -> int:
    args = parse_args()
    password = os.getenv("HIKVISION_PASSWORD", "")
    if not args.host:
        emit("fatal", error="missing-host")
        return 2
    if not password:
        emit("fatal", error="missing-password")
        return 2

    sdk_path = Path(args.sdk_library)
    if not sdk_path.is_file():
        emit("fatal", error="sdk-library-not-found", path=str(sdk_path))
        return 3

    try:
        sdk = ctypes.CDLL(str(sdk_path))
        configure_sdk(sdk, args.component_path)
    except Exception as error:
        emit("fatal", error="sdk-load-or-init-failed", detail=str(error))
        return 4

    callback_type = ctypes.CFUNCTYPE(
        ctypes.c_int,
        ctypes.c_int32,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.c_void_p,
    )

    def alarm_callback(command: int, _alarmer: int, alarm_info: int, buffer_length: int, _user: int) -> int:
        head = b""
        if alarm_info and buffer_length:
            try:
                head = ctypes.string_at(alarm_info, min(int(buffer_length), 64))
            except Exception:
                head = b""
        alarm_type = int.from_bytes(head[:4], byteorder=sys.byteorder, signed=False) if len(head) >= 4 else None
        enqueue_event({
            "command": int(command) & 0xFFFFFFFF,
            "alarmType": alarm_type,
            "bufferLength": int(buffer_length),
            "headHex": head.hex() if args.dump_events else None,
        })
        return 1

    callback = callback_type(alarm_callback)
    user_id = -1
    alarm_handle = -1

    def stop_handler(_signum: int, _frame: Any) -> None:
        STOP_EVENT.set()

    signal.signal(signal.SIGTERM, stop_handler)
    signal.signal(signal.SIGINT, stop_handler)

    try:
        device_info = ctypes.create_string_buffer(1024)
        sdk.NET_DVR_Login_V30.argtypes = [
            ctypes.c_char_p,
            ctypes.c_uint16,
            ctypes.c_char_p,
            ctypes.c_char_p,
            ctypes.c_void_p,
        ]
        sdk.NET_DVR_Login_V30.restype = ctypes.c_int32
        user_id = int(sdk.NET_DVR_Login_V30(
            args.host.encode("utf-8"),
            args.port,
            args.username.encode("utf-8"),
            password.encode("utf-8"),
            ctypes.byref(device_info),
        ))
        if user_id < 0:
            raise RuntimeError(f"NET_DVR_Login_V30 failed error={get_last_error(sdk)}")

        sdk.NET_DVR_SetDVRMessageCallBack_V31.argtypes = [callback_type, ctypes.c_void_p]
        sdk.NET_DVR_SetDVRMessageCallBack_V31.restype = ctypes.c_bool
        if not sdk.NET_DVR_SetDVRMessageCallBack_V31(callback, None):
            raise RuntimeError(f"NET_DVR_SetDVRMessageCallBack_V31 failed error={get_last_error(sdk)}")

        alarm_api = "V30"
        if hasattr(sdk, "NET_DVR_SetupAlarmChan_V41"):
            setup = NET_DVR_SETUPALARM_PARAM()
            setup.dwSize = ctypes.sizeof(NET_DVR_SETUPALARM_PARAM)
            setup.byLevel = 1
            setup.byRetAlarmTypeV40 = 0
            setup.byDeployType = 1
            sdk.NET_DVR_SetupAlarmChan_V41.argtypes = [
                ctypes.c_int32,
                ctypes.POINTER(NET_DVR_SETUPALARM_PARAM),
            ]
            sdk.NET_DVR_SetupAlarmChan_V41.restype = ctypes.c_int32
            alarm_handle = int(sdk.NET_DVR_SetupAlarmChan_V41(user_id, ctypes.byref(setup)))
            alarm_api = "V41"
        else:
            sdk.NET_DVR_SetupAlarmChan_V30.argtypes = [ctypes.c_int32]
            sdk.NET_DVR_SetupAlarmChan_V30.restype = ctypes.c_int32
            alarm_handle = int(sdk.NET_DVR_SetupAlarmChan_V30(user_id))
        if alarm_handle < 0:
            raise RuntimeError(f"NET_DVR_SetupAlarmChan_{alarm_api} failed error={get_last_error(sdk)}")

        local_token, local_port = load_local_api_settings(args.host)
        emit("state", state="CONNECTED", host=args.host, port=args.port, alarmApi=alarm_api)
        last_doorbell_at = 0.0
        last_motion_at = 0.0

        while not STOP_EVENT.is_set():
            try:
                event = EVENT_QUEUE.get(timeout=0.5)
            except queue.Empty:
                continue

            command = int(event["command"])
            alarm_type = event.get("alarmType")
            now = time.monotonic()

            if args.dump_events:
                emit(
                    "raw-event",
                    command=f"0x{command:04x}",
                    alarmType=alarm_type,
                    bufferLength=event.get("bufferLength"),
                    headHex=event.get("headHex"),
                )

            if command == COMM_ALARM_BUTTON_DOWN_EXCEPTION:
                if (now - last_doorbell_at) * 1000 >= max(args.doorbell_debounce_ms, 0):
                    last_doorbell_at = now
                    emit("doorbell", source="hikvision-hcnet-sdk", command="0x1152")
                continue

            if command in {COMM_ALARM, COMM_ALARM_V30, COMM_ALARM_V40} and alarm_type == MOTION_ALARM_TYPE:
                if (now - last_motion_at) * 1000 >= max(args.motion_debounce_ms, 0):
                    last_motion_at = now
                    emit("native-motion", source="hikvision-hcnet-sdk", command=f"0x{command:04x}", alarmType=alarm_type)
                    forward_motion(local_token, local_port, args.motion_hold_ms, command)

        emit("state", state="STOPPING")
        return 0
    except Exception as error:
        emit("fatal", error="alarm-session-failed", detail=str(error))
        return 5
    finally:
        if alarm_handle >= 0:
            try:
                sdk.NET_DVR_CloseAlarmChan_V30.argtypes = [ctypes.c_int32]
                sdk.NET_DVR_CloseAlarmChan_V30.restype = ctypes.c_bool
                sdk.NET_DVR_CloseAlarmChan_V30(alarm_handle)
            except Exception:
                pass
        if user_id >= 0:
            try:
                sdk.NET_DVR_Logout.argtypes = [ctypes.c_int32]
                sdk.NET_DVR_Logout.restype = ctypes.c_bool
                sdk.NET_DVR_Logout(user_id)
            except Exception:
                pass
        try:
            sdk.NET_DVR_Cleanup()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
