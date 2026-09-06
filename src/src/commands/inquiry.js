import { COMMAND_COMPLETE, activeCommand, defineCommand, setMode } from './registry.js';
import { arcSweep, circularPoint, dist, normalizeAngle } from '../core/math.js';
import { formatAngle, formatArea, formatLength, formatLengthLabel } from '../core/units.js';
import { ctx } from '../dom.js';
import { dimensionGeometry, dimensionText } from '../model/dimension.js';
import { entityArea, entityLength, entitySegments, polygonArea, polylineIsClosed } from '../model/entity.js';
import { getLayer, isEntityVisible } from '../model/layerQuery.js';
import { state } from '../state.js';
import { showInquiryReport } from '../ui/inquiry.js';
import { updatePrompt } from '../ui/prompt.js';
import { draw } from '../view/frame.js';
import { drawEntity, drawTransformGuide } from '../view/render.js';
import { worldToScreen } from '../view/viewport.js';

defineCommand('DIST', {
  usesOrtho: true,

  begin() {
    state.inquiry = { type: 'DIST', stage: 'POINTS' };
  },

  prompt() {
    return state.currentPoints.length
      ? 'DIST — Specify second point:'
      : 'DIST — Specify first point:';
  },

  point(p) {
    if (!state.currentPoints.length) {
      state.currentPoints.push({ ...p });
      updatePrompt();
    } else {
      reportDistance(state.currentPoints[0], p);
      setMode('SELECT');
    }
  },

  preview(p) {
    const from = state.currentPoints[0];
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    drawEntity({ type: 'LINE', a: from, b: p }, true);
    drawTransformGuide(
      from,
      p,
      `${formatLengthLabel(Math.hypot(dx, dy))} @ ${formatAngle(normalizeAngle(Math.atan2(dy, dx)))}`,
    );
  },

  finish() {
    setMode('SELECT');
  },
});

defineCommand('ID', {
  begin() {
    state.inquiry = { type: 'ID', stage: 'POINTS' };
  },

  prompt() {
    return 'ID — Specify point:';
  },

  point(p) {
    reportPoint(p);
    setMode('SELECT');
  },

  finish() {
    setMode('SELECT');
  },
});

defineCommand('AREA', {
  usesOrtho: true,

  begin() {
    state.inquiry = { type: 'AREA', stage: 'POINTS', mode: 'POINTS' };
    // Point-mode AREA does not consume a selection. Clear stale highlights
    // immediately instead of carrying them through an unrelated inquiry.
    state.selected.clear();
  },

  prompt() {
    if (state.inquiry?.stage === 'SELECT') {
      return 'AREA Object — Select one closed polyline or circle, then Enter:';
    }
    return state.currentPoints.length >= 3
      ? `AREA — Specify next point or Enter to total (${state.currentPoints.length} picked):`
      : `AREA — Specify point or [Object] (${state.currentPoints.length} picked):`;
  },

  acceptsPoint() {
    return state.inquiry?.stage === 'POINTS';
  },

  selectsObjects() {
    return state.inquiry?.stage === 'SELECT';
  },

  point(p) {
    if (state.inquiry?.stage !== 'POINTS') return;
    state.currentPoints.push({ ...p });
    updatePrompt();
  },

  keyword(text) {
    const keyword = text.trim().toUpperCase();
    if (['O', 'OBJECT'].includes(keyword)) {
      state.inquiry.mode = 'OBJECT';
      state.inquiry.stage = 'SELECT';
      state.currentPoints = [];
      state.selected.clear();
      updatePrompt();
      draw();
      return true;
    }
    if (['P', 'POINT', 'POINTS'].includes(keyword)) {
      state.inquiry.mode = 'POINTS';
      state.inquiry.stage = 'POINTS';
      state.selected.clear();
      updatePrompt();
      draw();
      return true;
    }
    return false;
  },

  preview(p) {
    if (state.inquiry?.stage !== 'POINTS') return;
    const points = [...state.currentPoints, p];
    // Shade the boundary as it is built so an accidental extra pick is obvious
    // before the total is taken.
    if (points.length >= 3) {
      ctx.beginPath();
      points.forEach((point, index) => {
        const screen = worldToScreen(point);
        if (index === 0) ctx.moveTo(screen.x, screen.y);
        else ctx.lineTo(screen.x, screen.y);
      });
      ctx.closePath();
      ctx.fillStyle = 'rgba(86, 214, 255, .12)';
      ctx.fill();
    }
    drawEntity({ type: 'PLINE', points, closed: points.length >= 3 }, true);
    if (points.length >= 3) {
      drawTransformGuide(
        state.currentPoints[state.currentPoints.length - 1],
        p,
        formatArea(Math.abs(polygonArea(points))),
      );
    }
  },

  finish() {
    if (state.inquiry?.stage === 'SELECT') {
      const selected = visibleSelectedEntities();
      if (!selected.length) {
        updatePrompt('No objects selected.');
      } else if (selected.length !== 1) {
        updatePrompt('Select exactly one closed polyline or circle.');
      } else if (reportEntityArea(selected[0])) {
        setMode('SELECT');
      }
      return true;
    }
    if (state.inquiry?.stage !== 'POINTS') return false;
    if (state.currentPoints.length < 3) {
      updatePrompt('Pick at least three points to enclose an area.');
    } else {
      reportPolygonArea(state.currentPoints);
      setMode('SELECT');
    }
    return true;
  },
});

