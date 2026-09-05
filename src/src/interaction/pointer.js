import { resolveCommandName } from '../commands/aliases.js';
import { activeCommand, cancelCurrent, commandSelectsObjects, commitPoint, finishCurrent, navigateHistory, startCommand } from '../commands/registry.js';
import { canvas, commandInput, currentLayerSelect, dimStyleDialog, polarDialog, snapDialog, unitsDialog } from '../dom.js';
import { hitTestGrip, startGripEdit } from '../geometry/grips.js';
import { commitCommandKeyword, commitCommandValue, commitDistance, commitPointInput, parseDistance } from './input.js';
import { deleteSelected, distanceToEntityPx, finishBoxSelection, selectAt } from './selection.js';
import { getActivePoint } from './tracking.js';
import { isEntityEditable } from '../model/layerQuery.js';
import { chooseOpenFile, newDrawing, saveDrawing } from '../model/persistence.js';
import { state } from '../state.js';
import { applyDimStyleDialog, closeDimStyleDialog } from '../ui/dialogs/dimstyle.js';
import { closePolarDialog, closeSnapDialog, setOrtho, setPolar } from '../ui/dialogs/drafting.js';
import { applyUnitsDialog, closeUnitsDialog } from '../ui/dialogs/units.js';
import { updatePrompt } from '../ui/prompt.js';
import { draw } from '../view/frame.js';
import { screenToWorld, zoomAt } from '../view/viewport.js';

export function canvasPoint(ev) {
  const r = canvas.getBoundingClientRect();
  return { x: ev.clientX-r.left, y: ev.clientY-r.top };
}

export function isSelectionStage() {
  return commandSelectsObjects() || state.mode === 'SELECT';
}

canvas.addEventListener('mousemove', ev => {
  state.mouseScreen = canvasPoint(ev);
  state.mouseWorld = screenToWorld(state.mouseScreen);

  if (state.panning && state.panStart) {
    const dx = state.mouseScreen.x - state.panStart.screen.x;
    const dy = state.mouseScreen.y - state.panStart.screen.y;
    state.view.offsetX = state.panStart.offsetX + dx;
    state.view.offsetY = state.panStart.offsetY + dy;
  }

  if (state.dragSelect) state.dragSelect.end = { ...state.mouseScreen };
  draw();
});

canvas.addEventListener('mousedown', ev => {
  state.mouseScreen = canvasPoint(ev);
  state.mouseWorld = screenToWorld(state.mouseScreen);
  state.mouseDownScreen = { ...state.mouseScreen };

  if (ev.button === 1) {
    state.panning = true;
    state.panStart = { screen: { ...state.mouseScreen }, offsetX: state.view.offsetX, offsetY: state.view.offsetY };
    ev.preventDefault();
    return;
  }

  if (ev.button === 0 && isSelectionStage()) {
    const overGrip = state.mode === 'SELECT' && hitTestGrip(state.mouseScreen, 9);
    if (overGrip) {
      // Begin immediately. GRIP mode is what drawPreview needs to rubber-band
      // the entity while the button is held.
      startGripEdit(overGrip);
      state.gripPress = true;
      return;
    }
    const close = state.entities.some(e => isEntityEditable(e) && distanceToEntityPx(state.mouseWorld,e) <= 8);
    if (!close) state.dragSelect = { start: { ...state.mouseScreen }, end: { ...state.mouseScreen } };
  }
});

canvas.addEventListener('mouseup', ev => {
  state.mouseScreen = canvasPoint(ev);
  state.mouseWorld = screenToWorld(state.mouseScreen);

  if (ev.button === 1) {
    state.panning = false;
    state.panStart = null;
    return;
  }

  if (ev.button === 0) {
    if (state.gripPress) {
      state.gripPress = false;
      const dragMovement = state.mouseDownScreen
        ? Math.hypot(state.mouseScreen.x - state.mouseDownScreen.x, state.mouseScreen.y - state.mouseDownScreen.y)
        : 0;
      // Released somewhere else: that was a drag, so place the grip here.
      // Released where it started: that was a click, so leave the edit live
      // and let the destination be picked or typed.
      if (dragMovement > 5) commitPoint(getActivePoint());
      return;
    }
    if (isSelectionStage()) {
      // A command that asked for objects keeps every pick; bare SELECT
      // replaces unless Shift is held.
      const commandSelection = Boolean(activeCommand()?.additiveSelection);
      if (state.dragSelect) {
        const moved = Math.hypot(state.dragSelect.end.x-state.dragSelect.start.x, state.dragSelect.end.y-state.dragSelect.start.y);
        if (moved > 4) finishBoxSelection(ev.shiftKey || commandSelection);
        else {
          state.dragSelect = null;
          selectAt(state.mouseWorld, ev.shiftKey || commandSelection);
        }
      } else {
        selectAt(state.mouseWorld, ev.shiftKey || commandSelection);
      }
      // A command whose selection stage takes exactly one pick has its
      // answer already and does not wait for Enter.
      if (activeCommand()?.commitsOnPick && isSelectionStage()) finishCurrent();
    } else {
      commitPoint(getActivePoint());
    }
  }
});

