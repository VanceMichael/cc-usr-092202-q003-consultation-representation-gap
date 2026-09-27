import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVoices, reconcileTotals } from '../src/voices.js';

const sub = (over) => ({
  id: 'x', received_at: '2026-06-01T00:00:00Z', channel: 'online_form',
  person_id: null, org_id: null, district: 'eastern',
  topics: [], self: { groups: [], age_band: null },
  signature_count: 0, duplicate_of: null, ...over,
});

test('同一人多渠道多次提交合并为 1 个声音', () => {
  const r = buildVoices([
    sub({ id: 'a', person_id: 'p1', channel: 'online_form' }),
    sub({ id: 'b', person_id: 'p1', channel: 'email', district: 'wan_chai' }),
  ]);
  assert.equal(r.voices.size, 1);
  assert.equal(r.audit.merged_repeat_submissions.length, 1);
  const voice = [...r.voices.values()][0];
  assert.deepEqual([...voice.channels].sort(), ['email', 'online_form']);
});

test('同一团体反复发声只计 1 个声音', () => {
  const r = buildVoices([
    sub({ id: 'a', org_id: 'org1' }),
    sub({ id: 'b', org_id: 'org1' }),
    sub({ id: 'c', org_id: 'org1' }),
  ]);
  assert.equal(r.voices.size, 1);
});

test('联署书只计 1 个声音，签名人数登记但绝不相加', () => {
  const r = buildVoices([
    sub({ id: 'pet1', signature_count: 500 }),
    sub({ id: 'pet2', signature_count: 1200 }),
  ]);
  assert.equal(r.voices.size, 2);
  assert.equal(r.audit.petition_signatures_excluded.length, 2);
  for (const row of r.audit.petition_signatures_excluded) assert.equal(row.voices_counted, 1);
  const totals = reconcileTotals([
    sub({ id: 'pet1', signature_count: 500 }),
    sub({ id: 'pet2', signature_count: 1200 }),
  ], r);
  assert.equal(totals.voices, 2);
  assert.equal(totals.petition_signatures_received_but_excluded, 1700);
});

test('duplicate_of 重复投递贡献 0 个新声音', () => {
  const submissions = [
    sub({ id: 'a', person_id: 'p1' }),
    sub({ id: 'b', person_id: 'p1', duplicate_of: 'a' }),
  ];
  const r = buildVoices(submissions);
  assert.equal(r.voices.size, 1);
  assert.deepEqual(r.audit.merged_duplicates[0], { submission_id: 'b', retained_as: 'a', voice_added: 0 });
  const totals = reconcileTotals(submissions, r);
  assert.equal(totals.voices, 1);
  assert.equal(totals.duplicate_submissions_removed, 1);
});

test('无锚点匿名意见各自成声且标记为不可合并', () => {
  const r = buildVoices([sub({ id: 'a' }), sub({ id: 'b' })]);
  assert.equal(r.voices.size, 2);
  assert.ok([...r.voices.values()].every((v) => v.unmergeable));
});

test('重复投递链成环时报错', () => {
  assert.throws(() => buildVoices([
    sub({ id: 'a', person_id: 'p1', duplicate_of: 'b' }),
    sub({ id: 'b', person_id: 'p2', duplicate_of: 'a' }),
  ]), /循环/);
});

test('对账恒等式成立：件数 − 重复投递 − 重复提交 = 声音数', () => {
  const submissions = [
    sub({ id: 'a', person_id: 'p1' }),
    sub({ id: 'b', person_id: 'p1' }),
    sub({ id: 'c', org_id: 'o1' }),
    sub({ id: 'd', person_id: 'p9', duplicate_of: 'c' }),
    sub({ id: 'e', signature_count: 30 }),
    sub({ id: 'f' }),
  ];
  const r = buildVoices(submissions);
  const totals = reconcileTotals(submissions, r);
  assert.equal(totals.voices, 4); // p1, o1, pet:e, anon:f
  assert.equal(totals.raw_submissions, 6);
});
