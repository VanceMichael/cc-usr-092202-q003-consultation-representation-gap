import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildCoverageMap } from '../src/coverage.js';
import { buildPublicMethodology, buildStaffReport } from '../src/publishing.js';
import { createSession, applyEvent, verifyOutreach } from '../src/outreach.js';

async function loadCoverage() {
  const records = JSON.parse(await readFile(new URL('../fixtures/submissions.sample.json', import.meta.url), 'utf8'));
  const targets = JSON.parse(await readFile(new URL('../fixtures/targets.sample.json', import.meta.url), 'utf8'));
  return buildCoverageMap(records, targets);
}

test('公开口径抑制小格子，只给区间与不确定性', async () => {
  const coverage = await loadCoverage();
  const pub = buildPublicMethodology(coverage, { threshold: 5 });

  assert.deepEqual(pub.byCohort['public-housing-waitlist'], { suppressed: true, range: '<5' });
  assert.deepEqual(pub.byChannel.online, { suppressed: false, range: '5–9' });
  assert.equal(pub.totals.effectiveVoices, '10–14');

  // 公开文本中不出现任何精确计数或缺口差额。
  const serialized = JSON.stringify(pub);
  assert.ok(!serialized.includes('"count"'));
  assert.ok(!serialized.includes('"shortfall"'));
});

test('公开说明交代统计口径与匿名门槛', async () => {
  const pub = buildPublicMethodology(await loadCoverage());
  assert.equal(pub.anonymityThreshold, 5);
  assert.ok(pub.notes.some((n) => n.includes('联署')));
  assert.ok(pub.notes.some((n) => n.includes('推断')));
  assert.ok(pub.gaps.every((g) => g.status === 'absent' || g.status === 'below-target'));
});

test('内部视图保留精确值，并逐场核对缺口填补', async () => {
  const coverage = await loadCoverage();

  const s = createSession({
    id: 's1',
    kind: 'accessible-session',
    capacity: 5,
    district: '离岛',
    topics: ['housing'],
    targetCohorts: ['public-housing-waitlist'],
  });
  applyEvent(s, {
    type: 'invited',
    participantKey: 'n1',
    disclosed: { district: '离岛', cohorts: ['public-housing-waitlist'] },
  });
  applyEvent(s, { type: 'confirmed', participantKey: 'n1' });
  applyEvent(s, { type: 'attended', participantKey: 'n1' });

  const verification = verifyOutreach([s], { gaps: coverage.gaps });
  const staff = buildStaffReport(coverage, verification);

  assert.equal(staff.audience, 'internal');
  assert.equal(staff.totals.effectiveVoices, 10);
  assert.equal(staff.cells.cohort['public-housing-waitlist'], 2);
  assert.ok(staff.gaps.some((g) => g.segment === '离岛' && g.absent));
  assert.ok(
    staff.outreach[0].gapsAddressed.some(
      (g) => g.dimension === 'district' && g.segment === '离岛',
    ),
  );
});
