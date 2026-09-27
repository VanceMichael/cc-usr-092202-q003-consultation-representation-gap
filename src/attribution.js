// 缺口填补核对（工作人员内部视图）。
// 回答的问题：每一场补充触达是否真的带来了“缺少的声音”，还是只制造了更好看的总数？
//
// 一个到场者只有同时满足以下条件，才计为“真正填补缺口的声音”：
// 1. 在场次后通过补充触达渠道留下了去重意见（到场本身不是声音，更不是赞成）；
// 2. 该声音的去重锚点在基线样本中不存在（不是原本就已在样本里的人）；
// 3. 分析授权当前有效（授权可随时撤回，撤回后该声音不进入代表性统计核对）；
// 4. 声音落进的人群/地区细格在基线缺口清单内，且与场次对准的缺口一致。

import { buildVoices } from './voices.js';
import { buildCoverageMap } from './coverage.js';

function cellsOf(voice) {
  const districts = voice.districts.size === 0 ? ['unknown'] : [...voice.districts];
  const groups = voice.groups.size === 0 ? [] : [...voice.groups];
  const cells = [];
  for (const group of groups) {
    for (const district of districts) cells.push({ dimension: 'group_district', key: `${group}|${district}`, group, district });
    cells.push({ dimension: 'group', key: group, group, district: null });
  }
  for (const district of districts) {
    if (district !== 'unknown') cells.push({ dimension: 'district', key: district, group: null, district });
  }
  return cells;
}

const OUTCOMES = Object.freeze({
  genuine_gap_filled: '真正填补缺口的新声音',
  already_in_sample: '基线样本中已存在的声音（不新增覆盖）',
  misaligned_with_target: '新声音，但与场次对准缺口不一致',
  new_but_not_gap: '新声音，但所落细格本已充分（只增加总数）',
  analysis_consent_withdrawn: '分析授权已撤回，不计入核对',
  participated_no_voice: '仅参与/到场，未留下意见（到场不是声音）',
  invited_not_participated: '获邀但未确认出席或已退出/婉拒/缺席',
});

