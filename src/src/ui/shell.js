import { commandCapturesSpace, commandLiveValue, navigateHistory, startCommand } from '../commands/registry.js';
import { LAYER_BASIC_COLORS } from '../core/constants.js';
import { LENGTH_FORMATS } from '../core/units.js';
import { addLayerBtn, assignLayerBtn, canvas, commandInput, currentLayerSelect, dimArrowSizeInput, dimArrowTypeSelect, dimPrecisionSelect, dimScaleInput, dimScalePresetSelect, dimStyleDialog, dimTextHeightInput, dxfInput, engineStatus, imageInput, layerColorMenu, layerColorPicker, layerList, layerPanel, layerPanelHandle, layersSection, layersSectionToggle, openInput, orthoBtn, plotAreaSelect, plotCenterCheck, plotColorSelect, plotDialog, plotLineweightsCheck, plotOrientationSelect, plotPaperSelect, plotScaleInput, plotScaleModeSelect, plotScalePresetSelect, plotWindowBtn, polarBtn, polarDialog, polarIncrementSelect, polarStatus, propertiesFields, propertiesLayerSelect, propertiesSection, propertiesSectionToggle, snapBtn, snapDialog, snapStatus, toolbarAutohideBtn, topbar, underlayApplyBtn, underlayCancelBtn, underlayDeleteBtn, underlayDialog, underlayFadeInput, underlayLockedCheck, underlayPlotCheck, unitDrawingUnitSelect, unitFormatSelect, unitPrecisionSelect, unitRescaleCheck, unitStatus, unitsDialog, workspace } from '../dom.js';
import { submitCommandInput } from '../interaction/pointer.js';
import { writeAutosaveOnUnload } from '../model/dirty.js';
import { assignSelectionToLayer, createLayer, deleteLayer, renameLayer, setCurrentLayer, setLayerColor, setLayerLinetype, setLayerLineweight, toggleLayerLock, toggleLayerPrintable, toggleLayerVisibility } from '../model/layers.js';
import { chooseOpenFile, loadDocumentText, newDrawing, restoreAutosave, saveDrawing } from '../model/persistence.js';
import { chooseDxfFile, exportDxf, loadDxfText } from './dialogs/dxf.js';
import { startImagePlacement } from '../commands/underlay.js';
import { underlayDescriptorFromFile } from '../model/imageImport.js';
import { applyUnderlayDialog, closeUnderlayDialog, deleteUnderlayFromDialog, openUnderlayDialog, setPendingUnderlay } from './dialogs/underlay.js';
import { state } from '../state.js';
import { applyDimStyleDialog, closeDimStyleDialog, openDimStyleDialog, pendingDimStyle, refreshDimStyleDialog } from './dialogs/dimstyle.js';
import { closePolarDialog, closeSnapDialog, openPolarDialog, openSnapDialog, setAllSnapTypes, setOrtho, setPolar, setPolarIncrement } from './dialogs/drafting.js';
import { closePlotDialog, openPlotDialog, runPlot, setPendingPlot, startPlotWindowPick } from './dialogs/plot.js';
import { applyUnitsDialog, closeUnitsDialog, openUnitsDialog, pendingUnits, refreshUnitsDialog } from './dialogs/units.js';
import { hideInquiryReport } from './inquiry.js';
import { applyPropertiesField, renderPropertiesPanel } from './propertiesPanel.js';
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

// A free-text stage (TEXT/MTEXT content) previously only showed what was
// typed in this input box, not on the drawing, until Enter committed it —
// every keystroke now also updates the on-canvas preview.
commandInput.addEventListener('input', () => commandLiveValue(commandInput.value));

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
  // Unlike every other layer-panel button, this one leaves focus where
  // renderLayerManager() just put it (the new layer's name field) instead of
  // returning it to the canvas — renaming a fresh "Layer 3" is the very next
  // thing a user does.
  createLayer();
});
assignLayerBtn.addEventListener('click', () => {
  assignSelectionToLayer();
  renderPropertiesPanel();
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
    openColorMenu(event.target, event.target.dataset.layerColor);
  }
  // Hiding/locking a layer, or deleting one, can drop entities out of the
  // current selection (model/layers.js) — the properties panel needs to
  // notice even though none of these actions go through commitGeometry.
  renderPropertiesPanel();
});

