import { ctx } from '../dom.js';
import { isLayerVisible } from '../model/layerQuery.js';
import { underlayCorners, underlayFadeAlpha, underlayHeight, underlaySelectionId, underlayWidth } from '../model/underlay.js';
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
}

export function drawUnderlays() {
  for (const underlay of state.underlays) {
    if (!isLayerVisible(underlay.layerId)) continue;
    drawUnderlay(underlay);
  }
}

function drawUnderlay(underlay) {
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
export function drawUnderlayPreview(descriptor, origin, unitsPerPixel) {
  const preview = {
    origin,
    rotation: 0,
    unitsPerPixel,
    widthPx: descriptor.widthPx,
    heightPx: descriptor.heightPx,
  };
  drawUnderlayOutline(preview, true);
  return { width: underlayWidth(preview), height: underlayHeight(preview) };
}
