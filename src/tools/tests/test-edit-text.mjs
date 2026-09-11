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

function entityById(id) { return api.entities.find(e => e.id === id); }

// ---------------------------------------------------------------------------
// TEXT: retype content in place
// ---------------------------------------------------------------------------
await reset();
{
  const text = placeText(P(10, 20), 2, 15, 'ORIGINAL');
  const ok = api.startTextEdit(entityById(text.id));
  check('startTextEdit accepts a TEXT entity', ok === true);
  check('mode enters TEXT to edit', api.state.mode === 'TEXT');
  check('edit jumps straight to CONTENT', api.state.text?.stage === 'CONTENT');
  check('edit seeds the live content with the existing text', api.state.text?.liveContent === 'ORIGINAL');
  check('the entity being edited is not drawn as itself meanwhile',
    api.state.text?.editingId === text.id);

  api.submitCommandText('RENAMED');
  const after = entityById(text.id);
  check('content is updated in place', after.content === 'RENAMED');
  check('position is unchanged', pointNear(after.position, 10, 20));
  check('height is unchanged', near(after.height, 2));
  check('rotation is unchanged', near(after.rotation, 15 * Math.PI / 180));
  check('id is unchanged (edited, not replaced)', after.id === text.id);
  check('entity count did not grow', api.entityCount === 1);
  check('mode returns to SELECT', api.state.mode === 'SELECT');
  check('the edited entity ends up selected', api.state.selected.has(text.id));
}

// ---------------------------------------------------------------------------
// MTEXT: retype content in place, width/wrap preserved
// ---------------------------------------------------------------------------
await reset();
{
  const mtext = placeMText(P(0, 0), 40, 3, 0, ['LINE ONE', 'LINE TWO']);
  api.startTextEdit(entityById(mtext.id));
  check('edit previews the existing content before any keystroke',
    api.state.text?.liveContent === 'LINE ONE\nLINE TWO');
  check('edit starts with an empty line buffer, not the old lines appended to',
    api.state.text?.lines.length === 0);

  // Replace with three fresh lines.
  api.submitCommandText('A');
  api.submitCommandText('B');
  api.submitCommandText('C');
  api.submitCommandText(''); // blank line commits
  const after = entityById(mtext.id);
  check('MTEXT content replaced with the new lines', after.content === 'A\nB\nC');
  check('MTEXT width is unchanged', near(after.width, 40));
  check('MTEXT height is unchanged', near(after.height, 3));
  check('entity count did not grow', api.entityCount === 1);
}

// ---------------------------------------------------------------------------
// Canceling an edit leaves the original content untouched
// ---------------------------------------------------------------------------
await reset();
{
  const text = placeText(P(0, 0), 2, 0, 'KEEP ME');
  api.startTextEdit(entityById(text.id));
  api.cancelCurrent();
  check('Esc during an edit leaves content unchanged', entityById(text.id).content === 'KEEP ME');
  check('Esc returns to SELECT', api.state.mode === 'SELECT');
}

// ---------------------------------------------------------------------------
// startTextEdit refused because another command is already running must not
// leave anything behind that hijacks the next real command.
// ---------------------------------------------------------------------------
await reset();
{
  const text = placeText(P(0, 0), 2, 0, 'FIRST');
  api.startTextEdit(entityById(text.id)); // now mid-edit, mode TEXT
  const blocked = api.startTextEdit(entityById(text.id)); // refused: already running
  check('a second startTextEdit while one is in progress is refused', blocked === false);
  api.cancelCurrent();

  const fresh = placeText(P(5, 5), 2, 0, 'SECOND');
  check('placing new text afterward is unaffected', fresh?.content === 'SECOND');
  check('the refused call did not turn the new placement into a phantom edit',
    fresh?.id !== text.id);
}

// ---------------------------------------------------------------------------
// A locked or hidden layer refuses the edit
// ---------------------------------------------------------------------------
await reset();
{
  // Layer 0 is current here, and the current layer can't be locked or
  // hidden — a second layer is needed to exercise that gate at all.
  const text = placeText(P(0, 0), 2, 0, 'LOCKED LAYER');
  const otherLayerId = api.createLayer('Other');
  api.state.selected.clear();
  api.state.selected.add(text.id);
  api.assignSelectionToLayer(otherLayerId);
  api.setCurrentLayer('0');

  api.toggleLayerLock(otherLayerId);
  const ok = api.startTextEdit(entityById(text.id));
  check('startTextEdit refuses an entity on a locked layer', ok === false);
  check('mode is untouched', api.state.mode === 'SELECT');
  api.toggleLayerLock(otherLayerId);

  api.toggleLayerVisibility(otherLayerId);
  const ok2 = api.startTextEdit(entityById(text.id));
  check('startTextEdit refuses an entity on a hidden layer', ok2 === false);
  api.toggleLayerVisibility(otherLayerId);

  // A refused startTextEdit must not leave anything behind that would
  // hijack the next unrelated TEXT/MTEXT placement into "editing" a
  // nonexistent entity — see the pendingTextEditId fix in annotate.js.
  const fresh = placeText(P(5, 5), 2, 0, 'STILL WORKS');
  check('a normal placement right after a refused edit still works',
    fresh?.content === 'STILL WORKS');
}

// ---------------------------------------------------------------------------
// startTextEdit refuses non-text entities
// ---------------------------------------------------------------------------
await reset();
{
  api.startCommand('LINE');
  api.commitPoint(P(0, 0));
  api.commitPoint(P(10, 0));
  api.finishCurrent();
  const line = api.entities[0];
  check('startTextEdit refuses a LINE', api.startTextEdit(line) === false);
}

// ---------------------------------------------------------------------------
// Undo restores the pre-edit content
// ---------------------------------------------------------------------------
await reset();
{
  const text = placeText(P(0, 0), 2, 0, 'BEFORE');
  api.startTextEdit(entityById(text.id));
  api.submitCommandText('AFTER');
  check('content is AFTER before undo', entityById(text.id).content === 'AFTER');
  api.navigateHistory('UNDO');
  check('undo restores the pre-edit content', entityById(text.id).content === 'BEFORE');
}

// ---------------------------------------------------------------------------
// updateTextContent directly
// ---------------------------------------------------------------------------
await reset();
{
  const text = placeText(P(0, 0), 2, 0, 'DIRECT');
  const ok = api.updateTextContent(text.id, 'VIA HELPER');
  check('updateTextContent updates the entity', ok === true && entityById(text.id).content === 'VIA HELPER');
  check('updateTextContent refuses an unknown id', api.updateTextContent(9999, 'X') === false);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
