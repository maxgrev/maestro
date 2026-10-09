import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("maestro_device", Path(__file__).resolve().parents[1] / "device.py")
device = importlib.util.module_from_spec(spec)
spec.loader.exec_module(device)


class Console:
    def __init__(self, lines): self.lines = iter(lines)
    def readline(self): return next(self.lines, b"")


class DeviceTests(unittest.TestCase):
    def test_log_prefix_does_not_hide_status_and_truncated_json_is_ignored(self):
        conn = Console([b'I (123) heartbeat @status {"wifi":', b'other log\n',
                        b'I (124) heartbeat @status {"board":"M5Stack StopWatch"}\r\n'])
        self.assertEqual(device.response(conn, "@status", .2), {"board": "M5Stack StopWatch"})

    def test_flash_requires_a_live_port_and_explicit_board_confirmation(self):
        with patch.object(device, "ports", return_value=[{"port": "/dev/cu.test"}]), patch.object(device, "install") as install:
            with self.assertRaises(ValueError): device.main({"action": "install", "port": "/dev/cu.missing", "confirmStopWatch": True})
            with self.assertRaises(ValueError): device.main({"action": "install", "port": "/dev/cu.test"})
            install.assert_not_called()

    def test_usb_certificate_transfer_is_bounded_and_paced(self):
        chunks = []
        class Writer:
            def write(self, chunk): chunks.append(chunk)
        with patch.object(device.time, "sleep"):
            device.send(Writer(), "maestro.setup=" + "x" * 3000)
        self.assertEqual(b"".join(chunks), b">maestro.setup=" + b"x" * 3000 + b"\n")
        self.assertTrue(all(len(chunk) <= 128 for chunk in chunks))
