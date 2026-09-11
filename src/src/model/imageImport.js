import { UNDERLAY_JPEG_QUALITY, UNDERLAY_MAX_EDGE_PX } from '../core/constants.js';

// ---------------------------------------------------------------------------
// Turning a picked file into an underlay descriptor.
//
// This is the one part of the underlay feature that touches the DOM, and it is
// isolated here for two reasons. The obvious one is testability: everything
// downstream takes a plain { name, widthPx, heightPx, data } record and can be
// driven headlessly. The less obvious one is that this is also where the
// feature's two size decisions are enforced, and they are decisions rather than
// details:
//
//   1. Every source format is re-encoded to JPEG. The drawing travels as JSON
//      with the image inline, and the PDF writer embeds the bytes verbatim, so
//      normalising the format here means output/pdf.js needs exactly one image
//      filter (DCTDecode) instead of a PNG decoder and a deflate compressor.
//      Transparency is composited onto white on the way through, since an
//      underlay sits behind the drawing and has nothing to show through to.
//
//   2. The raster is capped on its long edge. Every autosave re-serialises this
//      payload, so an uncapped 40-megapixel phone photo would make each save
//      cost tens of megabytes of string building. 2400px still resolves far
//      more than anyone traces at.
// ---------------------------------------------------------------------------

// Returns the scale to draw the source at, never above 1: an image smaller than
// the cap is left exactly as it came in rather than being enlarged.
export function imageFitScale(widthPx, heightPx, maxEdge = UNDERLAY_MAX_EDGE_PX) {
  const longest = Math.max(widthPx, heightPx);
  if (!(longest > 0)) return 1;
  return Math.min(1, maxEdge / longest);
}

export function imageTargetSize(widthPx, heightPx, maxEdge = UNDERLAY_MAX_EDGE_PX) {
  const scale = imageFitScale(widthPx, heightPx, maxEdge);
  return {
    widthPx: Math.max(1, Math.round(widthPx * scale)),
    heightPx: Math.max(1, Math.round(heightPx * scale)),
    scale,
  };
}

export function decodeImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file could not be read as an image.'));
    };
    image.src = url;
  });
}

export function encodeUnderlayImage(image, name) {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    throw new Error('That image has no usable size.');
  }
  const target = imageTargetSize(sourceWidth, sourceHeight);
  const canvas = document.createElement('canvas');
  canvas.width = target.widthPx;
  canvas.height = target.heightPx;
  const context = canvas.getContext('2d');
  // JPEG has no alpha, and an undrawn canvas is transparent black, which would
  // turn every transparent pixel into solid black rather than into paper.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, target.widthPx, target.heightPx);
  context.drawImage(image, 0, 0, target.widthPx, target.heightPx);
  const data = canvas.toDataURL('image/jpeg', UNDERLAY_JPEG_QUALITY);
  if (!data.startsWith('data:image/jpeg')) {
    throw new Error('This browser could not encode the image.');
  }
  return {
    name: underlayNameFromFile(name),
    widthPx: target.widthPx,
    heightPx: target.heightPx,
    data,
  };
}

export function underlayNameFromFile(name) {
  const base = String(name || 'image').replace(/\.[^.]+$/, '').trim();
  return base.slice(0, 60) || 'image';
}

export async function underlayDescriptorFromFile(file) {
  const image = await decodeImageFile(file);
  return encodeUnderlayImage(image, file.name);
}
