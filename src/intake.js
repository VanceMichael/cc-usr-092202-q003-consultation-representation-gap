// 收件校验：只接受结构化、自愿披露的人群信息。
// 设计原则：
// 1. 字段采用白名单（additionalProperties 拒绝），任何 inferred_* / assumed_* / stance 之类字段无法进入系统，
//    从结构上保证“不得从文字内容推断敏感身份”，也没有任何记录政策立场的字段。
// 2. 人群标签只能出现在 self.groups，且必须属于受控词表；self 即“本人自愿披露”。
// 3. 联署、重复投递、活动签到使用各自的结构与计数规则，见 voices.js / outreach 模块。

export const CHANNELS = Object.freeze({
  online_form: '网上咨询渠道',
  email: '电邮',
  post: '邮寄',
  phone: '电话',
  outreach_session: '补充触达场次',
});

// 十八区编码（样例只使用其中一部分）。
export const DISTRICTS = Object.freeze({
  central_western: '中西区',
  wan_chai: '湾仔',
  eastern: '东区',
  southern: '南区',
  yau_tsim_mong: '油尖旺',
  sham_shui_po: '深水埗',
  kowloon_city: '九龙城',
  wong_tai_sin: '黄大仙',
  kwun_tong: '观塘',
  kwai_tsing: '葵青',
  tsuen_wan: '荃湾',
  tuen_mun: '屯门',
  yuen_long: '元朗',
  north: '北区',
  tai_po: '大埔',
  sha_tin: '沙田',
  sai_kung: '西贡',
  islands: '离岛',
});

export const TOPICS = Object.freeze({
  housing: '住房',
  healthcare: '医疗',
  youth_development: '青年发展',
});

// 受控的自愿披露人群标签（可在此扩展，但任何新增都必须是“本人可自行声明”的类别）。
export const SELF_GROUPS = Object.freeze({
  prh_waiting: '轮候公屋住户',
  long_term_carer: '长期照护者',
  youth: '青年',
  older_adult: '长者',
  ethnic_minority: '少数族裔',
  disability: '残疾人士',
});

export const AGE_BANDS = Object.freeze({
  '15_24': '15–24岁',
  '25_39': '25–39岁',
  '40_59': '40–59岁',
  '60_plus': '60岁及以上',
});

const SUBMISSION_FIELDS = new Set([
  'id', 'received_at', 'channel', 'person_id', 'org_id',
  'district', 'topics', 'self', 'signature_count', 'duplicate_of',
]);
const SELF_FIELDS = new Set(['groups', 'age_band']);
const SIGNIN_FIELDS = new Set(['id', 'event_id', 'at', 'district', 'participant_ref']);
const BENCHMARK_FIELDS = new Set(['population_total', 'districts', 'groups', 'age_bands', 'group_district']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkExtraFields(obj, allowed, where, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) errors.push(`${where}出现不被允许的字段：${key}（系统只接受白名单字段，推断身份与立场字段一律拒绝）`);
  }
}

function isValidIsoDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function validateSubmissionOne(submission, index) {
  const where = `意见${index == null ? '' : `[${index}]`}`;
  const errors = [];
  if (!isPlainObject(submission)) {
    throw new Error(`${where}必须是对象`);
  }
  checkExtraFields(submission, SUBMISSION_FIELDS, where, errors);

  if (typeof submission.id !== 'string' || submission.id.length === 0) {
    errors.push(`${where}缺少有效 id`);
  }
  if (!isValidIsoDate(submission.received_at)) errors.push(`${where}received_at 不是有效时间`);
  if (!Object.hasOwn(CHANNELS, submission.channel)) errors.push(`${where}渠道不在受控词表：${submission.channel}`);

  for (const field of ['person_id', 'org_id', 'duplicate_of']) {
    const value = submission[field];
    if (value !== null && value !== undefined && typeof value !== 'string') {
      errors.push(`${where}${field} 必须为字符串或 null`);
    }
  }
  if (submission.person_id == null && submission.org_id == null && !(submission.signature_count > 0)) {
    // 无任何去重锚点的匿名意见允许进入，但会被标记为不可合并，统计时单独披露其不确定性。
  }

  if (submission.district !== null && submission.district !== undefined
      && !Object.hasOwn(DISTRICTS, submission.district)) {
    errors.push(`${where}地区编码无效：${submission.district}`);
  }

  if (!Array.isArray(submission.topics)) {
    errors.push(`${where}topics 必须为数组（可为空数组，表示未指明）`);
  } else {
    for (const topic of submission.topics) {
      if (!Object.hasOwn(TOPICS, topic)) errors.push(`${where}议题编码无效：${topic}`);
    }
  }

  if (!isPlainObject(submission.self)) {
    errors.push(`${where}self 必须为对象（自愿披露资料；不披露也要给空对象）`);
  } else {
    checkExtraFields(submission.self, SELF_FIELDS, `${where}.self`, errors);
    if (!Array.isArray(submission.self.groups)) {
      errors.push(`${where}.self.groups 必须为数组`);
    } else {
      for (const group of submission.self.groups) {
        if (!Object.hasOwn(SELF_GROUPS, group)) {
          errors.push(`${where}.self.groups 含非自愿披露受控词表的值：${group}`);
        }
      }
    }
    const age = submission.self.age_band ?? null;
    if (age !== null && !Object.hasOwn(AGE_BANDS, age)) {
      errors.push(`${where}.self.age_band 无效：${age}`);
    }
  }

  const sig = submission.signature_count ?? 0;
  if (!Number.isInteger(sig) || sig < 0) errors.push(`${where}signature_count 必须为非负整数`);

  if (errors.length) throw new Error(errors.join('；'));
  return submission;
}

