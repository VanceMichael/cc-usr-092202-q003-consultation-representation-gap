// 全流程演示（虚构数据）：
//   node scripts/demo.mjs
import { readFile } from 'node:fs/promises';
import {
  validateSubmissions, validateBenchmark, validateEventSignIns,
} from '../src/intake.js';
import { buildVoices, reconcileTotals } from '../src/voices.js';
import { buildCoverageMap } from '../src/coverage.js';
import { createSession, OutreachSession, snapshot, reduce as reduceEvent } from '../src/outreach.js';
import { buildAttributionReport } from '../src/attribution.js';
import { buildStaffDashboard } from '../src/staff.js';
import { buildPublicNote, DEFAULT_ANONYMITY_THRESHOLD } from '../src/publish.js';

const line = (title) => console.log(`\n=== ${title} ===`);

const raw = await readFile(new URL('../fixtures/consultation.sample.json', import.meta.url), 'utf8');
const sample = JSON.parse(raw);
validateBenchmark(sample.benchmark);
validateSubmissions(sample.baseline_submissions);
validateSubmissions(sample.followup_submissions);
validateEventSignIns(sample.sign_ins);

// ---------- 1. 提交量 ≠ 声音数 ----------
line('1. 收件核对：联署/重复/签到都不相加');
const baselineVoices = buildVoices(sample.baseline_submissions);
const totals = reconcileTotals(sample.baseline_submissions, baselineVoices);
console.log(totals);
console.log('活动签到记录条数（绝不计入声音数）：', sample.sign_ins.length);

// ---------- 2. 代表性缺口地图 ----------
line('2. 代表性缺口地图（工作人员内部视图，按严重度排序，前 8 项）');
const coverage = buildCoverageMap({
  submissions: sample.baseline_submissions,
  voicesResult: baselineVoices,
  benchmark: sample.benchmark,
});
console.log('去重声音总数：', coverage.total_voices, '；跨渠道重复发声声音：', coverage.multi_channel_voices);
for (const gap of coverage.gaps.slice(0, 8)) {
  console.log(`- [${gap.status}] ${gap.dimension}:${gap.key} 现有 ${gap.voices} / 期望约 ${gap.expected_voices}`);
}

// ---------- 3. 补充触达过程（事件可回放） ----------
line('3. 补充触达场次过程');

