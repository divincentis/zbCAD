import { DEFAULT_DIM_STYLE_ID, defaultDimStyle } from './defaults.js';
import { DRAWING_UNITS, LENGTH_FORMATS } from './units.js';
import { state } from '../state.js';

// ---------------------------------------------------------------------------
// Dimension styles
//
// Sizes are stored at PAPER scale and multiplied by `scale` to get model-space
// size, which is how DIMSCALE works and the only thing that makes a 3/16" text
// height meaningful on a 40-foot building. Until there is a plot scale, the
// user sets `scale` to their intended drawing scale (48 for 1/4" = 1'-0").
//
// arrowType is the single most visible difference between disciplines:
// architectural work uses ticks, mechanical work uses arrows.
// ---------------------------------------------------------------------------

export const ARROW_TYPES = { tick: 'Architectural tick', arrow: 'Filled arrow' };


export const DIM_NUMERIC_STYLE_FIELDS = ['textHeight', 'arrowSize', 'extensionOffset', 'extensionBeyond', 'textGap', 'scale'];

// `format` is the drawing's length format; a style's precision is an override
// of the drawing precision, so null means "follow the drawing" and anything
// else has to be a precision that format actually supports. Without this check
// an imported style could carry, say, precision 7 in a fractional drawing, load
// cleanly, and then crash the first time a dimension was drawn.
export function parseDimStyle(value, format = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'is not an object' };
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : '';
  if (!id) return { error: 'has no id' };
  if (!ARROW_TYPES[value.arrowType]) return { error: `has an unsupported arrow type ${String(value.arrowType)}` };
  // Field order matches defaultDimStyle() on purpose. A style built here used to
  // come back with `scale` last, so saving a drawing, reloading it, and saving
  // again produced two files that differed byte for byte with identical content
  // — enough to make saved drawings undiffable and any text comparison lie.
  const style = {
    id,
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : id,
    arrowType: value.arrowType,
    scale: value.scale,
    precision: value.precision === null || value.precision === undefined ? null : value.precision,
  };
  if (style.precision !== null) {
    const allowed = format ? LENGTH_FORMATS[format]?.precisions : null;
    if (!allowed) return { error: 'sets a precision but the drawing has no usable length format' };
    if (!allowed.includes(style.precision)) {
      return { error: `has an unsupported precision ${String(style.precision)} for ${LENGTH_FORMATS[format].name}` };
    }
  }
  for (const field of DIM_NUMERIC_STYLE_FIELDS) {
    if (!Number.isFinite(value[field]) || value[field] <= 0) return { error: `has an invalid ${field}` };
    style[field] = value[field];
  }
  if (DIM_NUMERIC_STYLE_FIELDS.some(field => field !== 'scale' && !Number.isFinite(style[field] * style.scale))) {
    return { error: 'has sizes outside the supported numeric range' };
  }
  return { style };
}

// Dimension style sizes are paper sizes in the drawing's own unit, so a
// drawing switched from inches to millimetres was left with a 0.1875 mm text
// height — legible in neither system. Rebase, but only where the user has not
// customised the value, so a deliberate choice is never clobbered.
export function rebaseDimStyleUnit(style, fromUnit, toUnit) {
  const oldDefaults = defaultDimStyle(fromUnit);
  const newDefaults = defaultDimStyle(toUnit);
  const rebased = { ...style };
  for (const field of ['textHeight', 'arrowSize', 'extensionOffset', 'extensionBeyond', 'textGap']) {
    if (style[field] === oldDefaults[field]) rebased[field] = newDefaults[field];
  }
  if (style.arrowType === oldDefaults.arrowType) rebased.arrowType = newDefaults.arrowType;
  // `scale` and `precision` are statements about the drawing, not the unit.
  return rebased;
}

export function getDimStyle(id) {
  return state.dimStyles.find(style => style.id === id) ||
    state.dimStyles.find(style => style.id === DEFAULT_DIM_STYLE_ID) ||
    state.dimStyles[0];
}

// Every drawn size derives from the style's paper size times its scale.
export function dimSize(style, field) {
  return style[field] * style.scale;
}

export function unitSummary(settings = state.unitSettings) {
  const spec = LENGTH_FORMATS[settings.format];
  const unit = DRAWING_UNITS[settings.drawingUnit];
  return `${unit.abbreviation.toUpperCase()} · ${spec.shortName} ${spec.precisionShort(settings.precision)}`;
}
