import { POLAR_INCREMENTS } from '../../core/constants.js';
import { SNAP_TYPES } from '../../core/defaults.js';
import { canvas, orthoBtn, polarBtn, polarDialog, polarIncrementSelect, polarStatus, snapDialog, snapTypeList } from '../../dom.js';
import { state } from '../../state.js';
import { fillSelect } from './units.js';
import { draw } from '../../view/frame.js';

// ---------------------------------------------------------------------------
// Object snap settings
//
// Applied as they are changed rather than on a confirmation: there is nothing
// to validate and nothing that can be half-entered, so a Cancel button would
// only be a way to lose a change already visible on the cursor.
// ---------------------------------------------------------------------------

// ORTHO and polar tracking both answer "which direction is this point allowed
// to go", so having both on at once would mean one silently doing nothing.
export function setOrtho(on) {
  state.ortho = Boolean(on);
  if (state.ortho) state.polar = false;
  refreshTrackingButtons();
  draw();
}

export function setPolar(on) {
  state.polar = Boolean(on);
  if (state.polar) state.ortho = false;
  refreshTrackingButtons();
  draw();
}

export function setPolarIncrement(degrees) {
  const value = Number(degrees);
  if (!POLAR_INCREMENTS.includes(value)) return false;
  state.polarIncrement = value;
  refreshTrackingButtons();
  draw();
  return true;
}

export function refreshTrackingButtons() {
  orthoBtn.classList.toggle('on', state.ortho);
  polarBtn.classList.toggle('on', state.polar);
  polarStatus.textContent = `${state.polarIncrement}\u00b0`;
  if (polarIncrementSelect.value !== String(state.polarIncrement)) {
    polarIncrementSelect.value = String(state.polarIncrement);
  }
}

export function openPolarDialog() {
  fillSelect(
    polarIncrementSelect,
    POLAR_INCREMENTS,
    value => `${value}\u00b0`,
    state.polarIncrement,
  );
  polarDialog.hidden = false;
}

export function closePolarDialog() {
  polarDialog.hidden = true;
  canvas.focus();
}

export function renderSnapDialog() {
  if (snapTypeList.children.length) {
    for (const entry of SNAP_TYPES) {
      const input = snapTypeList.querySelector(`#snapType-${entry.type}`);
      if (input) input.checked = Boolean(state.snapTypes[entry.type]);
    }
    return;
  }
  for (const entry of SNAP_TYPES) {
    const row = document.createElement('label');
    row.className = 'snap-row';
    row.setAttribute('for', `snapType-${entry.type}`);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = `snapType-${entry.type}`;
    input.checked = Boolean(state.snapTypes[entry.type]);
    input.addEventListener('change', () => setSnapType(entry.type, input.checked));
    const label = document.createElement('span');
    label.textContent = entry.label;
    const tag = document.createElement('code');
    tag.textContent = entry.type;
    row.append(input, label, tag);
    snapTypeList.append(row);
  }
}

export function setSnapType(type, on) {
  if (!(type in state.snapTypes)) return false;
  state.snapTypes[type] = Boolean(on);
  renderSnapDialog();
  draw();
  return true;
}

export function setAllSnapTypes(on) {
  for (const entry of SNAP_TYPES) state.snapTypes[entry.type] = on;
  renderSnapDialog();
  draw();
}

export function openSnapDialog() {
  renderSnapDialog();
  snapDialog.hidden = false;
}

export function closeSnapDialog() {
  snapDialog.hidden = true;
  canvas.focus();
}
