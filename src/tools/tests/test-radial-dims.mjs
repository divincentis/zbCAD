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
function drawCircle(center, radius) {
  api.startCommand('CIRCLE');
  api.commitPoint(center);
  api.commitPoint(P(center.x + radius, center.y));
  return api.entities[api.entityCount - 1];
}
function drawArc(a, b, c) {
  api.startCommand('ARC');
  api.commitPoint(a);
  api.commitPoint(b);
  api.commitPoint(c);
  return api.entities[api.entityCount - 1];
}
function drawLine(a, b) {
  api.startCommand('LINE');
  api.commitPoint(a);
  api.commitPoint(b);
  api.finishCurrent();
  return api.entities[api.entityCount - 1];
}
function entityById(id) { return api.entities.find(e => e.id === id); }
function lastDim() { return [...api.entities].reverse().find(e => e.type === 'DIM'); }
function measureOf(dim) { return api.dimensionGeometry(dim).measure; }

// ---------------------------------------------------------------------------
// DIMRADIUS
// ---------------------------------------------------------------------------
await reset();
{
  const circle = drawCircle(P(0, 0), 5);
  api.startCommand('DIMRADIUS');
  check('DIMRADIUS asks for a circle or arc', /circle or arc/.test(api.promptText), api.promptText);
  api.commitPoint(P(5, 0)); // on the circle
  check('DIMRADIUS asks where the dimension line goes',
    /dimension line location/.test(api.promptText), api.promptText);
  api.commitPoint(P(3, 0)); // place the text along the +x radius

  const dim = lastDim();
  check('DIMRADIUS creates a dimension', Boolean(dim));
  check('DIMRADIUS records its type', dim.dimType === 'RADIUS', dim.dimType);
  check('DIMRADIUS measures the radius', near(measureOf(dim), 5), String(measureOf(dim)));
  check('DIMRADIUS text is prefixed with R', /^R /.test(api.dimensionText(dim)), api.dimensionText(dim));
  check('DIMRADIUS runs from the centre to the curve',
    pointNear(dim.p1, 0, 0) && pointNear(dim.p2, 5, 0),
    `${JSON.stringify(dim.p1)} ${JSON.stringify(dim.p2)}`);
  // A radial dimension has no extension lines; the shared geometry produces
  // none because both measured points already lie on the dimension line.
  check('a radial dimension draws no extension lines',
    api.dimensionSegments(dim).length === 1, `${api.dimensionSegments(dim).length} segments`);
  check('DIMRADIUS references the circle at both ends',
    dim.refs.every(ref => ref && ref.entityId === circle.id), JSON.stringify(dim.refs));
  check('DIMRADIUS anchors one end to the centre',
    dim.refs.some(ref => ref.part === 'CENTER'), JSON.stringify(dim.refs));
}

// The leader angle comes from the cursor, so a dimension pulled up-left has to
// land on that side of the circle.
await reset();
{
  drawCircle(P(0, 0), 4);
  api.startCommand('DIMRADIUS');
  api.commitPoint(P(0, 4));
  api.commitPoint(P(0, 7)); // straight up
  const dim = lastDim();
  check('the leader follows the cursor direction', pointNear(dim.p2, 0, 4), JSON.stringify(dim.p2));
  check('the radius is the same whichever way the leader points', near(measureOf(dim), 4));
  const anchor = api.dimensionGeometry(dim).textAnchor;
  check('the text sits where the cursor placed it', pointNear(anchor, 0, 7), JSON.stringify(anchor));
}

