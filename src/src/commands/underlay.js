import { defineCommand, setMode, startCommand } from './registry.js';
import { UNDERLAY_DEFAULT_FADE } from '../core/constants.js';
import { dist } from '../core/math.js';
import { scalePresetLabel } from '../core/paper.js';
import { DRAWING_UNITS, formatLength, formatLengthLabel } from '../core/units.js';
import { parseDistance } from '../interaction/input.js';
import { commitGeometry } from '../model/history.js';
import { underlayDescriptorFromUrl } from '../model/imageImport.js';
import { currentLayerIsEditable } from '../model/layerQuery.js';
import { pdfPageUnderlay } from '../model/pdfImport.js';
import { calibrateUnderlay, makeUnderlay, underlayBBox, underlayContainsPoint, underlayIsSelectable, underlayIsVector, underlaySelectionId, underlayWidth } from '../model/underlay.js';
import { state } from '../state.js';
import { updatePrompt } from '../ui/prompt.js';
import { setFileStatus } from '../ui/status.js';
import { draw } from '../view/frame.js';
import { drawEntity } from '../view/render.js';
import { drawUnderlayPreview } from '../view/underlay.js';

// ---------------------------------------------------------------------------
// Underlay commands
//
// IMAGE places a raster; CALIBRATE tells the drawing how big it really is.
// They are separate commands rather than one wizard because calibration is not
// a one-time step: a traced image gets re-calibrated whenever a better known
// dimension turns up, and having to re-import to do that would be absurd.
// ---------------------------------------------------------------------------

// The descriptor waiting to be placed. It is handed in from the file picker
// (ui/shell.js) or, in tests, injected directly — the command itself never
// touches a File, which is what keeps it drivable headlessly.
export let pendingUnderlayImage = null;

export function setPendingUnderlayImage(descriptor) {
  pendingUnderlayImage = descriptor;
}

// Routed through startCommand rather than setMode so the placement obeys the
// same rules every other command does: it refuses while another command is
// mid-stage, and `creates` clears the selection and checks the current layer.
export function startImagePlacement(descriptor) {
  if (!descriptor) return false;
  pendingUnderlayImage = descriptor;
  startCommand('IMAGE');
  return true;
}

defineCommand('IMAGE', {
  creates: true,

  canBegin() {
    if (!pendingUnderlayImage) {
      updatePrompt('IMAGE — choose a file with the Image button first.');
      return false;
    }
    return true;
  },

  begin() {
    state.underlay = {
      stage: 'PLACE',
      descriptor: pendingUnderlayImage,
      // One drawing unit per pixel is an arbitrary but honest default: the
      // image carries no real-world scale, and pretending otherwise would be
      // a guess the user then has to detect and undo. CALIBRATE is the answer,
      // and the prompt says so.
      unitsPerPixel: 1,
    };
  },

  takesDistance: true,

  prompt() {
    const operation = state.underlay;
    if (!operation) return 'IMAGE:';
    const width = operation.descriptor.widthPx * operation.unitsPerPixel;
    return `IMAGE — Specify bottom-left corner, or type a width (${formatLengthLabel(width)} at present):`;
  },

  // A typed number at the placement stage means "make the image this wide",
  // which is the fastest possible calibration when the width is already known.
  distance(value) {
    const operation = state.underlay;
    if (!operation || !(value > 0)) {
      updatePrompt('Enter a width greater than zero.');
      return;
    }
    operation.unitsPerPixel = value / operation.descriptor.widthPx;
    updatePrompt();
    draw();
  },

  previewReady() {
    return Boolean(state.underlay);
  },

  preview(p) {
    const operation = state.underlay;
    if (!operation) return;
    drawUnderlayPreview(operation.descriptor, p, operation.unitsPerPixel);
  },

  point(p) {
    const operation = state.underlay;
    if (!operation) return;
    if (!currentLayerIsEditable()) {
      updatePrompt('The current layer is locked or hidden.');
      return;
    }
    const underlay = makeUnderlay(operation.descriptor, p, {
      unitsPerPixel: operation.unitsPerPixel,
      fade: UNDERLAY_DEFAULT_FADE,
    });
    const nextUnderlayId = underlay.id + 1;
    if (!commitGeometry(state.entities, {
      underlays: [...state.underlays, underlay],
      nextUnderlayId,
    })) return;
    pendingUnderlayImage = null;
    state.selected = new Set([underlaySelectionId(underlay.id)]);
    setMode('SELECT');
    updatePrompt(`Image placed ${formatLengthLabel(underlayWidth(underlay))} wide. Use CALIBRATE to set its true scale.`);
  },

  finish() {
    pendingUnderlayImage = null;
    setMode('SELECT');
  },
});

