// CIRCLE Ttr: a circle of a given radius tangent to two picked objects. Run
// after tools/run-checks.sh — this drives the built bundle.
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
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
// Perpendicular distance from a point to the infinite line through a and b.
function distanceToLine(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / Math.hypot(dx, dy);
}

const { api } = boot(BUNDLE);
const P = (x, y) => ({ x, y });

function reset() {
  api.newDrawing();
  api.setOrtho(false);
  api.setAllSnapTypes(false);
  // Picking objects is done in screen pixels; at the default 1.5px per unit a
  // pick could land on geometry a dozen units away.
  api.state.view.scale = 20;
}
function lastEntity() { return api.entities[api.entityCount - 1]; }
function drawLine(a, b) {
  api.startCommand('LINE');
  api.commitPoint(a);
  api.commitPoint(b);
  api.finishCurrent();
  return lastEntity();
}
function drawCircle(center, radius) {
  api.startCommand('CIRCLE');
  api.commitPoint(center);
  api.commitPoint(P(center.x + radius, center.y));
  return lastEntity();
}
function circles() { return api.entities.filter(e => e.type === 'CIRCLE'); }
// Two circles touch when their centres are exactly the sum of the radii apart
// (outside each other) or the difference (one inside the other). Asserting the
// property rather than a coordinate keeps the check honest about which of the
// several valid answers came back.
function tangentCircles(a, ra, b, rb, tol = 1e-6) {
  const gap = distance(a, b);
  return near(gap, ra + rb, tol) || near(gap, Math.abs(ra - rb), tol);
}
// Pick two objects and give a radius, the way the command is actually driven.
function ttr(first, second, radius, typed = true) {
  api.startCommand('CIRCLE');
  api.submitCommandText('TTR');
  api.state.mouseScreen = api.worldToScreen(first);
  api.commitPoint(first);
  api.state.mouseScreen = api.worldToScreen(second);
  api.commitPoint(second);
  if (typed) api.commitDistance(radius);
  else {
    const target = P(first.x + radius, first.y);
    api.state.mouseScreen = api.worldToScreen(target);
    api.commitPoint(target);
  }
  return circles()[circles().length - 1];
}

// ---------------------------------------------------------------------------
// The command's own stages
// ---------------------------------------------------------------------------

reset();
{
  drawLine(P(0, 0), P(10, 0));
  drawLine(P(0, 0), P(0, 10));
  api.startCommand('CIRCLE');
  check('CIRCLE offers Ttr alongside 2P and 3P', /\[2P\/3P\/Ttr\]/.test(api.promptText), api.promptText);
  api.submitCommandText('TTR');
  check('Ttr switches method', api.circleMethod === 'TTR', api.circleMethod);
  check('Ttr asks for the first object', /point on object for first tangent/.test(api.promptText), api.promptText);
  api.state.mouseScreen = api.worldToScreen(P(5, 0));
  api.commitPoint(P(5, 0));
  check('Ttr asks for the second object', /second tangent/.test(api.promptText), api.promptText);
  check('Ttr is still waiting, not drawing', circles().length === 0);
  api.state.mouseScreen = api.worldToScreen(P(0, 5));
  api.commitPoint(P(0, 5));
  check('Ttr then asks for the radius', /Specify radius of circle/.test(api.promptText), api.promptText);
  check('Ttr previews once it has both objects', api.commandCapabilities?.previewReady === true);
  api.commitDistance(2);
  check('Ttr draws the circle', circles().length === 1, `${circles().length}`);
  check('Ttr returns to SELECT', api.mode === 'SELECT', api.mode);
}

