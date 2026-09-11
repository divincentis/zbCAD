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
function selectOnly(...ids) {
  api.state.selected.clear();
  ids.forEach(id => api.state.selected.add(id));
}
function entityById(id) { return api.entities.find(e => e.id === id); }
function linesById(ids) {
  return ids.map(id => entityById(id)).filter(e => e?.type === 'LINE');
}

// ---------------------------------------------------------------------------
// Rectangular — basic grid, typed values
// ---------------------------------------------------------------------------
await reset();
{
  const line = drawLine(P(0, 0), P(1, 0));
  selectOnly(line.id);
  api.startCommand('ARRAY');
  check('ARRAY opens with a preselection at TYPE', api.operationStage === 'TYPE', api.operationStage);

  api.submitCommandText('R');
  check('R keyword moves to ROWS', api.operationStage === 'ROWS', api.operationStage);
  api.submitCommandText('3');
  check('typed rows advances to COLS', api.operationStage === 'COLS', api.operationStage);
  api.submitCommandText('2');
  check('typed cols advances to ROWSPACE', api.operationStage === 'ROWSPACE', api.operationStage);
  api.submitCommandText('5');
  check('typed row spacing advances to COLSPACE', api.operationStage === 'COLSPACE', api.operationStage);
  api.submitCommandText('10');
  check('typed column spacing advances to CONFIRM', api.operationStage === 'CONFIRM', api.operationStage);
  check('CONFIRM previews the grid', api.commandCapabilities?.previewReady === true);

  api.acceptDefaultAction();
  check('rectangular 3x2 array produced 6 total entities', api.entityCount === 6, `count ${api.entityCount}`);
  check('ARRAY completed rather than staying open', !api.commandInProgress());

  const others = api.entities.filter(e => e.id !== line.id);
  const originStarts = others.map(e => `${e.a.x},${e.a.y}`);
  const expected = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 2; col++) {
      if (row === 0 && col === 0) continue;
      expected.push(`${col * 10},${row * 5}`);
    }
  }
  check('every expected grid cell is present exactly once',
    expected.every(key => originStarts.includes(key)) && originStarts.length === expected.length,
    JSON.stringify(originStarts));
  check('the source line was left in place', pointNear(entityById(line.id).a, 0, 0) && pointNear(entityById(line.id).b, 1, 0));
  check('ARRAY selects the whole resulting group', api.selectedIds.length === 6, api.selectedIds.length);
}

// ---------------------------------------------------------------------------
// Rectangular — Enter accepts remembered defaults from the previous run
// ---------------------------------------------------------------------------
await reset();
{
  // Freshly booted defaults are 3x3 at spacing 1x1 — the module remembers
  // this run's 3x2 @ 5x10 from the previous suite's boot only within that
  // process, so re-establish a known baseline before asserting recall.
  const seed = drawLine(P(0, 0), P(1, 0));
  selectOnly(seed.id);
  api.startCommand('ARRAY');
  api.submitCommandText('R');
  api.submitCommandText('2');
  api.submitCommandText('4');
  api.submitCommandText('3');
  api.submitCommandText('7');
  api.acceptDefaultAction();
  check('baseline array seeded remembered settings', api.entityCount === 8, `count ${api.entityCount}`);

  const line = drawLine(P(100, 100), P(101, 100));
  selectOnly(line.id);
  api.startCommand('ARRAY');
  api.acceptDefaultAction(); // TYPE — Enter accepts Rectangular
  check('blank Enter at TYPE defaults to Rectangular', api.operationStage === 'ROWS', api.operationStage);
  api.acceptDefaultAction(); // ROWS — Enter accepts remembered 2
  api.acceptDefaultAction(); // COLS — Enter accepts remembered 4
  api.acceptDefaultAction(); // ROWSPACE — Enter accepts remembered 3
  api.acceptDefaultAction(); // COLSPACE — Enter accepts remembered 7
  check('blank Enters walked through to CONFIRM', api.operationStage === 'CONFIRM', api.operationStage);
  api.acceptDefaultAction();

  const grown = api.entities.filter(e => e.type === 'LINE' && e.id !== line.id &&
    e.a.x >= 100 && e.a.y >= 100);
  check('remembered 2x4 grid at spacing 3x7 was recreated with no typing',
    grown.length === 7, grown.length);
  const hasCell = (row, col) => grown.some(e => near(e.a.x, 100 + col * 7) && near(e.a.y, 100 + row * 3));
  check('recalled spacing/count matches the previous invocation',
    hasCell(0, 1) && hasCell(1, 3) && hasCell(1, 0));
}

// ---------------------------------------------------------------------------
// Rectangular — negative spacing grows the grid left/down
// ---------------------------------------------------------------------------
await reset();
{
  const line = drawLine(P(0, 0), P(1, 0));
  selectOnly(line.id);
  api.startCommand('ARRAY');
  api.submitCommandText('R');
  api.submitCommandText('1');
  api.submitCommandText('3');
  api.submitCommandText('1'); // row spacing irrelevant with 1 row, still required
  api.submitCommandText('-4');
  api.acceptDefaultAction();
  const copies = api.entities.filter(e => e.id !== line.id);
  check('negative column spacing produced 2 copies', copies.length === 2, copies.length);
  check('copies grew in the negative x direction',
    copies.some(e => near(e.a.x, -4)) && copies.some(e => near(e.a.x, -8)),
    JSON.stringify(copies.map(e => e.a.x)));
}

