import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSubmissions, validateBenchmark, validateEventSignIns,
} from '../src/intake.js';

const baseSubmission = {
  id: 's1', received_at: '2026-06-01T00:00:00Z', channel: 'online_form',
  person_id: 'p1', org_id: null, district: 'eastern',
  topics: ['housing'], self: { groups: [], age_band: null },
  signature_count: 0, duplicate_of: null,
};

test('合法意见通过校验', () => {
  assert.doesNotThrow(() => validateSubmissions([{ ...baseSubmission }]));
});

test('拒绝任何推断身份字段（白名单结构）', () => {
  assert.throws(
    () => validateSubmissions([{ ...baseSubmission, inferred_groups: ['prh_waiting'] }]),
    /不被允许的字段/,
  );
  assert.throws(
    () => validateSubmissions([{ ...baseSubmission, stance: 'supports_policy' }]),
    /不被允许的字段/,
  );
  assert.throws(
    () => validateSubmissions([{ ...baseSubmission, self: { groups: [], age_band: null, text_guess: 'carer' } }]),
    /不被允许的字段/,
  );
});

test('人群标签只能来自受控的自愿披露词表', () => {
  assert.throws(
    () => validateSubmissions([{ ...baseSubmission, self: { groups: ['welfare_recipient'], age_band: null } }]),
    /受控词表/,
  );
  assert.doesNotThrow(() => validateSubmissions([
    { ...baseSubmission, self: { groups: ['prh_waiting', 'long_term_carer'], age_band: '40_59' } },
  ]));
});

test('拒绝非法渠道、地区、议题与重复 id', () => {
  assert.throws(() => validateSubmissions([{ ...baseSubmission, channel: 'street_booth' }]), /渠道/);
  assert.throws(() => validateSubmissions([{ ...baseSubmission, district: 'nowhere' }]), /地区/);
  assert.throws(() => validateSubmissions([{ ...baseSubmission, topics: ['tax'] }]), /议题/);
  assert.throws(
    () => validateSubmissions([{ ...baseSubmission }, { ...baseSubmission }]),
    /标识重复/,
  );
});

test('duplicate_of 必须指向存在的记录', () => {
  assert.throws(
    () => validateSubmissions([{ ...baseSubmission, duplicate_of: 'missing' }]),
    /指向不存在/,
  );
});

test('联署签名数必须为非负整数', () => {
  assert.throws(() => validateSubmissions([{ ...baseSubmission, signature_count: -3 }]), /非负整数/);
  assert.throws(() => validateSubmissions([{ ...baseSubmission, signature_count: 1.5 }]), /非负整数/);
});

test('签到记录只接受过程字段', () => {
  assert.doesNotThrow(() => validateEventSignIns([
    { id: 'si1', event_id: 'e1', at: '2026-06-01T00:00:00Z', district: 'eastern', participant_ref: 'p1' },
  ]));
  assert.throws(
    () => validateEventSignIns([
      { id: 'si1', event_id: 'e1', at: '2026-06-01T00:00:00Z', opinion_count: 1 },
    ]),
    /不被允许的字段/,
  );
});

test('基准资料校验地区/人群编码与人口数', () => {
  const good = {
    population_total: 1000,
    districts: { eastern: 100 },
    groups: { youth: 200 },
    age_bands: { '15_24': 100 },
    group_district: { youth: { eastern: 5 } },
  };
  assert.doesNotThrow(() => validateBenchmark(good));
  assert.throws(() => validateBenchmark({ ...good, population_total: -1 }), /正整数/);
  assert.throws(() => validateBenchmark({ ...good, groups: { nope: 1 } }), /无效编码/);
  assert.throws(() => validateBenchmark({ ...good, group_district: { youth: { nope: 1 } } }), /无效地区编码/);
  assert.throws(() => validateBenchmark({ ...good, group_district: { nope: { eastern: 1 } } }), /无效人群编码/);
});
