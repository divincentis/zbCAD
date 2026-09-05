import { DEFAULT_UNIT_SETTINGS } from './defaults.js';
import { state } from '../state.js';

// ---------------------------------------------------------------------------
// Units
//
// Three concerns that the prototype previously collapsed into the single
// string 'inches', kept separate here:
//
//   1. STORAGE — geometry is plain doubles in "drawing units". Nothing below
//      changes a stored coordinate.
//   2. MEANING — `drawingUnit` declares what one drawing unit is physically.
//      Modelled on the DXF $INSUNITS header. This is what later makes exact
//      scaled PDF output and block insertion scaling possible.
//   3. DISPLAY — `format` and `precision` control how a length is written.
//
// Typed input is converted on the way in: a bare number is already in drawing
// units, a suffixed value ("6\"", "150mm") is a physical length and is
// converted through mmPerUnit.
// ---------------------------------------------------------------------------

export const DRAWING_UNITS = {
  inches:      { name: 'Inches',      abbreviation: 'in', mmPerUnit: 25.4 },
  feet:        { name: 'Feet',        abbreviation: 'ft', mmPerUnit: 304.8 },
  millimeters: { name: 'Millimeters', abbreviation: 'mm', mmPerUnit: 1 },
  centimeters: { name: 'Centimeters', abbreviation: 'cm', mmPerUnit: 10 },
  meters:      { name: 'Meters',      abbreviation: 'm',  mmPerUnit: 1000 },
};

// `requiresInchUnit` marks the two formats whose text is only meaningful when
// one drawing unit is one inch, matching AutoCAD.
export const LENGTH_FORMATS = {
  decimal: {
    name: 'Decimal',
    sample: '18.50',
    precisions: [0, 1, 2, 3, 4, 5, 6],
    defaultPrecision: 2,
    precisionLabel: value => `${value} decimal place${value === 1 ? '' : 's'}`,
    shortName: 'DEC',
    precisionShort: value => `${value}dp`,
  },
  architectural: {
    name: 'Architectural',
    sample: '1\'-6 1/2"',
    requiresInchUnit: true,
    precisions: [1, 2, 4, 8, 16, 32, 64],
    defaultPrecision: 16,
    precisionLabel: value => (value === 1 ? 'whole inch' : `1/${value}"`),
    shortName: 'ARCH',
    precisionShort: value => (value === 1 ? '1"' : `1/${value}"`),
  },
  engineering: {
    name: 'Engineering',
    sample: '1\'-6.50"',
    requiresInchUnit: true,
    precisions: [0, 1, 2, 3, 4],
    defaultPrecision: 2,
    precisionLabel: value => `${value} decimal place${value === 1 ? '' : 's'}`,
    shortName: 'ENG',
    precisionShort: value => `${value}dp`,
  },
  fractional: {
    name: 'Fractional',
    sample: '18 1/2',
    precisions: [1, 2, 4, 8, 16, 32, 64],
    defaultPrecision: 16,
    precisionLabel: value => (value === 1 ? 'whole units' : `1/${value}`),
    shortName: 'FRAC',
    precisionShort: value => (value === 1 ? '1' : `1/${value}`),
  },
};

export const MAX_ANGLE_PRECISION = 6;


export function unitConversion(fromUnit, toUnit) {
  return DRAWING_UNITS[fromUnit].mmPerUnit / DRAWING_UNITS[toUnit].mmPerUnit;
}

export function formatsForUnit(drawingUnit) {
  return Object.entries(LENGTH_FORMATS)
    .filter(([, spec]) => !spec.requiresInchUnit || drawingUnit === 'inches')
    .map(([key]) => key);
}

export function parseUnitSettings(value) {
  // Document version 2 stored a bare 'inches' string and always displayed two
  // decimal places. Migrate to exactly that, so an old file still looks the
  // way it did when it was saved.
  if (typeof value === 'string') {
    if (value !== 'inches') return { error: `Unsupported drawing units: ${value}.` };
    return {
      settings: {
        drawingUnit: 'inches',
        format: 'decimal',
        precision: 2,
        angleFormat: 'degrees',
        anglePrecision: 1,
      },
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'The drawing has no unit settings.' };
  }
  const drawingUnit = typeof value.drawingUnit === 'string' ? value.drawingUnit : '';
  if (!DRAWING_UNITS[drawingUnit]) {
    return { error: `Unsupported drawing unit: ${drawingUnit || '(missing)'}.` };
  }
  const format = typeof value.format === 'string' ? value.format : '';
  const spec = LENGTH_FORMATS[format];
  if (!spec) return { error: `Unsupported length format: ${format || '(missing)'}.` };
  if (spec.requiresInchUnit && drawingUnit !== 'inches') {
    return { error: `The ${spec.name} format requires inch drawing units.` };
  }
  if (!spec.precisions.includes(value.precision)) {
    return { error: `Unsupported ${spec.name} precision: ${String(value.precision)}.` };
  }
  if (value.angleFormat !== undefined && value.angleFormat !== 'degrees') {
    return { error: `Unsupported angle format: ${String(value.angleFormat)}.` };
  }
  const anglePrecision = Number.isInteger(value.anglePrecision) &&
    value.anglePrecision >= 0 && value.anglePrecision <= MAX_ANGLE_PRECISION
    ? value.anglePrecision
    : DEFAULT_UNIT_SETTINGS.anglePrecision;
  return {
    settings: { drawingUnit, format, precision: value.precision, angleFormat: 'degrees', anglePrecision },
  };
}

