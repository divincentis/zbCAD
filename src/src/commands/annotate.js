import { defineCommand, setMode } from './registry.js';
import { DEGREES } from './transform.js';
import { DEFAULT_DIM_STYLE_ID } from '../core/defaults.js';
import { TAU } from '../core/constants.js';
import { dimSize, getDimStyle } from '../core/dimstyle.js';
import { angleFromCenter, angleOnArc, circularPoint, dist, normalizeAngle } from '../core/math.js';
import { hitTestSegment } from '../geometry/edgeEdit.js';
import { formatLength } from '../core/units.js';
import { buildDimension, dimensionGeometry, resolveEntityReference } from '../model/dimension.js';
import { commitGeometry } from '../model/history.js';
import { currentLayerIsEditable } from '../model/layerQuery.js';
import { state } from '../state.js';
import { draw } from '../view/frame.js';
import { updatePrompt } from '../ui/prompt.js';
import { drawEntity } from '../view/render.js';

export function dimensionCommand(dimType, label) {
  return {
    // Both public commands share the existing DIM runtime state without
    // sacrificing their canonical identity for prompts and command repeat.
    stateMode: 'DIM',

    // A dimension is new geometry, so it behaves like the other creation
    // commands: an existing selection is unrelated and is cleared on entry
    // rather than left highlighted through the command.
    creates: true,

    canBegin() {
      if (currentLayerIsEditable()) return true;
      updatePrompt('The current layer is locked or hidden.');
      return false;
    },

    usesOrtho() {
      // The measured points benefit from ORTHO; the dimension-line location
      // is a free offset and must not be constrained.
      return state.currentPoints.length < 2;
    },

    begin() {
      state.dimension = { dimType, refs: [null, null] };
    },

    prompt() {
      if (!state.currentPoints.length) {
        return `${label} — Specify first extension line origin:`;
      }
      return state.currentPoints.length === 1
        ? `${label} — Specify second extension line origin:`
        : `${label} — Specify dimension line location:`;
    },

    point(p) {
      if (state.currentPoints.length < 2) {
        state.dimension.refs[state.currentPoints.length] = resolveEntityReference(p);
        state.currentPoints.push({ ...p });
        updatePrompt();
      } else if (addDimension(
        dimType,
        state.currentPoints[0], state.currentPoints[1], p,
        state.dimension.refs,
      )) {
        setMode('SELECT');
      }
    },

    preview(p) {
      if (state.currentPoints.length === 1) {
        drawEntity({ type: 'LINE', a: state.currentPoints[0], b: p }, true);
        return;
      }
      const preview = buildDimension(
        dimType, state.currentPoints[0], state.currentPoints[1], p, [null, null],
      );
      if (dimensionGeometry(preview).measure > 1e-9) drawEntity(preview, true);
    },
  };
}

defineCommand('DIMLINEAR', dimensionCommand('LINEAR', 'DIMLINEAR'));
defineCommand('DIMALIGNED', dimensionCommand('ALIGNED', 'DIMALIGNED'));

// Every transform opens the same way — take a selection, then a base point —
// and they all keep their staged runtime state in state.transform. Only what
// follows the base point differs, so the shared opening lives here.
export function addDimension(dimType, p1, p2, linePoint, refs) {
  if (!currentLayerIsEditable()) return false;
  if (dist(p1, p2) <= 1e-9) {
    updatePrompt('A dimension needs two distinct points.');
    return false;
  }
  const entity = buildDimension(dimType, p1, p2, linePoint, refs);
  const geometry = dimensionGeometry(entity);
  if (geometry.measure <= 1e-9) {
    updatePrompt('Dimension line location is read as horizontal or vertical, whichever the pick is offset toward — this pick measures neither. Try a point offset more clearly to one side.');
    return false;
  }
  entity.id = state.nextId;
  return commitGeometry([...state.entities, entity], { nextId: state.nextId + 1 });
}

