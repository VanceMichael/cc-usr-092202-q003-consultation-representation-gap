// 补充触达过程：事件溯源（append-only log）+ 纯归约器。
// 每一次邀请、席位预留/冲突、候补、递补、临时退出、到场、授权撤回都是不可删除的事件，
// 当前状态由日志归约得出，工作人员可回放全过程。
//
// 立场中立原则：日志中没有任何记录政策立场或意见内容的字段。
// 被邀请或到场仅表示参与过程，绝不表示赞成任何政策（输出中明示）。

import { SELF_GROUPS, DISTRICTS } from './intake.js';

export const SESSION_TYPES = Object.freeze({
  community_interview: '社区访谈',
  accessible_session: '无障碍场次',
  translated_session: '提供翻译的场次',
  targeted_invitation: '定向邀请',
});

const EVENT_TYPES = new Set([
  'session_created',
  'reservation_made', 'reservation_released',
  'invited', 'invitation_declined',
  'confirm_requested', 'seat_conflict',
  'waitlisted', 'promoted', 'waitlist_vacancy_unfilled',
  'cancelled_by_participant', 'no_show_recorded',
  'attendance_recorded',
  'translation_requested', 'translation_provided',
  'accommodation_requested', 'accommodation_provided',
  'consent_contact_withdrawn', 'consent_analysis_withdrawn',
]);

