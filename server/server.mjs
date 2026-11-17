// Local demo server. Synthetic data only. No real LIS connection, no real signing.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { llmStatus, buildLlmInput, explainReport } from './llm.mjs';
import { evaluateReport, DECISIONS } from '../src/core/engine.js';
import { buildHistoryIndex, historyFor } from '../src/core/history.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = p => JSON.parse(readFileSync(root + p, 'utf8'));

export function ensureArtifacts(log = console.log) {
  if (!existsSync(root + 'data/synthetic/dataset.json')) {
    log('Chưa có dữ liệu giả lập → đang sinh (seed cố định)…');
    execFileSync(process.execPath, [root + 'scripts/generate-data.mjs'], { stdio: 'inherit' });
  }
  if (!existsSync(root + 'models/chem_wbit.json') || !existsSync(root + 'reports/evaluation.json')) {
    log('Chưa có mô hình → đang huấn luyện…');
    execFileSync(process.execPath, [root + 'scripts/train.mjs'], { stdio: 'inherit' });
  }
  if (!existsSync(root + 'models/heme_wbit_xgb.json')) {
    log('Chưa có detector XGBoost → đang huấn luyện…');
    execFileSync(process.execPath, [root + 'scripts/train-xgb.mjs'], { stdio: 'inherit' });
  }
  if (!existsSync(root + 'models/chem_wbit_xgb.json') || !existsSync(root + 'models/chem_contam_xgb.json'))
    execFileSync(process.execPath, [root + 'scripts/train-xgb.mjs'], { stdio: 'inherit' });
  if (!existsSync(root + 'reports/evaluation-comparison.json'))
    execFileSync(process.execPath, [root + 'scripts/evaluate-comparison.mjs'], { stdio: 'inherit' });
}