// Ttr can only be chosen before a centre has been given, and a number before
// the radius stage is not silently taken as one.
reset();
{
  api.startCommand('CIRCLE');
  api.commitPoint(P(0, 0));
  api.submitCommandText('TTR');
  check('Ttr is refused once a centre exists', /before specifying the center point/.test(api.promptText),
    api.promptText);
}
reset();
{
  drawLine(P(0, 0), P(10, 0));
  api.startCommand('CIRCLE');
  api.submitCommandText('TTR');
  api.commitDistance(5);
  check('a number before the objects says what is wanted instead',
    /Pick an object to be tangent to/.test(api.promptText), api.promptText);
  check('and draws nothing', circles().length === 0);
}
reset();
{
  api.startCommand('CIRCLE');
  api.submitCommandText('TTR');
  api.state.mouseScreen = api.worldToScreen(P(50, 50));
  api.commitPoint(P(50, 50));
  check('clicking empty space says so', /No object there/.test(api.promptText), api.promptText);
}
reset();
{
  const line = drawLine(P(0, 0), P(10, 0));
  api.startCommand('CIRCLE');
  api.submitCommandText('TTR');
  api.state.mouseScreen = api.worldToScreen(P(3, 0));
  api.commitPoint(P(3, 0));
  api.state.mouseScreen = api.worldToScreen(P(7, 0));
  api.commitPoint(P(7, 0));
  check('picking the same object twice is refused', /second, different object/.test(api.promptText),
    api.promptText);
  void line;
}

// ---------------------------------------------------------------------------
// Two lines
// ---------------------------------------------------------------------------

// The everyday case: the circle that fits into the corner two lines make.
reset();
{
  drawLine(P(0, 0), P(10, 0));
  drawLine(P(0, 0), P(0, 10));
  const circle = ttr(P(4, 0), P(0, 4), 2);
  check('a circle in a right-angled corner sits a radius from each line',
    circle && pointNear(circle.center, 2, 2) && near(circle.radius, 2), JSON.stringify(circle));
}

// Which side of each line was clicked decides which of the four corners the
// circle goes in — the same rule a person uses to answer the question.
reset();
{
  drawLine(P(-10, 0), P(10, 0));
  drawLine(P(0, -10), P(0, 10));
  const circle = ttr(P(-4, 0), P(0, -4), 3);
  check('picking the other side puts the circle in the other quadrant',
    circle && pointNear(circle.center, -3, -3) && near(circle.radius, 3), JSON.stringify(circle));
}

// The lines need not actually reach the corner: a circle tangent to where two
// walls would have met is a real construction, so the extension is used when
// nothing on the drawn segments fits.
reset();
{
  const first = drawLine(P(6, 0), P(20, 0));
  const second = drawLine(P(0, 6), P(0, 20));
  const circle = ttr(P(8, 0), P(0, 8), 2);
  check('a circle can be tangent to the extensions of two lines',
    circle && pointNear(circle.center, 2, 2) && near(circle.radius, 2), JSON.stringify(circle));
  check('and is tangent to both of them',
    circle && near(distanceToLine(circle.center, first.a, first.b), 2) &&
    near(distanceToLine(circle.center, second.a, second.b), 2));
}

// Parallel lines have no corner, so there is nothing of the given radius to
// find and the command says so rather than drawing something plausible.
reset();
{
  drawLine(P(0, 0), P(10, 0));
  drawLine(P(0, 5), P(10, 5));
  api.startCommand('CIRCLE');
  api.submitCommandText('TTR');
  api.state.mouseScreen = api.worldToScreen(P(5, 0));
  api.commitPoint(P(5, 0));
  api.state.mouseScreen = api.worldToScreen(P(5, 5));
  api.commitPoint(P(5, 5));
  api.commitDistance(1);
  check('parallel lines with the wrong radius are refused by name',
    /No circle of that radius is tangent/.test(api.promptText), api.promptText);
  check('and nothing is drawn', circles().length === 0);
}

// A radius of zero has no circle to be tangent with.
reset();
{
  drawLine(P(0, 0), P(10, 0));
  drawLine(P(0, 0), P(0, 10));
  api.startCommand('CIRCLE');
  api.submitCommandText('TTR');
  api.state.mouseScreen = api.worldToScreen(P(4, 0));
  api.commitPoint(P(4, 0));
  api.state.mouseScreen = api.worldToScreen(P(0, 4));
  api.commitPoint(P(0, 4));
  api.commitDistance(0);
  check('a zero radius is refused', /Radius must be greater than zero/.test(api.promptText), api.promptText);
  check('and draws nothing', circles().length === 0);
}

