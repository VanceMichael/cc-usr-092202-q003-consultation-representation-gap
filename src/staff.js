// 工作人员核对面板（内部使用，含精确计数，不可直接对外发布）。
// 目的：让工作人员逐场核对“这次补充触达有没有真的补上缺少的声音”，
// 而不是只看到一个被联署人数、重复件和签到数垫高的总数。

import { buildAttributionReport } from './attribution.js';

export function buildStaffDashboard(input) {
  const report = buildAttributionReport(input);

  const sessionChecks = report.per_session.map((session) => {
    const c = session.outcomes;
    const verifiedGenuine = c.genuine_gap_filled ?? 0;
    const cosmeticOnly = (c.already_in_sample ?? 0)
      + (c.new_but_not_gap ?? 0)
      + (c.misaligned_with_target ?? 0);
    const processOnly = (c.participated_no_voice ?? 0)
      + (c.invited_not_participated ?? 0)
      + (c.analysis_consent_withdrawn ?? 0);

    // 该场次对准的缺口，经真正填补后是否仍为缺口。
    const targetTransition = session.target_gap
      ? report.gap_transitions.find((t) =>
        t.dimension === session.target_gap.dimension && t.key === session.target_gap.key)
      : null;

    let verdict;
    if (verifiedGenuine > 0) verdict = '填补了至少一个缺口声音';
    else if (cosmeticOnly > 0) verdict = '只增加总数，未填补所对准缺口';
    else verdict = '尚无填补证据（可能仍在过程中）';

    return {
      session_id: session.session_id,
      type: session.type,
      district: session.district,
      target_gap: session.target_gap,
      verdict,
      counts: {
        roster: session.roster_size,
        attended: session.attended,
        genuine_gap_filling: verifiedGenuine,
        cosmetic_only: cosmeticOnly,
        process_only: processOnly,
      },
      target_gap_transition: targetTransition
        ? {
            before: targetTransition.before, after: targetTransition.after,
            voices_before: targetTransition.voices_before, voices_after: targetTransition.voices_after,
            genuine_fills_recorded: targetTransition.genuine_fills,
          }
        : null,
      // 工作人员需要逐人复核的行。
      review_rows: session.rows.map((row) => ({
        participant_ref: row.participant_ref,
        roster_status: row.roster_status,
        outcome: row.outcome,
        outcome_label: report.outcomes[row.outcome],
        self_declared_group: row.self_declared_group,
        analysis_consent: row.analysis_consent,
        target_matched: row.target_matched,
        gap_cells_filled: row.gap_cells_filled,
      })),
    };
  });

  const anomalies = [];
  for (const snap of input.sessionSnapshots) {
    if (snap.pending_needs.length > 0) {
      anomalies.push({ session_id: snap.session_id, kind: 'pending_accessibility_or_translation', items: snap.pending_needs });
    }
    if (snap.open_vacancies > 0) {
      anomalies.push({ session_id: snap.session_id, kind: 'open_vacancy_not_yet_filled', seats: snap.open_vacancies });
    }
    if (snap.unfilled_vacancies.length > 0) {
      anomalies.push({
        session_id: snap.session_id, kind: 'vacancy_closed_unfilled',
        records: snap.unfilled_vacancies,
      });
    }
    if (snap.waitlist.length > 0) {
      anomalies.push({ session_id: snap.session_id, kind: 'waitlist_not_cleared', people: snap.waitlist.length });
    }
    const withdrawn = snap.roster.filter((r) => !r.consent.analysis || !r.consent.contact);
    if (withdrawn.length > 0) {
      anomalies.push({
        session_id: snap.session_id, kind: 'consent_partially_or_fully_withdrawn',
        refs: withdrawn.map((r) => r.participant_ref),
      });
    }
  }

  return {
    internal_only: true,
    do_not_publish_warning: '本面板含低于匿名门槛的精确计数与逐人结果，仅供工作人员核对，公开内容必须改用 publish.js 的输出。',
    headline: report.headline,
    coverage_change: {
      voices: { before: report.coverage_before.total_voices, after: report.coverage_after.total_voices },
      gaps: { before: report.coverage_before.gap_count, after: report.coverage_after.gap_count },
      note: '缺口数变化须与 genuine_fills 核对一致；若声音增加而缺口未减，表示触达没有对准代表性缺口。',
    },
    session_checks: sessionChecks,
    gap_transitions: report.gap_transitions,
    anomalies,
    event_log_replayable: true,
  };
}
