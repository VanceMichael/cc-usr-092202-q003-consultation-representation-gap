import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCoverageMap } from '../src/coverage.js';
import { buildVoices } from '../src/voices.js';

const sub = (over) => ({
  id: 'x', received_at: '2026-06-01T00:00:00Z', channel: 'online_form',
  person_id: 'p', org_id: null, district: 'eastern',
  topics: ['housing'], self: { groups: [], age_band: null },
  signature_count: 0, duplicate_of: null, ...over,
});

// 10 万人口基准；东部 5 万、青年 2 万。
const benchmark = {
  population_total: 100000,
  districts: { eastern: 50000, wan_chai: 50000 },
  groups: { youth: 20000, prh_waiting: 20000 },
  age_bands: { '15_24': 20000, '25_39': 80000 },
};

const analyze = (submissions, bm = benchmark) =>
  buildCoverageMap({ submissions, voicesResult: buildVoices(submissions), benchmark: bm });

test('统计单位是去重声音而非提交量', () => {
  const map = analyze([
    sub({ id: 'a', person_id: 'p1' }),
    sub({ id: 'b', person_id: 'p1' }),
    sub({ id: 'c', person_id: 'p1' }),
  ]);
  assert.equal(map.total_voices, 1);
  assert.equal(map.dimensions.channels.online_form.voices, 1);
});

test('地区覆盖按人口基准比例判定', () => {
  // 10 个声音全在湾仔；东部应期望约 5 个 → 0 个为 missing。
  const submissions = Array.from({ length: 10 }, (_, i) =>
    sub({ id: `p${i}`, person_id: `p${i}`, district: 'wan_chai' }));
  const map = analyze(submissions);
  assert.equal(map.dimensions.districts.eastern.status, 'missing');
  assert.equal(map.dimensions.districts.wan_chai.status, 'adequate');
  assert.ok(map.gaps.some((g) => g.dimension === 'district' && g.key === 'eastern'));
});

test('未披露人群从不被推断，也不进入人群计数', () => {
  const map = analyze([sub({ id: 'a', person_id: 'p1', self: { groups: [], age_band: null } })]);
  assert.equal(map.dimensions.groups.undisclosed.voices, 1);
  for (const key of ['youth', 'prh_waiting']) assert.equal(map.dimensions.groups[key].voices, 0);
});

test('证据不足的小细格不允许被一两个声音判为充分', () => {
  const map = analyze([sub({ id: 'a', person_id: 'p1', self: { groups: ['youth'], age_band: '15_24' } })]);
  // 只有 1 个声音，青年期望 < 最小证据量 → thin_evidence，而非 adequate。
  assert.equal(map.dimensions.groups.youth.status, 'thin_evidence');
});

test('低于充分比例阈值为 underrepresented，达到则 adequate', () => {
  // 青年占基准 20%；100 个声音时期望 20，阈值 0.8 → 16 个为分界。
  const many = Array.from({ length: 100 }, (_, i) =>
    sub({
      id: `p${i}`, person_id: `p${i}`,
      self: { groups: i < 10 ? ['youth'] : [], age_band: i < 10 ? '15_24' : '25_39' },
      topics: [],
    }));
  const map = analyze(many);
  assert.equal(map.dimensions.groups.youth.voices, 10);
  assert.equal(map.dimensions.groups.youth.status, 'underrepresented');
});

test('无地区声音进 unknown，多地声音进 multiple，均不臆断', () => {
  const map = analyze([
    sub({ id: 'a', person_id: 'p1', district: null }),
    sub({ id: 'b', person_id: 'p2', district: 'eastern' }),
    sub({ id: 'c2', person_id: 'p2', district: 'wan_chai' }),
  ]);
  assert.equal(map.dimensions.districts.unknown.voices, 1);
  assert.equal(map.dimensions.districts.multiple.voices, 1);
});

test('议题未指明计入 none 而不是被猜成某个议题', () => {
  const map = analyze([sub({ id: 'a', person_id: 'p1', topics: [] })]);
  assert.equal(map.dimensions.topics.none.voices, 1);
});
