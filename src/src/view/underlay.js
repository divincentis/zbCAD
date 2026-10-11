import { canvas, ctx } from '../dom.js';
import { isLayerVisible } from '../model/layerQuery.js';
import { underlayCorners, underlayFadeAlpha, underlayHeight, underlayIsVector, underlaySelectionId, underlayWidth } from '../model/underlay.js';
import { eachVectorRecord, traceVectorPath } from '../model/vectorUnderlay.js';
import { state } from '../state.js';
import { draw } from './frame.js';
import { worldToScreen } from './viewport.js';

// Decoded images keyed by the underlay's data URL rather than by its id, so a
// MOVE — which replaces the record — reuses the decode instead of throwing it
// away and flashing an empty frame.
const IMAGE_CACHE = new Map();

// Decoding is asynchronous and rendering is not, so this never waits: a frame
// drawn before the image is ready simply skips it and the load handler asks for
// another frame. That also keeps the headless harness, whose Image never
// loads, from deadlocking on a paint.
export function underlayImage(underlay) {
  const cached = IMAGE_CACHE.get(underlay.data);
  if (cached) return cached.ready ? cached.image : null;
  const image = new Image();
  const record = { image, ready: false };
  IMAGE_CACHE.set(underlay.data, record);
  image.onload = () => {
    record.ready = true;
    draw();
  };
  // A payload the browser cannot decode stays un-ready forever, which renders
  // as an empty frame rather than as a broken drawing.
  image.onerror = () => { record.failed = true; };
  image.src = underlay.data;
  return null;
}

export function forgetUnderlayImages() {
  IMAGE_CACHE.clear();
  VECTOR_DISPLAY_CACHE.clear();
  VECTOR_LAYERS.clear();
}

// ---------------------------------------------------------------------------
// Vector underlays (a page of a PDF)
// ---------------------------------------------------------------------------

// The drawing area's background, as 0..1 channels. A PDF is ink on white
// paper and this canvas is light on near-black, so a page drawn in its own
// colours would be black lines on a black screen.
export const UNDERLAY_CANVAS_BACKGROUND = Object.freeze([0x11 / 255, 0x11 / 255, 0x11 / 255]);
// A plotted hairline is a fraction of a pixel at any zoom that shows the whole
// sheet; below one pixel the canvas fades a line out rather than thinning it.
export const UNDERLAY_VECTOR_MIN_STROKE_PX = 1;
// Text smaller than this is drawn as a bar: the glyphs would be a smudge, and
// a thousand smudges cost far more to draw than a thousand rectangles.
export const UNDERLAY_VECTOR_GREEK_PX = 3.5;

// Paper colour to screen colour: lightness is turned over and hue is kept, so
// black ink comes out white, the white of the sheet (and of any fill used to
// mask what is behind it) comes out as the canvas itself, and a red line is
// still red. This is the "adjust colours for the background" every CAD program
// applies to a PDF underlay, for the same reason.
export function underlayScreenColor(color) {
  const [r, g, b] = color;
  const high = Math.max(r, g, b);
  const low = Math.min(r, g, b);
  // Turning lightness over maps each channel c to (high + low) - c mirrored
  // about the middle: c' = 1 - (high + low) + c.
  const shift = 1 - (high + low);
  return [r + shift, g + shift, b + shift].map((level, index) => {
    const clamped = Math.min(1, Math.max(0, level));
    const back = UNDERLAY_CANVAS_BACKGROUND[index];
    return back + (1 - back) * clamped;
  });
}

function underlayCss(color) {
  return `rgb(${color.map(level => Math.round(level * 255)).join(', ')})`;
}

// The page as things the canvas can draw, built once per payload and keyed by
// the payload string itself — like the image cache, so that a MOVE or a
// CALIBRATE, which replace the record but not its data, reuse it.
const VECTOR_DISPLAY_CACHE = new Map();
// Undo keeps erased pages reachable, so a list is not dropped the moment its
// underlay goes; but each one holds every path of a sheet, so only the most
// recently drawn few are kept.
export const VECTOR_DISPLAY_CACHE_LIMIT = 8;