export function reduceFraction(numerator, denominator) {
  let a = numerator;
  let b = denominator;
  while (b) { const remainder = a % b; a = b; b = remainder; }
  const divisor = a || 1;
  return [numerator / divisor, denominator / divisor];
}

export function formatFractionalLength(value, denominator) {
  const sign = value < 0 ? '-' : '';
  const ticks = Math.round(Math.abs(value) * denominator);
  const whole = Math.floor(ticks / denominator);
  const remainder = ticks - whole * denominator;
  if (!remainder) return `${sign}${whole}`;
  const [numerator, reduced] = reduceFraction(remainder, denominator);
  return `${sign}${whole ? `${whole} ` : ''}${numerator}/${reduced}`;
}

export function formatArchitecturalLength(inches, denominator) {
  const sign = inches < 0 ? '-' : '';
  // Round to the fraction first, so a value that rounds up carries correctly
  // into whole inches and then into feet: 11.999" at 1/16 is 1'-0", not 0'-12".
  const ticks = Math.round(Math.abs(inches) * denominator);
  const totalInches = Math.floor(ticks / denominator);
  const remainder = ticks - totalInches * denominator;
  const feet = Math.floor(totalInches / 12);
  let inchText = String(totalInches - feet * 12);
  if (remainder) {
    const [numerator, reduced] = reduceFraction(remainder, denominator);
    inchText += ` ${numerator}/${reduced}`;
  }
  return `${sign}${feet}'-${inchText}"`;
}

export function formatEngineeringLength(inches, decimals) {
  const sign = inches < 0 ? '-' : '';
  const scale = Math.pow(10, decimals);
  const ticks = Math.round(Math.abs(inches) * scale);
  const ticksPerFoot = 12 * scale;
  const feet = Math.floor(ticks / ticksPerFoot);
  const inchTicks = ticks - feet * ticksPerFoot;
  return `${sign}${feet}'-${(inchTicks / scale).toFixed(decimals)}"`;
}

export function formatLength(value, settings = state.unitSettings) {
  if (!Number.isFinite(value)) return '—';
  if (settings.format === 'architectural') return formatArchitecturalLength(value, settings.precision);
  if (settings.format === 'engineering') return formatEngineeringLength(value, settings.precision);
  if (settings.format === 'fractional') return formatFractionalLength(value, settings.precision);
  // Avoid rendering "-0.00" for values that round to zero from below.
  const fixed = value.toFixed(settings.precision);
  return Number(fixed) === 0 ? (0).toFixed(settings.precision) : fixed;
}

// For prompts and labels, where the number alone would be ambiguous.
// Architectural and engineering text already carries its own foot/inch marks.
export function formatLengthLabel(value, settings = state.unitSettings) {
  const text = formatLength(value, settings);
  if (settings.format === 'architectural' || settings.format === 'engineering') return text;
  return `${text} ${DRAWING_UNITS[settings.drawingUnit].abbreviation}`;
}

export function formatAngle(radians, settings = state.unitSettings) {
  return `${(radians * 180 / Math.PI).toFixed(settings.anglePrecision)}°`;
}

// Areas are always shown in decimal square units: "1'-6 1/2" squared" is not
// a thing anyone writes. Where a second unit is the one people actually think
// in (square feet on an inch drawing, square metres on a millimetre drawing)
// it is shown alongside rather than instead.
export const AREA_UNITS = {
  inches:      { symbol: 'in\u00b2', precision: 2, secondary: { symbol: 'ft\u00b2', per: 144, precision: 2 } },
  feet:        { symbol: 'ft\u00b2', precision: 3 },
  millimeters: { symbol: 'mm\u00b2', precision: 1, secondary: { symbol: 'm\u00b2', per: 1e6, precision: 3 } },
  centimeters: { symbol: 'cm\u00b2', precision: 2, secondary: { symbol: 'm\u00b2', per: 1e4, precision: 3 } },
  meters:      { symbol: 'm\u00b2', precision: 3 },
};

// Areas get large fast; grouping is the difference between a readable number
// and one that has to be counted. Done by hand rather than with toLocaleString
// so the output does not change with the browser locale.
export function groupDigits(text) {
  const [whole, fraction] = text.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const digits = sign ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}${fraction === undefined ? '' : `.${fraction}`}`;
}

export function formatArea(value, settings = state.unitSettings) {
  if (!Number.isFinite(value)) return '—';
  const spec = AREA_UNITS[settings.drawingUnit];
  const primary = `${groupDigits(value.toFixed(spec.precision))} ${spec.symbol}`;
  if (!spec.secondary) return primary;
  const converted = value / spec.secondary.per;
  return `${primary} (${groupDigits(converted.toFixed(spec.secondary.precision))} ${spec.secondary.symbol})`;
}
