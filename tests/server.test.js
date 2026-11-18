import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ensureArtifacts, createApp } from '../server/server.mjs';

let server, base, app;
before(async () => {
  ensureArtifacts(() => {});
  app = createApp({ runtimeFile: null, signDelayMs: [5, 10], signFailRate: 0 });
  server = createServer(app.handle);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections(); server.close(); });

const get = p => fetch(base + p).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, body: await r.json() }));
const wait = ms => new Promise(r => setTimeout(r, ms));
const scenario = async code => (await get('/api/worklist')).body.find(w => w.scenario?.code === code);

async function startApp(opts) {
  const a = createApp({ runtimeFile: null, ...opts });
  const srv = createServer(a.handle); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${srv.address().port}`;
  return {
    a, srv,
    get: p => fetch(b + p).then(r => r.json()),
    post: (p, body) => fetch(b + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then(async r => ({ status: r.status, body: await r.json() })),
    id: async code => (await fetch(b + '/api/worklist').then(r => r.json())).find(w => w.scenario?.code === code).reportId
  };
}

test('every pinned scenario yields its expected suggestion; nothing is signed without the doctor', async () => {
  const wl = (await get('/api/worklist')).body;
  const sc = wl.filter(w => w.scenario);
  assert.equal(sc.length, 17);
  for (const w of sc) {
    const d = (await get('/api/reports/' + w.reportId)).body;
    assert.equal(d.evaluation.decision, d.report.scenario.expect, w.scenario.code);
    assert.equal(d.report.truth, undefined, 'ground truth hidden by default');
  }
  assert.ok(wl.every(w => w.workState === 'PENDING' && !w.send), 'system never signs by itself');
  assert.equal((await post('/api/batch', {})).status, 404, 'no auto-sign batch');
});

test('blocked report cannot be signed; a rerun creates a new version that is re-read', async () => {
  const w = await scenario('KB4');
  assert.equal((await post(`/api/reports/${w.reportId}/action`, { action: 'SIGN' })).status, 409);
  const rq = await post(`/api/reports/${w.reportId}/action`, { action: 'REQUEST_RERUN', tests: ['K'] });
  assert.equal(rq.status, 200);
  assert.equal(rq.body.workState, 'RERUN_REQUESTED');
  const a = await post(`/api/reports/${w.reportId}/amend`, { kind: 'RERUN', changes: [{ test: 'K', value: 4.5 }], note: 'QC đạt lại, chạy lại' });
  assert.equal(a.status, 200);
  assert.equal(a.body.report.version, 2);
  assert.equal(a.body.evaluation.decision, 'AUTO_APPROVE_ELIGIBLE');
  assert.equal(a.body.workState, 'PENDING', 'new version goes back to the doctor');
});

test('critical value needs notification confirmation; signing is queued then confirmed; duplicates rejected', async () => {
  const w = await scenario('KB6');
  assert.equal((await post(`/api/reports/${w.reportId}/action`, { action: 'SIGN' })).status, 409);
  const ok = await post(`/api/reports/${w.reportId}/action`, { action: 'SIGN', criticalNotified: true });
  assert.equal(ok.status, 200);
  assert.ok(['QUEUED', 'SIGNING'].includes(ok.body.send.current.status), 'returns immediately, before the signing system answers');
  assert.equal(ok.body.workState, 'IN_QUEUE');
  await wait(60);
  const d = (await get('/api/reports/' + w.reportId)).body;
  assert.equal(d.send.current.status, 'SIGNED');
  assert.equal(d.workState, 'SIGNED');
  assert.equal((await post(`/api/reports/${w.reportId}/action`, { action: 'SIGN', criticalNotified: true })).status, 409);
});

test('feedback is recorded but rules in force do not change', async () => {
  const before = (await get('/api/rules')).body;
  const w = await scenario('KB7');
  const r = await post(`/api/reports/${w.reportId}/action`, { action: 'FLAG_REVIEW', reasonCode: 'SUSPECT_SPECIMEN', note: 'nghi EDTA' });
  assert.equal(r.status, 200);
  assert.equal(r.body.workState, 'FLAGGED');
  const fb = (await get('/api/feedback')).body.find(f => f.reportId === w.reportId);
  assert.equal(fb.labelStatus, 'CHƯA RÀ SOÁT');
  assert.equal(fb.affectsRunningRules, false);
  assert.deepEqual((await get('/api/rules')).body.rulesets, before.rulesets);
  assert.equal((await get('/api/reports/' + w.reportId)).body.evaluation.decision, 'MANUAL_REVIEW');
});

test('input validation', async () => {
  const w = await scenario('KB3');
  assert.equal((await post(`/api/reports/${w.reportId}/action`, { action: 'FLAG_REVIEW', reasonCode: 'OTHER' })).status, 400, 'OTHER needs a note');
  assert.equal((await post(`/api/reports/${w.reportId}/action`, { action: 'REQUEST_RERUN', tests: [] })).status, 400, 'rerun needs tests');
  assert.equal((await post(`/api/reports/${w.reportId}/action`, { action: 'REQUEST_RERUN', tests: ['PLT'] })).status, 400, 'test not ordered');
  assert.equal((await post(`/api/reports/${w.reportId}/action`, { action: 'DELETE' })).status, 400);
  const raw = await fetch(base + `/api/reports/${w.reportId}/action`, { method: 'POST', body: '{}' });
  assert.equal(raw.status, 415);
  assert.equal((await fetch(base + '/..%2Fpackage.json')).status, 404);
  assert.equal((await fetch(base + '/data/synthetic/dataset.json')).status, 404);
});

test('sign queue is FIFO, one at a time, and the doctor never waits', async () => {
  const t = await startApp({ signDelayMs: [400, 400], signFailRate: 0 });
  const ids = [await t.id('KB1'), await t.id('KB2')];
  const t0 = Date.now();
  for (const id of ids) assert.equal((await t.post(`/api/reports/${id}/action`, { action: 'SIGN' })).status, 200);
  let q = await t.get('/api/queue');
  assert.ok(Date.now() - t0 < 400, 'sign returns before the signing system answers');
  assert.equal(q.signing.reportId, ids[0]);
  assert.deepEqual(q.queued.map(x => x.reportId), [ids[1]]);
  await wait(400 - (Date.now() - t0) + 150);
  q = await t.get('/api/queue');
  assert.equal(q.signing.reportId, ids[1], 'next one starts only after the first finished');
  assert.equal((await t.get('/api/reports/' + ids[0])).send.current.status, 'SIGNED');
  t.srv.closeAllConnections(); t.srv.close();
});

test('queued signature can be withdrawn; an amendment drops the old queued signature', async () => {
  const t = await startApp({ signDelayMs: [200, 200], signFailRate: 0 });
  const [a, b, c] = [await t.id('KB1'), await t.id('KB2'), await t.id('KB3')];
  await t.post(`/api/reports/${a}/action`, { action: 'SIGN' });
  await t.post(`/api/reports/${b}/action`, { action: 'SIGN' });
  assert.equal((await t.post(`/api/reports/${a}/cancel-sign`)).status, 409, 'already being signed');
  const cb = await t.post(`/api/reports/${b}/cancel-sign`);
  assert.equal(cb.status, 200); assert.equal(cb.body.workState, 'PENDING');
  await t.post(`/api/reports/${c}/action`, { action: 'FLAG_REVIEW' });
  const rc = await t.get('/api/reports/' + c);
  assert.equal(rc.workState, 'FLAGGED');
  await t.post(`/api/reports/${b}/action`, { action: 'SIGN' });
  const am = await t.post(`/api/reports/${b}/amend`, { kind: 'UNIT_FIX', changes: [], clearFlags: true, note: 'x' });
  assert.equal(am.body.send.superseded[0].status, 'SUPERSEDED');
  assert.equal(am.body.workState, 'PENDING');
  assert.deepEqual((await t.get('/api/queue')).queued, []);
  t.srv.closeAllConnections(); t.srv.close();
});

test('failed signature comes back to the doctor, raises a notification, and can be re-signed', async () => {
  const t = await startApp({ signDelayMs: [1, 2], signFailRate: 1 });
  const id = await t.id('KB1');
  await t.post(`/api/reports/${id}/action`, { action: 'SIGN' });
  await wait(30);
  const d = await t.get('/api/reports/' + id);
  assert.equal(d.send.current.status, 'FAILED');
  assert.equal(d.workState, 'SIGN_FAILED');
  const wl = await t.get('/api/worklist');
  assert.equal(wl.find(w => w.reportId === id).workState, 'SIGN_FAILED');
  const notes = await t.get('/api/notifications');
  assert.equal(notes[0].reportId, id); assert.equal(notes[0].read, false);
  assert.equal((await t.get('/api/queue')).failed, 1);
  // Doctor changes their mind → no re-sign of a decision that is no longer "sign".
  assert.equal((await t.post(`/api/reports/${id}/action`, { action: 'FLAG_REVIEW', note: 'đổi ý' })).status, 200);
  assert.equal((await t.post(`/api/reports/${id}/resign`)).status, 409);
  // Sign again → fails again → explicit re-sign is accepted and marks the notification read.
  await t.post(`/api/reports/${id}/action`, { action: 'SIGN' });
  await wait(30);
  const before = (await t.get('/api/notifications')).filter(n => n.reportId === id).map(n => n.id);
  const rs = await t.post(`/api/reports/${id}/resign`);
  assert.equal(rs.status, 200);
  const after = await t.get('/api/notifications');
  assert.ok(after.filter(n => before.includes(n.id)).every(n => n.read), 're-sign clears the notifications it answers');
  await t.post('/api/notifications/read', {});
  assert.ok((await t.get('/api/notifications')).every(n => n.read));
  t.srv.closeAllConnections(); t.srv.close();
});

test('manual try evaluates without touching the worklist', async () => {
  const n = (await get('/api/worklist')).body.length;
  const r = await post('/api/evaluate', { panel: 'CHEM_BASIC', values: { GLU: { value: 5 }, URE: { value: 5 }, CRE: { value: 80 }, NA: { value: 140 }, K: { value: 4.1 }, CL: { value: 102 } }, hil: { H: 5, L: 10, I: 1 } });
  assert.equal(r.body.evaluation.decision, 'AUTO_APPROVE_ELIGIBLE');
  const empty = await post('/api/evaluate', { panel: 'CHEM_BASIC', values: {} });
  assert.equal(empty.body.evaluation.decision, 'BLOCKED', 'blank fields are "no result", not zero');
  assert.equal((await get('/api/worklist')).body.length, n);
});

test('recollection does not carry results of the old tube over', async () => {
  const w = await scenario('KB7');
  const r = await post(`/api/reports/${w.reportId}/amend`, { kind: 'RECOLLECT', changes: [{ test: 'K', value: 4.2 }, { test: 'CA', value: 2.33 }], note: 'lấy mẫu mới' });
  const others = r.body.report.results.filter(x => !['K', 'CA'].includes(x.test));
  assert.ok(others.every(x => x.status === 'PENDING' && x.value === null));
  assert.equal(r.body.evaluation.decision, 'BLOCKED');
});
