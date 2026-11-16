import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { llmStatus, buildLlmInput, explainReport } from '../server/llm.mjs';
import { createApp } from '../server/server.mjs';

const env = { OPENAI_API_KEY: 'test-key-never-real', OPENAI_MODEL: 'gpt-6-luna', LLM_ENABLED: 'true', LLM_TIMEOUT_MS: '1000' };
const fixture = {
  report: {
    reportId: 'PRIVATE-REPORT', subjectToken: 'PRIVATE-SUBJECT', encounterId: 'PRIVATE-ENCOUNTER', orderId: 'PRIVATE-ORDER',
    panel: 'CHEM', panelName: 'Hóa sinh', specimen: { specimenId: 'PRIVATE-SPECIMEN', collectedAt: '2026-11-16T09:00:00+07:00' },
    context: { age: 63, sex: 'F', conditions: [{ label: 'Tăng huyết áp', knownAt: '2026-11-14T10:00:00+07:00' }],
      medications: [{ label: 'Thuốc PRIVATE-SUBJECT ngày 15/11/2026', startedAt: '2026-11-15T10:00:00+07:00' }],
      events: [{ label: 'Nhập viện', at: '2026-11-16T08:00:00+07:00' }, { label: 'Tương lai', at: '2026-11-17T10:00:00+07:00' }] },
    results: [{ test: 'K', value: 6.6, unit: 'mmol/L', status: 'RESULTED', measuredAt: '2026-11-16T10:00:00+07:00', specimenId: 'PRIVATE-SPECIMEN' }]
  },
  analyteInfo: { K: { name: 'Kali', ref: [3.5, 5.1], unrelated: 'PRIVATE-ORDER' } },
  evaluation: { decision: 'MANUAL_REVIEW', checks: [
    { code: 'CRITICAL', name: 'Tới hạn', action: 'REVIEW', message: 'K=6.6 PRIVATE-REPORT PRIVATE-SUBJECT PRIVATE-ENCOUNTER PRIVATE-ORDER PRIVATE-SPECIMEN 2026-11-16T10:00:00+07:00 16/11/2026' },
    { code: 'PASS', name: 'Đạt', message: 'Không gửi check này' }
  ], models: [{ key: 'chem', score: 0.8, threshold: 0.5, flagged: true, inScope: true, private: 'PRIVATE-SUBJECT' }] }
};
const responseData = { status: 'completed', model: 'gpt-6-luna', usage: { input_tokens: 100, output_tokens: 20 },
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '- Đối chiếu kết quả theo SOP.' }] }] };
const success = () => new Response(JSON.stringify(responseData), { headers: { 'Content-Type': 'application/json' } });

test('buildLlmInput projects allowed fields and removes identifiers/dates even in messages', () => {
  const original = structuredClone(fixture);
  const input = buildLlmInput(fixture);
  const json = JSON.stringify(input);
  assert.doesNotMatch(json, /reportId|subjectToken|encounterId|orderId|specimenId|PRIVATE-|2026-11-16|\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}/);
  assert.equal(input.ageGroup, '60–74');
  assert.equal(input.sex, 'F');
  assert.deepEqual(input.results[0].referenceRange, [3.5, 5.1]);
  assert.equal(input.results[0].value, 6.6);
  assert.equal(input.checks.length, 1);
  assert.equal(input.context.conditions[0].daysAgo, 2);
  assert.equal(input.context.medications[0].daysAgo, 1);
  assert.equal(input.context.events.length, 1, 'future context excluded');
  assert.equal(input.context.events[0].daysAgo, 0);
  assert.deepEqual(fixture, original, 'source data unchanged');
});

test('missing data stays unknown and nested unexpected fields never pass through', () => {
  const input = buildLlmInput({ report: { results: [{ test: 'K', value: null }], context: { events: [{ label: 'Không có thời điểm' }] } } });
  assert.equal(input.ageGroup, null);
  assert.equal(input.results[0].value, null);
  assert.equal(input.context.events[0].daysAgo, null);
  assert.equal(input.decision, null);
});

test('explainReport uses injected fetch, Responses endpoint and returns text/usage/timing', async () => {
  const input = buildLlmInput(fixture);
  let calls = 0;
  const result = await explainReport(input, { env, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer test-key-never-real');
    const body = JSON.parse(options.body);
    assert.deepEqual(JSON.parse(body.input), input);
    assert.equal(body.store, false);
    assert.equal(body.model, 'gpt-6-luna');
    assert.equal(body.reasoning.effort, 'none');
    assert.equal(body.max_output_tokens, 700);
    assert.match(body.instructions, /không quyết định ký\/không ký/);
    return success();
  } });
  assert.equal(calls, 1);
  assert.equal(result.text, responseData.output[0].content[0].text);
  assert.equal(result.model, 'gpt-6-luna');
  assert.deepEqual(result.usage, responseData.usage);
  assert.ok(result.latencyMs >= 0);
});

test('missing key and disabled LLM fail before fetch and status never reveals key', async () => {
  const fetchImpl = () => assert.fail('must not call network');
  await assert.rejects(explainReport({}, { env: {}, fetchImpl }), e => e.status === 503 && /OPENAI_API_KEY.*\.env/.test(e.message));
  await assert.rejects(explainReport({}, { env: { ...env, LLM_ENABLED: 'false' }, fetchImpl }), e => e.status === 503);
  assert.deepEqual(llmStatus(env), { configured: true, model: 'gpt-6-luna', reason: null });
  assert.doesNotMatch(JSON.stringify(llmStatus(env)), /test-key/);
});