// ---------------------------------------------------------------------------
// DIMDIAMETER
// ---------------------------------------------------------------------------
await reset();
{
  const circle = drawCircle(P(2, 3), 6);
  api.startCommand('DIMDIAMETER');
  check('DIMDIAMETER asks for a circle', /Select a circle:/.test(api.promptText), api.promptText);
  api.commitPoint(P(8, 3));
  api.commitPoint(P(10, 3));

  const dim = lastDim();
  check('DIMDIAMETER records its type', dim.dimType === 'DIAMETER', dim.dimType);
  check('DIMDIAMETER measures the full diameter', near(measureOf(dim), 12), String(measureOf(dim)));
  check('DIMDIAMETER text is prefixed with a diameter sign',
    /^⌀ /.test(api.dimensionText(dim)), api.dimensionText(dim));
  check('DIMDIAMETER spans opposite sides of the circle',
    pointNear(dim.p1, -4, 3) && pointNear(dim.p2, 8, 3),
    `${JSON.stringify(dim.p1)} ${JSON.stringify(dim.p2)}`);
  // Picked here at 0° and 180°, so the resolver rightly uses the more
  // specific QUAD part; an off-quadrant leader gets POINT instead (below).
  check('DIMDIAMETER references the circle at both ends',
    dim.refs.every(ref => ref && ref.entityId === circle.id
      && ['POINT', 'QUAD'].includes(ref.part)),
    JSON.stringify(dim.refs));
  check('a diameter dimension draws no extension lines',
    api.dimensionSegments(dim).length === 1);
}

// The everyday case is a leader pulled to an arbitrary angle, not to one of
// the four quadrants — that is the case an earlier round of this work got
// wrong for linear dimensions, so it is asserted directly here.
await reset();
{
  const circle = drawCircle(P(0, 0), 5);
  api.startCommand('DIMDIAMETER');
  const oblique = P(5 * Math.cos(0.7), 5 * Math.sin(0.7));
  api.commitPoint(oblique);
  api.commitPoint(P(oblique.x * 1.6, oblique.y * 1.6));
  const dim = lastDim();
  check('an off-quadrant diameter still measures the diameter', near(measureOf(dim), 10),
    String(measureOf(dim)));
  check('an off-quadrant diameter tracks both ends by angle',
    dim.refs.every(ref => ref && ref.entityId === circle.id && ref.part === 'POINT'),
    JSON.stringify(dim.refs));

  api.state.selected.clear();
  api.state.selected.add(circle.id);
  api.startCommand('SCALE');
  api.commitPoint(P(0, 0));
  api.commitScaleInput('2');
  check('an off-quadrant diameter dimension is still associative',
    near(measureOf(entityById(dim.id)), 20), String(measureOf(entityById(dim.id))));
}

await reset();
{
  const circle = drawCircle(P(0, 0), 5);
  api.startCommand('DIMRADIUS');
  const oblique = P(5 * Math.cos(1.1), 5 * Math.sin(1.1));
  api.commitPoint(oblique);
  api.commitPoint(P(oblique.x * 0.5, oblique.y * 0.5));
  const dim = lastDim();
  check('an off-quadrant radius still measures the radius', near(measureOf(dim), 5),
    String(measureOf(dim)));
  api.state.selected.clear();
  api.state.selected.add(circle.id);
  api.startCommand('SCALE');
  api.commitPoint(P(0, 0));
  api.commitScaleInput('4');
  check('an off-quadrant radius dimension is still associative',
    near(measureOf(entityById(dim.id)), 20), String(measureOf(entityById(dim.id))));
}

// ---------------------------------------------------------------------------
// Associativity — the whole point of routing through the existing refs
// ---------------------------------------------------------------------------
await reset();
{
  const circle = drawCircle(P(0, 0), 5);
  api.startCommand('DIMRADIUS');
  api.commitPoint(P(5, 0));
  api.commitPoint(P(3, 0));
  const dimId = lastDim().id;

  // Scaling the circle must change what the dimension reads.
  api.state.selected.clear();
  api.state.selected.add(circle.id);
  api.startCommand('SCALE');
  api.commitPoint(P(0, 0));
  api.commitScaleInput('2');
  check('scaling the circle doubles its radius', near(entityById(circle.id).radius, 10),
    String(entityById(circle.id)?.radius));
  check('a radius dimension follows the circle it measures',
    near(measureOf(entityById(dimId)), 10), String(measureOf(entityById(dimId))));

  // Moving it must carry the dimension along without changing the value.
  api.state.selected.clear();
  api.state.selected.add(circle.id);
  api.startCommand('MOVE');
  api.commitPoint(P(0, 0));
  api.commitPoint(P(20, 20));
  const moved = entityById(dimId);
  check('moving the circle carries its radius dimension', pointNear(moved.p1, 20, 20),
    JSON.stringify(moved.p1));
  check('moving the circle does not change the measured radius', near(measureOf(moved), 10),
    String(measureOf(moved)));
}

