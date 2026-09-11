// Curved polyline segments (bulges): the geometry, and every part of the app
// that has to keep working once a polyline is no longer a chain of straight
// lines. Run after tools/run-checks.sh — this drives the built bundle.
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

const { api, sandbox } = boot(BUNDLE);
const P = (x, y) => ({ x, y });
const QUARTER = Math.tan(Math.PI / 8); // bulge of a 90 degree arc

async function reset() {
  await api.newDrawing();
  api.setOrtho(false);
  api.setAllSnapTypes(false);
}
function entityById(id) { return api.entities.find(e => e.id === id); }
function selectOnly(...ids) {
  api.state.selected.clear();
  ids.forEach(id => api.state.selected.add(id));
}
function lastEntity() { return api.entities[api.entityCount - 1]; }
function curvedSegments(entity) { return api.entitySegments(entity).filter(([, , arc]) => arc); }

// A square whose right-hand side bows outward as a half circle: four vertices,
// with the segment leaving (10,0) carrying a bulge of 1. Deliberately not a
// shape any single command produces, so the model is exercised directly.
function drawBowedSquare() {
  api.addPolyline([P(0, 0), P(10, 0), P(10, 10), P(0, 10)], true, [0, 1, 0, 0]);
  return lastEntity();
}

// ---------------------------------------------------------------------------
// The stored form
// ---------------------------------------------------------------------------

await reset();
{
  const shape = drawBowedSquare();
  check('a bulged polyline stores its bulges', Array.isArray(shape.bulges), JSON.stringify(shape.bulges));
  check('the bulge list matches the point list', shape.bulges?.length === shape.points.length,
    `${shape.bulges?.length} vs ${shape.points.length}`);
  check('the bulge sits on the segment it was given for', api.polylineBulge(shape, 1) === 1);
  check('every other segment stays straight',
    [0, 2, 3].every(index => api.polylineBulge(shape, index) === 0));
  check('polylineHasBulges recognises it', api.polylineHasBulges(shape) === true);
}

// An all-zero bulge list is not stored at all, so a straight polyline is
// byte-identical to one drawn before curved segments existed.
await reset();
{
  api.addPolyline([P(0, 0), P(5, 0), P(5, 5)], false, [0, 0, 0]);
  const straight = lastEntity();
  check('an all-zero bulge list is dropped', straight.bulges === undefined, JSON.stringify(straight.bulges));
  check('polylineHasBulges says no', api.polylineHasBulges(straight) === false);
}

// ---------------------------------------------------------------------------
// Segments, length, area, bounds
// ---------------------------------------------------------------------------

await reset();
{
  const shape = drawBowedSquare();
  const segments = api.entitySegments(shape);
  check('a closed bulged polyline still has one segment per vertex', segments.length === 4,
    `${segments.length}`);
  const arc = segments[1][2];
  check('the curved segment reports an arc', Boolean(arc));
  check('the arc radius is half the chord', near(arc.radius, 5), arc?.radius);
  check('the arc is centred on the chord midpoint', pointNear(arc.center, 10, 5), JSON.stringify(arc?.center));
  check('a bulge of 1 is a half turn', near(Math.abs(arc.sweep), Math.PI), arc?.sweep);
  check('straight segments report no arc',
    [0, 2, 3].every(index => segments[index][2] === null));

  // Three straight sides plus a semicircle.
  check('length follows the arc, not its chord',
    near(api.entityLength(shape), 30 + Math.PI * 5), String(api.entityLength(shape)));
  // The square plus the half disc the bulge adds outside it.
  check('area counts the circular segment',
    near(api.entityArea(shape), 100 + Math.PI * 25 / 2), String(api.entityArea(shape)));

  const box = api.entityBBox(shape);
  check('the bounding box reaches the arc crown, not the chord', near(box.maxX, 15), box.maxX);
  check('the bounding box is otherwise the square',
    near(box.minX, 0) && near(box.minY, 0) && near(box.maxY, 10),
    JSON.stringify(box));
}

