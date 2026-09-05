import { defineCommand, setMode } from './registry.js';
import { circularPoint, dist } from '../core/math.js';
import { formatAngle, formatLength, formatLengthLabel } from '../core/units.js';
import { mirrorEntity, rotateEntity, scaleEntity, translateEntity } from '../geometry/transform.js';
import { parseDistance } from '../interaction/input.js';
import { commitGeometry } from '../model/document.js';
import { duplicateEntities, entityBBox } from '../model/entity.js';
import { isEntityEditable } from '../model/layerQuery.js';
import { state } from '../state.js';
import { updatePrompt } from '../ui/prompt.js';
import { draw } from '../view/frame.js';
import { drawEntity, drawTransformGuide } from '../view/render.js';

export function transformStages(type, initial = {}) {
  return {
    // A selection gathered by the command accumulates: each pick adds to the
    // set rather than replacing it, which is what a click means once the
    // command has asked for objects.
    additiveSelection: true,

    begin() {
      const ids = editableSelectionIds();
      state.transform = {
        type,
        // A preselection is taken as the answer to "select objects", so the
        // command opens at the base point instead of asking again.
        stage: ids.length ? 'BASE' : 'SELECT',
        ids,
        base: null,
        ...initial,
      };
    },

    selectsObjects() {
      return state.transform?.stage === 'SELECT';
    },

    // Every stage after the selection wants a point, including those that
    // also accept a typed angle or factor.
    acceptsPoint() {
      return Boolean(state.transform) && state.transform.stage !== 'SELECT';
    },

    // Enter means "that is my selection". Past that stage the command is
    // waiting for a value and has no default to accept, which is exactly what
    // acceptTransformSelection() reports by returning false, so there is no
    // second stage check here.
    finish() {
      return acceptTransformSelection();
    },
  };
}

export function transformSelectionPrompt(type) {
  const count = state.selected.size;
  return count
    ? `${type} — ${count} selected; press Enter or right-click to continue:`
    : `${type} — Select objects, then press Enter or right-click:`;
}

// MOVE and COPY differ only in whether the originals survive, so they share
// one specification; applyTransform() reads operation.type to decide between
// translating and duplicating.
export function translateCommand(type) {
  return {
    ...transformStages(type),

    // Only the destination is anchored: the base point is a free pick, and
    // the selection stage has no point to constrain at all.
    usesOrtho() {
      return state.transform?.stage === 'DEST';
    },

    takesDistance() {
      return state.transform?.stage === 'DEST';
    },

    basePoint() {
      return state.transform?.stage === 'DEST' ? state.transform.base : null;
    },

    prompt() {
      const stage = state.transform?.stage || 'SELECT';
      if (stage === 'SELECT') return transformSelectionPrompt(type);
      if (stage === 'BASE') return `${type} — Specify base point:`;
      return `${type} — Specify destination, distance, or relative point:`;
    },

    point(p) {
      if (state.transform?.stage === 'BASE') {
        state.transform.base = { ...p };
        state.transform.stage = 'DEST';
        updatePrompt();
      } else if (state.transform?.stage === 'DEST') {
        applyTransform(p);
      }
    },

    previewReady() {
      return state.transform?.stage === 'DEST';
    },

    preview(p) {
      const dx = p.x - state.transform.base.x;
      const dy = p.y - state.transform.base.y;
      const ids = new Set(state.transform.ids);
      for (const entity of state.entities) {
        if (ids.has(entity.id) && isEntityEditable(entity)) {
          drawEntity(translateEntity(entity, dx, dy), true);
        }
      }
      drawTransformGuide(
        state.transform.base,
        p,
        `${formatLengthLabel(Math.hypot(dx, dy))} @ ${formatAngle(Math.atan2(dy, dx))}`,
      );
    },
  };
}

defineCommand('MOVE', translateCommand('MOVE'));
defineCommand('COPY', translateCommand('COPY'));

// The stages at which ROTATE is waiting for an angle: directly, or as either
// half of a Reference pair. All three accept a point or typed degrees, and
// all three measure from the base point.
export const ROTATE_ANGLE_STAGES = ['ANGLE', 'ROTATE_REF', 'ROTATE_TARGET'];