await reset();
{
  const circle = drawCircle(P(0, 0), 5);
  api.startCommand('DIMDIAMETER');
  api.commitPoint(P(5, 0));
  api.commitPoint(P(8, 0));
  const dimId = lastDim().id;
  api.state.selected.clear();
  api.state.selected.add(circle.id);
  api.startCommand('SCALE');
  api.commitPoint(P(0, 0));
  api.commitScaleInput('3');
  check('a diameter dimension follows the circle it measures',
    near(measureOf(entityById(dimId)), 30), String(measureOf(entityById(dimId))));
}

// CAD-002 — a coincident unrelated object must not steal the association.
// A line's START sits exactly on the circle's centre, and the line is created
// first, so a drawing-wide coincidence search would find it before the circle
// itself and silently bind the centre-side reference to the wrong object. The
// leader is pulled to the top of the circle — off the line entirely — so the
// initial pick unambiguously targets the circle rather than the line.
await reset();
{
  const line = drawLine(P(0, 0), P(10, 0));
  const circle = drawCircle(P(0, 0), 5);
  api.startCommand('DIMRADIUS');
  api.commitPoint(P(0, 5));
  api.commitPoint(P(0, 8));
  const dim = lastDim();
  check('the radius dimension references the circle, not the coincident line',
    dim.refs.every(ref => ref && ref.entityId === circle.id), JSON.stringify(dim.refs));

  api.state.selected.clear();
  api.state.selected.add(line.id);
  api.startCommand('SCALE');
  api.commitPoint(P(0, 0));
  api.commitScaleInput('2');
  check('scaling the unrelated coincident line does not change the radius reading',
    near(measureOf(entityById(dim.id)), 5), String(measureOf(entityById(dim.id))));
  check('scaling the unrelated line left the circle itself alone',
    near(entityById(circle.id).radius, 5), String(entityById(circle.id).radius));
}

// A dimension whose circle is deleted freezes rather than erroring, which is
// the established behaviour for every other reference.
await reset();
{
  const circle = drawCircle(P(0, 0), 5);
  api.startCommand('DIMRADIUS');
  api.commitPoint(P(5, 0));
  api.commitPoint(P(3, 0));
  const dimId = lastDim().id;
  api.state.selected.clear();
  api.state.selected.add(circle.id);
  api.startCommand('ERASE');
  const frozen = entityById(dimId);
  check('erasing the circle leaves its dimension in place', Boolean(frozen));
  check('the orphaned dimension freezes at its last value', near(measureOf(frozen), 5),
    String(frozen && measureOf(frozen)));
}

// ---------------------------------------------------------------------------
// Arcs and refusals
// ---------------------------------------------------------------------------
await reset();
{
  // A quarter arc from 0° to 90° at radius 4.
  const arc = drawArc(P(4, 0), P(4 * Math.cos(Math.PI / 4), 4 * Math.sin(Math.PI / 4)), P(0, 4));
  check('arc setup produced an arc', arc?.type === 'ARC', arc?.type);
  api.startCommand('DIMRADIUS');
  api.commitPoint(P(4, 0));
  api.commitPoint(P(6, 0));
  const dim = lastDim();
  check('DIMRADIUS works on an arc', dim?.dimType === 'RADIUS');
  check('DIMRADIUS measures the arc radius', near(measureOf(dim), 4), String(measureOf(dim)));
}

