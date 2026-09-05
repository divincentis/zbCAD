import { COMMAND_COMPLETE, defineCommand, setMode } from './registry.js';
import { editableSelectionIds } from './transform.js';
import { formatAngle, formatLengthLabel } from '../core/units.js';
import { finishEdgeEdit } from '../geometry/edgeEdit.js';
import { extendAt } from '../geometry/extend.js';
import { applyCorner, chamferCorner, cornerPick, filletCorner } from '../geometry/fillet.js';
import { applyGripEdit, gripEditedEntity } from '../geometry/grips.js';
import { explodeNote, explodeSelection, joinNote, joinSelection } from '../geometry/joinExplode.js';
import { acceptOffsetSource, applyOffset, isOffsettable, offsetEntity, setOffsetDistance } from '../geometry/offset.js';
import { applyStretch, pointInStretchWindow, stretchIsDegenerate, stretchedEntity } from '../geometry/stretch.js';
import { trimAt } from '../geometry/trim.js';
import { eraseNote, eraseSelection } from '../interaction/selection.js';
import { isEntityEditable } from '../model/layerQuery.js';
import { state } from '../state.js';
import { notePrompt, updatePrompt } from '../ui/prompt.js';
import { draw } from '../view/frame.js';
import { drawEntity, drawExtendPreview, drawTransformGuide, drawTrimPreview } from '../view/render.js';

defineCommand('OFFSET', {
  // Exactly one offsettable object already selected answers "which object",
  // so the command skips straight from the distance to the side. Anything
  // else is an unrelated selection and is cleared rather than guessed at.
  begin() {
    const preselected = state.entities.filter(entity =>
      state.selected.has(entity.id) && isEntityEditable(entity) && isOffsettable(entity),
    );
    const source = preselected.length === 1 && state.selected.size === 1 ? preselected[0] : null;
    if (!source) state.selected.clear();
    state.offset = {
      stage: 'DISTANCE',
      distance: null,
      sourceId: source?.id || null,
    };
  },

  prompt() {
    const stage = state.offset?.stage || 'DISTANCE';
    if (stage === 'DISTANCE') return 'OFFSET — Specify offset distance:';
    if (stage === 'SOURCE') return 'OFFSET — Select one line, polyline, circle, or arc:';
    return `OFFSET — Specify side (${formatLengthLabel(state.offset.distance)} offset):`;
  },

  selectsObjects() {
    return state.offset?.stage === 'SOURCE';
  },

  // A single pick is the whole answer, so there is nothing to confirm with
  // Enter afterwards.
  commitsOnPick: true,

  distance(value) {
    return setOffsetDistance(value);
  },

  // The side is a direction, not a location: snapping it to nearby geometry
  // would fight the only thing the pick is for.
  usesSnap() {
    return state.offset?.stage !== 'SIDE';
  },

  // Only the side stage takes a point, and it is taken from the raw cursor
  // rather than typed, so no typed point is accepted at any stage.
  acceptsPoint() {
    return false;
  },

  point(p) {
    if (state.offset?.stage === 'SIDE') applyOffset(p);
  },

  previewReady() {
    return state.offset?.stage === 'SIDE';
  },

  preview(p) {
    const source = state.entities.find(entity =>
      entity.id === state.offset.sourceId && isEntityEditable(entity));
    const preview = source && offsetEntity(source, state.offset.distance, p);
    if (preview) drawEntity(preview, true);
  },

  finish() {
    return acceptOffsetSource();
  },
});