// The equivalent for SCALE, where the value is a factor or a length.
export const SCALE_VALUE_STAGES = [
  'FACTOR', 'SCALE_REF_FIRST', 'SCALE_REF_SECOND', 'SCALE_REF_NEW',
];

export const DEGREES = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:°|deg)?$/i;
export const SCALE_FACTOR = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?:x)?$/i;
export const REFERENCE_KEYWORDS = ['R', 'REF', 'REFERENCE'];

defineCommand('ROTATE', {
  ...transformStages('ROTATE', { referenceStart: null, referenceAngle: null }),

  // A rotation about the base point is meaningful under ORTHO; picking the
  // reference or target direction is not, since those are absolute bearings
  // the user is reading off existing geometry.
  usesOrtho() {
    return state.transform?.stage === 'ANGLE';
  },

  basePoint() {
    return ROTATE_ANGLE_STAGES.includes(state.transform?.stage)
      ? state.transform.base
      : null;
  },

  prompt() {
    const stage = state.transform?.stage || 'SELECT';
    if (stage === 'SELECT') return transformSelectionPrompt('ROTATE');
    if (stage === 'BASE') return 'ROTATE — Specify base point:';
    if (stage === 'ROTATE_REF') return 'ROTATE Reference — Specify current reference point or angle:';
    if (stage === 'ROTATE_TARGET') return 'ROTATE Reference — Specify absolute target point or angle:';
    return 'ROTATE — Specify relative angle/point or [Reference]:';
  },

  point(p) {
    const operation = state.transform;
    if (!operation) return;
    if (operation.stage === 'BASE') {
      operation.base = { ...p };
      operation.stage = 'ANGLE';
      updatePrompt();
      return;
    }
    // A point arriving at the selection stage has no base to measure from.
    // Nothing in the UI can deliver one there, but the exposed commitPoint
    // hook can, and the previous dispatch ignored it rather than failing.
    if (!ROTATE_ANGLE_STAGES.includes(operation.stage)) return;
    // Every remaining stage reads a direction from the base point, so a pick
    // on the base itself carries no angle at all.
    const dx = p.x - operation.base.x;
    const dy = p.y - operation.base.y;
    if (Math.hypot(dx, dy) < 1e-9) {
      if (operation.stage === 'ANGLE') updatePrompt('Rotation point must differ from the base point.');
      else if (operation.stage === 'ROTATE_REF') updatePrompt('Reference point must differ from the base point.');
      else updatePrompt('Target point must differ from the base point.');
      return;
    }
    const angle = Math.atan2(dy, dx);
    if (operation.stage === 'ANGLE') {
      applyRotation(angle);
    } else if (operation.stage === 'ROTATE_REF') {
      operation.referenceAngle = angle;
      operation.referenceStart = { ...p };
      operation.stage = 'ROTATE_TARGET';
      updatePrompt();
    } else {
      applyRotation(angle - operation.referenceAngle);
    }
  },

  keyword(text) {
    const operation = state.transform;
    if (!ROTATE_ANGLE_STAGES.includes(operation?.stage)) return false;
    if (!REFERENCE_KEYWORDS.includes(text.trim().toUpperCase())) return false;
    // Asking for Reference again from the target stage discards the
    // half-entered pair rather than measuring against a stale bearing.
    operation.referenceAngle = null;
    operation.referenceStart = null;
    operation.stage = 'ROTATE_REF';
    updatePrompt();
    draw();
    return true;
  },

  value(text) {
    const operation = state.transform;
    if (!ROTATE_ANGLE_STAGES.includes(operation?.stage)) return false;
    const match = text.trim().match(DEGREES);
    if (!match) {
      updatePrompt('Invalid angle. Enter degrees, a point, or R for Reference.');
      return true;
    }
    const angle = Number(match[1]) * Math.PI / 180;
    if (operation.stage === 'ANGLE') {
      applyRotation(angle);
    } else if (operation.stage === 'ROTATE_REF') {
      operation.referenceAngle = angle;
      // A typed bearing has no picked point behind it, so a reference start
      // is synthesised on the unit circle purely to draw the guide.
      operation.referenceStart = circularPoint(operation.base, 1, angle);
      operation.stage = 'ROTATE_TARGET';
      updatePrompt();
      draw();
    } else {
      applyRotation(angle - operation.referenceAngle);
    }
    return true;
  },

  previewReady() {
    return ROTATE_ANGLE_STAGES.includes(state.transform?.stage);
  },

  preview(p) {
    const operation = state.transform;
    const targetAngle = Math.atan2(p.y - operation.base.y, p.x - operation.base.x);
    const stage = operation.stage;
    if (stage === 'ROTATE_REF') {
      drawTransformGuide(operation.base, p, `Reference ${formatAngle(targetAngle)}`, true);
      return;
    }

    const rotation = stage === 'ROTATE_TARGET'
      ? targetAngle - operation.referenceAngle
      : targetAngle;
    const ids = new Set(operation.ids);
    for (const entity of state.entities) {
      if (ids.has(entity.id) && isEntityEditable(entity)) {
        drawEntity(rotateEntity(entity, operation.base, rotation), true);
      }
    }
    if (stage === 'ROTATE_TARGET') {
      const guideRadius = Math.max(dist(operation.base, p), 40 / state.view.scale);
      const referenceEnd = circularPoint(operation.base, guideRadius, operation.referenceAngle);
      drawTransformGuide(operation.base, referenceEnd, 'Reference', true);
    }
    const label = stage === 'ROTATE_TARGET'
      ? `Target ${formatAngle(targetAngle)} · Δ ${formatAngle(rotation)}`
      : `Δ ${formatAngle(rotation)}`;
    drawTransformGuide(operation.base, p, label);
  },
});