for (const [http, status, message] of [[401, 502, /xác thực.*401/], [429, 429, /hạn mức.*429/], [404, 502, /HTTP 404/]]) {
  test('safe Vietnamese error for HTTP ' + http, async () => {
    await assert.rejects(explainReport({}, { env, fetchImpl: async () => new Response('SECRET BODY test-key', { status: http }) }), e => {
      assert.equal(e.status, status); assert.match(e.message, message); assert.doesNotMatch(e.message, /SECRET|test-key/); return true;
    });
  });
}

test('timeout and caller cancellation use abort signal', async () => {
  const fetchImpl = async (_, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  await assert.rejects(explainReport({}, { env: { ...env, LLM_TIMEOUT_MS: '5' }, fetchImpl }), e => e.status === 504 && /quá thời gian/.test(e.message));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(explainReport({}, { env, signal: controller.signal, fetchImpl }), e => e.status === 499);
});

test('incomplete, empty and malformed responses are rejected without upstream body', async () => {
  for (const data of [{ ...responseData, status: 'incomplete' }, { ...responseData, output: [] }, { status: 'completed', output: 'invalid' }]) {
    await assert.rejects(explainReport({}, { env, fetchImpl: async () => new Response(JSON.stringify(data)) }), e => e.status === 502);
  }
});

// Exercise HTTP handler entirely in memory: no network, including no loopback socket.
function request(app, method, url, data = {}) {
  return new Promise(resolve => {
    const req = Readable.from(method === 'POST' ? [Buffer.from(JSON.stringify(data))] : []);
    req.method = method; req.url = url; req.headers = { 'content-type': 'application/json' };
    const res = new EventEmitter();
    res.writeHead = status => { res.status = status; };
    res.end = body => resolve({ status: res.status, body: JSON.parse(body) });
    app.handle(req, res);
  });
}

test('explain route: configuration, worklist, caching, audit and decision isolation', async t => {
  const keys = [...Object.keys(env), 'OPENAI_BASE_URL'];
  const prior = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  t.after(() => { for (const k of keys) { if (prior[k] === undefined) delete process.env[k]; else process.env[k] = prior[k]; } });
  Object.assign(process.env, env); delete process.env.OPENAI_BASE_URL;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return success(); });
  const app = createApp({ runtimeFile: null });
  const id = app.worklistIds[0];
  const url = '/api/reports/' + id;
  const original = (await request(app, 'GET', url)).body;
  const meta = await request(app, 'GET', '/api/meta');
  assert.equal(meta.body.llm.configured, true);
  process.env.OPENAI_API_KEY = '';
  const missing = await request(app, 'POST', url + '/explain');
  assert.equal(missing.status, 503); assert.match(missing.body.error, /\.env/);
  assert.equal(calls, 0);
  process.env.OPENAI_API_KEY = env.OPENAI_API_KEY;
  assert.equal((await request(app, 'POST', '/api/reports/NOT-FOUND/explain')).status, 404);
  const first = await request(app, 'POST', url + '/explain');
  const second = await request(app, 'POST', url + '/explain');
  assert.equal(first.status, 200); assert.deepEqual(first.body, second.body);
  assert.match(first.body.disclaimer, /không quyết định ký/);
  assert.equal(calls, 1, 'same version/input cached');
  const after = (await request(app, 'GET', url)).body;
  assert.deepEqual(after.report, original.report);
  assert.deepEqual(after.evaluation, original.evaluation);
  assert.deepEqual(after.review, original.review);
  assert.deepEqual(after.send, original.send);
  const entries = app.state().audit.filter(a => a.type === 'LLM_EXPLAIN');
  assert.equal(entries.length, 2);
  assert.equal(entries[1].cached, true);
  assert.equal(entries[0].model, 'gpt-6-luna');
  assert.doesNotMatch(JSON.stringify(entries), /payload|test-key|Đối chiếu|conditions/);
  await request(app, 'POST', '/api/settings', { modelEnabled: false });
  await request(app, 'POST', url + '/explain');
  assert.equal(calls, 2, 'changed evaluation invalidates cached explanation');
  await request(app, 'POST', url + '/amend', { kind: 'UNIT_FIX', changes: [{ test: original.report.results[0].test, value: original.report.results[0].value }], note: 'test version' });
  await request(app, 'POST', url + '/explain');
  assert.equal(calls, 3, 'new report version invalidates cache');
  const amend = () => request(app, 'POST', url + '/amend', { kind: 'UNIT_FIX', changes: [{ test: original.report.results[0].test, value: original.report.results[0].value }], note: 'test concurrent amendment' });
  await amend();
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  t.mock.method(globalThis, 'fetch', async () => { entered(); await new Promise(resolve => { release = resolve; }); return success(); });
  const pending = request(app, 'POST', url + '/explain');
  await ready;
  const auditCount = app.state().audit.filter(a => a.type === 'LLM_EXPLAIN').length;
  await amend(); release();
  assert.equal((await pending).status, 409, 'do not return stale explanation after concurrent amendment');
  assert.equal(app.state().audit.filter(a => a.type === 'LLM_EXPLAIN').length, auditCount);
});