// ---------------------------------------------------------------------------
// Radial dimensions
//
// RADIUS and DIAMETER measure one circular entity rather than the distance
// between two features, but they still fit the two-point definition every
// other dimension uses: the dimension line is laid along a radius, so p1/p2
// are simply the two ends of what is being measured — centre-to-edge for a
// radius, edge-to-edge for a diameter. Because both points then sit on the
// line through linePoint, the shared geometry produces no extension lines,
// which is exactly right for a radial dimension.
//
// Both points land on features resolveEntityReference already tracks (the
// centre, and an arbitrary angle on the curve), so radial dimensions are
// associative through the existing machinery with nothing added.
//
// DIAMETER is offered on circles only. On an arc the opposite end of the
// diameter is not on the arc, so its reference would not resolve and the
// dimension would distort the moment the arc moved — a silently wrong result
// is worse than saying DIMRADIUS is the command for an arc.
// ---------------------------------------------------------------------------

export function radialTarget(world, dimType) {
  const hit = hitTestSegment(world, 10, null, true);
  if (!hit) return { error: 'No circle or arc there. Click one.' };
  const entity = hit.entity;
  if (entity.type !== 'CIRCLE' && entity.type !== 'ARC') {
    return { error: `That is a ${entity.type}. Select a circle or arc.` };
  }
  if (dimType === 'DIAMETER' && entity.type === 'ARC') {
    return { error: 'DIMDIAMETER measures a circle. Use DIMRADIUS on an arc.' };
  }
  return { entity };
}

// The cursor picks both which way the leader runs and how far the text sits
// along it, the way AutoCAD's radial dimensions behave.
export function radialDimensionEntity(dimType, targetId, cursor) {
  const target = state.entities.find(entity => entity.id === targetId);
  if (!target || (target.type !== 'CIRCLE' && target.type !== 'ARC')) return null;
  if (target.radius <= 1e-9) return null;

  let angle = angleFromCenter(target.center, cursor);
  // On an arc the leader has to land on the arc itself rather than on the
  // empty part of the circle it belongs to.
  if (target.type === 'ARC' && !angleOnArc(angle, target)) {
    const sweep = target.endAngle - target.startAngle;
    const past = normalizeAngle(angle - target.startAngle);
    angle = past - sweep < TAU - past ? target.endAngle : target.startAngle;
  }
  const edge = circularPoint(target.center, target.radius, angle);
  const p1 = dimType === 'RADIUS'
    ? { ...target.center }
    : circularPoint(target.center, target.radius, angle + Math.PI);
  const refs = [resolveEntityReference(p1), resolveEntityReference(edge)];

  // linePoint sits on the measured line itself, so the shared geometry
  // projects p1/p2 onto themselves and draws the dimension line straight
  // along the radius.
  const entity = buildDimension(dimType, p1, edge, p1, refs);
  const mid = { x: (p1.x + edge.x) / 2, y: (p1.y + edge.y) / 2 };
  // The text follows the cursor, which is the only thing left for the second
  // pick to say once the angle is taken from it.
  entity.textOffset = { x: cursor.x - mid.x, y: cursor.y - mid.y };
  return entity;
}

export function addRadialDimension(dimType, targetId, cursor) {
  if (!currentLayerIsEditable()) return false;
  const entity = radialDimensionEntity(dimType, targetId, cursor);
  if (!entity) {
    updatePrompt('That circle is no longer in the drawing.');
    return false;
  }
  if (dimensionGeometry(entity).measure <= 1e-9) {
    updatePrompt('That circle is too small to dimension.');
    return false;
  }
  entity.id = state.nextId;
  return commitGeometry([...state.entities, entity], { nextId: state.nextId + 1 });
}

export function radialDimensionCommand(dimType, label) {
  return {
    stateMode: 'DIM',
    creates: true,

    canBegin() {
      if (currentLayerIsEditable()) return true;
      updatePrompt('The current layer is locked or hidden.');
      return false;
    },

    begin() {
      state.dimension = { dimType, refs: [null, null], targetId: null };
    },

    // The first pick names which circle and the second names a direction
    // around it. Neither is a place in the drawing, so a snap would only
    // fight both.
    usesSnap: false,

    acceptsPoint() {
      return false;
    },

    prompt() {
      return state.dimension?.targetId
        ? `${label} — Specify the dimension line location:`
        : `${label} — Select a ${dimType === 'DIAMETER' ? 'circle' : 'circle or arc'}:`;
    },

    point(p) {
      const operation = state.dimension;
      if (!operation) return;
      if (!operation.targetId) {
        const picked = radialTarget(p, dimType);
        if (picked.error) {
          updatePrompt(picked.error);
          draw();
          return;
        }
        operation.targetId = picked.entity.id;
        updatePrompt();
        draw();
        return;
      }
      if (addRadialDimension(dimType, operation.targetId, p)) setMode('SELECT');
    },

    previewReady() {
      return Boolean(state.dimension?.targetId);
    },

    preview(p) {
      const entity = radialDimensionEntity(state.dimension.dimType, state.dimension.targetId, p);
      if (entity && dimensionGeometry(entity).measure > 1e-9) drawEntity(entity, true);
    },
  };
}

