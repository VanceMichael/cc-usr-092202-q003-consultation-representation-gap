import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, applyEvent, sessionSnapshot, verifyOutreach } from '../src/outreach.js';

function makeSession(overrides = {}) {
  return createSession({
    id: 's1',
    kind: 'community-interview',
    capacity: 1,
    district: '离岛',
    topics: ['housing'],
    targetCohorts: ['public-housing-waitlist'],
    ...overrides,
  });
}

test('席位冲突转入候补，过程完整保留', () => {
  const s = makeSession();
  applyEvent(s, { type: 'invited', participantKey: 'p1' });
  applyEvent(s, { type: 'invited', participantKey: 'p2' });
  applyEvent(s, { type: 'confirmed', participantKey: 'p1' });
  applyEvent(s, { type: 'confirmed', participantKey: 'p2' });

  const snap = sessionSnapshot(s);
  assert.equal(snap.confirmed, 1);
  assert.equal(snap.waitlisted, 1);
  assert.deepEqual(
    s.log.map((e) => e.type),
    ['invited', 'invited', 'confirmed', 'confirmed', 'waitlisted'],
  );
  const waitlisted = s.log.find((e) => e.type === 'waitlisted');
  assert.equal(waitlisted.participantKey, 'p2');
  assert.equal(waitlisted.reason, 'capacity-conflict');
});

test('临时退出释放席位，候补按序转正', () => {
  const s = makeSession();
  applyEvent(s, { type: 'invited', participantKey: 'p1' });
  applyEvent(s, { type: 'invited', participantKey: 'p2' });
  applyEvent(s, { type: 'confirmed', participantKey: 'p1' });
  applyEvent(s, { type: 'confirmed', participantKey: 'p2' });
  applyEvent(s, { type: 'withdrawn', participantKey: 'p1' });

  assert.equal(s.roster.get('p1').status, 'withdrawn');
  assert.equal(s.roster.get('p2').status, 'confirmed');
  const promoted = s.log.find((e) => e.type === 'promoted');
  assert.equal(promoted.participantKey, 'p2');
  assert.equal(promoted.reason, 'seat-freed');
});

test('授权撤回后不计入任何统计，披露特征即不可用，但过程留痕', () => {
  const s = makeSession();
  applyEvent(s, { type: 'invited', participantKey: 'p1', disclosed: { cohorts: ['caregiver'] } });
  applyEvent(s, { type: 'confirmed', participantKey: 'p1' });
  applyEvent(s, { type: 'attended', participantKey: 'p1' });
  applyEvent(s, { type: 'consent-revoked', participantKey: 'p1' });

  const snap = sessionSnapshot(s);
  assert.equal(snap.confirmed, 0);
  assert.equal(snap.attended, 0);
  assert.equal(snap.consentRevoked, 1);
  assert.equal(s.roster.get('p1').disclosed, null);
  assert.deepEqual(
    s.log.map((e) => e.type),
    ['invited', 'confirmed', 'attended', 'consent-revoked'],
  );
});

test('邀请或到场不得携带政策立场', () => {
  const s = makeSession();
  assert.throws(
    () => applyEvent(s, { type: 'invited', participantKey: 'p1', stance: 'support' }),
    /立场/,
  );
  applyEvent(s, { type: 'invited', participantKey: 'p1' });
  applyEvent(s, { type: 'confirmed', participantKey: 'p1' });
  assert.throws(
    () => applyEvent(s, { type: 'attended', participantKey: 'p1', position: 'opposed' }),
    /立场/,
  );
});

test('核对补充触达：填补缺口还是只做大总数', () => {
  const gaps = [
    { dimension: 'district', segment: '离岛', count: 0, minCount: 2 },
    { dimension: 'cohort', segment: 'public-housing-waitlist', count: 2, minCount: 5 },
  ];

  const gapSession = makeSession();
  applyEvent(gapSession, {
    type: 'invited',
    participantKey: 'new-1',
    disclosed: { district: '离岛', cohorts: ['public-housing-waitlist'] },
  });
  applyEvent(gapSession, { type: 'confirmed', participantKey: 'new-1' });
  applyEvent(gapSession, { type: 'attended', participantKey: 'new-1' });

  const busySession = makeSession({ id: 's2', district: '中区', topics: ['youth'], targetCohorts: [] });
  applyEvent(busySession, {
    type: 'invited',
    participantKey: 'new-2',
    disclosed: { district: '中区', cohorts: ['youth'] },
  });
  applyEvent(busySession, { type: 'confirmed', participantKey: 'new-2' });
  applyEvent(busySession, { type: 'attended', participantKey: 'new-2' });

  const [gapReport, busyReport] = verifyOutreach([gapSession, busySession], { gaps });

  assert.equal(gapReport.newVoices, 1);
  assert.ok(
    gapReport.gapsAddressed.some((g) => g.dimension === 'district' && g.segment === '离岛'),
  );
  assert.ok(
    gapReport.gapsAddressed.some(
      (g) => g.dimension === 'cohort' && g.segment === 'public-housing-waitlist',
    ),
  );
  assert.equal(gapReport.onlyInflatesTotal, false);

  assert.equal(busyReport.newVoices, 1);
  assert.equal(busyReport.gapsAddressed.length, 0);
  assert.equal(busyReport.onlyInflatesTotal, true);
});

test('已在既有意见中的参与者不算新声音', () => {
  const s = makeSession();
  applyEvent(s, {
    type: 'invited',
    participantKey: 'anon-a1',
    disclosed: { district: '离岛', cohorts: [] },
  });
  applyEvent(s, { type: 'confirmed', participantKey: 'anon-a1' });
  applyEvent(s, { type: 'attended', participantKey: 'anon-a1' });

  const [report] = verifyOutreach([s], {
    gaps: [{ dimension: 'district', segment: '离岛', count: 0, minCount: 2 }],
    knownSubmitterKeys: ['anon-a1'],
  });
  assert.equal(report.reached, 1);
  assert.equal(report.newVoices, 0);
  assert.equal(report.gapsAddressed.length, 0);
});

test('计划针对却未触达的缺口会被列为 missedTargets', () => {
  const s = makeSession();
  applyEvent(s, {
    type: 'invited',
    participantKey: 'new-1',
    disclosed: { district: '离岛', cohorts: [] },
  });
  applyEvent(s, { type: 'confirmed', participantKey: 'new-1' });
  applyEvent(s, { type: 'attended', participantKey: 'new-1' });

  const [report] = verifyOutreach([s], {
    gaps: [
      { dimension: 'district', segment: '离岛', count: 0, minCount: 2 },
      { dimension: 'cohort', segment: 'public-housing-waitlist', count: 2, minCount: 5 },
    ],
  });
  assert.ok(
    report.missedTargets.some(
      (g) => g.dimension === 'cohort' && g.segment === 'public-housing-waitlist',
    ),
  );
});
