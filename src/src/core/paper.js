import { DRAWING_UNITS } from './units.js';
import { state } from '../state.js';

// ---------------------------------------------------------------------------
// Paper
//
// Sheet sizes are physical millimetres, deliberately independent of both the
// drawing's own unit and of PDF points, so exactly one place knows how big a
// sheet is and every consumer converts from there.
//
// A drawing scale is the dimensionless ratio between a real-world length and
// the paper length that stands for it: 1/4" = 1'-0" is 48 because a foot is
// 48 quarter-inches, and 1" = 20' is 240 for the same reason. Being a ratio of
// two physical lengths it does not depend on the unit the geometry is stored
// in, which is what lets one number drive an inch drawing and a metric one —
// and what makes an exactly scaled plot possible at all.
// ---------------------------------------------------------------------------

export const MM_PER_INCH = 25.4;
// PDF user space is 1/72 inch. Nothing outside output/pdf.js should need this.
export const POINTS_PER_MM = 72 / MM_PER_INCH;

// Portrait dimensions; orientation is applied by paperSizeMM. The imperial
// sizes are written as inches times MM_PER_INCH rather than as rounded
// millimetres, because that is what they actually are — a 24 x 36 ARCH D sheet
// is exactly 609.6 x 914.4 mm and a plot at an exact scale has to stay exact.
export const PAPER_SIZES = Object.freeze([
  { id: 'ansi-a', name: 'ANSI A — 8.5 × 11 in', widthMM: 8.5 * MM_PER_INCH, heightMM: 11 * MM_PER_INCH },
  { id: 'ansi-b', name: 'ANSI B — 11 × 17 in', widthMM: 11 * MM_PER_INCH, heightMM: 17 * MM_PER_INCH },
  { id: 'ansi-c', name: 'ANSI C — 17 × 22 in', widthMM: 17 * MM_PER_INCH, heightMM: 22 * MM_PER_INCH },
  { id: 'ansi-d', name: 'ANSI D — 22 × 34 in', widthMM: 22 * MM_PER_INCH, heightMM: 34 * MM_PER_INCH },
  { id: 'ansi-e', name: 'ANSI E — 34 × 44 in', widthMM: 34 * MM_PER_INCH, heightMM: 44 * MM_PER_INCH },
  { id: 'arch-a', name: 'ARCH A — 9 × 12 in', widthMM: 9 * MM_PER_INCH, heightMM: 12 * MM_PER_INCH },
  { id: 'arch-b', name: 'ARCH B — 12 × 18 in', widthMM: 12 * MM_PER_INCH, heightMM: 18 * MM_PER_INCH },
  { id: 'arch-c', name: 'ARCH C — 18 × 24 in', widthMM: 18 * MM_PER_INCH, heightMM: 24 * MM_PER_INCH },
  { id: 'arch-d', name: 'ARCH D — 24 × 36 in', widthMM: 24 * MM_PER_INCH, heightMM: 36 * MM_PER_INCH },
  { id: 'arch-e', name: 'ARCH E — 36 × 48 in', widthMM: 36 * MM_PER_INCH, heightMM: 48 * MM_PER_INCH },
  { id: 'iso-a4', name: 'ISO A4 — 210 × 297 mm', widthMM: 210, heightMM: 297 },
  { id: 'iso-a3', name: 'ISO A3 — 297 × 420 mm', widthMM: 297, heightMM: 420 },
  { id: 'iso-a2', name: 'ISO A2 — 420 × 594 mm', widthMM: 420, heightMM: 594 },
  { id: 'iso-a1', name: 'ISO A1 — 594 × 841 mm', widthMM: 594, heightMM: 841 },
  { id: 'iso-a0', name: 'ISO A0 — 841 × 1189 mm', widthMM: 841, heightMM: 1189 },
]);

// A commercial roof plan is the workflow this tool exists for, and ARCH D
// landscape is the sheet it is issued on.
export const DEFAULT_PAPER_SIZE_ID = 'arch-d';
export const PAPER_ORIENTATIONS = Object.freeze({ landscape: 'Landscape', portrait: 'Portrait' });

// A half-inch border. Nothing is plotted into it: the plot is fitted inside it
// and clipped to it, which is also roughly the unprintable edge of a plotter.
export const PAPER_MARGIN_MM = 0.5 * MM_PER_INCH;

// Both lists are [label, model length per paper length]. Shared with the
// dimension style dialog, which needs exactly the same number for a different
// reason: a dimension's paper text height is multiplied by it to get a model
// text height, so a drawing plotted at 1/4" = 1'-0" wants DIMSCALE 48.
export const IMPERIAL_SCALE_PRESETS = Object.freeze([
  ['Full size (1:1)', 1], ['3" = 1\'-0"', 4], ['1 1/2" = 1\'-0"', 8],
  ['1" = 1\'-0"', 12], ['3/4" = 1\'-0"', 16], ['1/2" = 1\'-0"', 24],
  ['3/8" = 1\'-0"', 32], ['1/4" = 1\'-0"', 48], ['3/16" = 1\'-0"', 64],
  ['1/8" = 1\'-0"', 96], ['1/16" = 1\'-0"', 192],
  // Engineering scales. A roof or site plan is drawn at these, not at the
  // architectural fractions above.
  ['1" = 10\'', 120], ['1" = 20\'', 240], ['1" = 30\'', 360], ['1" = 40\'', 480],
  ['1" = 50\'', 600], ['1" = 60\'', 720], ['1" = 100\'', 1200],
]);
export const METRIC_SCALE_PRESETS = Object.freeze([
  ['Full size (1:1)', 1], ['1:2', 2], ['1:5', 5], ['1:10', 10], ['1:20', 20],
  ['1:25', 25], ['1:50', 50], ['1:100', 100], ['1:200', 200], ['1:500', 500],
  ['1:1000', 1000],
]);

export function scalePresets(drawingUnit = state.unitSettings.drawingUnit) {
  return drawingUnit === 'inches' || drawingUnit === 'feet'
    ? IMPERIAL_SCALE_PRESETS : METRIC_SCALE_PRESETS;
}

export function scalePresetLabel(value, drawingUnit = state.unitSettings.drawingUnit) {
  const match = scalePresets(drawingUnit).find(([, preset]) => Math.abs(preset - value) < 1e-9);
  if (match) return match[0];
  return value >= 1 ? `1:${Number(value.toFixed(4))}` : `${Number((1 / value).toFixed(4))}:1`;
}

export function getPaperSize(id) {
  return PAPER_SIZES.find(size => size.id === id) ||
    PAPER_SIZES.find(size => size.id === DEFAULT_PAPER_SIZE_ID);
}

export function paperSizeMM(id, orientation) {
  const size = getPaperSize(id);
  return orientation === 'portrait'
    ? { widthMM: size.widthMM, heightMM: size.heightMM }
    : { widthMM: size.heightMM, heightMM: size.widthMM };
}

// The one conversion the whole plot rests on: how many millimetres of paper
// one drawing unit becomes. Everything else in a plot is this number times a
// model coordinate.
export function paperMMPerDrawingUnit(scale, drawingUnit = state.unitSettings.drawingUnit) {
  return DRAWING_UNITS[drawingUnit].mmPerUnit / scale;
}
