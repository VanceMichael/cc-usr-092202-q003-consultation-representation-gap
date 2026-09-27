import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAttributionReport } from '../src/attribution.js';
import { buildStaffDashboard } from '../src/staff.js';
import { createSession, OutreachSession, snapshot } from '../src/outreach.js';

const benchmark = {
  population_total: 100000,
  districts: { sham_shui_po: 10000, kwun_tong: 10000 },
  groups: { prh_waiting: 20000, long_term_carer: 20000 },
  age_bands: { '40_59': 40000, '60_plus': 30000 },
};

const sub = (over) => ({
  id: 'x', received_at: '2026-06-01T00:00:00Z', channel: 'online_form',
  person_id: 'p', org_id: null, district: 'sham_shui_po',
  topics: ['housing'], self: { groups: [], age_band: null },
  signature_count: 0, duplicate_of: null, ...over,
});

const buildSession = ({ id, type, district, targetGap, events }) => {
  let s = createSession({
    id, type, scheduled_at: '2026-07-01T10:00:00Z', district,
    target_gap: targetGap, capacity: 10,
  });
  const o = new OutreachSession(s);
  events(o);
  return snapshot(o.state);
};

test('到场但没有经触达渠道留意见 = 到场不是声音', () => {
  const snap = buildSession({
    id: 's1', type: 'community_interview', district: 'sham_shui_po',
    targetGap: { dimension: 'group', key: 'prh_waiting' },
    events: (o) => {
      o.record('invited', '2026-07-01T09:00:00Z', 't', { ref: 'alice', group: 'prh_waiting', consents: { contact: true, analysis: true } });
      o.record('confirm_requested', '2026-07-01T09:10:00Z', 'alice', { ref: 'alice' });
      o.record('attendance_recorded', '2026-07-01T11:00:00Z', 't', { ref: 'alice' });
    },
  });
  const report = buildAttributionReport({
    baselineSubmissions: [sub({ id: 'b1', person_id: 'bp1' })],
    followupSubmissions: [],
    benchmark, sessionSnapshots: [snap],
  });
  assert.equal(report.outcome_counts.participated_no_voice, 1);
  assert.equal(report.headline.genuine_new_gap_filling_voices, 0);
});

test('基线样本里已存在的人即使到场留意见也不新增覆盖', () => {
  const snap = buildSession({
    id: 's1', type: 'community_interview', district: 'sham_shui_po',
    targetGap: { dimension: 'group', key: 'prh_waiting' },
    events: (o) => {
      o.record('invited', '2026-07-01T09:00:00Z', 't', { ref: 'pold', group: 'prh_waiting', consents: { contact: true, analysis: true } });
      o.record('confirm_requested', '2026-07-01T09:10:00Z', 'pold', { ref: 'pold' });
      o.record('attendance_recorded', '2026-07-01T11:00:00Z', 't', { ref: 'pold' });
    },
  });
  const report = buildAttributionReport({
    baselineSubmissions: [sub({ id: 'b1', person_id: 'pold', self: { groups: ['prh_waiting'], age_band: '40_59' } })],
    followupSubmissions: [sub({
      id: 'f1', person_id: 'pold', channel: 'outreach_session',
      self: { groups: ['prh_waiting'], age_band: '40_59' },
    })],
    benchmark, sessionSnapshots: [snap],
  });
  assert.equal(report.outcome_counts.already_in_sample, 1);
  assert.equal(report.headline.genuine_new_gap_filling_voices, 0);
});

