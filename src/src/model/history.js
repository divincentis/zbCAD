import { documentChanged } from '../events.js';
import { markDirty } from './dirty.js';
import { documentSnapshot, editSnapshot, restoreEditSnapshot, validateDocumentData } from './document.js';
import { state } from '../state.js';
import { updatePrompt } from '../ui/prompt.js';
import { draw } from '../view/frame.js';

export function pushHistory() {
  state.history.push(editSnapshot());
  if (state.history.length > 100) state.history.shift();
  state.future.length = 0;
  markDirty();
}

// Build a complete candidate without mutating entities, IDs, history, or the
// command stage. Only a validated candidate may enter the undoable document.
export function commitGeometry(entities, options = {}) {
  const candidate = {
    ...documentSnapshot(), entities,
    nextId: options.nextId ?? state.nextId,
    units: options.unitSettings ?? state.unitSettings,
    dimStyles: options.dimStyles ?? state.dimStyles,
  };
  if (!Number.isSafeInteger(candidate.nextId) || candidate.nextId <= 0) {
    updatePrompt('Edit rejected: no valid entity IDs remain.');
    return false;
  }
  const checked = validateDocumentData(candidate);
  if (checked.error) {
    updatePrompt(`Edit rejected: ${checked.error}`);
    return false;
  }
  pushHistory();
  state.entities = checked.document.entities;
  state.nextId = checked.document.nextId;
  state.unitSettings = checked.document.unitSettings;
  state.dimStyles = checked.document.dimStyles;
  return true;
}

export function undo() {
  if (!state.history.length) return;
  state.future.push(editSnapshot());
  restoreEditSnapshot(state.history.pop());
  state.selected.clear();
  markDirty();
  documentChanged();
  draw();
}

export function redo() {
  if (!state.future.length) return;
  state.history.push(editSnapshot());
  restoreEditSnapshot(state.future.pop());
  state.selected.clear();
  markDirty();
  documentChanged();
  draw();
}
