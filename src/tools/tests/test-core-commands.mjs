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

// Draw through the real command path rather than seeding state, so the tests
// exercise what a user's clicks actually produce.
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

// Sample a point on an arc at a fraction of its sweep.
function arcPointAt(arc, t) {
  const sweep = arc.endAngle - arc.startAngle;
  const angle = arc.startAngle + sweep * t;
  return P(arc.center.x + arc.radius * Math.cos(angle), arc.center.y + arc.radius * Math.sin(angle));
}

// ---------------------------------------------------------------------------
// ERASE
// ---------------------------------------------------------------------------
reset();
{
  const a = drawLine(P(0, 0), P(10, 0));
  const b = drawLine(P(0, 5), P(10, 5));
  check('ERASE setup drew two lines', api.entityCount === 2, `count ${api.entityCount}`);

  // Preselection is the whole instruction: the command should act at once.
  selectOnly(a.id);
  api.startCommand('ERASE');
  check('ERASE on a preselection erases immediately', api.entityCount === 1, `count ${api.entityCount}`);
  check('ERASE removed the selected line', !entityById(a.id));
  check('ERASE kept the unselected line', Boolean(entityById(b.id)));
  check('ERASE completed rather than staying open', !api.commandInProgress());

  api.undo();
  check('undo restores an erased object', api.entityCount === 2, `count ${api.entityCount}`);
}

reset();
{
  const a = drawLine(P(0, 0), P(10, 0));
  drawLine(P(0, 5), P(10, 5));
  // With nothing selected the command must wait and gather its own selection.
  api.state.selected.clear();
  api.startCommand('ERASE');
  check('ERASE with no preselection stays open', api.commandInProgress());
  check('ERASE asks for objects', api.commandCapabilities?.selectsObjects === true);
  selectOnly(a.id);
  api.acceptDefaultAction();
  check('ERASE erases the gathered selection on Enter', api.entityCount === 1, `count ${api.entityCount}`);
  check('ERASE reports what it removed', /Erased 1 object\./.test(api.promptText), api.promptText);
}

reset();
{
  drawLine(P(0, 0), P(10, 0));
  api.state.selected.clear();
  api.startCommand('ERASE');
  api.acceptDefaultAction();
  check('ERASE with an empty selection refuses rather than erasing', api.entityCount === 1);
  check('ERASE says why it refused', /No objects selected\./.test(api.promptText), api.promptText);
}

// A locked layer must not be erasable. Locking already drops the layer's
// entities from the selection, so the selection is forced back afterwards:
// the point is that the command refuses on its own, not merely that the UI
// never offers it.
reset();
{
  const wallsId = api.createLayer('WALLS');
  api.setCurrentLayer(wallsId);
  const a = drawLine(P(0, 0), P(10, 0));
  api.setCurrentLayer('0');
  check('locking a non-current layer is allowed', api.toggleLayerLock(wallsId) === true);
  check('the layer really is locked', api.layers.find(l => l.id === wallsId)?.locked === true);
  selectOnly(a.id);
  api.startCommand('ERASE');
  check('ERASE cannot remove an object on a locked layer', api.entityCount === 1, `count ${api.entityCount}`);
  check('ERASE says the selection is not erasable', /No objects selected\./.test(api.promptText), api.promptText);
}

// The same guard for MIRROR: a locked object must not be reflected in place.
reset();
{
  const wallsId = api.createLayer('WALLS');
  api.setCurrentLayer(wallsId);
  const a = drawLine(P(2, 1), P(6, 3));
  api.setCurrentLayer('0');
  api.toggleLayerLock(wallsId);
  selectOnly(a.id);
  api.startCommand('MIRROR');
  api.commitPoint(P(0, 0));
  api.commitPoint(P(0, 1));
  api.submitCommandText('Y');
  const untouched = entityById(a.id);
  check('MIRROR cannot reflect an object on a locked layer',
    untouched && pointNear(untouched.a, 2, 1) && pointNear(untouched.b, 6, 3),
    untouched && JSON.stringify([untouched.a, untouched.b]));
  check('MIRROR did not add a copy of locked geometry', api.entityCount === 1, `count ${api.entityCount}`);
}

