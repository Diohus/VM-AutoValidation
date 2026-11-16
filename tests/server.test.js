import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ensureArtifacts, createApp } from '../server/server.mjs';

let server, base, app;
before(async () => {
  ensureArtifacts(() => {});
  app = createApp({ runtimeFile: null, sendDelayMs: [5, 10], sendFailRate: 0 });
  server = createServer(app.handle);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const get = p => fetch(base + p).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, body: await r.json() }));
const wait = ms => new Promise(r => setTimeout(r, ms));
const scenario = async code => (await get('/api/worklist')).body.find(w => w.scenario?.code === code);

test('every pinned scenario yields its expected decision', async () => {
  const wl = (await get('/api/worklist')).body;
  const sc = wl.filter(w => w.scenario);
  assert.equal(sc.length, 17);
  for (const w of sc) {
    const d = (await get('/api/reports/' + w.reportId)).body;
    assert.equal(d.evaluation.decision, d.report.scenario.expect, w.scenario.code);
    assert.equal(d.report.truth, undefined, 'ground truth hidden by default');
  }
});

test('blocked report cannot be approved; rerun creates a new version that is re-evaluated', async () => {
  const w = await scenario('KB4');
  assert.equal((await post(`/api/reports/${w.reportId}/action`, { action: 'APPROVE', reasonCode: 'RERUN_CONFIRMED' })).status, 409);
  const a = await post(`/api/reports/${w.reportId}/amend`, { kind: 'RERUN', changes: [{ test: 'K', value: 4.5 }], note: 'QC đạt lại, chạy lại' });
  assert.equal(a.status, 200);
  assert.equal(a.body.report.version, 2);
  assert.equal(a.body.evaluation.decision, 'AUTO_APPROVE_ELIGIBLE');
});

test('critical value requires notification before approval; ACK only after receiver confirms; duplicates rejected', async () => {
  const w = await scenario('KB6');
  assert.equal((await post(`/api/reports/${w.reportId}/action`, { action: 'APPROVE', reasonCode: 'CRITICAL_NOTIFIED', note: 'x' })).status, 409);
  assert.equal((await post(`/api/reports/${w.reportId}/action`, { action: 'NOTIFY_CRITICAL', reasonCode: 'PHONE_WARD' })).status, 200);
  const ok = await post(`/api/reports/${w.reportId}/action`, { action: 'APPROVE', reasonCode: 'CRITICAL_NOTIFIED', note: 'đã báo' });
  assert.equal(ok.body.send.current.status, 'SENDING');
  await wait(60);
  assert.equal((await get('/api/reports/' + w.reportId)).body.send.current.status, 'ACKED');
  assert.equal((await post(`/api/reports/${w.reportId}/action`, { action: 'APPROVE', reasonCode: 'CRITICAL_NOTIFIED', note: 'lần 2' })).status, 409);
});

test('feedback is recorded but rules in force do not change', async () => {
  const before = (await get('/api/rules')).body;
  const w = await scenario('KB7');
  const r = await post(`/api/reports/${w.reportId}/action`, { action: 'REQUEST_CHECK', reasonCode: 'RECOLLECT', note: 'nghi EDTA' });
  assert.equal(r.status, 200);
  const fb = (await get('/api/feedback')).body.find(f => f.reportId === w.reportId);
  assert.equal(fb.labelStatus, 'CHƯA RÀ SOÁT');
  assert.equal(fb.affectsRunningRules, false);
  assert.deepEqual((await get('/api/rules')).body.rulesets, before.rulesets);
  assert.equal((await get('/api/reports/' + w.reportId)).body.evaluation.decision, 'MANUAL_REVIEW');
});

test('input validation', async () => {
  const w = await scenario('KB3');
  assert.equal((await post(`/api/reports/${w.reportId}/action`, { action: 'HOLD', reasonCode: 'SUSPECT_SPECIMEN' })).status, 400, 'note required');
  assert.equal((await post(`/api/reports/${w.reportId}/action`, { action: 'DELETE', reasonCode: 'X' })).status, 400);
  const raw = await fetch(base + `/api/reports/${w.reportId}/action`, { method: 'POST', body: '{}' });
  assert.equal(raw.status, 415);
  assert.equal((await fetch(base + '/..%2Fpackage.json')).status, 404);
  assert.equal((await fetch(base + '/data/synthetic/dataset.json')).status, 404);
});

test('shadow mode never sends; simulated auto-sign sends only eligible reports', async () => {
  const s = await post('/api/batch', {});
  assert.equal(s.body.sent, 0);
  await post('/api/settings', { mode: 'SIMULATED_AUTOSIGN' });
  const r = await post('/api/batch', {});
  assert.ok(r.body.sent > 0);
  await wait(60);
  for (const w of (await get('/api/worklist')).body) if (w.send?.via === 'Tự động ký (mô phỏng)') assert.equal(w.decision, 'AUTO_APPROVE_ELIGIBLE');
  await post('/api/settings', { mode: 'SHADOW' });
});

test('manual try evaluates without touching the worklist', async () => {
  const n = (await get('/api/worklist')).body.length;
  const r = await post('/api/evaluate', { panel: 'CHEM_BASIC', values: { GLU: { value: 5 }, URE: { value: 5 }, CRE: { value: 80 }, NA: { value: 140 }, K: { value: 4.1 }, CL: { value: 102 } }, hil: { H: 5, L: 10, I: 1 } });
  assert.equal(r.body.evaluation.decision, 'AUTO_APPROVE_ELIGIBLE');
  const empty = await post('/api/evaluate', { panel: 'CHEM_BASIC', values: {} });
  assert.equal(empty.body.evaluation.decision, 'BLOCKED', 'blank fields are "no result", not zero');
  assert.equal((await get('/api/worklist')).body.length, n);
});

test('retry-send refuses when the reviewer has since changed the decision to hold', async () => {
  const flaky = createApp({ runtimeFile: null, sendDelayMs: [1, 2], sendFailRate: 1 });
  const srv = createServer(flaky.handle); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${srv.address().port}`;
  const p = (u, body) => fetch(b + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const wl = await (await fetch(b + '/api/worklist')).json();
  const id = wl.find(w => w.scenario?.code === 'KB1').reportId;
  await p(`/api/reports/${id}/action`, { action: 'APPROVE', reasonCode: 'CONSISTENT_WITH_HISTORY' });
  await wait(30);
  assert.equal((await (await fetch(b + '/api/reports/' + id)).json()).send.current.status, 'FAILED');
  assert.equal((await p(`/api/reports/${id}/action`, { action: 'HOLD', reasonCode: 'NEED_CONTEXT', note: 'đổi ý' })).status, 200);
  assert.equal((await p(`/api/reports/${id}/retry-send`, {})).status, 409);
  srv.close();
});

test('recollection does not carry results of the old tube over', async () => {
  const w = await scenario('KB7');
  const r = await post(`/api/reports/${w.reportId}/amend`, { kind: 'RECOLLECT', changes: [{ test: 'K', value: 4.2 }, { test: 'CA', value: 2.33 }], note: 'lấy mẫu mới' });
  const others = r.body.report.results.filter(x => !['K', 'CA'].includes(x.test));
  assert.ok(others.every(x => x.status === 'PENDING' && x.value === null));
  assert.equal(r.body.evaluation.decision, 'BLOCKED');
});