test('对准缺口的新人到场留意见才计为真正填补；授权撤回者剔除', () => {
  const snap = buildSession({
    id: 's1', type: 'accessible_session', district: 'kwun_tong',
    targetGap: { dimension: 'group', key: 'long_term_carer' },
    events: (o) => {
      for (const ref of ['heidi', 'grace']) {
        o.record('invited', '2026-07-01T09:00:00Z', 't', { ref, group: 'long_term_carer', consents: { contact: true, analysis: true } });
        o.record('confirm_requested', '2026-07-01T09:10:00Z', ref, { ref });
        o.record('attendance_recorded', '2026-07-01T11:00:00Z', 't', { ref });
      }
      o.record('consent_analysis_withdrawn', '2026-07-02T00:00:00Z', 'grace', { ref: 'grace' });
    },
  });
  const fu = (id, person) => sub({
    id, person_id: person, channel: 'outreach_session', district: 'kwun_tong',
    topics: ['healthcare'], self: { groups: ['long_term_carer'], age_band: '40_59' },
  });
  const report = buildAttributionReport({
    baselineSubmissions: [sub({ id: 'b1', person_id: 'bp1' })],
    followupSubmissions: [fu('f1', 'heidi'), fu('f2', 'grace')],
    benchmark, sessionSnapshots: [snap],
  });
  assert.equal(report.outcome_counts.genuine_gap_filled, 1);
  assert.equal(report.outcome_counts.analysis_consent_withdrawn, 1);
  // grace 的意见在“触达后覆盖”中被排除。
  assert.equal(report.coverage_after.total_voices, 2); // bp1 + heidi
});

test('新声音落进已充分/未对准细格只增加总数，判为 cosmetic', () => {
  // 对准 prh_waiting，到场者却自报长者、议题医疗且其细格非缺口。
  const snap = buildSession({
    id: 's1', type: 'targeted_invitation', district: 'sham_shui_po',
    targetGap: { dimension: 'group_district', key: 'prh_waiting|sham_shui_po' },
    events: (o) => {
      o.record('invited', '2026-07-01T09:00:00Z', 't', { ref: 'mona', group: 'older_adult', consents: { contact: true, analysis: true } });
      o.record('confirm_requested', '2026-07-01T09:10:00Z', 'mona', { ref: 'mona' });
      o.record('attendance_recorded', '2026-07-01T11:00:00Z', 't', { ref: 'mona' });
    },
  });
  const report = buildAttributionReport({
    baselineSubmissions: Array.from({ length: 20 }, (_, i) =>
      sub({ id: `b${i}`, person_id: `bp${i}`, district: 'sham_shui_po', topics: [] })),
    followupSubmissions: [sub({
      id: 'f1', person_id: 'mona', channel: 'outreach_session',
      district: 'sham_shui_po', topics: ['healthcare'],
      self: { groups: ['older_adult'], age_band: '60_plus' },
    })],
    benchmark, sessionSnapshots: [snap],
  });
  assert.ok(
    report.outcome_counts.misaligned_with_target === 1 || report.outcome_counts.new_but_not_gap === 1,
  );
  assert.equal(report.headline.genuine_new_gap_filling_voices, 0);
});

test('工作人员面板给出逐场结论与缺口迁移', () => {
  const snap = buildSession({
    id: 's1', type: 'community_interview', district: 'sham_shui_po',
    targetGap: { dimension: 'group', key: 'prh_waiting' },
    events: (o) => {
      o.record('invited', '2026-07-01T09:00:00Z', 't', { ref: 'carol', group: 'prh_waiting', consents: { contact: true, analysis: true } });
      o.record('confirm_requested', '2026-07-01T09:10:00Z', 'carol', { ref: 'carol' });
      o.record('attendance_recorded', '2026-07-01T11:00:00Z', 't', { ref: 'carol' });
    },
  });
  const dashboard = buildStaffDashboard({
    baselineSubmissions: [sub({ id: 'b1', person_id: 'bp1' })],
    followupSubmissions: [sub({
      id: 'f1', person_id: 'carol', channel: 'outreach_session',
      self: { groups: ['prh_waiting'], age_band: '40_59' },
    })],
    benchmark, sessionSnapshots: [snap],
  });
  assert.equal(dashboard.internal_only, true);
  assert.equal(dashboard.session_checks[0].counts.genuine_gap_filling, 1);
  assert.ok(dashboard.session_checks[0].verdict.includes('填补'));
});
