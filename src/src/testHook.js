import { COMMAND_ALIASES, resolveCommandName } from './commands/aliases.js';
import { acceptInquirySelection, commitAreaKeyword, finishInquiryPoints } from './commands/inquiry.js';
import { activeCommand, cancelCurrent, closeCurrentPath, commandAcceptsPoint, commandInProgress, commandPreviewReady, commandSelectsObjects, commandTakesDistance, commandUsesOrtho, commandUsesSnap, commitPoint, finishCurrent, navigateHistory, startCommand, undoLastPoint } from './commands/registry.js';
import { acceptTransformSelection } from './commands/transform.js';
import { AUTOSAVE_BACKUP_KEY, AUTOSAVE_KEY, DOCUMENT_VERSION } from './core/constants.js';
import { SNAP_TYPES, defaultDimStyle, defaultSnapTypes, defaultUnitSettings } from './core/defaults.js';
import { dimSize, parseDimStyle, rebaseDimStyleUnit } from './core/dimstyle.js';
import { segmentIntersection, segmentWithinRadius } from './core/math.js';
import { DRAWING_UNITS, formatAngle, formatArea, formatLength, formatLengthLabel, formatsForUnit, groupDigits, parseUnitSettings, unitConversion } from './core/units.js';
import { commandInput, inquiryBody, inquiryPanel, polarDialog, promptEl, snapDialog, unitRescaleCheck } from './dom.js';
import { addPolyline } from './geometry/construct.js';
import { finishEdgeEdit } from './geometry/edgeEdit.js';
import { entityGrips } from './geometry/grips.js';
import { commitAngleInput, commitCircleKeyword, commitDistance, commitScaleInput, parseDistance, parsePoint } from './interaction/input.js';
import { acceptDefaultAction, submitCommandInput } from './interaction/pointer.js';
import { deleteSelected } from './interaction/selection.js';
import { getSnap } from './interaction/snap.js';
import { getCommandBasePoint } from './interaction/tracking.js';
import { buildDimension, dimensionGeometry, dimensionSegments, dimensionText, linearDimensionRotation, resolveEntityReference } from './model/dimension.js';
import { cleanEntityRefs, exportDocumentText, parseDocumentText } from './model/document.js';
import { boxesOverlap, cloneEntities, cloneLayers, duplicateEntities, entityArea, entityBBox, entityCrossesBox, entityLength, entitySegments, pickSegments, polygonArea, polylineIsClosed } from './model/entity.js';
import { redo, undo } from './model/history.js';
import { assignSelectionToLayer, createLayer, deleteLayer, renameLayer, setCurrentLayer, setLayerColor, setLayerLinetype, setLayerLineweight, toggleLayerLock, toggleLayerPrintable, toggleLayerVisibility } from './model/layers.js';
import { loadDocumentText, newDrawing, restoreAutosave } from './model/persistence.js';
import { state } from './state.js';
import { applyDimStyleDialog, closeDimStyleDialog, openDimStyleDialog, pendingDimStyle, refreshDimStyleDialog } from './ui/dialogs/dimstyle.js';
import { closePolarDialog, closeSnapDialog, openPolarDialog, openSnapDialog, setAllSnapTypes, setOrtho, setPolar, setPolarIncrement, setSnapType } from './ui/dialogs/drafting.js';
import { applyUnitsDialog, closeUnitsDialog, coordinateFieldChars, openUnitsDialog, pendingUnits, refreshUnitsDialog } from './ui/dialogs/units.js';
import { promptText } from './ui/prompt.js';
import { drawNow } from './view/frame.js';
import { chooseGridStep } from './view/grid.js';
import { frameLabelBoxes } from './view/render.js';
import { screenToWorld, worldToScreen, zoomExtents } from './view/viewport.js';

