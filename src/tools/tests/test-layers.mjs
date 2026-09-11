import { boot, DEFAULT_BUNDLE } from './harness.mjs';

const BUNDLE = process.argv[2] || DEFAULT_BUNDLE;

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) { passed++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const { api } = boot(BUNDLE);

async function reset() {
  await api.newDrawing();
}

// New layers get sensible defaults for the three new record fields.
await reset();
{
  const layer0 = api.layers.find(l => l.id === '0');
  check('layer 0 defaults to continuous', layer0.linetype === 'continuous');
  check('layer 0 defaults to 0.25mm lineweight', layer0.lineweight === 0.25);
  check('layer 0 defaults to printable', layer0.printable === true);

  const id = api.createLayer('Walls');
  const walls = api.layers.find(l => l.id === id);
  check('new layer defaults to continuous', walls.linetype === 'continuous');
  check('new layer defaults to 0.25mm lineweight', walls.lineweight === 0.25);
  check('new layer defaults to printable', walls.printable === true);
}

// Setters accept valid values and reject invalid ones.
await reset();
{
  const id = api.createLayer('Hidden Lines');
  check('setLayerLinetype accepts a listed linetype', api.setLayerLinetype(id, 'dashed') === true);
  check('linetype actually changed', api.layers.find(l => l.id === id).linetype === 'dashed');
  check('setLayerLinetype rejects an unlisted linetype', api.setLayerLinetype(id, 'squiggly') === false);
  check('rejected linetype left the layer unchanged', api.layers.find(l => l.id === id).linetype === 'dashed');

  check('setLayerLineweight accepts a listed weight', api.setLayerLineweight(id, 0.50) === true);
  check('lineweight actually changed', api.layers.find(l => l.id === id).lineweight === 0.50);
  check('setLayerLineweight accepts a value passed as a string', api.setLayerLineweight(id, '0.90') === true);
  check('string weight coerced to a number', api.layers.find(l => l.id === id).lineweight === 0.90);
  check('setLayerLineweight rejects a value off the standard table', api.setLayerLineweight(id, 0.37) === false);
  check('rejected lineweight left the layer unchanged', api.layers.find(l => l.id === id).lineweight === 0.90);

  check('toggleLayerPrintable flips printable off', api.toggleLayerPrintable(id) === true);
  check('layer is now non-printable', api.layers.find(l => l.id === id).printable === false);
  check('toggleLayerPrintable flips printable back on', api.toggleLayerPrintable(id) === true);
  check('layer is printable again', api.layers.find(l => l.id === id).printable === true);

  check('setters reject an unknown layer id', api.setLayerLinetype('nonexistent', 'dashed') === false);
}

// The new fields round-trip through save/load.
await reset();
{
  const id = api.createLayer('Center Lines');
  api.setLayerLinetype(id, 'center');
  api.setLayerLineweight(id, 1.00);
  api.toggleLayerPrintable(id);

  const text = api.exportDocumentText();
  const saved = JSON.parse(text);
  const savedLayer = saved.layers.find(l => l.id === id);
  check('linetype is present in the saved JSON', savedLayer.linetype === 'center');
  check('lineweight is present in the saved JSON', savedLayer.lineweight === 1.00);
  check('printable is present in the saved JSON', savedLayer.printable === false);

  await reset();
  check('reopening the saved document succeeds', await api.importDocumentText(text) === true);
  const reloaded = api.layers.find(l => l.id === id);
  check('linetype survived a save/reload round trip', reloaded?.linetype === 'center');
  check('lineweight survived a save/reload round trip', reloaded?.lineweight === 1.00);
  check('printable survived a save/reload round trip', reloaded?.printable === false);
}

// A pre-existing v4 file (no linetype/lineweight/printable on its layers,
// and no version bump) must still open, with the three fields defaulted
// exactly as a v4 drawing would have looked if it could have held them.
await reset();
{
  const text = api.exportDocumentText();
  const v4 = JSON.parse(text);
  v4.version = 4;
  for (const layer of v4.layers) {
    delete layer.linetype;
    delete layer.lineweight;
    delete layer.printable;
  }
  const layerId = v4.layers[0].id;

  check('a v4 document with no layer record fields still opens', await api.importDocumentText(JSON.stringify(v4)) === true);
  const migrated = api.layers.find(l => l.id === layerId);
  check('migrated layer defaults to continuous', migrated.linetype === 'continuous');
  check('migrated layer defaults to 0.25mm lineweight', migrated.lineweight === 0.25);
  check('migrated layer defaults to printable', migrated.printable === true);
}

// A file carrying garbage in the new fields is cleaned up rather than
// rejected outright or trusted verbatim.
await reset();
{
  const text = api.exportDocumentText();
  const doc = JSON.parse(text);
  doc.layers[0].linetype = 'not-a-real-linetype';
  doc.layers[0].lineweight = 999;
  doc.layers[0].printable = 'yes';
  const layerId = doc.layers[0].id;

  check('a document with invalid layer record values still opens', await api.importDocumentText(JSON.stringify(doc)) === true);
  const cleaned = api.layers.find(l => l.id === layerId);
  check('invalid linetype falls back to continuous', cleaned.linetype === 'continuous');
  check('out-of-table lineweight falls back to the default', cleaned.lineweight === 0.25);
  check('non-boolean printable is treated as truthy-by-default (only literal false excludes)', cleaned.printable === true);
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
