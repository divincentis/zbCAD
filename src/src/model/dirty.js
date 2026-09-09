import { AUTOSAVE_BACKUP_KEY, AUTOSAVE_KEY } from '../core/constants.js';
import { readAutosaveRecord, writeAutosaveRecord, writeAutosaveRecordSync } from './autosaveStore.js';
import { exportDocumentText, parseDocumentText } from './document.js';
import { state } from '../state.js';
import { setAutosaveStatus, setFileStatus } from '../ui/status.js';

export let autosaveTimer = null;

// Bumped once per change to the document, so an autosave that resolves after a
// later edit can tell that it no longer describes the drawing on screen.
export let autosaveGeneration = 0;

// The backup holds the drawing as it stood when the current one replaced it, and
// is written ONCE per document. Rotating it on every autosave gave a recovery
// window of a single edit, which is not a recovery window at all: decline the
// startup prompt, draw two lines, and the drawing you meant to keep was gone.
export let backupPinned = false;

// Opening a file, starting a new drawing, or recovering makes the outgoing
// drawing the thing worth preserving, so the pin is released at those points.
export function releaseBackupPin() {
  backupPinned = false;
}

export async function writeAutosave() {
  // Validate first: an invalid live document must not touch either saved copy.
  const text = exportDocumentText(false);
  if (!backupPinned) {
    const previous = await readAutosaveRecord(AUTOSAVE_KEY);
    if (previous && previous.text !== text && !parseDocumentText(previous.text).error) {
      try {
        await writeAutosaveRecord(AUTOSAVE_BACKUP_KEY, previous.text);
        backupPinned = true;
      } catch {
        // A full or unavailable store must not stop the primary autosave. The
        // backup is a convenience; the primary is the drawing. Try again on the
        // next write rather than failing the whole save.
      }
    }
  }
  await writeAutosaveRecord(AUTOSAVE_KEY, text);
  return true;
}

// The page is going away, and an IndexedDB transaction opened here would very
// likely be aborted before it commits, so this one write stays synchronous.
// It only ever covers the edits made since the last autosave settled — at most
// the debounce window — and the next successful autosave clears it again.
export function writeAutosaveOnUnload() {
  writeAutosaveRecordSync(AUTOSAVE_KEY, exportDocumentText(false));
  return true;
}

export function scheduleAutosave() {
  if (!state.documentDirty) return;
  setAutosaveStatus('pending');
  autosaveGeneration += 1;
  if (autosaveTimer !== null) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    const generation = autosaveGeneration;
    writeAutosave().then(() => {
      // The write is asynchronous now, so the drawing can have moved on while
      // it was in flight. Clearing the flag for a save that no longer describes
      // the document would also suppress the beforeunload write of the edits it
      // missed, which is exactly the case that path exists for.
      if (generation !== autosaveGeneration) return;
      state.documentDirty = false;
      setFileStatus(`${state.drawingName} · Autosaved`);
      setAutosaveStatus('saved');
    }, error => {
      setFileStatus(`Autosave failed — saved recovery copies retained. ${error.message || 'Use Save.'}`, true);
      setAutosaveStatus('error');
    });
  }, 250);
}

// Single place that marks the document changed. Autosave is driven from here
// rather than from draw(), so persistence is no longer tied to the render loop.
export function markDirty() {
  state.documentDirty = true;
  scheduleAutosave();
}