// The layer-driven-only properties panel (see roadmap.md): reassigning the
// selection's layer reuses the exact function the "Assign selection to
// current" button already calls, just with a picked id instead of the
// default. Per-type fields commit on change/blur, matching how a layer's own
// name field already commits (not on every keystroke).
propertiesLayerSelect.addEventListener('change', () => {
  assignSelectionToLayer(propertiesLayerSelect.value);
  renderPropertiesPanel();
  canvas.focus();
});
propertiesFields.addEventListener('change', event => {
  const field = event.target?.dataset?.propField;
  if (!field) return;
  applyPropertiesField(field, event.target.value, event.target.dataset.propAngle === '1');
  canvas.focus();
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

// A basic-colors swatch menu answers the common case ("make this layer red")
// without the OS picker's extra clicks; "Custom…" still reaches it for
// anything not in the palette. Built once since the palette is fixed.
layerColorMenu.innerHTML = LAYER_BASIC_COLORS.map(color =>
  `<button type="button" class="color-swatch" data-color="${color}" style="background-color: ${color};" title="${color}" aria-label="${color}"></button>`,
).join('') + '<button type="button" class="color-menu-custom" data-color-custom>Custom…</button>';

function openColorMenu(anchorEl, currentColor) {
  for (const swatch of layerColorMenu.querySelectorAll('.color-swatch')) {
    swatch.classList.toggle('current', swatch.dataset.color === currentColor);
  }
  const rect = anchorEl.getBoundingClientRect();
  layerColorMenu.hidden = false;
  // Flip left of the button instead of clipping off the right edge of the
  // docked panel, the same problem the native-picker anchor trick works
  // around above.
  const menuWidth = layerColorMenu.offsetWidth;
  layerColorMenu.style.left = `${Math.max(4, rect.left - menuWidth + rect.width)}px`;
  layerColorMenu.style.top = `${rect.bottom + 4}px`;
}

function closeColorMenu() {
  layerColorMenu.hidden = true;
}

layerColorMenu.addEventListener('click', event => {
  const color = event.target?.dataset?.color;
  if (color) {
    if (activeColorLayerId) setLayerColor(activeColorLayerId, color);
    closeColorMenu();
  } else if (event.target?.dataset?.colorCustom !== undefined) {
    layerColorPicker.value = layerColorMenu.querySelector('.color-swatch.current')?.dataset.color || '#ffffff';
    closeColorMenu();
    layerColorPicker.click();
  }
});
document.addEventListener('click', event => {
  if (!layerColorMenu.hidden && !layerColorMenu.contains(event.target) && event.target.dataset?.layerAction !== 'color') {
    closeColorMenu();
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !layerColorMenu.hidden) closeColorMenu();
});
// Choosing an image decodes and re-encodes it (see model/imageImport.js) and
// then hands the descriptor to the IMAGE command, which does the placing. The
// decode lives here rather than in the command so the command stays drivable
// without a File.
imageInput.addEventListener('change', async () => {
  const file = imageInput.files?.[0];
  if (!file) return;
  try {
    const descriptor = await underlayDescriptorFromFile(file);
    startImagePlacement(descriptor);
    canvas.focus();
  } catch (error) {
    setFileStatus(error.message || 'Could not read the selected image', true);
  }
});

dxfInput.addEventListener('change', async () => {
  const file = dxfInput.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    if (await loadDxfText(text, file.name)) canvas.focus();
  } catch {
    setFileStatus('Could not read the selected DXF file', true);
  }
});

document.getElementById('dxfInBtn').addEventListener('click', chooseDxfFile);
document.getElementById('dxfOutBtn').addEventListener('click', exportDxf);

document.getElementById('imageBtn').addEventListener('click', () => {
  if (!requireIdle('placing an image')) return;
  imageInput.value = '';
  imageInput.click();
});
document.getElementById('underlayBtn').addEventListener('click', openUnderlayDialog);

underlayCancelBtn.addEventListener('click', closeUnderlayDialog);
underlayApplyBtn.addEventListener('click', applyUnderlayDialog);
underlayDeleteBtn.addEventListener('click', deleteUnderlayFromDialog);
underlayDialog.addEventListener('click', ev => {
  if (ev.target === underlayDialog) closeUnderlayDialog();
});
underlayFadeInput.addEventListener('input', () => setPendingUnderlay({ fade: Number(underlayFadeInput.value) }));
underlayLockedCheck.addEventListener('change', () => setPendingUnderlay({ locked: underlayLockedCheck.checked }));
underlayPlotCheck.addEventListener('change', () => setPendingUnderlay({ plot: underlayPlotCheck.checked }));

openInput.addEventListener('change', async () => {
  const file = openInput.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    if (await loadDocumentText(text, file.name)) canvas.focus();
  } catch {
    setFileStatus('Could not read the selected drawing file', true);
  }
});
snapBtn.addEventListener('click', () => { state.snapEnabled=!state.snapEnabled; snapBtn.classList.toggle('on',state.snapEnabled); draw(); });
orthoBtn.addEventListener('click', () => setOrtho(!state.ortho));

// Collapse state and width are both per-browser convenience, not drawing
// data, so they live in their own localStorage keys rather than the
// document/autosave model. Width is applied as a direct inline style, the
// convention this codebase already uses everywhere else it touches .style
// (see layerColorMenu.style.left/top above) rather than a CSS custom
// property — the latter needs style.setProperty, which the headless test
// harness's minimal style stub doesn't implement.
const LAYER_PANEL_COLLAPSED_KEY = 'zbcad.layerPanelCollapsed';
const LAYER_PANEL_WIDTH_KEY = 'zbcad.layerPanelWidth';
const LAYER_PANEL_MIN_WIDTH = 220;
const LAYER_PANEL_MAX_WIDTH = 480;
const LAYER_PANEL_COLLAPSED_WIDTH = 34;
// A drag shorter than this reads as a click — the same handle serves both
// gestures (see .panel-resize-handle in shell.html), told apart by movement
// distance in the mouseup handler below rather than by separate elements.
const LAYER_PANEL_DRAG_THRESHOLD = 4;

