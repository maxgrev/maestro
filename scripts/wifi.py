#!/usr/bin/env python3
"""Set StopWatch Wi-Fi over USB without putting its password in shell history."""
import argparse
import getpass
import time
import serial

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("port")
args = parser.parse_args()
ssid = input("Wi-Fi name (2.4 GHz): ")
password = getpass.getpass("Wi-Fi password: ")
if not ssid or len(ssid.encode()) > 32 or len(password.encode()) > 64 or any(c in ssid + password for c in "\r\n\0"):
    raise SystemExit("Invalid Wi-Fi name or password.")
with serial.Serial(args.port, 115200, timeout=0.2) as port:
    time.sleep(1)
    port.reset_input_buffer()
    for command in (f"wifi.ssid={ssid}", f"wifi.pass={password}", "wifi.connect=1"):
        port.write((">" + command + "\n").encode())
        time.sleep(0.4)
        port.reset_input_buffer()
print("Wi-Fi settings sent. Check the device screen for connection status.")
