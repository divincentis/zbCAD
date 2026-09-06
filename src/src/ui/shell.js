import { commandCapturesSpace, navigateHistory, startCommand } from '../commands/registry.js';
import { LENGTH_FORMATS } from '../core/units.js';
import { addLayerBtn, assignLayerBtn, canvas, commandInput, currentLayerSelect, dimArrowSizeInput, dimArrowTypeSelect, dimPrecisionSelect, dimScaleInput, dimScalePresetSelect, dimStyleDialog, dimTextHeightInput, engineStatus, layerColorPicker, layerList, layerPanel, layerPanelToggle, openInput, orthoBtn, plotAreaSelect, plotCenterCheck, plotColorSelect, plotDialog, plotLineweightsCheck, plotOrientationSelect, plotPaperSelect, plotScaleInput, plotScaleModeSelect, plotScalePresetSelect, plotWindowBtn, polarBtn, polarDialog, polarIncrementSelect, polarStatus, snapBtn, snapDialog, snapStatus, unitDrawingUnitSelect, unitFormatSelect, unitPrecisionSelect, unitRescaleCheck, unitStatus, unitsDialog } from '../dom.js';
import { submitCommandInput } from '../interaction/pointer.js';
import { writeAutosave } from '../model/dirty.js';
import { assignSelectionToLayer, createLayer, deleteLayer, renameLayer, setCurrentLayer, setLayerColor, setLayerLinetype, setLayerLineweight, toggleLayerLock, toggleLayerPrintable, toggleLayerVisibility } from '../model/layers.js';
import { chooseOpenFile, loadDocumentText, newDrawing, restoreAutosave, saveDrawing } from '../model/persistence.js';
import { state } from '../state.js';
import { applyDimStyleDialog, closeDimStyleDialog, openDimStyleDialog, pendingDimStyle, refreshDimStyleDialog } from './dialogs/dimstyle.js';
import { closePolarDialog, closeSnapDialog, openPolarDialog, openSnapDialog, setAllSnapTypes, setOrtho, setPolar, setPolarIncrement } from './dialogs/drafting.js';
import { closePlotDialog, openPlotDialog, runPlot, setPendingPlot, startPlotWindowPick } from './dialogs/plot.js';
import { applyUnitsDialog, closeUnitsDialog, openUnitsDialog, pendingUnits, refreshUnitsDialog } from './dialogs/units.js';
import { hideInquiryReport } from './inquiry.js';
import { setFileStatus } from './status.js';
import { draw } from '../view/frame.js';
import { resize, zoomExtents } from '../view/viewport.js';

commandInput.addEventListener('keydown', ev => {
  // Space is a command terminator in AutoCAD and QCAD, so it must never be a
  // literal character here. Mixed numbers are therefore typed with a hyphen —
  // 5'6-1/2" — exactly as AutoCAD requires, and parseDistance accepts both
  // separators so pasted values still work. The one exception is a command
  // stage that explicitly captures free text (TEXT content): a space there is
  // a word break, not an Enter, so it is left to type normally instead.
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  if (ev.key === ' ' && commandCapturesSpace()) return;
  ev.preventDefault();
  ev.stopPropagation();
  submitCommandInput();
});