canvas.addEventListener('contextmenu', ev => {
  ev.preventDefault();
  acceptDefaultAction();
  canvas.focus();
});

canvas.addEventListener('wheel', ev => {
  ev.preventDefault();
  const p = canvasPoint(ev);
  zoomAt(p, ev.deltaY < 0 ? 1.15 : 1/1.15);
}, {passive:false});

document.addEventListener('keydown', ev => {
  // The dialog owns the keyboard while it is open, otherwise the catch-all
  // below would type into the command line behind it.
  if (!unitsDialog.hidden) {
    if (ev.key === 'Escape') { ev.preventDefault(); closeUnitsDialog(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); applyUnitsDialog(); }
    return;
  }

  if (!dimStyleDialog.hidden) {
    if (ev.key === 'Escape') { ev.preventDefault(); closeDimStyleDialog(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); applyDimStyleDialog(); }
    return;
  }
  if (!polarDialog.hidden) {
    if (ev.key === 'Escape' || ev.key === 'Enter') { ev.preventDefault(); closePolarDialog(); }
    return;
  }
  if (!snapDialog.hidden) {
    // Changes are already applied, so both keys mean the same thing here.
    if (ev.key === 'Escape' || ev.key === 'Enter') { ev.preventDefault(); closeSnapDialog(); }
    return;
  }

  const editingLayerControl = ev.target === currentLayerSelect || Boolean(ev.target?.dataset?.layerAction);
  if (editingLayerControl) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.target.blur?.();
      canvas.focus();
    }
    return;
  }

  if (ev.key === 'F8') {
    ev.preventDefault();
    setOrtho(!state.ortho);
    return;
  }

  if (ev.key === 'F10') {
    ev.preventDefault();
    setPolar(!state.polar);
    return;
  }

  if (ev.ctrlKey || ev.metaKey) {
    const key = ev.key.toLowerCase();
    if (key === 's') { ev.preventDefault(); saveDrawing(); return; }
    if (key === 'o') { ev.preventDefault(); chooseOpenFile(); return; }
    if (key === 'n') { ev.preventDefault(); newDrawing(); return; }
  }

  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); navigateHistory('UNDO'); return; }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'y') { ev.preventDefault(); navigateHistory('REDO'); return; }

  if (ev.key === 'Escape') {
    ev.preventDefault();
    // Esc always CANCELS. It must never commit geometry — use Enter, Space,
    // or right-click for that. Committing on Esc silently created polylines
    // that the user had explicitly tried to abandon.
    cancelCurrent();
    return;
  }

  if (ev.key === 'Enter' && ev.target !== commandInput) {
    ev.preventDefault();
    submitCommandInput();
    return;
  }

  if (ev.key === 'Delete' && document.activeElement !== commandInput) {
    ev.preventDefault(); deleteSelected(); return;
  }

  if (ev.key === ' ' && document.activeElement !== commandInput) {
    ev.preventDefault();
    submitCommandInput();
    return;
  }

  if (document.activeElement !== commandInput && !ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key.length === 1) {
    commandInput.focus();
    commandInput.value += ev.key;
    ev.preventDefault();
  }
});

// Enter, Space, and right-click all accept the same context-sensitive default.
// Keeping one dispatch boundary prevents those three inputs from drifting.
export function acceptDefaultAction() {
  if (activeCommand()?.finish) return finishCurrent() !== false;
  if (state.mode === 'SELECT' && state.lastCommand) return startCommand(state.lastCommand);
  return false;
}

export function submitCommandInput() {
  const raw = commandInput.value.trim();
  commandInput.value = '';

  if (!raw) {
    acceptDefaultAction();
    canvas.focus();
    return;
  }

  // Command-local keywords must run before alias lookup: C closes an active
  // line/polyline but starts CIRCLE at the bare command prompt.
  if (commitCommandKeyword(raw)) {
    canvas.focus();
    return;
  }

  if (commitPointInput(raw)) {
    canvas.focus();
    return;
  }

  if (commitCommandValue(raw)) {
    canvas.focus();
    return;
  }

  const d = parseDistance(raw);
  if (d !== null && commitDistance(d)) {
    canvas.focus();
    return;
  }

  const resolved = resolveCommandName(raw);

  if (!resolved) updatePrompt(`Unknown command: ${raw}`);
  else startCommand(resolved);
  canvas.focus();
}