// Small test hook used by automated regression tests for this prototype.
window.__cadPrototype = {
  // The raw model plus pure helpers below are intentionally exposed for the
  // headless Node suites. The browser-facing API continues below as getters
  // and command helpers; none of these names are used by the application UI.
  state,
  DRAWING_UNITS,
  DOCUMENT_VERSION,
  COMMAND_ALIASES,
  get registeredCommands() { return [...COMMANDS.keys()]; },
  resolveCommandName,
  defaultUnitSettings,
  unitConversion,
  formatsForUnit,
  cleanEntityRefs,
  parseDocumentText,
  entitySegments,
  pickSegments,
  entityBBox,
  boxesOverlap,
  entityCrossesBox,
  dimSize,
  segmentIntersection,
  segmentWithinRadius,
  parsePoint,
  get mode() { return state.mode; },
  get activeCommandName() { return state.activeCommandName; },
  get entityCount() { return state.entities.length; },
  get ortho() { return state.ortho; },
  get snapType() { return state.snap?.type || null; },
  get snapTypes() { return { ...state.snapTypes }; },
  get polar() { return state.polar; },
  get polarIncrement() { return state.polarIncrement; },
  get polarLock() { return state.polarLock ? { ...state.polarLock } : null; },
  get polarIncrements() { return [...POLAR_INCREMENTS]; },
  setOrtho,
  setPolar,
  setPolarIncrement,
  openPolarDialog,
  closePolarDialog,
  get polarDialogVisible() { return !polarDialog.hidden; },
  get snapTypeOrder() { return SNAP_TYPES.map(entry => entry.type); },
  setSnapType,
  setAllSnapTypes,
  defaultSnapTypes,
  openSnapDialog,
  closeSnapDialog,
  get snapDialogVisible() { return !snapDialog.hidden; },
  get entities() { return cloneEntities(); },
  get selectedIds() { return [...state.selected]; },
  get operationStage() { return state.transform?.stage || state.offset?.stage || state.edit?.stage || null; },
  // How the active command answers each staged hook at this moment. Some
  // answers are unreachable through the UI — a command cannot be asked for a
  // direct distance before it has a base point — so this is the only way to
  // assert them directly.
  get commandCapabilities() {
    const command = activeCommand();
    if (!command) return null;
    return {
      usesOrtho: commandUsesOrtho(command),
      takesDistance: commandTakesDistance(command),
      acceptsPoint: commandAcceptsPoint(command),
      previewReady: commandPreviewReady(command),
      selectsObjects: commandSelectsObjects(command),
      additiveSelection: Boolean(command.additiveSelection),
      commitsOnPick: Boolean(command.commitsOnPick),
      usesSnap: commandUsesSnap(command),
      snapExcludes: command.snapExcludes?.() ?? null,
      basePoint: getCommandBasePoint(),
    };
  },
  get gripKind() { return state.grip?.descriptor?.kind || null; },
  get gripEntityId() { return state.grip?.entityId || null; },
  get circleMethod() { return state.circle?.method || null; },
  get circleStage() { return state.circle?.stage || null; },
  get dimensionType() { return state.dimension?.dimType || null; },
  get viewScale() { return state.view.scale; },
  get layers() { return cloneLayers(); },
  get currentLayerId() { return state.currentLayerId; },
  get nextLayerId() { return state.nextLayerId; },
  get drawingName() { return state.drawingName; },
  get autosaveKey() { return AUTOSAVE_KEY; },
  get autosaveBackupKey() { return AUTOSAVE_BACKUP_KEY; },
  exportDocumentText,
  importDocumentText: loadDocumentText,
  newDrawing: () => newDrawing(true),
  restoreAutosave: () => restoreAutosave(true),
  restoreBackup: () => restoreAutosave(true, true),
  get unitSettings() { return { ...state.unitSettings }; },
  formatLength,
  formatLengthLabel,
  formatAngle,
  parseUnitSettings,
  chooseGridStep,
  coordinateFieldChars,
  worldToScreen,
  screenToWorld,
  zoomExtents,
  entityLength,
  entityArea,
  polygonArea,
  polylineIsClosed,
  formatArea,
  groupDigits,
  get inquiryStage() { return state.inquiry?.stage || null; },
  get inquiryMode() { return state.inquiry?.mode || null; },
  get inquiryVisible() { return !inquiryPanel.hidden; },
  get labelBoxes() { return frameLabelBoxes.map(box => ({ ...box })); },
  get dimStyles() { return state.dimStyles.map(style => ({ ...style })); },
  dimensionGeometry,
  gripsFor: entityGrips,
  dimensionText,
  dimensionSegments,
  buildDimension,
  resolveEntityReference,
  rebaseDimStyleUnit,
  linearDimensionRotation,
  defaultDimStyle,
  parseDimStyle,
  duplicateEntities,
  openDimStyleDialog,
  closeDimStyleDialog,
  applyDimStyleDialog,
  setPendingDimStyle(patch) { if (pendingDimStyle) { Object.assign(pendingDimStyle, patch); refreshDimStyleDialog(); } },
  get inquiryText() { return inquiryPanel.hidden ? null : inquiryBody.textContent; },
  openUnitsDialog,
  closeUnitsDialog,
  applyUnitsDialog,
  setPendingUnits(patch) { if (pendingUnits) { Object.assign(pendingUnits, patch); refreshUnitsDialog(); } },
  setUnitRescale(value) { unitRescaleCheck.checked = Boolean(value); refreshUnitsDialog(); },
  get promptText() { return promptEl.textContent; },
  submitCommandText(text = '') { commandInput.value = text; submitCommandInput(); },
  acceptDefaultAction,
  cancelCurrent,
  navigateHistory,
  commitPoint,
  finishCurrent,
  commitCircleKeyword,
  commitAngleInput,
  commitScaleInput,
  commitDistance,
  commitAreaKeyword,
  acceptInquirySelection,
  finishInquiryPoints,
  acceptTransformSelection,
  finishEdgeEdit,
  deleteSelected,
  undo,
  redo,
  closeCurrentPath,
  undoLastPoint,
  startCommand,
  commandInProgress,
  addPolyline,
  getSnap,
  drawNow,
  parseDistance,
  get lastCommand() { return state.lastCommand; },
  createLayer,
  renameLayer,
  setLayerColor,
  setLayerLinetype,
  setLayerLineweight,
  setCurrentLayer,
  toggleLayerVisibility,
  toggleLayerLock,
  toggleLayerPrintable,
  deleteLayer,
  assignSelectionToLayer,
};
