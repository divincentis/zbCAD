import { AUTOSAVE_BACKUP_KEY, AUTOSAVE_KEY } from '../core/constants.js';
import { exportDocumentText, parseDocumentText } from './document.js';
import { state } from '../state.js';
import { setFileStatus } from '../ui/status.js';

export let autosaveTimer = null;

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

export function writeAutosave() {
  // Validate first: an invalid live document must not touch either saved copy.
  const text = exportDocumentText(false);
  if (!backupPinned) {
    const previous = window.localStorage.getItem(AUTOSAVE_KEY);
    if (previous && previous !== text && !parseDocumentText(previous).error) {
      try {
        window.localStorage.setItem(AUTOSAVE_BACKUP_KEY, previous);
        backupPinned = true;
      } catch {
        // A full or unavailable store must not stop the primary autosave. The
        // backup is a convenience; the primary is the drawing. Try again on the
        // next write rather than failing the whole save.
      }
    }
  }
  window.localStorage.setItem(AUTOSAVE_KEY, text);
  return true;
}

export function scheduleAutosave() {
  if (!state.documentDirty) return;
  if (autosaveTimer !== null) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    try {
      writeAutosave();
      // Only clear the dirty flag once the write actually succeeded, so a failed
      // autosave does not also suppress the beforeunload save.
      state.documentDirty = false;
      setFileStatus(`${state.drawingName} · Autosaved`);
    } catch (error) {
      setFileStatus(`Autosave failed — saved recovery copies retained. ${error.message || 'Use Save.'}`, true);
    }
  }, 250);
}

// Single place that marks the document changed. Autosave is driven from here
// rather than from draw(), so persistence is no longer tied to the render loop.
export function markDirty() {
  state.documentDirty = true;
  scheduleAutosave();
}
