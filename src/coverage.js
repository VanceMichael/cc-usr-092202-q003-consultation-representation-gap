// 覆盖统计与代表性缺口地图（内部视图，工作人员可见真实计数）。
// 统计对象永远是“去重后的声音”，不是原始提交量。
// 缺口判定只用结构化自披露资料与部门人口基准，不读取意见文字。

import { CHANNELS, DISTRICTS, TOPICS, SELF_GROUPS, AGE_BANDS } from './intake.js';

// 达到期望占比的 80% 即视为覆盖充分；低于则 underrepresented，0 为 missing。
export const DEFAULT_ADEQUACY_RATIO = 0.8;
// 细格期望声音数低于此值时，无论实际计数多少都只能得到“证据不足”，
// 不允许用一两个声音宣布充分；证据不足细格同样列入待补充清单。
export const DEFAULT_MIN_CELL_EXPECTED = 3;

function earliestSubmissionMap(submissions) {
  const byId = new Map();
  for (const s of submissions) byId.set(s.id, s);
  return byId;
}

// 每个声音归并出用于统计的属性；多值属性（议题、自披露人群）保留多选。
function summarizeVoice(voice, submissionsById) {
  const dated = voice.submission_ids
    .map((id) => submissionsById.get(id))
    .sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at));

  // 主渠道：最早一次提交的渠道（多选渠道会令总数对不平，故选主渠道并另记跨渠道数）。
  const primaryChannel = dated[0].channel;
  const usesMultipleChannels = voice.channels.size > 1;

  let districtKey;
  if (voice.districts.size === 0) districtKey = 'unknown';
  else if (voice.districts.size === 1) districtKey = [...voice.districts][0];
  else districtKey = 'multiple';

  let ageKey;
  if (voice.age_bands.size === 0) ageKey = 'undisclosed';
  else if (voice.age_bands.size === 1) ageKey = [...voice.age_bands][0];
  else ageKey = 'inconsistent';

  return {
    id: voice.id,
    anchor: voice.anchor,
    primary_channel: primaryChannel,
    multi_channel: usesMultipleChannels,
    district: districtKey,
    groups: voice.groups.size > 0 ? [...voice.groups] : ['undisclosed'],
    age_band: ageKey,
    topics: voice.topics.size > 0 ? [...voice.topics] : ['none'],
    unmergeable: voice.unmergeable,
  };
}

function ratioStatus(count, expected, adequacyRatio, population, minCellExpected) {
  if (population <= 0) return 'not_in_benchmark';
  if (expected < minCellExpected) {
    // 基准太小，比例无统计意义：达到最小证据量即可视为有证据，否则证据不足。
    return count >= minCellExpected ? 'adequate' : 'thin_evidence';
  }
  if (count === 0) return 'missing';
  const ratio = count / expected;
  return ratio >= adequacyRatio ? 'adequate' : 'underrepresented';
}

function benchmarkCell(benchmark, kind, key) {
  const bag = kind === 'district' ? benchmark.districts
    : kind === 'group' ? benchmark.groups
    : benchmark.age_bands;
  return bag[key] ?? 0;
}