// A bulge that bows inward subtracts area instead of adding it, and the same
// arc travelled the other way is the same curve.
await reset();
{
  api.addPolyline([P(0, 0), P(10, 0), P(10, 10), P(0, 10)], true, [0, -1, 0, 0]);
  const shape = lastEntity();
  const arc = api.entitySegments(shape)[1][2];
  check('a negative bulge sweeps clockwise', arc.sweep < 0, String(arc.sweep));
  check('a negative bulge keeps the same centre and radius',
    pointNear(arc.center, 10, 5) && near(arc.radius, 5), JSON.stringify(arc));
  check('an inward bulge removes area', near(api.entityArea(shape), 100 - Math.PI * 25 / 2),
    String(api.entityArea(shape)));
  const box = api.entityBBox(shape);
  check('an inward bulge does not widen the bounding box', near(box.maxX, 10), box.maxX);
  check('an inward bulge does not narrow it either', near(box.minX, 0), box.minX);
}

// Three third-turn arcs close into a whole circle — the sharpest check that
// the sign convention, the arc-length sum and the area formula all agree, and
// the smallest closed polyline this format allows (a closed shape needs three
// vertices, so the two-arc DXF circle is not representable; a circle here is a
// CIRCLE).
await reset();
{
  const r = 5;
  const third = Math.tan(Math.PI / 6); // bulge of a 120 degree arc
  const at = degrees => P(r * Math.cos(degrees * Math.PI / 180), r * Math.sin(degrees * Math.PI / 180));
  api.addPolyline([at(90), at(210), at(330)], true, [third, third, third]);
  const circle = lastEntity();
  check('three third-turn arcs measure a full circumference',
    near(api.entityLength(circle), 2 * Math.PI * r, 1e-9), String(api.entityLength(circle)));
  check('and a full circle area', near(api.entityArea(circle), Math.PI * r * r, 1e-9),
    String(api.entityArea(circle)));
  const box = api.entityBBox(circle);
  check('and a full circle bounding box',
    near(box.minX, -r) && near(box.maxX, r) && near(box.minY, -r) && near(box.maxY, r),
    JSON.stringify(box));
}

// ---------------------------------------------------------------------------
// Save and reload
// ---------------------------------------------------------------------------

await reset();
{
  const shape = drawBowedSquare();
  const text = api.exportDocumentText();
  check('the saved file carries the bulges', /"bulges"/.test(text));
  await reset();
  await api.importDocumentText(text);
  const reloaded = api.entities.find(e => e.type === 'PLINE');
  check('a reloaded polyline keeps its bulges',
    JSON.stringify(reloaded?.bulges) === JSON.stringify(shape.bulges),
    JSON.stringify(reloaded?.bulges));
  check('a reloaded polyline measures the same',
    near(api.entityLength(reloaded), 30 + Math.PI * 5), String(api.entityLength(reloaded)));
}