await reset();
{
  const arc = drawArc(P(4, 0), P(4 * Math.cos(Math.PI / 4), 4 * Math.sin(Math.PI / 4)), P(0, 4));
  api.startCommand('DIMRADIUS');
  api.commitPoint(P(4, 0));
  // Pull the leader towards 180°, which is off the arc entirely.
  api.commitPoint(P(-8, 0));
  const dim = lastDim();
  const angle = Math.atan2(dim.p2.y - dim.p1.y, dim.p2.x - dim.p1.x);
  check('a leader pulled off an arc is clamped onto it',
    near(angle, Math.PI / 2, 1e-6), `angle ${angle}`);
  check('the clamped leader still measures the radius', near(measureOf(dim), 4));
  check('the clamped leader end is still on the arc',
    near(Math.hypot(dim.p2.x - arc.center.x, dim.p2.y - arc.center.y), arc.radius));
}

await reset();
{
  drawArc(P(4, 0), P(4 * Math.cos(Math.PI / 4), 4 * Math.sin(Math.PI / 4)), P(0, 4));
  api.startCommand('DIMDIAMETER');
  api.commitPoint(P(4, 0));
  check('DIMDIAMETER refuses an arc and names the alternative',
    /DIMRADIUS/.test(api.promptText), api.promptText);
  check('the refusal creates no dimension', !lastDim());
}

await reset();
{
  api.startCommand('LINE');
  api.commitPoint(P(0, 0));
  api.commitPoint(P(10, 0));
  api.finishCurrent();
  api.startCommand('DIMRADIUS');
  api.commitPoint(P(5, 0));
  check('DIMRADIUS names the wrong type rather than ignoring the pick',
    /LINE/.test(api.promptText), api.promptText);
  check('picking a line creates no dimension', !lastDim());
}

await reset();
{
  drawCircle(P(0, 0), 5);
  api.startCommand('DIMRADIUS');
  api.commitPoint(P(40, 40)); // empty space
  check('DIMRADIUS reports an empty pick', /No circle or arc there/.test(api.promptText), api.promptText);
}

// ---------------------------------------------------------------------------
// Persistence, undo, and the command surface
// ---------------------------------------------------------------------------
await reset();
{
  drawCircle(P(0, 0), 5);
  api.startCommand('DIMRADIUS');
  api.commitPoint(P(5, 0));
  api.commitPoint(P(3, 0));
  api.startCommand('DIMDIAMETER');
  api.commitPoint(P(0, 5));
  api.commitPoint(P(0, 9));
  check('both radial dimensions exist', api.entities.filter(e => e.type === 'DIM').length === 2);

  const before = api.entities;
  const text = api.exportDocumentText();
  await api.newDrawing();
  await api.importDocumentText(text);
  check('radial dimensions round-trip through the native format',
    JSON.stringify(api.entities) === JSON.stringify(before),
    `${api.entityCount} entities`);
  const reopened = api.entities.filter(e => e.type === 'DIM');
  check('the reopened radius dimension still measures correctly',
    near(measureOf(reopened.find(d => d.dimType === 'RADIUS')), 5));
  check('the reopened diameter dimension still measures correctly',
    near(measureOf(reopened.find(d => d.dimType === 'DIAMETER')), 10));
}

await reset();
{
  drawCircle(P(0, 0), 5);
  const before = JSON.stringify(api.entities);
  api.startCommand('DIMRADIUS');
  api.commitPoint(P(5, 0));
  api.commitPoint(P(3, 0));
  api.undo();
  check('undo removes a radial dimension in one step', JSON.stringify(api.entities) === before);
}

await reset();
{
  drawCircle(P(0, 0), 5);
  api.startCommand('DIMRADIUS');
  api.commitPoint(P(5, 0));
  api.cancelCurrent();
  check('Esc abandons a half-placed radial dimension', !lastDim());
  check('Esc leaves no command running', !api.commandInProgress());
}

check('DIMRADIUS is registered', api.registeredCommands.includes('DIMRADIUS'));
check('DIMDIAMETER is registered', api.registeredCommands.includes('DIMDIAMETER'));
check('DRA resolves to DIMRADIUS', api.resolveCommandName('DRA') === 'DIMRADIUS');
check('DDI resolves to DIMDIAMETER', api.resolveCommandName('DDI') === 'DIMDIAMETER');
check('the existing DDIM alias still reaches DIMSTYLE', api.resolveCommandName('DDIM') === 'DIMSTYLE');

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