defineCommand('LIST', {
  begin() {
    const selected = visibleSelectedEntities();
    if (selected.length) {
      reportEntityList(selected);
      return COMMAND_COMPLETE;
    }
    state.inquiry = { type: 'LIST', stage: 'SELECT' };
  },

  prompt() {
    return state.selected.size
      ? `LIST — ${state.selected.size} selected; Enter or right-click to report:`
      : 'LIST — Select objects, then press Enter or right-click:';
  },

  selectsObjects() {
    return state.inquiry?.stage === 'SELECT';
  },

  finish() {
    if (state.inquiry?.stage !== 'SELECT') return false;
    const selected = visibleSelectedEntities();
    if (!selected.length) {
      updatePrompt('No objects selected.');
    } else {
      reportEntityList(selected);
      setMode('SELECT');
    }
    return true;
  },
});

// ---------------------------------------------------------------------------
// Inquiry commands
//
// All read-only: no history entry, no document change, no schema impact. They
// also serve as the only way to check the geometry engine numerically, which
// is why they exist before annotation rather than after.
// ---------------------------------------------------------------------------

export function visibleSelectedEntities() {
  return state.entities.filter(entity =>
    state.selected.has(entity.id) && isEntityVisible(entity));
}

export function describePoint(point) {
  return `${formatLength(point.x)}, ${formatLength(point.y)}`;
}

export function reportDistance(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  showInquiryReport('DISTANCE', [{
    rows: [
      ['Distance', formatLengthLabel(Math.hypot(dx, dy))],
      ['Angle in XY plane', formatAngle(normalizeAngle(Math.atan2(dy, dx)))],
      ['Delta X', formatLengthLabel(dx)],
      ['Delta Y', formatLengthLabel(dy)],
      ['From', describePoint(from)],
      ['To', describePoint(to)],
    ],
  }]);
}

export function reportPoint(point) {
  showInquiryReport('POINT', [{
    rows: [['X', formatLength(point.x)], ['Y', formatLength(point.y)]],
  }]);
}

export function reportPolygonArea(points) {
  const area = Math.abs(polygonArea(points));
  let perimeter = 0;
  for (let i = 0; i < points.length; i++) {
    perimeter += dist(points[i], points[(i + 1) % points.length]);
  }
  showInquiryReport('AREA', [{
    rows: [
      ['Area', formatArea(area)],
      ['Perimeter', formatLengthLabel(perimeter)],
      ['Points', String(points.length)],
    ],
    note: 'Picked points are treated as a closed boundary. Self-intersecting outlines give a signed result and are not reliable.',
  }]);
}

export function reportEntityArea(entity) {
  const area = entityArea(entity);
  if (area === null) {
    updatePrompt('That object does not enclose an area. Pick a circle or a closed polyline.');
    return false;
  }
  showInquiryReport('AREA', [{
    title: `${entity.type} on layer ${getLayer(entity.layerId)?.name || '0'}`,
    rows: [
      ['Area', formatArea(area)],
      [entity.type === 'CIRCLE' ? 'Circumference' : 'Perimeter', formatLengthLabel(entityLength(entity))],
    ],
  }]);
  return true;
}