defineCommand('DIMRADIUS', radialDimensionCommand('RADIUS', 'DIMRADIUS'));
defineCommand('DIMDIAMETER', radialDimensionCommand('DIAMETER', 'DIMDIAMETER'));

// ---------------------------------------------------------------------------
// TEXT
//
// Follows the AutoCAD single-line TEXT flow: insertion point, height,
// rotation, then the content itself. The first three are point/distance/angle
// entry like every other command; content is not, so it goes through value()
// instead of point() — acceptsPoint() shuts point/coordinate parsing off once
// content is being typed, so a string that happens to contain a comma or
// start with '@' is never mistaken for a coordinate.
// ---------------------------------------------------------------------------

export function addText(position, height, rotation, content) {
  if (!currentLayerIsEditable()) return false;
  const entity = {
    id: state.nextId,
    type: 'TEXT',
    layerId: state.currentLayerId,
    position: { ...position },
    height,
    rotation,
    content,
  };
  return commitGeometry([...state.entities, entity], { nextId: state.nextId + 1 });
}

// A style's textHeight is already the "what does normal annotation text look
// like in this drawing" answer — dimension text uses exactly this number —
// so plain TEXT defaults to it too rather than inventing a second default.
export function defaultTextHeight() {
  return dimSize(getDimStyle(DEFAULT_DIM_STYLE_ID), 'textHeight');
}

defineCommand('TEXT', {
  creates: true,
  usesOrtho: true,

  takesDistance() {
    return state.text?.stage === 'HEIGHT';
  },

  // A space typed while entering content is a word break, not Enter.
  capturesSpace() {
    return state.text?.stage === 'CONTENT';
  },

  begin() {
    state.text = { stage: 'POINT', position: null, height: null, rotation: null };
  },

  prompt() {
    const stage = state.text?.stage;
    if (stage === 'HEIGHT') return `TEXT — Specify height <${formatLength(defaultTextHeight())}>:`;
    if (stage === 'ROTATION') return 'TEXT — Specify rotation angle <0>:';
    if (stage === 'CONTENT') return 'TEXT — Enter the text:';
    return 'TEXT — Specify start point:';
  },

  acceptsPoint() {
    return ['POINT', 'HEIGHT'].includes(state.text?.stage);
  },

  previewReady() {
    const stage = state.text?.stage;
    // Nothing has been typed yet the moment CONTENT begins, so there is
    // nothing to preview until liveValue() reports a first keystroke.
    if (stage === 'CONTENT') return Boolean(state.text.liveContent);
    return ['HEIGHT', 'ROTATION'].includes(stage);
  },

  point(p) {
    const operation = state.text;
    if (operation.stage === 'POINT') {
      operation.position = { ...p };
      operation.stage = 'HEIGHT';
      updatePrompt();
      return;
    }
    if (operation.stage === 'HEIGHT') {
      const height = dist(operation.position, p);
      if (height <= 1e-9) { updatePrompt('Height must be greater than zero.'); return; }
      operation.height = height;
      operation.stage = 'ROTATION';
      updatePrompt();
    }
  },

  distance(value) {
    const operation = state.text;
    if (operation?.stage !== 'HEIGHT') return false;
    if (value <= 1e-9) { updatePrompt('Height must be greater than zero.'); return true; }
    operation.height = value;
    operation.stage = 'ROTATION';
    updatePrompt();
    draw();
    return true;
  },

  value(text) {
    const operation = state.text;
    if (operation?.stage === 'ROTATION') {
      const match = text.trim().match(DEGREES);
      if (!match) { updatePrompt('Invalid angle. Enter degrees.'); return true; }
      operation.rotation = Number(match[1]) * Math.PI / 180;
      operation.stage = 'CONTENT';
      updatePrompt();
      draw();
      return true;
    }
    if (operation?.stage === 'CONTENT') {
      if (!text) { updatePrompt('Enter the text to place:'); return true; }
      if (addText(operation.position, operation.height, operation.rotation, text)) setMode('SELECT');
      return true;
    }
    return false;
  },

  // Fires on every keystroke, ahead of Enter — see liveValue() in the
  // registry's hook contract. Kept separate from value() so the committed
  // text always comes from the same trimmed, Enter-terminated string it
  // always has, while the canvas gets to see it as it's typed.
  liveValue(text) {
    const operation = state.text;
    if (operation?.stage !== 'CONTENT') return;
    operation.liveContent = text;
    draw();
  },

  // Enter/Space with nothing typed accepts the bracketed default for the
  // current stage, matching AutoCAD's <default> convention.
  finish() {
    const operation = state.text;
    if (!operation || operation.stage === 'POINT') return false;
    if (operation.stage === 'HEIGHT') {
      operation.height = defaultTextHeight();
      operation.stage = 'ROTATION';
      updatePrompt();
      draw();
      return;
    }
    if (operation.stage === 'ROTATION') {
      operation.rotation = 0;
      operation.stage = 'CONTENT';
      updatePrompt();
      draw();
      return;
    }
    // CONTENT: nothing typed yet, nothing to place.
    updatePrompt('Enter the text to place:');
    return false;
  },

  preview(p) {
    const operation = state.text;
    if (operation.stage === 'HEIGHT') {
      drawEntity({ type: 'LINE', a: operation.position, b: p }, true);
      return;
    }
    if (operation.stage === 'ROTATION') {
      drawEntity({
        type: 'TEXT',
        position: operation.position,
        height: operation.height,
        rotation: Math.atan2(p.y - operation.position.y, p.x - operation.position.x),
        content: '(text)',
      }, true);
      return;
    }
    if (operation.stage === 'CONTENT' && operation.liveContent) {
      drawEntity({
        type: 'TEXT',
        position: operation.position,
        height: operation.height,
        rotation: operation.rotation,
        content: operation.liveContent,
      }, true);
    }
  },
});

