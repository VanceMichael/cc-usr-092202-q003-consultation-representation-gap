import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeSubmissions, buildCoverageMap, UNDISCLOSED } from '../src/coverage.js';

const base = { district: '北区', topics: ['housing'], disclosedCohorts: [] };

test('联署整份算一个声音，签名人数绝不并入', () => {
  const records = [
    { id: 'p1', channel: 'petition', petitionId: 'pet-1', signatureCount: 4800, ...base },
    { id: 'p2', channel: 'petition', petitionId: 'pet-1', signatureCount: 4800, ...base },
    { id: 'i1', channel: 'online', submitterKey: 'k1', ...base },
  ];
  const coverage = buildCoverageMap(records);
  assert.equal(coverage.totals.effectiveVoices, 2);
  assert.equal(coverage.totals.collectivePetitions, 1);
  assert.equal(coverage.byChannel.petition, 1);
});

test('同一提交者的重复投递只计一次', () => {
  const records = [1, 2, 3].map((n) => ({
    id: `r${n}`,
    channel: 'online',
    submitterKey: 'same-person',
    ...base,
  }));
  const { voices } = normalizeSubmissions(records);
  assert.equal(voices.length, 1);
  assert.equal(voices[0].id, 'r1');
});

test('活动签到单独呈现，不计入意见数', () => {
  const records = [
    { id: 'c1', channel: 'event-checkin', eventId: 'evt-1', ...base },
    { id: 's1', channel: 'online', ...base },
  ];
  const coverage = buildCoverageMap(records);
  assert.equal(coverage.totals.effectiveVoices, 1);
  assert.equal(coverage.totals.eventCheckins, 1);
  assert.equal(coverage.byChannel['event-checkin'], undefined);
});

test('不从文字推断身份：未披露就是未披露', () => {
  const records = [
    {
      id: 't1',
      channel: 'online',
      district: '中区',
      topics: ['housing'],
      disclosedCohorts: [],
      text: '（示例）文字提及轮候公屋多年，但未自愿披露人群特征',
    },
  ];
  const coverage = buildCoverageMap(records);
  assert.equal(coverage.byCohort[UNDISCLOSED], 1);
  assert.equal(coverage.byCohort['public-housing-waitlist'], undefined);
});

test('缺口地图标出从未进入样本的人群', async () => {
  const records = JSON.parse(await readFile(new URL('../fixtures/submissions.sample.json', import.meta.url), 'utf8'));
  const targets = JSON.parse(await readFile(new URL('../fixtures/targets.sample.json', import.meta.url), 'utf8'));
  const coverage = buildCoverageMap(records, targets);

  assert.equal(coverage.totals.rawRecords, 14);
  assert.equal(coverage.totals.effectiveVoices, 10);
  assert.equal(coverage.totals.eventCheckins, 2);

  const first = coverage.gaps[0];
  assert.equal(first.dimension, 'district');
  assert.equal(first.segment, '离岛');
  assert.equal(first.absent, true);

  const waitlistGap = coverage.gaps.find(
    (g) => g.dimension === 'cohort' && g.segment === 'public-housing-waitlist',
  );
  assert.equal(waitlistGap.count, 2);
  assert.equal(waitlistGap.shortfall, 3);
});
