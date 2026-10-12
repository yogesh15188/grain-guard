/* GrainGuard — viewer3d.js
 * Interactive 3D hardware model: Arduino UNO R3 + DHT11 / LDR module /
 * fork probe / HC-SR04, driven either by the FastAPI backend (LIVE) or by a
 * self-contained local mirror of physics.py + engine.py + mock_data.py
 * (MIRROR) so the page works with zero backend running.
 *
 * Assembled layout:
 *   [glue]  shared helpers/state used by every part
 *   P1      [[PURE-START]] .. [[PURE-END]]  pure mirror (Node-testable)
 *   P3      HUD, controls, simulation loop, backend mode
 *   P2      Three.js scene (dynamic import, failure-tolerant)
 *   tail    boot()
 */

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmt(v, nd = 1, dash = '—') {
  if (v === null || v === undefined || !isFinite(Number(v))) return dash;
  return Number(v).toFixed(nd);
}

const RISK_CLASS = {
  LOW: 'risk-low',
  MEDIUM: 'risk-med',
  'MEDIUM-HIGH': 'risk-high',
  HIGH: 'risk-high',
  CRITICAL: 'risk-crit',
};

function band(v, lim) {
  if (v == null) return '';
  return v > lim + 1 ? 'bad' : v > lim ? 'warn' : 'ok';
}

const BAND_COLOR = { ok: '#2f9e61', warn: '#d98a1d', bad: '#d64545', '': '#8a93a3' };

let sceneApi = null;                 // P2 assigns {update, setWires, resetView, focus, applyTheme}
let flashPacket = () => {};          // P2 replaces it to pulse the UNO TX/RX LEDs
const labelEls = {};                 // P3 creates the .slabel nodes; P2 positions them each frame
let labelsOn = true;
let selKey = null;
let DEFAULT_CTL_NOTE = '';
let DEFAULT_SIM_NOTE = '';

// ================= P1 · pure mirror (physics + engine + mock) =================
// [[PURE-START]]
/* P1 · pure mirror of backend physics.py + engine.py + mock_data.py.
 * No DOM, no imports — plain module-scope declarations only.
 * Rule/evidence strings must stay byte-identical to engine.py. */

/* --- Python-compatible decimal helpers --------------------------------
 * Python's round()/format() round half-to-even on the exact binary value;
 * JS toFixed() rounds ties up. These use exact BigInt decimal expansion so
 * e.g. r2(11.125) === 11.12 like Python, not 11.13 like toFixed. */
const _p1dv = new DataView(new ArrayBuffer(8));

function _decExact(x) { // |x| = digits * 10^exp10, exact (x >= 0, finite)
  _p1dv.setFloat64(0, x);
  const hi = _p1dv.getUint32(0), lo = _p1dv.getUint32(4);
  const be = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e2;
  if (be === 0) { e2 = -1074; }
  else { m |= 1n << 52n; e2 = be - 1075; }
  if (m === 0n) return { digits: 0n, exp10: 0 };
  if (e2 >= 0) return { digits: m << BigInt(e2), exp10: 0 };
  return { digits: m * 5n ** BigInt(-e2), exp10: e2 };
}

function _decRound(x, nd) { // q such that |x| ≈ q * 10^-nd, half-even
  const { digits, exp10 } = _decExact(x);
  if (digits === 0n) return 0n;
  const k = exp10 + nd;
  if (k >= 0) return digits * 10n ** BigInt(k);
  const s = 10n ** BigInt(-k);
  const base = digits / s, rem = digits % s, twice = rem * 2n;
  if (twice > s || (twice === s && (base & 1n) === 1n)) return base + 1n;
  return base;
}

function _pyRound(x, nd) { // Python round(x, nd)
  if (!Number.isFinite(x)) return x;
  const neg = x < 0 || Object.is(x, -0);
  const v = Number(_decRound(Math.abs(x), nd)) / Math.pow(10, nd);
  return neg ? -v : v;
}

function r2(x) { return _pyRound(x, 2); }

function fNum(x, nd = 1) { // Python f"{x:.{nd}f}"
  if (x === null || x === undefined || Number.isNaN(x)) return String(x);
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  const neg = x < 0 || Object.is(x, -0);
  let s = _decRound(Math.abs(x), nd).toString();
  if (nd > 0) {
    if (s.length <= nd) s = s.padStart(nd + 1, '0');
    const cut = s.length - nd;
    s = s.slice(0, cut) + '.' + s.slice(cut);
  }
  return (neg ? '-' : '') + s;
}

function signed1(v, nd = 1) { // Python f"{v:+.{nd}f}"
  return (v > 0 || Object.is(v, 0) ? '+' : '') + fNum(v, nd);
}

function pyNum(x) { // Python str(float): 65 -> "65.0", 13.5 -> "13.5"
  const n = Number(x);
  if (Number.isInteger(n)) return n.toFixed(1);
  return String(n);
}