defineCommand('SCALE', {
  ...transformStages('SCALE', { referenceStart: null, referenceLength: null }),

  basePoint() {
    const operation = state.transform;
    if (['FACTOR', 'SCALE_REF_FIRST'].includes(operation?.stage)) return operation.base;
    if (operation?.stage === 'SCALE_REF_SECOND') return operation.referenceStart;
    // The new length is measured from wherever the reference was taken, which
    // is the base point when the reference length was typed rather than
    // picked.
    if (operation?.stage === 'SCALE_REF_NEW') return operation.referenceStart || operation.base;
    return null;
  },

  prompt() {
    const operation = state.transform;
    const stage = operation?.stage || 'SELECT';
    if (stage === 'SELECT') return transformSelectionPrompt('SCALE');
    if (stage === 'BASE') return 'SCALE — Specify base point:';
    if (stage === 'SCALE_REF_FIRST') return 'SCALE Reference — Specify reference length or first point:';
    if (stage === 'SCALE_REF_SECOND') return 'SCALE Reference — Specify second reference point:';
    if (stage === 'SCALE_REF_NEW') {
      return `SCALE Reference — Specify new length (${formatLengthLabel(operation.referenceLength)} current):`;
    }
    return 'SCALE — Specify scale factor/point or [Reference]:';
  },

  point(p) {
    const operation = state.transform;
    if (!operation) return;
    if (operation.stage === 'BASE') {
      operation.base = { ...p };
      operation.stage = 'FACTOR';
      updatePrompt();
    } else if (operation.stage === 'FACTOR') {
      // Without Reference the distance from the base point is the factor
      // itself, so a point one unit away means 1x.
      applyScale(dist(operation.base, p));
    } else if (operation.stage === 'SCALE_REF_FIRST') {
      operation.referenceStart = { ...p };
      operation.stage = 'SCALE_REF_SECOND';
      updatePrompt();
    } else if (operation.stage === 'SCALE_REF_SECOND') {
      const referenceLength = dist(operation.referenceStart, p);
      if (referenceLength <= 1e-9) {
        updatePrompt('Reference points must be different.');
      } else {
        operation.referenceLength = referenceLength;
        operation.stage = 'SCALE_REF_NEW';
        updatePrompt();
      }
    } else if (operation.stage === 'SCALE_REF_NEW') {
      const anchor = operation.referenceStart || operation.base;
      const newLength = dist(anchor, p);
      if (newLength <= 1e-9) updatePrompt('New length must be greater than zero.');
      else applyScale(newLength / operation.referenceLength);
    }
  },

  keyword(text) {
    const operation = state.transform;
    if (!SCALE_VALUE_STAGES.includes(operation?.stage)) return false;
    if (!REFERENCE_KEYWORDS.includes(text.trim().toUpperCase())) return false;
    operation.referenceStart = null;
    operation.referenceLength = null;
    operation.stage = 'SCALE_REF_FIRST';
    updatePrompt();
    draw();
    return true;
  },

  value(text) {
    const operation = state.transform;
    if (!SCALE_VALUE_STAGES.includes(operation?.stage)) return false;

    if (operation.stage === 'FACTOR') {
      const match = text.trim().match(SCALE_FACTOR);
      if (!match) {
        updatePrompt('Invalid scale factor. Enter a positive number or R for Reference.');
        return true;
      }
      applyScale(Number(match[1]));
      return true;
    }

    const length = parseDistance(text);
    if (length === null || length <= 1e-9) {
      const expected = operation.stage === 'SCALE_REF_NEW' ? 'new length' : 'reference length';
      updatePrompt(`Invalid ${expected}. Enter a positive distance or specify a point.`);
      return true;
    }
    // A typed reference length answers both reference stages at once: there
    // is nothing left to measure, so the command jumps to the new length.
    if (operation.stage === 'SCALE_REF_FIRST' || operation.stage === 'SCALE_REF_SECOND') {
      operation.referenceLength = length;
      operation.stage = 'SCALE_REF_NEW';
      updatePrompt();
      draw();
    } else {
      applyScale(length / operation.referenceLength);
    }
    return true;
  },

  previewReady() {
    return SCALE_VALUE_STAGES.includes(state.transform?.stage);
  },

  preview(p) {
    const operation = state.transform;
    const stage = operation.stage;
    if (stage === 'SCALE_REF_FIRST' || stage === 'SCALE_REF_SECOND') {
      const anchor = stage === 'SCALE_REF_SECOND' ? operation.referenceStart : operation.base;
      const length = dist(anchor, p);
      drawTransformGuide(
        anchor, p,
        `${stage === 'SCALE_REF_SECOND' ? 'Reference ' : ''}${formatLengthLabel(length)}`,
        true,
      );
      return;
    }

    const newLengthAnchor = operation.referenceStart || operation.base;
    const candidateLength = dist(newLengthAnchor, p);
    const factor = stage === 'SCALE_REF_NEW'
      ? candidateLength / operation.referenceLength
      : candidateLength;
    const ids = new Set(operation.ids);
    if (factor > 1e-9 && Number.isFinite(factor)) {
      for (const entity of state.entities) {
        if (ids.has(entity.id) && isEntityEditable(entity)) {
          const preview = scaleEntity(entity, operation.base, factor);
          const box = entityBBox(preview);
          if (box && Object.values(box).every(value => Number.isFinite(value))) drawEntity(preview, true);
        }
      }
    }
    const label = stage === 'SCALE_REF_NEW'
      ? `${formatLength(candidateLength)} / ${formatLength(operation.referenceLength)} = ${factor.toFixed(3)}x`
      : `${factor.toFixed(3)}x`;
    drawTransformGuide(newLengthAnchor, p, label);
  },
});
// The stages at which MIRROR is placing the mirror line. Both measure from
// the first picked point, and ORTHO applies to the second: a mirror axis in a
// building plan is very often exactly horizontal or vertical.
export const MIRROR_AXIS_STAGES = ['BASE', 'SECOND'];

