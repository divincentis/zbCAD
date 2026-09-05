import { defineCommand, setMode } from './registry.js';
import { dist } from '../core/math.js';
import { addCircle, addLine, addPolyline, addRectangle, addThreePointArc, addThreePointCircle, circumcircleFromThreePoints, threePointArc } from '../geometry/construct.js';
import { snapSegments } from '../interaction/snap.js';
import { markDirty } from '../model/dirty.js';
import { restoreEditSnapshot } from '../model/document.js';
import { state } from '../state.js';
import { updatePrompt } from '../ui/prompt.js';
import { draw } from '../view/frame.js';
import { drawEntity } from '../view/render.js';

defineCommand('LINE', {
  creates: true,
  usesOrtho: true,
  takesDistance: true,

  prompt() {
    if (!state.currentPoints.length) return 'LINE — Specify first point:';
    return state.currentPoints.length >= 3
      ? 'LINE — Specify next point, distance, or [Close/Undo]:'
      : 'LINE — Specify next point, distance, or [Undo]:';
  },

  point(p) {
    if (!state.currentPoints.length) {
      state.currentPoints.push({ ...p });
    } else if (addLine(state.currentPoints[state.currentPoints.length - 1], p)) {
      // The whole run is retained, not just the last point, so that Close and
      // Undo have the chain available.
      state.currentPoints.push({ ...p });
    }
    updatePrompt();
  },

  preview(p) {
    drawEntity({ type: 'LINE', a: state.currentPoints[state.currentPoints.length - 1], b: p }, true);
  },

  close() {
    if (state.currentPoints.length < 3) {
      updatePrompt('Draw at least two segments before closing.');
      return;
    }
    const start = state.currentPoints[0];
    const last = state.currentPoints[state.currentPoints.length - 1];
    if (!addLine(last, start)) {
      updatePrompt('Could not close this line run.');
      return;
    }
    state.currentPoints = [];
    setMode('SELECT');
  },

  undoPoint() {
    if (state.currentPoints.length < 2) {
      // Only the start point exists, so nothing has been committed yet.
      if (state.currentPoints.length) state.currentPoints.pop();
      else updatePrompt('Nothing to undo in this line run.');
      updatePrompt();
      draw();
      return;
    }
    // addLine pushed a snapshot before creating the segment, so popping and
    // restoring it removes exactly that segment and rewinds nextId with it.
    const snapshot = state.history.pop();
    if (snapshot) {
      restoreEditSnapshot(snapshot);
      state.future.length = 0;
      markDirty();
    }
    state.currentPoints.pop();
    state.selected.clear();
    updatePrompt();
    draw();
  },

  finish() {
    state.currentPoints = [];
    setMode('SELECT');
  },
});

defineCommand('PLINE', {
  creates: true,
  usesOrtho: true,
  takesDistance: true,

  prompt() {
    if (!state.currentPoints.length) return 'PLINE — Specify start point:';
    return state.currentPoints.length >= 3
      ? 'PLINE — Specify next point, distance, or [Close/Undo]; Enter to finish:'
      : 'PLINE — Specify next point, distance, or [Undo]; Enter to finish:';
  },

  point(p) {
    // The loader rejects duplicate consecutive points, so accepting one here
    // would produce a drawing that saves and then refuses to reopen. A
    // double-click is enough to send the same point twice.
    const last = state.currentPoints[state.currentPoints.length - 1];
    if (last && dist(last, p) <= 1e-9) {
      updatePrompt('PLINE — That is the same point. Specify a different next point:');
      return;
    }
    state.currentPoints.push({ ...p });
    updatePrompt();
  },

  preview(p) {
    drawEntity({ type: 'PLINE', points: [...state.currentPoints, p] }, true);
  },

  // Completed legs of the active polyline are real geometry for OSNAP, even
  // though the polyline is not added to the document until it is finished.
  snapSegments() {
    const segments = [];
    for (let i = 0; i < state.currentPoints.length - 1; i++) {
      segments.push([state.currentPoints[i], state.currentPoints[i + 1]]);
    }
    return segments;
  },

  close() {
    if (state.currentPoints.length < 3) {
      updatePrompt('Specify at least three points before closing.');
      return;
    }
    if (addPolyline(state.currentPoints, true)) {
      state.currentPoints = [];
      setMode('SELECT');
    } else {
      updatePrompt('Could not close this polyline.');
    }
  },

  undoPoint() {
    if (state.currentPoints.length < 1) {
      updatePrompt('Nothing to undo in this polyline.');
      return;
    }
    state.currentPoints.pop();
    updatePrompt();
    draw();
  },

  finish() {
    if (state.currentPoints.length >= 2 && !addPolyline(state.currentPoints)) return false;
    state.currentPoints = [];
    setMode('SELECT');
  },
});

