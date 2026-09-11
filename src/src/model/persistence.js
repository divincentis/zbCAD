import { requireIdle, setMode } from '../commands/registry.js';
import { AUTOSAVE_BACKUP_KEY, AUTOSAVE_KEY, LEGACY_AUTOSAVE_KEYS } from '../core/constants.js';
import { createDefaultLayers, defaultDimStyle, defaultUnitSettings, derivedNextLayerId } from '../core/defaults.js';
import { openInput } from '../dom.js';
import { documentChanged } from '../events.js';
import { readAutosaveRecord } from './autosaveStore.js';
import { autosaveTimer, markDirty, releaseBackupPin, scheduleAutosave, writeAutosave } from './dirty.js';
import { exportDocumentText, parseDocumentText } from './document.js';
import { state } from '../state.js';
import { setAutosaveStatus, setFileStatus } from '../ui/status.js';
import { zoomExtents } from '../view/viewport.js';

// New and Open replace the live document outright. If there is an edit newer
// than what's actually persisted — still sitting in the debounced autosave
// timer — flushing it here, before state is wiped, is what lets the next
// autosave's backup rotation actually preserve it, instead of the pending
// write simply being cancelled by scheduleAutosave() (see dirty.js) with
// nothing ever written anywhere to show for it.
//
// Recovery deliberately does not go through this: it already reads a specific
// autosave record and decides whether to promote it into the primary slot
// based on that read, and flushing the live document in the middle of that
// (applyDocument is what recovery uses to land the recovered copy) would
// overwrite the very record recovery just decided about. The live document at
// that point is also what recovery's own confirmation prompt already asked
// about discarding, so there is nothing new happening on the way out that the
// user has not already been told about.
async function flushOutgoingDocument() {
  if (!state.documentDirty) return;
  if (autosaveTimer !== null) { clearTimeout(autosaveTimer); autosaveTimer = null; }
  try {
    await writeAutosave();
  } catch (error) {
    setFileStatus(`Could not save the current drawing before replacing it: ${error.message || 'unknown error'}`, true);
  }
}

export async function applyDocument(documentData, dirty = true) {
  releaseBackupPin();
  state.entities = JSON.parse(JSON.stringify(documentData.entities));
  state.layers = JSON.parse(JSON.stringify(documentData.layers));
  state.currentLayerId = documentData.currentLayerId;
  state.drawingName = documentData.name;
  state.unitSettings = { ...documentData.unitSettings };
  state.dimStyles = documentData.dimStyles.map(style => ({ ...style }));
  state.nextId = documentData.nextId;
  state.nextLayerId = documentData.nextLayerId || derivedNextLayerId(state.layers);
  state.selected.clear();
  state.history = [];
  state.future = [];
  state.documentDirty = dirty;
  if (dirty) scheduleAutosave();
  else setAutosaveStatus('saved');
  setMode('SELECT');
  documentChanged();
  zoomExtents();
}

export async function loadDocumentText(text, sourceName = '') {
  const parsed = parseDocumentText(text);
  if (parsed.error) {
    setFileStatus(parsed.error, true);
    return false;
  }
  if (parsed.document.name === 'Untitled' && sourceName) {
    parsed.document.name = sourceName.replace(/(?:\.zbCAD)?\.json$/i, '').trim() || 'Untitled';
  }
  await flushOutgoingDocument();
  await applyDocument(parsed.document, true);
  setFileStatus(`${state.drawingName} · Opened`);
  return true;
}

// Asynchronous, because the autosave store is: the drawing comes back a few
// milliseconds after boot rather than during it. `onlyIfUntouched` covers the
// gap that opens up — a recovery offer that arrives after the user has already
// started drawing must not take their work away from them.
export async function restoreAutosave(skipConfirmation = false, backupOnly = false, onlyIfUntouched = false) {
  if (backupOnly && !requireIdle('recovering a backup')) return false;
  try {
    const keys = backupOnly ? [AUTOSAVE_BACKUP_KEY] :
      [AUTOSAVE_KEY, AUTOSAVE_BACKUP_KEY, ...LEGACY_AUTOSAVE_KEYS];
    for (const key of keys) {
      const record = await readAutosaveRecord(key);
      if (!record) continue;
      const parsed = parseDocumentText(record.text);
      if (parsed.error) continue;
      if (onlyIfUntouched && (state.entities.length || state.documentDirty)) return false;
      // Restoring without asking silently replaced a deliberately blank session
      // with the previous drawing, and the single autosave slot meant the
      // discarded one was then overwritten.
      const count = parsed.document.entities.length;
      const fromBackup = key === AUTOSAVE_BACKUP_KEY;
      if (!skipConfirmation && !window.confirm(
        `Recover ${fromBackup ? 'the previous backup of' : 'the unsaved drawing'} "${parsed.document.name}" (${count} ${count === 1 ? 'object' : 'objects'})?\n\n` +
        (backupOnly ? 'This replaces the current drawing. Use Save first if you need a separate copy. Cancel keeps the current drawing.' :
          'Choose Cancel to start a blank drawing. Recovery copies remain available until later changes are autosaved.'),
      )) return false;
      await applyDocument(parsed.document, false);
      // Anything but the live primary — a backup, a legacy key, or the copy the
      // unload path left in localStorage — is promoted to the primary at once,
      // so the next autosave cannot overwrite the drawing that was recovered.
      if (key !== AUTOSAVE_KEY || record.source !== 'db') {
        try { await writeAutosave(); } catch {
          setFileStatus('Drawing recovered; could not refresh autosave. Use Save.', true);
          return true;
        }
      }
      setFileStatus(`${state.drawingName} · Recovered${fromBackup ? ' previous backup' : ''}`);
      return true;
    }
    if (backupOnly) setFileStatus('No valid previous backup is available.', true);
    return false;
  } catch {
    setFileStatus('Autosave unavailable — use Save', true);
    return false;
  }
}

export async function newDrawing(skipConfirmation = false) {
  if (!skipConfirmation && state.entities.length &&
      !window.confirm('Start a new drawing? Use Save first if you need a separate copy of the current drawing.')) {
    return false;
  }
  await flushOutgoingDocument();
  releaseBackupPin();
  state.entities = [];
  state.layers = createDefaultLayers();
  state.currentLayerId = '0';
  state.drawingName = 'Untitled';
  state.unitSettings = defaultUnitSettings();
  state.dimStyles = [defaultDimStyle()];
  state.nextId = 1;
  state.nextLayerId = 1;
  state.selected.clear();
  state.history = [];
  state.future = [];
  markDirty();
  setMode('SELECT');
  documentChanged();
  zoomExtents();
  setFileStatus('Untitled · New drawing');
  return true;
}

// The drawing name reduced to something a file system will accept, without a
// suffix — the caller adds the one that describes what it is writing.
export function safeDrawingFileName() {
  const safeName = state.drawingName
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim();
  return safeName || 'drawing';
}

export function drawingDownloadName() {
  return `${safeDrawingFileName()}.zbCAD.json`;
}

// The browser's only "save as" is a click on an anchor, so every file this app
// hands the user leaves through here rather than each writer repeating it.
export function downloadTextFile(text, filename, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function saveDrawing() {
  try {
    downloadTextFile(exportDocumentText(true), drawingDownloadName(), 'application/json');
    setFileStatus(`${state.drawingName} · Saved file`);
    return true;
  } catch (error) {
    setFileStatus(`Could not save: ${error.message || 'Could not create the drawing file'}`, true);
    return false;
  }
}

export function chooseOpenFile() {
  openInput.value = '';
  openInput.click();
}
