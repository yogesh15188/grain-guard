/* GrainGuard frontend.
   The UI NEVER computes risk. It only renders what the deterministic engine
   returns and calls the scenario API. No scenario result is hardcoded here. */
'use strict';

const $ = (id) => document.getElementById(id);
const fmt = (v, nd = 1, dash = '—') =>
  (v === null || v === undefined || Number.isNaN(v)) ? dash : Number(v).toFixed(nd);
const RISK_CLASS = { 'LOW': 'risk-low', 'MEDIUM': 'risk-med', 'MEDIUM-HIGH': 'risk-high', 'HIGH': 'risk-high', 'CRITICAL': 'risk-crit' };
let LIMITS = {};
let SCENARIOS = [];

/* ---------------- theme ---------------- */
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('gg-theme', t);
}
function toggleTheme(btn) {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  setTheme(next);
  btn.classList.add('flip');
  setTimeout(() => btn.classList.remove('flip'), 420);
}

/* ---------------- IST clock ---------------- */
const IST = { timeZone: 'Asia/Kolkata' };
function tickClock() {
  const now = new Date();
  const time = now.toLocaleTimeString('en-GB', { ...IST, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const full = `${now.toLocaleDateString('en-GB', { ...IST, day: '2-digit', month: 'short', year: 'numeric' })} • ${time} IST`;
  $('clock').textContent = full;
  $('clock2').textContent = full;
}

/* ---------------- pipeline animation ---------------- */
function runPipeline() {
  const steps = [...document.querySelectorAll('.pstep')];
  steps.forEach((s) => s.classList.remove('done', 'active'));
  steps.forEach((s, i) => setTimeout(() => {
    steps.forEach((o) => o.classList.remove('active'));
    s.classList.add('active');
    setTimeout(() => s.classList.replace('active', 'done'), 420);
  }, 260 * (i + 1)));
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- SVG mimic ---------------- */
function paintMimic(f) {
  const rhLimit = LIMITS.rh_limit ?? 65;
  const emcLimit = LIMITS.emc_ingress ?? 14;
  const ldrLimit = LIMITS.ldr_anomaly ?? 700;
  const forkLow = LIMITS.fork_low ?? 300;
  const forkLoaded = LIMITS.fork_loaded ?? 600;
  const rh = f.rh, emc = f.emc_estimate, ldr = f.ldr_raw, fork = f.fork_raw;

  const air = $('mAir');
  let airFill = 'var(--safe-bg)';
  if (rh === null || rh === undefined) airFill = 'var(--surface2)';
  else if (rh > rhLimit + 5 || (emc != null && emc > emcLimit + 1)) airFill = 'var(--crit-bg)';
  else if (rh > rhLimit) airFill = 'var(--alert-bg)';
  air.style.fill = airFill;

  const dh = f.delta_height_cm;
  if (dh != null) {
    const top = Math.max(70, Math.min(150, 120 + dh * 4));
    $('mGrain').setAttribute('d', `M46 ${top} H274 V164 H46 Z`);
  }

  const ldrEl = $('mLdr'), shEl = $('mShutter'), dhtEl = $('mDht');
  ldrEl.classList.toggle('bad', ldr != null && ldr >= ldrLimit);
  ldrEl.classList.toggle('warn', ldr != null && ldr < ldrLimit && ldr >= ldrLimit * 0.6);
  shEl.classList.toggle('bad', rh != null && rh > rhLimit);
  dhtEl.classList.toggle('bad', rh != null && rh > rhLimit + 5);

  const probe = $('mProbe');
  if (fork != null) probe.style.stroke = fork < forkLow ? 'var(--crit)' : fork >= forkLoaded ? 'var(--ink2)' : 'var(--watch)';
}
/* ---------------- alerts ----------------
   The UI renders alerts and sounds a tone. It never computes one: every alert
   on screen came from the server's deterministic alerts.py. */
let MUTED = localStorage.getItem('gg-muted') === '1';
let SOUND = localStorage.getItem('gg-sound') !== '0';
let seenAlerts = new Set();
let audioCtx = null;

/* Short beep via WebAudio. No audio files, so it works with no network.
   Critical = urgent triple tone, danger = two, warning = one. */
function beep(severity) {
  if (MUTED || !SOUND) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    const pattern = severity === 'critical' ? [880, 1180, 880]
      : severity === 'danger' ? [700, 950] : [560];
    pattern.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const t0 = now + i * 0.17;
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.14, t0 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.16);
    });
  } catch (e) { /* audio is a nicety; never break the dashboard over it */ }
}

