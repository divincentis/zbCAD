// Autosave and crash recovery. The store is asynchronous now, so nearly every
// check has to wait for a write to settle before asking what was saved.
import { boot, DEFAULT_BUNDLE } from './harness.mjs';

const BUNDLE = process.argv[2] || DEFAULT_BUNDLE;

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) { passed++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const P = (x, y) => ({ x, y });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// Longer than the 250 ms autosave debounce, plus the store's own round trip.
const settle = () => wait(400);

// A whole app instance per scenario: recovery is about what one session left
// behind for the next, so each scenario needs its own empty pair of stores.
async function freshApp(options) {
  const booted = boot(BUNDLE, options);
  await booted.api.newDrawing();
  booted.api.setAllSnapTypes(false);
  return booted;
}

function drawLine(api, a, b) {
  api.startCommand('LINE');
  api.commitPoint(a);
  api.commitPoint(b);
  api.finishCurrent();
  return api.entities[api.entityCount - 1];
}

function entityCountOf(text) {
  return JSON.parse(text).entities.length;
}

// ---------------------------------------------------------------------------
// The autosave itself lands in IndexedDB, and stays off the synchronous path.
// ---------------------------------------------------------------------------
{
  const { api, localStorage } = await freshApp();
  drawLine(api, P(0, 0), P(10, 0));
  check('an edit marks the document dirty', api.state.documentDirty === true);
  await settle();

  const record = await api.readAutosaveRecord(api.autosaveKey);
  check('the drawing was autosaved', !!record);
  check('the autosave came from IndexedDB', record && record.source === 'db', record && record.source);
  check('the autosave holds the drawn line', record && entityCountOf(record.text) === 1);
  check('the autosave is timestamped', record && record.savedAt > 0);
  check('nothing was written to localStorage',
    localStorage.getItem(api.autosaveKey) === null);
  check('a settled autosave clears the dirty flag', api.state.documentDirty === false);
}

// ---------------------------------------------------------------------------
// The unload path: synchronous, localStorage, and newer than the database copy.
// ---------------------------------------------------------------------------
{
  const { api, localStorage } = await freshApp();
  drawLine(api, P(0, 0), P(10, 0));
  await settle();

  // The second line is drawn and the tab closed inside the debounce window, so
  // the database copy is a line behind when the page goes away.
  drawLine(api, P(0, 5), P(10, 5));
  api.writeAutosaveOnUnload();
  const saved = localStorage.getItem(api.autosaveKey);
  check('beforeunload wrote synchronously to localStorage', typeof saved === 'string');
  check('the unload copy holds the edit the database missed',
    saved && entityCountOf(saved) === 2, saved && String(entityCountOf(saved)));
  check('the unload copy is timestamped',
    Number(localStorage.getItem(`${api.autosaveKey}.at`)) > 0);

  const record = await api.readAutosaveRecord(api.autosaveKey);
  check('the newer unload copy wins over the database copy',
    record && record.source === 'local' && entityCountOf(record.text) === 2,
    record && `${record.source}/${entityCountOf(record.text)}`);

  await api.newDrawing();
  check('recovery restored the unload copy', await api.restoreAutosave() && api.entityCount === 2,
    `count ${api.entityCount}`);
  check('the recovered drawing is no longer dirty', api.state.documentDirty === false);
  const promoted = await api.readAutosaveRecord(api.autosaveKey);
  check('recovering from localStorage promotes the drawing into the database',
    promoted && promoted.source === 'db' && entityCountOf(promoted.text) === 2);
  check('the promoted copy replaced the localStorage one',
    localStorage.getItem(api.autosaveKey) === null);
}

// ---------------------------------------------------------------------------
// A stale localStorage copy must not beat a newer database one. An autosave
// written by an older version of this app carries no timestamp at all.
// ---------------------------------------------------------------------------
{
  const { api, localStorage } = await freshApp();
  drawLine(api, P(0, 0), P(10, 0));
  drawLine(api, P(0, 5), P(10, 5));
  await settle();

  const stale = JSON.stringify({
    ...JSON.parse(api.exportDocumentText(false)),
    entities: JSON.parse(api.exportDocumentText(false)).entities.slice(0, 1),
  });
  localStorage.setItem(api.autosaveKey, stale);

  const record = await api.readAutosaveRecord(api.autosaveKey);
  check('an untimestamped localStorage copy loses to the database copy',
    record && record.source === 'db' && entityCountOf(record.text) === 2,
    record && `${record.source}/${entityCountOf(record.text)}`);

  await api.newDrawing();
  await api.restoreAutosave();
  check('recovery took the database copy', api.entityCount === 2, `count ${api.entityCount}`);
}

// ---------------------------------------------------------------------------
// An autosave left by an older version, with no database copy beside it, is
// still recovered — and is moved into the database once it is.
// ---------------------------------------------------------------------------
{
  const { api, localStorage } = await freshApp();
  drawLine(api, P(0, 0), P(10, 0));
  drawLine(api, P(0, 5), P(10, 5));
  const legacy = api.exportDocumentText(false);
  await api.newDrawing();
  await settle();
  // What an older version of this app left behind: the drawing under the
  // autosave key and nothing in IndexedDB. Blanking the database record is how
  // this suite says "no record here" — an empty document reads as absent.
  await api.writeAutosaveRecord(api.autosaveKey, '');
  localStorage.setItem(api.autosaveKey, legacy);

  const record = await api.readAutosaveRecord(api.autosaveKey);
  check('a legacy localStorage autosave is found', record && record.source === 'local');
  await api.newDrawing();
  check('a legacy autosave is recovered', await api.restoreAutosave() && api.entityCount === 2,
    `count ${api.entityCount}`);
  const promoted = await api.readAutosaveRecord(api.autosaveKey);
  check('a recovered legacy autosave is promoted into the database',
    promoted && promoted.source === 'db');
}

// ---------------------------------------------------------------------------
// The backup slot still holds the drawing the current one replaced.
// ---------------------------------------------------------------------------
{
  const { api } = await freshApp();
  drawLine(api, P(0, 0), P(10, 0));
  await settle();
  await api.newDrawing();
  drawLine(api, P(0, 5), P(10, 5));
  drawLine(api, P(0, 6), P(10, 6));
  await settle();

  const primary = await api.readAutosaveRecord(api.autosaveKey);
  const backup = await api.readAutosaveRecord(api.autosaveBackupKey);
  check('the primary slot holds the current drawing', primary && entityCountOf(primary.text) === 2);
  check('the backup slot holds the drawing it replaced', backup && entityCountOf(backup.text) === 1,
    backup && String(entityCountOf(backup.text)));

  // A third edit must not rotate the backup again — one rotation per document
  // is the whole point of the pin.
  drawLine(api, P(0, 7), P(10, 7));
  await settle();
  const backupAgain = await api.readAutosaveRecord(api.autosaveBackupKey);
  check('further edits do not rotate the backup', backupAgain && entityCountOf(backupAgain.text) === 1,
    backupAgain && String(entityCountOf(backupAgain.text)));

  check('Recover Backup restores the previous drawing',
    await api.restoreBackup() && api.entityCount === 1, `count ${api.entityCount}`);
}

// ---------------------------------------------------------------------------
// CAD-005 — New Drawing must not discard an edit still sitting in the
// debounced autosave timer. Drawing a second line and immediately starting a
// new drawing, before that edit's own 250ms autosave ever fires, used to
// cancel the pending timer outright with nothing ever written for it — so the
// two-line drawing was gone from both the primary and the backup slot.
// ---------------------------------------------------------------------------
{
  const { api } = await freshApp();
  drawLine(api, P(0, 0), P(10, 0));
  await settle();
  drawLine(api, P(0, 5), P(10, 5));
  // No settle() here — the second line's own autosave has not fired yet.
  await api.newDrawing();
  await settle();

  const primary = await api.readAutosaveRecord(api.autosaveKey);
  const backup = await api.readAutosaveRecord(api.autosaveBackupKey);
  check('the primary slot holds the new, blank drawing',
    primary && entityCountOf(primary.text) === 0, primary && String(entityCountOf(primary.text)));
  check('the backup slot preserved the outgoing two-line drawing, not just the first line',
    backup && entityCountOf(backup.text) === 2, backup && String(entityCountOf(backup.text)));
}

// ---------------------------------------------------------------------------
// Boot-time recovery must not take work away from a user who was faster than
// the store.
// ---------------------------------------------------------------------------
{
  const { api } = await freshApp();
  drawLine(api, P(0, 0), P(10, 0));
  await settle();

  await api.newDrawing();
  drawLine(api, P(0, 5), P(10, 5));
  const declined = await api.restoreAutosaveIfUntouched();
  check('recovery stands down once the user has drawn something', declined === false);
  check('the drawing in progress survived', api.entityCount === 1, `count ${api.entityCount}`);

  await api.newDrawing();
  api.state.documentDirty = false;
  check('recovery still runs into an untouched session',
    await api.restoreAutosaveIfUntouched() === true);
}

// ---------------------------------------------------------------------------
// A browser that refuses to open a database (a private window) still autosaves.
// ---------------------------------------------------------------------------
{
  const { api, localStorage } = await freshApp({ indexedDB: false });
  drawLine(api, P(0, 0), P(10, 0));
  await settle();

  const saved = localStorage.getItem(api.autosaveKey);
  check('autosave falls back to localStorage without IndexedDB', typeof saved === 'string');
  check('the fallback copy holds the drawing', saved && entityCountOf(saved) === 1);
  const record = await api.readAutosaveRecord(api.autosaveKey);
  check('the fallback copy reads back as a local record', record && record.source === 'local');
  check('the fallback autosave cleared the dirty flag', api.state.documentDirty === false);

  await api.newDrawing();
  check('recovery works without IndexedDB', await api.restoreAutosave() && api.entityCount === 1,
    `count ${api.entityCount}`);
}

// ---------------------------------------------------------------------------
// A database that opens and then refuses every transaction — a storage policy,
// a private window that only fails on use — must still not cost an autosave.
// ---------------------------------------------------------------------------
{
  const { api, localStorage } = await freshApp({ indexedDB: 'broken' });
  drawLine(api, P(0, 0), P(10, 0));
  await settle();

  const saved = localStorage.getItem(api.autosaveKey);
  check('a failing database degrades to a localStorage autosave', typeof saved === 'string');
  check('the degraded copy holds the drawing', saved && entityCountOf(saved) === 1);
  check('a degraded autosave still clears the dirty flag', api.state.documentDirty === false);

  await api.newDrawing();
  check('recovery works through a failing database',
    await api.restoreAutosave() && api.entityCount === 1, `count ${api.entityCount}`);
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('FAILURES:');
  failures.forEach(f => console.log(`  - ${f}`));
  process.exit(1);
}