// ---------------------------------------------------------------------------
// PDFATTACH
//
// Places one page of a PDF. It differs from IMAGE in the one way a PDF differs
// from a picture: the file says how big its sheet is. So the page arrives at
// its true paper size, and the number to type is the scale the sheet was drawn
// at — 48 for a plan at 1/4" = 1'-0" — after which the building is full size
// and nothing needs calibrating. CALIBRATE still works on the result, for the
// sheet whose title block lies about its scale.
// ---------------------------------------------------------------------------

// The opened file waiting to be placed: { doc, name }, plus `first` when its
// only page has already been read and `nextPage` once a page has been placed.
// It is kept after a placement when there are more pages, because a drawing
// set is a single file and choosing it again for every sheet would be tedious.
export let pendingPdf = null;

// The scale the last page was placed at. Sheets from one set usually share a
// scale, so it is offered again rather than starting over at full size.
export let lastPdfScale = 1;

export function setPendingPdf(source) {
  pendingPdf = source;
}

// Accepts the ways a drawing scale is written on a title block: a bare ratio
// (48), a ratio with its colon (1:48), or a paper length and the real length
// it stands for (1/4"=1'). Returns real size over paper size, or null.
export function parseSheetScale(text) {
  const source = String(text).trim();
  const positive = value => (Number.isFinite(value) && value > 0 ? value : null);
  const equation = source.split('=');
  if (equation.length === 2) {
    const paper = positive(parseDistance(equation[0]));
    const real = positive(parseDistance(equation[1]));
    return paper && real ? positive(real / paper) : null;
  }
  const ratio = source.split(':');
  if (ratio.length === 2) {
    const paper = positive(Number(ratio[0]));
    const real = positive(Number(ratio[1]));
    return paper && real ? positive(real / paper) : null;
  }
  return positive(Number(source));
}

function pdfUnitsPerPixel(operation) {
  const unitMM = DRAWING_UNITS[state.unitSettings.drawingUnit].mmPerUnit;
  return (operation.descriptor.mmPerPixel * operation.scale) / unitMM;
}

// The page is placed by the bottom-left corner of what is seen. For a scan the
// PDF had turned on its side that is not the picture's own first corner, so
// the origin is backed off by however far the turned frame overhangs it.
function pdfOriginForCorner(operation, corner) {
  const placed = {
    origin: { x: 0, y: 0 },
    rotation: operation.descriptor.rotation || 0,
    unitsPerPixel: pdfUnitsPerPixel(operation),
    widthPx: operation.descriptor.widthPx,
    heightPx: operation.descriptor.heightPx,
  };
  const box = underlayBBox(placed);
  return { x: corner.x - box.minX, y: corner.y - box.minY };
}

function pdfPageReady(operation, result) {
  operation.descriptor = result.descriptor;
  operation.stage = 'PLACE';
  // What the page lost on the way in. Kept for the message that confirms the
  // placement, since the status line is soon overwritten by the autosave.
  operation.notes = result.notes || [];
  const notes = operation.notes.length ? ` · ${operation.notes.join('; ')}` : '';
  setFileStatus(`${result.descriptor.name}${notes}`, Boolean(notes));
  updatePrompt();
  draw();
}