// ---------------------------------------------------------------------------
// MIRROR
// ---------------------------------------------------------------------------

// Mirroring a line across the Y axis, keeping the source (the <No> default).
reset();
{
  const a = drawLine(P(2, 1), P(6, 3));
  selectOnly(a.id);
  api.startCommand('MIRROR');
  check('MIRROR opens at the mirror line with a preselection', api.operationStage === 'BASE', api.operationStage);
  api.commitPoint(P(0, 0));
  check('MIRROR asks for the second axis point', api.operationStage === 'SECOND', api.operationStage);
  check('MIRROR applies ORTHO to the axis', api.commandCapabilities?.usesOrtho === true);
  check('MIRROR takes a direct distance for the axis', api.commandCapabilities?.takesDistance === true);
  api.commitPoint(P(0, 10));
  check('MIRROR asks whether to erase the source', api.operationStage === 'CONFIRM', api.operationStage);
  check('MIRROR offers the Yes/No question', /Erase source objects\?/.test(api.promptText), api.promptText);

  api.acceptDefaultAction(); // Enter takes <No>
  check('MIRROR <No> keeps the source and adds a copy', api.entityCount === 2, `count ${api.entityCount}`);
  const original = entityById(a.id);
  check('MIRROR <No> left the original untouched',
    pointNear(original.a, 2, 1) && pointNear(original.b, 6, 3));
  const copy = api.entities.find(e => e.id !== a.id);
  check('MIRROR reflected the copy across the Y axis',
    pointNear(copy.a, -2, 1) && pointNear(copy.b, -6, 3),
    JSON.stringify([copy.a, copy.b]));
  check('MIRROR selects the new copy', api.selectedIds.length === 1 && api.selectedIds[0] === copy.id);
}

// Mirroring in place, erasing the source.
reset();
{
  const a = drawLine(P(2, 1), P(6, 3));
  selectOnly(a.id);
  api.startCommand('MIRROR');
  api.commitPoint(P(0, 0));
  api.commitPoint(P(0, 10));
  api.submitCommandText('Y');
  check('MIRROR Yes keeps the object count', api.entityCount === 1, `count ${api.entityCount}`);
  const moved = entityById(a.id);
  check('MIRROR Yes reflected in place',
    moved && pointNear(moved.a, -2, 1) && pointNear(moved.b, -6, 3),
    moved && JSON.stringify([moved.a, moved.b]));

  api.undo();
  const restored = entityById(a.id);
  check('undo restores a mirrored-in-place object',
    restored && pointNear(restored.a, 2, 1) && pointNear(restored.b, 6, 3));
}

// An oblique axis, the case where a wrong reflection formula still looks
// plausible on horizontal/vertical tests.
reset();
{
  const a = drawLine(P(4, 0), P(4, 2));
  selectOnly(a.id);
  api.startCommand('MIRROR');
  api.commitPoint(P(0, 0));
  api.commitPoint(P(5, 5)); // the 45° line y = x
  api.submitCommandText('Y');
  const moved = entityById(a.id);
  // Reflecting across y = x swaps the coordinates.
  check('MIRROR across a 45° axis swaps coordinates',
    moved && pointNear(moved.a, 0, 4) && pointNear(moved.b, 2, 4),
    moved && JSON.stringify([moved.a, moved.b]));
}

// A mirror line that is not through the origin.
reset();
{
  const a = drawLine(P(0, 0), P(2, 0));
  selectOnly(a.id);
  api.startCommand('MIRROR');
  api.commitPoint(P(10, 0));
  api.commitPoint(P(10, 7));
  api.submitCommandText('Y');
  const moved = entityById(a.id);
  check('MIRROR across x = 10 reflects about that axis',
    moved && pointNear(moved.a, 20, 0) && pointNear(moved.b, 18, 0),
    moved && JSON.stringify([moved.a, moved.b]));
}