// TRIM and EXTEND share every stage: they take optional boundaries from the
// selection, then repeat one click until dismissed. Only the operation each
// click performs differs.
export function edgeEditCommand(type) {
  const verb = type === 'TRIM' ? 'portions' : 'ends';
  return {
    begin() {
      // An empty selection means "use everything else as a boundary", which
      // is a different instruction from an empty list of boundaries.
      state.edit = {
        type,
        boundaryIds: state.selected.size
          ? editableSelectionIds()
          : null,
      };
      state.selected.clear();
    },

    prompt() {
      const boundaryCount = state.edit?.boundaryIds?.length || 0;
      const boundaries = boundaryCount
        ? `${boundaryCount} preselected ${boundaryCount === 1 ? 'boundary' : 'boundaries'}`
        : 'all other geometry as boundaries';
      return `${type} — Click ${verb} to ${type.toLowerCase()}; ${boundaries}; Enter/right-click/Esc to finish:`;
    },

    // The click selects which piece of which object is meant, so it is taken
    // from the raw cursor: a snap would pull it onto an endpoint and change
    // which side of a boundary it names.
    usesSnap: false,

    acceptsPoint() {
      return false;
    },

    point(p) {
      if (type === 'TRIM') trimAt(p);
      else extendAt(p);
    },

    previewReady() {
      return true;
    },

    preview(p) {
      if (type === 'TRIM') drawTrimPreview(p);
      else drawExtendPreview(p);
    },

    finish() {
      finishEdgeEdit();
      return true;
    },
  };
}

defineCommand('TRIM', edgeEditCommand('TRIM'));
defineCommand('EXTEND', edgeEditCommand('EXTEND'));

// GRIP is the one command with no name to type: it is entered by pressing a
// grip on a selected object, and startGripEdit() supplies the runtime state
// immediately after setMode. Everything before that state exists reports as
// not ready, which is what the single frame between the two allows for.
defineCommand('GRIP', {
  usesOrtho: true,

  takesDistance() {
    return Boolean(state.grip);
  },

  basePoint() {
    return state.grip?.base || null;
  },

  // Snapping the destination onto the entity being edited would let a grip
  // land on the geometry it is moving.
  snapExcludes() {
    return state.grip?.entityId ?? null;
  },

  prompt() {
    return 'GRIP — Specify destination point or distance:';
  },

  acceptsPoint() {
    return Boolean(state.grip);
  },

  point(p) {
    applyGripEdit(p);
  },

  previewReady() {
    return Boolean(state.grip);
  },

  preview(p) {
    const source = state.entities.find(entity =>
      entity.id === state.grip.entityId && isEntityEditable(entity));
    const preview = source && gripEditedEntity(source, state.grip.descriptor, p);
    if (preview?.entity) drawEntity(preview.entity, true);
    drawTransformGuide(state.grip.base, p, 'Grip');
  },

  finish() {
    setMode('SELECT');
    return true;
  },
});

// FILLET and CHAMFER keep their settings between invocations, the way every
// CAD does: a plan is cleaned up one corner at a time at a radius chosen once.
export const cornerSettings = { radius: 0, firstDistance: 0, secondDistance: 0 };

export const RADIUS_KEYWORDS = ['R', 'RAD', 'RADIUS'];
export const DISTANCE_KEYWORDS = ['D', 'DIST', 'DISTANCE'];