// ---------------------------------------------------------------------------
// A line and a circle
// ---------------------------------------------------------------------------

reset();
{
  const line = drawLine(P(-20, 0), P(20, 0));
  const target = drawCircle(P(0, 10), 4);
  // Picked on the underside of the circle and on the line beneath it: the
  // answer sits between the two, touching both from outside.
  const circle = ttr(P(0, 0), P(0, 6), 3);
  check('a circle tangent to a line and a circle clears the line by its radius',
    near(distanceToLine(circle.center, line.a, line.b), 3), String(circle && circle.radius));
  check('and touches the other circle externally',
    near(distance(circle.center, target.center), target.radius + 3),
    String(distance(circle.center, target.center)));
  check('and it is a third circle, not a change to either', api.entityCount === 3, `count ${api.entityCount}`);
}

// Picking the far side of the same circle asks for the other answer: one that
// swallows nothing but sits beyond it.
reset();
{
  const line = drawLine(P(-20, 0), P(20, 0));
  const target = drawCircle(P(0, 10), 4);
  const circle = ttr(P(0, 0), P(0, 14), 9);
  check('picking the far side still gives a circle tangent to both',
    circle && near(distanceToLine(circle.center, line.a, line.b), 9) &&
    tangentCircles(circle.center, 9, target.center, target.radius),
    circle && JSON.stringify({ center: circle.center, gap: distance(circle.center, target.center) }));
  check('and it is a different answer from the corner between them',
    circle && !pointNear(circle.center, 0, 9), circle && JSON.stringify(circle.center));
}

// A radius too small to bridge the gap has no solution at all.
reset();
{
  drawLine(P(-20, 0), P(20, 0));
  drawCircle(P(0, 20), 2);
  api.startCommand('CIRCLE');
  api.submitCommandText('TTR');
  api.state.mouseScreen = api.worldToScreen(P(0, 0));
  api.commitPoint(P(0, 0));
  api.state.mouseScreen = api.worldToScreen(P(0, 18));
  api.commitPoint(P(0, 18));
  api.commitDistance(3);
  check('a radius too small to reach is refused',
    /No circle of that radius is tangent/.test(api.promptText), api.promptText);
  check('and draws nothing', circles().length === 1, `${circles().length}`);
}

// ---------------------------------------------------------------------------
// Two circles
// ---------------------------------------------------------------------------

reset();
{
  const left = drawCircle(P(0, 0), 3);
  const right = drawCircle(P(20, 0), 3);
  // Picked on the facing sides, so the answer bridges the gap between them.
  const circle = ttr(P(3, 0), P(17, 0), 8);
  check('a circle tangent to two circles touches both externally',
    circle && near(distance(circle.center, left.center), 3 + 8) &&
    near(distance(circle.center, right.center), 3 + 8),
    JSON.stringify({ l: distance(circle.center, left.center), r: distance(circle.center, right.center) }));
  check('and sits between them', circle && near(circle.center.x, 10), circle && JSON.stringify(circle.center));
}

// A circle large enough to wrap around both is the internally tangent answer,
// and picking the far sides is how it is asked for.
reset();
{
  const left = drawCircle(P(0, 0), 3);
  const right = drawCircle(P(20, 0), 3);
  const circle = ttr(P(-3, 0), P(23, 0), 16);
  check('picking the far sides gives the circle that wraps both',
    circle && near(distance(circle.center, left.center), 16 - 3, 1e-6) &&
    near(distance(circle.center, right.center), 16 - 3, 1e-6),
    JSON.stringify({ l: distance(circle.center, left.center), r: distance(circle.center, right.center) }));
}

// ---------------------------------------------------------------------------
// An arc, and a polyline segment
// ---------------------------------------------------------------------------

