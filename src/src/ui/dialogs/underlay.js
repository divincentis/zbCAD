import { requireIdle } from '../../commands/registry.js';
import { formatLengthLabel } from '../../core/units.js';
import { canvas, underlayDialog, underlayDialogSubject, underlayFadeInput, underlayLockedCheck, underlayPlotCheck, underlayPreviewEl } from '../../dom.js';
import { commitGeometry } from '../../model/history.js';
import { underlayHeight, underlayIsSelectable, underlaySelectionId, underlayWidth } from '../../model/underlay.js';
import { state } from '../../state.js';
import { updatePrompt } from '../prompt.js';
import { setFileStatus } from '../status.js';
import { draw } from '../../view/frame.js';

// The draft the dialog edits, kept separate from the underlay itself so Cancel
// is free and Apply is a single undoable commit — the same shape the units and
// dimension-style dialogs use.
export let pendingUnderlay = null;

export function setPendingUnderlay(patch) {
  if (!pendingUnderlay) return;
  Object.assign(pendingUnderlay, patch);
  refreshUnderlayDialog();
}

function dialogTarget() {
  const selected = state.underlays.filter(underlay =>
    state.selected.has(underlaySelectionId(underlay.id)));
  if (selected.length === 1) return selected[0];
  // A single unlocked image in the drawing is unambiguous even unselected;
  // asking the user to select it first would be ceremony, not clarity.
  const selectable = state.underlays.filter(underlayIsSelectable);
  return selectable.length === 1 ? selectable[0] : null;
}

export function openUnderlayDialog() {
  if (!requireIdle('changing image properties')) return;
  const target = dialogTarget();
  if (!target) {
    updatePrompt(state.underlays.length
      ? 'Select one image first.'
      : 'There is no image in the drawing. Use the Image button to place one.');
    return;
  }
  pendingUnderlay = {
    id: target.id,
    fade: target.fade,
    locked: target.locked,
    plot: target.plot,
  };
  underlayDialog.hidden = false;
  refreshUnderlayDialog();
  underlayFadeInput.focus();
}

export function closeUnderlayDialog() {
  pendingUnderlay = null;
  underlayDialog.hidden = true;
  canvas.focus();
}

export function refreshUnderlayDialog() {
  if (!pendingUnderlay) return;
  const target = state.underlays.find(underlay => underlay.id === pendingUnderlay.id);
  if (!target) { closeUnderlayDialog(); return; }
  underlayFadeInput.value = String(pendingUnderlay.fade);
  underlayLockedCheck.checked = pendingUnderlay.locked;
  underlayPlotCheck.checked = pendingUnderlay.plot;
  underlayDialogSubject.textContent =
    `${target.name} · ${target.widthPx} × ${target.heightPx} pixels`;
  underlayPreviewEl.textContent =
    `${formatLengthLabel(underlayWidth(target))} × ${formatLengthLabel(underlayHeight(target))} · fade ${pendingUnderlay.fade}%`;
}

export function applyUnderlayDialog() {
  if (!pendingUnderlay) return;
  const target = state.underlays.find(underlay => underlay.id === pendingUnderlay.id);
  if (!target) { closeUnderlayDialog(); return; }
  const unchanged = target.fade === pendingUnderlay.fade
    && target.locked === pendingUnderlay.locked
    && target.plot === pendingUnderlay.plot;
  if (unchanged) { closeUnderlayDialog(); return; }
  const underlays = state.underlays.map(underlay => underlay.id === target.id
    ? { ...underlay, fade: pendingUnderlay.fade, locked: pendingUnderlay.locked, plot: pendingUnderlay.plot }
    : underlay);
  if (!commitGeometry(state.entities, { underlays })) return;
  setFileStatus(`${state.drawingName} · Image ${pendingUnderlay.plot ? 'will plot' : 'is reference only'}`);
  closeUnderlayDialog();
  draw();
}

export function deleteUnderlayFromDialog() {
  if (!pendingUnderlay) return;
  const target = state.underlays.find(underlay => underlay.id === pendingUnderlay.id);
  if (!target) { closeUnderlayDialog(); return; }
  const underlays = state.underlays.filter(underlay => underlay.id !== target.id);
  if (!commitGeometry(state.entities, { underlays })) return;
  state.selected.delete(underlaySelectionId(target.id));
  closeUnderlayDialog();
  updatePrompt(`Removed image ${target.name}.`);
  draw();
}