export function vectorDisplayList(data) {
  const cached = VECTOR_DISPLAY_CACHE.get(data);
  if (cached) {
    if (VECTOR_DISPLAY_CACHE.size > 1) {
      // A Map iterates in insertion order; re-inserting marks this one newest.
      VECTOR_DISPLAY_CACHE.delete(data);
      VECTOR_DISPLAY_CACHE.set(data, cached);
    }
    return cached;
  }
  const list = [];
  // Path2D holds a parsed path on the browser's side of the fence, so a frame
  // is one call per item rather than one per segment. The headless harness has
  // no Path2D; there the string is kept and replayed.
  const canHold = typeof Path2D === 'function';
  eachVectorRecord(data, record => {
    const css = underlayCss(underlayScreenColor(record.color));
    if (record.kind === 'text') {
      list.push({ ...record, css, natural: 0 });
      return;
    }
    let held = null;
    if (canHold) {
      held = new Path2D();
      traceVectorPath(record.path, held);
    }
    list.push({
      kind: record.kind, css, width: record.width, dash: record.dash, evenOdd: record.evenOdd,
      held, path: canHold ? null : record.path,
    });
  });
  VECTOR_DISPLAY_CACHE.set(data, list);
  while (VECTOR_DISPLAY_CACHE.size > VECTOR_DISPLAY_CACHE_LIMIT) {
    VECTOR_DISPLAY_CACHE.delete(VECTOR_DISPLAY_CACHE.keys().next().value);
  }
  return list;
}

function drawVectorText(context, item, pixelsPerUnit) {
  const sizePx = item.size * pixelsPerUnit;
  if (!(sizePx > 0.6)) return;
  context.save();
  context.translate(item.x, item.y);
  context.rotate(item.angle);
  // Out of the page's Y-up micrometres and into upright pixels, so the font
  // size is a real pixel size the canvas can render.
  context.scale(1 / pixelsPerUnit, -1 / pixelsPerUnit);
  context.fillStyle = item.css;
  const widthPx = item.width * pixelsPerUnit;
  if (sizePx < UNDERLAY_VECTOR_GREEK_PX) {
    context.globalAlpha *= 0.45;
    context.fillRect(0, -sizePx * 0.7, widthPx || sizePx * item.text.length * 0.5, sizePx * 0.7);
  } else {
    const family = item.font === 'courier' ? '"Courier New", Consolas, monospace' : 'Arial, Helvetica, sans-serif';
    if (!item.natural) {
      // How wide the stand-in face sets this string, per pixel of font size.
      // Measured once: it is a property of the string, not of the zoom.
      context.font = `100px ${family}`;
      item.natural = Math.max(1e-6, context.measureText(item.text).width / 100);
    }
    context.font = `${sizePx}px ${family}`;
    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
    // Stretched to the width the real font gave the string, so it ends where
    // it ended on the page and does not run into its neighbour.
    if (widthPx > 0) context.scale(Math.min(2.5, Math.max(0.4, widthPx / (item.natural * sizePx))), 1);
    context.fillText(item.text, 0, 0);
  }
  context.restore();
}

// Draws the page into `context`, which must already be in screen pixels.
export function drawVectorUnderlayItems(context, underlay) {
  const origin = worldToScreen(underlay.origin);
  const pixelsPerUnit = underlay.unitsPerPixel * state.view.scale;
  if (!(pixelsPerUnit > 0)) return;
  context.save();
  context.translate(origin.x, origin.y);
  context.rotate(-underlay.rotation);
  // Page coordinates are Y up, like the world and unlike the screen.
  context.scale(pixelsPerUnit, -pixelsPerUnit);
  const hairline = UNDERLAY_VECTOR_MIN_STROKE_PX / pixelsPerUnit;
  context.lineJoin = 'round';
  for (const item of vectorDisplayList(underlay.data)) {
    if (item.kind === 'text') {
      drawVectorText(context, item, pixelsPerUnit);
      continue;
    }
    if (!item.held) {
      context.beginPath();
      traceVectorPath(item.path, context);
    }
    if (item.kind === 'fill') {
      context.fillStyle = item.css;
      const rule = item.evenOdd ? 'evenodd' : 'nonzero';
      if (item.held) context.fill(item.held, rule);
      else context.fill(rule);
    } else {
      context.strokeStyle = item.css;
      context.lineWidth = Math.max(item.width, hairline);
      context.setLineDash(item.dash);
      if (item.held) context.stroke(item.held);
      else context.stroke();
    }
  }
  context.setLineDash([]);
  context.restore();
}

// One offscreen canvas per vector underlay, holding the page as last drawn.
// It earns its keep twice. Fade becomes a single composite of the finished
// page, where fading each stroke separately would let lines show through the
// white fills a drawing uses to mask them. And a frame in which the view has
// not moved — every mouse move while a command is tracking the cursor — costs
// one blit instead of redrawing a sheet's worth of line work.
const VECTOR_LAYERS = new Map();

