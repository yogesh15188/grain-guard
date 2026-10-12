"""GrainGuard deterministic engine.

Telemetry -> physics -> ordered rule evaluation ->
state / risk / facts / checks / aeration interlock.

This module is the ONLY thing allowed to decide risk. No SLM and no UI logic
may override what it returns.
"""
from __future__ import annotations

import time
from datetime import datetime

from physics import (
    calculate_dew_point,
    calculate_delta_height,
    calculate_emc,
    describe_interlock,
    update_stress,
)

S0 = "S0_IDLE_SAFE"
S1 = "S1_ATMOSPHERIC_INGRESS"
S2 = "S2_DUNNAGE_SEEPAGE"
S3 = "S3_PERMISSIBLE_AERATION"
S4 = "S4_PHYSICAL_ANOMALY"
S5 = "S5_CUMULATIVE_STRESS"
S6 = "S6_OFFLINE"
S7 = "S7_AUDIT_ANOMALY"

FORK_LOW = 300            # fork/proximity raw below this = object at the wall
FORK_LOADED = 600         # fork raw above this = grain surface meaningfully loaded
LDR_ANOMALY = 700         # LDR raw above this = sudden light ingress
DELTA_HEIGHT_CM = 5.0
RH_LIMIT = 65.0
EMC_INGRESS = 14.0
EMC_AERATION = 13.5
TEMP_LIMIT = 28.0
MOISTURE_STRESS_LIMIT_H = 24.0

RISK_RANK = {"LOW": 0, "MEDIUM": 1, "MEDIUM-HIGH": 2, "HIGH": 3, "CRITICAL": 4}


class StressTracker:
    """Cumulative stress hours across calls (server-lifetime state)."""

    def __init__(self):
        self.moisture_hours = 0.0
        self.thermal_hours = 0.0
        self._last_ts = None

    def update(self, temp_c, rh_pct, emc, limits=None, sample_time=None):
        limits = limits or {}
        now = time.time() if sample_time is None else sample_time
        dt = 0.0 if self._last_ts is None else max(0.0, now - self._last_ts)
        dt = min(dt, 60.0)  # cap so a restart or long gap cannot inflate hours
        self.moisture_hours, self.thermal_hours = update_stress(
            self.moisture_hours, self.thermal_hours, temp_c, rh_pct, emc, dt,
            rh_limit=limits.get("rh_limit", RH_LIMIT),
            temp_limit=limits.get("temp_limit", TEMP_LIMIT),
            emc_limit=limits.get("emc_limit", EMC_INGRESS),
        )
        self._last_ts = now
        return self.moisture_hours, self.thermal_hours

    def reset(self):
        self.moisture_hours = 0.0
        self.thermal_hours = 0.0
        self._last_ts = None

    def restore(self, moisture_hours, thermal_hours, sample_time=None):
        self.moisture_hours = max(0.0, float(moisture_hours or 0.0))
        self.thermal_hours = max(0.0, float(thermal_hours or 0.0))
        self._last_ts = sample_time


STRESS = StressTracker()


