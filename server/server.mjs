// Local demo server. Synthetic data only. No real LIS connection, no real signing.
// The system only SUGGESTS: it reads each report and highlights what looks wrong. The doctor decides and signs.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { llmStatus, buildLlmInput, explainReport } from './llm.mjs';
import { evaluateReport, DECISIONS } from '../src/core/engine.js';
import { buildHistoryIndex, historyFor } from '../src/core/history.js';
import { loadModels, stackFingerprint } from '../src/core/load-models.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = p => JSON.parse(readFileSync(root + p, 'utf8'));

// Startup never trains models and never calls Python: the app only uses the model JSON committed in models/
// (trained offline by ml/train_runtime.py). Without them it runs on rules alone and says so.
export function ensureArtifacts(log = console.log) {
  if (!existsSync(root + 'data/synthetic/dataset.json')) {
    log('Chưa có dữ liệu giả lập → đang sinh (seed cố định)…');
    execFileSync(process.execPath, [root + 'scripts/generate-data.mjs'], { stdio: 'inherit' });
  }
  if (!Object.keys(loadModels(root + 'models')).length)
    log('Không tìm thấy mô hình trong models/ → chỉ chạy rule. Huấn luyện ngoại tuyến: xem README (ml/train_runtime.py).');
  if (!existsSync(root + 'reports/evaluation-comparison.json')) {
    log('Chưa có báo cáo đánh giá → đang tính (Node, không cần Python)…');
    execFileSync(process.execPath, [root + 'scripts/evaluate-comparison.mjs'], { stdio: 'inherit' });
  }
}

// Model summary for the UI: never ship tree / reference arrays to the browser.
const modelSummary = m => ({ key: m.key, kind: m.kind, name: m.name, version: m.version, algorithm: m.algorithm, threshold: m.threshold,
  status: m.status, scope: m.scope, scopeNote: m.scopeNote, panel: m.panel, keyTests: m.keyTests, targets: m.targets,
  thresholdSelection: m.thresholdSelection, trainedOn: m.trainedOn, benchmarkTest: m.benchmarkTest, disclaimer: m.disclaimer });

function httpError(code, msg) { const e = new Error(msg); e.status = code; return e; }

