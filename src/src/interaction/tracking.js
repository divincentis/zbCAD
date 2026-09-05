import { activeCommand, commandUsesOrtho, commandUsesSnap } from '../commands/registry.js';
import { POLAR_APERTURE_PX } from '../core/constants.js';
import { normalizeAngle } from '../core/math.js';
import { getSnap } from './snap.js';
import { state } from '../state.js';

export function applyPolar(p, base) {
  state.polarLock = null;
  if (!state.polar || state.ortho || !base) return p;
  const dx = p.x - base.x;
  const dy = p.y - base.y;
  const reach = Math.hypot(dx, dy);
  if (reach < 1e-9) return p;

  const step = state.polarIncrement * Math.PI / 180;
  const angle = Math.atan2(dy, dx);
  const locked = Math.round(angle / step) * step;
  // The cursor's distance from the alignment ray is the component across it,
  // which is what the aperture is measured against.
  const across = Math.abs(reach * Math.sin(angle - locked));
  if (across * state.view.scale > POLAR_APERTURE_PX) return p;

  // Project onto the ray rather than rotating the point, so the cursor's
  // reach along the alignment is preserved instead of being stretched.
  const along = reach * Math.cos(angle - locked);
  if (along <= 1e-9) return p;
  const point = { x: base.x + along * Math.cos(locked), y: base.y + along * Math.sin(locked) };
  state.polarLock = { base: { ...base }, point, angle: normalizeAngle(locked), distance: along };
  return point;
}

export function applyOrtho(p, base) {
  if (!state.ortho || !base) return p;
  const dx = p.x - base.x;
  const dy = p.y - base.y;
  return Math.abs(dx) >= Math.abs(dy) ? { x: p.x, y: base.y } : { x: base.x, y: p.y };
}

export function getCommandBasePoint() {
  const command = activeCommand();
  if (command) {
    if (state.currentPoints.length) {
      return state.currentPoints[state.currentPoints.length - 1];
    }
    // Commands that do not accumulate points name their own anchor, and a
    // null answer means this stage has none.
    if (command.basePoint) return command.basePoint();
  }
  return null;
}

export function getActivePoint() {
  const command = activeCommand();
  // A pick that names a place on the screen — which side of a line, which
  // piece to cut — must not be pulled onto nearby geometry.
  if (!commandUsesSnap(command)) {
    state.snap = null;
    return { ...state.mouseWorld };
  }
  const base = getCommandBasePoint();
  // Registered commands may opt into ORTHO for every point or only for the
  // stages where a constraint makes sense. Polar tracking answers to the same
  // opt-in, because it constrains the same points for the same reason.
  let p = { ...state.mouseWorld };
  if (commandUsesOrtho(command)) p = applyPolar(applyOrtho(p, base), base);
  else state.polarLock = null;
  state.snap = getSnap(p, base, command?.snapExcludes?.() ?? null);
  // An acquired snap is a definite point the draughtsman asked for, so it
  // outranks a tracking guess, and the guide is dropped with it.
  if (state.snap) { p = state.snap.p; state.polarLock = null; }
  return p;
}