// FILLET and CHAMFER differ only in what replaces the corner and which
// settings they ask for, so they share every stage: optional settings, a first
// line, a second line, then straight back to the first line for the next
// corner.
export function cornerCommand(type) {
  const valueStages = type === 'FILLET' ? ['RADIUS'] : ['DISTANCE1', 'DISTANCE2'];

  return {
    begin() {
      // The picks name which line and which side, never a place, so an
      // unrelated selection would only be visual noise through the command.
      state.selected.clear();
      state.edit = { type, stage: 'FIRST', firstId: null, firstPoint: null, ...cornerSettings };
    },

    // Both picks say which edge and which side of the corner is meant. A snap
    // would pull them onto an endpoint and change the answer to both.
    usesSnap: false,

    acceptsPoint() {
      return false;
    },

    takesDistance() {
      return valueStages.includes(state.edit?.stage);
    },

    prompt() {
      const operation = state.edit;
      const stage = operation?.stage || 'FIRST';
      if (stage === 'RADIUS') return `FILLET — Specify fillet radius <${formatLengthLabel(operation.radius)}>:`;
      if (stage === 'DISTANCE1') return `CHAMFER — Specify first chamfer distance <${formatLengthLabel(operation.firstDistance)}>:`;
      if (stage === 'DISTANCE2') return `CHAMFER — Specify second chamfer distance <${formatLengthLabel(operation.secondDistance)}>:`;
      if (stage === 'SECOND') return `${type} — Select the second line:`;
      const setting = type === 'FILLET'
        ? `radius ${formatLengthLabel(operation?.radius ?? 0)}`
        : `${formatLengthLabel(operation?.firstDistance ?? 0)} × ${formatLengthLabel(operation?.secondDistance ?? 0)}`;
      const option = type === 'FILLET' ? 'Radius' : 'Distance';
      return `${type} — Select the first line or [${option}] (${setting}); Enter/right-click/Esc to finish:`;
    },

    keyword(text) {
      const operation = state.edit;
      if (operation?.stage !== 'FIRST') return false;
      const answer = text.trim().toUpperCase();
      if (type === 'FILLET' && RADIUS_KEYWORDS.includes(answer)) {
        operation.stage = 'RADIUS';
      } else if (type === 'CHAMFER' && DISTANCE_KEYWORDS.includes(answer)) {
        operation.stage = 'DISTANCE1';
      } else {
        return false;
      }
      updatePrompt();
      draw();
      return true;
    },

    distance(value) {
      const operation = state.edit;
      if (!valueStages.includes(operation?.stage)) return false;
      // A zero radius or distance is the ordinary "just close this corner"
      // instruction, so only a negative one is refused.
      if (value < 0) {
        updatePrompt('That value cannot be negative.');
        return true;
      }
      if (operation.stage === 'RADIUS') {
        operation.radius = value;
        cornerSettings.radius = value;
        operation.stage = 'FIRST';
      } else if (operation.stage === 'DISTANCE1') {
        operation.firstDistance = value;
        cornerSettings.firstDistance = value;
        // The second distance follows the first unless it is changed, which is
        // what makes an equal-sided chamfer a single answer.
        operation.secondDistance = value;
        cornerSettings.secondDistance = value;
        operation.stage = 'DISTANCE2';
      } else {
        operation.secondDistance = value;
        cornerSettings.secondDistance = value;
        operation.stage = 'FIRST';
      }
      updatePrompt();
      draw();
      return true;
    },

    point(p) {
      const operation = state.edit;
      if (operation?.stage === 'FIRST') {
        const picked = cornerPick(p);
        if (picked.error) {
          updatePrompt(picked.error);
          draw();
          return;
        }
        operation.firstId = picked.entity.id;
        operation.firstPoint = { ...picked.point };
        operation.stage = 'SECOND';
        updatePrompt();
        draw();
        return;
      }
      if (operation?.stage === 'SECOND') applyCorner(p);
    },

    previewReady() {
      return state.edit?.stage === 'SECOND';
    },

    preview(p) {
      const operation = state.edit;
      const first = state.entities.find(entity => entity.id === operation.firstId);
      const picked = cornerPick(p);
      if (!first || picked.error || picked.entity.id === first.id) return;
      const result = operation.type === 'FILLET'
        ? filletCorner(first, picked.entity, operation.firstPoint, picked.point, operation.radius)
        : chamferCorner(
          first, picked.entity, operation.firstPoint, picked.point,
          operation.firstDistance, operation.secondDistance,
        );
      if (result.error) return;
      for (const edge of result.edges) drawEntity(edge, true);
      const addition = result.arc || result.cut;
      if (addition) drawEntity(addition, true);
    },

    // One rule for Enter at every stage: the command is done. Abandoning a
    // half-picked corner and leaving the command are the same instruction as
    // far as the user is concerned, and Esc already cancels.
    finish() {
      setMode('SELECT');
      return true;
    },
  };
}

defineCommand('FILLET', cornerCommand('FILLET'));
defineCommand('CHAMFER', cornerCommand('CHAMFER'));

export function selectionEditCommand(type, label, apply, note) {
  return {
    additiveSelection: true,

    begin() {
      state.edit = { type, stage: 'SELECT' };
      if (!state.selected.size) return undefined;
      // A preselection is the whole instruction, so there is nothing left to
      // ask for. On a refusal the command stays open with the objects still
      // selected, which lets the reason be acted on rather than just read.
      const result = apply();
      notePrompt(result.error || note(result));
      return result.error ? undefined : COMMAND_COMPLETE;
    },

    selectsObjects() {
      return state.edit?.stage === 'SELECT';
    },

    // No acceptsPoint override is needed: neither command has a point hook,
    // which is already what "takes no typed point" means.

    prompt() {
      const count = state.selected.size;
      return count
        ? `${type} — ${count} selected; press Enter or right-click to ${label}:`
        : `${type} — Select objects to ${label}, then press Enter or right-click:`;
    },

    finish() {
      const result = apply();
      if (result.error) {
        updatePrompt(result.error);
        return true;
      }
      setMode('SELECT');
      notePrompt(note(result));
      updatePrompt();
      return true;
    },
  };
}