export const YES_KEYWORDS = ['Y', 'YES'];
export const NO_KEYWORDS = ['N', 'NO'];

defineCommand('MIRROR', {
  ...transformStages('MIRROR', { second: null }),

  usesOrtho() {
    return state.transform?.stage === 'SECOND';
  },

  takesDistance() {
    return state.transform?.stage === 'SECOND';
  },

  basePoint() {
    return state.transform?.stage === 'SECOND' ? state.transform.base : null;
  },

  acceptsPoint() {
    return MIRROR_AXIS_STAGES.includes(state.transform?.stage);
  },

  prompt() {
    const stage = state.transform?.stage || 'SELECT';
    if (stage === 'SELECT') return transformSelectionPrompt('MIRROR');
    if (stage === 'BASE') return 'MIRROR — Specify first point of mirror line:';
    if (stage === 'SECOND') return 'MIRROR — Specify second point of mirror line:';
    return 'MIRROR — Erase source objects? [Yes/No] <No>:';
  },

  point(p) {
    const operation = state.transform;
    if (!operation) return;
    if (operation.stage === 'BASE') {
      operation.base = { ...p };
      operation.stage = 'SECOND';
      updatePrompt();
      return;
    }
    if (operation.stage !== 'SECOND') return;
    if (dist(operation.base, p) < 1e-9) {
      updatePrompt('The mirror line needs two distinct points.');
      return;
    }
    operation.second = { ...p };
    operation.stage = 'CONFIRM';
    updatePrompt();
  },

  keyword(text) {
    const operation = state.transform;
    if (operation?.stage !== 'CONFIRM') return false;
    const answer = text.trim().toUpperCase();
    if (YES_KEYWORDS.includes(answer)) {
      applyMirror(true);
      return true;
    }
    if (NO_KEYWORDS.includes(answer)) {
      applyMirror(false);
      return true;
    }
    return false;
  },

  previewReady() {
    return ['SECOND', 'CONFIRM'].includes(state.transform?.stage);
  },

  preview(p) {
    const operation = state.transform;
    // Once the axis is fixed the cursor no longer defines it, so the committed
    // second point drives the preview and the answer stage keeps showing the
    // result the user is about to accept.
    const axisEnd = operation.stage === 'CONFIRM' ? operation.second : p;
    if (dist(operation.base, axisEnd) < 1e-9) return;
    const ids = new Set(operation.ids);
    for (const entity of state.entities) {
      if (ids.has(entity.id) && isEntityEditable(entity)) {
        drawEntity(mirrorEntity(entity, operation.base, axisEnd), true);
      }
    }
    drawTransformGuide(
      operation.base,
      axisEnd,
      `Mirror @ ${formatAngle(Math.atan2(axisEnd.y - operation.base.y, axisEnd.x - operation.base.x))}`,
      true,
    );
  },

  // Enter answers whichever question is open: the selection first, then the
  // bracketed <No> default for erasing the source.
  finish() {
    if (state.transform?.stage === 'CONFIRM') {
      applyMirror(false);
      return true;
    }
    return acceptTransformSelection();
  },
});

