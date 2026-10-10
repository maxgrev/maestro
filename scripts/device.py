#!/usr/bin/env python3
"""One bounded USB operation. Private inputs arrive on stdin, never in argv."""
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

import serial
from serial.tools import list_ports

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("MAESTRO_DATA", ROOT / ".local"))


def ports():
    return [{"port": p.device, "serial": p.serial_number or "", "name": "ESP32 USB device"}
            for p in list_ports.comports() if p.vid == 0x303A and p.device.startswith("/dev/cu.")]


def emit(value):
    print(json.dumps(value), flush=True)


def send(conn, command):
    # The SDK console has a 1 KB receive ring. Pace large certificate messages.
    data = (">" + command + "\n").encode()
    for offset in range(0, len(data), 128):
        conn.write(data[offset:offset + 128])
        time.sleep(0.02)


def response(conn, prefix, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        line = conn.readline().decode("utf-8", errors="replace").strip()
        # ESP-IDF's log writer can precede a console reply on the same line.
        start = line.find(prefix + " ")
        if start >= 0:
            try:
                return json.JSONDecoder().raw_decode(line[start + len(prefix) + 1:])[0]
            except json.JSONDecodeError:
                continue
    raise TimeoutError("The device did not answer. Check its cable and try again.")


def inspect(conn):
    conn.reset_input_buffer()
    send(conn, "status")
    status = response(conn, "@status", 5)
    if status.get("board") != "M5Stack StopWatch":
        raise ValueError("This device is not an M5Stack StopWatch.")
    d = status.get("device", {})
    send(conn, "maestro.status")
    try:
        maestro = response(conn, "@maestro.status", 2)
    except TimeoutError:
        maestro = {"version": 1, "configured": False}
    # Deliberately return only user-facing state, never account or auth data.
    return {"board": status["board"], "name": d.get("name", "StopWatch"), "wifi": d.get("wifi", {}),
            "pair": d.get("pair", {}), "link": d.get("link", {}), "maestro": maestro}


def install(port):
    build = Path(os.environ.get("MAESTRO_FIRMWARE", ROOT / "firmware/build/sdk/esp32/build-maestro"))
    manifest = json.loads((build / "maestro-manifest.json").read_text())
    if manifest.get("board") != "m5stack-stopwatch" or manifest.get("generic") is not True:
        raise ValueError("The firmware is not a generic StopWatch build.")
    files = []
    for item in manifest["files"]:
        path = (build / item["file"]).resolve()
        if not path.is_relative_to(build.resolve()) or hashlib.sha256(path.read_bytes()).hexdigest() != item["sha256"]:
            raise ValueError("The firmware checksum failed. Download Maestro again.")
        files.extend([item["address"], str(path)])
    tool = [sys.executable, "-m", "esptool", "--chip", "esp32s3", "--port", port, "--baud", "460800"]

    def run(args, timeout=240):
        # Tool logs can include flash bytes. Keep them out of the web response.
        result = subprocess.run(tool + args, capture_output=True, text=True, timeout=timeout)
        if result.returncode:
            raise RuntimeError("USB installation stopped. Reconnect the device and retry; its backup is saved.")
        return result.stdout

    info = run(["flash-id"])
    if "16MB" not in info:
        raise ValueError("Expected the StopWatch's 16 MB flash. Nothing was written.")
    mac_text = run(["read-mac"])
    match = re.search(r"MAC:\s*([0-9a-fA-F:]{17})", mac_text)
    if not match:
        raise ValueError("Cannot verify the device identity. Nothing was written.")
    device_id = match[1].replace(":", "").lower()
    backups = DATA / "backups" / device_id
    backups.mkdir(parents=True, exist_ok=True, mode=0o700)
    backup, checksum = backups / "original.bin", backups / "original.sha256"
    if not backup.exists():
        emit({"progress": "Saving a recovery copy of this device. Keep USB connected."})
        partial = backups / "original.partial"
        run(["read-flash", "0", "0x1000000", str(partial)])
        if partial.stat().st_size != 16 * 1024 * 1024:
            raise ValueError("The backup is incomplete. Nothing was written.")
        checksum.write_text(hashlib.sha256(partial.read_bytes()).hexdigest())
        partial.rename(backup)
    if not checksum.exists() or hashlib.sha256(backup.read_bytes()).hexdigest() != checksum.read_text().strip():
        raise ValueError("The recovery copy failed its checksum. Nothing was written.")
    emit({"progress": "Installing Maestro. Keep USB connected."})
    run(["write-flash", *manifest["args"], *files])
    return {"installed": True, "device": device_id}


def main(request):
    action = request["action"]
    if action == "ports":
        return {"ports": ports()}
    port = request["port"]
    if port not in [p["port"] for p in ports()]:
        raise ValueError("The selected USB device disconnected. Connect it again.")
    if action == "install":
        if request.get("confirmStopWatch") is not True:
            raise ValueError("Confirm that this is an M5Stack StopWatch before installing.")
        return install(port)
    with serial.Serial(port, 115200, timeout=0.2, write_timeout=3, exclusive=True) as conn:
        state = inspect(conn)
        if action == "inspect":
            return state
        if action == "wifi":
            ssid, password = request["ssid"], request["password"]
            if not 1 <= len(ssid.encode()) <= 32 or len(password.encode()) > 64 or any(c in ssid + password for c in "\r\n\0"):
                raise ValueError("Use a Wi-Fi name up to 32 bytes and a password up to 64 bytes.")
            for cmd in ("wifi.ssid=" + ssid, "wifi.pass=" + password, "wifi.connect=1"):
                send(conn, cmd)
            deadline = time.monotonic() + 35
            while time.monotonic() < deadline:
                time.sleep(1)
                state = inspect(conn)
                if state["wifi"].get("state") == "connected" and state["wifi"].get("ssid") == ssid:
                    return state
            raise ValueError("Wi-Fi did not connect. Check the password and use a 2.4 GHz network.")
        if action == "configure":
            if state["maestro"].get("version", 0) < 2:
                raise ValueError("Install the current Maestro firmware first.")
            if request["config"].get("trust") == "public" and state["maestro"].get("version", 0) < 3:
                raise ValueError("Install the current firmware before saving remote access.")
            send(conn, "maestro.setup=" + json.dumps(request["config"], separators=(",", ":")))
            result = response(conn, "@maestro.setup", 5)
            if result.get("ok") is not True:
                raise ValueError("The device could not save its settings.")
            return {"saved": True, "restarting": True}
        if action == "agents":
            send(conn, "maestro.agents")
            return {"opened": True}
    raise ValueError("Unknown device action.")


if __name__ == "__main__":
    os.umask(0o077)
    try:
        emit({"result": main(json.loads(sys.stdin.read(16000)))})
    except (ValueError, TimeoutError, RuntimeError) as error:
        emit({"error": str(error)})
        sys.exit(1)
    except Exception:
        emit({"error": "Could not talk to the device. Close any other USB tools and check the cable."})
        sys.exit(1)