export function createApp({ runtimeFile = root + 'data/runtime/state.json', signDelayMs = [10000, 15000], signFailRate = 0.1, random = Math.random } = {}) {
  const catalog = read('config/analytes.json');
  const rulesets = { CHEM: read('config/rules.chem.json'), HEME: read('config/rules.heme.json') };
  const models = loadModels(root + 'models');
  const evaluationReport = existsSync(root + 'reports/evaluation-comparison.json') ? read('reports/evaluation-comparison.json') : null;
  // The report is only valid for the exact models/rules/catalog it was computed with.
  const evaluationStale = !!evaluationReport && evaluationReport.fingerprint !== stackFingerprint(models, rulesets, catalog);
  const ds = read('data/synthetic/dataset.json');
  const today = ds.meta.today;
  const baseReports = new Map(ds.reports.map(r => [r.reportId, r]));
  const index = buildHistoryIndex(ds.reports);
  const worklistIds = ds.reports.filter(r => r.specimen.collectedAt.startsWith(today)).map(r => r.reportId);

  // ---------- runtime state ----------
  // Every report is signed by the doctor. Signing is pushed to the hospital signing system (simulated, ~10–15 s each)
  // through a FIFO queue so the doctor can move on to the next report immediately.
  const fresh = () => ({ settings: { modelEnabled: true, showTruth: false, personalMode: 'OFF' }, amendments: {}, reviews: {}, sends: {}, audit: [], feedback: [], notifications: [], seq: 0 });
  let state = fresh();
  if (runtimeFile && existsSync(runtimeFile)) { try { state = { ...fresh(), ...JSON.parse(readFileSync(runtimeFile, 'utf8')) }; } catch { /* corrupted → start fresh */ } }
  state.settings.personalMode ??= 'OFF';
  delete state.settings.mode; // legacy "simulated auto-sign" setting: removed, the system never signs by itself
  let saveTimer = null;
  const persist = () => {
    if (!runtimeFile) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      mkdirSync(resolve(runtimeFile, '..'), { recursive: true });
      writeFileSync(runtimeFile + '.tmp', JSON.stringify(state));
      renameSync(runtimeFile + '.tmp', runtimeFile);
    }, 50);
  };
  const audit = (type, data) => {
    const e = { id: ++state.seq, at: new Date().toISOString(), actor: data.actor ?? 'HỆ THỐNG', type, ...data };
    state.audit.push(e); persist(); return e;
  };
  const notify = (reportId, version, text) => {
    const n = { id: ++state.seq, at: new Date().toISOString(), reportId, version, text, read: false };
    state.notifications.push(n);
    if (state.notifications.length > 200) state.notifications.splice(0, state.notifications.length - 200);
    persist(); return n;
  };

  // A report's current version = base + amendments (each amendment is a new version).
  function currentReport(id) {
    const base = baseReports.get(id);
    if (!base) return null;
    const amends = state.amendments[id] ?? [];
    if (!amends.length) return base;
    const r = structuredClone(base);
    for (const a of amends) {
      for (const c of a.changes) {
        const res = r.results.find(x => x.test === c.test);
        if (!res) continue;
        if ('value' in c) res.value = c.value;
        if ('unit' in c) res.unit = c.unit;
        if ('status' in c) res.status = c.status;
        if (c.measuredAt) res.measuredAt = c.measuredAt;
        res.run = (res.run ?? 1) + (a.kind === 'RERUN' ? 1 : 0);
        res.flags = c.clearFlags ? [] : res.flags;
      }
      if (a.clearInstrumentFlags) r.instrumentFlags = [];
      if (a.hil) r.specimen.hil = a.hil;
      if (a.kind === 'RECOLLECT') {
        // New specimen: results of the old tube never carry over; anything not re-measured is pending, old HIL dropped.
        r.specimen.collectedAt = `${today}T11:50:00+07:00`; r.specimen.receivedAt = `${today}T12:00:00+07:00`; r.specimen.specimenId = base.specimen.specimenId + '-R' + a.version;
        if (!a.hil) r.specimen.hil = null;
        r.instrumentFlags = [];
        for (const x of r.results) if (!a.changes.some(c => c.test === x.test)) { x.status = 'PENDING'; x.value = null; x.flags = []; }
      }
      r.version = a.version;
    }
    return r;
  }

  const evalCache = new Map();
  const llmCache = new Map();
  function evaluate(report) {
    const key = `${report.reportId}|${report.version}|${state.settings.modelEnabled}|${state.settings.personalMode}`;
    if (evalCache.has(key)) return evalCache.get(key);
    const history = historyFor(index, report, catalog);
    const ev = evaluateReport(report, { catalog, rulesets, qcLog: ds.qcLog, history, models, settings: { modelEnabled: state.settings.modelEnabled, personalMode: state.settings.personalMode ?? 'OFF' } });
    evalCache.set(key, ev);
    return ev;
  }

  const sendKey = (id, v) => `${id}:v${v}`;
  const idOfKey = k => k.slice(0, k.lastIndexOf(':v'));
  function sendState(id) {
    const r = currentReport(id);
    const s = state.sends[sendKey(id, r.version)];
    const older = Object.entries(state.sends).filter(([k]) => idOfKey(k) === id && k !== sendKey(id, r.version)).map(([k, v]) => ({ key: k, ...v }));
    return { current: s ?? null, superseded: older };
  }

  // ---------- sign queue: FIFO, one report at a time, simulated hospital signing system ----------
  const signQueue = [];
  let signingKey = null;
  const SIGN_ERRORS = [
    'Hệ thống ký số của bệnh viện không phản hồi (timeout) — mô phỏng',
    'Hệ thống bệnh viện trả HTTP 503 (đang bảo trì) — mô phỏng',
    'Chứng thư số của bác sĩ chưa được mở khóa (token/HSM) — mô phỏng'
  ];
  // Restart: queued items resume in their original order; an item that was mid-signing has an unknown outcome.
  for (const [k, s] of Object.entries(state.sends).sort((a, b) => String(a[1].queuedAt).localeCompare(String(b[1].queuedAt)))) {
    if (s.status === 'QUEUED') signQueue.push(k);
    if (s.status === 'SIGNING' || s.status === 'SENDING') {
      s.status = 'FAILED'; s.error = 'Máy chủ khởi động lại khi đang ký — chưa xác nhận đã ký, cần ký lại';
      notify(idOfKey(k), s.version, `Ký lỗi phiếu ${idOfKey(k)}: ${s.error}`);
    }
  }
  const queuePosition = key => { const i = signQueue.indexOf(key); return i < 0 ? null : i + 1; };

  function enqueueSign(id, actor, via) {
    const r = currentReport(id);
    const key = sendKey(id, r.version);
    const existing = state.sends[key];
    if (existing && ['QUEUED', 'SIGNING', 'SIGNED'].includes(existing.status)) {
      audit('SIGN_DUPLICATE_IGNORED', { reportId: id, version: r.version, actor, note: `Yêu cầu ký trùng (idempotency key ${key}) — bỏ qua, trạng thái hiện tại ${existing.status}` });
      return existing;
    }
    const s = { status: 'QUEUED', idempotencyKey: key, version: r.version, attempts: (existing?.attempts ?? 0) + 1, queuedAt: new Date().toISOString(), via, signId: null, error: null };
    state.sends[key] = s;
    signQueue.push(key);
    audit('SIGN_QUEUED', { reportId: id, version: r.version, actor, note: `${via} → hàng đợi ký (vị trí ${signQueue.length}, lần ${s.attempts})` });
    pump();
    persist();
    return s;
  }

  function pump() {
    while (!signingKey && signQueue.length) {
      const key = signQueue.shift();
      const s = state.sends[key];
      if (!s || s.status !== 'QUEUED') continue;
      const id = idOfKey(key);
      if (currentReport(id).version !== s.version) { s.status = 'SUPERSEDED'; audit('SIGN_SUPERSEDED', { reportId: id, version: s.version, note: 'Phiếu đã có phiên bản mới trước khi ký — bỏ khỏi hàng đợi' }); continue; }
      signingKey = key;
      s.status = 'SIGNING'; s.startedAt = new Date().toISOString();
      audit('SIGN_STARTED', { reportId: id, version: s.version, note: 'Gửi sang hệ thống ký số bệnh viện (mô phỏng)' });
      const delay = signDelayMs[0] + random() * (signDelayMs[1] - signDelayMs[0]);
      const t = setTimeout(() => { signingKey = null; finishSign(id, s); persist(); pump(); }, delay);
      t.unref?.();
    }
  }

  function finishSign(id, s) {
    if (s.status !== 'SIGNING') return;
    if (currentReport(id).version !== s.version) { s.status = 'SUPERSEDED'; audit('SIGN_SUPERSEDED', { reportId: id, version: s.version, note: 'Phiếu đã có phiên bản mới trước khi ký xong — chữ ký cũ không áp dụng cho phiên bản mới' }); return; }
    if (random() < signFailRate) {
      s.status = 'FAILED'; s.failedAt = new Date().toISOString();
      s.error = SIGN_ERRORS[Math.floor(random() * SIGN_ERRORS.length) % SIGN_ERRORS.length];
      audit('SIGN_FAILED', { reportId: id, version: s.version, note: s.error });
      notify(id, s.version, `Ký lỗi phiếu ${id}: ${s.error}`);
    } else {
      s.status = 'SIGNED'; s.signId = 'SIG-' + randomUUID().slice(0, 8).toUpperCase(); s.signedAt = new Date().toISOString();
      audit('SIGN_DONE', { reportId: id, version: s.version, note: `Hệ thống bệnh viện xác nhận ${s.signId}. Chỉ từ lúc này phiếu mới hiển thị "đã ký".` });
    }
  }

  function cancelSign(id, actor = 'Bác sĩ (demo)') {
    const r = currentReport(id);
    const key = sendKey(id, r.version);
    const s = state.sends[key];
    if (!s || s.status !== 'QUEUED') throw httpError(409, s?.status === 'SIGNING' ? 'Phiếu đang được gửi sang hệ thống ký — không rút lại được nữa.' : 'Phiếu không nằm trong hàng đợi ký.');
    s.status = 'CANCELLED';
    const i = signQueue.indexOf(key); if (i >= 0) signQueue.splice(i, 1);
    delete state.reviews[key];
    audit('SIGN_CANCELLED', { reportId: id, version: r.version, actor, note: 'Bác sĩ rút lệnh ký trước khi gửi — phiếu trở về chờ duyệt' });
    persist();
    return detail(id);
  }

  // Doctor-facing work state of the current version.
  function workState(id, r = currentReport(id)) {
    const key = sendKey(id, r.version);
    const rv = state.reviews[key], s = state.sends[key];
    if (rv?.action === 'SIGN') return s?.status === 'FAILED' ? 'SIGN_FAILED' : s?.status === 'SIGNED' ? 'SIGNED' : ['QUEUED', 'SIGNING'].includes(s?.status) ? 'IN_QUEUE' : 'PENDING';
    if (rv?.action === 'FLAG_REVIEW') return 'FLAGGED';
    if (rv?.action === 'REQUEST_RERUN') return 'RERUN_REQUESTED';
    return 'PENDING';
  }

  function summary(id) {
    const r = currentReport(id);
    const ev = evaluate(r);
    const key = sendKey(id, r.version);
    const review = state.reviews[key] ?? null;
    const s = state.sends[key] ?? null;
    return {
      reportId: id, version: r.version, panel: r.panel, panelName: r.panelName, discipline: r.discipline, ward: r.ward,
      subjectToken: r.subjectToken, collectedAt: r.specimen.collectedAt, ageGroup: r.context.ageGroup, sex: r.context.sex,
      decision: ev.decision, priority: ev.priority, criticalValue: ev.criticalValue,
      flaggedTests: [...new Set(ev.checks.filter(c => c.action).flatMap(c => c.analytes))], nIssues: ev.checks.filter(c => c.action).length,
      scenario: r.scenario ? { code: r.scenario.code, title: r.scenario.title } : null,
      workState: workState(id, r),
      review: review ? { action: review.action, at: review.at, note: review.note, tests: review.tests } : null,
      send: s ? { status: s.status, error: s.error, failedAt: s.failedAt, signedAt: s.signedAt, queuedAt: s.queuedAt, position: queuePosition(key) } : null
    };
  }

  function queueStatus() {
    const cur = signingKey ? state.sends[signingKey] : null;
    return {
      signing: cur ? { reportId: idOfKey(signingKey), version: cur.version, startedAt: cur.startedAt } : null,
      queued: signQueue.map(k => ({ reportId: idOfKey(k), version: state.sends[k].version, queuedAt: state.sends[k].queuedAt })),
      failed: worklistIds.filter(id => workState(id) === 'SIGN_FAILED').length,
      delaySeconds: signDelayMs.map(v => Math.round(v / 1000))
    };
  }

  function historySeries(r) {
    const h = historyFor(index, r, catalog);
    const series = {};
    for (const x of h) (series[x.test] ??= []).push({ value: x.value, measuredAt: x.measuredAt, reportId: x.reportId });
    for (const k of Object.keys(series)) series[k] = series[k].slice(-5);
    return series;
  }

  function detail(id) {
    const r = currentReport(id);
    const ev = evaluate(r);
    const { truth, reviewer, split, ...visible } = r;
    const key = sendKey(id, r.version);
    return {
      report: visible, evaluation: ev, history: historySeries(r),
      analyteInfo: Object.fromEntries(r.orderedTests.map(t => { const d = catalog.analytes[t]; return [t, { name: d.name, unit: d.unit, ref: d.ref[r.context.sex] ?? d.ref.M, avLimits: d.avLimits, critical: d.critical, amr: d.amr, rcvPct: d.rcvPct, instrument: d.instrument }]; })),
      workState: workState(id, r), queuePosition: queuePosition(key),
      review: state.reviews[key] ?? null,
      reviewsAllVersions: Object.entries(state.reviews).filter(([k]) => idOfKey(k) === id).map(([k, v]) => ({ key: k, ...v })),
      amendments: state.amendments[id] ?? [],
      send: sendState(id),
      audit: state.audit.filter(a => a.reportId === id),
      feedback: state.feedback.filter(f => f.reportId === id),
      qcRelevant: ds.qcLog.filter(q => q.at.startsWith(today) && r.results.some(x => x.instrument === q.instrument && x.test === q.test) && (q.status !== 'PASS' || q.note)),
      simulationTruth: state.settings.showTruth ? { truth, simulatedReviewer: reviewer ?? null, split } : null
    };
  }

  // ---------- doctor actions: Ký / Cần xem xét lại / Yêu cầu chạy lại mẫu ----------
  // Reason codes are optional quick picks: the doctor can always just click.
  const REASONS = {
    SIGN: [],
    FLAG_REVIEW: ['SUSPECT_SPECIMEN', 'SUSPECT_WBIT', 'SUSPECT_INSTRUMENT', 'NEED_CONTEXT', 'ASK_COLLEAGUE', 'OTHER'],
    REQUEST_RERUN: ['RERUN', 'RECOLLECT', 'DILUTE', 'SMEAR_REVIEW', 'CHECK_TUBE_LABEL', 'OTHER']
  };

  function act(id, body) {
    const r = currentReport(id);
    const ev = evaluate(r);
    const { action, reasonCode = null, note = '', criticalNotified = false, tests = [], actor = 'Bác sĩ (demo)' } = body;
    if (!REASONS[action]) throw httpError(400, 'Hành động không hợp lệ');
    if (reasonCode != null && reasonCode !== '' && !REASONS[action].includes(reasonCode)) throw httpError(400, 'Mã lý do không hợp lệ');
    if (String(note).length > 1000) throw httpError(400, 'Ghi chú quá dài');
    const key = sendKey(id, r.version);
    const cur = state.sends[key];
    if (['QUEUED', 'SIGNING'].includes(cur?.status)) throw httpError(409, `Phiếu v${r.version} đang trong hàng đợi ký. Rút lệnh ký trước nếu muốn đổi quyết định.`);
    if (cur?.status === 'SIGNED') throw httpError(409, `Phiếu v${r.version} đã ký. Muốn thay đổi cần tạo phiên bản mới.`);
    let rerunTests = [];
    if (action === 'SIGN') {
      if (ev.decision === DECISIONS.BLOCKED) throw httpError(409, 'Phiếu có lỗi dữ liệu/QC/mẫu nên chưa ký được (thiếu kết quả, sai đơn vị, QC không đạt…). Yêu cầu chạy lại mẫu hoặc xử lý, rồi ký phiên bản mới.');
      if (ev.criticalValue && criticalNotified !== true) throw httpError(409, 'Phiếu có giá trị tới hạn: cần xác nhận đã thông báo lâm sàng trước khi ký.');
    }
    if (action === 'REQUEST_RERUN') {
      rerunTests = [...new Set((Array.isArray(tests) ? tests : []).map(String))];
      if (!rerunTests.length) throw httpError(400, 'Chọn ít nhất một xét nghiệm cần chạy lại');
      const bad = rerunTests.find(t => !r.orderedTests.includes(t));
      if (bad) throw httpError(400, `Xét nghiệm ${bad} không thuộc chỉ định`);
    }
    if (reasonCode === 'OTHER' && !String(note).trim()) throw httpError(400, 'Vui lòng ghi lý do');
    const rec = { action, reasonCode: reasonCode || null, note: String(note).trim(), actor, at: new Date().toISOString(), version: r.version, evaluationDecision: ev.decision };
    if (action === 'SIGN' && ev.criticalValue) rec.criticalNotified = true;
    if (action === 'REQUEST_RERUN') rec.tests = rerunTests;
    state.reviews[key] = rec;
    audit('REVIEW_' + action, { reportId: id, version: r.version, actor,
      note: [reasonCode, rerunTests.length ? 'chạy lại ' + rerunTests.join(', ') : '', rec.criticalNotified ? 'đã báo giá trị tới hạn' : '', rec.note].filter(Boolean).join(' — '),
      decision: ev.decision, rulesetVersion: ev.rulesetVersion, modelVersions: ev.modelVersions, inputHash: ev.inputHash });
    state.feedback.push({
      feedbackId: 'FB-' + String(state.feedback.length + 1).padStart(4, '0'), reportId: id, version: r.version, discipline: r.discipline, createdAt: rec.at,
      systemDecision: ev.decision, systemReasons: ev.checks.filter(c => c.action).map(c => c.code), modelScores: ev.models.filter(m => m.status === 'SCORED').map(m => ({ key: m.key, score: m.score, flagged: m.flagged })),
      rulesetVersion: ev.rulesetVersion, modelVersions: ev.modelVersions, inputHash: ev.inputHash,
      reviewerAction: action, reasonCode: rec.reasonCode, note: rec.note, tests: rec.tests ?? [],
      agreement: (action === 'SIGN') === (ev.decision === DECISIONS.AUTO) ? 'ĐỒNG Ý' : 'KHÁC',
      labelStatus: 'CHƯA RÀ SOÁT', usableForTraining: false, affectsRunningRules: false
    });
    if (action === 'SIGN') enqueueSign(id, actor, 'Bác sĩ bấm ký');
    persist();
    return detail(id);
  }

  function resign(id, actor = 'Bác sĩ (demo)') {
    const st = sendState(id).current;
    if (!st || st.status !== 'FAILED') throw httpError(409, 'Chỉ ký lại khi lần ký trước thất bại');
    const cur = currentReport(id);
    const rv = state.reviews[sendKey(id, cur.version)];
    if (rv?.action !== 'SIGN') throw httpError(409, 'Quyết định hiện tại của phiên bản này không còn là "ký" — không ký lại.');
    if (evaluate(cur).decision === DECISIONS.BLOCKED) throw httpError(409, 'Phiếu đang có lỗi chặn — không ký lại.');
    enqueueSign(id, actor, 'Ký lại sau lỗi');
    for (const n of state.notifications) if (n.reportId === id && n.version === cur.version) n.read = true;
    return detail(id);
  }

  // Simulates the instrument sending a new run (or a data fix) back to the LIS → new version, re-read by the system.
  function amend(id, body) {
    const r = currentReport(id);
    const { kind, changes = [], note = '', actor = 'Kỹ thuật viên (demo)', clearFlags = false, hil = null } = body;
    if (!['RERUN', 'UNIT_FIX', 'RECOLLECT', 'MANUAL_CORRECTION'].includes(kind)) throw httpError(400, 'Loại cập nhật không hợp lệ');
    if (!String(note).trim()) throw httpError(400, 'Vui lòng ghi lý do cập nhật');
    const version = (r.version ?? 1) + 1;
    // Demo clock: re-runs happen "now" (today 12:xx), after the scripted QC recovery; a unit fix keeps the original run time.
    const rerunAt = ['RERUN', 'RECOLLECT'].includes(kind) ? `${today}T12:${String(10 + version).padStart(2, '0')}:00+07:00` : null;
    const clean = [];
    for (const c of changes) {
      if (!r.orderedTests.includes(c.test)) throw httpError(400, `Xét nghiệm ${c.test} không thuộc chỉ định`);
      const v = c.value === '' || c.value == null ? null : Number(c.value);
      if (v != null && !Number.isFinite(v)) throw httpError(400, `Giá trị ${c.test} không hợp lệ`);
      clean.push({ test: c.test, value: v, unit: c.unit ?? catalog.analytes[c.test].unit, status: v == null ? 'PENDING' : 'RESULTED', measuredAt: rerunAt, clearFlags });
    }
    if (!clean.length && !clearFlags && !hil) throw httpError(400, 'Không có thay đổi');
    const a = { version, kind, changes: clean, note: String(note).trim(), actor, at: new Date().toISOString(), clearInstrumentFlags: !!clearFlags, hil };
    (state.amendments[id] ??= []).push(a);
    // A queued signature of the old version must never be applied to the new one.
    const oldKey = sendKey(id, r.version), old = state.sends[oldKey];
    if (old?.status === 'QUEUED') { old.status = 'SUPERSEDED'; const i = signQueue.indexOf(oldKey); if (i >= 0) signQueue.splice(i, 1); }
    const ev = evaluate(currentReport(id));
    audit('REPORT_AMENDED', { reportId: id, version, actor, note: `${kind}: ${clean.map(c => `${c.test}=${c.value ?? '—'} ${c.unit}`).join(', ')}${clearFlags ? ' (xóa cờ sau chạy lại)' : ''} — ${a.note}. Đề xuất cũ hết hiệu lực; hệ thống đọc lại: ${ev.decision}` });
    persist();
    return detail(id);
  }

  // Manual "try it" evaluation: never written into the worklist.
  function tryEvaluate(body) {
    const panel = catalog.panels[body.panel];
    if (!panel) throw httpError(400, 'Bảng xét nghiệm không hợp lệ');
    const now = Date.parse(`${today}T12:00:00+07:00`);
    const collected = now - (Number(body.collectedMinutesAgo ?? 60)) * 60000;
    const measuredAt = new Date(now + 7 * 3600000).toISOString().slice(0, 19) + '+07:00';
    const values = body.values ?? {};
    const report = {
      reportId: 'TRY-' + randomUUID().slice(0, 6).toUpperCase(), version: 1, subjectToken: 'SBJ-TRY', panel: body.panel, panelName: panel.name, discipline: panel.discipline, ward: body.ward ?? 'OPD',
      orderedTests: [...panel.tests],
      specimen: { specimenId: 'SPC-TRY', type: panel.specimen, collectedAt: new Date(collected + 7 * 3600000).toISOString().slice(0, 19) + '+07:00', receivedAt: measuredAt,
        hil: panel.discipline === 'CHEM' ? (body.hil && ['H', 'L', 'I'].every(k => body.hil[k] !== '' && body.hil[k] != null) ? { H: Number(body.hil.H), L: Number(body.hil.L), I: Number(body.hil.I) } : null) : null },
      results: panel.tests.map(t => {
        const v = values[t] ?? {};
        const status = v.status ?? (v.value === '' || v.value == null ? 'PENDING' : 'RESULTED');
        return { test: t, status, value: status === 'RESULTED' ? Number(v.value) : null, unit: v.unit ?? catalog.analytes[t].unit, instrument: catalog.analytes[t].instrument, measuredAt, run: 1, flags: [] };
      }),
      instrumentFlags: (body.flags ?? []).filter(Boolean).map(code => ({ code: String(code).toUpperCase().slice(0, 40), source: 'MANUAL' })),
      context: { age: Number(body.age ?? 50), ageGroup: '', sex: body.sex === 'F' ? 'F' : 'M', fasting: 'UNKNOWN', ivInfusion: 'UNKNOWN', conditions: [], medications: [], events: [] }
    };
    const history = (body.history ?? []).filter(h => h && h.test && h.value !== '' && h.value != null).map(h => ({
      test: h.test, value: Number(h.value), unit: catalog.analytes[h.test]?.unit, measuredAt: new Date(now - Number(h.daysAgo ?? 7) * 86400000 + 7 * 3600000).toISOString().slice(0, 19) + '+07:00', reportId: 'TRY-HIST' }));
    const qcStatus = body.qc ?? 'PASS';
    const qcLog = qcStatus === 'NONE' ? [] : panel.tests.map(t => ({ instrument: catalog.analytes[t].instrument, test: t, at: new Date(now - 3600000 + 7 * 3600000).toISOString().slice(0, 19) + '+07:00', status: qcStatus, level: 'L1+L2', note: 'QC nhập tay (thử)' }));
    const ev = evaluateReport(report, { catalog, rulesets, qcLog, history, models, settings: { modelEnabled: state.settings.modelEnabled, personalMode: state.settings.personalMode ?? 'OFF' } });
    audit('MANUAL_TRY', { reportId: null, actor: 'Bác sĩ (demo)', note: `Nhập thử ${body.panel}: ${ev.decision} (không ghi vào hàng đợi)`, inputHash: ev.inputHash });
    return { report, evaluation: ev, analyteInfo: Object.fromEntries(panel.tests.map(t => { const d = catalog.analytes[t]; return [t, { name: d.name, unit: d.unit, ref: d.ref[report.context.sex], avLimits: d.avLimits, critical: d.critical, amr: d.amr }]; })) };
  }

  // ---------- HTTP ----------
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  async function body(req) {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > 200_000) throw httpError(413, 'Payload quá lớn'); chunks.push(c); }
    try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { throw httpError(400, 'JSON không hợp lệ'); }
  }
  const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (p.startsWith('/api/')) {
        if (req.method === 'POST' && req.headers['content-type']?.split(';')[0] !== 'application/json') throw httpError(415, 'Cần Content-Type: application/json');
        const m = p.match(/^\/api\/reports\/([A-Z0-9-]+)(?:\/(action|amend|resign|cancel-sign|explain))?$/);
        if (req.method === 'GET' && p === '/api/meta') return json(res, 200, { today, disclaimer: ds.meta.disclaimer, llm: llmStatus(), settings: state.settings, rulesets: Object.fromEntries(Object.entries(rulesets).map(([k, v]) => [k, { version: v.version, status: v.status }])), models: Object.values(models).map(modelSummary), catalogVersion: catalog.version, worklistSize: worklistIds.length, reasons: REASONS, panels: catalog.panels, analytes: catalog.analytes, signDelaySeconds: signDelayMs.map(v => Math.round(v / 1000)) });
        if (req.method === 'GET' && p === '/api/worklist') return json(res, 200, worklistIds.map(summary));
        if (req.method === 'GET' && p === '/api/queue') return json(res, 200, queueStatus());
        if (req.method === 'GET' && p === '/api/notifications') return json(res, 200, state.notifications.slice(-50).reverse());
        if (req.method === 'POST' && p === '/api/notifications/read') {
          const b = await body(req);
          const ids = Array.isArray(b.ids) ? new Set(b.ids.map(Number)) : null;
          for (const n of state.notifications) if (!ids || ids.has(n.id)) n.read = true;
          persist();
          return json(res, 200, { ok: true });
        }
        if (m && req.method === 'GET' && !m[2]) { if (!baseReports.has(m[1])) throw httpError(404, 'Không tìm thấy phiếu'); return json(res, 200, detail(m[1])); }
        if (m && req.method === 'POST' && m[2]) {
          if (!worklistIds.includes(m[1])) throw httpError(404, 'Phiếu không thuộc danh sách hôm nay');
          const b = await body(req);
          if (m[2] === 'explain') {
            const status = llmStatus();
            if (!status.configured) throw httpError(503, status.reason);
            const d = detail(m[1]);
            const input = buildLlmInput(d);
            const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
            const key = JSON.stringify([m[1], d.report.version, d.evaluation.inputHash, inputHash, status.model, process.env.OPENAI_BASE_URL]);
            const controller = new AbortController();
            const abort = () => controller.abort();
            res.once('close', abort);
            let explanation;
            const cached = llmCache.has(key);
            try {
              explanation = llmCache.get(key) ?? await explainReport(input, { signal: controller.signal });
            } finally { res.off('close', abort); }
            // An amendment/settings change during the request invalidates this explanation.
            const current = detail(m[1]);
            if (current.report.version !== d.report.version || JSON.stringify(buildLlmInput(current)) !== JSON.stringify(input)) {
              throw httpError(409, 'Phiếu hoặc đánh giá đã thay đổi. Vui lòng tải lại và yêu cầu diễn giải mới.');
            }
            if (!cached) {
              if (llmCache.size >= 300) llmCache.delete(llmCache.keys().next().value);
              llmCache.set(key, explanation);
            }
            audit('LLM_EXPLAIN', { reportId: m[1], version: d.report.version, model: explanation.model, latencyMs: explanation.latencyMs, cached });
            return json(res, 200, { text: explanation.text, model: explanation.model, latencyMs: explanation.latencyMs,
              disclaimer: 'LLM chỉ diễn giải lý do của hệ thống và gợi ý kiểm tra theo SOP; không quyết định ký, không chẩn đoán, không kê thuốc. Dữ liệu giả lập.' });
          }
          if (m[2] === 'action') return json(res, 200, act(m[1], b));
          if (m[2] === 'amend') return json(res, 200, amend(m[1], b));
          if (m[2] === 'cancel-sign') return json(res, 200, cancelSign(m[1], b.actor));
          return json(res, 200, resign(m[1], b.actor));
        }
        if (req.method === 'POST' && p === '/api/settings') {
          const b = await body(req);
          if ('personalMode' in b && !['OFF', 'TIGHTEN', 'ADAPT'].includes(b.personalMode)) throw httpError(400, 'Chế độ ngưỡng không hợp lệ');
          const keys = ['personalMode', 'modelEnabled', 'showTruth'].filter(k => k in b);
          const before = { ...state.settings };
          for (const k of keys) state.settings[k] = k === 'personalMode' ? b[k] : !!b[k];
          audit('SETTINGS_CHANGED', { note: keys.map(k => `${k}: ${before[k]} → ${state.settings[k]}`).join('; '), actor: 'Bác sĩ (demo)' });
          return json(res, 200, state.settings);
        }
        if (req.method === 'POST' && p === '/api/evaluate') return json(res, 200, tryEvaluate(await body(req)));
        if (req.method === 'POST' && p === '/api/reset') {
          if (signingKey || signQueue.length) throw httpError(409, 'Đang có phiếu trong hàng đợi ký — chờ xong rồi mới xóa trạng thái demo.');
          state = fresh(); evalCache.clear(); llmCache.clear(); audit('RESET', { note: 'Xóa trạng thái demo (thao tác, nhật ký, phiên bản sửa, thông báo)' }); return json(res, 200, { ok: true });
        }
        if (req.method === 'GET' && p === '/api/audit') return json(res, 200, state.audit.slice(-500).reverse());
        if (req.method === 'GET' && p === '/api/feedback') return json(res, 200, state.feedback);
        if (req.method === 'GET' && p === '/api/feedback.csv') {
          const cols = ['feedbackId', 'reportId', 'version', 'discipline', 'createdAt', 'systemDecision', 'systemReasons', 'rulesetVersion', 'modelVersions', 'inputHash', 'reviewerAction', 'reasonCode', 'tests', 'agreement', 'labelStatus', 'note'];
          const esc = v => { const s = Array.isArray(v) ? v.join('|') : v == null ? '' : String(v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s; };
          res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="feedback-demo.csv"' });
          return res.end('﻿' + [cols.join(','), ...state.feedback.map(f => cols.map(c => esc(f[c])).join(','))].join('\n'));
        }
        if (req.method === 'GET' && p === '/api/rules') return json(res, 200, { rulesets, catalog });
        if (req.method === 'GET' && p === '/api/evaluation') return json(res, 200, { evaluation: evaluationReport, stale: evaluationStale, models: Object.values(models).map(modelSummary) });
        throw httpError(404, 'Không có API này');
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw httpError(405, 'Method not allowed');
      const rel = p === '/' ? 'public/index.html' : p.startsWith('/core/') ? 'src/core/' + p.slice(6) : 'public' + p;
      const file = resolve(root, decodeURIComponent(rel));
      const ok = (file.startsWith(resolve(root, 'public') + sep) || file.startsWith(resolve(root, 'src/core') + sep)) && types[extname(file)];
      if (!ok) throw httpError(404, 'Not found');
      const bytes = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[extname(file)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (e) {
      const code = e.status ?? (e.code === 'ENOENT' ? 404 : 500);
      if (code === 500) console.error(e);
      if (p.startsWith('/api/')) return json(res, code, { error: code === 500 ? 'Lỗi máy chủ' : e.message });
      res.writeHead(code); res.end(code === 404 ? 'Not found' : 'Error');
    }
  }
  return { handle, state: () => state, worklistIds, currentReport, evaluate, queueStatus };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile(resolve(root, '.env')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  ensureArtifacts();
  const app = createApp();
  const port = Number(process.env.PORT || 5173), host = process.env.HOST || '127.0.0.1';
  const server = createServer(app.handle);
  server.listen(port, host, () => console.log(`\nLabReview (DỮ LIỆU GIẢ LẬP): http://${host}:${server.address().port}\n`));
  server.on('error', e => { console.error(e.message); process.exitCode = 1; });
}
