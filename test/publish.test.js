import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPublicNote, bandForCount, DEFAULT_ANONYMITY_THRESHOLD } from '../src/publish.js';
import { buildCoverageMap } from '../src/coverage.js';
import { buildVoices } from '../src/voices.js';

const sub = (over) => ({
  id: 'x', received_at: '2026-06-01T00:00:00Z', channel: 'online_form',
  person_id: 'p', org_id: null, district: 'eastern',
  topics: [], self: { groups: [], age_band: null },
  signature_count: 0, duplicate_of: null, ...over,
});

const benchmark = {
  population_total: 100000,
  districts: { eastern: 50000 },
  groups: { youth: 20000 },
  age_bands: { '15_24': 20000 },
};

test('计数低于门槛 K 一律抑制为 <K，0 与小计数不可区分', () => {
  assert.equal(bandForCount(0, 10).band, '< 10');
  assert.equal(bandForCount(9, 10).band, '< 10');
  assert.equal(bandForCount(10, 10).band, '10–19');
  assert.equal(bandForCount(23, 10).band, '20–29');
  assert.equal(bandForCount(105, 10).band, '100–109');
});

test('公开视图不暴露门槛以下细格的缺口状态或精确值', () => {
  const submissions = [
    ...Array.from({ length: 25 }, (_, i) => sub({ id: `p${i}`, person_id: `p${i}` })),
    sub({ id: 'y1', person_id: 'y1', self: { groups: ['youth'], age_band: '15_24' } }),
  ];
  const note = buildPublicNote({
    coverage: buildCoverageMap({ submissions, voicesResult: buildVoices(submissions), benchmark }),
    totals: { raw_submissions: submissions.length, distinct_voices: submissions.length },
  });
  const youthRow = note.ranges.by_self_declared_group.find((r) => r.key === 'youth');
  assert.equal(youthRow.status, 'below_threshold');
  assert.equal(youthRow.count_band, `< ${DEFAULT_ANONYMITY_THRESHOLD}`);
  assert.equal(youthRow.coverage_status, undefined);
  // 公开缺口清单不含任何低于门槛的细格。
  assert.ok(note.gaps_public.every((g) => !g.key.includes('youth')));
  assert.ok(note.suppression_notice.suppressed_gap_cells >= 1);
});

test('公开视图保留方法、计数规则、不确定性与中立声明', () => {
  const submissions = [sub({ id: 'a', person_id: 'a' })];
  const note = buildPublicNote({
    coverage: buildCoverageMap({ submissions, voicesResult: buildVoices(submissions), benchmark }),
    totals: { raw_submissions: 1, distinct_voices: 1 },
  });
  assert.match(note.counting_rules.join(''), /联署/);
  assert.match(note.counting_rules.join(''), /签到/);
  assert.match(note.neutrality, /不表示赞成/);
  assert.match(note.uncertainty.join(''), /不.*推断/);
  assert.match(note.consent, /撤回/);
  assert.match(note.staff_only_outputs, /工作人员/);
});

test('未披露与未知类别同样以区间呈现', () => {
  const submissions = Array.from({ length: 12 }, (_, i) =>
    sub({ id: `p${i}`, person_id: `p${i}`, district: null, self: { groups: [], age_band: null } }));
  const note = buildPublicNote({
    coverage: buildCoverageMap({ submissions, voicesResult: buildVoices(submissions), benchmark }),
    totals: { raw_submissions: 12 },
  });
  assert.equal(note.ranges.undisclosed_and_unknown.group_undisclosed_band, '10–19');
  assert.equal(note.ranges.undisclosed_and_unknown.district_unknown_band, '10–19');
});