export function validateSubmissions(submissions) {
  if (!Array.isArray(submissions)) throw new Error('意见清单必须为数组');
  const ids = new Set();
  submissions.forEach((submission, index) => {
    validateSubmissionOne(submission, index);
    if (ids.has(submission.id)) throw new Error(`意见标识重复：${submission.id}`);
    ids.add(submission.id);
  });
  submissions.forEach((submission, index) => {
    if (submission.duplicate_of != null) {
      if (!ids.has(submission.duplicate_of)) {
        throw new Error(`意见[${index}]${submission.id} 的 duplicate_of 指向不存在的记录：${submission.duplicate_of}`);
      }
    }
  });
  return submissions;
}

// 活动签到记录：单独存放，仅用于出席过程，绝不计入意见声音数。
export function validateEventSignIns(signIns) {
  if (!Array.isArray(signIns)) throw new Error('签到清单必须为数组');
  const ids = new Set();
  signIns.forEach((entry, index) => {
    const where = `签到[${index}]`;
    if (!isPlainObject(entry)) throw new Error(`${where}必须是对象`);
    const errors = [];
    checkExtraFields(entry, SIGNIN_FIELDS, where, errors);
    if (typeof entry.id !== 'string' || entry.id.length === 0) errors.push(`${where}缺少有效 id`);
    if (typeof entry.event_id !== 'string' || entry.event_id.length === 0) errors.push(`${where}缺少 event_id`);
    if (!isValidIsoDate(entry.at)) errors.push(`${where}at 不是有效时间`);
    if (entry.district !== undefined && entry.district !== null
        && !Object.hasOwn(DISTRICTS, entry.district)) {
      errors.push(`${where}地区编码无效：${entry.district}`);
    }
    if (entry.participant_ref !== undefined && entry.participant_ref !== null
        && typeof entry.participant_ref !== 'string') {
      errors.push(`${where}participant_ref 必须为字符串`);
    }
    if (ids.has(entry.id)) errors.push(`${where}标识重复`);
    ids.add(entry.id);
    if (errors.length) throw new Error(errors.join('；'));
  });
  return signIns;
}

// 部门人口基准资料（虚构/统计口径数据，不含个人资料）。
export function validateBenchmark(benchmark) {
  if (!isPlainObject(benchmark)) throw new Error('基准资料必须为对象');
  const errors = [];
  checkExtraFields(benchmark, BENCHMARK_FIELDS, '基准资料', errors);
  if (!Number.isInteger(benchmark.population_total) || benchmark.population_total <= 0) {
    errors.push('population_total 必须为正整数');
  }
  const validateBag = (bag, allowed, label) => {
    if (!isPlainObject(bag)) { errors.push(`${label} 必须为对象`); return; }
    for (const [key, value] of Object.entries(bag)) {
      if (!Object.hasOwn(allowed, key)) errors.push(`${label}含无效编码：${key}`);
      if (!Number.isInteger(value) || value < 0) errors.push(`${label}.${key} 必须为非负整数`);
    }
  };
  validateBag(benchmark.districts, DISTRICTS, 'districts');
  validateBag(benchmark.groups, SELF_GROUPS, 'groups');
  validateBag(benchmark.age_bands, AGE_BANDS, 'age_bands');
  if (benchmark.group_district !== undefined) {
    if (!isPlainObject(benchmark.group_district)) {
      errors.push('group_district 必须为对象');
    } else {
      for (const [group, bag] of Object.entries(benchmark.group_district)) {
        if (!Object.hasOwn(SELF_GROUPS, group)) errors.push(`group_district 含无效人群编码：${group}`);
        if (!isPlainObject(bag)) { errors.push(`group_district.${group} 必须为对象`); continue; }
        for (const [district, value] of Object.entries(bag)) {
          if (!Object.hasOwn(DISTRICTS, district)) errors.push(`group_district.${group} 含无效地区编码：${district}`);
          if (!Number.isInteger(value) || value < 0) errors.push(`group_district.${group}.${district} 必须为非负整数`);
        }
      }
    }
  }
  if (errors.length) throw new Error(errors.join('；'));
  return benchmark;
}
