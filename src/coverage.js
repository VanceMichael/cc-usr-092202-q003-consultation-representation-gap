// 意见覆盖画像与代表性缺口地图。
//
// 统计口径（对应咨询团队的约定）：
// - 只按渠道、地区、关注议题和「自愿披露」的人群特征统计；
//   绝不从意见文字内容推断敏感身份，未披露就是未披露。
// - 联署按一份集体意见计算，联署人数不并入人头数；
// - 同一提交者的重复投递只计一次；
// - 活动签到是到场记录，单独呈现，绝不计入意见数。

export const CHANNELS = ['online', 'paper', 'hotline', 'petition', 'event-checkin'];
export const UNDISCLOSED = 'undisclosed';

function assertRecordShape(record) {
  for (const field of ['id', 'channel', 'district', 'topics', 'disclosedCohorts']) {
    if (record[field] === undefined || record[field] === null) {
      throw new Error(`意见记录缺少字段: ${field}`);
    }
  }
  if (!CHANNELS.includes(record.channel)) {
    throw new Error(`未知渠道: ${record.channel}`);
  }
  if (!Array.isArray(record.topics) || record.topics.length === 0) {
    throw new Error('意见记录至少需要一个关注议题');
  }
  if (!Array.isArray(record.disclosedCohorts)) {
    throw new Error('disclosedCohorts 必须是数组（可以为空，表示未披露）');
  }
}

// 把原始记录归并成「有效声音」：
// 联署整份算一个；同一 submitterKey 只留第一份；签到记录分流出去单独计数。
export function normalizeSubmissions(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('意见记录不能为空');
  }
  const eventCheckins = [];
  const petitions = new Map();
  const individuals = new Map();
  const untracked = [];

  for (const record of records) {
    assertRecordShape(record);
    if (record.channel === 'event-checkin' || record.eventId) {
      // 活动签到只说明到过现场，不是一份意见。
      eventCheckins.push(record);
      continue;
    }
    if (record.petitionId) {
      // 联署：一份集体意见。signatureCount 永远不参与计数——
      // 签名者与个人提交者的重叠无法核实，相加必然重复。
      if (!petitions.has(record.petitionId)) {
        petitions.set(record.petitionId, { ...record, collective: true });
      }
      continue;
    }
    if (record.submitterKey) {
      // 重复投递：同一提交者只计一次，保留第一份。
      if (!individuals.has(record.submitterKey)) {
        individuals.set(record.submitterKey, record);
      }
      continue;
    }
    untracked.push(record);
  }

  return {
    voices: [...petitions.values(), ...individuals.values(), ...untracked],
    eventCheckins,
  };
}

function countBy(voices, segmentsOf) {
  const cells = new Map();
  for (const voice of voices) {
    for (const segment of segmentsOf(voice)) {
      cells.set(segment, (cells.get(segment) ?? 0) + 1);
    }
  }
  return Object.fromEntries(cells);
}

// 只读取结构化披露字段；record.text 在这里刻意不被触碰。
function cohortsOf(voice) {
  return voice.disclosedCohorts.length > 0 ? voice.disclosedCohorts : [UNDISCLOSED];
}

// targets 形如 { district: { '北区': 40 }, cohort: { caregiver: 25 }, ... }，
// 每个分段给出最低覆盖数；低于即为缺口，数量为 0 的分段就是「从未进入样本」。
export function findGaps(cellsByDimension, targets) {
  const gaps = [];
  for (const [dimension, segments] of Object.entries(targets)) {
    const cells = cellsByDimension[dimension] ?? {};
    for (const [segment, minCount] of Object.entries(segments)) {
      const count = cells[segment] ?? 0;
      if (count < minCount) {
        gaps.push({
          dimension,
          segment,
          count,
          minCount,
          shortfall: minCount - count,
          ratio: count / minCount,
          absent: count === 0,
        });
      }
    }
  }
  return gaps.sort((a, b) => a.ratio - b.ratio || b.shortfall - a.shortfall);
}

export function buildCoverageMap(records, targets = {}) {
  const { voices, eventCheckins } = normalizeSubmissions(records);
  const byChannel = countBy(voices, (v) => [v.channel]);
  const byDistrict = countBy(voices, (v) => [v.district]);
  const byTopic = countBy(voices, (v) => v.topics);
  const byCohort = countBy(voices, cohortsOf);
  const totals = {
    rawRecords: records.length,
    effectiveVoices: voices.length,
    collectivePetitions: voices.filter((v) => v.collective).length,
    // 签到数与有效声音分开呈现，互不相加。
    eventCheckins: eventCheckins.length,
  };
  const gaps = findGaps(
    { channel: byChannel, district: byDistrict, topic: byTopic, cohort: byCohort },
    targets,
  );
  return { totals, byChannel, byDistrict, byTopic, byCohort, gaps };
}