// A circle: only the centre moves, the radius is untouched.
reset();
{
  const c = drawCircle(P(3, 4), 2);
  selectOnly(c.id);
  api.startCommand('MIRROR');
  api.commitPoint(P(0, 0));
  api.commitPoint(P(0, 1));
  api.submitCommandText('Y');
  const moved = entityById(c.id);
  check('MIRROR moves a circle centre and keeps its radius',
    moved && pointNear(moved.center, -3, 4) && near(moved.radius, 2),
    moved && JSON.stringify(moved));
}

// The arc case: reflection reverses the sense of rotation, so the mirrored arc
// must still cover the reflected span rather than its complement.
reset();
{
  api.startCommand('ARC');
  api.commitPoint(P(7, 0));   // start
  api.commitPoint(P(5 + 2 * Math.cos(Math.PI / 4), 2 * Math.sin(Math.PI / 4))); // through 45°
  api.commitPoint(P(5, 2));   // end
  const arc = api.entities[api.entityCount - 1];
  check('ARC setup produced an arc', arc?.type === 'ARC', arc?.type);

  const beforeStart = arcPointAt(arc, 0);
  const beforeEnd = arcPointAt(arc, 1);
  const beforeMid = arcPointAt(arc, 0.5);

  selectOnly(arc.id);
  api.startCommand('MIRROR');
  api.commitPoint(P(0, 0));
  api.commitPoint(P(0, 1)); // the Y axis
  api.submitCommandText('Y');
  const moved = entityById(arc.id);

  const afterStart = arcPointAt(moved, 0);
  const afterEnd = arcPointAt(moved, 1);
  const afterMid = arcPointAt(moved, 0.5);

  check('MIRROR keeps the arc radius', near(moved.radius, arc.radius));
  check('MIRROR reflects the arc centre', pointNear(moved.center, -arc.center.x, arc.center.y));
  check('MIRROR preserves the arc sweep magnitude',
    near(Math.abs(moved.endAngle - moved.startAngle), Math.abs(arc.endAngle - arc.startAngle)),
    `${moved.endAngle - moved.startAngle} vs ${arc.endAngle - arc.startAngle}`);
  // Reflection reverses orientation, so the old end becomes the new start.
  check('MIRROR maps the arc end onto the new arc start',
    pointNear(afterStart, -beforeEnd.x, beforeEnd.y, 1e-6),
    `${JSON.stringify(afterStart)} vs reflected ${JSON.stringify(beforeEnd)}`);
  check('MIRROR maps the arc start onto the new arc end',
    pointNear(afterEnd, -beforeStart.x, beforeStart.y, 1e-6),
    `${JSON.stringify(afterEnd)} vs reflected ${JSON.stringify(beforeStart)}`);
  // The decisive check: the midpoint of the swept span must land on the
  // reflected midpoint, not on the far side of the circle.
  check('MIRROR keeps the arc on the reflected span, not its complement',
    pointNear(afterMid, -beforeMid.x, beforeMid.y, 1e-6),
    `${JSON.stringify(afterMid)} vs reflected ${JSON.stringify(beforeMid)}`);
}

// Text mirrors its insertion point but stays readable (AutoCAD MIRRTEXT=0).
reset();
{
  api.startCommand('TEXT');
  api.commitPoint(P(4, 1));
  api.commitDistance(1);
  api.submitCommandText('0');
  api.submitCommandText('NORTH');
  const text = api.entities[api.entityCount - 1];
  check('TEXT setup placed text', text?.type === 'TEXT', text?.type);

  selectOnly(text.id);
  api.startCommand('MIRROR');
  api.commitPoint(P(0, 0));
  api.commitPoint(P(0, 1));
  api.submitCommandText('Y');
  const moved = entityById(text.id);
  check('MIRROR reflects the text insertion point', pointNear(moved.position, -4, 1),
    JSON.stringify(moved.position));
  check('MIRROR keeps text readable rather than flipping it', near(moved.rotation, text.rotation),
    `${moved.rotation} vs ${text.rotation}`);
  check('MIRROR keeps the text content and height',
    moved.content === 'NORTH' && near(moved.height, text.height));
}