// ---------------------------------------------------------------------------
// Rectangular — input validation
// ---------------------------------------------------------------------------
await reset();
{
  const line = drawLine(P(0, 0), P(1, 0));
  selectOnly(line.id);
  api.startCommand('ARRAY');
  api.submitCommandText('R');
  api.submitCommandText('2.5');
  check('a non-integer row count is rejected', api.operationStage === 'ROWS', api.operationStage);
  check('rejection explains the rule', /whole number/.test(api.promptText), api.promptText);
  api.submitCommandText('0');
  check('a zero row count is rejected too', api.operationStage === 'ROWS', api.operationStage);
  api.submitCommandText('2');
  api.submitCommandText('2');
  api.submitCommandText('0');
  check('zero spacing is rejected', api.operationStage === 'ROWSPACE', api.operationStage);
  check('entities unchanged while the command is still open', api.entityCount === 1);
}

// ---------------------------------------------------------------------------
// Rectangular — a locked layer cannot be arrayed
// ---------------------------------------------------------------------------
await reset();
{
  const wallsId = api.createLayer('WALLS');
  api.setCurrentLayer(wallsId);
  const a = drawLine(P(2, 1), P(6, 3));
  api.setCurrentLayer('0');
  api.toggleLayerLock(wallsId);
  selectOnly(a.id);
  api.startCommand('ARRAY');
  check('ARRAY on a fully-locked selection has nothing to select and asks again',
    api.operationStage === 'SELECT', api.operationStage);
  check('no copies were made of locked geometry', api.entityCount === 1, api.entityCount);
}

// ---------------------------------------------------------------------------
// Polar — full circle, rotate items (the default)
// ---------------------------------------------------------------------------
await reset();
{
  const line = drawLine(P(10, 0), P(12, 0));
  selectOnly(line.id);
  api.startCommand('ARRAY');
  api.submitCommandText('P');
  check('P keyword moves to CENTER', api.operationStage === 'CENTER', api.operationStage);
  check('CENTER stage accepts a point', api.commandCapabilities?.acceptsPoint === true);
  api.commitPoint(P(0, 0));
  check('picking the center advances to ITEMS', api.operationStage === 'ITEMS', api.operationStage);
  api.submitCommandText('4');
  check('typed item count advances to ANGLEFILL', api.operationStage === 'ANGLEFILL', api.operationStage);
  api.acceptDefaultAction(); // accept default 360
  check('blank angle-fill defaults to 360 and advances to ROTATEITEMS',
    api.operationStage === 'ROTATEITEMS', api.operationStage);
  api.acceptDefaultAction(); // accept default Yes (rotate)
  check('blank rotate-items answer defaults to Yes and advances to CONFIRM',
    api.operationStage === 'CONFIRM', api.operationStage);
  api.acceptDefaultAction();

  check('polar array of 4 over a full circle produced 4 total entities',
    api.entityCount === 4, api.entityCount);
  const others = api.entities.filter(e => e.id !== line.id);
  const radius = Math.hypot(11, 0); // distance from center to the line's midpoint
  for (const copy of others) {
    const mid = P((copy.a.x + copy.b.x) / 2, (copy.a.y + copy.b.y) / 2);
    check('each copy keeps its distance from the array center',
      near(Math.hypot(mid.x, mid.y), radius, 1e-6), Math.hypot(mid.x, mid.y));
  }
  const angles = others.map(copy => {
    const mid = P((copy.a.x + copy.b.x) / 2, (copy.a.y + copy.b.y) / 2);
    return ((Math.atan2(mid.y, mid.x) * 180 / Math.PI) + 360) % 360;
  }).sort((x, y) => x - y);
  check('a full circle of 4 lands at 90, 180, 270',
    near(angles[0], 90) && near(angles[1], 180) && near(angles[2], 270),
    JSON.stringify(angles));
  // Rotate=Yes means each copy's own orientation turned with its placement:
  // the 180° copy should point the opposite way from the source.
  const oppositeCopy = others.find(copy => {
    const mid = P((copy.a.x + copy.b.x) / 2, (copy.a.y + copy.b.y) / 2);
    return near(Math.atan2(mid.y, mid.x) * 180 / Math.PI, 180);
  });
  const sourceAngle = Math.atan2(0, 2); // the source line's own direction (horizontal)
  const copyDirection = Math.atan2(oppositeCopy.b.y - oppositeCopy.a.y, oppositeCopy.b.x - oppositeCopy.a.x);
  check('rotate=Yes turned each copy to follow the array',
    near(Math.abs(copyDirection - sourceAngle), Math.PI, 1e-6),
    `${copyDirection} vs ${sourceAngle}`);
}