// Reads a page into the running command. A page of line work is ready at
// once; a scan has a picture to decode first, and the command waits in
// LOADING for it — unless it has been cancelled in the meantime, in which
// case the late result is dropped.
function choosePdfPage(operation, index, known = null) {
  const result = known || pdfPageUnderlay(operation.source.doc, index, operation.source.name);
  if (result.error) {
    updatePrompt(`PDF — ${result.error}${operation.pageCount > 1 ? ' Enter another page:' : ''}`);
    return false;
  }
  operation.pageIndex = index;
  if (result.descriptor) {
    pdfPageReady(operation, result);
    return true;
  }
  operation.stage = 'LOADING';
  updatePrompt();
  const current = () => state.activeCommandName === 'PDFATTACH' && state.underlay === operation;
  underlayDescriptorFromUrl(result.scan.data, result.scan.name).then(descriptor => {
    if (!current()) return;
    pdfPageReady(operation, {
      descriptor: {
        ...descriptor,
        mmPerPixel: result.scan.widthMM / descriptor.widthPx,
        rotation: result.scan.angle,
      },
      notes: ['a scanned page, placed as an image'],
    });
  }, error => {
    if (!current()) return;
    operation.stage = 'PAGE';
    updatePrompt(`PDF — ${error.message || 'That page could not be read.'}`);
  });
  return true;
}

// The file picker's way in (ui/shell.js), and a test's. A one-page file is
// read before the command starts, so that a page with nothing usable on it is
// an error message rather than a command that begins and has nowhere to go.
export function startPdfPlacement(source) {
  if (!source || !source.doc || !source.doc.pages.length) return false;
  const pending = { doc: source.doc, name: source.name || 'pdf', first: null, nextPage: 0 };
  if (pending.doc.pages.length === 1) {
    pending.first = pdfPageUnderlay(pending.doc, 0, pending.name);
    if (pending.first.error) {
      setFileStatus(pending.first.error, true);
      updatePrompt(`PDF — ${pending.first.error}`);
      return false;
    }
  }
  pendingPdf = pending;
  return startCommand('PDFATTACH');
}

