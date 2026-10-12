# GrainGuard

**Protect the Grain. See the Risk Before the Loss.**
Offline-first early warning for Indian grain storage.

Sensors provide evidence → Physics calculates → Rules determine risk →
**Human decides** → SLM explains.

---

## Run it

```bash
pip install -r requirements.txt
python run.py
```

Open <http://127.0.0.1:8000>. That is the whole setup.

Works with **no hardware**, **no internet** and **no SLM**. When the Arduino is
not connected the console shows `HARDWARE OFFLINE — SIMULATION MODE` and keeps
running on mock telemetry.

```bash
python run.py --no-open     # server only
python tests_check.py       # verify engine against all scenarios
python tests_serial_worker.py  # verify serial ingestion and reconnection
python tests_database.py   # verify persistence and ledger integrity
```

---

## 3-minute pitch

> A farmer stores paddy in a concrete godown for six months. If damp air gets in
> through a roof gap, the grain spoils. The problem is that nobody notices until
> it is too late, because nobody is inside the bin at 3 AM.
>
> GrainGuard puts four cheap sensors in one bin: temperature, humidity, light at
> the shutter, and grain surface height. Physics turns those readings into an EMC
> estimate and a dew point. Fixed rules then decide the risk — no guessing, and
> the exact rule that fired is always on screen.
>
> Two things make it trustworthy. First, the machine never overclaims: it will
> tell you conditions are *consistent with* damp air, never that it detected
> fungus or rodents, because it cannot. Second, the aeration fan stays locked
> unless conditions are genuinely safe, and unlocking it needs a human.
>
> Every alert is written to a tamper-evident local ledger. If someone marks an
> alert done without going to look, that is recorded as an unverified
> acknowledgment and escalated to the manager — we do not delete the original
> alert.
>
> It runs on a low-cost board with no internet. If the network or the hardware
> dies, the last reading and full history stay on screen.

---

## Live demo walkthrough

Open **Launch Console**, then click the scenario buttons. Each one is pushed
through the *same* physics and engine pipeline as live telemetry — the UI only
renders what the deterministic engine returns.

| Step | Click | Expected result |
|---|---|---|
| 1 | `Normal` | `S0_IDLE_SAFE`, LOW, aeration LOCKED |
| 2 | `Humidity Intrusion` | `S1_ATMOSPHERIC_INGRESS`, HIGH, aeration LOCKED |
| 3 | `Dunnage Seepage` | `S2_DUNNAGE_SEEPAGE`, HIGH, aeration LOCKED |
| 4 | `Stock Anomaly` | `S4_PHYSICAL_ANOMALY`, MEDIUM-HIGH |
| 5 | `Offline` | `S6_OFFLINE`, last reading retained |
| 6 | `Unverified Acknowledgment` | `S7_AUDIT_ANOMALY`, CRITICAL |

Watch the **pipeline indicator** light up Telemetry → Physics → Deterministic
Engine → SLM Explanation. That is the proof for judges that the same code path
handles both live and simulated data.

Also try: switch **Operator Mode / Manager Mode**, toggle the light/dark theme,
and use the Ack buttons to show the audit trail.

The **Recent Trend** panel plots the last 60 stored readings from `/api/history`
with the configured RH ingress limit drawn as a reference line, so you can show
how close the bin came to the limit over time. The chart only renders stored
numbers — it never scores risk.

### Mock data in simulation mode