export function buildAttributionReport({
  baselineSubmissions,
  followupSubmissions,
  benchmark,
  sessionSnapshots,
  adequacyRatio,
}) {
  const baseline = buildVoices(baselineSubmissions);
  const followup = buildVoices(followupSubmissions);
  const baselineAnchors = new Set();
  for (const voice of baseline.voices.values()) baselineAnchors.add(voice.id);

  const coverageBefore = buildCoverageMap({
    submissions: baselineSubmissions, voicesResult: baseline, benchmark, adequacyRatio,
  });

  // 分析授权已撤回者：其意见不进入代表性统计（联络授权撤回不影响统计，只影响后续联络）。
  const analysisWithdrawnRefs = new Set();
  for (const snap of sessionSnapshots) {
    for (const entry of snap.roster) {
      if (!entry.consent.analysis) analysisWithdrawnRefs.add(entry.participant_ref);
    }
  }
  const countedSubmissions = (rows) => rows.filter((s) =>
    s.person_id == null || !analysisWithdrawnRefs.has(s.person_id));
  const allSubmissions = countedSubmissions([...baselineSubmissions, ...followupSubmissions]);
  const combined = buildVoices(allSubmissions);
  const coverageAfter = buildCoverageMap({
    submissions: allSubmissions, voicesResult: combined, benchmark, adequacyRatio,
  });

  const gapIndex = new Map();
  for (const gap of coverageBefore.gaps) gapIndex.set(`${gap.dimension}:${gap.key}`, gap);

  const byAnchor = new Map();
  for (const [id, voice] of followup.voices) byAnchor.set(voice.id, voice);

  const perSession = [];
  const outcomeCounts = Object.fromEntries(Object.keys(OUTCOMES).map((k) => [k, 0]));
  const gapFillLedger = [];

  for (const snap of sessionSnapshots) {
    const rows = [];
    for (const entry of snap.roster) {
      const anchor = `person:${entry.participant_ref}`;
      const followupVoice = byAnchor.get(anchor);
      const existedBefore = baselineAnchors.has(anchor);
      // 只有“到场”才是参与；已确认但未到场（no_show）不算参与，更不算声音。
      const present = entry.status === 'attended';

      let outcome;
      let matchedCells = [];
      let targetMatched = null;

      if (!present) {
        outcome = 'invited_not_participated';
      } else if (!followupVoice || !followupVoice.channels.has('outreach_session')) {
        outcome = 'participated_no_voice';
      } else if (!entry.consent.analysis) {
        outcome = 'analysis_consent_withdrawn';
      } else if (existedBefore) {
        outcome = 'already_in_sample';
      } else {
        const allCells = cellsOf(followupVoice);
        matchedCells = allCells.filter((c) => gapIndex.has(`${c.dimension}:${c.key}`));
        if (snap.target_gap) {
          targetMatched = allCells.some((c) =>
            c.dimension === snap.target_gap.dimension && c.key === snap.target_gap.key);
        }
        if (matchedCells.length > 0 && (snap.target_gap == null || targetMatched)) {
          outcome = 'genuine_gap_filled';
        } else if (snap.target_gap != null && !targetMatched) {
          outcome = 'misaligned_with_target';
        } else {
          outcome = 'new_but_not_gap';
        }
      }

      outcomeCounts[outcome] += 1;
      rows.push({
        participant_ref: entry.participant_ref,
        roster_status: entry.status,
        self_declared_group: entry.self_declared_group,
        outcome,
        target_gap: snap.target_gap,
        target_matched: targetMatched,
        gap_cells_filled: outcome === 'genuine_gap_filled' ? matchedCells : [],
        analysis_consent: entry.consent.analysis,
      });
      if (outcome === 'genuine_gap_filled') {
        for (const cell of matchedCells) {
          gapFillLedger.push({
            session_id: snap.session_id,
            participant_ref: entry.participant_ref,
            dimension: cell.dimension,
            key: cell.key,
          });
        }
      }
    }
    perSession.push({
      session_id: snap.session_id,
      type: snap.type,
      district: snap.district,
      target_gap: snap.target_gap,
      roster_size: snap.roster.length,
      attended: snap.by_status.attended ?? 0,
      outcomes: countBy(rows.map((r) => r.outcome)),
      rows,
    });
  }

  // 缺口状态迁移：只看真正填补的声音带来的变化（而非笼统的总数变化）。
  const afterIndex = new Map();
  for (const [key, cell] of Object.entries(coverageAfter.dimensions.groups)) {
    if (cell.status) afterIndex.set(`group:${key}`, cell);
  }
  for (const [key, cell] of Object.entries(coverageAfter.dimensions.districts)) {
    if (cell.status) afterIndex.set(`district:${key}`, cell);
  }
  for (const cell of coverageAfter.cross_cells) {
    afterIndex.set(`group_district:${cell.group}|${cell.district}`, cell);
  }

  const gapTransitions = coverageBefore.gaps.map((gap) => {
    const id = `${gap.dimension}:${gap.key}`;
    const after = afterIndex.get(id);
    return {
      dimension: gap.dimension, key: gap.key,
      before: gap.status,
      after: after ? after.status : 'unknown',
      voices_before: gap.voices,
      voices_after: after ? after.voices : null,
      genuine_fills: gapFillLedger.filter((g) => g.dimension === gap.dimension && g.key === gap.key).length,
    };
  });

  const genuineVoiceRefs = new Set(
    perSession.flatMap((s) => s.rows
      .filter((r) => r.outcome === 'genuine_gap_filled')
      .map((r) => r.participant_ref))
  );

  return {
    outcomes: OUTCOMES,
    outcome_counts: outcomeCounts,
    per_session: perSession,
    gap_fill_ledger: gapFillLedger,
    gap_transitions: gapTransitions,
    headline: {
      invitations_and_roster_rows: sessionSnapshots.reduce((n, s) => n + s.roster.length, 0),
      attended: sessionSnapshots.reduce((n, s) => n + (s.by_status.attended ?? 0), 0),
      genuine_new_gap_filling_voices: genuineVoiceRefs.size,
      message: '只有“真正填补缺口的新声音”改善代表性；出席、已有样本者和未对准缺口的新声音都不改善覆盖。',
    },
    coverage_before: { total_voices: coverageBefore.total_voices, gap_count: coverageBefore.gaps.length },
    coverage_after: { total_voices: coverageAfter.total_voices, gap_count: coverageAfter.gaps.length },
  };
}

function countBy(items) {
  const out = {};
  for (const item of items) out[item] = (out[item] ?? 0) + 1;
  return out;
}