defineCommand('PDFATTACH', {
  creates: true,

  canBegin() {
    if (!pendingPdf) {
      updatePrompt('PDF — choose a file with the PDF button first.');
      return false;
    }
    return true;
  },

  begin() {
    const operation = {
      stage: 'PAGE',
      source: pendingPdf,
      pageCount: pendingPdf.doc.pages.length,
      pageIndex: Math.min(pendingPdf.nextPage || 0, pendingPdf.doc.pages.length - 1),
      descriptor: null,
      notes: [],
      scale: lastPdfScale,
    };
    state.underlay = operation;
    if (operation.pageCount === 1) {
      const known = pendingPdf.first;
      pendingPdf.first = null;
      choosePdfPage(operation, 0, known);
    }
  },

  prompt() {
    const operation = state.underlay;
    if (!operation) return 'PDF:';
    if (operation.stage === 'PAGE') {
      return `PDF — ${operation.source.name} has ${operation.pageCount} pages. `
        + `Enter the page to place <${operation.pageIndex + 1}>:`;
    }
    if (operation.stage === 'LOADING') return 'PDF — reading the page…';
    return 'PDF — Specify bottom-left corner, or type the scale the sheet was drawn at '
      + `(${scalePresetLabel(operation.scale)} at present):`;
  },

  acceptsPoint() {
    return state.underlay?.stage === 'PLACE';
  },

  // A page number, then a scale. Neither is a distance: 48 here means 1:48,
  // not forty-eight drawing units.
  value(text) {
    const operation = state.underlay;
    if (!operation) return false;
    if (operation.stage === 'PAGE') {
      const page = Number(String(text).trim());
      if (!Number.isInteger(page) || page < 1 || page > operation.pageCount) {
        updatePrompt(`PDF — enter a page from 1 to ${operation.pageCount}:`);
        return true;
      }
      choosePdfPage(operation, page - 1);
      return true;
    }
    if (operation.stage !== 'PLACE') return true;
    const scale = parseSheetScale(text);
    if (scale === null) {
      updatePrompt('PDF — enter the sheet\'s scale, for example 48, 1:100 or 1/4"=1\'.');
      return true;
    }
    operation.scale = scale;
    lastPdfScale = scale;
    updatePrompt();
    draw();
    return true;
  },

  previewReady() {
    return state.underlay?.stage === 'PLACE';
  },

  preview(p) {
    const operation = state.underlay;
    if (!operation?.descriptor) return;
    drawUnderlayPreview(operation.descriptor, pdfOriginForCorner(operation, p),
      pdfUnitsPerPixel(operation), operation.descriptor.rotation || 0);
  },

  point(p) {
    const operation = state.underlay;
    if (!operation || operation.stage !== 'PLACE') return;
    if (!currentLayerIsEditable()) {
      updatePrompt('The current layer is locked or hidden.');
      return;
    }
    const underlay = makeUnderlay(operation.descriptor, pdfOriginForCorner(operation, p), {
      unitsPerPixel: pdfUnitsPerPixel(operation),
      rotation: operation.descriptor.rotation || 0,
      fade: UNDERLAY_DEFAULT_FADE,
    });
    if (!commitGeometry(state.entities, {
      underlays: [...state.underlays, underlay],
      nextUnderlayId: underlay.id + 1,
    })) return;
    const more = operation.pageCount > 1;
    if (more) pendingPdf = { ...operation.source, first: null, nextPage: Math.min(operation.pageIndex + 1, operation.pageCount - 1) };
    else pendingPdf = null;
    state.selected = new Set([underlaySelectionId(underlay.id)]);
    setMode('SELECT');
    const lost = operation.notes && operation.notes.length ? ` (${operation.notes.join('; ')})` : '';
    updatePrompt(`PDF page placed at ${scalePresetLabel(operation.scale)}, ${formatLengthLabel(underlayWidth(underlay))} wide${lost}. `
      + (more ? 'Type PDF to place another page of the same file.' : 'CALIBRATE checks it against a known dimension.'));
  },

  // Enter takes the page on offer; once a page is waiting to be placed it
  // means what it means to IMAGE, which is "never mind".
  finish() {
    const operation = state.underlay;
    if (operation?.stage === 'PAGE') {
      choosePdfPage(operation, operation.pageIndex);
      return;
    }
    setMode('SELECT');
  },
});

// ---------------------------------------------------------------------------
// CALIBRATE
//
// Pick two points whose real separation is known, type the distance, and the
// image is scaled about the first pick. Holding the first pick fixed matters:
// the user has just told you where a known point on the image is, and moving it
// out from under them would undo the very thing they were establishing.
// ---------------------------------------------------------------------------

