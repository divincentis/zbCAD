import { requireIdle } from '../../commands/registry.js';
import { DEFAULT_DIM_STYLE_ID } from '../../core/defaults.js';
import { ARROW_TYPES, DIM_NUMERIC_STYLE_FIELDS, getDimStyle, parseDimStyle } from '../../core/dimstyle.js';
import { scalePresets } from '../../core/paper.js';
import { LENGTH_FORMATS, formatLengthLabel } from '../../core/units.js';
import { canvas, dimArrowSizeInput, dimArrowTypeSelect, dimPrecisionSelect, dimScaleInput, dimScalePresetSelect, dimStyleDialog, dimStylePreview, dimTextHeightInput } from '../../dom.js';
import { commitGeometry } from '../../model/history.js';
import { state } from '../../state.js';
import { fillSelect } from './units.js';
import { updatePrompt } from '../prompt.js';
import { setFileStatus } from '../status.js';
import { draw } from '../../view/frame.js';

export let pendingDimStyle = null;

export function refreshDimStyleDialog() {
  if (!pendingDimStyle) return;
  fillSelect(dimArrowTypeSelect, Object.keys(ARROW_TYPES),
    key => ARROW_TYPES[key], pendingDimStyle.arrowType);

  const presets = scalePresets();
  const match = presets.find(([, value]) => Math.abs(value - pendingDimStyle.scale) < 1e-9);
  fillSelect(dimScalePresetSelect, ['custom', ...presets.map(([, value]) => value)],
    value => (value === 'custom' ? 'Custom' : presets.find(([, v]) => v === value)[0]),
    match ? match[1] : 'custom');

  dimScaleInput.value = String(pendingDimStyle.scale);
  dimTextHeightInput.value = String(pendingDimStyle.textHeight);
  dimArrowSizeInput.value = String(pendingDimStyle.arrowSize);

  const spec = LENGTH_FORMATS[state.unitSettings.format];
  fillSelect(dimPrecisionSelect, ['document', ...spec.precisions],
    value => (value === 'document'
      ? `Follow drawing units (${spec.precisionShort(state.unitSettings.precision)})`
      : spec.precisionLabel(value)),
    pendingDimStyle.precision === null ? 'document' : pendingDimStyle.precision);

  const textSize = pendingDimStyle.textHeight * pendingDimStyle.scale;
  const arrowSizeValue = pendingDimStyle.arrowSize * pendingDimStyle.scale;
  dimStylePreview.textContent =
    `text ${formatLengthLabel(textSize)} · terminator ${formatLengthLabel(arrowSizeValue)}`;
}

export function openDimStyleDialog() {
  if (!requireIdle('changing the dimension style')) return;
  pendingDimStyle = { ...getDimStyle(DEFAULT_DIM_STYLE_ID) };
  dimStyleDialog.hidden = false;
  refreshDimStyleDialog();
  dimArrowTypeSelect.focus();
}

export function closeDimStyleDialog() {
  pendingDimStyle = null;
  dimStyleDialog.hidden = true;
  canvas.focus();
}

export function applyDimStyleDialog() {
  if (!pendingDimStyle) return;
  const candidate = { ...getDimStyle(DEFAULT_DIM_STYLE_ID), ...pendingDimStyle };
  const parsed = parseDimStyle(candidate, state.unitSettings.format);
  if (parsed.error) {
    updatePrompt(`The dimension style ${parsed.error}.`);
    return;
  }
  const current = getDimStyle(DEFAULT_DIM_STYLE_ID);
  const unchanged = DIM_NUMERIC_STYLE_FIELDS.every(field => current[field] === parsed.style[field]) &&
    current.arrowType === parsed.style.arrowType && current.precision === parsed.style.precision;
  if (unchanged) { closeDimStyleDialog(); return; }
  const dimStyles = state.dimStyles.map(style =>
    style.id === parsed.style.id ? parsed.style : style);
  if (!commitGeometry(state.entities, { dimStyles })) return;
  setFileStatus(`${state.drawingName} · Dimension style updated`);
  closeDimStyleDialog();
  draw();
}