// The panel's chosen width, independent of whether it's currently collapsed
// (collapsing never changes it — it's what the handle drag returns to).
let layerPanelWidth = window.innerWidth <= 820 ? 230 : 274;
try {
  const stored = Number(window.localStorage.getItem(LAYER_PANEL_WIDTH_KEY));
  if (Number.isFinite(stored) && stored > 0) layerPanelWidth = stored;
} catch {
  // Fall back to the viewport-based default.
}

function applyWorkspaceColumns() {
  const width = layerPanel.classList.contains('collapsed') ? LAYER_PANEL_COLLAPSED_WIDTH : layerPanelWidth;
  workspace.style.gridTemplateColumns = `minmax(0, 1fr) ${width}px`;
}

function setLayerPanelCollapsed(collapsed) {
  layerPanel.classList.toggle('collapsed', collapsed);
  layerPanelHandle.setAttribute('aria-expanded', String(!collapsed));
  applyWorkspaceColumns();
  try {
    window.localStorage.setItem(LAYER_PANEL_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Private browsing or storage disabled: the toggle still works this session.
  }
}

function setLayerPanelWidth(width) {
  layerPanelWidth = Math.min(LAYER_PANEL_MAX_WIDTH, Math.max(LAYER_PANEL_MIN_WIDTH, width));
  applyWorkspaceColumns();
  try {
    window.localStorage.setItem(LAYER_PANEL_WIDTH_KEY, String(layerPanelWidth));
  } catch {
    // Private browsing or storage disabled: the resize still works this session.
  }
}
setLayerPanelWidth(layerPanelWidth);

layerPanelHandle.addEventListener('mousedown', event => {
  if (event.button !== 0) return;
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = layerPanelWidth;
  let dragging = false;

  function onMove(moveEvent) {
    const delta = startX - moveEvent.clientX;
    if (!dragging) {
      if (Math.abs(delta) < LAYER_PANEL_DRAG_THRESHOLD) return;
      dragging = true;
      layerPanelHandle.classList.add('dragging');
      setLayerPanelCollapsed(false);
    }
    setLayerPanelWidth(startWidth + delta);
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    layerPanelHandle.classList.remove('dragging');
    if (!dragging) setLayerPanelCollapsed(!layerPanel.classList.contains('collapsed'));
    canvas.focus();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});
layerPanelHandle.addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
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

// Properties and Layers are two independent concerns that used to share one
// heading; each now collapses on its own (an accordion within the still-open
// panel), separate from the whole-panel toggle above which frees canvas width.
function makeSectionCollapser(section, toggle, label, storageKey) {
  function setCollapsed(collapsed) {
    section.classList.toggle('collapsed', collapsed);
    toggle.textContent = collapsed ? '▸' : '▾';
    toggle.title = collapsed ? `Expand ${label}` : `Collapse ${label}`;
    toggle.setAttribute('aria-label', toggle.title);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    try {
      window.localStorage.setItem(storageKey, collapsed ? '1' : '0');
    } catch {
      // Private browsing or storage disabled: the toggle still works this session.
    }
  }
  toggle.addEventListener('click', () => {
    setCollapsed(!section.classList.contains('collapsed'));
    canvas.focus();
  });
  let initiallyCollapsed = false;
  try {
    initiallyCollapsed = window.localStorage.getItem(storageKey) === '1';
  } catch {
    // Fall back to expanded.
  }
  setCollapsed(initiallyCollapsed);
}
makeSectionCollapser(propertiesSection, propertiesSectionToggle, 'properties', 'zbcad.propertiesSectionCollapsed');
makeSectionCollapser(layersSection, layersSectionToggle, 'layers', 'zbcad.layersSectionCollapsed');

// Same per-browser convenience as the layer panel above: whether the toolbar
// auto-hides is a display preference, not drawing data.
const TOOLBAR_AUTOHIDE_KEY = 'zbcad.toolbarAutohide';
function setToolbarAutohide(enabled) {
  topbar.classList.toggle('autohide', enabled);
  toolbarAutohideBtn.classList.toggle('on', enabled);
  toolbarAutohideBtn.setAttribute('aria-pressed', String(enabled));
  try {
    window.localStorage.setItem(TOOLBAR_AUTOHIDE_KEY, enabled ? '1' : '0');
  } catch {
    // Private browsing or storage disabled: the toggle still works this session.
  }
}
toolbarAutohideBtn.addEventListener('click', () => {
  setToolbarAutohide(!topbar.classList.contains('autohide'));
  canvas.focus();
});
let toolbarAutohideInitially = false;
try {
  toolbarAutohideInitially = window.localStorage.getItem(TOOLBAR_AUTOHIDE_KEY) === '1';
} catch {
  // Fall back to always-visible.
}
setToolbarAutohide(toolbarAutohideInitially);

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
    writeAutosaveOnUnload();
  } catch {
    // Manual Save remains available when browser storage is unavailable.
  }
});
