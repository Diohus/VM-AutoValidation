import test from 'node:test';
import assert from 'node:assert/strict';
import { cases } from '../src/data.js';
import { evaluateCase } from '../src/rules.js';
const find = id => cases.find(item => item.id === id);

test('default fixtures have the expected scenario decisions', () => {
  assert.deepEqual(cases.map(item => evaluateCase(item).decision), ['ELIGIBLE','ELIGIBLE','REVIEW','REVIEW','REVIEW','REVIEW']);
});
test('history option changes only the corresponding scenario and explains why', () => {
  const sample = find('DEMO-003');
  assert.equal(evaluateCase(sample).decision, 'REVIEW');
  assert.equal(evaluateCase(sample, {history:false, context:true}).decision, 'ELIGIBLE');
  assert.match(evaluateCase(sample).checks.find(item => !item.pass).info, /biến động/);
});
test('optional checks cannot override mandatory missing data and instrument flags', () => {
  const options = {history:false, context:false};
  for (const id of ['DEMO-004','DEMO-005']) assert.equal(evaluateCase(find(id), options).decision, 'REVIEW');
});
test('an out-of-reference scenario is not automatically treated as an instrument error', () => {
  assert.equal(evaluateCase(find('DEMO-002')).decision, 'ELIGIBLE');
  assert.equal(evaluateCase({...find('DEMO-002'), flag:true}).decision, 'REVIEW');
});
test('results identify the simulation and rule version without mutating inputs', () => {
  const before = JSON.stringify(cases);
  for (const sample of cases) {
    const result = evaluateCase(sample);
    assert.equal(result.simulation, true);
    assert.equal(result.ruleVersion, 'scenario-v1');
  }
  assert.equal(JSON.stringify(cases), before);
});
