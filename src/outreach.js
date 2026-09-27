// 补充触达排程与过程留痕。
//
// 缺口确认后安排社区访谈、无障碍场次、翻译资源与定向邀请。
// 席位冲突、候补、临时退出、授权撤回全部以追加事件的方式保留过程；
// 日志只增不改——撤回的是「数据使用权」，不是「发生过这件事」的记录。
//
// 被邀请或到场不代表赞成任何政策：任何事件都不得携带立场字段。

export const SESSION_KINDS = [
  'community-interview', // 社区访谈
  'accessible-session', // 无障碍场次
  'translation-support', // 翻译资源
  'targeted-invitation', // 定向邀请
];

const STANCE_FIELDS = ['stance', 'position', 'support', 'opposed', 'attitude', 'opinion'];
const ACTIVE_STATUSES = new Set(['invited', 'confirmed', 'waitlisted']);

export function createSession({
  id,
  kind,
  capacity,
  district = null,
  topics = [],
  targetCohorts = [],
  resources = [],
}) {
  if (!id) throw new Error('场次需要标识');
  if (!SESSION_KINDS.includes(kind)) throw new Error(`未知场次类型: ${kind}`);
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error('席位必须是正整数');
  return {
    id,
    kind,
    capacity,
    district,
    topics,
    targetCohorts,
    resources,
    log: [],
    roster: new Map(),
    waitlist: [],
  };
}

function appendLog(session, entry) {
  session.log.push(Object.freeze({ seq: session.log.length + 1, ...entry }));
}

function assertNoStance(event) {
  for (const field of STANCE_FIELDS) {
    if (field in event) {
      throw new Error('邀请、确认或到场记录不得携带政策立场');
    }
  }
}

function requireStatus(participant, allowed, eventType, participantKey) {
  if (!participant || !allowed.includes(participant.status)) {
    const current = participant ? participant.status : '不存在';
    throw new Error(`参与者 ${participantKey} 当前状态为 ${current}，不能接受事件 ${eventType}`);
  }
}

function removeFromWaitlist(session, participantKey) {
  const index = session.waitlist.indexOf(participantKey);
  if (index >= 0) session.waitlist.splice(index, 1);
}

function seatedCount(session) {
  let count = 0;
  for (const p of session.roster.values()) {
    if (p.status === 'confirmed') count += 1;
  }
  return count;
}

// 席位空出时，候补按顺序转正；已退出或已撤回者自动让位。
function promoteNext(session, at) {
  while (session.waitlist.length > 0) {
    const participantKey = session.waitlist.shift();
    const next = session.roster.get(participantKey);
    if (next && next.status === 'waitlisted') {
      next.status = 'confirmed';
      appendLog(session, { type: 'promoted', participantKey, reason: 'seat-freed', at: at ?? null });
      return;
    }
  }
}

export function applyEvent(session, event) {
  assertNoStance(event);
  const { type, participantKey } = event;
  if (!participantKey) throw new Error('事件缺少参与者标识');
  const at = event.at ?? null;
  const participant = session.roster.get(participantKey);

  switch (type) {
    case 'invited': {
      if (participant && ACTIVE_STATUSES.has(participant.status)) {
        throw new Error(`参与者已在场次中: ${participantKey}`);
      }
      session.roster.set(participantKey, {
        status: 'invited',
        attended: false,
        disclosed: event.disclosed ?? {},
      });
      appendLog(session, { type, participantKey, at });
      break;
    }
    case 'confirmed': {
      requireStatus(participant, ['invited'], type, participantKey);
      appendLog(session, { type, participantKey, at });
      if (seatedCount(session) < session.capacity) {
        participant.status = 'confirmed';
      } else {
        // 席位冲突：确认尝试本身留痕，再记录转入候补。
        participant.status = 'waitlisted';
        session.waitlist.push(participantKey);
        appendLog(session, { type: 'waitlisted', participantKey, reason: 'capacity-conflict', at });
      }
      break;
    }
    case 'withdrawn': {
      // 临时退出：若占着席位则释放，候补按序转正。
      requireStatus(participant, ['invited', 'confirmed', 'waitlisted'], type, participantKey);
      const freedSeat = participant.status === 'confirmed';
      participant.status = 'withdrawn';
      removeFromWaitlist(session, participantKey);
      appendLog(session, { type, participantKey, at });
      if (freedSeat) promoteNext(session, at);
      break;
    }
    case 'consent-revoked': {
      // 授权撤回：立即不再计入任何统计，披露特征即不可用；过程事件保留。
      requireStatus(participant, ['invited', 'confirmed', 'waitlisted'], type, participantKey);
      const freedSeat = participant.status === 'confirmed';
      participant.status = 'consent-revoked';
      participant.disclosed = null;
      removeFromWaitlist(session, participantKey);
      appendLog(session, { type, participantKey, at });
      if (freedSeat) promoteNext(session, at);
      break;
    }
    case 'attended': {
      requireStatus(participant, ['confirmed'], type, participantKey);
      participant.attended = true;
      appendLog(session, { type, participantKey, at });
      break;
    }
    default:
      throw new Error(`未知事件类型: ${type}`);
  }
}