export function buildCoverageMap({
  submissions, voicesResult, benchmark,
  adequacyRatio = DEFAULT_ADEQUACY_RATIO,
  minCellExpected = DEFAULT_MIN_CELL_EXPECTED,
}) {
  const submissionsById = earliestSubmissionMap(submissions);
  const summaries = [...voicesResult.voices.values()]
    .map((voice) => summarizeVoice(voice, submissionsById));
  const totalVoices = summaries.length;

  const emptyCount = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));

  const channelCounts = emptyCount(Object.keys(CHANNELS));
  const districtCounts = emptyCount([...Object.keys(DISTRICTS), 'unknown', 'multiple']);
  const topicCounts = emptyCount([...Object.keys(TOPICS), 'none']);
  const groupCounts = emptyCount([...Object.keys(SELF_GROUPS), 'undisclosed']);
  const ageCounts = emptyCount([...Object.keys(AGE_BANDS), 'undisclosed', 'inconsistent']);
  let multiChannelVoices = 0;
  let unmergeableAnonymous = 0;

  // group × district 交叉细格（定向补充触达对准用）。
  const cross = new Map();
  const bumpCross = (group, district) => {
    const key = `${group}|${district}`;
    cross.set(key, (cross.get(key) ?? 0) + 1);
  };

  for (const v of summaries) {
    channelCounts[v.primary_channel] += 1;
    if (v.multi_channel) multiChannelVoices += 1;
    districtCounts[v.district] += 1;
    for (const t of v.topics) topicCounts[t] += 1;
    for (const g of v.groups) groupCounts[g] += 1;
    ageCounts[v.age_band] += 1;
    if (v.unmergeable) unmergeableAnonymous += 1;
    for (const g of v.groups) {
      if (g !== 'undisclosed') bumpCross(g, v.district);
    }
  }

  const expectedFor = (population) => Math.max(1, Math.ceil((population / benchmark.population_total) * totalVoices));

  const assessDimension = (counts, bagKeys, kind) => {
    const out = {};
    for (const key of bagKeys) {
      const population = benchmarkCell(benchmark, kind, key);
      const expected = expectedFor(population);
      const voices = counts[key];
      out[key] = {
        voices,
        benchmark_population: population,
        expected_voices: expected,
        coverage_ratio: population > 0 ? Number((voices / expected).toFixed(3)) : null,
        status: ratioStatus(voices, expected, adequacyRatio, population, minCellExpected),
      };
    }
    return out;
  };

  const districts = assessDimension(districtCounts, Object.keys(DISTRICTS), 'district');
  districts.unknown = { voices: districtCounts.unknown, note: '未提供地区，不推断' };
  districts.multiple = { voices: districtCounts.multiple, note: '同一声音报称多个地区' };

  const groups = assessDimension(groupCounts, Object.keys(SELF_GROUPS), 'group');
  groups.undisclosed = { voices: groupCounts.undisclosed, note: '自愿披露为空，不推断其人群身份' };

  const ageBands = assessDimension(ageCounts, Object.keys(AGE_BANDS), 'age_bands');
  ageBands.undisclosed = { voices: ageCounts.undisclosed, note: '未披露年龄段' };
  ageBands.inconsistent = { voices: ageCounts.inconsistent, note: '同一声音多次提交披露不一致' };

  const channels = {};
  for (const key of Object.keys(CHANNELS)) {
    channels[key] = { voices: channelCounts[key], share: Number((channelCounts[key] / totalVoices).toFixed(3)) };
  }

  const topics = {};
  for (const key of Object.keys(TOPICS)) {
    topics[key] = { voices: topicCounts[key] };
  }
  topics.none = { voices: topicCounts.none, note: '未指明议题' };

  // 交叉细格评估：优先使用基准中可选的 group×district 人口；缺则以独立假设计算并标注。
  const crossCells = [];
  for (const group of Object.keys(SELF_GROUPS)) {
    for (const district of Object.keys(DISTRICTS)) {
      const key = `${group}|${district}`;
      const voices = cross.get(key) ?? 0;
      const direct = benchmark.group_district?.[group]?.[district];
      let expected;
      let basis;
      let cellPopulation;
      if (direct != null) {
        cellPopulation = direct;
        basis = 'benchmark_direct';
      } else {
        const gPop = benchmark.groups[group] ?? 0;
        const dPop = benchmark.districts[district] ?? 0;
        cellPopulation = (gPop * dPop) / Math.max(1, benchmark.population_total);
        basis = 'independence_estimate';
      }
      expected = expectedFor(cellPopulation);
      crossCells.push({
        group, district, voices, expected_voices: expected,
        coverage_ratio: cellPopulation > 0 ? Number((voices / expected).toFixed(3)) : null,
        status: ratioStatus(voices, expected, adequacyRatio, cellPopulation, minCellExpected),
        expected_basis: basis,
      });
    }
  }

  const GAP_STATUSES = new Set(['missing', 'underrepresented', 'thin_evidence']);
  const gaps = [];
  const pushGaps = (dimension, key, cell) => {
    if (GAP_STATUSES.has(cell.status)) {
      gaps.push({ dimension, key, voices: cell.voices, expected_voices: cell.expected_voices, status: cell.status });
    }
  };
  for (const [key, cell] of Object.entries(districts)) {
    if (cell.status) pushGaps('district', key, cell);
  }
  for (const [key, cell] of Object.entries(groups)) {
    if (cell.status) pushGaps('group', key, cell);
  }
  for (const cell of crossCells) {
    if (GAP_STATUSES.has(cell.status)) {
      pushGaps('group_district', `${cell.group}|${cell.district}`, cell);
    }
  }
  const rank = { missing: 0, underrepresented: 1, thin_evidence: 2 };
  gaps.sort((a, b) => {
    if (a.status !== b.status) return rank[a.status] - rank[b.status];
    return (a.voices / a.expected_voices) - (b.voices / b.expected_voices);
  });

  return {
    total_voices: totalVoices,
    multi_channel_voices: multiChannelVoices,
    unmergeable_anonymous_voices: unmergeableAnonymous,
    dimensions: { channels, districts, topics, groups, age_bands: ageBands },
    cross_cells: crossCells,
    gaps,
  };
}