// A mirrored copy of geometry plus its dimension must measure the copy, not
// the original — this is what remapEntityReferences is for.
reset();
{
  const line = drawLine(P(2, 0), P(8, 0));
  api.startCommand('DIMLINEAR');
  api.commitPoint(P(2, 0));
  api.commitPoint(P(8, 0));
  api.commitPoint(P(5, -2));
  const dim = api.entities[api.entityCount - 1];
  check('DIM setup produced a dimension', dim?.type === 'DIM', dim?.type);
  const dimRefIds = (dim.refs || []).filter(Boolean).map(r => r.entityId);
  check('DIM setup captured references to the line',
    dimRefIds.length === 2 && dimRefIds.every(id => id === line.id),
    JSON.stringify(dim.refs));

  selectOnly(line.id, dim.id);
  api.startCommand('MIRROR');
  api.commitPoint(P(0, 0));
  api.commitPoint(P(0, 1));
  api.acceptDefaultAction(); // keep the source
  check('MIRROR copied both the line and its dimension', api.entityCount === 4, `count ${api.entityCount}`);

  const copiedDim = api.entities.find(e => e.type === 'DIM' && e.id !== dim.id);
  const copiedLine = api.entities.find(e => e.type === 'LINE' && e.id !== line.id);
  const copiedRefIds = (copiedDim.refs || []).filter(Boolean).map(r => r.entityId);
  check('the mirrored dimension references the mirrored line, not the original',
    copiedRefIds.length === 2 && copiedRefIds.every(id => id === copiedLine.id),
    `refs ${JSON.stringify(copiedRefIds)} line ${copiedLine.id} original ${line.id}`);
  check('the original dimension still references the original line',
    (entityById(dim.id).refs || []).filter(Boolean).every(r => r.entityId === line.id));
  check('the mirrored dimension measures the same length',
    near(api.dimensionGeometry(copiedDim).measure, api.dimensionGeometry(dim).measure),
    `${api.dimensionGeometry(copiedDim).measure} vs ${api.dimensionGeometry(dim).measure}`);
}

// A degenerate mirror line names no direction and must be refused.
reset();
{
  const a = drawLine(P(2, 1), P(6, 3));
  selectOnly(a.id);
  api.startCommand('MIRROR');
  api.commitPoint(P(3, 3));
  api.commitPoint(P(3, 3));
  check('MIRROR refuses a zero-length mirror line', api.operationStage === 'SECOND', api.operationStage);
  check('MIRROR says why it refused', /two distinct points/.test(api.promptText), api.promptText);
  check('MIRROR changed nothing on the refusal', api.entityCount === 1);
}

// Esc must abandon, never commit.
reset();
{
  const a = drawLine(P(2, 1), P(6, 3));
  selectOnly(a.id);
  api.startCommand('MIRROR');
  api.commitPoint(P(0, 0));
  api.commitPoint(P(0, 1));
  api.cancelCurrent();
  check('Esc abandons MIRROR without committing', api.entityCount === 1, `count ${api.entityCount}`);
  const untouched = entityById(a.id);
  check('Esc left the original geometry alone',
    pointNear(untouched.a, 2, 1) && pointNear(untouched.b, 6, 3));
}

// Mirrored geometry has to survive a save/reopen unchanged.
reset();
{
  const a = drawLine(P(2, 1), P(6, 3));
  selectOnly(a.id);
  api.startCommand('MIRROR');
  api.commitPoint(P(0, 0));
  api.commitPoint(P(0, 1));
  api.acceptDefaultAction();
  const before = api.entities;
  const text = api.exportDocumentText();
  api.newDrawing();
  api.importDocumentText(text);
  const after = api.entities;
  check('mirrored geometry round-trips through the native format',
    JSON.stringify(after) === JSON.stringify(before),
    `${after.length} vs ${before.length} entities`);
}

// MIRROR is a transform, so a repeat should reopen it like MOVE or ROTATE.
reset();
{
  const a = drawLine(P(2, 1), P(6, 3));
  selectOnly(a.id);
  api.startCommand('MIRROR');
  api.commitPoint(P(0, 0));
  api.commitPoint(P(0, 1));
  api.submitCommandText('Y');
  check('MIRROR records itself as the last command', api.lastCommand === 'MIRROR', api.lastCommand);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
