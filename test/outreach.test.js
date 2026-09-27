import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, OutreachSession, snapshot, reduce, SESSION_TYPES } from '../src/outreach.js';

function newSession(over = {}) {
  return createSession({
    id: 's1', type: 'community_interview',
    scheduled_at: '2026-07-01T10:00:00Z', district: 'sham_shui_po',
    target_gap: { dimension: 'group', key: 'prh_waiting' },
    capacity: 2, ...over,
  });
}

const invite = (o, ref, at = '2026-07-01T09:00:00Z', extra = {}) =>
  o.record('invited', at, 'team', { ref, group: 'prh_waiting', consents: { contact: true, analysis: true }, ...extra });

test('场次定义有严格字段与受控类型', () => {
  assert.throws(() => createSession({
    id: 'x', type: 'street_rally', scheduled_at: '2026-07-01T10:00:00Z',
    district: 'sham_shui_po', capacity: 2,
  }), /场次类型/);
  assert.throws(() => newSession({ endorsement: true }), /不被允许的字段/);
  assert.equal(Object.hasOwn(SESSION_TYPES, 'accessible_session'), true);
});

test('满员时确认触发席位冲突并自动转候补，不允许直接占座', () => {
  const o = new OutreachSession(newSession());
  invite(o, 'a'); invite(o, 'b'); invite(o, 'c');
  o.record('confirm_requested', '2026-07-01T09:10:00Z', 'a', { ref: 'a' });
  o.record('confirm_requested', '2026-07-01T09:11:00Z', 'b', { ref: 'b' });
  o.record('confirm_requested', '2026-07-01T09:12:00Z', 'c', { ref: 'c' });
  const snap = snapshot(o.state);
  assert.equal(snap.seats_taken, 2);
  assert.equal(snap.waitlist[0].ref, 'c');
  assert.ok(o.state.events.some((e) => e.type === 'seat_conflict'));
  assert.equal(snap.roster.find((r) => r.participant_ref === 'c').conflicts.length, 1);
});

test('候补必须按顺位递补，不能插队', () => {
  const o = new OutreachSession(newSession());
  invite(o, 'a'); invite(o, 'b'); invite(o, 'c'); invite(o, 'd');
  o.record('confirm_requested', '2026-07-01T09:10:00Z', 'a', { ref: 'a' });
  o.record('confirm_requested', '2026-07-01T09:11:00Z', 'b', { ref: 'b' });
  o.record('waitlisted', '2026-07-01T09:12:00Z', 'c', { ref: 'c' });
  o.record('waitlisted', '2026-07-01T09:13:00Z', 'd', { ref: 'd' });
  assert.throws(() => o.record('promoted', '2026-07-01T09:20:00Z', 'team', { ref: 'd' }), /顺位/);
  o.record('cancelled_by_participant', '2026-07-01T09:21:00Z', 'a', { ref: 'a' });
  o.record('promoted', '2026-07-01T09:22:00Z', 'team', {});
  const entry = snapshot(o.state).roster.find((r) => r.participant_ref === 'c');
  assert.equal(entry.status, 'confirmed');
  assert.equal(entry.promoted_from_rank, 1);
});

test('临时退出释放席位；无候补时空缺须留痕为未填补', () => {
  const o = new OutreachSession(newSession());
  invite(o, 'a');
  o.record('confirm_requested', '2026-07-01T09:10:00Z', 'a', { ref: 'a' });
  // 尚无人退出、没有空缺时，不能登记“空缺未填补”。
  assert.throws(
    () => o.record('waitlist_vacancy_unfilled', '2026-07-01T09:20:00Z', 'team', {}),
    /没有待填补/,
  );
  o.record('cancelled_by_participant', '2026-07-01T09:30:00Z', 'a', { ref: 'a', reason: '病了' });
  assert.equal(snapshot(o.state).open_vacancies, 1);
  o.record('waitlist_vacancy_unfilled', '2026-07-01T09:59:00Z', 'team', { reason: '联系不上候补' });
  assert.equal(snapshot(o.state).unfilled_vacancies[0].vacancies, 1);
});

