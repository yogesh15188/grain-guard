"""GrainGuard FastAPI server.

ONE pipeline for everything. Live serial packets, POSTed telemetry and
simulated scenario packets all enter through process_telemetry(), so the demo
provably uses the same physics + engine path as live data.

SLM runs last, on wording only.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
from datetime import datetime

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import alerts                      # noqa: E402
import engine                      # noqa: E402
import slm_forensics               # noqa: E402
from audit_pdf import build_audit_pdf   # noqa: E402
from database import Database, _now_iso   # noqa: E402
from serial_worker import SerialWorker      # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.path.join(ROOT, "data")
FRONTEND = os.path.join(ROOT, "src", "frontend")

app = FastAPI(title="GrainGuard", version="1.0")
db = Database()
lock = threading.Lock()

STATE = {
    "mode": "OFFLINE",         # LIVE | SIMULATION | OFFLINE
    "source_detail": "starting",
    "last_packet": None,
    "last_result": None,
    "last_source": None,
    "last_ts": None,
    "last_event_id": None,
    "baseline_cm": 15.0,
    "live_baseline_set": False,
    "limits": {},
    "offline_mode": False,
    "unverified_ack": None,
    "facility": {},
    "sim_hold_until": 0.0,
    "alerts": {"alerts": [], "new": [], "cleared": [], "top": None},
    "alerts_enabled": True,
    "sound_enabled": True,
    "pipeline_error": None,
}


def _load_json(name, default):
    try:
        with open(os.path.join(DATA, name), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


PROFILE = _load_json("facility_profile.json", {})
SCENARIOS = {s["id"]: s for s in _load_json("scenarios.json", {"scenarios": []}).get("scenarios", [])}
STATE["baseline_cm"] = float(PROFILE.get("baseline_distance_cm", 15.0))
STATE["limits"] = PROFILE.get("rules", {})
STATE["facility"] = {
    "name": PROFILE.get("facility", "Demo Rice Storage"),
    "commodity": PROFILE.get("commodity", ""),
    "bin": PROFILE.get("bin", ""),
    "known_defects": PROFILE.get("known_defects", []),
}


SIM_HOLD_SECONDS = 60.0   # keep a triggered scenario on screen long enough to read

# One alert engine for the whole server lifetime. It holds the RH rate history
# that rain-surge detection depends on, so it must NOT be rebuilt per request.
ALERTS = alerts.AlertEngine(PROFILE.get("alerts"))


def run_alerts(result: dict, extra: dict = None, now: float = None):
    """Evaluate the alert layer and record newly-raised alerts in the ledger.

    Returns the alert payload for the response. Never raises: a failure here
    must not take down the telemetry pipeline.
    """
    try:
        payload = ALERTS.detect(result or {}, time.time() if now is None else now)
        for a in payload["new"]:
            try:
                db.log_event("ALERT", result or {}, {"alert": a})
            except Exception:                      # noqa: BLE001
                pass
        if payload["new"] or payload["cleared"]:
            STATE["alerts"] = {k: payload[k] for k in ("alerts", "new", "cleared")}
        STATE["alerts"]["top"] = payload["top"]
        if extra:
            STATE["alerts"].update(extra)
        return STATE["alerts"]
    except Exception as exc:                       # noqa: BLE001
        return STATE.get("alerts") or {"alerts": [], "new": [], "cleared": [],
                                       "top": None, "error": str(exc)[:120]}


def status_led_safe(result: dict) -> bool:
    """Return true only when all live channels and configured safety checks pass."""
    if not isinstance(result, dict) or result.get("state") != engine.S0 \
            or result.get("risk") != "LOW" or result.get("invalid_channels"):
        return False
    facts = result.get("facts") or {}
    limits = STATE["limits"]
    try:
        return (
            facts["temp"] <= limits["temp_limit"]
            and facts["rh"] <= limits["rh_limit"]
            and facts["emc_estimate"] <= limits["emc_ingress"]
            and facts["fork_raw"] >= limits["fork_loaded"]
            and facts["ldr_raw"] < limits["ldr_anomaly"]
            and facts["distance_cm"] >= 0
            and abs(facts["delta_height_cm"]) <= limits["delta_height_cm"]
            and not (result.get("alerts") or STATE["alerts"]).get("alerts")
        )
    except (KeyError, TypeError):
        return False


def process_telemetry(packet: dict, source: str, hold: bool = False) -> dict:
    """THE single entry point into physics + engine + ledger."""
    sample_time = engine.timestamp_epoch(packet.get("timestamp"))
    with lock:
        if hold:
            STATE["sim_hold_until"] = time.time() + SIM_HOLD_SECONDS
        elif source == "MOCK" and time.time() < STATE.get("sim_hold_until", 0):
            # A scenario is on screen. Mock/live noise must not erase it.
            return dict(STATE["last_result"] or {})
        STATE["last_packet"] = packet
        STATE["last_source"] = source
        STATE["last_ts"] = time.time()
        STATE["offline_mode"] = False
        STATE["source_detail"] = source
        STATE["mode"] = "LIVE" if source in ("LIVE", "FILE") else "SIMULATION"

        distance = packet.get("distance_cm")
        started_live_baseline = (
            source == "LIVE"
            and not STATE["live_baseline_set"]
            and isinstance(distance, (int, float))
            and not isinstance(distance, bool)
            and 0 <= distance <= 1000
        )
        if started_live_baseline:
            STATE["baseline_cm"] = float(distance)
            STATE["live_baseline_set"] = True
            engine.STRESS.reset()

        result = engine.evaluate(packet, STATE["baseline_cm"], STATE["limits"],
                                 sample_time=sample_time)
        if started_live_baseline:
            STATE["last_event_id"] = db.log_event(
                "LIVE_BASELINE", result,
                {"distance_cm": STATE["baseline_cm"],
                 "note": "Baseline captured from first valid ultrasonic reading"},
            )
        previous = STATE["last_result"]
        STATE["last_result"] = result
        db.log_telemetry(packet, result, source)

        if previous is None or previous.get("state") != result["state"] \
                or previous.get("risk") != result["risk"]:
            event_id = db.log_event("STATE_CHANGE", result, {
                "source": source,
                "evidence": result["evidence"],
                "aeration": result["aeration"],
            })
            STATE["last_event_id"] = event_id
    result = dict(result)
    result["mode"] = "SIMULATION" if source in ("MOCK", "SIMULATION") else "LIVE"
    result["source"] = source
    result["timestamp"] = packet.get("timestamp") or _now_iso()
    result["event_id"] = STATE["last_event_id"]
    result["explanation"] = slm_forensics.explain(result)
    result["alerts"] = run_alerts(result, now=sample_time)
    result["status_led_safe"] = status_led_safe(result)
    with lock:
        if STATE["last_result"] is not None:
            STATE["last_result"]["status_led_safe"] = result["status_led_safe"]
    return result


def apply_offline(seconds: float = 0):
    with lock:
        STATE["offline_mode"] = True
        STATE["mode"] = "OFFLINE"
        STATE["sim_hold_until"] = time.time() + SIM_HOLD_SECONDS
        base = STATE["last_result"] or engine.evaluate({}, None, STATE["limits"])
        result = engine.evaluate_offline(base, seconds)
        STATE["last_result"] = result
        STATE["last_event_id"] = db.log_event("TELEMETRY_LOST", result,
                                              {"seconds": round(seconds, 1)})
    result = dict(result)
    result["mode"] = "OFFLINE"
    result["source"] = "SIMULATION"
    result["timestamp"] = _now_iso()
    result["event_id"] = STATE["last_event_id"]
    result["seconds_since_last"] = round(seconds, 1)
    result["explanation"] = slm_forensics.explain(result)
    result["alerts"] = run_alerts(result)
    return result


def apply_unverified_ack(ack: dict):
    with lock:
        base = STATE["last_result"] or {}
        STATE["unverified_ack"] = ack
        STATE["sim_hold_until"] = time.time() + SIM_HOLD_SECONDS
        result = engine.evaluate_audit_anomaly(base, ack)
        STATE["last_result"] = result
        STATE["last_event_id"] = db.log_event("AUDIT_ANOMALY", result, {
            "acknowledgment": ack,
            "note": "unverified acknowledgment - original alert preserved",
        })
    result = dict(result)
    result["mode"] = STATE["mode"]
    result["source"] = "SIMULATION"
    result["timestamp"] = _now_iso()
    result["event_id"] = STATE["last_event_id"]
    result["explanation"] = slm_forensics.explain(result)
    result["alerts"] = run_alerts(result)
    return result


def restore_latest_telemetry():
    """Restore the last saved reading on restart without writing a duplicate."""
    row = db.latest_telemetry()
    if not row:
        return
    packet = json.loads(row["raw_json"])
    sample_time = engine.timestamp_epoch(packet.get("timestamp"))
    result = json.loads(row["result_json"]) if row["result_json"] else \
        engine.evaluate(packet, STATE["baseline_cm"], STATE["limits"],
                        sample_time=sample_time)
    facts = result.get("facts") or {}
    engine.STRESS.restore(facts.get("moisture_stress_hours"),
                          facts.get("thermal_stress_hours"), sample_time)
    try:
        last_ts = datetime.fromisoformat(row["ts"]).timestamp()
    except ValueError:
        last_ts = time.time()
    STATE["last_packet"] = packet
    STATE["last_result"] = result
    STATE["last_source"] = row["source"]
    STATE["last_ts"] = last_ts
    STATE["mode"] = "SIMULATION" if row["source"] in ("MOCK", "SIMULATION") else "LIVE"
    STATE["source_detail"] = row["source"]
    run_alerts(result, now=sample_time)


class TelemetryIn(BaseModel):
    timestamp: datetime | None = None
    temp: float | None = None
    rh: float | None = None
    fork_raw: float | None = None
    ldr_raw: float | None = None
    distance_cm: float | None = None


class AckIn(BaseModel):
    operator: str = "operator"
    event_id: int | None = None
    physically_verified: bool = False
    note: str = ""


def _worker_detail():
    """Live hardware status, read fresh so the banner reflects reality."""
    w = STATE.get("_worker")
    if w is None:
        return "serial worker not started"
    return w.detail or w.mode


@app.get("/api/status")
def get_status():
    with lock:
        result = dict(STATE["last_result"] or {})
        result["mode"] = STATE["mode"]
        result["source_detail"] = _worker_detail()
        result["source"] = STATE["last_source"]
        if STATE["last_packet"]:
            result["timestamp"] = (STATE["last_packet"].get("timestamp")
                                   or _now_iso())
        result["facility"] = STATE["facility"]
        result["baseline_cm"] = STATE["baseline_cm"]
        result["limits"] = STATE["limits"]
        result["unverified_ack"] = STATE["unverified_ack"]
        last_ts = STATE["last_ts"]
        result["status_led_safe"] = status_led_safe(result)
    age = (time.time() - last_ts) if last_ts else None
    if result:
        result["seconds_since_last"] = round(age, 1) if age is not None else None
    return {
        "facility": STATE["facility"],
        "mode": STATE["mode"],
        "source_detail": _worker_detail(),
        "pipeline_error": STATE["pipeline_error"],
        "limits": STATE["limits"],
        "baseline_cm": STATE["baseline_cm"],
        "result": result,
        "alerts": dict(STATE["alerts"]),
        "scenarios": [{"id": k, "label": v.get("label", k), "expect": v.get("expect", "")}
                      for k, v in SCENARIOS.items()],
        "chain": db.verify_chain(),
        "slm_enabled": slm_forensics.SLM_ENABLED,
        "sim_hold_seconds": max(0.0, round(STATE["sim_hold_until"] - time.time(), 1)),
        "server_time": _now_iso(),
    }


@app.post("/api/telemetry")
def post_telemetry(body: TelemetryIn):
    packet = body.model_dump(mode="json", exclude_none=True)
    if not packet:
        raise HTTPException(400, "empty telemetry payload")
    return process_telemetry(packet, "LIVE")


@app.get("/api/history")
def get_history(limit: int = 60):
    return {"history": db.history(min(limit, 500))}


@app.get("/api/events")
def get_events(limit: int = 60):
    return {"events": db.events(min(limit, 200)),
            "acknowledgments": db.acknowledgments(20),
            "chain": db.verify_chain()}


@app.get("/api/audit.pdf")
def download_audit_pdf():
    snapshot = db.audit_snapshot()
    pdf = build_audit_pdf(snapshot, STATE["facility"])
    return StreamingResponse(
        pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="grain-guard-audit.pdf"'},
    )


@app.post("/api/simulate/{scenario_id}")
def simulate(scenario_id: str):
    scenario = SCENARIOS.get(scenario_id)
    if not scenario:
        raise HTTPException(404, f"unknown scenario '{scenario_id}'")

    if scenario_id == "offline":
        age = 0.0
        if STATE["last_ts"]:
            age = time.time() - STATE["last_ts"]
        return apply_offline(age)

    packet = dict(scenario.get("telemetry") or {})
    packet.setdefault("timestamp", _now_iso())
    result = process_telemetry(packet, "SIMULATION", hold=True)

    if scenario_id == "unverified_ack":
        ack = db.log_ack("operator-on-duty", STATE["last_event_id"], 0,
                         "Alert marked handled without physical verification.")
        return apply_unverified_ack(ack)

    return result


@app.post("/api/acknowledge")
def acknowledge(body: AckIn):
    ack = db.log_ack(body.operator, body.event_id or STATE["last_event_id"],
                     1 if body.physically_verified else 0, body.note)
    if not body.physically_verified:
        return apply_unverified_ack(ack)
    with lock:
        STATE["unverified_ack"] = None
        STATE["sim_hold_until"] = time.time() + SIM_HOLD_SECONDS
        # A verification clears the audit overlay, so re-run the real sensor
        # state rather than keeping the S7 result on top of it.
        base = engine.evaluate(STATE["last_packet"], STATE["baseline_cm"], STATE["limits"]) \
            if STATE["last_packet"] else dict(STATE["last_result"] or {})
        STATE["last_result"] = base
        STATE["last_event_id"] = db.log_event(
            "ACKNOWLEDGMENT_VERIFIED", base, {"acknowledgment": ack})
    out = dict(STATE["last_result"] or {})
    out.update({"mode": STATE["mode"], "source": "LIVE", "timestamp": _now_iso(),
                "event_id": STATE["last_event_id"], "acknowledgment": ack,
                "explanation": slm_forensics.explain(out)})
    return out


# --- static frontend ------------------------------------------------------
@app.get("/api/health")
def health():
    return {"ok": True, "time": _now_iso()}


@app.get("/")
def index():
    return FileResponse(os.path.join(FRONTEND, "index.html"))


@app.on_event("startup")
def startup():
    engine.STRESS.reset()
    restore_latest_telemetry()
    seed = _load_json("sensor_reading.json", {})
    if seed:
        process_telemetry(seed, "LIVE")

    def on_packet(packet, mode):
        try:
            result = process_telemetry(packet, mode)
            STATE["pipeline_error"] = None
            return result
        except Exception as exc:               # noqa: BLE001 - keep the worker alive, but report failure
            STATE["pipeline_error"] = str(exc)[:200]
            return None

    mock = {"temp": 27.2, "rh": 61.0, "fork_raw": 890, "ldr_raw": 22, "distance_cm": 15.0}
    worker = SerialWorker(on_packet, mock_packet=mock)
    worker.start()
    STATE["source_detail"] = worker.detail
    STATE["_worker"] = worker


@app.exception_handler(Exception)
def unhandled(request, exc):
    """Last-resort guard: the dashboard must always get a JSON answer."""
    return JSONResponse(status_code=500,
                        content={"error": "internal", "detail": str(exc)[:200]})


app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")