With no Arduino attached, `mock_data.py` feeds the pipeline a physically
plausible bin instead of a flat line: a damped diurnal temperature swing (peak
~15:00 IST, lagging ~2.5 h behind ambient because of the grain's thermal mass),
RH moving inversely with temperature, ADC read noise on the raw channels, and
occasional damp-ingress episodes that raise RH, drop temperature and admit light
at the shutter.

The generator emits **numbers only**. It has no knowledge of engine thresholds
or states, and its ambient baseline deliberately sits below the ingress limit, so
the resting demo state is `S0`/`S3`. Any risk you see was decided by the
deterministic engine reading that stream, exactly as it would for real hardware.

A scenario result is held on screen for 60 s so judges can read it; live mock
telemetry then resumes automatically.

---

## API

| Method | Endpoint | Purpose |
|---|---|---|
| GET  | `/api/status` | current state, risk, evidence, mode |
| POST | `/api/telemetry` | push one live telemetry packet |
| GET  | `/api/history` | recent telemetry rows (drives the Trend chart) |
| GET  | `/api/events` | event log, acks, ledger chain check |
| POST | `/api/simulate/{id}` | run a scenario through the live pipeline |
| POST | `/api/acknowledge` | record a verified / unverified ack |

Telemetry shape:

```json
{"timestamp":"ISO-8601","temp":28.5,"rh":78.0,"fork_raw":1023,"ldr_raw":12,"distance_cm":15.0}
```

Missing or invalid fields are reported, never guessed, and never crash the app.

### Connect an IoT controller

The included [sketch.ino](./firmware/sketch/sketch.ino) runs on an Arduino UNO R4
Minima and emits one newline-terminated `DATA` record every second over
USB serial at **9600 baud**. GrainGuard accepts that firmware format directly:

```text
DATA,27.0,60.0,900,20,15.0
```

The fields after `DATA` are temperature, relative humidity, fork/proximity
reading, light reading and distance, in that order. The backend also accepts
newline-terminated JSON from other controllers, using the same field names and
units as the API:

```json
{"timestamp":"2026-10-06T11:00:00+05:30","temp":28.5,"rh":78.0,"fork_raw":1023,"ldr_raw":12,"distance_cm":15.0}
```

Map your sensor readings to `temp` in °C, `rh` in percent, `fork_raw` and
`ldr_raw` as 0–1023 ADC readings, and `distance_cm` in centimetres. The
controller firmware must perform any required sensor calibration; the backend
does not guess or calibrate hardware values.

Set `GRAINGUARD_SERIAL_PORT` to the controller's port (for example `COM5`) when
more than one serial device is attached. Otherwise, GrainGuard discovers a
connected serial port automatically. Each valid packet is run through the same
physics and deterministic risk engine as the dashboard scenarios, then saved
to the local SQLite telemetry history and hash chain. The dashboard refreshes
automatically. If the device is unplugged or stops sending packets, the
dashboard clearly marks the simulated fallback and the worker keeps retrying
the hardware connection.

For a Wi-Fi controller, POST the same JSON object to `/api/telemetry` with
`Content-Type: application/json`; it is also processed and saved immediately.
The server binds to `127.0.0.1` by default. For a trusted local network, set
`GRAINGUARD_HOST=0.0.0.0` and allow the chosen port through the host firewall;
the controller can then post to `http://<computer-lan-ip>:8000/api/telemetry`.

---

## How the decision is made

States: `S0_IDLE_SAFE`, `S1_ATMOSPHERIC_INGRESS`, `S2_DUNNAGE_SEEPAGE`,
`S3_PERMISSIBLE_AERATION`, `S4_PHYSICAL_ANOMALY`, `S5_CUMULATIVE_STRESS`,
`S6_OFFLINE`, `S7_AUDIT_ANOMALY`.

Rules are evaluated in a fixed order (thresholds live in
`data/facility_profile.json`):

1. cumulative moisture stress over limit → **S5 / CRITICAL**
2. `fork_raw < 300` → **S2 / HIGH**, aeration locked
3. headspace change > 5 cm → **S4 / MEDIUM-HIGH**, aeration locked
4. `ldr_raw >= 700` with RH still normal → **S4 / MEDIUM-HIGH**
5. `RH > 65%` or `EMC > 14%` → **S1 / HIGH**, aeration locked
6. `T > 28°C` and RH low and EMC safe and fork loaded → **S3 / MEDIUM**, aeration available
7. otherwise → **S0 / LOW**

> Note on ordering: a high-RH reading *explains* high light readings (an open
> shutter admits both light and damp air), so rule 4 is skipped when rule 5
> fires. A headspace movement is not explained by damp air, so rule 3 keeps
> priority.

**The SLM never decides risk, state, thresholds, cause, action or actuator
permission.** It only rewords the engine's output. If it is slow (>2 s),
missing or broken, a deterministic template is used and the UI is unaffected.

---

## What GrainGuard will never claim

- that a rodent, pest, fungus or groundwater was detected
- that it measured actual grain moisture content

EMC is an **estimate of the moisture the air would reach**, not a measurement of
the grain. Findings are phrased as *consistent with*, *possible*,
*inspect/verify*.

---

## Project layout

```
grain-guard/
├── firmware/            # Arduino UNO R4 Minima sketch
├── src/backend/
│   ├── main.py          # FastAPI: 6 endpoints, one shared pipeline
│   ├── physics.py       # EMC, dew point, Δheight, stress hours
│   ├── engine.py        # ordered rule engine -> state/risk/facts/interlock
│   ├── database.py      # SQLite WAL + hash-chained ledger
│   ├── slm_forensics.py # optional narrative, 2s timeout, hard fallback
│   ├── mock_data.py     # realistic mock telemetry for simulation mode
│   └── serial_worker.py # serial reader -> automatic mock fallback
├── src/frontend/        # index.html, styles.css, app.js (no frameworks)
├── data/                # scenarios, facility profile, SQLite ledger
├── run.py               # one-command boot
└── tests_check.py       # engine verification
```

Three.js is bundled locally for the optional 3D hardware viewer; its MIT
license is included under `src/frontend/vendor/LICENSES/`.

## Config (optional)

| Variable | Default | Meaning |
|---|---|---|
| `GRAINGUARD_PORT` | `8000` | server port |
| `GRAINGUARD_HOST` | `127.0.0.1` | bind address; use `0.0.0.0` for LAN devices |
| `GRAINGUARD_SERIAL_PORT` | auto | e.g. `COM5` |
| `GRAINGUARD_SERIAL_BAUD` | `9600` | serial baud rate |
| `GRAINGUARD_SERIAL_RETRY_SECONDS` | `5` | wait between connection attempts |
| `GRAINGUARD_SERIAL_STALE_SECONDS` | `15` | switch to fallback after no valid packet |
| `GRAINGUARD_SLM` | `1` | set `0` to disable the SLM entirely |
| `GRAINGUARD_SLM_URL` | Ollama | local SLM endpoint |

Arduino serial readings are processed directly by the deterministic risk
engine and saved to the local SQLite ledger. Use the **Download audit PDF**
control in the console to export the latest readings, decisions, alert causes,
event history, operator acknowledgments, and ledger-integrity status. The
export includes the newest 500 telemetry records and newest 500 events (plus
all acknowledgments); the report states the full record counts.

The board's built-in LED turns on only when the backend confirms a complete,
valid, low-risk reading. The firmware reports a failed DHT11 read as `-999.0`
and an ultrasonic timeout as `-1.0`. The backend marks those channels invalid
instead of treating them as sensor values, and the LED stays off.
At the start of a live run, the first valid ultrasonic reading establishes a
fresh headspace baseline while the earlier audit history is retained.