// 场次一：深水埗公屋轮候住户社区访谈（容量 8，含 2 个无障碍预留席）
let s1 = createSession({
  id: 's-prh-shamshuipo', type: 'community_interview',
  scheduled_at: '2026-07-08T10:00:00Z', district: 'sham_shui_po',
  target_gap: { dimension: 'group_district', key: 'prh_waiting|sham_shui_po' },
  capacity: 8,
});
const o1 = new OutreachSession(s1);
const t1 = '2026-07-08T';
o1.record('reservation_made', `${t1}09:00:00Z`, '公众咨询团队', { reason: '无障碍预留席位', seats: 2 });
for (const [ref, group] of [
  ['alice', 'prh_waiting'], ['bob', 'prh_waiting'], ['carol', 'prh_waiting'], ['dave', 'prh_waiting'],
  ['ellen', 'prh_waiting'], ['frank', 'prh_waiting'], ['p13', 'prh_waiting'], ['nina', 'prh_waiting'],
]) {
  o1.record('invited', `${t1}09:05:00Z`, '公众咨询团队', {
    ref, group, consents: { contact: true, analysis: true },
  });
}
o1.record('translation_requested', `${t1}09:10:00Z`, 'carol', { lang: 'urdu', ref: 'carol' });
o1.record('accommodation_requested', `${t1}09:12:00Z`, 'alice', { ref: 'alice', kind: 'sign_language_interpreter' });
for (const ref of ['alice', 'bob', 'carol', 'dave', 'ellen', 'frank']) {
  o1.record('confirm_requested', `${t1}09:20:00Z`, ref, { ref });
}
// 只剩 0 个普通席：p13 确认触发席位冲突 → 自动候补
o1.record('confirm_requested', `${t1}09:22:00Z`, 'p13', { ref: 'p13' });
o1.record('waitlisted', `${t1}09:23:00Z`, 'nina', { ref: 'nina' });
// 翻译与无障碍资源在开场前到位
o1.record('translation_provided', `${t1}09:40:00Z`, '公众咨询团队', { lang: 'urdu' });
o1.record('accommodation_provided', `${t1}09:45:00Z`, '公众咨询团队', { ref: 'alice', index: 0 });
// bob 临时退出 → 空出席位 → 候补首位 p13 递补
o1.record('cancelled_by_participant', `${t1}09:50:00Z`, 'bob', { ref: 'bob', reason: '家中有事' });
o1.record('consent_contact_withdrawn', `${t1}09:51:00Z`, 'bob', { ref: 'bob', reason: '退出后不再接受联络' });
o1.record('promoted', `${t1}09:52:00Z`, '公众咨询团队', {});
// dave 已确认但缺席；其席位空出 → nina 递补到场
o1.record('no_show_recorded', `${t1}10:30:00Z`, '公众咨询团队', { ref: 'dave' });
o1.record('promoted', `${t1}10:31:00Z`, '公众咨询团队', {});
for (const ref of ['alice', 'carol', 'ellen', 'frank', 'p13', 'nina']) {
  o1.record('attendance_recorded', `${t1}11:00:00Z`, '公众咨询团队', { ref });
}
const snap1 = snapshot(o1.state);
console.log(`场次一 ${snap1.session_id}：容量 ${snap1.capacity}，预留 ${snap1.seats_reserved}，到场 ${snap1.by_status.attended ?? 0}，候补剩余 ${snap1.waitlist.length}`);

// 场次二：观塘长期照护者无障碍场次
let s2 = createSession({
  id: 's-carer-kwuntong', type: 'accessible_session',
  scheduled_at: '2026-07-15T12:30:00Z', district: 'kwun_tong',
  target_gap: { dimension: 'group', key: 'long_term_carer' },
  capacity: 4,
});
const o2 = new OutreachSession(s2);
for (const [ref, group] of [['heidi', 'long_term_carer'], ['judy', 'long_term_carer'], ['grace', 'long_term_carer'], ['ivan', 'long_term_carer']]) {
  o2.record('invited', '2026-07-15T12:00:00Z', '公众咨询团队', {
    ref, group, consents: { contact: true, analysis: true },
  });
}
o2.record('accommodation_requested', '2026-07-15T12:05:00Z', 'heidi', { ref: 'heidi', kind: 'wheelchair_access' });
o2.record('accommodation_provided', '2026-07-15T12:20:00Z', '公众咨询团队', { ref: 'heidi', index: 0 });
for (const ref of ['heidi', 'judy', 'grace']) o2.record('confirm_requested', '2026-07-15T12:10:00Z', ref, { ref });
o2.record('invitation_declined', '2026-07-15T12:12:00Z', 'ivan', { ref: 'ivan' });
for (const ref of ['heidi', 'judy', 'grace']) {
  o2.record('attendance_recorded', '2026-07-15T14:00:00Z', '公众咨询团队', { ref });
}
// grace 场次后撤回分析授权：她的意见永久留痕但退出统计
o2.record('consent_analysis_withdrawn', '2026-07-16T09:00:00Z', 'grace', { ref: 'grace', reason: '改变主意' });
const snap2 = snapshot(o2.state);
console.log(`场次二 ${snap2.session_id}：到场 ${snap2.by_status.attended ?? 0}，分析授权当前无效：`,
  snap2.roster.filter((r) => !r.consent.analysis).map((r) => r.participant_ref));