// ---------------------------------------------------------------------------
// MTEXT
//
// TEXT with a fixed box width instead of one derived from content, and more
// than one line. Follows the same point/distance/angle-then-free-text shape
// as TEXT, with an extra WIDTH stage ahead of HEIGHT: first corner, opposite
// corner (sets the wrap width), height, rotation, then content — except
// content itself is multi-line, so each Enter commits one line and stays in
// CONTENT rather than finishing; finish() (a blank Enter) is what ends entry,
// the way AutoCAD's command-line MTEXT works.
// ---------------------------------------------------------------------------

export function addMText(position, width, height, rotation, content) {
  if (!currentLayerIsEditable()) return false;
  const entity = {
    id: state.nextId,
    type: 'MTEXT',
    layerId: state.currentLayerId,
    position: { ...position },
    width,
    height,
    rotation,
    content,
  };
  return commitGeometry([...state.entities, entity], { nextId: state.nextId + 1 });
}

// A generous default so Enter-for-default at the WIDTH stage still produces
// something a few words wide, mirroring TEXT's <default> convention even
// though AutoCAD's own MTEXT has no true default (it always asks for the
// opposite corner).
export function defaultMTextWidth() {
  return defaultTextHeight() * 20;
}

defineCommand('MTEXT', {
  creates: true,
  usesOrtho: true,

  takesDistance() {
    return ['WIDTH', 'HEIGHT'].includes(state.mtext?.stage);
  },

  capturesSpace() {
    return state.mtext?.stage === 'CONTENT';
  },

  begin() {
    state.mtext = {
      stage: 'POINT', position: null, width: null, height: null, rotation: null,
      lines: [], liveContent: '',
    };
  },

  prompt() {
    const stage = state.mtext?.stage;
    if (stage === 'WIDTH') return `MTEXT — Specify opposite corner <${formatLength(defaultMTextWidth())} wide>:`;
    if (stage === 'HEIGHT') return `MTEXT — Specify height <${formatLength(defaultTextHeight())}>:`;
    if (stage === 'ROTATION') return 'MTEXT — Specify rotation angle <0>:';
    if (stage === 'CONTENT') return 'MTEXT — Enter a line of text, blank line to finish:';
    return 'MTEXT — Specify first corner:';
  },

  acceptsPoint() {
    return ['POINT', 'WIDTH', 'HEIGHT'].includes(state.mtext?.stage);
  },

  previewReady() {
    const stage = state.mtext?.stage;
    if (stage === 'CONTENT') return Boolean(state.mtext.lines.length || state.mtext.liveContent);
    return ['WIDTH', 'HEIGHT', 'ROTATION'].includes(stage);
  },

  point(p) {
    const operation = state.mtext;
    if (operation.stage === 'POINT') {
      operation.position = { ...p };
      operation.stage = 'WIDTH';
      updatePrompt();
      return;
    }
    if (operation.stage === 'WIDTH') {
      const width = dist(operation.position, p);
      if (width <= 1e-9) { updatePrompt('Width must be greater than zero.'); return; }
      operation.width = width;
      operation.stage = 'HEIGHT';
      updatePrompt();
      return;
    }
    if (operation.stage === 'HEIGHT') {
      const height = dist(operation.position, p);
      if (height <= 1e-9) { updatePrompt('Height must be greater than zero.'); return; }
      operation.height = height;
      operation.stage = 'ROTATION';
      updatePrompt();
    }
  },

  distance(value) {
    const operation = state.mtext;
    const stage = operation?.stage;
    if (stage !== 'WIDTH' && stage !== 'HEIGHT') return false;
    if (value <= 1e-9) {
      updatePrompt(`${stage === 'WIDTH' ? 'Width' : 'Height'} must be greater than zero.`);
      return true;
    }
    operation[stage === 'WIDTH' ? 'width' : 'height'] = value;
    operation.stage = stage === 'WIDTH' ? 'HEIGHT' : 'ROTATION';
    updatePrompt();
    draw();
    return true;
  },

  value(text) {
    const operation = state.mtext;
    if (operation?.stage === 'ROTATION') {
      const match = text.trim().match(DEGREES);
      if (!match) { updatePrompt('Invalid angle. Enter degrees.'); return true; }
      operation.rotation = Number(match[1]) * Math.PI / 180;
      operation.stage = 'CONTENT';
      updatePrompt();
      draw();
      return true;
    }
    if (operation?.stage === 'CONTENT') {
      // A non-blank submission is one more line, not the end of entry — a
      // blank Enter (finish(), below) is what closes the entity out.
      operation.lines.push(text);
      operation.liveContent = '';
      updatePrompt();
      draw();
      return true;
    }
    return false;
  },

  liveValue(text) {
    const operation = state.mtext;
    if (operation?.stage !== 'CONTENT') return;
    operation.liveContent = text;
    draw();
  },

  // Enter/Space with nothing typed accepts the bracketed default for the
  // current stage, matching AutoCAD's <default> convention — except at
  // CONTENT, where a blank line is the multi-line terminator instead.
  finish() {
    const operation = state.mtext;
    if (!operation || operation.stage === 'POINT') return false;
    if (operation.stage === 'WIDTH') {
      operation.width = defaultMTextWidth();
      operation.stage = 'HEIGHT';
      updatePrompt();
      draw();
      return;
    }
    if (operation.stage === 'HEIGHT') {
      operation.height = defaultTextHeight();
      operation.stage = 'ROTATION';
      updatePrompt();
      draw();
      return;
    }
    if (operation.stage === 'ROTATION') {
      operation.rotation = 0;
      operation.stage = 'CONTENT';
      updatePrompt();
      draw();
      return;
    }
    if (!operation.lines.length) {
      updatePrompt('Enter at least one line of text.');
      return false;
    }
    if (addMText(operation.position, operation.width, operation.height, operation.rotation, operation.lines.join('\n'))) {
      setMode('SELECT');
    }
    return;
  },

  preview(p) {
    const operation = state.mtext;
    if (operation.stage === 'WIDTH' || operation.stage === 'HEIGHT') {
      drawEntity({ type: 'LINE', a: operation.position, b: p }, true);
      return;
    }
    if (operation.stage === 'ROTATION') {
      drawEntity({
        type: 'MTEXT',
        position: operation.position,
        width: operation.width,
        height: operation.height,
        rotation: Math.atan2(p.y - operation.position.y, p.x - operation.position.x),
        content: '(text)',
      }, true);
      return;
    }
    if (operation.stage === 'CONTENT') {
      const content = [...operation.lines, operation.liveContent].join('\n');
      if (content.trim()) {
        drawEntity({
          type: 'MTEXT',
          position: operation.position,
          width: operation.width,
          height: operation.height,
          rotation: operation.rotation,
          content,
        }, true);
      }
    }
  },
});