export function editableSelectionIds() {
  return state.entities
    .filter(entity => state.selected.has(entity.id) && isEntityEditable(entity))
    .map(entity => entity.id);
}

export function acceptTransformSelection() {
  if (!state.transform || state.transform.stage !== 'SELECT') return false;
  const ids = editableSelectionIds();
  if (!ids.length) {
    updatePrompt('No objects selected.');
    return true;
  }
  state.transform.ids = ids;
  state.transform.stage = 'BASE';
  updatePrompt();
  draw();
  return true;
}

export function applyTransform(destination) {
  const operation = state.transform;
  if (!operation?.base || operation.stage !== 'DEST') return;
  const dx = destination.x - operation.base.x;
  const dy = destination.y - operation.base.y;
  if (Math.hypot(dx, dy) < 1e-9) {
    updatePrompt('Destination must differ from the base point.');
    return;
  }

  const idSet = new Set(state.entities
    .filter(entity => operation.ids.includes(entity.id) && isEntityEditable(entity))
    .map(entity => entity.id));
  if (!idSet.size) {
    updatePrompt('The selected objects are no longer editable.');
    return;
  }
  if (operation.type === 'MOVE') {
    const entities = state.entities.map(entity =>
      idSet.has(entity.id) ? translateEntity(entity, dx, dy) : entity,
    );
    if (!commitGeometry(entities)) return;
    state.selected = new Set(idSet);
  } else {
    const moved = state.entities
      .filter(entity => idSet.has(entity.id))
      .map(entity => translateEntity(entity, dx, dy));
    const { entities: copies, nextId } = duplicateEntities(moved, state.nextId);
    if (!commitGeometry([...state.entities, ...copies], { nextId })) return;
    state.selected = new Set(copies.map(entity => entity.id));
  }
  setMode('SELECT');
}