const SESSION_FIELDS = new Set(['id', 'type', 'scheduled_at', 'district', 'target_gap', 'capacity']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function createSession(def) {
  assert(isPlainObject(def), '场次定义必须为对象');
  for (const key of Object.keys(def)) {
    assert(SESSION_FIELDS.has(key), `场次定义含不被允许的字段：${key}`);
  }
  assert(typeof def.id === 'string' && def.id.length > 0, '场次缺少 id');
  assert(Object.hasOwn(SESSION_TYPES, def.type), `场次类型无效：${def.type}`);
  assert(!Number.isNaN(Date.parse(def.scheduled_at)), '场次时间无效');
  assert(Object.hasOwn(DISTRICTS, def.district), `场次地区无效：${def.district}`);
  assert(Number.isInteger(def.capacity) && def.capacity > 0, 'capacity 必须为正整数');
  if (def.target_gap !== undefined && def.target_gap !== null) {
    assert(isPlainObject(def.target_gap) && typeof def.target_gap.dimension === 'string'
      && typeof def.target_gap.key === 'string', 'target_gap 必须为 {dimension, key} 或 null');
  }
  const event = {
    session_id: def.id,
    type: 'session_created', at: def.scheduled_at,
    payload: {
      type: def.type, district: def.district, capacity: def.capacity,
      target_gap: def.target_gap ?? null,
    },
  };
  return reduce(null, event);
}

function initialState(sessionId, event) {
  return {
    session_id: sessionId,
    type: event.payload.type,
    district: event.payload.district,
    capacity: event.payload.capacity,
    target_gap: event.payload.target_gap,
    reservations: [], // {reason, seats, active}
    roster: new Map(),
    waitlist: [],
    open_vacancies: 0,
    translations: new Map(), // lang -> {requested_by:[], provided:bool}
    accommodations: new Map(), // ref -> [requests]
    events: [],
  };
}

function rosterEntry(ref, payload, at) {
  return {
    participant_ref: ref,
    self_declared_group: payload.group ?? 'undisclosed',
    status: 'invited',
    invited_at: at,
    waitlist_rank: null,
    promoted_from_rank: null,
    consent: {
      contact: payload.consents?.contact ?? false,
      analysis: payload.consents?.analysis ?? false,
    },
    consent_history: [{
      at, contact: payload.consents?.contact ?? false, analysis: payload.consents?.analysis ?? false,
      reason: '登记时的授权状态',
    }],
  };
}

export function reduce(state, event) {
  assert(EVENT_TYPES.has(event.type), `未知事件类型：${event.type}`);
  const next = state === null
    ? initialState(event.session_id, event)
    : cloneState(state);
  if (state !== null && event.session_id != null && event.session_id !== state.session_id) {
    throw new Error(`事件场次 ${event.session_id} 与状态场次 ${state.session_id} 不一致`);
  }
  next.events.push(event);
  const p = event.payload ?? {};
  const roster = next.roster;
  const entry = p.ref ? roster.get(p.ref) : null;

  const seatsTaken = () => [...roster.values()].filter((r) => r.status === 'confirmed' || r.status === 'attended').length;
  const availableSeats = () => next.capacity
    - next.reservations.filter((r) => r.active).reduce((n, r) => n + r.seats, 0)
    - seatsTaken();

  switch (event.type) {
    case 'session_created':
      break;

    case 'reservation_made': {
      assert(Number.isInteger(p.seats) && p.seats > 0, '预留席位数必须为正整数');
      assert(availableSeats() >= p.seats, `预留 ${p.seats} 席超过可用席位（剩 ${availableSeats()}）`);
      next.reservations.push({ reason: p.reason, seats: p.seats, active: true, at: event.at });
      break;
    }
    case 'reservation_released': {
      const r = next.reservations[p.index];
      assert(r && r.active, '只能释放一条生效中的预留');
      r.active = false;
      r.released_at = event.at;
      break;
    }

    case 'invited': {
      assert(typeof p.ref === 'string' && p.ref.length > 0, '缺少 participant_ref');
      assert(p.group === undefined || p.group === 'undisclosed' || Object.hasOwn(SELF_GROUPS, p.group),
        '登记的人群标签必须为受控词表中的本人自披露类别');
      if (entry) {
        assert(entry.status === 'declined' || entry.status === 'cancelled' || entry.status === 'no_show',
          `参与者 ${p.ref} 已在名单中（状态：${entry.status}），不能重复邀请`);
        Object.assign(entry, rosterEntry(p.ref, p, event.at));
      } else {
        roster.set(p.ref, rosterEntry(p.ref, p, event.at));
      }
      break;
    }

    case 'invitation_declined': {
      assert(entry, '名单中找不到该参与者');
      assert(['invited'].includes(entry.status), '只有已邀请未确认者可标记婉拒');
      entry.status = 'declined';
      break;
    }

    case 'confirm_requested': {
      assert(entry, '名单中找不到该参与者');
      if (entry.status === 'waitlisted') {
        assert(false, '候补者必须经过递补（promoted）才能确认，不能直接占座');
      }
      assert(['invited'].includes(entry.status), `当前状态 ${entry.status} 不能请求确认`);
      if (availableSeats() <= 0) {
        // 不静默拒绝：保留冲突事实，并自动列入候补。
        entry.status = 'waitlisted';
        entry.waitlist_rank = next.waitlist.length + 1;
        next.waitlist.push(p.ref);
        entry.conflicts = entry.conflicts ?? [];
        entry.conflicts.push({
          at: event.at, seats_taken: seatsTaken(),
          note: p.note ?? '确认时无可用席位，已转候补',
        });
      } else {
        entry.status = 'confirmed';
      }
      break;
    }

    case 'seat_conflict':
      // 冲突事实的扁平日志标记；实质状态变化（转候补）已在 confirm_requested 中完成。
      break;

    case 'waitlisted': {
      assert(entry, '名单中找不到该参与者');
      assert(entry.status === 'invited' || entry.status === 'declined', '只有已邀请者可加入候补');
      assert(entry.waitlist_rank == null, '该参与者已在候补名单');
      entry.status = 'waitlisted';
      entry.waitlist_rank = next.waitlist.length + 1;
      next.waitlist.push(p.ref);
      break;
    }

    case 'promoted': {
      const head = next.waitlist
        .map((ref) => roster.get(ref))
        .find((r) => r.status === 'waitlisted');
      assert(head, '候补名单为空，无法递补');
      assert(p.ref === undefined || p.ref === head.participant_ref,
        `候补必须按顺位递补：下一位是 ${head.participant_ref}（第 ${head.waitlist_rank} 顺位）`);
      assert(availableSeats() >= 1, '没有空缺席位可供递补');
      head.status = 'confirmed';
      head.promoted_from_rank = head.waitlist_rank;
      next.waitlist = next.waitlist.filter((ref) => ref !== head.participant_ref);
      if (next.open_vacancies > 0) next.open_vacancies -= 1;
      break;
    }

    case 'cancelled_by_participant': {
      assert(entry, '名单中找不到该参与者');
      assert(['confirmed', 'invited', 'waitlisted'].includes(entry.status),
        `状态 ${entry.status} 不存在可退出的席位`);
      const heldSeat = entry.status === 'confirmed';
      entry.status = 'cancelled';
      entry.cancelled_at = event.at;
      entry.cancel_reason = p.reason ?? null;
      if (entry.waitlist_rank != null) {
        next.waitlist = next.waitlist.filter((ref) => ref !== p.ref);
      }
      if (heldSeat) next.open_vacancies += 1;
      break;
    }

    case 'waitlist_vacancy_unfilled': {
      assert(next.open_vacancies >= 1, '当前没有待填补的空缺');
      next.unfilled = next.unfilled ?? [];
      next.unfilled.push({ at: event.at, reason: p.reason, vacancies: next.open_vacancies });
      next.open_vacancies = 0;
      break;
    }

    case 'no_show_recorded': {
      assert(entry, '名单中找不到该参与者');
      assert(entry.status === 'confirmed', '只有已确认席位者可记为未到场');
      entry.status = 'no_show';
      // 席位事实上空出，登记为待填补空缺（是否还能递补由随后的 promoted/未填补事件说明）。
      next.open_vacancies += 1;
      break;
    }

    case 'attendance_recorded': {
      assert(entry, '名单中找不到该参与者');
      assert(['confirmed'].includes(entry.status), `状态 ${entry.status} 不能登记到场`);
      entry.status = 'attended';
      entry.attended_at = event.at;
      break;
    }

    case 'translation_requested': {
      assert(typeof p.lang === 'string', '缺少 lang');
      const bag = next.translations.get(p.lang) ?? { requested: [], provided: false, provided_at: null };
      if (p.ref) bag.requested.push(p.ref);
      next.translations.set(p.lang, bag);
      break;
    }
    case 'translation_provided': {
      const bag = next.translations.get(p.lang) ?? { requested: [], provided: false, provided_at: null };
      bag.provided = true;
      bag.provided_at = event.at;
      next.translations.set(p.lang, bag);
      break;
    }

    case 'accommodation_requested': {
      assert(typeof p.kind === 'string', '缺少无障碍需求种类');
      const list = next.accommodations.get(p.ref) ?? [];
      list.push({ kind: p.kind, at: event.at, fulfilled: false });
      next.accommodations.set(p.ref, list);
      break;
    }
    case 'accommodation_provided': {
      const list = next.accommodations.get(p.ref);
      assert(list && list[p.index], '找不到对应的无障碍需求记录');
      list[p.index].fulfilled = true;
      list[p.index].fulfilled_at = event.at;
      break;
    }

    case 'consent_contact_withdrawn':
    case 'consent_analysis_withdrawn': {
      assert(entry, '名单中找不到该参与者');
      const scope = event.type === 'consent_contact_withdrawn' ? 'contact' : 'analysis';
      entry.consent[scope] = false;
      entry.consent_history.push({ at: event.at, scope, withdrawn: true, reason: p.reason ?? null });
      break;
    }

    default:
      assert(false, `未实现的事件：${event.type}`);
  }
  return next;
}

function cloneState(state) {
  return {
    ...state,
    reservations: state.reservations.map((r) => ({ ...r })),
    roster: new Map([...state.roster].map(([k, v]) => [k, {
      ...v,
      consent: { ...v.consent },
      consent_history: v.consent_history.map((h) => ({ ...h })),
    }])),
    waitlist: [...state.waitlist],
    translations: new Map([...state.translations].map(([k, v]) => [k, { ...v, requested: [...v.requested] }])),
    accommodations: new Map([...state.accommodations].map(([k, v]) => [k, v.map((a) => ({ ...a }))])),
    unfilled: state.unfilled ? [...state.unfilled] : undefined,
    events: [...state.events],
  };
}

// 便利封装：逐场记录事件的会话对象。
export class OutreachSession {
  constructor(state) {
    this.state = state;
    this._seq = state.events.length;
  }

  record(type, at, by, payload = {}) {
    this._seq += 1;
    const event = { seq: this._seq, session_id: this.state.session_id ?? null, type, at, by: by ?? null, payload };
    const wasWaitlisted = payload.ref != null
      && this.state.roster.get(payload.ref)?.status === 'waitlisted';
    this.state = reduce(this.state, event);
    // 确认请求因席位冲突被转候补时，补登一条扁平的冲突事件，便于审计检索。
    if (type === 'confirm_requested' && !wasWaitlisted
        && this.state.roster.get(payload.ref)?.status === 'waitlisted') {
      this._seq += 1;
      const conflictEvent = {
        seq: this._seq, session_id: this.state.session_id, type: 'seat_conflict', at, by: by ?? null,
        payload: { ref: payload.ref, note: '确认时无可用席位，已转候补' },
      };
      this.state = reduce(this.state, conflictEvent);
    }
    return event;
  }
}

export function snapshot(state) {
  const roster = [...state.roster.values()].map((r) => ({ ...r, consent: { ...r.consent } }));
  const byStatus = {};
  for (const r of roster) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const seatsTaken = roster.filter((r) => r.status === 'confirmed' || r.status === 'attended').length;
  const reserved = state.reservations.filter((r) => r.active).reduce((n, r) => n + r.seats, 0);

  const pendingNeeds = [];
  for (const [lang, bag] of state.translations) {
    if (!bag.provided) pendingNeeds.push({ kind: 'translation', lang, requests: bag.requested.length });
  }
  for (const [ref, list] of state.accommodations) {
    list.forEach((a, index) => {
      if (!a.fulfilled) pendingNeeds.push({ kind: 'accommodation', ref, accommodation: a.kind, index });
    });
  }

  return {
    session_id: state.session_id,
    type: state.type,
    district: state.district,
    target_gap: state.target_gap,
    capacity: state.capacity,
    seats_reserved: reserved,
    seats_taken: seatsTaken,
    seats_available: state.capacity - reserved - seatsTaken,
    open_vacancies: state.open_vacancies,
    waitlist: state.waitlist
      .map((ref) => state.roster.get(ref))
      .filter((r) => r && r.status === 'waitlisted')
      .map((r) => ({ ref: r.participant_ref, rank: r.waitlist_rank, group: r.self_declared_group })),
    roster,
    by_status: byStatus,
    pending_needs: pendingNeeds,
    unfilled_vacancies: state.unfilled ?? [],
    event_count: state.events.length,
    // 立场中立保证：邀请与出席不代表赞成任何政策。
    attendance_implies_endorsement: false,
  };
}