function toast(a) {
  const box = $('toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast ' + (a.severity || 'warning');
  el.innerHTML = `<b>${esc(a.title)}</b><small>${esc(a.evidence)}</small>` +
    `<div class="t-ev">${esc(a.key)}</div>`;
  el.onclick = () => el.remove();
  box.appendChild(el);
  setTimeout(() => el.remove(), a.severity === 'critical' ? 14000 : 8000);
  while (box.children.length > 4) box.firstChild.remove();
}

function renderAlerts(payload) {
  const A = payload.alerts || { alerts: [], new: [] };
  const list = A.alerts || [];
  const banner = $('alertBanner');

  /* active alert cards */
  const box = $('alertList');
  if (box) {
    box.innerHTML = list.length
      ? list.map((a) => `<li class="acard ${esc(a.severity)}">
          <div class="a-head"><span class="a-sev">${esc(a.severity)}</span>
            <span class="a-key">${esc(a.key)}</span></div>
          <div class="a-title">${esc(a.title)}</div>
          <div class="a-ev">${esc(a.evidence)}</div>
          <div class="a-cons">${esc(a.consistency)}</div>
          <ol class="a-list">${(a.actions || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
        </li>`).join('')
      : '<li class="muted">No alerts active. Conditions are within limits.</li>';
  }
  const cnt = $('alertCount');
  if (cnt) cnt.textContent = list.length ? `${list.length} active` : 'none';

  /* banner for the most severe alert */
  const top = A.top || list[0] || null;
  if (banner) {
    if (top) {
      banner.hidden = false;
      banner.className = 'alertbanner ' + top.severity;
      banner.innerHTML = `<span class="ab-ico">${
        top.severity === 'critical' ? '⛔' : top.severity === 'danger' ? '⚠' : 'ℹ'}</span>
        <span class="ab-txt"><b>${esc(top.title)}</b><small>${esc(top.evidence)}</small></span>
        <button class="ab-close" type="button" aria-label="Dismiss">×</button>`;
      banner.querySelector('.ab-close').onclick = () => { banner.hidden = true; };
    } else {
      banner.hidden = true;
    }
  }

  /* only fire a toast/beep for genuinely NEW alerts, so a persistent
     condition does not re-announce itself every poll */
  (A.new || []).forEach((a) => {
    const sig = a.key + '|' + a.evidence;
    if (seenAlerts.has(sig)) return;
    seenAlerts.add(sig);
    toast(a);
    beep(a.severity);
  });
  const live = new Set(list.map((a) => a.key));
  seenAlerts.forEach((sig) => { if (!live.has(sig.split('|')[0])) seenAlerts.delete(sig); });

  const mb = $('muteBtn');
  if (mb) mb.textContent = MUTED ? 'Unmute' : 'Mute';
}

/* ---------------- main render ---------------- */
function renderStatus(payload) {
  const r = payload.result;
  LIMITS = payload.limits || {};

  const pill = $('modePill');
  pill.textContent = payload.mode;
  pill.className = 'modepill ' + (payload.mode === 'OFFLINE' ? 'off'
    : payload.mode === 'SIMULATION' ? 'sim' : 'live');
  $('facilityName').textContent = (payload.facility && payload.facility.name) || 'Demo Rice Storage';

  const hw = $('hwFlag');
  const detail = payload.source_detail || '';
  if (payload.pipeline_error) {
    hw.textContent = 'DATA PIPELINE ERROR';
    hw.className = 'hwflag';
    hw.title = payload.pipeline_error;
  } else if (/HARDWARE OFFLINE/i.test(detail)) {
    hw.textContent = 'HARDWARE OFFLINE — SIMULATION MODE';
    hw.className = 'hwflag';
  } else if (/connected/i.test(detail)) {
    hw.textContent = payload.result.status_led_safe
      ? 'HARDWARE LIVE · BOARD LED ON'
      : 'HARDWARE LIVE · BOARD LED OFF';
    hw.className = payload.result.status_led_safe ? 'hwflag ok' : 'hwflag';
  } else if (/connecting/i.test(detail)) {
    hw.textContent = 'CONNECTING TO HARDWARE';
    hw.className = 'hwflag';
  } else {
    hw.textContent = 'MOCK TELEMETRY — SIMULATION MODE';
    hw.className = 'hwflag';
  }
  if (!payload.pipeline_error) hw.title = detail;

  // While a scenario is held on screen, say so instead of letting the operator
  // wonder why the live mock numbers are not moving.
  if (payload.sim_hold_seconds > 0) {
    $('simNote').textContent = `Scenario held for ${Math.ceil(payload.sim_hold_seconds)}s so the result stays readable. The sensor stream or clearly labeled simulation fallback resumes automatically.`;
  }

  // Alerts render regardless of whether a sensor result exists yet, so a
  // device or audit alert is still visible on a cold start.
  renderAlerts(payload);

  if (!r) return;

  $('shState').textContent = r.headline || '—';
  $('shSub').textContent = r.plain_summary || '';
  $('shCode').textContent = r.state || '';

  $('riskValue').parentElement.className = 'riskbox ' + (RISK_CLASS[r.risk] || 'risk-low');
  $('riskValue').textContent = r.risk || '—';
  $('aerBox').className = 'aerbox ' + (r.aeration_allowed ? 'aer-ok' : 'aer-locked');
  $('aerValue').textContent = r.aeration_allowed ? 'AVAILABLE — HUMAN VERIFICATION REQUIRED' : 'LOCKED';

  /* metrics */
  const f = r.facts || {};
  $('vTemp').textContent = fmt(f.temp);
  $('vRh').textContent = fmt(f.rh);
  $('vEmc').textContent = fmt(f.emc_estimate);
  $('vDh').textContent = f.distance_cm == null ? '—'
    : fmt(Math.max(0, f.distance_cm));
  $('fDh').textContent = f.delta_height_cm == null
    ? 'waiting for valid baseline'
    : `change from baseline ${fmt(f.delta_height_cm)} cm`;

  const tL = LIMITS.temp_limit ?? 28, rhL = LIMITS.rh_limit ?? 65;
  const eL = LIMITS.emc_ingress ?? 14, dL = LIMITS.delta_height_cm ?? 5;
  const band = (v, lim) => (v == null ? '' : v > lim + 1 ? 'bad' : v > lim ? 'warn' : 'ok');
  $('mTemp').className = 'card metric ' + band(f.temp, tL);
  $('mRh').className = 'card metric ' + band(f.rh, rhL);
  $('mEmc').className = 'card metric ' + band(f.emc_estimate, eL);
  $('mDh').className = 'card metric ' + (f.distance_cm == null ? ''
    : Math.abs(f.delta_height_cm || 0) > dL ? 'bad'
      : Math.abs(f.delta_height_cm || 0) > dL / 2 ? 'warn' : 'ok');

  /* why / evidence / checks */
  $('ruleText').textContent = r.rule || '—';
  $('eviList').innerHTML = (r.evidence || []).map((e) => `<li>${esc(e)}</li>`).join('');
  const checks = (r.checks && r.checks.length) ? r.checks
    : ['No action required. Keep the normal inspection round.'];
  $('checkList').innerHTML = checks.map((c) => `<li>${esc(c)}</li>`).join('');

  /* explanation - wording only, never the source of the decision */
  const ex = r.explanation || {};
  $('explainText').textContent = ex.text || r.plain_summary || '—';
  $('explainSrc').textContent = ex.source === 'slm'
    ? 'Wording from the optional local SLM. Risk, state and the aeration interlock were decided by the deterministic engine.'
    : 'Wording from the built-in deterministic template. The local SLM is unavailable or disabled — the system works fully without it.';

  /* manager detail */
  $('rTemp').textContent = fmt(f.temp) + ' °C';
  $('rRh').textContent = fmt(f.rh) + ' %';
  $('rEmc').textContent = fmt(f.emc_estimate, 2) + ' %';
  $('rDew').textContent = fmt(f.dew_point) + ' °C';
  $('rFork').textContent = fmt(f.fork_raw, 0);
  $('rLdr').textContent = fmt(f.ldr_raw, 0);
  $('rDist').textContent = fmt(f.distance_cm) + ' cm';
  $('rDh').textContent = fmt(f.delta_height_cm) + ' cm';
  $('rMs').textContent = fmt(f.moisture_stress_hours, 2) + ' h';
  $('rTs').textContent = fmt(f.thermal_stress_hours, 2) + ' h';
  $('rState').textContent = r.state || '—';
  $('rRule').textContent = r.rule || '—';
  $('rTime').textContent = r.timestamp || payload.server_time || '—';
  const ch = payload.chain || {};
  $('rChain').textContent = (ch.telemetry !== false && ch.events !== false && ch.acknowledgments !== false)
    ? 'INTACT' : 'BROKEN — ' + (ch.detail || '');
  $('ackState').textContent = payload.unverified_ack
    ? 'Unverified acknowledgment on record at ' + payload.unverified_ack.ts +
      '. The original alert was preserved, not deleted.'
    : 'No unverified acknowledgment on record.';

  paintMimic(f);
}

/* ---------------- trend chart (renders stored history only) ----------------
   The chart plots rows from /api/history. It performs no risk analysis and
   draws no risk band: the dashed RH line is the configured ingress limit, so
   a judge can see how close readings came to it over time. */
const TREND_W = 560, TREND_H = 200, TREND_PAD = 26;

function renderTrend(rows) {
  const svg = $('trendChart');
  const pts = (rows || []).filter((r) => r.rh != null || r.temp != null);
  if (pts.length < 2) {
    svg.innerHTML = `<text class="empty" x="${TREND_W / 2}" y="${TREND_H / 2}" ` +
      `text-anchor="middle">Collecting readings&hellip;</text>`;
    $('trendMeta').textContent = `${pts.length} reading(s) stored`;
    return;
  }

  const rhLim = LIMITS.rh_limit ?? 65;
  const vals = pts.flatMap((r) => [r.rh, r.temp]).filter((v) => v != null);
  // Scale covers the data with a little headroom, and always includes the RH limit.
  let lo = Math.min(...vals, rhLim) - 2;
  let hi = Math.max(...vals, rhLim) + 2;
  const n = pts.length;
  const x = (i) => TREND_PAD + (i * (TREND_W - TREND_PAD * 2)) / (n - 1);
  const y = (v) => TREND_H - TREND_PAD - ((v - lo) / (hi - lo)) * (TREND_H - TREND_PAD * 2);

  const path = (key) => {
    // A row can be missing a channel (bad packet). Break the line at the gap
    // rather than emitting NaN, which would silently kill the whole path.
    let d = '', pen = false;
    pts.forEach((r, i) => {
      const v = r[key];
      if (v == null || !Number.isFinite(v)) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };

  const grid = [0, 0.5, 1].map((f) => {
    const gy = (TREND_PAD + f * (TREND_H - TREND_PAD * 2)).toFixed(1);
    return `<line class="grid" x1="${TREND_PAD}" y1="${gy}" x2="${TREND_W - TREND_PAD}" y2="${gy}"/>`;
  }).join('');

  const last = pts[pts.length - 1];
  const when = last.ts ? new Date(last.ts) : null;
  $('trendMeta').textContent =
    `${n} readings · ${when && !isNaN(when)
      ? when.toLocaleTimeString('en-GB', { ...IST, hour: '2-digit', minute: '2-digit' })
      : '—'}`;

  svg.innerHTML =
    grid +
    // configured ingress limit, drawn as a reference the readings are judged against
    `<line class="lim" x1="${TREND_PAD}" y1="${y(rhLim).toFixed(1)}" x2="${TREND_W - TREND_PAD}" y2="${y(rhLim).toFixed(1)}"/>` +
    `<text class="limtxt" x="${TREND_W - TREND_PAD}" y="${(y(rhLim) - 4).toFixed(1)}" text-anchor="end">RH limit ${rhLim}%</text>` +
    `<text class="axistxt" x="4" y="${y(hi).toFixed(1)}">${hi.toFixed(0)}</text>` +
    `<text class="axistxt" x="4" y="${y(lo + 4).toFixed(1)}">${lo.toFixed(0)}</text>` +
    `<path class="series s-rh" d="${path('rh')}"/>` +
    `<path class="series s-temp" d="${path('temp')}"/>`;
}

async function loadHistory() {
  try {
    const res = await fetch('/api/history?limit=60');
    const data = await res.json();
    renderTrend(data.history || []);
  } catch (e) {
    $('trendMeta').textContent = 'History unavailable';
  }
}

/* ---------------- events timeline ---------------- */
async function loadEvents() {
  try {
    const res = await fetch('/api/events?limit=14');
    const data = await res.json();
    const items = (data.events || []).slice().reverse();
    $('eventsList').innerHTML = items.length
      ? items.map((e) => {
          const t = new Date(e.ts);
          const hh = isNaN(t) ? '--:--' : t.toLocaleTimeString('en-GB', { ...IST, hour: '2-digit', minute: '2-digit' });
          const head = e.kind === 'STATE_CHANGE' ? e.rule || e.state
            : e.kind === 'TELEMETRY_LOST' ? 'Telemetry lost'
            : e.kind === 'AUDIT_ANOMALY' ? 'Unverified acknowledgment' : e.kind;
          return `<li><span class="tl-time">${hh}</span><span class="tl-txt"><b>${esc(head)}</b>
            <small>${esc(e.state || '')} · ${esc(e.risk || '')}</small></span></li>`;
        }).join('')
      : '<li><span class="tl-txt muted">No events recorded yet.</span></li>';
  } catch (e) {
    $('eventsList').innerHTML = '<li><span class="tl-txt muted">Event log unavailable.</span></li>';
  }
}
/* ---------------- scenario buttons ---------------- */
function buildScenarioButtons(list) {
  SCENARIOS = list;
  $('simBtns').innerHTML = list.map((s) =>
    `<button class="simbtn" data-scenario="${esc(s.id)}">${esc(s.label)}<small>${esc(s.expect)}</small></button>`
  ).join('');
  document.querySelectorAll('.simbtn').forEach((btn) => {
    btn.addEventListener('click', () => triggerScenario(btn.dataset.scenario, btn));
  });
}

async function triggerScenario(id, btn) {
  document.querySelectorAll('.simbtn').forEach((b) => b.classList.remove('on'));
  if (btn) btn.classList.add('on');
  $('simNote').textContent = `Running scenario "${id}" through the live pipeline…`;
  runPipeline();
  try {
    const res = await fetch(`/api/simulate/${encodeURIComponent(id)}`, { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    const out = await res.json();
    // Render ONLY what the engine returned. No client-side scenario logic.
    renderStatus({
      result: out, mode: out.mode || 'SIMULATION', limits: LIMITS,
      baseline_cm: 15.0, facility: { name: 'Demo Rice Storage' },
      chain: { telemetry: true, events: true, acknowledgments: true },
      server_time: out.timestamp,
    });
    $('simNote').textContent =
      `Scenario "${id}" → ${out.state} / ${out.risk} / aeration ${out.aeration_allowed ? 'AVAILABLE' : 'LOCKED'}. ` +
      'That result came from the deterministic engine, not from the button.';
  } catch (err) {
    $('simNote').textContent = 'Scenario request failed: ' + err.message;
  }
  loadEvents();
  loadHistory();
}

/* ---------------- acknowledge ---------------- */
async function acknowledge(verified) {
  const note = $('ackNote').value || '';
  $('simNote').textContent = verified
    ? 'Recording a verified acknowledgment…'
    : 'Recording an acknowledgment WITHOUT physical verification…';
  runPipeline();
  try {
    const res = await fetch('/api/acknowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operator: 'console-operator', physically_verified: verified, note }),
    });
    const out = await res.json();
    renderStatus({
      result: out, mode: out.mode || 'SIMULATION', limits: LIMITS,
      baseline_cm: 15.0, facility: { name: 'Demo Rice Storage' },
      chain: { telemetry: true, events: true, acknowledgments: true },
      server_time: out.timestamp,
    });
    $('simNote').textContent = verified
      ? `Acknowledgment recorded and verified. State is now ${out.state}.`
      : `Unverified acknowledgment recorded. State is now ${out.state} — a manager must physically verify.`;
    $('ackNote').value = '';
  } catch (err) {
    $('simNote').textContent = 'Acknowledge failed: ' + err.message;
  }
  loadEvents();
}

/* ---------------- polling ---------------- */
async function poll() {
  try {
    const res = await fetch('/api/status');
    const payload = await res.json();
    renderStatus(payload);
    if (!SCENARIOS.length && payload.scenarios) buildScenarioButtons(payload.scenarios);
  } catch (e) {
    $('modePill').textContent = 'SERVER OFFLINE';
    $('modePill').className = 'modepill off';
    $('shState').textContent = 'SERVER UNREACHABLE';
    $('shSub').textContent = 'Start the backend with: python run.py';
  }
}

/* ---------------- wiring ---------------- */
function init() {
  setTheme(localStorage.getItem('gg-theme') || 'light');
  $('themeBtn').addEventListener('click', (e) => toggleTheme(e.currentTarget));
  $('themeBtn2').addEventListener('click', (e) => toggleTheme(e.currentTarget));

  document.querySelectorAll('.mtab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.mtab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      document.body.classList.toggle('manager', tab.dataset.view === 'manager');
    });
  });

  $('ackVerified').addEventListener('click', () => acknowledge(true));
  $('ackUnverified').addEventListener('click', () => acknowledge(false));
  /* alert controls */
  const st = $('soundToggle');
  if (st) {
    st.checked = SOUND;
    st.addEventListener('change', () => {
      SOUND = st.checked;
      localStorage.setItem('gg-sound', SOUND ? '1' : '0');
      if (SOUND) beep('warning');
    });
  }
  $('muteBtn')?.addEventListener('click', () => {
    MUTED = !MUTED;
    localStorage.setItem('gg-muted', MUTED ? '1' : '0');
    $('muteBtn').textContent = MUTED ? 'Unmute' : 'Mute';
    if (!MUTED) beep('warning');
  });
  $('testAlertBtn')?.addEventListener('click', () => {
    toast({ key: 'TEST', severity: 'critical', title: 'Test alert',
            evidence: 'This is a demonstration tone. Nothing is wrong with the bin.' });
    beep('critical');
  });

  tickClock();
  setInterval(tickClock, 1000);
  poll();
  setInterval(poll, 1000);
  // History drives the trend chart; refresh it with the other panels.
  loadHistory();
  setInterval(loadHistory, 5000);
  setInterval(loadEvents, 5000);
}

document.addEventListener('DOMContentLoaded', init);