document.querySelectorAll('[data-command]').forEach(btn => btn.addEventListener('click', () => {
  startCommand(btn.dataset.command);
  canvas.focus();
}));
document.getElementById('undoBtn').addEventListener('click', () => navigateHistory('UNDO'));
document.getElementById('redoBtn').addEventListener('click', () => navigateHistory('REDO'));
document.getElementById('fitBtn').addEventListener('click', zoomExtents);
document.getElementById('unitsBtn').addEventListener('click', openUnitsDialog);
document.getElementById('inquiryClose').addEventListener('click', () => {
  hideInquiryReport();
  canvas.focus();
});
document.getElementById('smallScreenDismiss').addEventListener('click', () => {
  document.getElementById('smallScreenWarning').classList.add('dismissed');
});
unitStatus.addEventListener('click', openUnitsDialog);
snapStatus.addEventListener('click', openSnapDialog);
polarBtn.addEventListener('click', () => setPolar(!state.polar));
polarStatus.addEventListener('click', openPolarDialog);
polarIncrementSelect.addEventListener('change', () => setPolarIncrement(polarIncrementSelect.value));
document.getElementById('polarDone').addEventListener('click', closePolarDialog);
polarDialog.addEventListener('click', ev => { if (ev.target === polarDialog) closePolarDialog(); });
document.getElementById('snapDone').addEventListener('click', closeSnapDialog);
document.getElementById('snapAllOn').addEventListener('click', () => setAllSnapTypes(true));
document.getElementById('snapAllOff').addEventListener('click', () => setAllSnapTypes(false));
snapDialog.addEventListener('click', ev => { if (ev.target === snapDialog) closeSnapDialog(); });
document.getElementById('unitsCancel').addEventListener('click', closeUnitsDialog);
document.getElementById('unitsApply').addEventListener('click', applyUnitsDialog);
unitsDialog.addEventListener('click', ev => { if (ev.target === unitsDialog) closeUnitsDialog(); });
unitDrawingUnitSelect.addEventListener('change', () => {
  if (!pendingUnits) return;
  pendingUnits.drawingUnit = unitDrawingUnitSelect.value;
  refreshUnitsDialog();
});
unitFormatSelect.addEventListener('change', () => {
  if (!pendingUnits) return;
  pendingUnits.format = unitFormatSelect.value;
  pendingUnits.precision = LENGTH_FORMATS[pendingUnits.format].defaultPrecision;
  refreshUnitsDialog();
});
unitPrecisionSelect.addEventListener('change', () => {
  if (!pendingUnits) return;
  pendingUnits.precision = Number(unitPrecisionSelect.value);
  refreshUnitsDialog();
});
unitRescaleCheck.addEventListener('change', refreshUnitsDialog);

document.getElementById('plotBtn').addEventListener('click', openPlotDialog);
document.getElementById('plotCancel').addEventListener('click', closePlotDialog);
document.getElementById('plotRun').addEventListener('click', runPlot);
plotWindowBtn.addEventListener('click', startPlotWindowPick);
plotDialog.addEventListener('click', ev => { if (ev.target === plotDialog) closePlotDialog(); });
for (const [select, field] of [[plotPaperSelect, 'paperSizeId'], [plotOrientationSelect, 'orientation'],
  [plotAreaSelect, 'area'], [plotScaleModeSelect, 'scaleMode'], [plotColorSelect, 'color']]) {
  select.addEventListener('change', () => setPendingPlot({ [field]: select.value }));
}
plotScalePresetSelect.addEventListener('change', () => {
  if (plotScalePresetSelect.value === 'custom') return;
  setPendingPlot({ scale: Number(plotScalePresetSelect.value) });
});
plotScaleInput.addEventListener('input', () => {
  const value = Number(plotScaleInput.value);
  if (!Number.isFinite(value) || value <= 0) return;
  setPendingPlot({ scale: value });
});
plotCenterCheck.addEventListener('change', () => setPendingPlot({ center: plotCenterCheck.checked }));
plotLineweightsCheck.addEventListener('change', () => setPendingPlot({ lineweights: plotLineweightsCheck.checked }));

