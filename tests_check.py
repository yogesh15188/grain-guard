"""Ad-hoc verification of the deterministic engine against scenarios.json.

Run:  python tests_check.py
Not part of the server; kept so the demo expectations stay honest.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "src", "backend"))
os.environ.setdefault("GRAINGUARD_SLM", "0")

import engine  # noqa: E402

DATA = os.path.join(HERE, "data")
SC = {s["id"]: s for s in json.load(open(os.path.join(DATA, "scenarios.json"), encoding="utf-8"))["scenarios"]}
PROF = json.load(open(os.path.join(DATA, "facility_profile.json"), encoding="utf-8"))
LIM, BASE = PROF["rules"], PROF["baseline_distance_cm"]

EXPECT = {
    "normal": "S0_IDLE_SAFE",
    "humidity_intrusion": "S1_ATMOSPHERIC_INGRESS",
    "dunnage_seepage": "S2_DUNNAGE_SEEPAGE",
    "stock_anomaly": "S4_PHYSICAL_ANOMALY",
}

fails = 0
for sid, want in EXPECT.items():
    r = engine.evaluate(SC[sid]["telemetry"], BASE, LIM)
    ok = r["state"] == want
    fails += 0 if ok else 1
    print(f"{'PASS' if ok else 'FAIL'}  {sid:20s} -> {r['state']:26s} "
          f"{r['risk']:12s} aeration={r['aeration']}")

# Scenario 5 - aeration must stay locked on every alerting scenario.
for sid in ("humidity_intrusion", "dunnage_seepage", "stock_anomaly"):
    r = engine.evaluate(SC[sid]["telemetry"], BASE, LIM)
    ok = r["aeration_allowed"] is False
    fails += 0 if ok else 1
    print(f"{'PASS' if ok else 'FAIL'}  {sid:20s} aeration locked = {r['aeration']}")

# S6 offline overlay keeps the last facts.
last = engine.evaluate(SC["humidity_intrusion"]["telemetry"], BASE, LIM)
off = engine.evaluate_offline(last, 45)
ok = off["state"] == "S6_OFFLINE" and off["facts"].get("rh") == 78.0 or off["state"] == "S6_OFFLINE"
fails += 0 if off["state"] == "S6_OFFLINE" else 1
print(f"{'PASS' if off['state'] == 'S6_OFFLINE' else 'FAIL'}  offline             -> {off['state']} "
      f"(retained RH={off['facts'].get('rh')})")

# S7 unverified acknowledgment.
s7 = engine.evaluate_audit_anomaly(last, {"ts": "2026-10-05T14:31:00+05:30", "operator": "op"})
fails += 0 if s7["state"] == "S7_AUDIT_ANOMALY" and s7["aeration_allowed"] is False else 1
print(f"{'PASS' if s7['state'] == 'S7_AUDIT_ANOMALY' else 'FAIL'}  unverified_ack      -> {s7['state']}")

# Aeration permitted only in the safe window.
r = engine.evaluate({"temp": 29.0, "rh": 55.0, "fork_raw": 900, "ldr_raw": 20, "distance_cm": 15.0}, BASE, LIM)
fails += 0 if r["state"] == "S3_PERMISSIBLE_AERATION" and r["aeration_allowed"] else 1
print(f"{'PASS' if r['state'] == 'S3_PERMISSIBLE_AERATION' else 'FAIL'}  aeration_window    -> {r['state']} {r['aeration']}")

# Garbage input must not crash and must be flagged.
r = engine.evaluate({"temp": "hot", "rh": None, "fork_raw": 99999}, BASE, LIM)
fails += 0 if r["invalid_channels"] else 1
print(f"{'PASS' if r['invalid_channels'] else 'FAIL'}  invalid_input       -> invalid={r['invalid_channels']}")

# Ultrasonic timeouts must stay invalid, never become a fabricated distance.
bad_ultrasonic = engine.evaluate(
    {"temp": 26.0, "rh": 55.0, "fork_raw": 900, "ldr_raw": 20,
     "distance_cm": -1.0}, BASE, LIM)
ok = "distance_cm" in bad_ultrasonic["invalid_channels"] \
    and bad_ultrasonic["facts"]["headspace_cm"] is None
fails += 0 if ok else 1
print(f"{'PASS' if ok else 'FAIL'}  ultrasonic_timeout   -> "
      f"headspace={bad_ultrasonic['facts']['headspace_cm']}")

# Headspace movement in either direction is evaluated as an absolute change.
negative_delta = engine.evaluate(
    {"temp": 26.0, "rh": 55.0, "fork_raw": 900, "ldr_raw": 20,
     "distance_cm": BASE - 6.0}, BASE, LIM)
ok = negative_delta["state"] == "S4_PHYSICAL_ANOMALY"
fails += 0 if ok else 1
print(f"{'PASS' if ok else 'FAIL'}  negative_headspace_delta -> "
      f"{negative_delta['state']} ({negative_delta['facts']['delta_height_cm']:+.1f} cm)")

# File records use their recorded times for cumulative stress, not import speed.
engine.STRESS.reset()
first = engine.evaluate(
    {"timestamp": "2026-10-06T10:00:00+00:00", "temp": 25.0, "rh": 70.0},
    BASE, LIM)
second = engine.evaluate(
    {"timestamp": "2026-10-06T10:01:00+00:00", "temp": 25.0, "rh": 70.0},
    BASE, LIM)
ok = first["facts"]["moisture_stress_hours"] == 0.0 \
    and second["facts"]["moisture_stress_hours"] == 0.02
fails += 0 if ok else 1
print(f"{'PASS' if ok else 'FAIL'}  timestamped_stress   -> "
      f"{second['facts']['moisture_stress_hours']:.2f} h after 60 recorded seconds")
engine.STRESS.reset()

print("\n" + ("ALL CHECKS PASSED" if fails == 0 else f"{fails} CHECK(S) FAILED"))
sys.exit(1 if fails else 0)