defineCommand('CALIBRATE', {
  stateMode: 'CALIBRATE',

  canBegin() {
    if (!state.underlays.some(underlayIsSelectable)) {
      updatePrompt('CALIBRATE — there is no unlocked image to calibrate.');
      return false;
    }
    return true;
  },

  begin() {
    const preselected = state.underlays.filter(underlay =>
      state.selected.has(underlaySelectionId(underlay.id)) && underlayIsSelectable(underlay));
    const selectable = state.underlays.filter(underlayIsSelectable);
    // One image, or exactly one selected, is not a choice worth asking about.
    const target = preselected.length === 1 ? preselected[0]
      : (selectable.length === 1 ? selectable[0] : null);
    state.underlay = {
      stage: target ? 'FIRST' : 'PICK',
      targetId: target ? target.id : null,
      first: null,
      second: null,
    };
  },

  // Calibration points are read off a raster, so OSNAP has nothing useful to
  // contribute and a stray endpoint snap would silently calibrate against the
  // wrong place. A PDF page is the exception: its dimension lines have real
  // ends, and landing exactly on them is the whole of an accurate calibration.
  usesSnap() {
    const target = state.underlays.find(underlay => underlay.id === state.underlay?.targetId);
    return Boolean(target) && underlayIsVector(target);
  },

  takesDistance() {
    return state.underlay?.stage === 'DISTANCE';
  },

  acceptsPoint() {
    return state.underlay?.stage !== 'DISTANCE';
  },

  prompt() {
    const operation = state.underlay;
    if (!operation) return 'CALIBRATE:';
    if (operation.stage === 'PICK') return 'CALIBRATE — Select the image to calibrate:';
    if (operation.stage === 'FIRST') return 'CALIBRATE — Specify first point of a known distance:';
    if (operation.stage === 'SECOND') return 'CALIBRATE — Specify second point of the known distance:';
    const measured = dist(operation.first, operation.second);
    return `CALIBRATE — Enter the true distance between those points (${formatLength(measured)} at present):`;
  },

  point(p) {
    const operation = state.underlay;
    if (!operation) return;
    if (operation.stage === 'PICK') {
      const target = [...state.underlays].reverse()
        .find(underlay => underlayIsSelectable(underlay) && underlayContainsPoint(underlay, p));
      if (!target) {
        updatePrompt('CALIBRATE — that is not on an unlocked image. Pick again:');
        return;
      }
      operation.targetId = target.id;
      operation.stage = 'FIRST';
      updatePrompt();
      return;
    }
    if (operation.stage === 'FIRST') {
      operation.first = { ...p };
      operation.stage = 'SECOND';
      updatePrompt();
      return;
    }
    if (operation.stage === 'SECOND') {
      if (dist(operation.first, p) < 1e-9) {
        updatePrompt('CALIBRATE — those points are in the same place. Pick the second point again:');
        return;
      }
      operation.second = { ...p };
      operation.stage = 'DISTANCE';
      updatePrompt();
      draw();
    }
  },

  distance(value) {
    applyCalibration(value);
  },

  // The typed value can carry a unit suffix (12', 150mm), which parseDistance
  // already understands, so it is routed here as well as through distance().
  value(text) {
    if (state.underlay?.stage !== 'DISTANCE') return false;
    const parsed = parseDistance(text);
    if (parsed === null) {
      updatePrompt('Enter a distance, for example 24 or 2\' or 600mm.');
      return true;
    }
    applyCalibration(parsed);
    return true;
  },

  previewReady() {
    return Boolean(state.underlay?.first) && state.underlay.stage === 'SECOND';
  },

  // The measuring line is the whole feedback for this stage: it is what tells
  // the user which two features of the image they are about to declare a
  // distance between.
  preview(p) {
    drawEntity({ type: 'LINE', a: state.underlay.first, b: p }, true);
  },

  finish() {
    setMode('SELECT');
  },
});

export function applyCalibration(knownDistance) {
  const operation = state.underlay;
  if (!operation || operation.stage !== 'DISTANCE') return;
  const target = state.underlays.find(underlay => underlay.id === operation.targetId);
  if (!target) {
    updatePrompt('That image is no longer in the drawing.');
    setMode('SELECT');
    return;
  }
  const result = calibrateUnderlay(target, operation.first, operation.second, knownDistance);
  if (result.error) {
    updatePrompt(`CALIBRATE — ${result.error}`);
    return;
  }
  const underlays = state.underlays.map(underlay =>
    underlay.id === target.id ? result.underlay : underlay);
  if (!commitGeometry(state.entities, { underlays })) return;
  state.selected = new Set([underlaySelectionId(target.id)]);
  setMode('SELECT');
  updatePrompt(`Image calibrated: scaled ${result.factor.toFixed(4)}x, now ${formatLengthLabel(underlayWidth(result.underlay))} wide.`);
}