document.getElementById('dimStyleBtn').addEventListener('click', openDimStyleDialog);
document.getElementById('dimStyleCancel').addEventListener('click', closeDimStyleDialog);
document.getElementById('dimStyleApply').addEventListener('click', applyDimStyleDialog);
dimStyleDialog.addEventListener('click', ev => { if (ev.target === dimStyleDialog) closeDimStyleDialog(); });
dimArrowTypeSelect.addEventListener('change', () => {
  if (!pendingDimStyle) return;
  pendingDimStyle.arrowType = dimArrowTypeSelect.value;
  refreshDimStyleDialog();
});
dimScalePresetSelect.addEventListener('change', () => {
  if (!pendingDimStyle || dimScalePresetSelect.value === 'custom') return;
  pendingDimStyle.scale = Number(dimScalePresetSelect.value);
  refreshDimStyleDialog();
});
for (const [input, field] of [[dimScaleInput, 'scale'], [dimTextHeightInput, 'textHeight'], [dimArrowSizeInput, 'arrowSize']]) {
  input.addEventListener('input', () => {
    if (!pendingDimStyle) return;
    const value = Number(input.value);
    if (!Number.isFinite(value) || value <= 0) return;
    pendingDimStyle[field] = value;
    refreshDimStyleDialog();
  });
}
dimPrecisionSelect.addEventListener('change', () => {
  if (!pendingDimStyle) return;
  pendingDimStyle.precision = dimPrecisionSelect.value === 'document'
    ? null : Number(dimPrecisionSelect.value);
  refreshDimStyleDialog();
});
document.getElementById('newBtn').addEventListener('click', () => newDrawing());
document.getElementById('openBtn').addEventListener('click', chooseOpenFile);
document.getElementById('saveBtn').addEventListener('click', saveDrawing);
document.getElementById('recoverBackupBtn').addEventListener('click', () => restoreAutosave(false, true));
addLayerBtn.addEventListener('click', () => {
  createLayer();
  canvas.focus();
});
assignLayerBtn.addEventListener('click', () => {
  assignSelectionToLayer();
  canvas.focus();
});
currentLayerSelect.addEventListener('change', () => {
  setCurrentLayer(currentLayerSelect.value);
  canvas.focus();
});
layerList.addEventListener('click', event => {
  const action = event.target?.dataset?.layerAction;
  const id = event.target?.dataset?.layerId;
  if (action === 'current') setCurrentLayer(id);
  else if (action === 'visibility') toggleLayerVisibility(id);
  else if (action === 'lock') toggleLayerLock(id);
  else if (action === 'printable') toggleLayerPrintable(id);
  else if (action === 'delete') deleteLayer(id);
  else if (action === 'color') {
    activeColorLayerId = id;
    layerColorPicker.value = event.target.dataset.layerColor;
    layerColorPicker.click();
  }
});
layerList.addEventListener('change', event => {
  const action = event.target?.dataset?.layerAction;
  const id = event.target?.dataset?.layerId;
  if (action === 'name') renameLayer(id, event.target.value);
  else if (action === 'linetype') setLayerLinetype(id, event.target.value);
  else if (action === 'lineweight') setLayerLineweight(id, event.target.value);
});
// The picker anchor lives outside the layer rows (see .layer-color-anchor in
// shell.html) so Chrome's native popup always has room to open — a row's own
// swatch button sits flush against the docked panel's right edge, and that
// popup clips instead of flipping when it's anchored there.
let activeColorLayerId = null;
layerColorPicker.addEventListener('change', () => {
  if (activeColorLayerId) setLayerColor(activeColorLayerId, layerColorPicker.value);
});
openInput.addEventListener('change', async () => {
  const file = openInput.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    if (loadDocumentText(text, file.name)) canvas.focus();
  } catch {
    setFileStatus('Could not read the selected drawing file', true);
  }
});
snapBtn.addEventListener('click', () => { state.snapEnabled=!state.snapEnabled; snapBtn.classList.toggle('on',state.snapEnabled); draw(); });
orthoBtn.addEventListener('click', () => setOrtho(!state.ortho));

// Collapse state is a per-browser convenience, not drawing data, so it lives
// in its own localStorage key rather than the document/autosave model.
const LAYER_PANEL_COLLAPSED_KEY = 'zbcad.layerPanelCollapsed';
function setLayerPanelCollapsed(collapsed) {
  layerPanel.classList.toggle('collapsed', collapsed);
  layerPanelToggle.textContent = collapsed ? '◂' : '▸';
  layerPanelToggle.title = collapsed ? 'Expand layers panel' : 'Collapse layers panel';
  layerPanelToggle.setAttribute('aria-label', layerPanelToggle.title);
  layerPanelToggle.setAttribute('aria-expanded', String(!collapsed));
  try {
    window.localStorage.setItem(LAYER_PANEL_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Private browsing or storage disabled: the toggle still works this session.
  }
}
layerPanelToggle.addEventListener('click', () => {
  setLayerPanelCollapsed(!layerPanel.classList.contains('collapsed'));
  canvas.focus();
});
let layerPanelInitiallyCollapsed = false;
try {
  layerPanelInitiallyCollapsed = window.localStorage.getItem(LAYER_PANEL_COLLAPSED_KEY) === '1';
} catch {
  // Fall back to expanded.
}
setLayerPanelCollapsed(layerPanelInitiallyCollapsed);

window.addEventListener('error', () => {
  engineStatus.textContent = 'ENGINE: ERROR';
  engineStatus.classList.remove('loading', 'ready');
  engineStatus.classList.add('error');
});

window.addEventListener('resize', resize);
// A window resize is not the only thing that changes the canvas size now: the
// toolbar wraps to a second row and takes height from the canvas.
if (window.ResizeObserver) {
  new ResizeObserver(() => resize()).observe(canvas.parentElement);
}
window.addEventListener('beforeunload', () => {
  if (!state.documentDirty) return;
  try {
    writeAutosave();
  } catch {
    // Manual Save remains available when browser storage is unavailable.
  }
});
