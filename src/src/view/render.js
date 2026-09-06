import { activeCommand, commandPreviewReady } from '../commands/registry.js';
import { DEFAULT_LINETYPE, DEFAULT_LINEWEIGHT, LINETYPE_DASH_PATTERNS, LINEWEIGHT_PX_PER_MM, MIN_LINEWEIGHT_PX, TAU } from '../core/constants.js';
import { dimSize } from '../core/dimstyle.js';
import { formatAngle, formatLength, formatLengthLabel } from '../core/units.js';
import { assignLayerBtn, canvas, coordXEl, coordYEl, ctx, snapStatus } from '../dom.js';
import { calculateExtendOperation } from '../geometry/extend.js';
import { entityGrips } from '../geometry/grips.js';
import { calculateTrimOperation } from '../geometry/trim.js';
import { getActivePoint } from '../interaction/tracking.js';
import { dimensionGeometry, dimensionText } from '../model/dimension.js';
import { entitySegments } from '../model/entity.js';
import { getLayer, isEntityVisible } from '../model/layerQuery.js';
import { state } from '../state.js';
import { drawGrid } from './grid.js';
import { worldToScreen } from './viewport.js';

export function drawArrowHead(tip, direction, sizePx, color) {
  const width = sizePx * 0.36;
  const backX = tip.x - direction.x * sizePx;
  const backY = tip.y - direction.y * sizePx;
  const nx = -direction.y;
  const ny = direction.x;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(backX + nx * width, backY + ny * width);
  ctx.lineTo(backX - nx * width, backY - ny * width);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

export function drawDimension(entity, preview, color) {
  const geometry = dimensionGeometry(entity);
  const style = geometry.style;
  const scale = state.view.scale;
  const q1 = worldToScreen(geometry.q1);
  const q2 = worldToScreen(geometry.q2);

  ctx.strokeStyle = color;
  ctx.lineWidth = preview ? 1 : 1.1;
  ctx.setLineDash(preview ? [6, 4] : []);
  ctx.beginPath();
  ctx.moveTo(q1.x, q1.y);
  ctx.lineTo(q2.x, q2.y);
  for (const extension of [geometry.extension1, geometry.extension2]) {
    if (!extension) continue;
    const a = worldToScreen(extension[0]);
    const b = worldToScreen(extension[1]);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Terminators. Screen direction, not world direction, because the Y axis is
  // flipped between the two.
  const span = Math.hypot(q2.x - q1.x, q2.y - q1.y);
  if (span > 0.5) {
    const ux = (q2.x - q1.x) / span;
    const uy = (q2.y - q1.y) / span;
    const sizePx = dimSize(style, 'arrowSize') * scale;
    if (style.arrowType === 'tick') {
      // A 45 degree slash through the dimension line at each end.
      const tx = (ux + uy) * sizePx * 0.5;
      const ty = (uy - ux) * sizePx * 0.5;
      ctx.beginPath();
      ctx.moveTo(q1.x - tx, q1.y - ty); ctx.lineTo(q1.x + tx, q1.y + ty);
      ctx.moveTo(q2.x - tx, q2.y - ty); ctx.lineTo(q2.x + tx, q2.y + ty);
      ctx.stroke();
    } else {
      drawArrowHead(q1, { x: -ux, y: -uy }, sizePx, color);
      drawArrowHead(q2, { x: ux, y: uy }, sizePx, color);
    }
  }

  // Text, rotated along the dimension line and never upside down.
  const text = dimensionText(entity);
  const heightPx = dimSize(style, 'textHeight') * scale;
  if (heightPx >= 4) {
    const anchor = worldToScreen(geometry.textAnchor);
    let angle = Math.atan2(q2.y - q1.y, q2.x - q1.x);
    if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;
    ctx.save();
    ctx.translate(anchor.x, anchor.y);
    ctx.rotate(angle);
    ctx.font = `${heightPx}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const width = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(17, 17, 17, .82)';
    ctx.fillRect(-width / 2 - heightPx * 0.2, -heightPx * 0.62, width + heightPx * 0.4, heightPx * 1.24);
    ctx.fillStyle = color;
    ctx.fillText(text, 0, 0);
    ctx.restore();
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }
}

export function drawText(e, preview, color) {
  const screen = worldToScreen(e.position);
  const heightPx = e.height * state.view.scale;
  if (heightPx < 2) return; // Illegible below this; skip rather than draw a smear.
  ctx.save();
  ctx.translate(screen.x, screen.y);
  // World Y and screen Y point opposite ways, so an un-mirrored rotation here
  // would spin text the wrong direction relative to everything else drawn.
  ctx.rotate(-e.rotation);
  ctx.font = `${heightPx}px monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color;
  if (preview) ctx.globalAlpha = 0.6;
  ctx.fillText(e.content, 0, 0);
  ctx.restore();
}

// Screen line width is a fixed pixel value derived from the layer's mm
// lineweight (see LINEWEIGHT_PX_PER_MM), not something that scales with
// zoom — matches how CAD programs keep lineweight legible at any view scale.
export function lineWidthForLayer(layer) {
  const mm = typeof layer?.lineweight === 'number' ? layer.lineweight : DEFAULT_LINEWEIGHT;
  return Math.max(MIN_LINEWEIGHT_PX, mm * LINEWEIGHT_PX_PER_MM);
}

export function dashPatternForLayer(layer) {
  return LINETYPE_DASH_PATTERNS[layer?.linetype] || LINETYPE_DASH_PATTERNS[DEFAULT_LINETYPE];
}

export function drawEntity(e, preview = false) {
  const layer = getLayer(e.layerId);
  ctx.lineWidth = preview ? 1 : lineWidthForLayer(layer);
  const layerColor = layer?.color || '#d6d6d6';
  ctx.strokeStyle = preview ? '#bdbdbd' : state.selected.has(e.id) ? '#ffffff' : layerColor;
  if (e.type === 'DIM') {
    drawDimension(e, preview, preview ? '#bdbdbd' : state.selected.has(e.id) ? '#ffffff' : layerColor);
    return;
  }
  if (e.type === 'TEXT') {
    drawText(e, preview, preview ? '#bdbdbd' : state.selected.has(e.id) ? '#ffffff' : layerColor);
    return;
  }
  if (preview) ctx.setLineDash([6,4]); else ctx.setLineDash(dashPatternForLayer(layer));
  ctx.beginPath();
  if (e.type === 'CIRCLE') {
    const center = worldToScreen(e.center);
    ctx.arc(center.x, center.y, e.radius * state.view.scale, 0, TAU);
  } else if (e.type === 'ARC') {
    const center = worldToScreen(e.center);
    ctx.arc(center.x, center.y, e.radius * state.view.scale, -e.startAngle, -e.endAngle, true);
  } else {
    for (const [a,b] of entitySegments(e)) {
      const sa = worldToScreen(a), sb = worldToScreen(b);
      ctx.moveTo(sa.x,sa.y); ctx.lineTo(sb.x,sb.y);
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);

  if (state.selected.has(e.id) && !preview) {
    const points = entityGrips(e).map(grip => grip.point);
    ctx.fillStyle = '#fff';
    for (const p of points) {
      const s = worldToScreen(p);
      ctx.fillRect(s.x-2.5,s.y-2.5,5,5);
    }
  }
}

// Labels used to be drawn at a fixed +8/-8 from their anchor, so the snap type
// and the transform readout printed on top of each other whenever a snap was
// acquired mid-command. ROTATE and SCALE also draw two guides whose labels can
// collide with each other. Everything now goes through one placement pass that
// remembers what it has already put down this frame.
export const LABEL_HEIGHT = 12;
export const LABEL_ASCENT = 9;
export let frameLabelBoxes = [];

export function resetFrameLabels() {
  frameLabelBoxes = [];
}

export function labelBoxesOverlap(a, b) {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}

// Offsets are tried in order, so the first caller each frame keeps the
// conventional above-right position and later ones step out of the way.
export function labelPlacements(width) {
  return [
    [12, -8], [12, 18], [-12 - width, -8], [-12 - width, 18],
    [12, -26], [12, 36], [-12 - width, -26], [-12 - width, 36],
  ];
}

export function labelInsideCanvas(box) {
  const margin = 2;
  return box.x >= margin && box.y >= margin &&
    box.x + box.w <= canvas.clientWidth - margin &&
    box.y + box.h <= canvas.clientHeight - margin;
}

export function drawFloatingLabel(text, anchorX, anchorY, color) {
  if (!text) return null;
  ctx.font = '11px Arial';
  const width = ctx.measureText(text).width;
  const boxes = labelPlacements(width).map(([dx, dy]) => ({
    x: anchorX + dx, y: anchorY + dy - LABEL_ASCENT, w: width, h: LABEL_HEIGHT,
  }));
  const clear = box => !frameLabelBoxes.some(existing => labelBoxesOverlap(existing, box));
  // Preference order: on screen and clear, then on screen, then clear, then
  // anything — so a readout near the right edge flips to the left of the
  // cursor rather than being drawn off the canvas.
  const chosen = boxes.find(box => labelInsideCanvas(box) && clear(box)) ||
    boxes.find(labelInsideCanvas) ||
    boxes.find(clear) ||
    boxes[0];
  frameLabelBoxes.push(chosen);
  // A dim backing keeps the text readable where it crosses geometry.
  ctx.fillStyle = 'rgba(17, 17, 17, .74)';
  ctx.fillRect(chosen.x - 3, chosen.y - 1, width + 6, LABEL_HEIGHT + 2);
  ctx.fillStyle = color;
  ctx.fillText(text, chosen.x, chosen.y + LABEL_ASCENT);
  return chosen;
}

export function drawTransformGuide(start, end, label = '', dashed = false) {
  const startScreen = worldToScreen(start);
  const endScreen = worldToScreen(end);
  ctx.strokeStyle = '#ffc857';
  ctx.fillStyle = '#ffc857';
  ctx.lineWidth = 1.5;
  ctx.setLineDash(dashed ? [5, 4] : []);
  ctx.beginPath();
  ctx.moveTo(startScreen.x - 7, startScreen.y); ctx.lineTo(startScreen.x + 7, startScreen.y);
  ctx.moveTo(startScreen.x, startScreen.y - 7); ctx.lineTo(startScreen.x, startScreen.y + 7);
  ctx.moveTo(startScreen.x, startScreen.y); ctx.lineTo(endScreen.x, endScreen.y);
  ctx.stroke();
  ctx.setLineDash([]);
  drawFloatingLabel(label, endScreen.x, endScreen.y, '#ffc857');
}

export function drawTrimPreview() {
    const operation = calculateTrimOperation(state.mouseWorld);
    if (!operation.error) {
      ctx.strokeStyle = '#ff9f43';
      ctx.lineWidth = 3;
      ctx.setLineDash([]);
      ctx.beginPath();
      if (operation.removeArc) {
        const center = worldToScreen(operation.removeArc.center);
        ctx.arc(
          center.x,
          center.y,
          operation.removeArc.radius * state.view.scale,
          -operation.removeArc.startAngle,
          -operation.removeArc.endAngle,
          true,
        );
      } else {
        operation.removePoints.forEach((point, index) => {
          const screen = worldToScreen(point);
          if (index === 0) ctx.moveTo(screen.x, screen.y);
          else ctx.lineTo(screen.x, screen.y);
        });
      }
      ctx.stroke();
    }
}

export function drawExtendPreview() {
  const operation = calculateExtendOperation(state.mouseWorld);
  if (!operation.error) drawEntity(operation.result, true);
}

export function drawPreview() {
  const command = activeCommand();
  // render() has already resolved the active point for this frame. Calling
  // getActivePoint() again here ran the whole snap search a second time, so
  // every frame paid for snapping twice.
  if (command?.preview && commandPreviewReady(command)) command.preview(state.activePoint);
}

export function drawPolarTracking() {
  const lock = state.polarLock;
  if (!lock) return;
  // The ray is drawn past the locked point so the alignment reads as a
  // direction being followed rather than a segment being drawn.
  const overshoot = 40 / state.view.scale;
  const end = {
    x: lock.base.x + (lock.distance + overshoot) * Math.cos(lock.angle),
    y: lock.base.y + (lock.distance + overshoot) * Math.sin(lock.angle),
  };
  const a = worldToScreen(lock.base);
  const b = worldToScreen(end);
  ctx.save();
  ctx.strokeStyle = '#7ee081';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
  const at = worldToScreen(lock.point);
  drawFloatingLabel(
    `${formatLengthLabel(lock.distance)} < ${formatAngle(lock.angle)}`,
    at.x, at.y, '#7ee081',
  );
}

export function drawSnap() {
  if (!state.snapEnabled) {
    snapStatus.textContent = 'OFF';
    return;
  }
  snapStatus.textContent = state.snap ? state.snap.type : '—';
  if (!state.snap) return;
  const s = worldToScreen(state.snap.p);
  ctx.strokeStyle = '#56d6ff';
  ctx.fillStyle = '#56d6ff';
  ctx.lineWidth = 1.5;
  const r = 6;
  if (state.snap.type === 'END') {
    ctx.strokeRect(s.x-r,s.y-r,r*2,r*2);
  } else if (state.snap.type === 'MID') {
    ctx.beginPath();
    ctx.moveTo(s.x,s.y-r-1); ctx.lineTo(s.x-r-1,s.y+r); ctx.lineTo(s.x+r+1,s.y+r); ctx.closePath(); ctx.stroke();
  } else if (state.snap.type === 'INT') {
    ctx.beginPath(); ctx.moveTo(s.x-r,s.y-r); ctx.lineTo(s.x+r,s.y+r); ctx.moveTo(s.x+r,s.y-r); ctx.lineTo(s.x-r,s.y+r); ctx.stroke();
  } else if (state.snap.type === 'PERP') {
    ctx.strokeRect(s.x-r,s.y-r,r*2,r*2);
    ctx.fillRect(s.x-1,s.y-1,2,2);
  } else if (state.snap.type === 'CENTER') {
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.moveTo(s.x-r-2,s.y); ctx.lineTo(s.x+r+2,s.y);
    ctx.moveTo(s.x,s.y-r-2); ctx.lineTo(s.x,s.y+r+2);
    ctx.stroke();
  } else if (state.snap.type === 'QUAD') {
    ctx.beginPath();
    ctx.moveTo(s.x,s.y-r-1); ctx.lineTo(s.x+r+1,s.y); ctx.lineTo(s.x,s.y+r+1); ctx.lineTo(s.x-r-1,s.y); ctx.closePath(); ctx.stroke();
  } else if (state.snap.type === 'TAN') {
    // A circle with the tangent line resting on it.
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.moveTo(s.x-r-1, s.y-r); ctx.lineTo(s.x+r+1, s.y-r);
    ctx.stroke();
  } else if (state.snap.type === 'NEAR') {
    // An hourglass, which is the conventional nearest marker.
    ctx.beginPath();
    ctx.moveTo(s.x-r,s.y-r); ctx.lineTo(s.x+r,s.y-r);
    ctx.lineTo(s.x-r,s.y+r); ctx.lineTo(s.x+r,s.y+r);
    ctx.closePath(); ctx.stroke();
  }
  drawFloatingLabel(state.snap.type, s.x, s.y, '#56d6ff');
}

export function drawSelectionBox() {
  if (!state.dragSelect) return;
  const {start,end} = state.dragSelect;
  const crossing = end.x < start.x;
  ctx.fillStyle = crossing ? 'rgba(150,150,150,.10)' : 'rgba(220,220,220,.08)';
  ctx.strokeStyle = crossing ? '#8f8f8f' : '#cfcfcf';
  ctx.setLineDash(crossing ? [5,4] : []);
  ctx.fillRect(start.x,start.y,end.x-start.x,end.y-start.y);
  ctx.strokeRect(start.x,start.y,end.x-start.x,end.y-start.y);
  ctx.setLineDash([]);
}

export function render() {
  document.getElementById('dimensionNotice').hidden = state.mode !== 'DIM' &&
    !state.entities.some(entity => entity.type === 'DIM');
  resetFrameLabels();
  state.activePoint = getActivePoint();
  coordXEl.textContent = formatLength(state.activePoint.x);
  coordYEl.textContent = formatLength(state.activePoint.y);
  ctx.clearRect(0,0,canvas.clientWidth,canvas.clientHeight);
  ctx.fillStyle = '#111';
  ctx.fillRect(0,0,canvas.clientWidth,canvas.clientHeight);
  drawGrid();
  for (const e of state.entities) {
    if (isEntityVisible(e)) drawEntity(e);
  }
  drawPreview();
  drawPolarTracking();
  drawSelectionBox();
  drawSnap();
  if (assignLayerBtn) assignLayerBtn.disabled = !state.selected.size;
}