reset();
{
  const line = drawLine(P(-20, 0), P(20, 0));
  api.startCommand('ARC');
  api.commitPoint(P(-5, 10));
  api.commitPoint(P(0, 6));
  api.commitPoint(P(5, 10));
  const arc = lastEntity();
  // The arc dips to y = 6, so a radius of 3 is exactly what bridges the gap.
  const circle = ttr(P(0, 0), P(0, 6), 3);
  check('a circle tangent to a line and an arc clears the line',
    circle && near(distanceToLine(circle.center, line.a, line.b), 3), JSON.stringify(circle));
  check('and touches the arc',
    circle && tangentCircles(circle.center, 3, arc.center, arc.radius),
    circle && String(distance(circle.center, arc.center)));
  check('and lands squarely between them', circle && pointNear(circle.center, 0, 3),
    circle && JSON.stringify(circle.center));
}

reset();
{
  api.addPolyline([P(0, 10), P(0, 0), P(10, 0)], false);
  api.startCommand('CIRCLE');
  api.submitCommandText('TTR');
  api.state.mouseScreen = api.worldToScreen(P(0, 5));
  api.commitPoint(P(0, 5));
  api.state.mouseScreen = api.worldToScreen(P(5, 0));
  api.commitPoint(P(5, 0));
  api.commitDistance(2);
  const circle = circles()[0];
  check('two segments of one polyline can be the two tangents',
    circle && pointNear(circle.center, 2, 2) && near(circle.radius, 2), JSON.stringify(circle));
}

// A curved polyline segment has a centre and radius edgeRef does not carry, so
// it is refused by name rather than measured off its chord.
reset();
{
  api.addPolyline([P(0, 0), P(10, 0), P(10, 10)], false, [Math.tan(Math.PI / 8), 0, 0]);
  api.startCommand('CIRCLE');
  api.submitCommandText('TTR');
  const arc = api.entitySegments(api.entities[0])[0][2];
  const onArc = P(
    arc.center.x + arc.radius * Math.cos((arc.startAngle + arc.endAngle) / 2),
    arc.center.y + arc.radius * Math.sin((arc.startAngle + arc.endAngle) / 2),
  );
  api.state.mouseScreen = api.worldToScreen(onArc);
  api.commitPoint(onArc);
  check('a curved polyline segment is refused by name',
    /segment is curved/.test(api.promptText), api.promptText);
  check('and nothing is drawn', circles().length === 0);
}

// ---------------------------------------------------------------------------
// Picking the radius instead of typing it
// ---------------------------------------------------------------------------

reset();
{
  drawLine(P(0, 0), P(10, 0));
  drawLine(P(0, 0), P(0, 10));
  const circle = ttr(P(4, 0), P(0, 4), 2, false);
  check('the radius can be picked as a length from the first tangent point',
    circle && pointNear(circle.center, 2, 2) && near(circle.radius, 2), JSON.stringify(circle));
}

// ---------------------------------------------------------------------------
// The result is an ordinary circle
// ---------------------------------------------------------------------------

reset();
{
  drawLine(P(0, 0), P(10, 0));
  drawLine(P(0, 0), P(0, 10));
  const circle = ttr(P(4, 0), P(0, 4), 2);
  check('the tangent circle is on the current layer', circle?.layerId === api.currentLayerId);
  check('the tangent circle survives a save and reload', (() => {
    const text = api.exportDocumentText();
    api.newDrawing();
    api.importDocumentText(text);
    const reloaded = circles()[0];
    return reloaded && pointNear(reloaded.center, 2, 2) && near(reloaded.radius, 2);
  })());
}

reset();
{
  drawLine(P(0, 0), P(10, 0));
  drawLine(P(0, 0), P(0, 10));
  ttr(P(4, 0), P(0, 4), 2);
  api.undo();
  check('undo removes the tangent circle in one step', circles().length === 0, `${circles().length}`);
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('FAILURES:');
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exit(1);
}