export function applyRotation(angle) {
  const operation = state.transform;
  if (!operation?.base || !['ANGLE', 'ROTATE_TARGET'].includes(operation.stage) || operation.type !== 'ROTATE') return;
  if (!Number.isFinite(angle)) {
    updatePrompt('Rotation angle must be a finite number.');
    return;
  }
  const reducedAngle = Math.atan2(Math.sin(angle), Math.cos(angle));
  if (Math.abs(reducedAngle) < 1e-10) {
    updatePrompt('Rotation angle must differ from zero.');
    return;
  }

  const idSet = new Set(state.entities
    .filter(entity => operation.ids.includes(entity.id) && isEntityEditable(entity))
    .map(entity => entity.id));
  if (!idSet.size) {
    updatePrompt('The selected objects are no longer editable.');
    return;
  }
  const entities = state.entities.map(entity =>
    idSet.has(entity.id) ? rotateEntity(entity, operation.base, reducedAngle) : entity,
  );
  if (!commitGeometry(entities)) return;
  state.selected = new Set(idSet);
  setMode('SELECT');
}

export function applyScale(factor) {
  const operation = state.transform;
  if (!operation?.base || !['FACTOR', 'SCALE_REF_NEW'].includes(operation.stage) || operation.type !== 'SCALE') return;
  if (!Number.isFinite(factor) || factor <= 1e-9) {
    updatePrompt('Scale factor must be greater than zero.');
    return;
  }
  if (Math.abs(factor - 1) < 1e-10) {
    updatePrompt('Scale factor must differ from 1.');
    return;
  }

  const idSet = new Set(state.entities
    .filter(entity => operation.ids.includes(entity.id) && isEntityEditable(entity))
    .map(entity => entity.id));
  if (!idSet.size) {
    updatePrompt('The selected objects are no longer editable.');
    return;
  }

  const scaled = new Map();
  for (const entity of state.entities) {
    if (!idSet.has(entity.id)) continue;
    const result = scaleEntity(entity, operation.base, factor);
    const box = entityBBox(result);
    if (!box || Object.values(box).some(value => !Number.isFinite(value))) {
      updatePrompt('That scale factor would create invalid geometry.');
      return;
    }
    scaled.set(entity.id, result);
  }

  if (!commitGeometry(state.entities.map(entity => scaled.get(entity.id) || entity))) return;
  state.selected = new Set(idSet);
  setMode('SELECT');
}

export function applyMirror(eraseSource) {
  const operation = state.transform;
  if (!operation?.base || operation.stage !== 'CONFIRM' || operation.type !== 'MIRROR') return;
  if (!operation.second || dist(operation.base, operation.second) < 1e-9) {
    updatePrompt('The mirror line needs two distinct points.');
    return;
  }

  const idSet = new Set(state.entities
    .filter(entity => operation.ids.includes(entity.id) && isEntityEditable(entity))
    .map(entity => entity.id));
  if (!idSet.size) {
    updatePrompt('The selected objects are no longer editable.');
    return;
  }

  if (eraseSource) {
    const entities = state.entities.map(entity =>
      idSet.has(entity.id) ? mirrorEntity(entity, operation.base, operation.second) : entity,
    );
    if (!commitGeometry(entities)) return;
    state.selected = new Set(idSet);
  } else {
    // The reflected entities keep their original ids on the way into
    // duplicateEntities, which is what lets a mirrored dimension be remapped
    // onto the mirrored copy of the geometry it measures rather than left
    // pointing at the original.
    const reflected = state.entities
      .filter(entity => idSet.has(entity.id))
      .map(entity => mirrorEntity(entity, operation.base, operation.second));
    const { entities: copies, nextId } = duplicateEntities(reflected, state.nextId);
    if (!commitGeometry([...state.entities, ...copies], { nextId })) return;
    state.selected = new Set(copies.map(entity => entity.id));
  }
  setMode('SELECT');
}