function vectorLayer(underlay) {
  let layer = VECTOR_LAYERS.get(underlay.id);
  if (!layer) {
    const surface = document.createElement('canvas');
    layer = { surface, context: surface.getContext('2d'), key: '', data: null };
    VECTOR_LAYERS.set(underlay.id, layer);
  }
  if (!layer.context) return null;
  const ratio = canvas.clientWidth ? canvas.width / canvas.clientWidth : 1;
  const key = [canvas.width, canvas.height, ratio, state.view.scale, state.view.offsetX, state.view.offsetY,
    underlay.origin.x, underlay.origin.y, underlay.rotation, underlay.unitsPerPixel].join('|');
  if (layer.key === key && layer.data === underlay.data) return layer;
  if (layer.surface.width !== canvas.width) layer.surface.width = canvas.width;
  if (layer.surface.height !== canvas.height) layer.surface.height = canvas.height;
  layer.context.setTransform(1, 0, 0, 1, 0, 0);
  layer.context.clearRect(0, 0, canvas.width, canvas.height);
  layer.context.setTransform(ratio, 0, 0, ratio, 0, 0);
  drawVectorUnderlayItems(layer.context, underlay);
  layer.key = key;
  layer.data = underlay.data;
  return layer;
}

function drawVectorUnderlay(underlay) {
  const layer = vectorLayer(underlay);
  ctx.save();
  ctx.globalAlpha = underlayFadeAlpha(underlay);
  if (layer) {
    // Device pixel for device pixel: the layer is the size of the canvas's
    // backing store, so it is copied with the scaling transform set aside.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layer.surface, 0, 0);
  } else {
    drawVectorUnderlayItems(ctx, underlay);
  }
  ctx.restore();
}

// Layers belong to underlays that still exist; an erased page should not keep
// a canvas-sized bitmap alive.
function pruneVectorLayers() {
  if (!VECTOR_LAYERS.size) return;
  const live = new Set(state.underlays.filter(underlayIsVector).map(underlay => underlay.id));
  for (const id of VECTOR_LAYERS.keys()) if (!live.has(id)) VECTOR_LAYERS.delete(id);
}

export function drawUnderlays() {
  pruneVectorLayers();
  for (const underlay of state.underlays) {
    if (!isLayerVisible(underlay.layerId)) continue;
    drawUnderlay(underlay);
  }
}

function drawUnderlay(underlay) {
  if (underlayIsVector(underlay)) {
    drawVectorUnderlay(underlay);
    if (state.selected.has(underlaySelectionId(underlay.id))) drawUnderlayOutline(underlay, true);
    return;
  }
  const image = underlayImage(underlay);
  const origin = worldToScreen(underlay.origin);
  const scale = underlay.unitsPerPixel * state.view.scale;
  if (image) {
    ctx.save();
    ctx.globalAlpha = underlayFadeAlpha(underlay);
    ctx.translate(origin.x, origin.y);
    // World Y and screen Y point opposite ways. Text solves this by rotating
    // backwards (see drawText); a raster cannot, because its own rows are laid
    // out top-down, so the whole frame is flipped instead and the image is
    // drawn from 0,0 downward in that flipped space.
    ctx.rotate(-underlay.rotation);
    ctx.scale(scale, scale);
    ctx.drawImage(image, 0, -underlay.heightPx, underlay.widthPx, underlay.heightPx);
    ctx.restore();
  }
  if (state.selected.has(underlaySelectionId(underlay.id))) drawUnderlayOutline(underlay, true);
  else if (!image) drawUnderlayOutline(underlay, false);
}

// The outline doubles as the placeholder for an image that has not decoded yet
// and as the selection indicator, since an underlay has no line work of its own
// that a selection halo could sit behind.
export function drawUnderlayOutline(underlay, selected) {
  const corners = underlayCorners(underlay).map(worldToScreen);
  ctx.save();
  ctx.setLineDash(selected ? [] : [6, 4]);
  ctx.lineWidth = selected ? 2 : 1;
  ctx.strokeStyle = selected ? 'rgba(86, 214, 255, 0.95)' : 'rgba(120, 120, 120, 0.7)';
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (let index = 1; index < corners.length; index++) ctx.lineTo(corners[index].x, corners[index].y);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

// The rubber band IMAGE draws while the insertion point is being picked. The
// raster itself is not drawn during placement: at an uncalibrated default scale
// it is routinely the size of a city block, and painting that on every mouse
// move to throw it away is a poor trade for an outline that says the same
// thing.
export function drawUnderlayPreview(descriptor, origin, unitsPerPixel, rotation = 0) {
  const preview = {
    origin,
    rotation,
    unitsPerPixel,
    widthPx: descriptor.widthPx,
    heightPx: descriptor.heightPx,
  };
  drawUnderlayOutline(preview, true);
  return { width: underlayWidth(preview), height: underlayHeight(preview) };
}