def timestamp_epoch(timestamp):
    if not isinstance(timestamp, str) or not timestamp.strip():
        return None
    try:
        value = datetime.fromisoformat(timestamp.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return value.timestamp()


def _num(v, lo, hi):
    return (v is not None and isinstance(v, (int, float))
            and not isinstance(v, bool) and v == v and lo <= v <= hi)
def _fmt(v, unit="", nd=1):
    return "unavailable" if v is None else f"{v:.{nd}f}{unit}"


def evaluate(telemetry: dict, baseline_cm=None, limits: dict = None,
             sample_time=None) -> dict:
    """Run the full pipeline for one telemetry packet."""
    t = telemetry or {}
    limits = limits or {}
    fork_low = limits.get("fork_low", FORK_LOW)
    fork_loaded = limits.get("fork_loaded", FORK_LOADED)
    ldr_anom = limits.get("ldr_anomaly", LDR_ANOMALY)
    dh_limit = limits.get("delta_height_cm", DELTA_HEIGHT_CM)
    rh_limit = limits.get("rh_limit", RH_LIMIT)
    emc_ingress = limits.get("emc_ingress", EMC_INGRESS)
    emc_aeration = limits.get("emc_aeration", EMC_AERATION)
    temp_limit = limits.get("temp_limit", TEMP_LIMIT)
    stress_limit = limits.get("moisture_stress_limit_h", MOISTURE_STRESS_LIMIT_H)

    temp = t.get("temp") if _num(t.get("temp"), -10.0, 70.0) else None
    rh = t.get("rh") if _num(t.get("rh"), 0.0, 100.0) else None
    fork = t.get("fork_raw") if _num(t.get("fork_raw"), 0, 1023) else None
    ldr = t.get("ldr_raw") if _num(t.get("ldr_raw"), 0, 1023) else None
    dist = t.get("distance_cm") if _num(t.get("distance_cm"), 0.0, 1000.0) else None
    invalid = [k for k, v in (("temp", temp), ("rh", rh), ("fork_raw", fork),
                              ("ldr_raw", ldr), ("distance_cm", dist)) if v is None]

    # --- PHYSICS ---
    emc = calculate_emc(temp, rh) if (temp is not None and rh is not None) else None
    dew = calculate_dew_point(temp, rh) if (temp is not None and rh is not None) else None
    delta_h = (calculate_delta_height(dist, baseline_cm)
               if (dist is not None and baseline_cm is not None) else None)
    if sample_time is None:
        sample_time = timestamp_epoch(t.get("timestamp"))
    m_h, t_h = STRESS.update(temp, rh, emc, limits, sample_time)

    state, risk, aeration_ok = S0, "LOW", False
    rule, evidence, checks = "", [], []
    headline = "STORAGE NORMAL"
    plain = "Air in the bin is within configured limits. Nothing needs attention."

    # S5 outranks active conditions once cumulative time is critical.
    if m_h >= stress_limit:
        state, risk = S5, "CRITICAL"
        rule = f"cumulative moisture stress {m_h:.1f} h >= {stress_limit} h limit"
        evidence = [
            f"Moisture-stress hours accumulated: {m_h:.1f} h",
            f"Configured escalation limit: {stress_limit} h",
            "Long exposure, not a single spike, drives this escalation",
        ]
        checks = [
            "Escalate to the manager on duty now",
            "Re-check shutters, roof gaps and drainage around the bin",
            "Plan controlled drying or shifting once conditions improve",
        ]
        headline = "LONG-TERM MOISTURE STRESS"
        plain = ("Damp air has been sitting around this bin for a long time now. "
                 "Please call the manager now.")

    elif fork is not None and fork < fork_low:
        state, risk = S2, "HIGH"
        rule = f"fork_raw {fork:.0f} < {fork_low} -> object/proximity at bin wall"
        evidence = [
            f"Fork/proximity sensor raw: {fork:.0f} (limit {fork_low})",
            "Consistent with something close to the wall or floor probe",
            "Channel no longer shows a loaded grain surface",
        ]
        checks = [
            "Walk to the bin wall and look for a water seep or leak",
            "Inspect floor contact and the dunnage / wooden supports",
            "Look for an animal entry hole by eye - this sensor does not identify animals",
        ]
        headline = "WATER OR SEEPAGE NEAR WALL"
        plain = ("Something is very close to the side of the bin. This looks like "
                 "water leaking in near the wall. Please go and see the wall.")

    elif delta_h is not None and abs(delta_h) > dh_limit:
        # Headspace movement is evaluated before the humidity rules: a level change
        # is unexplained by damp air and needs its own evidence trail.
        state, risk = S4, "MEDIUM-HIGH"
        rule =         f"absolute headspace change {abs(delta_h):.1f} cm > {dh_limit} cm limit"
        evidence = [
            f"Headspace reading {dist:.1f} cm vs baseline {baseline_cm:.1f} cm",
        f"Change of {delta_h:+.1f} cm exceeds the ±{dh_limit} cm limit",
            "Consistent with stock displacement or settling, or a moved surface probe",
            "Unexpected stock displacement / headspace change - not an identification of cause",
        ]
        checks = [
            "Go to the bin and visually confirm the grain surface level",
            "Check whether shutters or doors were left open",
            "Confirm the distance probe has not been shifted or knocked",
        ]
        headline = "UNEXPECTED STOCK / HEADSPACE CHANGE"
        plain = ("The grain level or the light inside the bin changed suddenly. "
                 "Something may have moved. Please check the bin yourself.")
    elif ((ldr is not None and ldr >= ldr_anom)
          and not (rh is not None and rh > rh_limit)):
        # Standalone light ingress with no headspace move and no humidity breach.
        # When RH is also high, the S1 branch above wins: damp air explains the light.
        state, risk = S4, "MEDIUM-HIGH"
        rule = f"ldr_raw {ldr:.0f} >= {ldr_anom} -> abrupt light ingress at shutter"
        evidence = [
            f"Light sensor raw: {ldr:.0f} (limit {ldr_anom})",
            "Consistent with a shutter or opening being left open, or direct light on the sensor",
            f"Relative humidity {_fmt(rh, '%')} is not above the {rh_limit}% ingress limit",
        ]
        checks = [
            "Go to the bin and confirm whether a shutter or door was left open",
            "Check that the bin is not in direct afternoon sun",
            "Note the time so you can compare it against any change in humidity",
        ]
        headline = "UNEXPECTED LIGHT / HEADSPACE CHANGE"
        plain = ("There is a lot of light inside the bin now. Something may have been "
                 "left open. Please go and check the shutters.")

    elif (rh is not None and rh > rh_limit) or (emc is not None and emc > emc_ingress):
        state, risk = S1, "HIGH"
        if rh is not None and rh > rh_limit:
            rule = f"RH {rh:.1f}% > {rh_limit}% limit -> atmospheric moisture ingress"
            evidence = [
                f"Relative humidity: {rh:.1f}% (limit {rh_limit}%)",
                f"EMC estimate: {_fmt(emc, '%')}",
                f"Dew point: {_fmt(dew, ' C')}",
                "High humidity at this temperature is consistent with moist air entering the bin",
            ]
        else:
            rule = f"EMC estimate {emc}% > {emc_ingress}% limit -> atmospheric moisture ingress"
            evidence = [
                f"EMC estimate: {emc}% (limit {emc_ingress}%)",
                f"Relative humidity: {_fmt(rh, '%')}",
                "EMC above limit is consistent with air that can keep the grain damp",
            ]
        checks = [
            "Walk the shed and look for open shutters, roof gaps or broken mesh",
            "Check that vents and louvres are closed and the seals are intact",
            "Verify the DHT11 is not near an open window or a wet wall",
        ]
        headline = "HIGH HUMIDITY - CHECK SHUTTERS"
        plain = ("The air inside is too wet. Wet air can spoil grain. "
                 "Please check the shutters, roof and vents for gaps.")

    elif (temp is not None and temp > temp_limit and rh is not None
          and rh <= rh_limit and emc is not None and emc <= emc_aeration
          and fork is not None and fork >= fork_loaded):
        state, risk, aeration_ok = S3, "MEDIUM", True
        rule = (f"T {temp:.1f}C > {temp_limit}C with RH {rh:.1f}% <= {rh_limit}%, "
                f"EMC {emc}% <= {emc_aeration}% and fork_raw {fork:.0f} >= {fork_loaded}")
        evidence = [
            f"Temperature: {temp:.1f} C (limit {temp_limit} C)",
            f"Relative humidity: {rh:.1f}% - air is dry enough",
            f"EMC estimate: {emc}% - below the {emc_aeration}% safe limit",
            f"Fork/proximity raw: {fork:.0f} - grain surface present and loaded",
            "Conditions are consistent with a safe, gentle aeration window",
        ]
        checks = [
            "Confirm the fan and duct are clear before starting",
            "Start aeration for a short trial and watch the bin surface",
            "Record the start time and stop if humidity rises",
        ]
        headline = "SAFE AERATION WINDOW"
        plain = ("The air is dry and the grain is not warm enough to harm. "
                 "This is a good time to run the fan, if you are satisfied it is safe.")

    else:
        rule = "all readings within configured limits"
        evidence = [
            f"Temperature: {_fmt(temp, ' C')} within limit",
            f"Relative humidity: {_fmt(rh, '%')} within limit",
            f"EMC estimate: {_fmt(emc, '%')}",
            f"Fork/proximity raw: {_fmt(fork, '', 0)} - grain surface present",
        ]

    if invalid:
        evidence.append("Invalid or missing channels: " + ", ".join(invalid))

    return {
        "state": state,
        "risk": risk,
        "risk_rank": RISK_RANK.get(risk, 0),
        "headline": headline,
        "rule": rule,
        "evidence": evidence,
        "checks": checks,
        "aeration_allowed": aeration_ok,
        "aeration": describe_interlock(aeration_ok),
        "facts": {
            "temp": temp, "rh": rh, "emc_estimate": emc, "dew_point": dew,
            "fork_raw": fork, "ldr_raw": ldr, "distance_cm": dist,
            "headspace_cm": dist,
            "delta_height_cm": delta_h,
            "moisture_stress_hours": m_h, "thermal_stress_hours": t_h,
        },
        "invalid_channels": invalid,
        "plain_summary": plain,
}
def evaluate_offline(last_result: dict, seconds_since_last: float) -> dict:
    """S6 overlay - retains the last reading and local history."""
    out = dict(last_result or {})
    out.update({
        "state": S6,
        "risk": out.get("risk") or "MEDIUM-HIGH",
        "headline": "TELEMETRY OFFLINE",
        "rule": f"no telemetry received for {seconds_since_last:.0f}s -> S6_OFFLINE",
        "evidence": [
            "No live telemetry packet received from the edge node",
            f"Last reading is {seconds_since_last:.0f}s old and is shown for reference only",
            "Values shown are the last known values, not current readings",
        ],
        "aeration_allowed": False,
        "aeration": describe_interlock(False),
        "plain_summary": ("The monitoring box has stopped sending readings. "
                          "The numbers shown are old. Please check the unit and power."),
        "facts": out.get("facts", {}),
        "invalid_channels": out.get("invalid_channels", []),
        "risk_rank": RISK_RANK.get(out.get("risk", "MEDIUM-HIGH"), 2),
    })
    return out


def evaluate_audit_anomaly(last_result: dict, ack: dict) -> dict:
    """S7 - an operator acknowledged without physical verification."""
    out = dict(last_result or {})
    out.update({
        "state": S7,
        "risk": "CRITICAL",
        "headline": "UNVERIFIED ACKNOWLEDGMENT",
        "rule": f"acknowledged without physical verification at {ack.get('ts')} -> S7_AUDIT_ANOMALY",
        "evidence": [
            f"Acknowledgment recorded at {ack.get('ts')} by {ack.get('operator')}",
            "Operator marked the alert handled but no physical verification was logged",
            "This is an unverified acknowledgment, not an accusation of wrongdoing",
            "The original alert is preserved in the ledger and was not deleted",
        ],
        "checks": [
            "Manager to physically inspect the bin and record what was seen",
            "Record the verification time and the name of the verifier",
            "Keep aeration locked until physical verification is logged",
        ],
        "aeration_allowed": False,
        "aeration": describe_interlock(False),
        "plain_summary": ("Someone marked this alert as done, but nobody went and checked. "
                          "A manager must go and verify the bin."),
        "facts": out.get("facts", {}),
        "invalid_channels": out.get("invalid_channels", []),
        "risk_rank": RISK_RANK["CRITICAL"],
    })
    return out
