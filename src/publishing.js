// 匿名方法公开与内部核对视图。
//
// 公开口径：只呈现达到匿名门槛的区间与不确定性——
// 小于门槛的格子一律抑制，达标的格子也只给区间带，不给精确值。
// 内部口径：工作人员看精确计数与逐场次的缺口填补核对，
// 用来确认补充触达填补的是缺口，而不是把总数做得更好看。

export const DEFAULT_THRESHOLD = 5;
export const DEFAULT_BAND_SIZE = 5;

function bandOf(count, bandSize) {
  const low = Math.floor(count / bandSize) * bandSize;
  return `${low}–${low + bandSize - 1}`;
}

function publicCells(cells, threshold, bandSize) {
  const out = {};
  for (const [segment, count] of Object.entries(cells)) {
    out[segment] = count < threshold
      ? { suppressed: true, range: `<${threshold}` }
      : { suppressed: false, range: bandOf(count, bandSize) };
  }
  return out;
}

function publicTotal(count, threshold, bandSize) {
  return count < threshold ? `<${threshold}` : bandOf(count, bandSize);
}

// 公开方法说明：不含任何精确计数，小格子只有「已抑制」与上界。
export function buildPublicMethodology(
  coverage,
  { threshold = DEFAULT_THRESHOLD, bandSize = DEFAULT_BAND_SIZE } = {},
) {
  return {
    audience: 'public',
    anonymityThreshold: threshold,
    bandSize,
    totals: {
      // 总数同样只给区间；签到数与有效声音分开呈现，不相加。
      effectiveVoices: publicTotal(coverage.totals.effectiveVoices, threshold, bandSize),
      eventCheckins: publicTotal(coverage.totals.eventCheckins, threshold, bandSize),
    },
    byChannel: publicCells(coverage.byChannel, threshold, bandSize),
    byDistrict: publicCells(coverage.byDistrict, threshold, bandSize),
    byTopic: publicCells(coverage.byTopic, threshold, bandSize),
    byCohort: publicCells(coverage.byCohort, threshold, bandSize),
    gaps: coverage.gaps.map((gap) => ({
      dimension: gap.dimension,
      segment: gap.segment,
      status: gap.absent ? 'absent' : 'below-target',
      // 不公开缺口的精确差额，只公开达成率区间（%）。
      coveragePercentRange: bandOf(Math.round(gap.ratio * 100), 10),
    })),
    notes: [
      '联署按一份集体意见计算，签名人数不并入总数',
      '同一提交者的重复投递只计一次',
      '活动签到为到场记录，不计入意见数',
      '人群特征仅统计自愿披露，未从意见文字推断身份',
      `小于 ${threshold} 的格子已抑制；区间带宽为 ${bandSize}`,
      '区间反映去重与联署重叠带来的不确定性，实际值落在区间内',
    ],
  };
}

// 内部核对视图：精确计数 + 缺口清单 + 每场补充触达的缺口填补核对。
// 仅供工作人员使用，不得原样公开。
export function buildStaffReport(coverage, outreachVerification = []) {
  return {
    audience: 'internal',
    totals: { ...coverage.totals },
    cells: {
      channel: { ...coverage.byChannel },
      district: { ...coverage.byDistrict },
      topic: { ...coverage.byTopic },
      cohort: { ...coverage.byCohort },
    },
    gaps: coverage.gaps.map((gap) => ({ ...gap })),
    outreach: outreachVerification,
  };
}