function fmtP(v, unit = '', nd = 1) { // Python engine._fmt
  return (v === null || v === undefined) ? 'unavailable' : fNum(v, nd) + unit;
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function _num(v, lo, hi) { // Python engine._num (bools/NaN/out-of-range rejected)
  return typeof v === 'number' && !Number.isNaN(v) && v >= lo && v <= hi;
}

/* --- facility profile defaults (data/facility_profile.json) ------------ */
const DEF_LIMITS = {
  fork_low: 300,
  fork_loaded: 600,
  ldr_anomaly: 700,
  delta_height_cm: 5.0,
  rh_limit: 65.0,
  emc_ingress: 14.0,
  emc_aeration: 13.5,
  temp_limit: 28.0,
  moisture_stress_limit_h: 24.0,
};
const DEF_BASELINE = 15.0;

/* --- engine constants (engine.py) ------------------------------------- */
const FORK_LOW = 300;
const FORK_LOADED = 600;
const LDR_ANOMALY = 700;
const DELTA_HEIGHT_CM = 5.0;
const RH_LIMIT = 65.0;
const EMC_INGRESS = 14.0;
const EMC_AERATION = 13.5;
const TEMP_LIMIT = 28.0;
const MOISTURE_STRESS_LIMIT_H = 24.0;

const S0 = 'S0_IDLE_SAFE';
const S1 = 'S1_ATMOSPHERIC_INGRESS';
const S2 = 'S2_DUNNAGE_SEEPAGE';
const S3 = 'S3_PERMISSIBLE_AERATION';
const S4 = 'S4_PHYSICAL_ANOMALY';
const S5 = 'S5_CUMULATIVE_STRESS';
const S6 = 'S6_OFFLINE';
const S7 = 'S7_AUDIT_ANOMALY';

const RISK_RANK = { LOW: 0, MEDIUM: 1, 'MEDIUM-HIGH': 2, HIGH: 3, CRITICAL: 4 };

/* --- physics (physics.py) --------------------------------------------- */
const EMC_A = 4.85;
const EMC_B = 0.13;
const EMC_C = -0.05;
const EMC_TREF = 25.0;
const EMC_MIN = 5.0;
const EMC_MAX = 20.0;

function calculate_emc(temp_c, rh_pct) {
  if (!_num(temp_c, -10.0, 70.0) || !_num(rh_pct, 0.0, 100.0)) return null;
  const emc = EMC_A + EMC_B * rh_pct + EMC_C * (temp_c - EMC_TREF);
  return r2(Math.min(Math.max(emc, EMC_MIN), EMC_MAX));
}

function calculate_dew_point(temp_c, rh_pct) {
  if (!_num(temp_c, -10.0, 70.0) || !_num(rh_pct, 1.0, 100.0)) return null;
  const a = 17.27, b = 237.7;
  const gamma = (a * temp_c) / (b + temp_c) + Math.log(rh_pct / 100.0);
  return r2((b * gamma) / (a - gamma));
}

function calculate_delta_height(current_cm, baseline_cm) {
  if (!_num(current_cm, 0.0, 1000.0) || !_num(baseline_cm, 0.0, 1000.0)) return null;
  return r2(current_cm - baseline_cm);
}

function update_stress(moisture_hours, thermal_hours, temp_c, rh_pct, emc,
                       dt_seconds, rh_limit = 65.0, temp_limit = 28.0, emc_limit = 14.0) {
  const dt_h = Math.max(0.0, dt_seconds || 0.0) / 3600.0;
  let m = Math.max(0.0, Number(moisture_hours) || 0.0);
  let t = Math.max(0.0, Number(thermal_hours) || 0.0);
  const moist_risk = (_num(rh_pct, 0, 100) && rh_pct > rh_limit) ||
                     (_num(emc, EMC_MIN, EMC_MAX) && emc > emc_limit);
  if (moist_risk) m += dt_h;
  if (_num(temp_c, -10.0, 70.0) && temp_c > temp_limit) t += dt_h;
  return [r2(m), r2(t)];
}

function describe_interlock(aeration_allowed) {
  return aeration_allowed ? 'AVAILABLE - HUMAN VERIFICATION REQUIRED' : 'LOCKED';
}

/* --- cumulative stress tracker ---------------------------------------- */
function makeStress() {
  return { moistureHours: 0.0, thermalHours: 0.0, last: null };
}

function stressUpdate(st, temp, rh, emc, limits, dtOverride) {
  if (!st) return [0, 0];
  limits = limits || {};
  let dt;
  if (dtOverride === undefined || dtOverride === null) {
    dt = st.last == null ? 0.0 : (Date.now() - st.last) / 1000;
  } else {
    dt = Number(dtOverride);
    if (!Number.isFinite(dt)) dt = 0.0;
  }
  dt = Math.min(60.0, Math.max(0.0, dt)); // cap so a gap cannot inflate hours
  const acc = update_stress(st.moistureHours, st.thermalHours, temp, rh, emc, dt,
    limits.rh_limit ?? RH_LIMIT, limits.temp_limit ?? TEMP_LIMIT,
    limits.emc_limit ?? EMC_INGRESS);
  st.moistureHours = acc[0];
  st.thermalHours = acc[1];
  st.last = Date.now();
  return acc;
}

/* --- deterministic engine (engine.py, exact branch order) -------------- */
function evaluate(t, baseline_cm = null, limits = null, stress = null, dtOverride = null) {
  t = t || {};
  limits = limits || {};
  const fork_low = limits.fork_low ?? FORK_LOW;
  const fork_loaded = limits.fork_loaded ?? FORK_LOADED;
  const ldr_anom = limits.ldr_anomaly ?? LDR_ANOMALY;
  const dh_limit = limits.delta_height_cm ?? DELTA_HEIGHT_CM;
  const rh_limit = limits.rh_limit ?? RH_LIMIT;
  const emc_ingress = limits.emc_ingress ?? EMC_INGRESS;
  const emc_aeration = limits.emc_aeration ?? EMC_AERATION;
  const temp_limit = limits.temp_limit ?? TEMP_LIMIT;
  const stress_limit = limits.moisture_stress_limit_h ?? MOISTURE_STRESS_LIMIT_H;

  const temp = _num(t.temp, -10.0, 70.0) ? t.temp : null;
  const rh = _num(t.rh, 0.0, 100.0) ? t.rh : null;
  const fork = _num(t.fork_raw, 0, 1023) ? t.fork_raw : null;
  const ldr = _num(t.ldr_raw, 0, 1023) ? t.ldr_raw : null;
  const dist = _num(t.distance_cm, 0.0, 1000.0) ? t.distance_cm : null;
  const invalid = [];
  if (temp === null) invalid.push('temp');
  if (rh === null) invalid.push('rh');
  if (fork === null) invalid.push('fork_raw');
  if (ldr === null) invalid.push('ldr_raw');
  if (dist === null) invalid.push('distance_cm');

  // --- PHYSICS ---
  const emc = (temp !== null && rh !== null) ? calculate_emc(temp, rh) : null;
  const dew = (temp !== null && rh !== null) ? calculate_dew_point(temp, rh) : null;
  const delta_h = (dist !== null && baseline_cm !== null && baseline_cm !== undefined)
    ? calculate_delta_height(dist, baseline_cm) : null;
  const stressAcc = stressUpdate(stress, temp, rh, emc, limits, dtOverride);
  const m_h = stressAcc[0], t_h = stressAcc[1];

  let state = S0, risk = 'LOW', aeration_ok = false;
  let rule = '', evidence = [], checks = [];
  let headline = 'STORAGE NORMAL';
  let plain = 'Air in the bin is within configured limits. Nothing needs attention.';

  // S5 outranks active conditions once cumulative time is critical.
  if (m_h >= stress_limit) {
    state = S5; risk = 'CRITICAL';
    rule = `cumulative moisture stress ${fNum(m_h, 1)} h >= ${pyNum(stress_limit)} h limit`;
    evidence = [
      `Moisture-stress hours accumulated: ${fNum(m_h, 1)} h`,
      `Configured escalation limit: ${pyNum(stress_limit)} h`,
      'Long exposure, not a single spike, drives this escalation',
    ];
    checks = [
      'Escalate to the manager on duty now',
      'Re-check shutters, roof gaps and drainage around the bin',
      'Plan controlled drying or shifting once conditions improve',
    ];
    headline = 'LONG-TERM MOISTURE STRESS';
    plain = 'Damp air has been sitting around this bin for a long time now. ' +
            'Please call the manager now.';

  } else if (fork !== null && fork < fork_low) {
    state = S2; risk = 'HIGH';
    rule = `fork_raw ${fNum(fork, 0)} < ${fork_low} -> object/proximity at bin wall`;
    evidence = [
      `Fork/proximity sensor raw: ${fNum(fork, 0)} (limit ${fork_low})`,
      'Consistent with something close to the wall or floor probe',
      'Channel no longer shows a loaded grain surface',
    ];
    checks = [
      'Walk to the bin wall and look for a water seep or leak',
      'Inspect floor contact and the dunnage / wooden supports',
      'Look for an animal entry hole by eye - this sensor does not identify animals',
    ];
    headline = 'WATER OR SEEPAGE NEAR WALL';
    plain = 'Something is very close to the side of the bin. This looks like ' +
            'water leaking in near the wall. Please go and see the wall.';

  } else if (delta_h !== null && delta_h > dh_limit) {
    // Headspace movement is evaluated before the humidity rules: a level change
    // is unexplained by damp air and needs its own evidence trail.
    state = S4; risk = 'MEDIUM-HIGH';
    rule = `headspace change ${signed1(delta_h)} cm > ${pyNum(dh_limit)} cm limit`;
    evidence = [
      `Headspace reading ${fNum(dist, 1)} cm vs baseline ${fNum(baseline_cm, 1)} cm`,
      `Change of ${signed1(delta_h)} cm exceeds the ${pyNum(dh_limit)} cm limit`,
      'Consistent with stock displacement or settling, or a moved surface probe',
      'Unexpected stock displacement / headspace change - not an identification of cause',
    ];
    checks = [
      'Go to the bin and visually confirm the grain surface level',
      'Check whether shutters or doors were left open',
      'Confirm the distance probe has not been shifted or knocked',
    ];
    headline = 'UNEXPECTED STOCK / HEADSPACE CHANGE';
    plain = 'The grain level or the light inside the bin changed suddenly. ' +
            'Something may have moved. Please check the bin yourself.';

  } else if (ldr !== null && ldr >= ldr_anom && !(rh !== null && rh > rh_limit)) {
    // Standalone light ingress with no headspace move and no humidity breach.
    // When RH is also high, the S1 branch above wins: damp air explains the light.
    state = S4; risk = 'MEDIUM-HIGH';
    rule = `ldr_raw ${fNum(ldr, 0)} >= ${ldr_anom} -> abrupt light ingress at shutter`;
    evidence = [
      `Light sensor raw: ${fNum(ldr, 0)} (limit ${ldr_anom})`,
      'Consistent with a shutter or opening being left open, or direct light on the sensor',
      `Relative humidity ${fmtP(rh, '%')} is not above the ${pyNum(rh_limit)}% ingress limit`,
    ];
    checks = [
      'Go to the bin and confirm whether a shutter or door was left open',
      'Check that the bin is not in direct afternoon sun',
      'Note the time so you can compare it against any change in humidity',
    ];
    headline = 'UNEXPECTED LIGHT / HEADSPACE CHANGE';
    plain = 'There is a lot of light inside the bin now. Something may have been ' +
            'left open. Please go and check the shutters.';

  } else if ((rh !== null && rh > rh_limit) || (emc !== null && emc > emc_ingress)) {
    state = S1; risk = 'HIGH';
    if (rh !== null && rh > rh_limit) {
      rule = `RH ${fNum(rh, 1)}% > ${pyNum(rh_limit)}% limit -> atmospheric moisture ingress`;
      evidence = [
        `Relative humidity: ${fNum(rh, 1)}% (limit ${pyNum(rh_limit)}%)`,
        `EMC estimate: ${fmtP(emc, '%')}`,
        `Dew point: ${fmtP(dew, ' C')}`,
        'High humidity at this temperature is consistent with moist air entering the bin',
      ];
    } else {
      rule = `EMC estimate ${pyNum(emc)}% > ${pyNum(emc_ingress)}% limit -> atmospheric moisture ingress`;
      evidence = [
        `EMC estimate: ${pyNum(emc)}% (limit ${pyNum(emc_ingress)}%)`,
        `Relative humidity: ${fmtP(rh, '%')}`,
        'EMC above limit is consistent with air that can keep the grain damp',
      ];
    }
    checks = [
      'Walk the shed and look for open shutters, roof gaps or broken mesh',
      'Check that vents and louvres are closed and the seals are intact',
      'Verify the DHT11 is not near an open window or a wet wall',
    ];
    headline = 'HIGH HUMIDITY - CHECK SHUTTERS';
    plain = 'The air inside is too wet. Wet air can spoil grain. ' +
            'Please check the shutters, roof and vents for gaps.';

  } else if (temp !== null && temp > temp_limit && rh !== null && rh <= rh_limit &&
             emc !== null && emc <= emc_aeration && fork !== null && fork >= fork_loaded) {
    state = S3; risk = 'MEDIUM'; aeration_ok = true;
    rule = `T ${fNum(temp, 1)}C > ${pyNum(temp_limit)}C with RH ${fNum(rh, 1)}% <= ${pyNum(rh_limit)}%, ` +
           `EMC ${pyNum(emc)}% <= ${pyNum(emc_aeration)}% and fork_raw ${fNum(fork, 0)} >= ${fork_loaded}`;
    evidence = [
      `Temperature: ${fNum(temp, 1)} C (limit ${pyNum(temp_limit)} C)`,
      `Relative humidity: ${fNum(rh, 1)}% - air is dry enough`,
      `EMC estimate: ${pyNum(emc)}% - below the ${pyNum(emc_aeration)}% safe limit`,
      `Fork/proximity raw: ${fNum(fork, 0)} - grain surface present and loaded`,
      'Conditions are consistent with a safe, gentle aeration window',
    ];
    checks = [
      'Confirm the fan and duct are clear before starting',
      'Start aeration for a short trial and watch the bin surface',
      'Record the start time and stop if humidity rises',
    ];
    headline = 'SAFE AERATION WINDOW';
    plain = 'The air is dry and the grain is not warm enough to harm. ' +
            'This is a good time to run the fan, if you are satisfied it is safe.';

  } else {
    rule = 'all readings within configured limits';
    evidence = [
      `Temperature: ${fmtP(temp, ' C')} within limit`,
      `Relative humidity: ${fmtP(rh, '%')} within limit`,
      `EMC estimate: ${fmtP(emc, '%')}`,
      `Fork/proximity raw: ${fmtP(fork, '', 0)} - grain surface present`,
    ];
  }

  if (invalid.length) evidence.push('Invalid or missing channels: ' + invalid.join(', '));

  return {
    state, risk,
    risk_rank: RISK_RANK[risk] ?? 0,
    headline, rule, evidence, checks,
    aeration_allowed: aeration_ok,
    aeration: describe_interlock(aeration_ok),
    facts: {
      temp, rh, emc_estimate: emc, dew_point: dew,
      fork_raw: fork, ldr_raw: ldr, distance_cm: dist,
      delta_height_cm: delta_h,
      moisture_stress_hours: m_h, thermal_stress_hours: t_h,
    },
    invalid_channels: invalid,
    plain_summary: plain,
  };
}

function evaluate_offline(last_result, seconds_since_last) {
  const out = Object.assign({}, last_result || {});
  const secs = Number(seconds_since_last) || 0;
  out.state = S6;
  out.risk = out.risk || 'MEDIUM-HIGH';
  out.headline = 'TELEMETRY OFFLINE';
  out.rule = `no telemetry received for ${fNum(secs, 0)}s -> S6_OFFLINE`;
  out.evidence = [
    'No live telemetry packet received from the edge node',
    `Last reading is ${fNum(secs, 0)}s old and is shown for reference only`,
    'Values shown are the last known values, not current readings',
  ];
  out.aeration_allowed = false;
  out.aeration = describe_interlock(false);
  out.plain_summary = 'The monitoring box has stopped sending readings. ' +
                      'The numbers shown are old. Please check the unit and power.';
  out.facts = out.facts || {};
  out.invalid_channels = out.invalid_channels || [];
  out.risk_rank = RISK_RANK[out.risk] ?? 2;
  return out;
}

/* --- mock telemetry (mock_data.py) ------------------------------------- */
const MOCK_BASE = {
  temp: 27.2,      // bin interior
  rh: 61.0,
  fork_raw: 900,   // grain surface present and loaded
  ldr_raw: 22,     // shutter closed, bin dark
  distance_cm: 15.0,
};
const _BIN_SWING_C = 1.6;
const _BIN_LAG_H = 2.5;
const _PEAK_HOUR = 15.0;
const _RH_BASE = 63.0;
const _RH_TEMP_COUPLING = -1.15;
const _RH_DRIFT_PCT = 2.5;
const _EP_START_CHANCE = 0.0016;
const _EP_RAMP_S = 90.0;
const _EP_HOLD_MIN_S = 150.0;
const _EP_HOLD_MAX_S = 420.0;
const _EP_DECAY_S = 240.0;

function _mkRand(seed) { // mulberry32 — Python random.Random is not replicable
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function _hourOfDay(now) { // IST hour + minutes as fraction
  const d = new Date((now + 19800) * 1000); // +5:30 in seconds
  return d.getUTCHours() + d.getUTCMinutes() / 60.0;
}

function _diurnal(hour, lag_h = 0.0) { // -1 at daily min, +1 at daily peak
  return Math.cos(2.0 * Math.PI * (hour - _PEAK_HOUR + lag_h) / 24.0);
}

function _istStamp(now) {
  const d = new Date(now * 1000 + 19800000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
         `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+05:30`;
}

class MockGen {
  constructor(base = null, seed = null, start_ts = null) {
    this.base = Object.assign({}, MOCK_BASE);
    if (base) {
      for (const k of Object.keys(base)) {
        if (k in MOCK_BASE) this.base[k] = Number(base[k]);
      }
    }
    const s = (seed === null || seed === undefined)
      ? ((Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0)
      : (Number(seed) >>> 0);
    this._rand = _mkRand(s);
    this.start_ts = (start_ts === null || start_ts === undefined) ? Date.now() / 1000 : start_ts;
    this.steps = 0;
    this._phase = this._rand() * 6.28;
    this._drift = 0.0;
    this._episode = null; // null, or gains + envelope timers
  }

  get in_episode() { return this._episode !== null; }

  _gauss(mu, sigma) { // Box–Muller (stream parity with Python not required)
    let u = 0, v = 0;
    while (u === 0) u = this._rand();
    while (v === 0) v = this._rand();
    return mu + sigma * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  _maybeStartEpisode() {
    if (this._episode !== null) return;
    if (this._rand() >= _EP_START_CHANCE) return;
    this._episode = {
      rh_gain: 18.0 + this._rand() * 10.0,       // uniform(18, 28)
      temp_drop: 1.4 + this._rand() * 1.6,        // uniform(1.4, 3.0)
      ldr_gain: 450 + this._rand() * 410,         // uniform(450, 860)
      t_ramp: 0.0,
      t_hold: _EP_HOLD_MIN_S + this._rand() * (_EP_HOLD_MAX_S - _EP_HOLD_MIN_S),
      t_decay: 0.0,
    };
  }

  _episodeStrength(dt) { // advance the envelope, return 0..1 strength
    const ep = this._episode;
    if (ep === null) return 0.0;
    ep.t_ramp += dt;
    if (ep.t_ramp < _EP_RAMP_S) return ep.t_ramp / _EP_RAMP_S;
    ep.t_hold -= dt;
    if (ep.t_hold > 0) return 1.0;
    ep.t_decay += dt;
    if (ep.t_decay < _EP_DECAY_S) return 1.0 - (ep.t_decay / _EP_DECAY_S);
    this._episode = null;
    return 0.0;
  }

  step(dt = 1.0, now = null) { // advance dt seconds, return one telemetry packet
    dt = Math.max(0.0, Number(dt) || 0.0);
    this.steps += 1;
    now = (now === null || now === undefined) ? Date.now() / 1000 : now;
    this._phase += dt / 90.0;

    // Slow synoptic wander, clamped so it cannot run away.
    this._drift = clamp(this._drift + ((this._rand() - 0.5) * 0.5) * dt / 60.0,
      -_RH_DRIFT_PCT, _RH_DRIFT_PCT);

    this._maybeStartEpisode();
    const strength = this._episodeStrength(dt);
    const ep = this._episode;
    const gain = (k) => (ep ? ep[k] : 0.0);

    // Bin temperature: damped, lagged diurnal swing minus ingress cooling.
    let temp = this.base.temp + _BIN_SWING_C * _diurnal(_hourOfDay(now), -_BIN_LAG_H);
    temp += 0.12 * Math.sin(this._phase);
    temp -= gain('temp_drop') * strength;

    // RH rises as temperature falls, plus slow drift and any ingress.
    let rh = _RH_BASE + _RH_TEMP_COUPLING * (temp - this.base.temp) + this._drift;
    rh += gain('rh_gain') * strength;

    // Raw channels behave like real ADC reads: quantised, with read noise.
    const fork = this.base.fork_raw + this._gauss(0.0, 6.0);
    const ldr = this.base.ldr_raw + Math.abs(this._gauss(0.0, 3.0)) + gain('ldr_gain') * strength;
    const dist = this.base.distance_cm + this._gauss(0.0, 0.06) - 0.9 * strength;

    return {
      timestamp: _istStamp(now),
      temp: r2(clamp(temp, -10.0, 70.0)),
      rh: r2(clamp(rh, 0.0, 100.0)),
      fork_raw: Math.trunc(clamp(_pyRound(fork, 0), 0, 1023)),
      ldr_raw: Math.trunc(clamp(_pyRound(ldr, 0), 0, 1023)),
      distance_cm: r2(clamp(dist, 0.0, 1000.0)),
    };
  }
}

/* --- canned scenarios (data/scenarios.json) ---------------------------- */
const SCENARIOS = {
  normal: {
    label: 'Normal',
    expect: 'S0_IDLE_SAFE / LOW',
    telemetry: { temp: 26.0, rh: 58.0, fork_raw: 880, ldr_raw: 24, distance_cm: 15.0 },
  },
  humidity_intrusion: {
    label: 'Humidity Intrusion',
    expect: 'S1_ATMOSPHERIC_INGRESS / HIGH / aeration locked',
    telemetry: { temp: 27.8, rh: 86.4, fork_raw: 1023, ldr_raw: 840, distance_cm: 15.0 },
  },
  dunnage_seepage: {
    label: 'Dunnage Seepage',
    expect: 'S2_DUNNAGE_SEEPAGE / HIGH / aeration locked',
    telemetry: { temp: 26.5, rh: 61.2, fork_raw: 190, ldr_raw: 32, distance_cm: 15.2 },
  },
  stock_anomaly: {
    label: 'Stock Anomaly',
    expect: 'S4_PHYSICAL_ANOMALY / MEDIUM-HIGH',
    telemetry: { temp: 28.2, rh: 63.5, fork_raw: 1023, ldr_raw: 28, distance_cm: 23.8 },
  },
  offline: {
    label: 'Offline',
    expect: 'S6_OFFLINE',
    telemetry: null,
  },
  unverified_ack: {
    label: 'Unverified Acknowledgment',
    expect: 'S7_AUDIT_ANOMALY',
    telemetry: { temp: 28.5, rh: 78.0, fork_raw: 1023, ldr_raw: 12, distance_cm: 15.0 },
  },
};
// [[PURE-END]]

// ================= P3 · HUD, simulation, backend mode =================
/* ================================================================
 * P3 — HUD rendering, controls, local simulation loop, backend mode
 * Assembled between P1 (pure mirror) and P2 (Three.js scene).
 * Uses only glue helpers ($, esc, fmt, RISK_CLASS, band, BAND_COLOR,
 * sceneApi, flashPacket, labelEls, labelsOn, selKey, DEFAULT_* notes)
 * and P1/P2 functions — nothing here is redeclared from those parts.
 * ================================================================ */

/* ---------------- state ---------------- */
let mode = 'mirror';                    // 'mirror' | 'live'
let playing = true;
let speed = 1;
let LIMITS = Object.assign({}, DEF_LIMITS);
let BASELINE = DEF_BASELINE;
let mock = new MockGen();
let stress = makeStress();
let lastResult = null;
let lastEvalMs = Date.now();
let hold = null;                        // active 60 s fault hold (mirror mode)
let liveHoldSec = 0;                    // backend sim_hold_seconds
let pollTimer = null;
let probeTimer = null;
let pipeLast = 0;
let pipeTimers = [];
let simAcc = 0;                         // mirror sim seconds accumulated this frame

const IST = { timeZone: 'Asia/Kolkata' };

/* Representative pin map — keys are exactly what P2's raycaster uses:
   uno, dht, ldr, fork, sonic. No firmware pin map exists in the repo. */
const SENSOR_DEFS = {
  uno: {
    name: 'Arduino UNO R3',
    pin: 'ATmega328P · 16 MHz',
    role: 'Edge node — samples sensors, runs the rule mirror',
  },
  dht: {
    name: 'DHT11',
    pin: 'D2 (digital)',
    role: 'Bin air — temperature & relative humidity',
  },
  ldr: {
    name: 'LDR module',
    pin: 'A0 (analog)',
    role: 'Shutter light ingress',
  },
  fork: {
    name: 'Fork probe',
    pin: 'A1 (analog)',
    role: 'Wall proximity / dunnage probe',
  },
  sonic: {
    name: 'HC-SR04',
    pin: 'D3 trig / D4 echo',
    role: 'Headspace → stock level',
  },
};

/* ---------------- clocks (verbatim app.js idiom) ---------------- */
function tickClock() {
  const now = new Date();
  const time = now.toLocaleTimeString('en-GB', { ...IST, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const full = `${now.toLocaleDateString('en-GB', { ...IST, day: '2-digit', month: 'short', year: 'numeric' })} • ${time} IST`;
  $('clock').textContent = full;
  $('clock2').textContent = full;
}

/* ---------------- theme ---------------- */
function toggleTheme(btn) {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('gg-theme', next);
  btn.classList.add('flip');
  setTimeout(() => btn.classList.remove('flip'), 420);
  if (sceneApi?.applyTheme) sceneApi.applyTheme();
}

/* ---------------- mode flags (.cbarmode .hwflag / .modepill) ---------------- */
function setModeFlags(m, payload) {
  const bar = document.querySelector('.cbarmode');
  if (!bar) return;
  const hw = bar.querySelector('.hwflag');
  const pill = bar.querySelector('.modepill');
  if (!hw || !pill) return;

  if (m === 'mirror') {
    hw.textContent = 'OFFLINE — NO BACKEND';
    hw.classList.remove('ok');
    pill.textContent = 'LOCAL MIRROR';
    pill.className = 'modepill sim';
    return;
  }

  const detail = (payload && payload.source_detail) || '';
  if (/HARDWARE OFFLINE/i.test(detail)) {
    hw.textContent = 'HARDWARE OFFLINE — SIMULATION MODE';
    hw.classList.remove('ok');
  } else if (/connected/i.test(detail)) {
    hw.textContent = 'HARDWARE LIVE';
    hw.classList.add('ok');
  } else {
    hw.textContent = 'MOCK TELEMETRY — SIMULATION MODE';
    hw.classList.remove('ok');
  }
  hw.title = detail;

  const md = (payload && payload.mode) || 'SIMULATION';
  pill.textContent = md;
  pill.className = 'modepill ' + (md === 'LIVE' ? 'live' : md === 'OFFLINE' ? 'off' : 'sim');
}

/* ---------------- legend (stage overlay) ---------------- */
function buildLegend() {
  const rows = [
    ['temp', 'TEMP'],
    ['rh', 'RH'],
    ['fork', 'FORK'],
    ['ldr', 'LDR'],
    ['dist', 'DIST'],
  ];
  $('legend').innerHTML = rows.map(([k, label]) =>
    `<div class="lg" data-k="${k}"><span class="sw"></span>${label}<b>—</b></div>`).join('');
}

function legendVal(k, f) {
  if (k === 'temp') return fmt(f.temp) + '°C';
  if (k === 'rh') return fmt(f.rh) + '%';
  if (k === 'fork') return fmt(f.fork_raw, 0);
  if (k === 'ldr') return fmt(f.ldr_raw, 0);
  if (k === 'dist') return fmt(f.distance_cm) + 'cm';
  return '—';
}

/* Same thresholds as the metric cards; LIMITS where available. */
function legendBand(k, f) {
  if (k === 'temp') return band(f.temp, LIMITS.temp_limit ?? 28);
  if (k === 'rh') return band(f.rh, LIMITS.rh_limit ?? 65);
  if (k === 'fork') {
    const v = f.fork_raw;
    if (v == null) return '';
    return v < (LIMITS.fork_low ?? 300) ? 'bad' : v < (LIMITS.fork_loaded ?? 600) ? 'warn' : 'ok';
  }
  if (k === 'ldr') {
    const v = f.ldr_raw;
    if (v == null) return '';
    return v >= (LIMITS.ldr_anomaly ?? 700) ? 'bad' : v >= 420 ? 'warn' : 'ok';
  }
  if (k === 'dist') {
    const dh = f.delta_height_cm;
    if (dh == null) return '';
    const lim = LIMITS.delta_height_cm ?? 5;
    return dh > lim ? 'bad' : dh > lim / 2 ? 'warn' : 'ok';
  }
  return '';
}

function updateLegend(f) {
  ['temp', 'rh', 'fork', 'ldr', 'dist'].forEach((k) => {
    const row = document.querySelector(`#legend .lg[data-k="${k}"]`);
    if (!row) return;
    const b = legendBand(k, f);
    row.classList.toggle('hot', b === 'bad');
    const sw = row.querySelector('.sw');
    const color = BAND_COLOR[b] || BAND_COLOR[''];
    sw.style.background = color;
    sw.style.color = color;
    const val = row.querySelector('b');
    if (val) val.textContent = legendVal(k, f);
  });
}

/* ---------------- sensor labels ---------------- */
function buildLabelLayer() {
  const host = $('labels');
  if (!host) return;
  Object.keys(SENSOR_DEFS).forEach((key) => {
    const el = document.createElement('div');
    el.className = 'slabel';
    el.dataset.key = key;
    host.appendChild(el);
    labelEls[key] = el;
  });
}

function labelText(key, f) {
  if (key === 'dht') return `DHT11 · ${fmt(f.temp)} °C / ${fmt(f.rh, 0)} %`;
  if (key === 'ldr') return `LDR · raw ${fmt(f.ldr_raw, 0)}`;
  if (key === 'fork') return `Fork · raw ${fmt(f.fork_raw, 0)}`;
  if (key === 'sonic') return `HC-SR04 · ${fmt(f.distance_cm)} cm`;
  if (key === 'uno') return 'UNO R3 · edge node';
  return key;
}

function labelHot(key, f) {
  if (key === 'dht') return f.rh > (LIMITS.rh_limit ?? 65) || f.temp > (LIMITS.temp_limit ?? 28);
  if (key === 'ldr') return f.ldr_raw >= (LIMITS.ldr_anomaly ?? 700);
  if (key === 'fork') return f.fork_raw != null && f.fork_raw < (LIMITS.fork_low ?? 300);
  if (key === 'sonic') {
    const dh = f.delta_height_cm;
    return dh != null && Math.abs(dh) > (LIMITS.delta_height_cm ?? 5);
  }
  return false; // uno is never hot
}

function updateLabels(f, r) {
  Object.keys(labelEls).forEach((key) => {
    const el = labelEls[key];
    if (!el) return;
    el.classList.toggle('hot', labelHot(key, f));
    const txt = labelText(key, f);
    if (el.dataset.txt !== txt) {
      el.dataset.txt = txt;
      el.textContent = txt;
    }
  });
}

/* ---------------- selected-sensor panel ---------------- */
function readingFor(key, r) {
  const f = (r && r.facts) || {};
  if (key === 'dht') return `${fmt(f.temp)} °C · ${fmt(f.rh)} %RH`;
  if (key === 'ldr') return `raw ${fmt(f.ldr_raw, 0)} / 1023`;
  if (key === 'fork') return `raw ${fmt(f.fork_raw, 0)} / 1023`;
  if (key === 'sonic') {
    const dh = f.delta_height_cm;
    const signed = dh == null ? '—' : (dh > 0 ? '+' : '') + Number(dh).toFixed(1) + ' cm';
    return `${fmt(f.distance_cm)} cm · Δh ${signed}`;
  }
  if (key === 'uno') return `${mode === 'live' ? 'live backend' : 'local mirror'} · ${r?.state ?? 'idle'}`;
  return '—';
}

function updateSelPanel(r) {
  if (!selKey) {
    $('selTag').textContent = 'none';
    $('selText').textContent = 'Click a sensor in the scene to lock its readout and focus the camera.';
    return;
  }
  const d = SENSOR_DEFS[selKey];
  if (!d) {
    $('selTag').textContent = 'none';
    $('selText').textContent = 'Click a sensor in the scene to lock its readout and focus the camera.';
    return;
  }
  $('selTag').textContent = selKey;
  const rows = [
    ['Device', d.name],
    ['Role', d.role],
    ['Reading', readingFor(selKey, r)],
    ['Pin', d.pin],
  ];
  $('selText').innerHTML = rows.map(([k, v]) =>
    `<div class="selrow"><span class="muted">${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
}

/* P2's raycaster calls this; key is null when the empty scene is clicked. */
function selectSensor(key) {
  selKey = key;
  updateSelPanel(lastResult);
  Object.keys(labelEls).forEach((k) => {
    const el = labelEls[k];
    if (el) el.classList.toggle('on', k === key);
  });
  if (sceneApi?.focus) sceneApi.focus(key);
}

/* ---------------- pipeline animation ---------------- */
function runPipeline(force) {
  const now = Date.now();
  if (!force && now - pipeLast < 700) return;
  pipeLast = now;
  pipeTimers.forEach(clearTimeout);
  pipeTimers = [];

  const steps = Array.from(document.querySelectorAll('.pstep'));
  steps.forEach((s) => s.classList.remove('done', 'active'));
  steps.forEach((s, i) => {
    pipeTimers.push(setTimeout(() => {
      steps.forEach((o) => o.classList.remove('active'));
      s.classList.add('active');
    }, i * 260));
    pipeTimers.push(setTimeout(() => {
      s.classList.remove('active');
      s.classList.add('done');
    }, i * 260 + 420));
  });
}

/* ---------------- main HUD render ---------------- */
function renderHUD(r) {
  if (!r || !r.state) return;
  lastResult = r;
  const f = r.facts || {};

  $('shState').textContent = r.headline || '—';
  $('shSub').textContent = r.plain_summary || '';
  $('shCode').textContent = r.state || '';

  $('riskBox').className = 'riskbox ' + (RISK_CLASS[r.risk] || 'risk-low');
  const tag = $('riskBox').querySelector('.tag');
  if (tag) tag.textContent = mode === 'live' ? 'live' : 'mirror';
  $('riskValue').textContent = r.risk || '—';

  $('aerBox').className = 'aerbox ' + (r.aeration_allowed ? 'aer-ok' : 'aer-locked');
  $('aerValue').textContent = r.aeration_allowed
    ? 'AVAILABLE — HUMAN VERIFICATION REQUIRED'
    : 'LOCKED';

  const dh = f.delta_height_cm;
  const fork = f.fork_raw;
  const ldr = f.ldr_raw;
  const emc = f.emc_estimate;
  const dew = f.dew_point;
  const mH = f.moisture_stress_hours;
  const tH = f.thermal_stress_hours;

  $('vTemp').textContent = fmt(f.temp);
  $('vRh').textContent = fmt(f.rh);
  $('vFork').textContent = fmt(f.fork_raw, 0);
  $('vLdr').textContent = fmt(f.ldr_raw, 0);
  $('vDist').textContent = fmt(f.distance_cm);
  $('fDist').textContent = dh == null ? 'Δh —'
    : `Δh ${dh > 0 ? '+' : ''}${Number(dh).toFixed(1)} cm`;

  $('mTemp').className = 'card metric ' + band(f.temp, LIMITS.temp_limit ?? 28);
  $('mRh').className = 'card metric ' + band(f.rh, LIMITS.rh_limit ?? 65);
  $('mFork').className = 'card metric ' + (fork == null ? ''
    : fork < (LIMITS.fork_low ?? 300) ? 'bad'
    : fork < (LIMITS.fork_loaded ?? 600) ? 'warn' : 'ok');
  $('mLdr').className = 'card metric ' + (ldr == null ? ''
    : ldr >= (LIMITS.ldr_anomaly ?? 700) ? 'bad'
    : ldr >= 420 ? 'warn' : 'ok');
  $('mDist').className = 'card metric v3-span ' + (dh == null ? ''
    : dh > (LIMITS.delta_height_cm ?? 5) ? 'bad'
    : dh > (LIMITS.delta_height_cm ?? 5) / 2 ? 'warn' : 'ok');

  $('rEmc').textContent = emc == null ? '—' : Number(emc).toFixed(2) + ' %';
  $('rDew').textContent = dew == null ? '—' : Number(dew).toFixed(1) + ' °C';
  $('rMs').textContent = mH == null ? '—' : Number(mH).toFixed(2) + ' h';
  $('rTs').textContent = tH == null ? '—' : Number(tH).toFixed(2) + ' h';

  $('ruleText').textContent = r.rule || '—';
  $('eviList').innerHTML = (r.evidence || []).map((e) => `<li>${esc(e)}</li>`).join('');
  const checks = (r.checks && r.checks.length) ? r.checks
    : ['No action required. Keep the normal inspection round.'];
  $('checkList').innerHTML = checks.map((c) => `<li>${esc(c)}</li>`).join('');

  $('pipeTag').textContent = mode === 'live' ? 'live · 1 s poll' : 'mirror · ' + speed + '×';

  updateLegend(f);
  updateLabels(f, r);
  updateSelPanel(r);
  if (sceneApi?.update) sceneApi.update(f, r);
}

/* ---------------- evaluation / mirror simulation ---------------- */
function evalPacket(packet, dtOverride) {
  const dt = dtOverride ?? Math.min(60, Math.max(0, (Date.now() - lastEvalMs) / 1000));
  lastEvalMs = Date.now();
  const r = evaluate(packet, BASELINE, LIMITS, stress, dt);
  renderHUD(r);
  runPipeline();
  flashPacket();
  return r;
}

function stepSim() {
  if (mode !== 'mirror' || hold) return;
  const pkt = mock.step(1, Date.now() / 1000);
  evalPacket(pkt);
}

/* P2 calls this once per animation frame with real elapsed seconds. */
function mirrorTick(dtReal) {
  if (mode !== 'mirror') return;
  if (playing) {
    simAcc = Math.min(simAcc + dtReal * speed, 2);
    while (simAcc >= 1) {
      simAcc -= 1;
      stepSim();
    }
  }
  tickHold();
}

/* ---------------- fault injection (mirror semantics: 60 s hold) ---------------- */
function setFaultBtn(id) {
  document.querySelectorAll('#faultBtns .simbtn').forEach((b) => {
    b.classList.toggle('on', b.dataset.fault === id);
  });
}

function updateHoldNote(now) {
  if (!hold) return;
  const left = Math.max(0, Math.ceil((hold.until - now) / 1000));
  if (hold.id === 'offline') {
    const secs = Math.max(0, Math.floor((now - hold.offlineStart) / 1000));
    $('ctlNote').innerHTML =
      `<b>S6 overlay</b> — stream cut, last reading <b>${secs}s</b> old. Release in <b>${left}s</b>.`;
  } else {
    const sc = SCENARIOS[hold.id];
    const label = (sc && sc.label) || hold.id;
    $('ctlNote').innerHTML =
      `<b>${esc(label)}</b> evaluated once and held — mock stream paused. Release in <b>${left}s</b>.`;
  }
}

function tickHold() {
  if (!hold) return;
  const now = Date.now();

  if (now >= hold.until) {
    hold = null;
    setFaultBtn('normal');
    lastEvalMs = Date.now();
    $('ctlNote').innerHTML = DEFAULT_CTL_NOTE;
    return;
  }

  if (hold.id === 'offline' && now >= hold.nextRefresh) {
    hold.nextRefresh = now + 1000;
    renderHUD(evaluate_offline(hold.offlineBase, (now - hold.offlineStart) / 1000));
  }

  if (now - (hold._noteAt || 0) >= 250) {
    hold._noteAt = now;
    updateHoldNote(now);
  }
}

function injectFault(id) {
  if (mode === 'live') {
    postFault(id);
    return;
  }

  if (id === 'normal') {
    hold = null;
    setFaultBtn('normal');
    $('ctlNote').innerHTML = DEFAULT_CTL_NOTE;
    evalPacket(Object.assign({}, SCENARIOS.normal.telemetry), 0);
    return;
  }

  if (id === 'offline') {
    const base = (lastResult && lastResult.state !== S6)
      ? lastResult
      : evaluate(Object.assign({}, SCENARIOS.normal.telemetry), BASELINE, LIMITS, stress, 0);
    hold = {
      id: 'offline',
      until: Date.now() + 60000,
      offlineBase: base,
      offlineStart: Date.now(),
      nextRefresh: Date.now() + 1000,
      _noteAt: 0,
    };
    setFaultBtn('offline');
    renderHUD(evaluate_offline(base, 0));
    runPipeline(true);
    updateHoldNote(Date.now());
    return;
  }

  const sc = SCENARIOS[id];
  if (!sc || !sc.telemetry) return;
  setFaultBtn(id);
  evalPacket(Object.assign({}, sc.telemetry));
  hold = { id, until: Date.now() + 60000, _noteAt: 0 };
  updateHoldNote(Date.now());
}

/* LIVE mode: push the scenario to the backend, which holds it server-side. */
function postFault(id) {
  fetch(`api/simulate/${id}`, { method: 'POST', cache: 'no-store' })
    .then((res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then((r) => {
      renderHUD(r);
      runPipeline(true);
      flashPacket();
      $('ctlNote').innerHTML = id === 'offline'
        ? 'Offline scenario pushed to the backend — S6 overlay held server-side for 60 s.'
        : `Scenario <b>${esc(id)}</b> pushed to the backend — held server-side for 60 s.`;
    })
    .catch(() => {
      $('ctlNote').innerHTML =
        `Could not reach the backend to push <b>${esc(id)}</b> — falling back to the last status it reported.`;
    });
}

/* ---------------- backend mode (LIVE / MIRROR) ---------------- */
function probeBackend() {
  if (mode !== 'mirror') return;
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch (e) { /* ignore */ } }, 2500);
  fetch('api/status', { cache: 'no-store', signal: ac.signal })
    .then((res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then((payload) => {
      clearTimeout(timer);
      goLive(payload);
    })
    .catch(() => {
      clearTimeout(timer);
      if (mode === 'mirror') scheduleProbe(10000);
    });
}

function scheduleProbe(ms) {
  if (probeTimer) clearTimeout(probeTimer);
  probeTimer = setTimeout(() => {
    probeTimer = null;
    probeBackend();
  }, ms);
}

function goLive(payload) {
  mode = 'live';
  if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
  // Any mirror-side hold is meaningless once the backend drives the HUD.
  hold = null;
  setFaultBtn('normal');
  $('ctlNote').innerHTML = DEFAULT_CTL_NOTE;
  setModeFlags('live', payload);
  applyStatus(payload);
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollStatus, 1000);
}

function pollStatus() {
  fetch('api/status', { cache: 'no-store' })
    .then((res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then((json) => applyStatus(json))
    .catch(() => goMirror());
}

function goMirror() {
  if (mode === 'mirror') return;
  mode = 'mirror';
  setModeFlags('mirror');
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  lastEvalMs = Date.now();
  simAcc = 0;
  hold = null;
  setFaultBtn('normal');
  $('ctlNote').innerHTML = DEFAULT_CTL_NOTE;
  scheduleProbe(10000);
}

function applyStatus(payload) {
  payload = payload || {};
  if (payload.limits) LIMITS = Object.assign({}, DEF_LIMITS, payload.limits);
  if (typeof payload.baseline_cm === 'number') BASELINE = payload.baseline_cm;
  liveHoldSec = payload.sim_hold_seconds || 0;
  setModeFlags('live', payload);

  if (payload.result && payload.result.state) {
    renderHUD(payload.result);
    runPipeline();
    flashPacket();
  }

  if (liveHoldSec > 0) {
    $('ctlNote').innerHTML =
      `Backend is holding a scenario — <b>${Number(liveHoldSec).toFixed(0)} s</b> of sim_hold remaining (server side).`;
  } else if (/sim_hold|holding/i.test($('ctlNote').textContent)) {
    $('ctlNote').innerHTML = DEFAULT_CTL_NOTE;
  }
}

/* ---------------- wiring ---------------- */
function wireControls() {
  $('themeBtn').addEventListener('click', (e) => toggleTheme(e.currentTarget));
  $('themeBtn2').addEventListener('click', (e) => toggleTheme(e.currentTarget));

  $('btnPlay').addEventListener('click', () => {
    playing = !playing;
    $('btnPlay').textContent = playing ? 'Pause' : 'Play';
  });

  $('speedSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-speed]');
    if (!b) return;
    speed = parseFloat(b.dataset.speed) || 1;
    $('speedSeg').querySelectorAll('[data-speed]').forEach((x) => {
      x.classList.toggle('on', x === b);
    });
    if (mode === 'mirror') $('pipeTag').textContent = 'mirror · ' + speed + '×';
  });

  $('btnWires').addEventListener('click', () => {
    const on = $('btnWires').classList.toggle('on');
    if (sceneApi?.setWires) sceneApi.setWires(on);
  });

  $('btnLabels').addEventListener('click', () => {
    const on = $('btnLabels').classList.toggle('on');
    labelsOn = on;
    $('labels').style.display = on ? '' : 'none';
  });

  $('btnCam').addEventListener('click', () => {
    if (sceneApi?.resetView) sceneApi.resetView();
  });

  $('faultBtns').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fault]');
    if (!b) return;
    injectFault(b.dataset.fault);
  });
}

/* ---------------- boot (called once by the assembled tail) ---------------- */
function boot() {
  DEFAULT_CTL_NOTE = $('ctlNote').innerHTML;
  DEFAULT_SIM_NOTE = $('simNote').innerHTML;

  buildLegend();
  buildLabelLayer();
  wireControls();
  setModeFlags('mirror');

  tickClock();
  setInterval(tickClock, 1000);

  // One evaluation immediately so the page never stays on "STARTING".
  evalPacket(mock.step(1, Date.now() / 1000), 0);

  initScene();   // P2 — async, handles its own errors; not awaited
  probeBackend(); // fire and forget; catches internally
}

// ================= P2 · Three.js scene =================
/* GrainGuard — viewer3d.js
 * PART 2 — Three.js scene.
 *
 * Builds the whole 3D hardware model: WebGL renderer, lights, floor/grid,
 * the translucent grain bin + grain fill, the Arduino UNO R3 with a painted
 * silkscreen, the four sensors (DHT11 / LDR / fork probe / HC-SR04), the
 * sagging wire runs, raycast selection, camera focus tweens, DOM label
 * projection, resize handling, bloom and theme restyling.
 *
 * Everything lives inside initScene() — the only top-level name this part
 * declares. Three.js arrives through a dynamic import() so a failed load
 * degrades to the HUD-only page instead of breaking it (the catch below).
 *
 * Assembled file = GLUE + P1(pure) + P3(HUD) + P2(this) + tail boot();
 * function declarations hoist, so call order is safe.
 */

async function initScene() {

  /* Single failure sink: keep the HUD/simulation alive, surface the reason. */
  function fail(err) {
    const box = $('stageLoad');
    if (!box) return;
    box.hidden = false;
    box.classList.add('err');
    box.textContent = '3D engine failed to load — ' + (err?.message || err) + '. HUD and simulation keep running.';
  }

  try {
    const THREE = await import('three');
    const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');

    const stage = $('stage');
    const canvas = $('scene');
    if (!stage || !canvas) throw new Error('stage or #scene canvas not found');

    /* ---------- shared mutable state (declared before anything can touch it) ---------- */
    let stageW = stage.clientWidth || 640;
    let stageH = stage.clientHeight || 480;
    let composer = null;      // EffectComposer or null when bloom is unavailable
    let dark = false;         // current theme, set by applyTheme()
    let critRisk = false;     // HIGH/CRITICAL → pulsing status LED
    let txFlashUntil = 0;     // performance.now() deadline for the TX/RX blink

    const anchors = {};       // key -> label anchor Object3D (projected every frame)
    const pickTargets = [];   // groups fed to the raycaster

    /* ---------- renderer / scene / camera ---------- */
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(stageW, stageH, false);       // CSS already stretches the canvas
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xeef1f6);

    const camera = new THREE.PerspectiveCamera(45, stageW / stageH, 0.1, 500);
    const DEF_CAM = new THREE.Vector3(24, 18, 26);
    const DEF_TGT = new THREE.Vector3(-2, 4, 0);
    camera.position.copy(DEF_CAM);

    const controls = new OrbitControls(camera, canvas);
    controls.target.copy(DEF_TGT);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 8;
    controls.maxDistance = 90;
    controls.maxPolarAngle = 1.52;
    controls.update();

    /* ---------- lights ---------- */
    const hemi = new THREE.HemisphereLight(0xf4f7ff, 0x9aa3b2, 0.9);
    scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(18, 30, 14);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -40;
    sun.shadow.camera.right = 40;
    sun.shadow.camera.top = 40;
    sun.shadow.camera.bottom = -40;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 90;
    sun.shadow.bias = -0.0004;
    scene.add(sun);
    scene.add(sun.target);

    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-16, 12, -18);
    scene.add(fill);

    /* ---------- floor + grid ---------- */
    const floorMat = new THREE.MeshStandardMaterial({ color: 0xe9ecf1, roughness: 0.96, metalness: 0 });
    const floor = new THREE.Mesh(new THREE.CircleGeometry(42, 72), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    const grid = new THREE.GridHelper(84, 42, 0x9fb0c8, 0xc3cbd8);
    grid.position.y = 0.02;
    grid.material.transparent = true;
    grid.material.opacity = 0.35;
    scene.add(grid);

    /* ---------- grain bin (godown) — centred at x=-9, z=-4 ---------- */
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0xc9d1db, roughness: 0.7, metalness: 0.02,
      transparent: true, opacity: 0.16, depthWrite: false,
    });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x6b7686, transparent: true, opacity: 0.5 });
    const slabMat = new THREE.MeshStandardMaterial({ color: 0xb9bfc8, roughness: 0.92 });

    const binGroup = new THREE.Group();
    scene.add(binGroup);

    const slab = new THREE.Mesh(new THREE.BoxGeometry(14.8, 0.6, 13.8), slabMat);
    slab.position.set(-9, 0.3, -4);                 // top at y = 0.6
    slab.castShadow = true;
    slab.receiveShadow = true;
    binGroup.add(slab);

    function addWall(w, h, d, x, y, z) {
      const geo = new THREE.BoxGeometry(w, h, d);
      const mesh = new THREE.Mesh(geo, wallMat);
      mesh.position.set(x, y, z);
      binGroup.add(mesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
      edges.position.copy(mesh.position);
      binGroup.add(edges);
      return mesh;
    }
    addWall(14, 10, 0.5, -9, 5.6, 2.25);            // front  (z = 2.25)
    addWall(14, 10, 0.5, -9, 5.6, -10.25);          // back   (z = -10.25)
    addWall(0.5, 10, 13, -15.75, 5.6, -4);          // left   (x = -15.75)
    addWall(0.5, 10, 13, -2.25, 5.6, -4);           // right  (x = -2.25)

    const shutterMat = new THREE.MeshStandardMaterial({ color: 0x8a93a1, roughness: 0.75 });
    const shutter = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.4, 0.16), shutterMat);
    shutter.position.set(-5.5, 7.2, 2.55);           // LDR mounts on this panel
    shutter.castShadow = true;
    binGroup.add(shutter);

    /* ---------- grain fill (unit-height box, scaled by setGrain) ---------- */
    const grainMat = new THREE.MeshStandardMaterial({ color: 0xcfae64, roughness: 0.92, metalness: 0 });
    const grain = new THREE.Mesh(new THREE.BoxGeometry(12.6, 1, 12.0), grainMat);
    grain.castShadow = true;
    grain.receiveShadow = true;
    scene.add(grain);

    /* distance_cm 15 → top y 8 (full); a stock-anomaly 23.8 → top ≈ 4.5 (drops) */
    function setGrain(distance) {
      const d = (distance === null || distance === undefined || !isFinite(Number(distance)))
        ? 15 : Number(distance);
      const top = clamp(8 + (15 - d) * 0.4, 1.5, 9.6);
      const h = Math.max(0.4, top - 0.6);
      grain.scale.y = h;
      grain.position.set(-9, 0.6 + h / 2, -4);
    }
    setGrain(15);

    /* ---------- Arduino UNO R3 at (5, 0.5, 5) ---------- */
    const uno = new THREE.Group();
    uno.position.set(5, 0.5, 5);
    uno.rotation.y = -0.35;
    uno.userData.key = 'uno';
    scene.add(uno);
    pickTargets.push(uno);

    const silver = new THREE.MeshStandardMaterial({ color: 0xc8ccd4, roughness: 0.35, metalness: 0.7 });
    const black = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.6 });
    const goldMat = new THREE.MeshStandardMaterial({ color: 0xd9b441, roughness: 0.4, metalness: 0.6 });

    /* Silkscreen painted into a 2D canvas → CanvasTexture on the PCB top face. */
    function makeSilkTexture() {
      const c = document.createElement('canvas');
      c.width = 1024;
      c.height = 792;
      const g = c.getContext('2d');
      const W = 1024, H = 792;

      g.fillStyle = '#0e7a86';
      g.fillRect(0, 0, W, H);
      g.strokeStyle = 'rgba(255,255,255,0.35)';
      g.lineWidth = 4;
      g.strokeRect(14, 14, W - 28, H - 28);

      const gold = '#d9b441';
      const white = '#ffffff';

      // Digital pads + D0..D13 along the +z edge (canvas bottom).
      const dig = ['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13'];
      const dx0 = 341, dx1 = 860;
      g.textAlign = 'center';
      g.font = 'bold 17px monospace';
      for (let i = 0; i < dig.length; i++) {
        const x = dx0 + (dx1 - dx0) * i / (dig.length - 1);
        g.fillStyle = gold;
        g.fillRect(x - 8, 742, 16, 22);
        g.fillStyle = white;
        g.fillText(dig[i], x, 730);
      }

      // Power pads along the -z edge (canvas top).
      const pwr = ['5V', 'GND', 'VIN', 'RST'];
      const px0 = 133, px1 = 326;
      g.font = 'bold 17px monospace';
      for (let i = 0; i < pwr.length; i++) {
        const x = px0 + (px1 - px0) * i / (pwr.length - 1);
        g.fillStyle = gold;
        g.fillRect(x - 8, 28, 16, 22);
        g.fillStyle = white;
        g.fillText(pwr[i], x, 76);
      }

      // Analog pads A0..A5, same edge further along.
      const ana = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'];
      const ax0 = 646, ax1 = 863;
      for (let i = 0; i < ana.length; i++) {
        const x = ax0 + (ax1 - ax0) * i / (ana.length - 1);
        g.fillStyle = gold;
        g.fillRect(x - 8, 28, 16, 22);
        g.fillStyle = white;
        g.fillText(ana[i], x, 76);
      }

      // DIP footprint + label (the physical chip straddles its upper half,
      // leaving the ATMEGA328P text visible below it).
      g.fillStyle = '#14171d';
      g.fillRect(440, 395, 320, 175);
      g.strokeStyle = 'rgba(255,255,255,0.25)';
      g.lineWidth = 2;
      g.strokeRect(440, 395, 320, 175);
      g.fillStyle = '#cfd6de';
      g.font = 'bold 26px monospace';
      g.fillText('ATMEGA328P', 600, 545);

      // Branding block.
      g.textAlign = 'left';
      g.fillStyle = white;
      g.font = 'bold 64px sans-serif';
      g.fillText('GrainGuard', 64, 260);
      g.font = 'bold 46px sans-serif';
      g.fillText('UNO R3', 64, 322);
      g.font = 'bold 24px monospace';
      g.fillText('EDGE NODE · 4-SENSOR HUB', 64, 368);

      // Four corner mounting holes.
      const holes = [[51, 47], [973, 47], [51, 745], [973, 745]];
      for (const [hx, hy] of holes) {
        g.beginPath();
        g.arc(hx, hy, 22, 0, Math.PI * 2);
        g.fillStyle = '#0a4a54';
        g.fill();
        g.lineWidth = 4;
        g.strokeStyle = 'rgba(255,255,255,0.5)';
        g.stroke();
        g.beginPath();
        g.arc(hx, hy, 12, 0, Math.PI * 2);
        g.fillStyle = '#0b1016';
        g.fill();
      }

      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      return tex;
    }

    const silkTex = makeSilkTexture();
    const pcbEdgeMat = new THREE.MeshStandardMaterial({ color: 0x0e7a86, roughness: 0.65 });
    const pcbTopMat = new THREE.MeshStandardMaterial({ map: silkTex, roughness: 0.55 });
    const pcbBotMat = new THREE.MeshStandardMaterial({ color: 0x0a5f68, roughness: 0.8 });
    // material order: [+x, -x, +y, -y, +z, -z] — silk on index 2 (top face)
    const pcb = new THREE.Mesh(
      new THREE.BoxGeometry(6.9, 0.16, 5.3),
      [pcbEdgeMat, pcbEdgeMat, pcbTopMat, pcbBotMat, pcbEdgeMat, pcbEdgeMat]
    );
    pcb.castShadow = true;
    pcb.receiveShadow = true;
    uno.add(pcb);

    // Silver USB-B overhanging the -x end.
    const usb = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.2, 1.35), silver);
    usb.position.set(-3.75, 0.68, -1.15);
    usb.castShadow = true;
    uno.add(usb);

    // Black barrel jack, same end, other side.
    const jack = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.0, 1.0), black);
    jack.position.set(-3.6, 0.58, 1.35);
    jack.castShadow = true;
    uno.add(jack);

    // ATMEGA328P DIP package.
    const dip = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.3, 0.9), black);
    dip.position.set(0.6, 0.23, 0.445);
    dip.castShadow = true;
    uno.add(dip);

    // Silver crystal can.
    const crystal = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 1.1, 14), silver);
    crystal.rotation.z = Math.PI / 2;
    crystal.position.set(-1.35, 0.34, 0.4);
    crystal.castShadow = true;
    uno.add(crystal);

    // Black header strips with gold pin nubs.
    function headerStrip(cx, cz, pins, spacing, len) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(len, 0.35, 0.5), black);
      strip.position.set(cx, 0.26, cz);
      strip.castShadow = true;
      uno.add(strip);
      const start = cx - (pins - 1) * spacing / 2;
      for (let i = 0; i < pins; i++) {
        const nub = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.16, 0.09), goldMat);
        nub.position.set(start + i * spacing, 0.51, cz);
        uno.add(nub);
      }
    }
    headerStrip(0.6, 2.35, 14, 0.269, 3.8);    // digital, +z edge
    headerStrip(-1.9, -2.35, 4, 0.433, 1.6);    // power,   -z edge
    headerStrip(1.63, -2.35, 6, 0.292, 1.75);   // analog,  -z edge

    // Indicator LEDs — each gets its own emissive material.
    function led(x, z, hex) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0x1a1c20, emissive: hex, emissiveIntensity: 0.3, roughness: 0.4,
      });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.12, 0.18), mat);
      mesh.position.set(x, 0.14, z);
      uno.add(mesh);
      return mesh;
    }
    const ledTx = led(-2.45, -0.35, 0x2fd06f);   // TX — green
    const ledRx = led(-2.45, 0.25, 0xe2453c);    // RX — red
    const ledPwr = led(-2.45, 0.85, 0x2fd06f);   // PWR — green, steady
    ledPwr.material.emissiveIntensity = 1.0;
    const ledStatus = led(2.35, 1.85, 0x2f9e61); // near D13
    const statusMat = ledStatus.material;
    statusMat.emissiveIntensity = 1.1;

    // Standoffs under the four corners.
    for (const sx of [-3.1, 3.1]) {
      for (const sz of [-2.4, 2.4]) {
        const st = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.42, 12), silver);
        st.position.set(sx, -0.29, sz);
        st.castShadow = true;
        uno.add(st);
      }
    }

    const unoLabelAnchor = new THREE.Object3D();
    unoLabelAnchor.position.set(0, 0.9, 0);
    uno.add(unoLabelAnchor);
    anchors.uno = unoLabelAnchor;

    const unoWire = new THREE.Object3D();
    unoWire.position.set(0.6, 0.45, 2.35);        // near the +z digital header
    uno.add(unoWire);
    uno.userData.wireAnchor = unoWire;

    /* ---------- sensor factory: group + label anchor + wire anchor ---------- */
    function sensorGroup(key, x, y, z) {
      const g = new THREE.Group();
      g.position.set(x, y, z);
      g.userData.key = key;
      scene.add(g);
      pickTargets.push(g);
      const la = new THREE.Object3D();
      g.add(la);
      anchors[key] = la;
      const wa = new THREE.Object3D();
      g.add(wa);
      g.userData.wireAnchor = wa;
      return g;
    }

    /* 1 — DHT11 inside the bin, on the left wall */
    const dht = sensorGroup('dht', -14.9, 9.0, -6);
    const dhtBody = new THREE.Mesh(
      new THREE.BoxGeometry(0.35, 1.5, 2.0),
      new THREE.MeshStandardMaterial({ color: 0x7ec3e8, roughness: 0.6 })
    );
    dhtBody.castShadow = true;
    dht.add(dhtBody);
    const grilleMat = new THREE.MeshStandardMaterial({ color: 0x2a3340, roughness: 0.85 });
    for (const gy of [0.32, 0.05, -0.22]) {
      const slot = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.13, 1.3), grilleMat);
      slot.position.set(0.18, gy, 0);
      dht.add(slot);
    }
    const dhtLed = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.12, 0.12),
      new THREE.MeshStandardMaterial({ color: 0x1a1c20, emissive: 0xe2453c, emissiveIntensity: 1.2 })
    );
    dhtLed.position.set(0.18, -0.5, 0);
    dht.add(dhtLed);
    const dhtBracket = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.14, 1.1), silver);
    dhtBracket.position.set(-0.45, -0.55, 0);
    dht.add(dhtBracket);
    anchors.dht.position.set(0.15, 1.15, 0);
    dht.userData.wireAnchor.position.set(0.1, -0.7, 0.7);

    /* 2 — LDR module on the shutter panel, facing +z */
    const ldr = sensorGroup('ldr', -5.5, 7.2, 2.7);
    const ldrBoard = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 1.5, 0.22),
      new THREE.MeshStandardMaterial({ color: 0x8a4a33, roughness: 0.7 })
    );
    ldrBoard.castShadow = true;
    ldr.add(ldrBoard);
    const ldrSensor = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.4, 0.16, 24),
      new THREE.MeshStandardMaterial({ color: 0x7a1f1f, roughness: 0.5, emissive: 0x3a0d0d, emissiveIntensity: 0.4 })
    );
    ldrSensor.rotation.x = Math.PI / 2;            // faces +z
    ldrSensor.position.set(0, 0, 0.19);
    ldr.add(ldrSensor);
    const ldrLens = new THREE.Mesh(
      new THREE.CircleGeometry(0.22, 20),
      new THREE.MeshStandardMaterial({ color: 0x4a1010, roughness: 0.35, metalness: 0.3 })
    );
    ldrLens.position.set(0, 0, 0.275);
    ldr.add(ldrLens);
    anchors.ldr.position.set(0, 1.15, 0);
    ldr.userData.wireAnchor.position.set(0, -0.9, 0);

    /* 3 — fork probe on the inner right wall; prongs pierce the grain */
    const fork = sensorGroup('fork', -2.8, 7.8, -3);
    const forkBoard = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 1.5, 2.0),
      new THREE.MeshStandardMaterial({ color: 0x1f5a3a, roughness: 0.7 })
    );
    forkBoard.castShadow = true;
    fork.add(forkBoard);
    const prongMat = new THREE.MeshStandardMaterial({ color: 0xc0c6ce, roughness: 0.3, metalness: 0.7 });
    for (const pz of [-0.45, 0.45]) {
      const prong = new THREE.Mesh(new THREE.BoxGeometry(0.07, 3.4, 0.1), prongMat);
      prong.position.set(-0.2, -2.45, pz);         // hangs from the board bottom, bin side
      prong.castShadow = true;
      fork.add(prong);
    }
    const forkBracket = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.7, 1.1), silver);
    forkBracket.position.set(0.22, 0.1, 0);
    fork.add(forkBracket);
    anchors.fork.position.set(0, 1.1, 0);
    fork.userData.wireAnchor.position.set(0.3, 0.1, 0);

    /* 4 — gantry + HC-SR04 above the bin */
    const gantryMat = new THREE.MeshStandardMaterial({ color: 0x9aa3b2, roughness: 0.6, metalness: 0.3 });
    for (const px of [-15.4, -2.6]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 13, 16), gantryMat);
      post.position.set(px, 6.5, -4);
      post.castShadow = true;
      scene.add(post);
    }
    const crossbar = new THREE.Mesh(new THREE.BoxGeometry(13.4, 0.3, 0.3), gantryMat);
    crossbar.position.set(-9, 12.9, -4);
    crossbar.castShadow = true;
    scene.add(crossbar);

    const sonic = sensorGroup('sonic', -9, 12.35, -4);
    const sonicBoard = new THREE.Mesh(
      new THREE.BoxGeometry(4.6, 0.32, 2.0),
      new THREE.MeshStandardMaterial({ color: 0x0e7a86, roughness: 0.6 })
    );
    sonicBoard.castShadow = true;
    sonic.add(sonicBoard);
    const transMat = new THREE.MeshStandardMaterial({ color: 0xcfd4dc, roughness: 0.3, metalness: 0.8 });
    const faceMat = new THREE.MeshStandardMaterial({ color: 0x6a7079, roughness: 0.7 });
    for (const tx of [-1.15, 1.15]) {
      // Transducer cans hang under the board with their round face pointing DOWN.
      const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.45, 28), transMat);
      tr.position.set(tx, -0.385, 0);
      tr.castShadow = true;
      sonic.add(tr);
      const face = new THREE.Mesh(new THREE.CircleGeometry(0.5, 24), faceMat);
      face.rotation.x = Math.PI / 2;               // circle normal +z → -y (down)
      face.position.set(tx, -0.613, 0);
      sonic.add(face);
    }
    anchors.sonic.position.set(0, 1.4, 0);         // above the crossbar
    sonic.userData.wireAnchor.position.set(0, 0.2, 0);

    /* ---------- wires: sensor anchor → low sag → UNO header ---------- */
    scene.updateMatrixWorld(true);

    const wireGroup = new THREE.Group();
    scene.add(wireGroup);
    const wireMats = [0xd64545, 0x141414, 0xe0b13a].map(   // VCC / GND / SIG
      (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.55 })
    );

    const unoWirePos = new THREE.Vector3();
    unoWire.getWorldPosition(unoWirePos);
    const unoRight = new THREE.Vector3(1, 0, 0)
      .applyQuaternion(uno.getWorldQuaternion(new THREE.Quaternion()));

    const sensorList = [
      { key: 'dht', obj: dht },
      { key: 'ldr', obj: ldr },
      { key: 'fork', obj: fork },
      { key: 'sonic', obj: sonic },
    ];

    for (let i = 0; i < sensorList.length; i++) {
      const A = new THREE.Vector3();
      sensorList[i].obj.userData.wireAnchor.getWorldPosition(A);
      const H = unoWirePos.clone().addScaledVector(unoRight, (i - 1.5) * 0.55);

      const dir = new THREE.Vector3(H.x - A.x, 0, H.z - A.z);
      if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
      dir.normalize();
      const perp = new THREE.Vector3(-dir.z, 0, dir.x);

      for (let j = 0; j < 3; j++) {
        const off = (j - 1) * 0.16;
        const a = A.clone().addScaledVector(perp, off * 0.5);
        const h = H.clone().addScaledVector(perp, off);
        const p1 = a.clone().lerp(h, 0.4).addScaledVector(perp, off * 0.5);
        p1.y = 0.4 + j * 0.06;                      // low sag point
        const p2 = a.clone().lerp(h, 0.72).addScaledVector(perp, off * 0.5);
        p2.y = 0.4 + j * 0.06;
        const curve = new THREE.CatmullRomCurve3([a, p1, p2, h]);
        wireGroup.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.05, 6, false), wireMats[j]));
      }
    }

    function setWires(on) {
      wireGroup.visible = !!on;
    }

    /* ---------- selection: pointerdown/up + raycast ---------- */
    const raycaster = new THREE.Raycaster();
    let downPt = null;

    canvas.addEventListener('pointerdown', (e) => {
      downPt = { x: e.clientX, y: e.clientY };
    });

    canvas.addEventListener('pointerup', (e) => {
      if (!downPt) return;
      const moved = Math.hypot(e.clientX - downPt.x, e.clientY - downPt.y);
      downPt = null;
      if (moved > 6) return;                        // that was an orbit drag
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(pickTargets, true);
      let key = null;
      if (hits.length) {
        let o = hits[0].object;
        while (o && !o.userData.key) o = o.parent;
        key = o ? o.userData.key : null;
      }
      selectSensor(key);                            // P3 hook; it calls sceneApi.focus back
    });

    /* ---------- camera tween (focus / reset) ---------- */
    const tween = {
      on: false, t: 0, dur: 0.7,
      fp: new THREE.Vector3(), tp: new THREE.Vector3(),
      ft: new THREE.Vector3(), tt: new THREE.Vector3(),
    };

    function easeInOutQuad(t) {
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    }

    function startTween(camTo, tgtTo) {
      tween.fp.copy(camera.position);
      tween.tp.copy(controls.target);
      tween.ft.copy(camTo);
      tween.tt.copy(tgtTo);
      tween.t = 0;
      tween.on = true;
      controls.enabled = false;
    }

    function stepTween(dt) {
      if (!tween.on) return;
      tween.t = Math.min(1, tween.t + dt / tween.dur);
      const k = easeInOutQuad(tween.t);
      camera.position.lerpVectors(tween.fp, tween.ft, k);
      controls.target.lerpVectors(tween.tp, tween.tt, k);
      if (tween.t >= 1) {
        tween.on = false;
        controls.enabled = true;
      }
    }

    function focus(keyOrNull) {
      if (!keyOrNull) return;                       // null → no-op
      const a = anchors[keyOrNull];
      if (!a) return;
      const tgt = new THREE.Vector3();
      a.getWorldPosition(tgt);
      const dist = keyOrNull === 'uno' ? 11 : keyOrNull === 'sonic' ? 17 : 13;
      const dir = camera.position.clone().sub(controls.target);
      if (dir.lengthSq() < 1e-6) dir.set(1, 0.6, 1); // keep the current viewing side
      dir.normalize();
      const camTo = tgt.clone().addScaledVector(dir, dist);
      if (camTo.y < tgt.y + 3) camTo.y = tgt.y + 3;  // never dive under the target
      startTween(camTo, tgt);
    }

    function resetView() {
      startTween(DEF_CAM, DEF_TGT);
    }

    /* ---------- DOM labels ---------- */
    const LABEL_KEYS = ['uno', 'dht', 'ldr', 'fork', 'sonic'];
    const _lp = new THREE.Vector3();

    function projectLabels() {
      const pad = 1.08;                             // slightly padded NDC box
      for (const k of LABEL_KEYS) {
        const el = labelEls[k];
        if (!el) continue;
        const a = anchors[k];
        if (!labelsOn || !a) {
          el.style.display = 'none';
          continue;
        }
        a.getWorldPosition(_lp);
        _lp.project(camera);
        if (_lp.z > 1 || _lp.x < -pad || _lp.x > pad || _lp.y < -pad || _lp.y > pad) {
          el.style.display = 'none';
        } else {
          el.style.display = '';
          el.style.left = (_lp.x * 0.5 + 0.5) * stageW + 'px';
          el.style.top = (-_lp.y * 0.5 + 0.5) * stageH + 'px';
          // transform is owned by CSS (.slabel) — never touch it here
        }
      }
    }

    /* ---------- resize ---------- */
    function resize() {
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      if (!w || !h) return;
      stageW = w;
      stageH = h;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (composer) composer.setSize(w, h);
    }
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(resize).observe(stage);
    } else {
      window.addEventListener('resize', resize);
    }
    resize();

    /* ---------- bloom (optional: never break when the addons are missing) ---------- */
    try {
      const [ecMod, rpMod, ubMod, opMod] = await Promise.all([
        import('three/addons/postprocessing/EffectComposer.js'),
        import('three/addons/postprocessing/RenderPass.js'),
        import('three/addons/postprocessing/UnrealBloomPass.js'),
        import('three/addons/postprocessing/OutputPass.js'),
      ]);
      const c = new ecMod.EffectComposer(renderer);
      c.setSize(stageW, stageH);
      c.addPass(new rpMod.RenderPass(scene, camera));
      c.addPass(new ubMod.UnrealBloomPass(new THREE.Vector2(stageW, stageH), 0.55, 0.4, 0.85));
      c.addPass(new opMod.OutputPass());
      composer = c;
    } catch (e) {
      composer = null;                              // fall back to direct rendering
    }

    /* ---------- theme ---------- */
    function applyTheme() {
      dark = document.documentElement.dataset.theme === 'dark';
      scene.background.setHex(dark ? 0x0b0e14 : 0xeef1f6);
      floorMat.color.setHex(dark ? 0x12151d : 0xe9ecf1);
      grid.material.opacity = dark ? 0.22 : 0.35;
      hemi.intensity = dark ? 0.55 : 0.9;
      sun.intensity = dark ? 1.1 : 1.5;
      wallMat.color.setHex(dark ? 0x6d7a8c : 0xc9d1db);
      grainMat.color.setHex(dark ? 0xa8873f : 0xcfae64);
      // bloom only renders in dark mode (checked in the frame loop)
    }

    /* ---------- telemetry ---------- */
    const RISK_COLOR = {
      LOW: 0x2f9e61,
      MEDIUM: 0xd98a1d,
      'MEDIUM-HIGH': 0xe2711d,
      HIGH: 0xd64545,
      CRITICAL: 0xd64545,
    };

    function update(facts, result) {
      setGrain(facts ? facts.distance_cm : null);   // null → 15 cm (full)
      const risk = (result && result.risk) || 'LOW';
      const hex = RISK_COLOR[risk];
      if (hex !== undefined) statusMat.emissive.setHex(hex);
      critRisk = risk === 'HIGH' || risk === 'CRITICAL';
    }

    /* ---------- public API + TX/RX flash hook (ASSIGN, never redeclare) ---------- */
    sceneApi = { update, setWires, resetView, focus, applyTheme };
    flashPacket = () => {
      txFlashUntil = performance.now() + 160;
    };

    applyTheme();
    $('stageLoad').hidden = true;

    /* ---------- frame loop ---------- */
    let lastT = performance.now();
    function frame() {
      try {
        const now = performance.now();
        let dt = (now - lastT) / 1000;
        lastT = now;
        if (!(dt >= 0)) dt = 0;
        if (dt > 0.05) dt = 0.05;

        try { mirrorTick(dt); } catch (e) { /* the HUD runs its own sim; keep rendering */ }
        stepTween(dt);
        controls.update();

        const flashing = now < txFlashUntil;
        ledTx.material.emissiveIntensity = flashing ? 2.4 : 0.3;
        ledRx.material.emissiveIntensity = flashing ? 2.4 : 0.3;
        statusMat.emissiveIntensity = critRisk
          ? 1.4 + Math.sin(now / 160) * 0.8
          : 1.1;

        projectLabels();

        if (composer && dark) composer.render();
        else renderer.render(scene, camera);
      } catch (err) {
        fail(err);                                  // stop the loop, HUD keeps running
        return;
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  } catch (err) {
    fail(err);
    return;
  }
}

/* boot — assembled last so every declaration above is in scope */
boot();