defineCommand('RECTANGLE', {
  creates: true,

  prompt() {
    return state.currentPoints.length
      ? 'RECTANGLE — Specify opposite corner:'
      : 'RECTANGLE — Specify first corner:';
  },

  point(p) {
    if (!state.currentPoints.length) {
      state.currentPoints.push({ ...p });
      updatePrompt();
    } else if (addRectangle(state.currentPoints[0], p)) {
      setMode('SELECT');
    } else {
      updatePrompt('Opposite corner must create nonzero width and height.');
    }
  },

  preview(p) {
    const first = state.currentPoints[0];
    drawEntity({
      type: 'PLINE',
      points: [first, { x: p.x, y: first.y }, p, { x: first.x, y: p.y }],
      closed: true,
    }, true);
  },
});

defineCommand('CIRCLE', {
  creates: true,
  // 2P and 3P treat a number as a directed distance from the last point.
  // Centre-radius and centre-diameter consume it in distance() instead.
  takesDistance: true,

  begin() {
    state.circle = { method: 'CENTER_RADIUS', stage: 'CENTER' };
  },

  prompt() {
    const method = state.circle?.method || 'CENTER_RADIUS';
    const stage = state.circle?.stage || 'CENTER';
    if (method === 'TWO_POINT') {
      return stage === 'FIRST'
        ? 'CIRCLE 2P — Specify first diameter endpoint:'
        : 'CIRCLE 2P — Specify second diameter endpoint:';
    }
    if (method === 'THREE_POINT') {
      if (stage === 'FIRST') return 'CIRCLE 3P — Specify first point:';
      if (stage === 'SECOND') return 'CIRCLE 3P — Specify second point:';
      return 'CIRCLE 3P — Specify third point:';
    }
    if (method === 'CENTER_DIAMETER') {
      return 'CIRCLE Diameter — Specify diameter or point:';
    }
    return stage === 'CENTER'
      ? 'CIRCLE — Specify center point or [2P/3P]:'
      : 'CIRCLE — Specify radius or [Diameter]:';
  },

  point(p) {
    const operation = state.circle;
    if (operation.method === 'TWO_POINT') {
      if (operation.stage === 'FIRST') {
        state.currentPoints = [{ ...p }];
        operation.stage = 'SECOND';
        updatePrompt();
      } else {
        const first = state.currentPoints[0];
        const diameter = dist(first, p);
        const center = { x: (first.x + p.x) / 2, y: (first.y + p.y) / 2 };
        if (addCircle(center, diameter / 2)) setMode('SELECT');
        else updatePrompt('Diameter endpoints must be different.');
      }
      return;
    }

    if (operation.method === 'THREE_POINT') {
      if (operation.stage === 'FIRST') {
        state.currentPoints = [{ ...p }];
        operation.stage = 'SECOND';
        updatePrompt();
      } else if (operation.stage === 'SECOND') {
        state.currentPoints.push({ ...p });
        operation.stage = 'THIRD';
        updatePrompt();
      } else if (addThreePointCircle(state.currentPoints[0], state.currentPoints[1], p)) {
        setMode('SELECT');
      } else {
        updatePrompt('Three circle points must be distinct and non-collinear.');
      }
      return;
    }

    if (operation.stage === 'CENTER') {
      state.currentPoints = [{ ...p }];
      operation.stage = 'RADIUS';
      updatePrompt();
      return;
    }

    const pickedDistance = dist(state.currentPoints[0], p);
    const radius = operation.method === 'CENTER_DIAMETER' ? pickedDistance / 2 : pickedDistance;
    if (addCircle(state.currentPoints[0], radius)) setMode('SELECT');
    else updatePrompt(operation.method === 'CENTER_DIAMETER'
      ? 'Diameter must be greater than zero.'
      : 'Radius must be greater than zero.');
  },

  distance(value) {
    const operation = state.circle;
    if (!state.currentPoints.length ||
        !['CENTER_RADIUS', 'CENTER_DIAMETER'].includes(operation?.method)) return false;
    const radius = operation.method === 'CENTER_DIAMETER' ? value / 2 : value;
    if (!addCircle(state.currentPoints[0], radius)) {
      updatePrompt(operation.method === 'CENTER_DIAMETER'
        ? 'Diameter must be greater than zero.'
        : 'Radius must be greater than zero.');
    } else {
      setMode('SELECT');
    }
    return true;
  },

  keyword(text) {
    const operation = state.circle;
    const keyword = text.trim().toUpperCase();
    if (['2P', '2POINT', 'TWOPOINT'].includes(keyword)) {
      if (operation.stage !== 'CENTER' || state.currentPoints.length) {
        updatePrompt('Choose 2P before specifying the center point.');
      } else {
        operation.method = 'TWO_POINT';
        operation.stage = 'FIRST';
        updatePrompt();
        draw();
      }
      return true;
    }
    if (['3P', '3POINT', 'THREEPOINT'].includes(keyword)) {
      if (operation.stage !== 'CENTER' || state.currentPoints.length) {
        updatePrompt('Choose 3P before specifying the center point.');
      } else {
        operation.method = 'THREE_POINT';
        operation.stage = 'FIRST';
        updatePrompt();
        draw();
      }
      return true;
    }
    if (['D', 'DIA', 'DIAMETER'].includes(keyword)) {
      if (operation.method !== 'CENTER_RADIUS' || operation.stage !== 'RADIUS' || !state.currentPoints.length) {
        updatePrompt('Specify the circle center before choosing Diameter.');
      } else {
        operation.method = 'CENTER_DIAMETER';
        operation.stage = 'DIAMETER';
        updatePrompt();
        draw();
      }
      return true;
    }
    return false;
  },

  preview(p) {
    const method = state.circle?.method || 'CENTER_RADIUS';
    if (method === 'TWO_POINT') {
      const first = state.currentPoints[0];
      drawEntity({
        type: 'CIRCLE',
        center: { x: (first.x + p.x) / 2, y: (first.y + p.y) / 2 },
        radius: dist(first, p) / 2,
      }, true);
    } else if (method === 'THREE_POINT') {
      if (state.currentPoints.length === 1) {
        drawEntity({ type: 'LINE', a: state.currentPoints[0], b: p }, true);
      } else {
        const circle = circumcircleFromThreePoints(state.currentPoints[0], state.currentPoints[1], p);
        if (circle) drawEntity({ type: 'CIRCLE', ...circle }, true);
        else drawEntity({ type: 'PLINE', points: [...state.currentPoints, p] }, true);
      }
    } else {
      const pickedDistance = dist(state.currentPoints[0], p);
      drawEntity({
        type: 'CIRCLE',
        center: state.currentPoints[0],
        radius: method === 'CENTER_DIAMETER' ? pickedDistance / 2 : pickedDistance,
      }, true);
    }
  },
});

defineCommand('ARC', {
  creates: true,
  takesDistance: true,

  prompt() {
    if (!state.currentPoints.length) return 'ARC — Specify start point:';
    if (state.currentPoints.length === 1) return 'ARC — Specify point on arc:';
    return 'ARC — Specify endpoint:';
  },

  point(p) {
    if (state.currentPoints.length < 2) {
      state.currentPoints.push({ ...p });
      updatePrompt();
    } else if (addThreePointArc(state.currentPoints[0], state.currentPoints[1], p)) {
      setMode('SELECT');
    } else {
      updatePrompt('Points must be distinct and non-collinear.');
    }
  },

  preview(p) {
    if (state.currentPoints.length === 1) {
      drawEntity({ type: 'LINE', a: state.currentPoints[0], b: p }, true);
    } else {
      const preview = threePointArc(state.currentPoints[0], state.currentPoints[1], p);
      if (preview) drawEntity(preview, true);
      else drawEntity({ type: 'PLINE', points: [...state.currentPoints, p] }, true);
    }
  },
});