// A bulge list that does not line up with the points is rejected rather than
// resized, so a stale array can never draw a curve on the wrong segment.
{
  const document = JSON.parse(api.exportDocumentText());
  document.entities = [{
    id: 1, type: 'PLINE', layerId: '0', closed: false,
    points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
    bulges: [0, 1],
  }];
  const parsed = api.parseDocumentText(JSON.stringify(document));
  check('a mismatched bulge list is rejected', Boolean(parsed.error), JSON.stringify(parsed.error));
  check('and says why', /bulge list/.test(parsed.error || ''), parsed.error);
}
{
  const document = JSON.parse(api.exportDocumentText());
  document.entities = [{
    id: 1, type: 'PLINE', layerId: '0', closed: false,
    points: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    bulges: [0.5, 'x'],
  }];
  const parsed = api.parseDocumentText(JSON.stringify(document));
  check('a non-numeric bulge is rejected', /invalid polyline bulge/.test(parsed.error || ''), parsed.error);
}
// A file written before curved segments existed still opens, unchanged.
{
  const document = JSON.parse(api.exportDocumentText());
  document.entities = [{
    id: 1, type: 'PLINE', layerId: '0', closed: false,
    points: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
  }];
  const parsed = api.parseDocumentText(JSON.stringify(document));
  check('a polyline with no bulge list still loads', !parsed.error, JSON.stringify(parsed.error));
  check('and gains no bulge list', parsed.document?.entities[0].bulges === undefined);
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

// MOVE, ROTATE and SCALE leave a bulge alone — the whole reason a curve is
// stored as one — while MIRROR reverses it.
await reset();
{
  const shape = drawBowedSquare();
  selectOnly(shape.id);
  api.startCommand('MOVE');
  api.commitPoint(P(0, 0));
  api.commitPoint(P(3, 7));
  const moved = entityById(shape.id);
  check('MOVE keeps the bulges', JSON.stringify(moved.bulges) === JSON.stringify(shape.bulges),
    JSON.stringify(moved.bulges));
  check('MOVE carries the arc with the points',
    pointNear(api.entitySegments(moved)[1][2].center, 13, 12),
    JSON.stringify(api.entitySegments(moved)[1][2].center));
}

await reset();
{
  const shape = drawBowedSquare();
  selectOnly(shape.id);
  api.startCommand('SCALE');
  api.commitPoint(P(0, 0));
  api.commitScaleInput('2');
  const scaled = entityById(shape.id);
  check('SCALE keeps the bulges', JSON.stringify(scaled.bulges) === JSON.stringify(shape.bulges));
  check('SCALE doubles the arc radius', near(api.entitySegments(scaled)[1][2].radius, 10),
    String(api.entitySegments(scaled)[1][2].radius));
}

await reset();
{
  const shape = drawBowedSquare();
  selectOnly(shape.id);
  api.startCommand('MIRROR');
  api.commitPoint(P(0, 0));
  api.commitPoint(P(0, 10));
  api.submitCommandText('Y');
  const mirrored = entityById(shape.id);
  check('MIRROR negates the bulges', mirrored.bulges[1] === -1, JSON.stringify(mirrored.bulges));
  const arc = api.entitySegments(mirrored)[1][2];
  check('the mirrored arc is the reflection', pointNear(arc.center, -10, 5) && near(arc.radius, 5),
    JSON.stringify(arc));
  check('the mirrored shape keeps its area', near(api.entityArea(mirrored), 100 + Math.PI * 25 / 2),
    String(api.entityArea(mirrored)));
  // Without the sign flip the arc would bow the wrong way and the bounding box
  // would collapse back onto the chord.
  check('the mirrored bounding box reaches the reflected crown',
    near(api.entityBBox(mirrored).minX, -15), String(api.entityBBox(mirrored).minX));
}

// ---------------------------------------------------------------------------
// Picking and snapping
// ---------------------------------------------------------------------------

// Everything below picks and snaps in screen pixels, so the view is zoomed to
// the drawing first — at the default 1.5px per unit a five-unit gap is inside
// the pick aperture and no probe could tell the arc from its chord.
await reset();
{
  const shape = drawBowedSquare();
  api.zoomExtents();
  api.state.mouseScreen = api.worldToScreen(P(15, 5));
  api.selectAt(P(15, 5));
  check('clicking the arc crown selects the polyline',
    api.selectedIds.length === 1 && api.selectedIds[0] === shape.id, JSON.stringify(api.selectedIds));
}
await reset();
{
  drawBowedSquare();
  api.zoomExtents();
  // Dead on the chord the arc replaced. Picking off the chord would select
  // here; picking off the arc, five units away, must not.
  api.state.mouseScreen = api.worldToScreen(P(10, 5));
  api.selectAt(P(10, 5));
  check('clicking the chord the arc replaced selects nothing', api.selectedIds.length === 0,
    JSON.stringify(api.selectedIds));
}

await reset();
{
  const shape = drawBowedSquare();
  api.zoomExtents();
  api.setSnapType('MID', true);
  api.state.mouseScreen = api.worldToScreen(P(15.02, 5.02));
  const snap = api.getSnap(P(15.02, 5.02));
  check('MID snaps to the arc midpoint, not the chord midpoint',
    snap?.type === 'MID' && pointNear(snap.p, 15, 5), JSON.stringify(snap));
  api.setSnapType('MID', false);

  api.setSnapType('CENTER', true);
  api.state.mouseScreen = api.worldToScreen(P(10.02, 5.02));
  const centerSnap = api.getSnap(P(10.02, 5.02));
  check('CENTER snaps to the arc centre', centerSnap?.type === 'CENTER' && pointNear(centerSnap.p, 10, 5),
    JSON.stringify(centerSnap));
  api.setSnapType('CENTER', false);

  api.setSnapType('NEAR', true);
  api.state.mouseScreen = api.worldToScreen(P(13.6, 8.6));
  const nearSnap = api.getSnap(P(13.6, 8.6));
  check('NEAR lands on the arc itself',
    nearSnap?.type === 'NEAR' && near(distance(nearSnap.p, P(10, 5)), 5, 1e-6),
    JSON.stringify(nearSnap));
  api.setSnapType('NEAR', false);
  void shape;
}

// A crossing window over empty space inside the bulge must not select it, and
// one that crosses the arc must.
await reset();
{
  const shape = drawBowedSquare();
  api.zoomExtents();
  check('a window crossing the arc catches the polyline',
    api.entityCrossesBox(shape, { minX: 14, maxX: 16, minY: 4, maxY: 6 }) === true);
  check('a window in the empty space beyond the arc does not',
    api.entityCrossesBox(shape, { minX: 16, maxX: 18, minY: 4, maxY: 6 }) === false);
}

// ---------------------------------------------------------------------------
// Explode and join
// ---------------------------------------------------------------------------

// EXPLODE is what the commands that refuse a curved polyline point users at,
// so a curve has to leave as a real ARC rather than as its chord.
await reset();
{
  const shape = drawBowedSquare();
  selectOnly(shape.id);
  api.startCommand('EXPLODE');
  const arcs = api.entities.filter(e => e.type === 'ARC');
  const lines = api.entities.filter(e => e.type === 'LINE');
  check('EXPLODE turns a curved segment into an ARC', arcs.length === 1, `${arcs.length} arcs`);
  check('EXPLODE turns the straight segments into LINEs', lines.length === 3, `${lines.length} lines`);
  check('the exploded arc keeps the curve',
    arcs[0] && pointNear(arcs[0].center, 10, 5) && near(arcs[0].radius, 5) &&
      near(arcs[0].endAngle - arcs[0].startAngle, Math.PI),
    JSON.stringify(arcs[0]));
}

// JOIN is the inverse, and an arc can now be part of the chain.
await reset();
{
  api.startCommand('LINE');
  api.commitPoint(P(0, 0));
  api.commitPoint(P(10, 0));
  api.finishCurrent();
  const line = lastEntity();
  api.startCommand('ARC');
  api.commitPoint(P(10, 0));
  api.commitPoint(P(15, 5));
  api.commitPoint(P(10, 10));
  const arc = lastEntity();
  selectOnly(line.id, arc.id);
  api.startCommand('JOIN');
  const joined = api.entities.find(e => e.type === 'PLINE');
  check('JOIN accepts an arc', Boolean(joined) && api.entityCount === 1, `count ${api.entityCount}`);
  check('the joined polyline carries the arc as a bulge',
    joined && curvedSegments(joined).length === 1, JSON.stringify(joined?.bulges));
  const rebuilt = joined && curvedSegments(joined)[0][2];
  check('the joined arc has the same centre and radius',
    rebuilt && pointNear(rebuilt.center, 10, 5) && near(rebuilt.radius, 5), JSON.stringify(rebuilt));
  check('the joined polyline measures line plus arc',
    joined && near(api.entityLength(joined), 10 + Math.PI * 5), String(joined && api.entityLength(joined)));
}

// A chain that has to be walked backwards reverses the arc with it.
await reset();
{
  api.startCommand('ARC');
  api.commitPoint(P(10, 0));
  api.commitPoint(P(15, 5));
  api.commitPoint(P(10, 10));
  const arc = lastEntity();
  api.startCommand('LINE');
  api.commitPoint(P(0, 0));
  api.commitPoint(P(10, 0));
  api.finishCurrent();
  const line = lastEntity();
  selectOnly(arc.id, line.id);
  api.startCommand('JOIN');
  const joined = api.entities.find(e => e.type === 'PLINE');
  const rebuilt = joined && curvedSegments(joined)[0]?.[2];
  check('a reversed arc keeps its shape through JOIN',
    rebuilt && pointNear(rebuilt.center, 10, 5) && near(rebuilt.radius, 5) &&
      near(Math.abs(rebuilt.sweep), Math.PI), JSON.stringify(rebuilt));
}

// ---------------------------------------------------------------------------
// Commands that cannot handle a curve say so
// ---------------------------------------------------------------------------

await reset();
{
  const shape = drawBowedSquare();
  const before = JSON.stringify(api.entities);
  api.startCommand('TRIM'); // no preselection: every visible object cuts
  api.state.mouseScreen = api.worldToScreen(P(5, 0));
  api.commitPoint(P(5, 0));
  check('TRIM refuses a curved polyline by name',
    /curved segment/.test(api.promptText), api.promptText);
  check('a refused trim changes nothing', JSON.stringify(api.entities) === before);
  api.cancelCurrent();
  void shape;
}

await reset();
{
  const shape = drawBowedSquare();
  selectOnly(shape.id);
  api.startCommand('OFFSET');
  check('OFFSET does not take a curved polyline as its preselection',
    api.promptText.includes('offset distance'), api.promptText);
  api.commitDistance(1);
  selectOnly(shape.id);
  api.acceptDefaultAction();
  check('OFFSET refuses a curved polyline by name',
    /curved segment/.test(api.promptText), api.promptText);
  check('a refused offset adds nothing', api.entityCount === 1, `count ${api.entityCount}`);
  api.cancelCurrent();
}

await reset();
{
  api.addPolyline([P(0, 0), P(10, 0), P(20, 0)], false, [QUARTER, 0, 0]);
  const shape = lastEntity();
  api.startCommand('LINE');
  api.commitPoint(P(30, -10));
  api.commitPoint(P(30, 10));
  api.finishCurrent();
  const before = JSON.stringify(api.entities);
  api.startCommand('EXTEND');
  api.state.mouseScreen = api.worldToScreen(P(0, 0));
  api.commitPoint(P(0.5, 0));
  check('EXTEND refuses a curved end by name', /curved/.test(api.promptText), api.promptText);
  check('a refused extend changes nothing', JSON.stringify(api.entities) === before);
  api.cancelCurrent();
  // The straight end of the same polyline still extends.
  api.startCommand('EXTEND');
  api.state.mouseScreen = api.worldToScreen(P(19.5, 0));
  api.commitPoint(P(19.5, 0));
  check('the straight end of the same polyline still extends',
    pointNear(entityById(shape.id).points[2], 30, 0),
    JSON.stringify(entityById(shape.id).points[2]));
  api.cancelCurrent();
}

// ---------------------------------------------------------------------------
// Associative dimensions
// ---------------------------------------------------------------------------

// A dimension picked at an arbitrary point on a curved segment tracks that
// point along the arc rather than along the chord it used to be.
await reset();
{
  const shape = drawBowedSquare();
  // The segment runs from (10,0) counter-clockwise round to (10,10), so it
  // starts at 270 degrees; a third of the way along is 330.
  const onArc = P(10 + 5 * Math.cos(-Math.PI / 6), 5 + 5 * Math.sin(-Math.PI / 6));
  const ref = api.resolveEntityReference(onArc);
  check('a point on a curved segment resolves to that segment',
    ref?.entityId === shape.id && ref.part === 'SEGMENT' && ref.segmentIndex === 1,
    JSON.stringify(ref));
  check('and records where along the arc it sits', ref && near(ref.t, 1 / 3, 1e-6), ref?.t);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// What the renderer asks the canvas for, since a curve drawn as its chord
// would pass every geometric check above and still look wrong on screen.
await reset();
{
  drawBowedSquare();
  api.zoomExtents();
  const context = sandbox.document.getElementById('cadCanvas').getContext('2d');
  const calls = [];
  for (const name of ['moveTo', 'lineTo', 'arc']) {
    context[name] = (...args) => calls.push([name, ...args]);
  }
  api.drawNow();
  const arcCalls = calls.filter(call => call[0] === 'arc');
  check('the renderer draws one arc for the curved segment', arcCalls.length === 1,
    `${arcCalls.length} arcs`);
  // The grid draws lines too, so what matters is not how many there are but
  // what follows the move to the curved segment's start: the chord must never
  // be drawn. Calls arrive in order, so each moveTo names what comes next.
  const from = api.worldToScreen(P(10, 0));
  const chordEnd = api.worldToScreen(P(10, 10));
  const after = calls
    .map((call, index) => (call[0] === 'moveTo' && near(call[1], from.x, 1e-6) &&
      near(call[2], from.y, 1e-6) ? calls[index + 1] : null))
    .filter(Boolean);
  check('the curved segment is drawn as an arc, never as its chord',
    after.length === 1 && after[0][0] === 'arc',
    JSON.stringify(after.map(call => call[0])));
  check('and no line is drawn along that chord',
    !calls.some(call => call[0] === 'lineTo' && near(call[1], chordEnd.x, 1e-6) &&
      near(call[2], chordEnd.y, 1e-6)));
  const [, cx, cy, radiusPx, , , anticlockwise] = arcCalls[0] || [];
  const centre = api.worldToScreen(P(10, 5));
  check('the drawn arc is centred where the arc is',
    near(cx, centre.x, 1e-6) && near(cy, centre.y, 1e-6), JSON.stringify([cx, cy]));
  check('the drawn arc has the arc radius in pixels', near(radiusPx, 5 * api.viewScale, 1e-6),
    String(radiusPx));
  // Screen Y runs opposite world Y, so a counter-clockwise world sweep is an
  // anticlockwise canvas sweep; drawn the other way it would bow the wrong side.
  check('the drawn arc sweeps the way the bulge does', anticlockwise === true, String(anticlockwise));
  const crown = api.worldToScreen(P(15, 5));
  check('the crown lies on the circle drawn',
    near(Math.hypot(crown.x - cx, crown.y - cy), radiusPx, 1e-6),
    String(Math.hypot(crown.x - cx, crown.y - cy)));
}

// ---------------------------------------------------------------------------
// Plotting
// ---------------------------------------------------------------------------

await reset();
{
  drawBowedSquare();
  const plan = api.buildPlotPlan({ ...api.defaultPlotSettings(), area: 'extents' });
  const stroke = plan.ops.find(op => op.kind === 'stroke');
  const subpath = stroke?.subpaths[0];
  check('a plotted polyline is one subpath', stroke?.subpaths.length === 1, JSON.stringify(stroke?.subpaths.length));
  check('the plotted curve becomes bezier pieces',
    subpath?.segs.some(seg => seg.type === 'c'), JSON.stringify(subpath?.segs.map(s => s.type)));
  check('the plotted straight sides stay lines',
    subpath?.segs.filter(seg => seg.type === 'l').length === 2,
    JSON.stringify(subpath?.segs.map(s => s.type)));
  check('the plotted subpath is still closed', subpath?.closed === true);
}

// A straight polyline plots exactly as it did before curved segments existed:
// three vertices, two line segments, no close operator.
await reset();
{
  api.addPolyline([P(0, 0), P(10, 0), P(10, 10)], false);
  const plan = api.buildPlotPlan({ ...api.defaultPlotSettings(), area: 'extents' });
  const subpath = plan.ops.find(op => op.kind === 'stroke')?.subpaths[0];
  check('a straight polyline plots unchanged',
    subpath?.segs.length === 2 && subpath.segs.every(seg => seg.type === 'l') && subpath.closed === false,
    JSON.stringify(subpath?.segs.map(s => s.type)));
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('FAILURES:');
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exit(1);
}