export function entityReportGroup(entity) {
  const layer = getLayer(entity.layerId);
  const rows = [['Layer', layer?.name || '0'], ['ID', String(entity.id)]];
  if (entity.type === 'LINE') {
    const dx = entity.b.x - entity.a.x;
    const dy = entity.b.y - entity.a.y;
    rows.push(
      ['From', describePoint(entity.a)],
      ['To', describePoint(entity.b)],
      ['Length', formatLengthLabel(entityLength(entity))],
      ['Angle', formatAngle(normalizeAngle(Math.atan2(dy, dx)))],
    );
  } else if (entity.type === 'PLINE') {
    const closed = polylineIsClosed(entity);
    const curved = entitySegments(entity).filter(([, , arc]) => arc).length;
    rows.push(
      ['Vertices', String(entity.points.length)],
      ['Closed', closed ? 'Yes' : 'No'],
    );
    if (curved) rows.push(['Curved segments', String(curved)]);
    rows.push([closed ? 'Perimeter' : 'Length', formatLengthLabel(entityLength(entity))]);
    if (closed) rows.push(['Area', formatArea(entityArea(entity))]);
  } else if (entity.type === 'CIRCLE') {
    rows.push(
      ['Center', describePoint(entity.center)],
      ['Radius', formatLengthLabel(entity.radius)],
      ['Diameter', formatLengthLabel(entity.radius * 2)],
      ['Circumference', formatLengthLabel(entityLength(entity))],
      ['Area', formatArea(entityArea(entity))],
    );
  } else if (entity.type === 'DIM') {
    const geometry = dimensionGeometry(entity);
    const referenced = entity.refs.filter(Boolean).length;
    rows.push(
      ['Dimension type', entity.dimType],
      ['Measurement', dimensionText(entity)],
      ['Exact value', formatLengthLabel(geometry.measure)],
      ['From', describePoint(entity.p1)],
      ['To', describePoint(entity.p2)],
      ['Style', geometry.style.name],
      ['Associative', referenced === 0 ? 'No' : referenced === 2 ? 'Yes' : 'Partial'],
      ['References captured', `${referenced} of 2`],
    );
  } else if (entity.type === 'TEXT') {
    rows.push(
      ['Position', describePoint(entity.position)],
      ['Height', formatLengthLabel(entity.height)],
      ['Rotation', formatAngle(normalizeAngle(entity.rotation))],
      ['Content', entity.content],
    );
  } else if (entity.type === 'ARC') {
    rows.push(
      ['Center', describePoint(entity.center)],
      ['Radius', formatLengthLabel(entity.radius)],
      ['Start angle', formatAngle(normalizeAngle(entity.startAngle))],
      ['End angle', formatAngle(normalizeAngle(entity.endAngle))],
      ['Included angle', formatAngle(arcSweep(entity))],
      ['Arc length', formatLengthLabel(entityLength(entity))],
      ['Chord', formatLengthLabel(dist(
        circularPoint(entity.center, entity.radius, entity.startAngle),
        circularPoint(entity.center, entity.radius, entity.endAngle),
      ))],
    );
  }
  return { title: entity.type, rows };
}

export const LIST_REPORT_LIMIT = 20;

export function reportEntityList(entities) {
  const shown = entities.slice(0, LIST_REPORT_LIMIT);
  const groups = shown.map(entityReportGroup);
  let totalLength = 0;
  let totalArea = 0;
  let areaCount = 0;
  for (const entity of entities) {
    totalLength += entityLength(entity);
    const area = entityArea(entity);
    if (area !== null) { totalArea += area; areaCount += 1; }
  }
  if (entities.length > 1) {
    const rows = [['Objects', String(entities.length)], ['Total length', formatLengthLabel(totalLength)]];
    if (areaCount) rows.push([`Total area (${areaCount})`, formatArea(totalArea)]);
    groups.unshift({ title: 'Selection', rows });
  }
  if (entities.length > shown.length) {
    groups.push({ note: `${entities.length - shown.length} more object(s) not listed individually.` });
  }
  showInquiryReport('LIST', groups);
}

// Compatibility entry points retained for the test API. Runtime dispatch now
// reaches the same registry finish hook directly.
export function acceptInquirySelection() {
  if (state.inquiry?.stage !== 'SELECT') return false;
  const command = activeCommand();
  if (!command?.finish) return false;
  command.finish();
  return true;
}

export function finishInquiryPoints() {
  if (state.inquiry?.stage !== 'POINTS') return false;
  const command = activeCommand();
  if (!command?.finish) return false;
  command.finish();
  return true;
}

// Kept as a narrow public wrapper for existing tests and integrations.
export function commitAreaKeyword(text) {
  if (state.mode !== 'AREA') return false;
  return Boolean(activeCommand()?.keyword?.(text));
}

// Locked and hidden layers are filtered out at every point where a selection
// becomes an operand, so a refusal is never discovered halfway through.
