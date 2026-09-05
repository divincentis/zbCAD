import { MAX_VIEW_SCALE, MIN_VIEW_SCALE } from '../core/constants.js';
import { canvas, ctx } from '../dom.js';
import { entityBBox } from '../model/entity.js';
import { isEntityVisible } from '../model/layerQuery.js';
import { state } from '../state.js';
import { draw } from './frame.js';

export let lastCanvasSize = null;

export function resize() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(rect.width * dpr);
  const height = Math.round(rect.height * dpr);
  // Assigning width/height clears the canvas, so only do it when it changed.
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (state.view.offsetX === 0 && state.view.offsetY === 0) {
    state.view.offsetX = rect.width / 2;
    state.view.offsetY = rect.height / 2;
  } else if (lastCanvasSize) {
    // Keep whatever is under the centre of the canvas under the centre after
    // the resize, so a toolbar wrap does not shift the drawing.
    state.view.offsetX += (rect.width - lastCanvasSize.width) / 2;
    state.view.offsetY += (rect.height - lastCanvasSize.height) / 2;
  }
  lastCanvasSize = { width: rect.width, height: rect.height };
  draw();
}

export function screenToWorld(p) {
  return {
    x: (p.x - state.view.offsetX) / state.view.scale,
    y: (state.view.offsetY - p.y) / state.view.scale,
  };
}

export function worldToScreen(p) {
  return {
    x: state.view.offsetX + p.x * state.view.scale,
    y: state.view.offsetY - p.y * state.view.scale,
  };
}

export function zoomAt(screen, factor) {
  const before = screenToWorld(screen);
  state.view.scale = Math.max(MIN_VIEW_SCALE, Math.min(MAX_VIEW_SCALE, state.view.scale * factor));
  const afterScreen = worldToScreen(before);
  state.view.offsetX += screen.x - afterScreen.x;
  state.view.offsetY += screen.y - afterScreen.y;
  draw();
}

export function zoomExtents() {
  const visibleEntities = state.entities.filter(isEntityVisible);
  if (!visibleEntities.length) {
    state.view.scale = 1.5;
    state.view.offsetX = canvas.clientWidth / 2;
    state.view.offsetY = canvas.clientHeight / 2;
    draw();
    return;
  }
  const boxes = visibleEntities.map(entityBBox).filter(Boolean);
  const box = {
    minX: Math.min(...boxes.map(b=>b.minX)), maxX: Math.max(...boxes.map(b=>b.maxX)),
    minY: Math.min(...boxes.map(b=>b.minY)), maxY: Math.max(...boxes.map(b=>b.maxY)),
  };
  const w = Math.max(1, box.maxX - box.minX);
  const h = Math.max(1, box.maxY - box.minY);
  const margin = 70;
  const fitScale = Math.min((canvas.clientWidth - margin*2)/w, (canvas.clientHeight - margin*2)/h);
  state.view.scale = Math.max(MIN_VIEW_SCALE, Math.min(MAX_VIEW_SCALE, fitScale));
  const cx = (box.minX + box.maxX)/2;
  const cy = (box.minY + box.maxY)/2;
  state.view.offsetX = canvas.clientWidth/2 - cx*state.view.scale;
  state.view.offsetY = canvas.clientHeight/2 + cy*state.view.scale;
  draw();
}

// A grid on a 1-2-5-10 decade ladder is right for metric, but produces
// meaningless 20" and 50" spacings on an inch drawing. Imperial formats get a
// fraction/inch/foot ladder instead.
