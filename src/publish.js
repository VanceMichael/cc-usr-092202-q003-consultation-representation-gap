// 公开方法说明与对外发布视图。
// 铁律：公开输出只呈现达到匿名门槛的范围与不确定性；
// 任何细格计数低于门槛 K 都不展示精确值，并避免用“总数相减”反推出被隐藏的数字。

import { CHANNELS, DISTRICTS, TOPICS, SELF_GROUPS, AGE_BANDS } from './intake.js';

const CHANNEL_LABELS = CHANNELS;
const DISTRICT_LABELS = DISTRICTS;
const TOPIC_LABELS = TOPICS;
const GROUP_LABELS = SELF_GROUPS;
const AGE_LABELS = AGE_BANDS;

export const DEFAULT_ANONYMITY_THRESHOLD = 10;

// 把计数转成“固定宽度 K”的区间带，避免精确值泄露；区间有意不相加成总数。
// 0 与 1..K-1 合并报告为“门槛以下”（不区分，防止 1 人被识别，也不给出可反推的余数）。
export function bandForCount(count, k = DEFAULT_ANONYMITY_THRESHOLD) {
  if (!Number.isInteger(count) || count < 0) throw new Error('计数必须为非负整数');
  if (count < k) return { suppressed: true, band: `< ${k}`, exact: null, lower_bound: null };
  const lo = Math.floor(count / k) * k;
  const hi = lo + k - 1;
  return { suppressed: false, band: `${lo}–${hi}`, exact: null, lower_bound: lo };
}

function shareRange(count, total, k) {
  if (total === 0) return null;
  if (count < k) return { suppressed: true, share_band: null };
  const band = bandForCount(count, k);
  return {
    suppressed: false,
    count_band: band.band,
    share_range_pct: [
      Number(((band.lower_bound / total) * 100).toFixed(1)),
      Number((((band.lower_bound + k - 1) / total) * 100).toFixed(1)),
    ],
  };
}

function publishDimension(cells, labels, total, k) {
  const rows = [];
  for (const [key, cell] of Object.entries(cells)) {
    if (key === 'undisclosed' || key === 'unknown' || key === 'multiple'
        || key === 'inconsistent' || key === 'none') continue;
    const count = cell.voices;
    if (count < k) {
      // 0 与小计数不区分显示：只说“低于门槛”，既不暴露少数人，也不暴露空缺定位。
      rows.push({ key, label: labels[key], status: 'below_threshold', count_band: `< ${k}` });
    } else {
      rows.push({ key, label: labels[key], coverage_status: cell.status, ...shareRange(count, total, k) });
    }
  }
  return rows;
}

export function buildPublicNote({ coverage, totals, k = DEFAULT_ANONYMITY_THRESHOLD }) {
  const d = coverage.dimensions;

  // 未披露/未知类别同样只给区间，且不计入任何人群细格。
  const undisclosed = {
    group_undisclosed_band: bandForCount(d.groups.undisclosed.voices, k).band,
    age_undisclosed_band: bandForCount(d.age_bands.undisclosed.voices, k).band,
    district_unknown_band: bandForCount(d.districts.unknown.voices, k).band,
    unmergeable_anonymous_band: bandForCount(coverage.unmergeable_anonymous_voices, k).band,
  };

  // 缺口对外清单：只公开计数≥门槛的细格状态；门槛以下（含 0）不在公开版本定位，
  // 避免把“某类人在某区完全缺席”这类可识别小群体的信息公开定位。
  const publicGaps = coverage.gaps
    .filter((gap) => gap.voices >= k)
    .map((gap) => ({
      dimension: gap.dimension, key: gap.key,
      status: gap.status,
      voices_band: bandForCount(gap.voices, k).band,
    }));
  const suppressedGapCount = coverage.gaps.length - publicGaps.length;

  return {
    title: '五年规划公众咨询代表性补充——方法说明（公开版）',
    generated_for: '公开发布',
    anonymity_threshold_k: k,
    headline_totals: {
      raw_submissions: totals.raw_submissions,
      distinct_voices: coverage.total_voices,
      note: '声音数已对重复投递、同人/同团体多次提交去重；联署每份计 1 个声音，签名人数不相加；活动签到不计入声音数。',
    },
    ranges: {
      by_channel: publishDimension(d.channels, CHANNEL_LABELS, coverage.total_voices, k),
      by_district: publishDimension(d.districts, DISTRICT_LABELS, coverage.total_voices, k),
      by_topic: publishDimension(d.topics, TOPIC_LABELS, coverage.total_voices, k),
      by_self_declared_group: publishDimension(d.groups, GROUP_LABELS, coverage.total_voices, k),
      by_age_band: publishDimension(d.age_bands, AGE_LABELS, coverage.total_voices, k),
      undisclosed_and_unknown: undisclosed,
      multi_channel_voices_band: bandForCount(coverage.multi_channel_voices, k).band,
    },
    gaps_public: publicGaps,
    suppression_notice: {
      suppressed_gap_cells: suppressedGapCount,
      rule: `计数低于 ${k} 的细格一律显示为“< ${k}”，且公开版不报告其缺口状态、不发布余数，因此各表有意不能相加为总数。`,
    },
    uncertainty: [
      '人群、年龄段与地区仅来自本人自愿披露的结构化选项；未披露者归入“未披露”，不从意见文字推断身份。',
      '人口基准为部门统计口径；人群×地区交叉细格在缺少直接人口时按独立假设计算，标记为 independence_estimate（内部视图），公开版不展示该级别的精确估计。',
      '无锚点匿名意见无法跨渠道合并，其数量以区间形式计入。',
    ],
    counting_rules: [
      '同一人经任何渠道多次提交合并为 1 个声音。',
      '同一团体反复发声合并为 1 个声音。',
      '联署书每份计 1 个声音；签名人数登记但不计入声音数。',
      '明确标记的重复投递并入原件。',
      '补充触达场次的活动签到只记录出席过程，绝不计入意见声音数。',
    ],
    neutrality: '获邀、出席或在补充场次发言均不表示赞成任何政策或方案；过程参与与政策立场在数据结构上完全分离。',
    consent: '联络授权与分析授权可分别撤回；撤回以事件形式永久留痕，撤回后的声音不进入代表性统计与填补核对。',
    staff_only_outputs: '逐人/逐场次的精确计数、缺口定位与填补核对结果仅工作人员可见，不包含在本公开版中。',
  };
}
