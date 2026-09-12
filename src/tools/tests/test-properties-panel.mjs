import { boot, DEFAULT_BUNDLE, registerStubImage } from './harness.mjs';

const BUNDLE = process.argv[2] || DEFAULT_BUNDLE;

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) { passed++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
function near(a, b, tol = 1e-6) { return Math.abs(a - b) <= tol; }

const { api } = boot(BUNDLE);
const P = (x, y) => ({ x, y });

const JPEG_DATA_URL = 'data:image/jpeg;base64,/9j/2wCEAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAKAAoDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9/KKKKAP/2Q==';
registerStubImage(JPEG_DATA_URL, 10, 10);
function placeUnderlay(origin) {
  api.startImagePlacement({ name: 'aerial', widthPx: 10, heightPx: 10, data: JPEG_DATA_URL });
  api.commitPoint(origin);
  return api.state.underlays[api.state.underlays.length - 1];
}

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
function drawLine(a, b) {
  api.startCommand('LINE');
  api.commitPoint(a);
  api.commitPoint(b);
  api.finishCurrent();
  return api.entities[api.entityCount - 1];
}
// Real command path — insertion point, height, rotation, content — the same
// realistic (non-canonical) sequence a user's clicks and keystrokes produce.
function placeText(position, height, rotationDeg, content) {
  api.startCommand('TEXT');
  api.commitPoint(position);
  api.commitDistance(height);
  api.submitCommandText(String(rotationDeg));
  api.submitCommandText(content);
  return api.entities[api.entityCount - 1];
}
function placeMText(position, width, height, rotationDeg, lines) {
  api.startCommand('MTEXT');
  api.commitPoint(position);
  api.commitPoint(P(position.x + width, position.y));
  api.commitDistance(height);
  api.submitCommandText(String(rotationDeg));
  for (const line of lines) api.submitCommandText(line);
  api.submitCommandText('');
  return api.entities[api.entityCount - 1];
}
function selectOnly(...ids) {
  api.state.selected.clear();
  ids.forEach(id => api.state.selected.add(id));
}
function entityById(id) { return api.entities.find(e => e.id === id); }

// ---------------------------------------------------------------------------
// Nothing selected
// ---------------------------------------------------------------------------
await reset();
{
  check('empty selection reports no summary', api.propertiesSummary === null);
}

// ---------------------------------------------------------------------------
// Homogeneous CIRCLE selection — reads and writes radius
// ---------------------------------------------------------------------------
await reset();
{
  const c = drawCircle(P(0, 0), 5);
  selectOnly(c.id);
  const summary = api.propertiesSummary;
  check('single circle summary reports count 1', summary.count === 1);
  check('single circle summary reports homogeneous CIRCLE', summary.homogeneousType === 'CIRCLE');
  check('single circle summary reports its layer', summary.layerId === '0');
  check('single circle summary reports its radius', near(summary.fields.radius, 5));

  check('applyPropertiesField updates radius', api.applyPropertiesField('radius', '12', false) === true);
  check('radius actually changed', near(entityById(c.id).radius, 12));
  check('post-edit summary reflects new radius', near(api.propertiesSummary.fields.radius, 12));

  check('applyPropertiesField rejects a non-numeric radius', api.applyPropertiesField('radius', 'abc', false) === false);
  check('rejected edit left radius unchanged', near(entityById(c.id).radius, 12));

  check('applyPropertiesField rejects a zero radius', api.applyPropertiesField('radius', '0', false) === false);
  check('applyPropertiesField rejects a negative radius', api.applyPropertiesField('radius', '-3', false) === false);
  check('rejected edits left radius unchanged', near(entityById(c.id).radius, 12));

  api.undo();
  check('undo restored the original radius', near(entityById(c.id).radius, 5));
}

// ---------------------------------------------------------------------------
// A mixed-radius selection reports "Varies" (null), and an edit applies to
// every selected circle at once.
// ---------------------------------------------------------------------------
await reset();
{
  const a = drawCircle(P(0, 0), 3);
  const b = drawCircle(P(20, 0), 7);
  selectOnly(a.id, b.id);
  check('differing radii report as varying (null)', api.propertiesSummary.fields.radius === null);

  check('applying a radius affects the whole selection', api.applyPropertiesField('radius', '9', false) === true);
  check('first circle updated', near(entityById(a.id).radius, 9));
  check('second circle updated', near(entityById(b.id).radius, 9));
  check('selection now reports a common radius', near(api.propertiesSummary.fields.radius, 9));
}

// ---------------------------------------------------------------------------
// TEXT — height, rotation (typed/read in degrees, stored in radians), content
// ---------------------------------------------------------------------------
await reset();
{
  const t = placeText(P(0, 0), 2.5, 30, 'ROOF PLAN');
  selectOnly(t.id);
  const summary = api.propertiesSummary;
  check('text summary is homogeneous TEXT', summary.homogeneousType === 'TEXT');
  check('text summary reports height', near(summary.fields.height, 2.5));
  check('text summary reports rotation in radians (30deg)', near(summary.fields.rotation, 30 * Math.PI / 180));
  check('text summary reports its content', summary.fields.content === 'ROOF PLAN');

  check('applyPropertiesField sets rotation from typed degrees', api.applyPropertiesField('rotation', '90', true) === true);
  check('stored rotation is now 90 degrees in radians', near(entityById(t.id).rotation, Math.PI / 2));

  check('applyPropertiesField updates content', api.applyPropertiesField('content', 'REVISED NOTE', false) === true);
  check('content actually changed', entityById(t.id).content === 'REVISED NOTE');

  check('applyPropertiesField rejects blank content', api.applyPropertiesField('content', '   ', false) === false);
  check('rejected content left the entity unchanged', entityById(t.id).content === 'REVISED NOTE');
}

// ---------------------------------------------------------------------------
// MTEXT — same fields as TEXT plus width
// ---------------------------------------------------------------------------
await reset();
{
  const m = placeMText(P(0, 0), 40, 3, 0, ['General notes:', 'See detail 3/A5.']);
  selectOnly(m.id);
  const summary = api.propertiesSummary;
  check('mtext summary is homogeneous MTEXT', summary.homogeneousType === 'MTEXT');
  check('mtext summary reports width', near(summary.fields.width, 40));
  check('mtext summary reports multi-line content', summary.fields.content === 'General notes:\nSee detail 3/A5.');

  check('applyPropertiesField updates width', api.applyPropertiesField('width', '60', false) === true);
  check('width actually changed', near(entityById(m.id).width, 60));
  check('applyPropertiesField rejects a zero width', api.applyPropertiesField('width', '0', false) === false);
}

// ---------------------------------------------------------------------------
// Mixed entity types — only the shared layer field applies, no per-type field
// ---------------------------------------------------------------------------
await reset();
{
  const line = drawLine(P(0, 0), P(10, 0));
  const circle = drawCircle(P(0, 5), 4);
  selectOnly(line.id, circle.id);
  const summary = api.propertiesSummary;
  check('mixed-type selection reports the total count', summary.count === 2);
  check('mixed-type selection has no homogeneous type', summary.homogeneousType === null);
  check('mixed-type selection has no per-type fields', Object.keys(summary.fields).length === 0);
  check('mixed-type selection still reports a common layer', summary.layerId === '0');

  const wallsId = api.createLayer('Walls');
  check('applyPropertiesField refuses a field with no homogeneous type target',
    api.applyPropertiesField('radius', '5', false) === false);
  check('assignSelectionToLayer still reassigns both entities in a mixed selection',
    api.assignSelectionToLayer(wallsId) === true);
  check('line moved to the new layer', entityById(line.id).layerId === wallsId);
  check('circle moved to the new layer', entityById(circle.id).layerId === wallsId);
}

// ---------------------------------------------------------------------------
// A selection spanning an underlay reports the shared layer only, and
// assignSelectionToLayer now reassigns the underlay too (it silently did not
// before this feature).
// ---------------------------------------------------------------------------
await reset();
{
  const line = drawLine(P(0, 0), P(10, 0));
  const underlay = placeUnderlay(P(0, -20));

  api.state.selected.clear();
  api.state.selected.add(line.id);
  api.state.selected.add(api.underlaySelectionId(underlay.id));

  const summary = api.propertiesSummary;
  check('entity+underlay selection reports both in the count', summary.count === 2);
  check('entity+underlay selection has no homogeneous entity type', summary.homogeneousType === null);
  check('entity+underlay selection reports the shared layer', summary.layerId === '0');

  const wallsId = api.createLayer('Site');
  check('assignSelectionToLayer moves the underlay as well as the line', api.assignSelectionToLayer(wallsId) === true);
  check('line reassigned', entityById(line.id).layerId === wallsId);
  check('underlay reassigned', api.state.underlays.find(u => u.id === underlay.id).layerId === wallsId);
}

// ---------------------------------------------------------------------------
// Mid-command edits are refused, matching every other layer/selection mutator
// ---------------------------------------------------------------------------
await reset();
{
  const c = drawCircle(P(0, 0), 5);
  selectOnly(c.id);
  api.startCommand('LINE');
  check('a command is in progress', api.commandInProgress() === true);
  check('applyPropertiesField refuses to run mid-command', api.applyPropertiesField('radius', '9', false) === false);
  check('radius left untouched by the refused edit', near(entityById(c.id).radius, 5));
  api.cancelCurrent();
  check('command cancelled cleanly', api.commandInProgress() === false);
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
