"""Serial reader with automatic mock fallback.

Tries real hardware first. On any failure it switches to mock mode and keeps
running - this worker must never crash the application. It does not touch
firmware; it only reads the JSON line the firmware already emits.
"""
from __future__ import annotations

import json
import math
import os
import threading
import time

from mock_data import MockGenerator

PORT = os.environ.get("GRAINGUARD_SERIAL_PORT", "")
BAUD = int(os.environ.get("GRAINGUARD_SERIAL_BAUD", "9600"))
RETRY_SECONDS = max(1.0, float(os.environ.get("GRAINGUARD_SERIAL_RETRY_SECONDS", "5")))
STALE_SECONDS = max(2.0, float(os.environ.get("GRAINGUARD_SERIAL_STALE_SECONDS", "15")))
FIELDS = ("temp", "rh", "fork_raw", "ldr_raw", "distance_cm")
STATUS_LED_ON = b"G"
STATUS_LED_OFF = b"g"


def status_led_command(result: dict) -> bytes:
    """Illuminate the board LED only for a complete, validated safe reading."""
    if not isinstance(result, dict):
        return STATUS_LED_OFF
    facts = result.get("facts") or {}
    if (result.get("status_led_safe") is True
            and not result.get("invalid_channels")
            and all(isinstance(facts.get(key), (int, float))
                    for key in ("temp", "rh", "emc_estimate", "fork_raw",
                                "ldr_raw", "distance_cm"))
            and -10 <= facts["temp"] <= 70
            and 0 <= facts["rh"] <= 100
            and 5 <= facts["emc_estimate"] <= 20
            and 0 <= facts["fork_raw"] <= 1023
            and 0 <= facts["ldr_raw"] <= 1023
            and facts["distance_cm"] >= 0):
        return STATUS_LED_ON
    return STATUS_LED_OFF


def parse_line(line: str):
    """Parse and validate one telemetry line. Returns dict or None."""
    if not line:
        return None
    line = line.strip()
    if line.upper().startswith("DATA,"):
        values = line.split(",")
        if len(values) != len(FIELDS) + 1:
            return None
        out = {}
        for key, value in zip(FIELDS, values[1:]):
            try:
                number = float(value)
            except ValueError:
                return None
            if not math.isfinite(number):
                return None
            out[key] = number
        return out
    else:
        try:
            obj = json.loads(line)
        except ValueError:
            return None
    if not isinstance(obj, dict):
        return None
    out = {}
    if isinstance(obj.get("timestamp"), str):
        out["timestamp"] = obj["timestamp"]
    for key in FIELDS:
        val = obj.get(key)
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            try:
                number = float(val)
            except (OverflowError, ValueError):
                continue
            if math.isfinite(number):
                out[key] = number
    return out or None


class SerialWorker(threading.Thread):
    """Background thread producing telemetry dicts onto a queue-like callback."""

    daemon = True

    def __init__(self, on_packet, mock_packet=None, interval: float = 1.0):
        super().__init__()
        self.on_packet = on_packet
        self.mock_packet = mock_packet or {}
        self.interval = interval
        self.mode = "MOCK"           # MOCK | LIVE | SIMULATION
        self.detail = "starting"
        self.last_error = None
        self._stop_event = threading.Event()

    # -- hardware --------------------------------------------------------
    def _open_serial(self):
        try:
            import serial  # optional dependency
        except ImportError:
            raise RuntimeError("pyserial not installed")
        port = PORT or self._first_port()
        if not port:
            raise RuntimeError("no serial device found")
        return serial.Serial(port, BAUD, timeout=2)

    @staticmethod
    def _first_port():
        try:
            from serial.tools import list_ports
            ports = sorted(port.device for port in list_ports.comports())
            return ports[0] if ports else None
        except (ImportError, OSError):
            return None

    def _hardware_loop(self, ser):
        last_packet = time.monotonic()
        try:
            while not self._stop_event.is_set():
                raw = ser.readline()
                if not raw:
                    if time.monotonic() - last_packet >= STALE_SECONDS:
                        raise TimeoutError(
                            f"no valid sensor packets for {STALE_SECONDS:g} seconds")
                    continue
                packet = parse_line(raw.decode("utf-8", "ignore"))
                if packet:
                    result = self.on_packet(packet, "LIVE")
                    ser.write(status_led_command(result))
                    last_packet = time.monotonic()
        finally:
            ser.close()

    # -- mock loop -------------------------------------------------------
    def _mock_loop(self, duration=None):
        """Emit physically plausible mock telemetry.

        Uses mock_data.MockGenerator so the demo behaves like a real bin:
        damped diurnal swing, ADC read noise, and occasional damp-ingress
        episodes. The generator never invents a hazard on its own - risk is
        still decided only by the deterministic engine reading these numbers.
        """
        gen = MockGenerator(base=self.mock_packet)
        last = time.time()
        end = time.monotonic() + duration if duration is not None else None
        while not self._stop_event.is_set() \
                and (end is None or time.monotonic() < end):
            now = time.time()
            dt = max(0.0, min(now - last, 5.0)) or self.interval
            last = now
            self.on_packet(gen.step(dt, now), self.mode)
            self._stop_event.wait(self.interval)

    def stop(self):
        self._stop_event.set()

    def run(self):
        while not self._stop_event.is_set():
            try:
                self.mode = "LIVE"
                self.detail = f"connecting to serial on {PORT or 'auto'}"
                ser = self._open_serial()
                self.last_error = None
                self.detail = f"connected to {ser.name}"
                self._hardware_loop(ser)
                if self._stop_event.is_set():
                    return
                raise RuntimeError("serial stream ended")
            except Exception as exc:                 # noqa: BLE001 - worker must keep retrying
                self.last_error = str(exc)[:200]
                self.mode = "MOCK"
                self.detail = (
                    f"HARDWARE OFFLINE — SIMULATION MODE; retrying in "
                    f"{RETRY_SECONDS:g}s ({self.last_error})"
                )[:240]
                try:
                    self._mock_loop(duration=RETRY_SECONDS)
                except Exception as callback_error:  # noqa: BLE001
                    self.last_error = str(callback_error)[:200]
                    self.detail = f"SIMULATION PIPELINE ERROR ({self.last_error})"[:240]
                    self._stop_event.wait(RETRY_SECONDS)
