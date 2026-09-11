// TRIM's Fence option: draw a polyline instead of clicking, and everything it
// crosses gets trimmed at the crossing point. Fence reuses the exact same
// calculateTrimOperation/replaceEditedEntity pair a literal click uses (see
// geometry/fence.js), so these tests focus on what only Fence itself can get
// wrong: collecting the fence path, ordering crossings along it, and honoring
// the same preselected-boundary/refusal rules a click already has coverage
// for elsewhere (test-corners.mjs, test-bulges.mjs).
import { boot, DEFAULT_BUNDLE } from './harness.mjs';

const BUNDLE = process.argv[2] || DEFAULT_BUNDLE;

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) { passed++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
function near(a, b, tol = 1e-6) { return Math.abs(a - b) <= tol; }
function pointNear(p, x, y, tol = 1e-6) { return p && near(p.x, x, tol) && near(p.y, y, tol); }

const { api } = boot(BUNDLE);
const P = (x, y) => ({ x, y });

async function reset() {
  await api.newDrawing();
  api.setOrtho(false);
  api.setAllSnapTypes(false);
}
function drawLine(a, b) {
  api.startCommand('LINE');
  api.commitPoint(a);
  api.commitPoint(b);
  api.finishCurrent();
  return api.entities[api.entityCount - 1];
}
function drawCircle(center, radius) {
  api.startCommand('CIRCLE');
  api.commitPoint(center);
  api.commitPoint(P(center.x + radius, center.y));
  return api.entities[api.entityCount - 1];
}
function selectOnly(...ids) {
  api.state.selected.clear();
  ids.forEach(id => api.state.selected.add(id));
}
function entityById(id) { return api.entities.find(e => e.id === id); }
function hasLine(p, q, tol = 1e-6) {
  const matches = (m, n) => pointNear(m, p.x, p.y, tol) && pointNear(n, q.x, q.y, tol);
  return api.entities.some(e => e.type === 'LINE' && (matches(e.a, e.b) || matches(e.b, e.a)));
}
function lineHasEnds(id, p, q, tol = 1e-6) {
  const e = entityById(id);
  if (!e) return false;
  const matches = (m, n) => pointNear(e.a, m.x, m.y, tol) && pointNear(e.b, n.x, n.y, tol);
  return matches(p, q) || matches(q, p);
}
// TRIM/EXTEND hit-test from the raw cursor, not the committed point, so every
// existing suite that drives them sets this first — mirrored here for both
// the actual trim click and each fence point.
function trimClick(p) {
  api.state.mouseScreen = api.worldToScreen(p);
  api.commitPoint(p);
}
const fencePoint = trimClick;
function startFence() {
  api.startCommand('TRIM');
  api.submitCommandText('F');
}

// ---------------------------------------------------------------------------
// Basic single crossing, boundaries drawn as ordinary geometry
// ---------------------------------------------------------------------------

await reset();
{
  const target = drawLine(P(0, 0), P(20, 0));
  const left = drawLine(P(5, -5), P(5, 5));
  const right = drawLine(P(15, -5), P(15, 5));
  startFence();
  check('F enters fence mode', api.promptText.includes('first fence point'), api.promptText);
  fencePoint(P(10, -3));
  fencePoint(P(10, 3));
  api.finishCurrent();
  check('the near piece survives', hasLine(P(0, 0), P(5, 0)));
  check('the far piece survives', hasLine(P(15, 0), P(20, 0)));
  check('boundaries themselves are untouched',
    lineHasEnds(left.id, P(5, -5), P(5, 5)) && lineHasEnds(right.id, P(15, -5), P(15, 5)));
  check('TRIM stays active after a fence pass', api.mode === 'TRIM', api.mode);
}

// ---------------------------------------------------------------------------
// One fence segment crossing two different objects at once
// ---------------------------------------------------------------------------

await reset();
{
  const top = drawLine(P(0, 10), P(20, 10));
  const bottom = drawLine(P(0, 0), P(20, 0));
  const leftBound = drawLine(P(5, -5), P(5, 15));
  const rightBound = drawLine(P(15, -5), P(15, 15));
  startFence();
  fencePoint(P(10, -2));
  fencePoint(P(10, 12));
  api.finishCurrent();
  check('both near pieces survive', hasLine(P(0, 0), P(5, 0)) && hasLine(P(0, 10), P(5, 10)));
  check('both far pieces survive', hasLine(P(15, 0), P(20, 0)) && hasLine(P(15, 10), P(20, 10)));
  check('the boundaries themselves are untouched',
    lineHasEnds(leftBound.id, P(5, -5), P(5, 15)) && lineHasEnds(rightBound.id, P(15, -5), P(15, 15)));
}

// ---------------------------------------------------------------------------
// Multi-segment (zigzag) fence crosses objects on different legs, well apart
// from each other, proving crossings are found and applied per-leg rather
// than only along a single straight pick.
// ---------------------------------------------------------------------------

await reset();
{
  const first = drawLine(P(0, 0), P(0, 20));
  const second = drawLine(P(100, 0), P(100, 20));
  drawLine(P(-3, 5), P(3, 5));
  drawLine(P(-3, 15), P(3, 15));
  drawLine(P(97, 5), P(103, 5));
  drawLine(P(97, 15), P(103, 15));
  startFence();
  fencePoint(P(-2, 10));
  fencePoint(P(2, 10)); // leg 1: crosses `first` at (0, 10)
  fencePoint(P(2, 30));
  fencePoint(P(98, 30)); // legs 2-3: far from both columns, cross nothing
  fencePoint(P(98, 10));
  fencePoint(P(102, 10)); // leg 5: crosses `second` at (100, 10)
  api.finishCurrent();
  check('the first column was cut between its two boundaries',
    hasLine(P(0, 0), P(0, 5)) && hasLine(P(0, 15), P(0, 20)));
  check('the second column was cut between its two boundaries',
    hasLine(P(100, 0), P(100, 5)) && hasLine(P(100, 15), P(100, 20)));
}

// ---------------------------------------------------------------------------
// Preselected boundaries are excluded from trimming, even when the fence
// crosses them too — matching a literal click's own excludedIds rule.
// ---------------------------------------------------------------------------

await reset();
{
  const target = drawLine(P(0, 0), P(20, 0));
  const boundary = drawLine(P(5, -5), P(5, 5));
  const notBoundary = drawLine(P(15, -5), P(15, 5)); // visible, but never preselected
  selectOnly(boundary.id);
  startFence();
  fencePoint(P(10, -3));
  fencePoint(P(10, 3));
  api.finishCurrent();
  check('the preselected boundary is unchanged', lineHasEnds(boundary.id, P(5, -5), P(5, 5)));
  check('the non-preselected line was never a cutting edge, and is untouched',
    lineHasEnds(notBoundary.id, P(15, -5), P(15, 5)));
  // With only the x=5 boundary available, the piece runs from the target's
  // own start up to it; past that there is nothing to stop the cut, so it
  // continues to the target's own end — the same rule a single-boundary
  // click already follows.
  check('the target was cut only against the preselected boundary',
    hasLine(P(0, 0), P(5, 0)) && !hasLine(P(15, 0), P(20, 0)));
  void target;
}

// ---------------------------------------------------------------------------
// A fence that crosses nothing, and a fence that crosses something with no
// cutting boundary, are reported differently and change nothing either way.
// ---------------------------------------------------------------------------

await reset();
{
  drawLine(P(0, 0), P(20, 0));
  const before = JSON.stringify(api.entities);
  startFence();
  fencePoint(P(0, 10));
  fencePoint(P(20, 10)); // parallel to the line, well clear of it
  api.finishCurrent();
  check('a fence crossing nothing says so', /crossed nothing/.test(api.promptText), api.promptText);
  check('nothing changed', JSON.stringify(api.entities) === before);
}

await reset();
{
  drawLine(P(0, 0), P(20, 0)); // no other geometry to cut against
  const before = JSON.stringify(api.entities);
  startFence();
  fencePoint(P(10, -3));
  fencePoint(P(10, 3));
  api.finishCurrent();
  check('a crossing with no cutting boundary is reported as skipped',
    /skipped 1/.test(api.promptText), api.promptText);
  check('nothing changed when the crossing could not be cut', JSON.stringify(api.entities) === before);
}

// ---------------------------------------------------------------------------
// Undo during fence collection, and finishing early
// ---------------------------------------------------------------------------

await reset();
{
  const target = drawLine(P(0, 0), P(20, 0));
  drawLine(P(5, -5), P(5, 5));
  drawLine(P(15, -5), P(15, 5));
  startFence();
  fencePoint(P(3, -3)); // a wrong first point, to be undone
  fencePoint(P(3, 3));
  check('two fence points staged before undo', api.state.currentPoints.length === 2);
  api.undoLastPoint();
  check('undo removed the last fence point', api.state.currentPoints.length === 1);
  check('prompt is back to asking for the next point after undo',
    api.promptText.includes('next fence point'), api.promptText);
  api.undoLastPoint();
  check('undo again empties the fence', api.state.currentPoints.length === 0);
  check('prompt asks for the first point again', api.promptText.includes('first fence point'), api.promptText);
  fencePoint(P(10, -3));
  fencePoint(P(10, 3));
  api.finishCurrent();
  check('the fence still trims correctly after being undone and redrawn',
    hasLine(P(0, 0), P(5, 0)));
}

await reset();
{
  const before = JSON.stringify(api.entities);
  startFence();
  fencePoint(P(0, 0));
  api.finishCurrent();
  check('Enter with only one fence point asks for more rather than trimming',
    /at least two points/.test(api.promptText), api.promptText);
  check('mode is still TRIM', api.mode === 'TRIM', api.mode);
  check('nothing was changed by an incomplete fence', JSON.stringify(api.entities) === before);
}

// ---------------------------------------------------------------------------
// The full "FENCE" keyword works too, not just the "F" abbreviation, and
// typed coordinates work as fence points exactly as they do for PLINE.
// ---------------------------------------------------------------------------

await reset();
{
  const target = drawLine(P(0, 0), P(20, 0));
  drawLine(P(5, -5), P(5, 5));
  drawLine(P(15, -5), P(15, 5));
  api.startCommand('TRIM');
  api.submitCommandText('FENCE');
  check('the full word FENCE also enters fence mode', api.promptText.includes('first fence point'), api.promptText);
  api.submitCommandText('10,-3');
  api.submitCommandText('10,3');
  api.finishCurrent();
  check('FENCE with typed coordinates trimmed the same way F with clicks does',
    hasLine(P(0, 0), P(5, 0)));
}

// ---------------------------------------------------------------------------
// EXTEND does not gain Fence — this is TRIM-only. Since EXTEND defines no
// keyword() hook at all (unlike TRIM), an unclaimed "F" falls through to the
// ordinary command grammar exactly as it always did: F resolves to FILLET,
// but starting a new command while EXTEND is still active is refused, so
// EXTEND is left running and untouched rather than gaining a fence stage.
// ---------------------------------------------------------------------------

await reset();
{
  drawLine(P(0, 0), P(20, 0));
  api.startCommand('EXTEND');
  api.submitCommandText('F');
  check('F during EXTEND is not claimed as a Fence keyword there',
    api.mode === 'EXTEND', api.mode);
  check('EXTEND never stages fence points', api.state.currentPoints.length === 0);
}

// ---------------------------------------------------------------------------
// A circle crossed by a fence, cutting it down to a single ARC — the fence
// starts inside the circle so its one finite segment crosses the boundary
// exactly once, keeping this to the same single-crossing shape as a literal
// click, rather than the more delicate case of two crossings racing each
// other on the same entity (already exercised, for lines, by the two-object
// and zigzag cases above).
// ---------------------------------------------------------------------------

await reset();
{
  const circle = drawCircle(P(0, 0), 5);
  drawLine(P(-10, 0), P(10, 0)); // crosses the circle at angle 0 and pi exactly
  startFence();
  // (0, 1) is inside the circle without sitting on the boundary line drawn
  // through the origin, so this fence crosses only the circle, once.
  fencePoint(P(0, 1));
  fencePoint(P(0, 8)); // crosses the circle's boundary once, at (0, 5)
  api.finishCurrent();
  check('fence trim on a circle reports one trim, no skips',
    api.promptText.includes('trimmed 1.'), api.promptText);
  check('the full circle is gone', !api.entities.some(e => e.id === circle.id && e.type === 'CIRCLE'));
  const arcs = api.entities.filter(e => e.type === 'ARC');
  check('exactly one arc remains from the circle', arcs.length === 1, arcs.length);
  const arc = arcs[0];
  check('the surviving arc keeps the circle\'s radius and centre',
    arc && near(arc.radius, 5) && pointNear(arc.center, 0, 0));
  const withinArc = angle => {
    const TAU = Math.PI * 2;
    let a = angle;
    while (a < arc.startAngle - 1e-6) a += TAU;
    while (a >= arc.startAngle + TAU) a -= TAU;
    return a <= arc.endAngle + 1e-6;
  };
  check('the crossing point (top of the circle) was removed', arc && !withinArc(Math.PI / 2));
  check('the opposite point (bottom of the circle) survived', arc && withinArc(-Math.PI / 2));
  check('the kept arc is a half-circle', arc && near(arc.endAngle - arc.startAngle, Math.PI));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
