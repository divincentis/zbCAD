import { requireIdle } from '../../commands/registry.js';
import { rebaseDimStyleUnit, unitSummary } from '../../core/dimstyle.js';
import { DRAWING_UNITS, LENGTH_FORMATS, formatLength, formatLengthLabel, formatsForUnit, unitConversion } from '../../core/units.js';
import { canvas, coordXEl, coordYEl, unitDrawingUnitSelect, unitFormatSelect, unitPrecisionSelect, unitPreview, unitRescaleCheck, unitRescaleRow, unitStatus, unitsDialog } from '../../dom.js';
import { scaleEntity } from '../../geometry/transform.js';
import { commitGeometry } from '../../model/document.js';
import { state } from '../../state.js';
import { updatePrompt } from '../prompt.js';
import { setFileStatus } from '../status.js';
import { draw } from '../../view/frame.js';
import { zoomExtents } from '../../view/viewport.js';

// ---------------------------------------------------------------------------
// Units dialog
// ---------------------------------------------------------------------------

// A fixed physical length, so the sample shows the effect of BOTH the drawing
// unit and the display format rather than just re-formatting the same number.
export const UNIT_SAMPLE_MM = 66.5 * 25.4;

export let pendingUnits = null;

// Sized from the format, not from the live value: these probes are the widest
// strings a realistic drawing will produce, so the field stops changing width
// as the cursor moves. Anything beyond them still grows the field rather than
// being silently clipped.
export const COORDINATE_PROBES = [-99999.9375, -8888.9375, -1234.0625, 0, 99999.9375];

export function coordinateFieldChars(settings = state.unitSettings) {
  let widest = 4;
  for (const probe of COORDINATE_PROBES) {
    widest = Math.max(widest, formatLength(probe, settings).length);
  }
  return widest;
}

export function applyCoordinateFieldWidth() {
  const width = `${coordinateFieldChars()}ch`;
  coordXEl.style.minWidth = width;
  coordYEl.style.minWidth = width;
}

export function renderUnitStatus() {
  if (unitStatus) unitStatus.textContent = unitSummary();
  applyCoordinateFieldWidth();
}

export function fillSelect(select, values, labelFor, selected) {
  select.textContent = '';
  for (const value of values) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = labelFor(value);
    if (String(value) === String(selected)) option.selected = true;
    select.appendChild(option);
  }
}

export function refreshUnitsDialog() {
  if (!pendingUnits) return;
  const availableFormats = formatsForUnit(pendingUnits.drawingUnit);
  if (!availableFormats.includes(pendingUnits.format)) pendingUnits.format = 'decimal';
  const spec = LENGTH_FORMATS[pendingUnits.format];
  if (!spec.precisions.includes(pendingUnits.precision)) pendingUnits.precision = spec.defaultPrecision;

  fillSelect(unitDrawingUnitSelect, Object.keys(DRAWING_UNITS),
    key => `${DRAWING_UNITS[key].name} (${DRAWING_UNITS[key].abbreviation})`, pendingUnits.drawingUnit);
  fillSelect(unitFormatSelect, availableFormats,
    key => `${LENGTH_FORMATS[key].name} — ${LENGTH_FORMATS[key].sample}`, pendingUnits.format);
  fillSelect(unitPrecisionSelect, spec.precisions,
    value => spec.precisionLabel(value), pendingUnits.precision);

  // Rescaling only means anything when the physical meaning of a unit changes.
  const unitChanged = pendingUnits.drawingUnit !== state.unitSettings.drawingUnit;
  unitRescaleCheck.disabled = !unitChanged;
  if (!unitChanged) unitRescaleCheck.checked = false;
  unitRescaleRow.classList.toggle('disabled', !unitChanged);

  const sample = UNIT_SAMPLE_MM / DRAWING_UNITS[pendingUnits.drawingUnit].mmPerUnit;
  unitPreview.textContent = formatLengthLabel(sample, pendingUnits);
}

export function openUnitsDialog() {
  // Rescaling mid-command moves the entities but not the points already staged
  // in state.transform, leaving a MOVE anchored to the old coordinates.
  if (!requireIdle('changing units')) return;
  pendingUnits = { ...state.unitSettings };
  unitRescaleCheck.checked = false;
  unitsDialog.hidden = false;
  refreshUnitsDialog();
  unitDrawingUnitSelect.focus();
}

export function closeUnitsDialog() {
  pendingUnits = null;
  unitsDialog.hidden = true;
  canvas.focus();
}

export function applyUnitsDialog() {
  if (!pendingUnits) return;
  const next = { ...state.unitSettings, ...pendingUnits };
  const previousUnit = state.unitSettings.drawingUnit;
  const rescale = unitRescaleCheck.checked && !unitRescaleCheck.disabled &&
    next.drawingUnit !== previousUnit;
  const unchanged = !rescale &&
    next.drawingUnit === state.unitSettings.drawingUnit &&
    next.format === state.unitSettings.format &&
    next.precision === state.unitSettings.precision;
  if (unchanged) { closeUnitsDialog(); return; }

  let entities = state.entities;
  if (rescale) {
    // Convert geometry about the origin so a 120" line stays 10 feet long when
    // the drawing unit becomes millimetres.
    const factor = unitConversion(previousUnit, next.drawingUnit);
    const origin = { x: 0, y: 0 };
    entities = entities.map(entity => scaleEntity(entity, origin, factor));
  }
  let dimStyles = state.dimStyles;
  if (next.drawingUnit !== previousUnit) {
    dimStyles = dimStyles.map(style =>
      rebaseDimStyleUnit(style, previousUnit, next.drawingUnit));
  }
  // A precision meaningful for decimals may not exist for fractions.
  dimStyles = dimStyles.map(style => style.precision !== null &&
    !LENGTH_FORMATS[next.format].precisions.includes(style.precision)
    ? { ...style, precision: null } : style);
  if (!commitGeometry(entities, { unitSettings: next, dimStyles })) return;
  renderUnitStatus();
  updatePrompt();
  setFileStatus(`${state.drawingName} · Units set to ${unitSummary()}`);
  closeUnitsDialog();
  if (rescale) zoomExtents();
  draw();
}

// ---------------------------------------------------------------------------
// Dimension style dialog
// ---------------------------------------------------------------------------

// Common drawing scales, as the multiplier that turns a paper size into a
// model size. 1/4" = 1'-0" is 48 because one paper inch is four model feet.