test('已确认缺席记 no_show；出席不隐含赞成', () => {
  const o = new OutreachSession(newSession());
  invite(o, 'a');
  o.record('confirm_requested', '2026-07-01T09:10:00Z', 'a', { ref: 'a' });
  o.record('no_show_recorded', '2026-07-01T11:00:00Z', 'team', { ref: 'a' });
  const snap = snapshot(o.state);
  assert.equal(snap.by_status.no_show, 1);
  assert.equal(snap.attendance_implies_endorsement, false);
});

test('联络与分析授权可分别撤回且全程留痕，撤回后状态为 false', () => {
  const o = new OutreachSession(newSession());
  invite(o, 'a');
  o.record('consent_contact_withdrawn', '2026-07-02T00:00:00Z', 'a', { ref: 'a' });
  o.record('consent_analysis_withdrawn', '2026-07-03T00:00:00Z', 'a', { ref: 'a', reason: '不想参与了' });
  const entry = snapshot(o.state).roster.find((r) => r.participant_ref === 'a');
  assert.equal(entry.consent.contact, false);
  assert.equal(entry.consent.analysis, false);
  assert.equal(entry.consent_history.length, 3);
});

test('预留席位占用容量；释放后才可再确认', () => {
  const o = new OutreachSession(newSession({ capacity: 3 }));
  o.record('reservation_made', '2026-07-01T08:00:00Z', 'team', { reason: '无障碍预留', seats: 2 });
  invite(o, 'a'); invite(o, 'b');
  o.record('confirm_requested', '2026-07-01T09:10:00Z', 'a', { ref: 'a' });
  o.record('confirm_requested', '2026-07-01T09:11:00Z', 'b', { ref: 'b' });
  assert.equal(snapshot(o.state).waitlist.length, 1); // b 被转候补
  o.record('reservation_released', '2026-07-01T09:30:00Z', 'team', { index: 0 });
  o.record('promoted', '2026-07-01T09:31:00Z', 'team', {});
  assert.equal(snapshot(o.state).seats_taken, 2);
});

test('翻译请求与无障碍需求在未满足前列为待办', () => {
  const o = new OutreachSession(newSession());
  invite(o, 'a');
  o.record('translation_requested', '2026-07-01T08:30:00Z', 'a', { lang: 'urdu', ref: 'a' });
  o.record('accommodation_requested', '2026-07-01T08:31:00Z', 'a', { ref: 'a', kind: 'sign_language_interpreter' });
  assert.equal(snapshot(o.state).pending_needs.length, 2);
  o.record('translation_provided', '2026-07-01T08:50:00Z', 'team', { lang: 'urdu' });
  o.record('accommodation_provided', '2026-07-01T08:51:00Z', 'team', { ref: 'a', index: 0 });
  assert.equal(snapshot(o.state).pending_needs.length, 0);
});

test('事件日志可完整重放出相同状态', () => {
  const o = new OutreachSession(newSession({ capacity: 3 }));
  invite(o, 'a'); invite(o, 'b'); invite(o, 'c'); invite(o, 'd');
  o.record('confirm_requested', '2026-07-01T09:10:00Z', 'a', { ref: 'a' });
  o.record('confirm_requested', '2026-07-01T09:11:00Z', 'b', { ref: 'b' });
  o.record('confirm_requested', '2026-07-01T09:12:00Z', 'c', { ref: 'c' });
  o.record('confirm_requested', '2026-07-01T09:13:00Z', 'd', { ref: 'd' }); // 冲突 → 候补
  o.record('cancelled_by_participant', '2026-07-01T09:40:00Z', 'b', { ref: 'b' });
  o.record('promoted', '2026-07-01T09:41:00Z', 'team', {}); // d 顺位递补
  const replayed = o.state.events.reduce((acc, event) => reduce(acc, event), null);
  assert.deepEqual(
    snapshot(replayed).roster.map((r) => [r.participant_ref, r.status]).sort(),
    snapshot(o.state).roster.map((r) => [r.participant_ref, r.status]).sort(),
  );
});

test('邀请记录拒绝非自愿披露受控词表的人群标签', () => {
  const o = new OutreachSession(newSession());
  assert.throws(() => invite(o, 'a', '2026-07-01T09:00:00Z', { group: 'assumed_poor' }), /受控词表/);
});