export function createApp({ runtimeFile = root + 'data/runtime/state.json', sendDelayMs = [700, 1800], sendFailRate = 0.1, random = Math.random } = {}) {
  const catalog = read('config/analytes.json');
  const rulesets = { CHEM: read('config/rules.chem.json'), HEME: read('config/rules.heme.json') };
  const models = Object.fromEntries(readdirSync(root + 'models').filter(f => f.endsWith('.json')).map(f => [f.replace('.json', ''), read('models/' + f)]));
  const evaluationReport = read(existsSync(root + 'reports/evaluation-comparison.json') ? 'reports/evaluation-comparison.json' : 'reports/evaluation.json');
  const ds = read('data/synthetic/dataset.json');
  const today = ds.meta.today;
  const baseReports = new Map(ds.reports.map(r => [r.reportId, r]));
  const index = buildHistoryIndex(ds.reports);
  const worklistIds = ds.reports.filter(r => r.specimen.collectedAt.startsWith(today)).map(r => r.reportId);

  // ---------- runtime state ----------
  const fresh = () => ({ settings: { mode: 'SHADOW', modelEnabled: true, showTruth: false, personalMode: 'OFF' }, amendments: {}, reviews: {}, sends: {}, audit: [], feedback: [], seq: 0 });
  let state = fresh();
  if (runtimeFile && existsSync(runtimeFile)) { try { state = { ...fresh(), ...JSON.parse(readFileSync(runtimeFile, 'utf8')) }; } catch { /* corrupted → start fresh */ } }
  state.settings.personalMode ??= 'OFF';
  // A send still "SENDING" after restart has no pending ACK timer: mark it failed so it can be retried explicitly.
  for (const s of Object.values(state.sends)) if (s.status === 'SENDING') { s.status = 'FAILED'; s.error = 'Máy chủ khởi động lại trước khi có ACK — chưa xác nhận đã gửi, cần gửi lại'; }
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
  function sendState(id) {
    const r = currentReport(id);
    const s = state.sends[sendKey(id, r.version)];
    const older = Object.entries(state.sends).filter(([k]) => k.startsWith(id + ':') && k !== sendKey(id, r.version)).map(([k, v]) => ({ key: k, ...v }));
    return { current: s ?? null, superseded: older };
  }

  // ---------- simulated receiving system (mock, async ACK) ----------
  function send(id, actor, via) {
    const r = currentReport(id);
    const key = sendKey(id, r.version);
    const existing = state.sends[key];
    if (existing && ['SENDING', 'ACKED'].includes(existing.status)) {
      audit('SEND_DUPLICATE_IGNORED', { reportId: id, version: r.version, actor, note: `Yêu cầu gửi trùng (idempotency key ${key}) — bỏ qua, trạng thái hiện tại ${existing.status}` });
      return existing;
    }
    const s = { status: 'SENDING', idempotencyKey: key, version: r.version, attempts: (existing?.attempts ?? 0) + 1, requestedAt: new Date().toISOString(), via, ackId: null, error: null };
    state.sends[key] = s;
    audit('SEND_REQUESTED', { reportId: id, version: r.version, actor, note: `${via} → hệ thống tiếp nhận mô phỏng (lần ${s.attempts})` });
    const delay = sendDelayMs[0] + random() * (sendDelayMs[1] - sendDelayMs[0]);
    setTimeout(() => {
      const cur = currentReport(id);
      if (cur.version !== s.version) { s.status = 'SUPERSEDED'; audit('SEND_SUPERSEDED', { reportId: id, version: s.version, note: 'Phiếu đã có phiên bản mới trước khi ACK — ACK cũ không xác nhận phiên bản mới' }); return; }
      if (random() < sendFailRate) {
        s.status = 'FAILED'; s.error = 'Timeout/HTTP 503 từ hệ thống tiếp nhận (mô phỏng)';
        audit('SEND_FAILED', { reportId: id, version: s.version, note: s.error });
      } else {
        s.status = 'ACKED'; s.ackId = 'ACK-' + randomUUID().slice(0, 8).toUpperCase(); s.ackAt = new Date().toISOString();
        audit('SEND_ACKED', { reportId: id, version: s.version, note: `Hệ thống tiếp nhận xác nhận ${s.ackId}. Chỉ từ lúc này mới hiển thị "đã ký/đã gửi (mô phỏng)".` });
      }
      persist();
    }, delay).unref?.();
    persist();
    return s;
  }

  function summary(id) {
    const r = currentReport(id);
    const ev = evaluate(r);
    const review = state.reviews[sendKey(id, r.version)] ?? null;
    return {
      reportId: id, version: r.version, panel: r.panel, panelName: r.panelName, discipline: r.discipline, ward: r.ward,
      subjectToken: r.subjectToken, collectedAt: r.specimen.collectedAt, ageGroup: r.context.ageGroup, sex: r.context.sex,
      decision: ev.decision, priority: ev.priority, criticalValue: ev.criticalValue, reasons: ev.reasons.slice(0, 3), nReasons: ev.reasons.length,
      scenario: r.scenario ? { code: r.scenario.code, title: r.scenario.title } : null,
      review: review ? { action: review.action, at: review.at } : null,
      send: sendState(id).current
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
    return {
      report: visible, evaluation: ev, history: historySeries(r),
      analyteInfo: Object.fromEntries(r.orderedTests.map(t => { const d = catalog.analytes[t]; return [t, { name: d.name, unit: d.unit, ref: d.ref[r.context.sex] ?? d.ref.M, avLimits: d.avLimits, critical: d.critical, amr: d.amr, rcvPct: d.rcvPct, instrument: d.instrument }]; })),
      review: state.reviews[sendKey(id, r.version)] ?? null,
      reviewsAllVersions: Object.entries(state.reviews).filter(([k]) => k.startsWith(id + ':')).map(([k, v]) => ({ key: k, ...v })),
      amendments: state.amendments[id] ?? [],
      send: sendState(id),
      audit: state.audit.filter(a => a.reportId === id),
      feedback: state.feedback.filter(f => f.reportId === id),
      qcRelevant: ds.qcLog.filter(q => q.at.startsWith(today) && r.results.some(x => x.instrument === q.instrument && x.test === q.test) && (q.status !== 'PASS' || q.note)),
      simulationTruth: state.settings.showTruth ? { truth, simulatedReviewer: reviewer ?? null, split } : null
    };
  }

  // ---------- actions ----------
  const REASONS = {
    APPROVE: ['CONSISTENT_WITH_HISTORY', 'CONSISTENT_WITH_CONTEXT', 'RERUN_CONFIRMED', 'CRITICAL_NOTIFIED', 'OTHER'],
    HOLD: ['SUSPECT_SPECIMEN', 'SUSPECT_WBIT', 'SUSPECT_INSTRUMENT', 'NEED_CONTEXT', 'OTHER'],
    REQUEST_CHECK: ['RERUN', 'RECOLLECT', 'CHECK_TUBE_LABEL', 'SMEAR_REVIEW', 'CONTACT_WARD', 'CHECK_INTERFACE_CONFIG', 'OTHER'],
    NOTIFY_CRITICAL: ['PHONE_WARD', 'OTHER']
  };

  function act(id, body) {
    const r = currentReport(id);
    const ev = evaluate(r);
    const { action, reasonCode, note = '', verification = 'NOT_VERIFIED', actor = 'Người phụ trách (demo)' } = body;
    if (!REASONS[action]) throw httpError(400, 'Hành động không hợp lệ');
    if (!REASONS[action].includes(reasonCode)) throw httpError(400, 'Cần chọn mã lý do hợp lệ');
    if (String(note).length > 1000) throw httpError(400, 'Ghi chú quá dài');
    if ((reasonCode === 'OTHER' || action !== 'APPROVE') && !String(note).trim() && action !== 'NOTIFY_CRITICAL') throw httpError(400, 'Vui lòng ghi lý do');
    const key = sendKey(id, r.version);
    const prior = state.reviews[key];
    if (['APPROVE', 'AUTO_APPROVE'].includes(prior?.action) && ['SENDING', 'ACKED'].includes(state.sends[key]?.status)) throw httpError(409, `Phiên bản v${r.version} đã được duyệt và đang/đã gửi (${state.sends[key].status}). Muốn thay đổi cần tạo phiên bản mới.`);
    if (action === 'APPROVE') {
      if (ev.decision === DECISIONS.BLOCKED) throw httpError(409, 'Phiếu đang BLOCKED: cần xử lý điều kiện chặn (chạy lại/sửa dữ liệu/QC) để tạo phiên bản mới trước khi duyệt.');
      if (ev.criticalValue && !(prior?.criticalNotified)) throw httpError(409, 'Giá trị tới hạn: cần ghi nhận "Đã thông báo lâm sàng" trước khi duyệt (chính sách giả lập).');
    }
    const rec = { action, reasonCode, note: String(note).trim(), verification, actor, at: new Date().toISOString(), version: r.version,
      evaluationDecision: ev.decision, criticalNotified: prior?.criticalNotified || action === 'NOTIFY_CRITICAL' };
    state.reviews[key] = rec;
    audit('REVIEW_' + action, { reportId: id, version: r.version, actor, note: `${reasonCode}${rec.note ? ' — ' + rec.note : ''}`, decision: ev.decision, rulesetVersion: ev.rulesetVersion, modelVersions: ev.modelVersions, inputHash: ev.inputHash });
    if (action !== 'NOTIFY_CRITICAL') {
      state.feedback.push({
        feedbackId: 'FB-' + String(state.feedback.length + 1).padStart(4, '0'), reportId: id, version: r.version, discipline: r.discipline, createdAt: rec.at,
        systemDecision: ev.decision, systemReasons: ev.checks.filter(c => c.action).map(c => c.code), modelScores: ev.models.filter(m => m.inScope).map(m => ({ key: m.key, score: m.score, flagged: m.flagged })),
        rulesetVersion: ev.rulesetVersion, modelVersions: ev.modelVersions, inputHash: ev.inputHash,
        reviewerAction: action, reasonCode, note: rec.note, verification,
        agreement: (action === 'APPROVE') === (ev.decision === DECISIONS.AUTO) ? 'ĐỒNG Ý' : 'KHÁC',
        labelStatus: 'CHƯA RÀ SOÁT', usableForTraining: false, affectsRunningRules: false
      });
    }
    if (action === 'APPROVE') send(id, actor, 'Duyệt thủ công');
    persist();
    return detail(id);
  }

  function amend(id, body) {
    const r = currentReport(id);
    const { kind, changes = [], note = '', actor = 'Người phụ trách (demo)', clearFlags = false, hil = null } = body;
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
    const ev = evaluate(currentReport(id));
    audit('REPORT_AMENDED', { reportId: id, version, actor, note: `${kind}: ${clean.map(c => `${c.test}=${c.value ?? '—'} ${c.unit}`).join(', ')}${clearFlags ? ' (xóa cờ sau chạy lại)' : ''} — ${a.note}. Đánh giá cũ hết hiệu lực; đánh giá lại: ${ev.decision}` });
    persist();
    return detail(id);
  }

  function runBatch(actor = 'HỆ THỐNG') {
    const res = { evaluated: 0, autoEligible: 0, sent: 0, shadowOnly: 0 };
    for (const id of worklistIds) {
      const r = currentReport(id); const ev = evaluate(r); res.evaluated++;
      if (ev.decision !== DECISIONS.AUTO) continue;
      res.autoEligible++;
      const key = sendKey(id, r.version);
      if (state.reviews[key]) continue;
      if (state.settings.mode === 'SIMULATED_AUTOSIGN') {
        state.reviews[key] = { action: 'AUTO_APPROVE', reasonCode: 'ALL_CONDITIONS_MET', note: '', actor: 'HỆ THỐNG', at: new Date().toISOString(), version: r.version, evaluationDecision: ev.decision };
        audit('AUTO_APPROVED', { reportId: id, version: r.version, actor: 'HỆ THỐNG', note: `Đủ điều kiện theo ${ev.rulesetVersion}${ev.modelVersions.length ? ' + ' + ev.modelVersions.join(', ') : ''}`, inputHash: ev.inputHash });
        send(id, 'HỆ THỐNG', 'Tự động ký (mô phỏng)'); res.sent++;
      } else res.shadowOnly++;
    }
    audit('BATCH_RUN', { actor, note: `Chế độ ${state.settings.mode}: ${res.autoEligible}/${res.evaluated} đủ điều kiện; ${res.sent} gửi ký mô phỏng; ${res.shadowOnly} chỉ đề xuất (chạy ngầm)` });
    return res;
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
    audit('MANUAL_TRY', { reportId: null, actor: 'Người phụ trách (demo)', note: `Nhập thử ${body.panel}: ${ev.decision} (không ghi vào hàng đợi)`, inputHash: ev.inputHash });
    return { report, evaluation: ev, analyteInfo: Object.fromEntries(panel.tests.map(t => { const d = catalog.analytes[t]; return [t, { name: d.name, unit: d.unit, ref: d.ref[report.context.sex], avLimits: d.avLimits, critical: d.critical, amr: d.amr }]; })) };
  }

  // ---------- HTTP ----------
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  function httpError(code, msg) { const e = new Error(msg); e.status = code; return e; }
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
        const m = p.match(/^\/api\/reports\/([A-Z0-9-]+)(?:\/(action|amend|retry-send|explain))?$/);
        if (req.method === 'GET' && p === '/api/meta') return json(res, 200, { today, disclaimer: ds.meta.disclaimer, llm: llmStatus(), settings: state.settings, rulesets: Object.fromEntries(Object.entries(rulesets).map(([k, v]) => [k, { version: v.version, status: v.status }])), models: Object.values(models).map(m => ({ key: m.key, name: m.name, version: m.version, threshold: m.threshold, status: m.status, scope: m.scope })), catalogVersion: catalog.version, worklistSize: worklistIds.length, reasons: REASONS, panels: catalog.panels, analytes: catalog.analytes });
        if (req.method === 'GET' && p === '/api/worklist') return json(res, 200, worklistIds.map(summary));
        if (m && req.method === 'GET' && !m[2]) { if (!baseReports.has(m[1])) throw httpError(404, 'Không tìm thấy phiếu'); return json(res, 200, detail(m[1])); }
        if (m && req.method === 'POST' && m[2]) {
          if (!worklistIds.includes(m[1])) throw httpError(404, 'Phiếu không thuộc hàng đợi hôm nay');
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
          const st = sendState(m[1]).current;
          if (!st || st.status !== 'FAILED') throw httpError(409, 'Chỉ gửi lại khi lần gửi trước thất bại');
          const cur = currentReport(m[1]);
          const rv = state.reviews[sendKey(m[1], cur.version)];
          if (!['APPROVE', 'AUTO_APPROVE'].includes(rv?.action)) throw httpError(409, 'Quyết định hiện tại của phiên bản này không còn là "duyệt" — không gửi lại.');
          if (evaluate(cur).decision === DECISIONS.BLOCKED) throw httpError(409, 'Phiếu đang BLOCKED — không gửi lại.');
          send(m[1], b.actor ?? 'Người phụ trách (demo)', 'Gửi lại'); return json(res, 200, detail(m[1]));
        }
        if (req.method === 'POST' && p === '/api/settings') {
          const b = await body(req);
          if (b.mode && !['SHADOW', 'SIMULATED_AUTOSIGN'].includes(b.mode)) throw httpError(400, 'Chế độ không hợp lệ');
          if ('personalMode' in b && !['OFF', 'TIGHTEN', 'ADAPT'].includes(b.personalMode)) throw httpError(400, 'Chế độ ngưỡng không hợp lệ');
          const before = { ...state.settings };
          for (const k of ['mode', 'personalMode', 'modelEnabled', 'showTruth']) if (k in b) state.settings[k] = ['mode', 'personalMode'].includes(k) ? b[k] : !!b[k];
          audit('SETTINGS_CHANGED', { note: Object.keys(b).map(k => `${k}: ${before[k]} → ${state.settings[k]}`).join('; '), actor: 'Người phụ trách (demo)' });
          return json(res, 200, state.settings);
        }
        if (req.method === 'POST' && p === '/api/batch') return json(res, 200, runBatch('Người phụ trách (demo)'));
        if (req.method === 'POST' && p === '/api/evaluate') return json(res, 200, tryEvaluate(await body(req)));
        if (req.method === 'POST' && p === '/api/reset') { state = fresh(); evalCache.clear(); llmCache.clear(); audit('RESET', { note: 'Xóa trạng thái demo (phản hồi, nhật ký, phiên bản sửa)' }); return json(res, 200, { ok: true }); }
        if (req.method === 'GET' && p === '/api/audit') return json(res, 200, state.audit.slice(-500).reverse());
        if (req.method === 'GET' && p === '/api/feedback') return json(res, 200, state.feedback);
        if (req.method === 'GET' && p === '/api/feedback.csv') {
          const cols = ['feedbackId', 'reportId', 'version', 'discipline', 'createdAt', 'systemDecision', 'systemReasons', 'rulesetVersion', 'modelVersions', 'inputHash', 'reviewerAction', 'reasonCode', 'verification', 'agreement', 'labelStatus', 'note'];
          const esc = v => { const s = Array.isArray(v) ? v.join('|') : v == null ? '' : String(v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s; };
          res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="feedback-demo.csv"' });
          return res.end('﻿' + [cols.join(','), ...state.feedback.map(f => cols.map(c => esc(f[c])).join(','))].join('\n'));
        }
        if (req.method === 'GET' && p === '/api/rules') return json(res, 200, { rulesets, catalog });
        if (req.method === 'GET' && p === '/api/evaluation') return json(res, 200, { evaluation: evaluationReport, models });
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
  return { handle, state: () => state, worklistIds, currentReport, evaluate, runBatch };
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
