// Dimension references surviving edits that are not simple move/scale of the
// referenced object alone: rotating or mirroring the dimension together with
// its target (CAD-001), and JOIN/EXPLODE replacing the referenced geometry
// outright under new ids (CAD-004). Both are cases where the association used
// to silently go stale rather than error, which a green suite could miss.
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
function selectOnly(...ids) { api.state.selected.clear(); ids.forEach(id => api.state.selected.add(id)); }
function entityById(id) { return api.entities.find(e => e.id === id); }
function lastDim() { return [...api.entities].reverse().find(e => e.type === 'DIM'); }
function measureOf(dim) { return api.dimensionGeometry(dim).measure; }
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
function drawArc(a, b, c) {
  api.startCommand('ARC');
  api.commitPoint(a);
  api.commitPoint(b);
  api.commitPoint(c);
  return api.entities[api.entityCount - 1];
}
function drawOpenPolyline(points) {
  api.startCommand('PLINE');
  for (const p of points) api.commitPoint(p);
  api.finishCurrent();
  return api.entities[api.entityCount - 1];
}

// ---------------------------------------------------------------------------
// CAD-001 — mirroring an arc and its dimension together
//
// A quarter arc from 0° to 90°, radius 10. An aligned dimension's first point
// is picked exactly on the arc's START (10, 0), so it captures a START
// reference. Mirroring both across the Y axis (in place) reflects the arc's
// own start/end sense — its new START is the reflection of the old END — so
// the dimension's reference has to relabel to keep naming the same physical
// point, or it silently starts tracking the other end of the arc.
// ---------------------------------------------------------------------------
await reset();
{
  const arc = drawArc(P(10, 0), P(10 * Math.cos(Math.PI / 4), 10 * Math.sin(Math.PI / 4)), P(0, 10));
  check('arc setup produced a quarter arc', arc?.type === 'ARC', arc?.type);

  api.startCommand('DIMALIGNED');
  api.commitPoint(P(10, 0)); // exactly the arc's START
  api.commitPoint(P(20, 0)); // an unrelated free point
  api.commitPoint(P(15, -5));
  const dim = lastDim();
  check('the aligned dimension captured a START reference to the arc',
    dim.refs[0] && dim.refs[0].entityId === arc.id && dim.refs[0].part === 'START',
    JSON.stringify(dim.refs));
  check('the dimension measures 10 before the mirror', near(measureOf(dim), 10), String(measureOf(dim)));

  selectOnly(arc.id, dim.id);
  api.startCommand('MIRROR');
  api.commitPoint(P(0, 0));
  api.commitPoint(P(0, 1));
  api.submitCommandText('Y'); // erase source, replacing both in place

  const mirroredDim = entityById(dim.id);
  check('the mirrored dimension keeps measuring the arc endpoint it started on',
    pointNear(mirroredDim.p1, -10, 0), JSON.stringify(mirroredDim.p1));
  check('the mirrored dimension still measures 10, not the diagonal to the other end',
    near(measureOf(mirroredDim), 10), String(measureOf(mirroredDim)));
}

// ---------------------------------------------------------------------------
// CAD-001 — rotating a circle and its radius dimension together
//
// The dimension's leader point is a QUAD/POINT reference carrying an absolute
// world angle. Rotating the circle and its dimension together as one rigid
// operation must turn that angle by the same amount the circle turned by, or
// updateAssociativeDimensions snaps the leader straight back to its old spot.
// ---------------------------------------------------------------------------
await reset();
{
  const circle = drawCircle(P(0, 0), 10);
  api.startCommand('DIMRADIUS');
  api.commitPoint(P(10, 0));
  api.commitPoint(P(13, 0));
  const dim = lastDim();
  check('the radius dimension starts pointing east', pointNear(dim.p2, 10, 0), JSON.stringify(dim.p2));

  selectOnly(circle.id, dim.id);
  api.startCommand('ROTATE');
  api.commitPoint(P(0, 0));
  api.commitAngleInput('90');

  const rotated = entityById(dim.id);
  check('the rotated dimension leader follows the rotation to the north point',
    pointNear(rotated.p2, 0, 10), JSON.stringify(rotated.p2));
  check('the rotated dimension still measures the radius', near(measureOf(rotated), 10),
    String(measureOf(rotated)));
}

// ---------------------------------------------------------------------------
// CAD-004 — JOIN remapping a dimension onto the merged polyline
// ---------------------------------------------------------------------------
await reset();
{
  const first = drawLine(P(0, 0), P(10, 0));
  const second = drawLine(P(10, 0), P(20, 0));
  api.startCommand('DIMALIGNED');
  api.commitPoint(P(0, 0)); // first's START
  api.commitPoint(P(10, 0)); // first's END
  api.commitPoint(P(5, -3));
  const dimId = lastDim().id;
  check('the dimension measures the first line before JOIN', near(measureOf(entityById(dimId)), 10));

  selectOnly(first.id, second.id);
  api.startCommand('JOIN');
  const joined = api.entities.find(e => e.type === 'PLINE');
  check('JOIN produced one polyline', Boolean(joined));
  check('JOIN removed both source lines',
    !entityById(first.id) && !entityById(second.id));

  const afterJoin = entityById(dimId);
  const refIds = (afterJoin.refs || []).filter(Boolean).map(r => r.entityId);
  check('the dimension no longer references a deleted line id',
    refIds.every(id => id === joined.id), JSON.stringify(afterJoin.refs));
  check('the dimension still measures 10 right after JOIN', near(measureOf(afterJoin), 10),
    String(measureOf(afterJoin)));

  selectOnly(joined.id);
  api.startCommand('SCALE');
  api.commitPoint(P(0, 0));
  api.commitScaleInput('2');
  check('scaling the joined polyline now carries the dimension along',
    near(measureOf(entityById(dimId)), 20), String(measureOf(entityById(dimId))));
}

// ---------------------------------------------------------------------------
// CAD-004 — EXPLODE remapping a dimension onto its own piece
// ---------------------------------------------------------------------------
await reset();
{
  const poly = drawOpenPolyline([P(0, 0), P(10, 0), P(10, 10)]);
  api.startCommand('DIMALIGNED');
  api.commitPoint(P(10, 0)); // the shared middle vertex
  api.commitPoint(P(10, 10)); // the far end
  api.commitPoint(P(13, 5));
  const dimId = lastDim().id;
  check('the dimension measures the last segment before EXPLODE',
    near(measureOf(entityById(dimId)), 10));

  selectOnly(poly.id);
  api.startCommand('EXPLODE');
  check('EXPLODE removed the source polyline', !entityById(poly.id));
  const pieces = api.entities.filter(e => e.type === 'LINE');
  check('EXPLODE produced two line segments', pieces.length === 2, String(pieces.length));

  const afterExplode = entityById(dimId);
  const refIds = (afterExplode.refs || []).filter(Boolean).map(r => r.entityId);
  check('the dimension no longer references the deleted polyline id',
    refIds.every(id => id !== poly.id), JSON.stringify(afterExplode.refs));
  check('the dimension still measures 10 right after EXPLODE', near(measureOf(afterExplode), 10),
    String(measureOf(afterExplode)));

  selectOnly(...pieces.map(e => e.id));
  api.startCommand('SCALE');
  api.commitPoint(P(0, 0));
  api.commitScaleInput('2');
  check('scaling the exploded pieces now carries the dimension along',
    near(measureOf(entityById(dimId)), 20), String(measureOf(entityById(dimId))));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