// ---------------------------------------------------------------------------
// Polar — partial fill spaces across n-1 gaps, not n
// ---------------------------------------------------------------------------
await reset();
{
  const line = drawLine(P(10, 0), P(12, 0));
  selectOnly(line.id);
  api.startCommand('ARRAY');
  api.submitCommandText('P');
  api.commitPoint(P(0, 0));
  api.submitCommandText('4');
  api.submitCommandText('180');
  api.submitCommandText('Y');
  api.acceptDefaultAction();

  const others = api.entities.filter(e => e.id !== line.id);
  check('4 items over a 180 fill produced 3 copies', others.length === 3, others.length);
  const angles = others.map(copy => {
    const mid = P((copy.a.x + copy.b.x) / 2, (copy.a.y + copy.b.y) / 2);
    return (Math.atan2(mid.y, mid.x) * 180 / Math.PI + 360) % 360;
  }).sort((x, y) => x - y);
  check('a 180 fill over 4 items steps by 60 degrees',
    near(angles[0], 60) && near(angles[1], 120) && near(angles[2], 180),
    JSON.stringify(angles));
}

// ---------------------------------------------------------------------------
// Polar — rotate items = No moves the group rigidly without turning it
// ---------------------------------------------------------------------------
await reset();
{
  const line = drawLine(P(10, 0), P(12, 0));
  selectOnly(line.id);
  api.startCommand('ARRAY');
  api.submitCommandText('P');
  api.commitPoint(P(0, 0));
  api.submitCommandText('4');
  api.submitCommandText('360'); // typed explicitly — an earlier test left a
  // partial-fill value remembered as the default, and this one needs a full
  // circle for its radius/angle math.
  api.submitCommandText('N');
  api.acceptDefaultAction();

  const others = api.entities.filter(e => e.id !== line.id);
  check('rotate=No still produced 3 copies', others.length === 3, others.length);
  const sourceDirection = Math.atan2(line.b.y - line.a.y, line.b.x - line.a.x);
  for (const copy of others) {
    const direction = Math.atan2(copy.b.y - copy.a.y, copy.b.x - copy.a.x);
    check('rotate=No keeps every copy at the source orientation',
      near(direction, sourceDirection, 1e-6), direction);
  }
  // The group's own midpoint (its bbox centre, here just the line's midpoint)
  // should itself sit on the 90/180/270 circle around the array centre.
  const midpoints = others.map(copy => P((copy.a.x + copy.b.x) / 2, (copy.a.y + copy.b.y) / 2));
  const radius = Math.hypot(11, 0);
  for (const mid of midpoints) {
    check('rotate=No still carries the group around the array centre at a fixed radius',
      near(Math.hypot(mid.x, mid.y), radius, 1e-6), Math.hypot(mid.x, mid.y));
  }
}

// ---------------------------------------------------------------------------
// Polar array of a dimensioned line keeps each copy's dimension associative
// to its own copy, not the original or another instance's.
// ---------------------------------------------------------------------------
await reset();
{
  const line = drawLine(P(2, 0), P(8, 0));
  api.startCommand('DIMLINEAR');
  api.commitPoint(P(2, 0));
  api.commitPoint(P(8, 0));
  api.commitPoint(P(5, -2));
  const dim = api.entities[api.entityCount - 1];
  check('DIM setup produced a dimension', dim?.type === 'DIM', dim?.type);

  selectOnly(line.id, dim.id);
  api.startCommand('ARRAY');
  api.submitCommandText('P');
  api.commitPoint(P(-20, 0));
  api.submitCommandText('3');
  api.acceptDefaultAction();
  api.acceptDefaultAction(); // rotate = Yes
  api.acceptDefaultAction();

  check('polar array of a line+dimension pair made 3 lines and 3 dims',
    api.entities.filter(e => e.type === 'LINE').length === 3 &&
    api.entities.filter(e => e.type === 'DIM').length === 3,
    JSON.stringify(api.entities.map(e => e.type)));

  const copiedLines = linesById(api.entities.filter(e => e.type === 'LINE').map(e => e.id))
    .filter(e => e.id !== line.id);
  const copiedDims = api.entities.filter(e => e.type === 'DIM' && e.id !== dim.id);
  for (const copiedDim of copiedDims) {
    const refIds = (copiedDim.refs || []).filter(Boolean).map(r => r.entityId);
    const matchingLine = copiedLines.find(l => refIds.includes(l.id));
    check('each copied dimension references its own copied line, not the original or a sibling instance',
      Boolean(matchingLine) && refIds.every(id => id === matchingLine.id),
      `refs ${JSON.stringify(refIds)} lines ${JSON.stringify(copiedLines.map(l => l.id))}`);
    check('each copied dimension still measures the correct length',
      near(api.dimensionGeometry(copiedDim).measure, api.dimensionGeometry(dim).measure),
      `${api.dimensionGeometry(copiedDim).measure} vs ${api.dimensionGeometry(dim).measure}`);
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
