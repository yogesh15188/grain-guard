"""Serial ingestion checks. Run: python tests_serial_worker.py"""
import os
import sys
import unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "src", "backend"))

from serial_worker import SerialWorker, parse_line, status_led_command  # noqa: E402


class FakeSerial:
    name = "fake-port"

    def __init__(self, lines):
        self.lines = iter(lines)
        self.closed = False
        self.commands = []

    def readline(self):
        return next(self.lines, b"")

    def close(self):
        self.closed = True

    def write(self, command):
        self.commands.append(command)
        return len(command)


class SerialWorkerChecks(unittest.TestCase):
    def test_parse_line_preserves_timestamp_and_numeric_channels(self):
        packet = parse_line(
            '{"timestamp":"2026-10-06T11:00:00+05:30","temp":28.5,'
            '"rh":78,"fork_raw":1023,"ldr_raw":12,"distance_cm":15}'
        )
        self.assertEqual(packet["timestamp"], "2026-10-06T11:00:00+05:30")
        self.assertEqual(packet["temp"], 28.5)
        self.assertEqual(packet["fork_raw"], 1023.0)

    def test_parse_line_rejects_malformed_and_non_finite_only_packets(self):
        self.assertIsNone(parse_line("not json"))
        self.assertIsNone(parse_line('{"temp": NaN}'))
        self.assertIsNone(parse_line('{"temp": 1e999}'))

    def test_parse_arduino_sketch_data_line(self):
        packet = parse_line("DATA,27.0,60.0,900,20,15.0\r\n")
        self.assertEqual(packet, {
            "temp": 27.0, "rh": 60.0, "fork_raw": 900.0,
            "ldr_raw": 20.0, "distance_cm": 15.0,
        })
        self.assertIsNone(parse_line("DATA,27.0,60.0,900,20"))
        self.assertIsNone(parse_line("DATA,27.0,60.0,NaN,20,15.0"))

    def test_hardware_packets_use_live_source_and_close_serial(self):
        serial = FakeSerial([
            b'{"temp":28.5,"rh":78,"fork_raw":1023,"ldr_raw":12,'
            b'"distance_cm":15}\n'
        ])
        packets = []
        worker = SerialWorker(lambda packet, source: (packets.append((packet, source)),
                                                       worker.stop()))

        worker._hardware_loop(serial)

        self.assertEqual(len(packets), 1)
        self.assertEqual(packets[0][1], "LIVE")
        self.assertEqual(serial.commands, [b"g"])
        self.assertTrue(serial.closed)

    def test_status_led_requires_every_sensor_and_safe_engine_state(self):
        safe = {
            "state": "S0_IDLE_SAFE",
            "risk": "LOW",
            "status_led_safe": True,
            "invalid_channels": [],
            "facts": {
                "temp": 27.0, "rh": 55.0, "emc_estimate": 12.0,
                "fork_raw": 900, "ldr_raw": 20, "distance_cm": 12.0,
            },
        }
        self.assertEqual(status_led_command(safe), b"G")
        unsafe = dict(safe, state="S1_ATMOSPHERIC_INGRESS", risk="HIGH")
        unsafe["status_led_safe"] = False
        self.assertEqual(status_led_command(unsafe), b"g")
        invalid = dict(safe, invalid_channels=["distance_cm"])
        self.assertEqual(status_led_command(invalid), b"g")

    def test_worker_retries_after_initial_serial_failure(self):
        worker = SerialWorker(lambda packet, source: None)
        attempts = []
        mock_modes = []
        serial = FakeSerial([])

        def open_serial():
            attempts.append(True)
            if len(attempts) == 1:
                raise OSError("not attached yet")
            return serial

        def mock_loop(duration=None):
            mock_modes.append(worker.mode)

        def hardware_loop(_serial):
            worker.stop()

        worker._open_serial = open_serial
        worker._mock_loop = mock_loop
        worker._hardware_loop = hardware_loop
        worker.run()

        self.assertEqual(len(attempts), 2)
        self.assertEqual(mock_modes, ["MOCK"])
        self.assertEqual(worker.mode, "LIVE")

    def test_hardware_staleness_closes_and_reports_disconnected_device(self):
        serial = FakeSerial([])
        worker = SerialWorker(lambda packet, source: None)
        with patch("serial_worker.STALE_SECONDS", 1), \
                patch("serial_worker.time.monotonic", side_effect=[0, 2]):
            with self.assertRaisesRegex(TimeoutError, "no valid sensor packets"):
                worker._hardware_loop(serial)
        self.assertTrue(serial.closed)


if __name__ == "__main__":
    unittest.main()