// 场次三：元朗青年定向邀请
let s3 = createSession({
  id: 's-youth-yuenlong', type: 'targeted_invitation',
  scheduled_at: '2026-07-22T15:30:00Z', district: 'yuen_long',
  target_gap: { dimension: 'group_district', key: 'youth|yuen_long' },
  capacity: 3,
});
const o3 = new OutreachSession(s3);
o3.record('invited', '2026-07-22T14:00:00Z', '公众咨询团队', {
  ref: 'leo', group: 'youth', consents: { contact: true, analysis: true },
});
o3.record('invited', '2026-07-22T14:00:00Z', '公众咨询团队', {
  ref: 'mona', group: 'older_adult', consents: { contact: true, analysis: true },
});
o3.record('invited', '2026-07-22T14:00:00Z', '公众咨询团队', {
  ref: 'kevin', group: 'youth', consents: { contact: true, analysis: true },
});
for (const ref of ['leo', 'mona', 'kevin']) o3.record('confirm_requested', '2026-07-22T14:30:00Z', ref, { ref });
o3.record('cancelled_by_participant', '2026-07-22T15:00:00Z', 'kevin', { ref: 'kevin', reason: '临时要上班' });
o3.record('waitlist_vacancy_unfilled', '2026-07-22T15:25:00Z', '公众咨询团队', { reason: '候补名单无人可递补' });
for (const ref of ['leo', 'mona']) o3.record('attendance_recorded', '2026-07-22T16:30:00Z', '公众咨询团队', { ref });
const snap3 = snapshot(o3.state);
console.log(`场次三 ${snap3.session_id}：到场 ${snap3.by_status.attended ?? 0}，未填补空缺记录 ${snap3.unfilled_vacancies.length} 条`);

// 事件日志可从存储重放（这里重放场次一验证）：
const replayed = o1.state.events.reduce((acc, event) => reduceEvent(acc, event), null);
console.log('事件日志重放一致：', snapshot(replayed).by_status.attended === snap1.by_status.attended);

// ---------- 4. 工作人员核对：真的补缺，还是数字好看 ----------
line('4. 工作人员核对面板（内部，禁止对外）');
const sessions = [snap1, snap2, snap3];
const report = buildAttributionReport({
  baselineSubmissions: sample.baseline_submissions,
  followupSubmissions: sample.followup_submissions,
  benchmark: sample.benchmark,
  sessionSnapshots: sessions,
});
console.log(report.headline);
const dashboard = buildStaffDashboard({
  baselineSubmissions: sample.baseline_submissions,
  followupSubmissions: sample.followup_submissions,
  benchmark: sample.benchmark,
  sessionSnapshots: sessions,
});
for (const check of dashboard.session_checks) {
  console.log(`- ${check.session_id}：${check.verdict}`, JSON.stringify(check.counts));
  if (check.target_gap_transition) {
    console.log(`  对准缺口迁移：${check.target_gap_transition.before} → ${check.target_gap_transition.after}`
      + `（声音 ${check.target_gap_transition.voices_before} → ${check.target_gap_transition.voices_after}，核对到 ${check.target_gap_transition.genuine_fills_recorded} 个真正填补）`);
  }
}
console.log('待处理/异常提示：', JSON.stringify(dashboard.anomalies, null, 0));

// ---------- 5. 公开方法说明（匿名门槛） ----------
line(`5. 公开方法说明（K = ${DEFAULT_ANONYMITY_THRESHOLD}，只给区间与不确定性）`);
const counted = [
  ...sample.baseline_submissions,
  ...sample.followup_submissions.filter((s) => s.person_id !== 'grace'),
];
const countedVoices = buildVoices(counted);
const countedTotals = reconcileTotals(counted, countedVoices);
const publicNote = buildPublicNote({
  coverage: buildCoverageMap({
    submissions: counted, voicesResult: countedVoices, benchmark: sample.benchmark,
  }),
  totals: countedTotals,
});
console.log('对外总量：', publicNote.headline_totals);
console.log('按自披露人群（公开）：');
for (const row of publicNote.ranges.by_self_declared_group) console.log(' ', row);
console.log('公开缺口条目数：', publicNote.gaps_public.length, '；因门槛抑制：', publicNote.suppression_notice.suppressed_gap_cells);
console.log('中立声明：', publicNote.neutrality);