defineCommand('JOIN', selectionEditCommand('JOIN', 'join', joinSelection, joinNote));
defineCommand('EXPLODE', selectionEditCommand('EXPLODE', 'explode', explodeSelection, explodeNote));
// ERASE reads a selection and nothing else, which is the shape JOIN and
// EXPLODE already have: act on a preselection at once, otherwise gather one
// and act on Enter. The Delete key stays as the shortcut for the same thing.
defineCommand('ERASE', selectionEditCommand('ERASE', 'erase', eraseSelection, eraseNote));
defineCommand('STRETCH', {
  additiveSelection: true,

  begin() {
    // A preselection carries no record of how it was made, and without the
    // windows there is nothing to say which vertices were meant. The command
    // asks for its own.
    state.selected.clear();
    state.edit = {
      type: 'STRETCH',
      stage: 'SELECT',
      ids: [],
      windows: [],
      pickedIds: [],
      base: null,
    };
  },

  selectsObjects() {
    return state.edit?.stage === 'SELECT';
  },

  // Recorded as the selection is gathered, because which vertices move
  // depends on how each object was caught, not merely on which were.
  noteSelection(detail) {
    if (state.edit?.stage !== 'SELECT') return;
    if (detail.box) state.edit.windows.push({ ...detail.box });
    if (detail.entityId !== undefined && !state.edit.pickedIds.includes(detail.entityId)) {
      state.edit.pickedIds.push(detail.entityId);
    }
  },

  usesOrtho() {
    return state.edit?.stage === 'DEST';
  },

  takesDistance() {
    return state.edit?.stage === 'DEST';
  },

  basePoint() {
    return state.edit?.stage === 'DEST' ? state.edit.base : null;
  },

  acceptsPoint() {
    return ['BASE', 'DEST'].includes(state.edit?.stage);
  },

  prompt() {
    const stage = state.edit?.stage || 'SELECT';
    if (stage === 'SELECT') {
      const count = state.selected.size;
      return count
        ? `STRETCH — ${count} selected; press Enter or right-click to continue:`
        : 'STRETCH — Select with a crossing window, then press Enter or right-click:';
    }
    if (stage === 'BASE') return 'STRETCH — Specify base point:';
    return 'STRETCH — Specify destination, distance, or relative point:';
  },

  point(p) {
    if (state.edit?.stage === 'BASE') {
      state.edit.base = { ...p };
      state.edit.stage = 'DEST';
      updatePrompt();
    } else if (state.edit?.stage === 'DEST') {
      applyStretch(p);
    }
  },

  previewReady() {
    return state.edit?.stage === 'DEST';
  },

  preview(p) {
    const operation = state.edit;
    const dx = p.x - operation.base.x;
    const dy = p.y - operation.base.y;
    const ids = new Set(operation.ids);
    for (const entity of state.entities) {
      if (!ids.has(entity.id) || !isEntityEditable(entity)) continue;
      const whole = operation.pickedIds.includes(entity.id);
      const result = stretchedEntity(
        entity, dx, dy,
        point => whole || pointInStretchWindow(point, operation.windows),
      );
      if (!stretchIsDegenerate(result)) drawEntity(result, true);
    }
    drawTransformGuide(
      operation.base,
      p,
      `${formatLengthLabel(Math.hypot(dx, dy))} @ ${formatAngle(Math.atan2(dy, dx))}`,
    );
  },

  finish() {
    if (state.edit?.stage !== 'SELECT') return false;
    const ids = editableSelectionIds();
    if (!ids.length) {
      updatePrompt('No objects selected.');
      return true;
    }
    state.edit.ids = ids;
    state.edit.stage = 'BASE';
    updatePrompt();
    draw();
    return true;
  },
});
