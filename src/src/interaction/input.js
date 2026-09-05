import { unitConversion } from '../core/units.js';
import { state } from '../state.js';

export function parseMagnitude(text) {
  const s = String(text).trim();
  if (!s) return null;

  const mixed = s.match(/^(\d+)[\s-](\d+)\/(\d+)$/);
  if (mixed) {
    const denominator = Number(mixed[3]);
    return denominator > 0 ? Number(mixed[1]) + Number(mixed[2]) / denominator : null;
  }

  const fraction = s.match(/^(\d+)\/(\d+)$/);
  if (fraction) {
    const denominator = Number(fraction[2]);
    return denominator > 0 ? Number(fraction[1]) / denominator : null;
  }

  // A leading or trailing point is ordinary CAD entry: .5 and 5. both mean
  // what they look like, and rejecting them made the command line feel broken.
  return /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(s) ? Number(s) : null;
}

// Ordered longest-first so mm beats m and cm beats m.
export const DISTANCE_SUFFIXES = [
  { pattern: /^(.*?)\s*(?:mm|millimeters?|millimetres?)$/, unit: 'millimeters' },
  { pattern: /^(.*?)\s*(?:cm|centimeters?|centimetres?)$/, unit: 'centimeters' },
  { pattern: /^(.*?)\s*(?:m|meters?|metres?)$/, unit: 'meters' },
  { pattern: /^(.*?)\s*(?:"|in|inch|inches)$/, unit: 'inches' },
];

export function parseDistance(text, settings = state.unitSettings) {
  // Whitespace is collapsed but NOT removed: "3 1/2" and "31/2" differ.
  let s = String(text).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;

  let sign = 1;
  if (s.startsWith('-')) { sign = -1; s = s.slice(1).trim(); }
  else if (s.startsWith('+')) { s = s.slice(1).trim(); }
  if (!s) return null;

  const toDrawing = unit => unitConversion(unit, settings.drawingUnit);
  const finite = value => Number.isFinite(value) ? value : null;

  // Feet, optionally with inches: 5'   5'6"   5'6-1/2"   5 ft 6 in
  const ftIn = s.match(/^([\d./ -]*\d)\s*(?:'|ft|feet)\s*(?:[-\s]*(.+?)\s*(?:"|in|inch|inches)?)?$/);
  if (ftIn) {
    const feet = parseMagnitude(ftIn[1]);
    const inchPart = ftIn[2] === undefined ? 0 : parseMagnitude(ftIn[2]);
    if (feet !== null && inchPart !== null) {
      return finite(sign * (feet * 12 + inchPart) * toDrawing('inches'));
    }
  }

  // An explicit unit suffix is a physical length, converted to drawing units.
  for (const { pattern, unit } of DISTANCE_SUFFIXES) {
    const match = s.match(pattern);
    if (!match) continue;
    const value = parseMagnitude(match[1]);
    if (value !== null) return finite(sign * value * toDrawing(unit));
  }

  // A bare number or fraction is already in drawing units.
  const bare = parseMagnitude(s);
  return bare === null ? null : finite(sign * bare);
}

export function parsePoint(text, basePoint) {
  // Inner whitespace is preserved so parseDistance can see mixed numbers.
  const s = text.trim();
  if (!s) return null;

  const relative = s.startsWith('@');
  const body = relative ? s.slice(1) : s;
  const origin = relative ? basePoint : { x: 0, y: 0 };
  if (relative && !origin) return null;

  const polarSeparator = body.lastIndexOf('<');
  if (polarSeparator > 0) {
    const distance = parseDistance(body.slice(0, polarSeparator));
    const angleText = body.slice(polarSeparator + 1).trim();
    if (!angleText) return null;
    const angle = Number(angleText);
    if (distance === null || !Number.isFinite(angle)) return null;
    const radians = (angle % 360) * Math.PI / 180;
    return cleanPoint({
      x: origin.x + distance * Math.cos(radians),
      y: origin.y + distance * Math.sin(radians),
    });
  }

  const parts = body.split(',');
  if (parts.length !== 2) return null;
  const x = parseDistance(parts[0]);
  const y = parseDistance(parts[1]);
  if (x === null || y === null) return null;
  return cleanPoint({ x: origin.x + x, y: origin.y + y });
}

export function commitPointInput(text) {
  const acceptsPoint = commandAcceptsPoint();
  if (!acceptsPoint) return false;
  const s = text.trim();
  if (!s.startsWith('@') && !s.includes(',') && !s.includes('<')) return false;
  const base = getCommandBasePoint();
  const point = parsePoint(s, base);
  if (!point) {
    updatePrompt(s.startsWith('@') && !base
      ? 'Specify a first point before relative entry.'
      : 'Invalid point. Use x,y, @x,y, or @distance<angle.');
    return true;
  }
  commitPoint(point);
  return true;
}

export function commitCommandKeyword(text) {
  const command = activeCommand();
  if (!command) return false;
  const keyword = text.trim().toUpperCase();

  // Close and Undo are common point-run conventions. They remain distinct
  // hooks because not every point-driven command supports either action.
  if (state.currentPoints.length && ['C', 'CLOSE'].includes(keyword) && command.close) {
    command.close();
    return true;
  }
  if (state.currentPoints.length && ['U', 'UNDO'].includes(keyword) && command.undoPoint) {
    command.undoPoint();
    return true;
  }

  return command.keyword ? Boolean(command.keyword(text)) : false;
}

// Retained for the test/diagnostic API while input dispatch remains generic.
export function commitCircleKeyword(text) {
  return state.mode === 'CIRCLE' && commitCommandKeyword(text);
}

export function commitDistance(value) {
  const command = activeCommand();
  if (command?.distance?.(value)) return true;
  // Like usesOrtho, this is static for commands where every point can take a
  // distance and stage-dependent for those where only one can.
  const acceptsDistance = commandTakesDistance(command);
  const base = getCommandBasePoint();
  if (!acceptsDistance || !base) return false;
  let target = getActivePoint();
  let dx = target.x - base.x;
  let dy = target.y - base.y;
  let len = Math.hypot(dx, dy);
  if (len < 1e-9) { dx = 1; dy = 0; len = 1; }
  const p = { x: base.x + value * dx / len, y: base.y + value * dy / len };
  commitPoint(p);
  return true;
}

// Typed input that is neither a point nor a distance. It runs after point
// entry, so a command reading an angle still sees "@30,40" as a point rather
// than as malformed degrees. It runs before distance entry by convention
// rather than necessity: no command currently reads both a value and a
// direct distance, so nothing yet depends on that half of the order.
//
// A command that consumes the text reports true, including when the text was
// invalid for the stage — the value belongs to the command either way, and
// falling through would report it as an unknown command name.
export function commitCommandValue(text) {
  return Boolean(activeCommand()?.value?.(text));
}

// Retained as narrow public wrappers for existing tests and integrations.
export function commitAngleInput(text) {
  if (state.mode !== 'ROTATE') return false;
  return commitCommandKeyword(text) || commitCommandValue(text);
}

export function commitScaleInput(text) {
  if (state.mode !== 'SCALE') return false;
  return commitCommandKeyword(text) || commitCommandValue(text);
}
