// 声音去重：提交量不等于声音数。
// 规则（与业务约束逐条对应）：
// - 同一人（person_id）经任何渠道多次提交：合并为 1 个声音。
// - 同一团体（org_id）反复发声：合并为 1 个声音，避免熟悉线上渠道的团体放大总量。
// - 联署（signature_count > 0）：整份联署书只计 1 个声音；签名人数只登记、绝不相加。
// - duplicate_of 指向的重复投递：合并进原件，贡献 0 个新声音。
// - 活动签到由 outreach 模块单独管理，永远不进入意见声音集合（本模块甚至不接收签到数据）。
// - 完全无锚点的匿名意见：每件是 1 个不可合并声音，单独标记，不确定性在公开说明中披露。

function resolveDuplicateChains(submissions) {
  const byId = new Map(submissions.map((s) => [s.id, s]));
  const rootOf = new Map();
  const rootFor = (id) => {
    if (rootOf.has(id)) return rootOf.get(id);
    const seen = new Set();
    let cur = id;
    while (true) {
      if (seen.has(cur)) throw new Error(`重复投递链存在循环：${cur}`);
      seen.add(cur);
      const sub = byId.get(cur);
      if (sub.duplicate_of == null) break;
      cur = sub.duplicate_of;
    }
    for (const node of seen) rootOf.set(node, cur);
    return cur;
  };
  return { byId, rootFor };
}

export function buildVoices(submissions) {
  const { rootFor } = resolveDuplicateChains(submissions);

  const voices = new Map();
  const audit = {
    merged_repeat_submissions: [], // 同人/同团体多渠道多次提交
    merged_duplicates: [],         // 明确标记的重复投递
    petition_signatures_excluded: [],
    unmergeable_anonymous: [],
  };

  const ensureVoice = (voiceId, anchor) => {
    let voice = voices.get(voiceId);
    if (!voice) {
      voice = {
        id: voiceId,
        anchor,
        channels: new Set(),
        districts: new Set(),
        groups: new Set(),
        age_bands: new Set(),
        topics: new Set(),
        submission_ids: [],
        petition_signature_count: 0,
        unmergeable: anchor === 'anonymous',
      };
      voices.set(voiceId, voice);
    }
    return voice;
  };

  for (const submission of submissions) {
    const rootId = rootFor(submission.id);

    if (submission.duplicate_of != null) {
      audit.merged_duplicates.push({
        submission_id: submission.id,
        retained_as: rootId,
        voice_added: 0,
      });
      continue;
    }

    let voiceId;
    let anchor;
    if (submission.person_id != null) {
      voiceId = `person:${submission.person_id}`;
      anchor = 'person';
    } else if (submission.org_id != null) {
      voiceId = `org:${submission.org_id}`;
      anchor = 'org';
    } else if (submission.signature_count > 0) {
      voiceId = `petition:${submission.id}`;
      anchor = 'petition';
    } else {
      voiceId = `anon:${submission.id}`;
      anchor = 'anonymous';
      audit.unmergeable_anonymous.push({ submission_id: submission.id });
    }

    const voice = ensureVoice(voiceId, anchor);
    if (voice.submission_ids.length > 0) {
      audit.merged_repeat_submissions.push({
        voice_id: voiceId,
        anchor,
        submission_id: submission.id,
        already_seen_submissions: [...voice.submission_ids],
      });
    }
    voice.submission_ids.push(submission.id);
    voice.channels.add(submission.channel);
    if (submission.district != null) voice.districts.add(submission.district);
    for (const topic of submission.topics) voice.topics.add(topic);
    for (const group of submission.self.groups) voice.groups.add(group);
    if (submission.self.age_band != null) voice.age_bands.add(submission.self.age_band);

    if (submission.signature_count > 0) {
      voice.petition_signature_count += submission.signature_count;
      audit.petition_signatures_excluded.push({
        submission_id: submission.id,
        voice_id: voiceId,
        signature_count: submission.signature_count,
        voices_counted: 1,
      });
    }
  }

  return { voices, audit };
}

// 汇总核对数：三个总数必须能对上原始收件量。
export function reconcileTotals(submissions, voicesResult) {
  const { voices, audit } = voicesResult;
  const rawSubmissions = submissions.length;
  const duplicateSubmissions = audit.merged_duplicates.length;
  const signatureCount = submissions.reduce((sum, s) => sum + (s.signature_count ?? 0), 0);
  const repeatMerges = audit.merged_repeat_submissions.length;
  // 声音数 = 原始件数 - 重复投递件数 - 被合并的重复提交件数
  const expectedVoices = rawSubmissions - duplicateSubmissions - repeatMerges;
  const actualVoices = voices.size;
  if (expectedVoices !== actualVoices) {
    throw new Error(`声音数对不平：件数 ${rawSubmissions} − 重复投递 ${duplicateSubmissions} − 重复提交 ${repeatMerges} = ${expectedVoices}，实际声音 ${actualVoices}`);
  }
  return {
    raw_submissions: rawSubmissions,
    voices: actualVoices,
    duplicate_submissions_removed: duplicateSubmissions,
    repeat_submissions_merged: repeatMerges,
    petition_signatures_received_but_excluded: signatureCount,
    unmergeable_anonymous_voices: audit.unmergeable_anonymous.length,
  };
}