// 当前状态快照：只统计授权仍有效的参与者；完整过程请查 log。
export function sessionSnapshot(session) {
  const counts = { invited: 0, confirmed: 0, waitlisted: 0, withdrawn: 0, consentRevoked: 0, attended: 0 };
  for (const p of session.roster.values()) {
    if (p.status === 'consent-revoked') counts.consentRevoked += 1;
    else counts[p.status] += 1;
    if (p.attended && p.status === 'confirmed') counts.attended += 1;
  }
  return {
    sessionId: session.id,
    seats: session.capacity,
    ...counts,
    logLength: session.log.length,
  };
}

function participantSegments(session, participant) {
  const segments = [];
  const district = participant.disclosed?.district ?? session.district;
  if (district) segments.push(`district:${district}`);
  for (const cohort of participant.disclosed?.cohorts ?? []) {
    segments.push(`cohort:${cohort}`);
  }
  for (const topic of session.topics) {
    segments.push(`topic:${topic}`);
  }
  return segments;
}

function targetedSegments(session) {
  return [
    ...(session.district ? [`district:${session.district}`] : []),
    ...session.targetCohorts.map((c) => `cohort:${c}`),
    ...session.topics.map((t) => `topic:${t}`),
  ];
}

// 工作人员核对：每场补充触达是否真的填补了缺少的声音。
// 口径：只算「到场且授权有效」的参与者——被邀请、候补上都不算数；
// 新声音 = 不在既有有效意见 submitterKey 集合中的参与者。
// 只把总数做大、没有落在任何缺口段上的场次会被标记 onlyInflatesTotal。
export function verifyOutreach(sessions, { gaps, knownSubmitterKeys = [] }) {
  const known = new Set(knownSubmitterKeys);
  const gapKeys = new Set(gaps.map((g) => `${g.dimension}:${g.segment}`));

  return sessions.map((session) => {
    const reached = [...session.roster.entries()].filter(
      ([, p]) => p.attended && p.status === 'confirmed',
    );
    const segmentVoices = new Map();
    let newVoices = 0;
    for (const [key, participant] of reached) {
      if (known.has(key)) continue;
      newVoices += 1;
      for (const segment of participantSegments(session, participant)) {
        if (gapKeys.has(segment)) {
          segmentVoices.set(segment, (segmentVoices.get(segment) ?? 0) + 1);
        }
      }
    }
    const gapsAddressed = [...segmentVoices.entries()].map(([segmentKey, voices]) => {
      const separator = segmentKey.indexOf(':');
      return {
        dimension: segmentKey.slice(0, separator),
        segment: segmentKey.slice(separator + 1),
        voices,
      };
    });
    const addressedKeys = new Set(segmentVoices.keys());
    const missedTargets = targetedSegments(session)
      .filter((segmentKey) => gapKeys.has(segmentKey) && !addressedKeys.has(segmentKey))
      .map((segmentKey) => {
        const separator = segmentKey.indexOf(':');
        return { dimension: segmentKey.slice(0, separator), segment: segmentKey.slice(separator + 1) };
      });
    return {
      sessionId: session.id,
      kind: session.kind,
      reached: reached.length,
      newVoices,
      gapsAddressed,
      missedTargets,
      onlyInflatesTotal: newVoices > 0 && gapsAddressed.length === 0,
    };
  });
}
