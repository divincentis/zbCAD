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

function reset() {
  api.newDrawing();
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
function entityById(id) { return api.entities.find(e => e.id === id); }
function lineById(id) { const e = entityById(id); return e ? [e.a, e.b] : null; }
// A line's endpoints in whichever order, so a test asserts geometry rather
// than which end the model happens to store first.
function lineHasEnds(id, p, q, tol = 1e-6) {
  const e = entityById(id);
  if (!e) return false;
  const matches = (m, n) => pointNear(e.a, m.x, m.y, tol) && pointNear(e.b, n.x, n.y, tol);
  return matches(p, q) || matches(q, p);
}
function arcs() { return api.entities.filter(e => e.type === 'ARC'); }
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function arcPointAt(arc, t) {
  const angle = arc.startAngle + (arc.endAngle - arc.startAngle) * t;
  return P(arc.center.x + arc.radius * Math.cos(angle), arc.center.y + arc.radius * Math.sin(angle));
}
// Perpendicular distance from a point to the infinite line through a and b.
function distanceToLine(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / Math.hypot(dx, dy);
}

function startFillet(radius) {
  api.startCommand('FILLET');
  api.submitCommandText('R');
  api.commitDistance(radius);
}
function startChamfer(first, second) {
  api.startCommand('CHAMFER');
  api.submitCommandText('D');
  api.commitDistance(first);
  api.commitDistance(second);
}

// ---------------------------------------------------------------------------
// FILLET
// ---------------------------------------------------------------------------

// Radius 0 is the everyday corner cleanup: two edges that stop short are
// extended until they meet, and no arc is created.
reset();
{
  const h = drawLine(P(2, 0), P(10, 0));
  const v = drawLine(P(0, 2), P(0, 10));
  startFillet(0);
  check('FILLET starts by asking for the first line', api.operationStage === 'FIRST', api.operationStage);
  api.commitPoint(P(6, 0));
  check('FILLET asks for the second line after the first pick', api.operationStage === 'SECOND', api.operationStage);
  api.commitPoint(P(0, 6));

  check('FILLET 0 creates no arc', arcs().length === 0, `${arcs().length} arcs`);
  check('FILLET 0 extends the first line to the corner',
    lineHasEnds(h.id, P(10, 0), P(0, 0)), JSON.stringify(lineById(h.id)));
  check('FILLET 0 extends the second line to the corner',
    lineHasEnds(v.id, P(0, 10), P(0, 0)), JSON.stringify(lineById(v.id)));
  check('FILLET returns to the first line for the next corner',
    api.operationStage === 'FIRST', api.operationStage);
  check('FILLET stays open to keep cleaning corners', api.commandInProgress());
}

// A right-angle corner at a known radius, checked against the tangency the
// fillet is supposed to produce rather than against precomputed numbers alone.
reset();
{
  const h = drawLine(P(0, 0), P(10, 0));
  const v = drawLine(P(0, 0), P(0, 10));
  startFillet(2);
  api.commitPoint(P(6, 0));
  api.commitPoint(P(0, 6));

  check('FILLET creates exactly one arc', arcs().length === 1, `${arcs().length} arcs`);
  const arc = arcs()[0];
  check('the fillet arc has the requested radius', near(arc.radius, 2), String(arc?.radius));
  check('the fillet arc is centred on the bisector', pointNear(arc.center, 2, 2), JSON.stringify(arc.center));
  check('FILLET trims the first line back to the tangent point',
    lineHasEnds(h.id, P(10, 0), P(2, 0)), JSON.stringify(lineById(h.id)));
  check('FILLET trims the second line back to the tangent point',
    lineHasEnds(v.id, P(0, 10), P(0, 2)), JSON.stringify(lineById(v.id)));

  // Tangency is the property that actually matters: the centre must sit one
  // radius from both edges, and the arc must end exactly on them.
  check('the arc centre is one radius from the first edge',
    near(distanceToLine(arc.center, P(10, 0), P(2, 0)), 2));
  check('the arc centre is one radius from the second edge',
    near(distanceToLine(arc.center, P(0, 10), P(0, 2)), 2));
  const ends = [arcPointAt(arc, 0), arcPointAt(arc, 1)];
  check('the arc ends on the two tangent points',
    ends.some(p => pointNear(p, 2, 0)) && ends.some(p => pointNear(p, 0, 2)),
    JSON.stringify(ends));
  check('the fillet takes the short way round, bulging towards the corner',
    near(Math.abs(arc.endAngle - arc.startAngle), Math.PI / 2),
    String(arc.endAngle - arc.startAngle));
  const mid = arcPointAt(arc, 0.5);
  check('the arc midpoint lies inside the corner',
    mid.x > 0 && mid.y > 0 && mid.x < 2 && mid.y < 2, JSON.stringify(mid));
  check('the arc midpoint is one radius from the centre', near(distance(mid, arc.center), 2));
}

// The pick points choose which side of each crossing survives.
reset();
{
  const h = drawLine(P(-10, 0), P(10, 0));
  const v = drawLine(P(0, -10), P(0, 10));
  startFillet(0);
  api.commitPoint(P(-6, 0)); // keep the left half
  api.commitPoint(P(0, -6)); // keep the lower half
  check('FILLET keeps the picked half of the first line',
    lineHasEnds(h.id, P(-10, 0), P(0, 0)), JSON.stringify(lineById(h.id)));
  check('FILLET keeps the picked half of the second line',
    lineHasEnds(v.id, P(0, -10), P(0, 0)), JSON.stringify(lineById(v.id)));
}

reset();
{
  const h = drawLine(P(-10, 0), P(10, 0));
  const v = drawLine(P(0, -10), P(0, 10));
  startFillet(0);
  api.commitPoint(P(6, 0)); // the opposite picks keep the opposite halves
  api.commitPoint(P(0, 6));
  check('the opposite picks keep the opposite half of the first line',
    lineHasEnds(h.id, P(10, 0), P(0, 0)), JSON.stringify(lineById(h.id)));
  check('the opposite picks keep the opposite half of the second line',
    lineHasEnds(v.id, P(0, 10), P(0, 0)), JSON.stringify(lineById(v.id)));
}

// A corner that is not a right angle: the tangent setback is r/tan(θ/2), so a
// formula that only ever gets tested at 90° would slip through.
reset();
{
  const a = drawLine(P(0, 0), P(10, 0));
  // 60° from the first edge.
  const b = drawLine(P(0, 0), P(10 * Math.cos(Math.PI / 3), 10 * Math.sin(Math.PI / 3)));
  const radius = 1.5;
  startFillet(radius);
  api.commitPoint(P(6, 0));
  api.commitPoint(P(6 * Math.cos(Math.PI / 3), 6 * Math.sin(Math.PI / 3)));

  const arc = arcs()[0];
  check('a 60° corner produces one arc', arcs().length === 1, `${arcs().length} arcs`);
  const expectedSetback = radius / Math.tan(Math.PI / 6);
  check('the tangent setback follows r/tan(θ/2)',
    lineHasEnds(a.id, P(10, 0), P(expectedSetback, 0), 1e-6),
    `${JSON.stringify(lineById(a.id))} expected setback ${expectedSetback}`);
  check('the 60° arc is still tangent to the first edge',
    near(distanceToLine(arc.center, P(0, 0), P(10, 0)), radius, 1e-9));
  check('the 60° arc is still tangent to the second edge',
    near(distanceToLine(arc.center, P(0, 0), P(Math.cos(Math.PI / 3), Math.sin(Math.PI / 3))), radius, 1e-9));
  check('the 60° fillet sweeps the supplement of the corner',
    near(Math.abs(arc.endAngle - arc.startAngle), Math.PI - Math.PI / 3, 1e-9),
    String(arc.endAngle - arc.startAngle));
}

// Refusals must leave the drawing exactly as it was.
reset();
{
  drawLine(P(0, 0), P(10, 0));
  drawLine(P(0, 0), P(0, 10));
  const before = JSON.stringify(api.entities);
  startFillet(15); // far larger than either edge
  api.commitPoint(P(6, 0));
  api.commitPoint(P(0, 6));
  check('FILLET refuses a radius larger than the lines', /too large/.test(api.promptText), api.promptText);
  check('a refused fillet changes nothing', JSON.stringify(api.entities) === before);
  check('a refused fillet returns to the first line', api.operationStage === 'FIRST', api.operationStage);
}

reset();
{
  drawLine(P(0, 0), P(10, 0));
  drawLine(P(0, 5), P(10, 5));
  const before = JSON.stringify(api.entities);
  startFillet(1);
  api.commitPoint(P(6, 0));
  api.commitPoint(P(6, 5));
  check('FILLET refuses parallel lines', /parallel/.test(api.promptText), api.promptText);
  check('a parallel refusal changes nothing', JSON.stringify(api.entities) === before);
}

reset();
{
  drawLine(P(0, 0), P(10, 0));
  api.startCommand('CIRCLE');
  api.commitPoint(P(20, 0));
  api.commitPoint(P(23, 0));
  const before = JSON.stringify(api.entities);
  startFillet(1);
  api.commitPoint(P(23, 0)); // on the circle
  check('FILLET names the unsupported type rather than ignoring the click',
    /CIRCLE/.test(api.promptText), api.promptText);
  check('FILLET is still waiting for a first line', api.operationStage === 'FIRST', api.operationStage);
  check('an unsupported pick changes nothing', JSON.stringify(api.entities) === before);
}

reset();
{
  drawLine(P(0, 0), P(10, 0));
  startFillet(1);
  api.commitPoint(P(6, 0));
  api.commitPoint(P(4, 0)); // the same line again
  check('FILLET refuses the same line twice', /different line/.test(api.promptText), api.promptText);
  check('FILLET still wants a second line', api.operationStage === 'SECOND', api.operationStage);
}

reset();
{
  drawLine(P(0, 0), P(10, 0));
  drawLine(P(0, 0), P(0, 10));
  startFillet(1);
  api.commitPoint(P(50, 50)); // empty space
  check('FILLET reports an empty pick', /No line there/.test(api.promptText), api.promptText);
}

// Undo has to take the whole fillet back in one step, arc included.
reset();
{
  const h = drawLine(P(0, 0), P(10, 0));
  drawLine(P(0, 0), P(0, 10));
  const before = JSON.stringify(api.entities);
  startFillet(2);
  api.commitPoint(P(6, 0));
  api.commitPoint(P(0, 6));
  check('the fillet added the arc', api.entityCount === 3, `count ${api.entityCount}`);
  api.undo();
  check('undo removes the arc and restores both lines in one step',
    JSON.stringify(api.entities) === before,
    `${api.entityCount} entities: ${JSON.stringify(api.entities)}`);
  check('undo restored the first line', lineHasEnds(h.id, P(0, 0), P(10, 0)));
}

// The radius is remembered between invocations, the way CAD settings are.
reset();
{
  drawLine(P(0, 0), P(10, 0));
  drawLine(P(0, 0), P(0, 10));
  startFillet(3);
  api.finishCurrent();
  api.startCommand('FILLET');
  check('FILLET remembers the last radius', /radius/.test(api.promptText), api.promptText);
  api.commitPoint(P(6, 0));
  api.commitPoint(P(0, 6));
  check('the remembered radius is used', near(arcs()[0]?.radius, 3), String(arcs()[0]?.radius));
}

// Enter ends the command.
reset();
{
  drawLine(P(0, 0), P(10, 0));
  api.startCommand('FILLET');
  api.finishCurrent();
  check('Enter ends FILLET', !api.commandInProgress());
}

// Esc must never commit.
reset();
{
  drawLine(P(0, 0), P(10, 0));
  drawLine(P(0, 0), P(0, 10));
  const before = JSON.stringify(api.entities);
  startFillet(2);
  api.commitPoint(P(6, 0));
  api.cancelCurrent();
  check('Esc abandons a half-picked fillet', JSON.stringify(api.entities) === before);
  check('Esc leaves no command running', !api.commandInProgress());
}

// A fillet arc has to survive save and reopen.
reset();
{
  drawLine(P(0, 0), P(10, 0));
  drawLine(P(0, 0), P(0, 10));
  startFillet(2);
  api.commitPoint(P(6, 0));
  api.commitPoint(P(0, 6));
  api.finishCurrent();
  const before = api.entities;
  const text = api.exportDocumentText();
  api.newDrawing();
  api.importDocumentText(text);
  check('a filleted corner round-trips through the native format',
    JSON.stringify(api.entities) === JSON.stringify(before));
}

// ---------------------------------------------------------------------------
// CHAMFER
// ---------------------------------------------------------------------------
reset();
{
  const h = drawLine(P(0, 0), P(10, 0));
  const v = drawLine(P(0, 0), P(0, 10));
  startChamfer(2, 2);
  api.commitPoint(P(6, 0));
  api.commitPoint(P(0, 6));

  const cuts = api.entities.filter(e => e.type === 'LINE' && e.id !== h.id && e.id !== v.id);
  check('CHAMFER adds one cut line', cuts.length === 1, `${cuts.length} cuts`);
  check('CHAMFER sets the first edge back by the first distance',
    lineHasEnds(h.id, P(10, 0), P(2, 0)), JSON.stringify(lineById(h.id)));
  check('CHAMFER sets the second edge back by the second distance',
    lineHasEnds(v.id, P(0, 10), P(0, 2)), JSON.stringify(lineById(v.id)));
  const cut = cuts[0];
  const cutEnds = [cut.a, cut.b];
  check('the cut spans the two setback points',
    cutEnds.some(p => pointNear(p, 2, 0)) && cutEnds.some(p => pointNear(p, 0, 2)),
    JSON.stringify(cutEnds));
}

// Unequal distances, so a chamfer that quietly uses one distance twice fails.
reset();
{
  const h = drawLine(P(0, 0), P(10, 0));
  const v = drawLine(P(0, 0), P(0, 10));
  startChamfer(1, 4);
  api.commitPoint(P(6, 0));
  api.commitPoint(P(0, 6));
  check('CHAMFER uses the first distance on the first-picked edge',
    lineHasEnds(h.id, P(10, 0), P(1, 0)), JSON.stringify(lineById(h.id)));
  check('CHAMFER uses the second distance on the second-picked edge',
    lineHasEnds(v.id, P(0, 10), P(0, 4)), JSON.stringify(lineById(v.id)));
}

// The second distance follows the first until it is given, so an equal-sided
// chamfer is a single answer.
reset();
{
  const h = drawLine(P(0, 0), P(10, 0));
  const v = drawLine(P(0, 0), P(0, 10));
  api.startCommand('CHAMFER');
  api.submitCommandText('D');
  api.commitDistance(3);
  api.finishCurrent(); // accept the mirrored second distance and leave
  api.startCommand('CHAMFER');
  api.commitPoint(P(6, 0));
  api.commitPoint(P(0, 6));
  check('the second chamfer distance defaults to the first',
    lineHasEnds(h.id, P(10, 0), P(3, 0)) && lineHasEnds(v.id, P(0, 10), P(0, 3)),
    `${JSON.stringify(lineById(h.id))} ${JSON.stringify(lineById(v.id))}`);
}

// Zero distances are a corner close with nothing to draw between them.
reset();
{
  const h = drawLine(P(2, 0), P(10, 0));
  const v = drawLine(P(0, 2), P(0, 10));
  startChamfer(0, 0);
  api.commitPoint(P(6, 0));
  api.commitPoint(P(0, 6));
  check('CHAMFER 0 adds no cut line', api.entityCount === 2, `count ${api.entityCount}`);
  check('CHAMFER 0 closes the corner exactly',
    lineHasEnds(h.id, P(10, 0), P(0, 0)) && lineHasEnds(v.id, P(0, 10), P(0, 0)),
    `${JSON.stringify(lineById(h.id))} ${JSON.stringify(lineById(v.id))}`);
}

reset();
{
  drawLine(P(0, 0), P(10, 0));
  drawLine(P(0, 0), P(0, 10));
  const before = JSON.stringify(api.entities);
  startChamfer(20, 20);
  api.commitPoint(P(6, 0));
  api.commitPoint(P(0, 6));
  check('CHAMFER refuses distances larger than the lines', /too large/.test(api.promptText), api.promptText);
  check('a refused chamfer changes nothing', JSON.stringify(api.entities) === before);
}

// A negative setting is the one value neither command accepts.
reset();
{
  api.startCommand('FILLET');
  api.submitCommandText('R');
  api.commitDistance(-1);
  check('FILLET refuses a negative radius', /cannot be negative/.test(api.promptText), api.promptText);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
