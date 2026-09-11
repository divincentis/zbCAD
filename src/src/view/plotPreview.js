import { pdfTextWidthMM } from '../output/pdf.js';

// ---------------------------------------------------------------------------
// Plot preview
//
// The plot plan (output/plot.js) drawn onto a small canvas, so sheet, scale and
// area can be judged before a file is written. It reads the same plan that
// output/pdf.js serialises and nothing else: there is no second path from the
// drawing to paper that could drift out of step, so what this shows is what the
// PDF contains — including the clip at the picked area's border, which is the
// part of a plot that is otherwise impossible to guess.
// ---------------------------------------------------------------------------

// Room around the sheet for whatever falls off it. Without this a plot that
// overruns the paper would be cropped by the preview as well, which is exactly
// the information the preview exists to give.
export const PLOT_PREVIEW_PAD_PX = 18;
// Plotted hairlines are a fraction of a millimetre and vanish at preview scale;
// the preview is about placement, not about honest line weights.
export const PLOT_PREVIEW_MIN_STROKE_PX = 0.7;
// Everything outside the printable area is clipped out of the PDF. It is drawn
// anyway, in the same amber the warnings use, so a missing line has a visible
// reason rather than just being absent.
export const PLOT_PREVIEW_CLIPPED_COLOR = '#e0a03c';
export const PLOT_PREVIEW_CLIPPED_ALPHA = 0.5;

export function plotPreviewCssColor(color) {
  const [r, g, b] = color || [0, 0, 0];
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

// Where the sheet sits inside the preview box, and how to get from a paper
// millimetre (Y up, from the bottom-left corner) to a CSS pixel (Y down).
export function plotPreviewView(page, widthPx, heightPx) {
  const scale = Math.min(
    (widthPx - PLOT_PREVIEW_PAD_PX * 2) / page.widthMM,
    (heightPx - PLOT_PREVIEW_PAD_PX * 2) / page.heightMM,
  );
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const originX = (widthPx - page.widthMM * scale) / 2;
  const originY = (heightPx + page.heightMM * scale) / 2;
  return {
    scale, originX, originY,
    toPx: point => ({ x: originX + point.x * scale, y: originY - point.y * scale }),
  };
}

// Runs `draw` with the context in paper millimetres, Y up — the plan's own
// coordinates, which is what lets the bezier and dash numbers be used as they
// stand instead of being converted a second time.
function inPaperFrame(context, view, draw) {
  context.save();
  context.translate(view.originX, view.originY);
  context.scale(view.scale, -view.scale);
  draw();
  context.restore();
}

export function drawPlotPreviewStroke(context, view, op, clipped) {
  inPaperFrame(context, view, () => {
    context.strokeStyle = clipped ? PLOT_PREVIEW_CLIPPED_COLOR : plotPreviewCssColor(op.color);
    context.lineWidth = Math.max(op.widthMM, PLOT_PREVIEW_MIN_STROKE_PX / view.scale);
    context.setLineDash(op.dash && op.dash.length ? op.dash : []);
    context.beginPath();
    for (const subpath of op.subpaths) {
      context.moveTo(subpath.start.x, subpath.start.y);
      for (const segment of subpath.segs) {
        if (segment.type === 'c') {
          context.bezierCurveTo(segment.c1.x, segment.c1.y, segment.c2.x, segment.c2.y,
            segment.to.x, segment.to.y);
        } else {
          context.lineTo(segment.to.x, segment.to.y);
        }
      }
      if (subpath.closed) context.closePath();
    }
    context.stroke();
    context.setLineDash([]);
  });
}

export function drawPlotPreviewFill(context, view, op, clipped) {
  inPaperFrame(context, view, () => {
    context.fillStyle = clipped ? PLOT_PREVIEW_CLIPPED_COLOR : plotPreviewCssColor(op.color);
    context.beginPath();
    op.points.forEach((point, index) => {
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    context.closePath();
    context.fill();
  });
}

// Below this the glyphs are smaller than the strokes that draw them and come
// out as a smudge, so the string is greeked into a bar instead: unreadable
// either way, but a bar is honest about being an approximation, and leaving
// the text out altogether would hide annotation that is really on the sheet.
export const PLOT_PREVIEW_GREEK_PX = 3;
export const PLOT_PREVIEW_GREEK_ALPHA = 0.5;

// Text is placed in pixel space rather than in the flipped paper frame, so the
// font size stays a real pixel size the canvas can render. The anchor and
// baseline offsets are the ones output/pdf.js applies, so a centred dimension
// string lands in the preview where it lands on the sheet.
export function drawPlotPreviewText(context, view, op, clipped) {
  const family = op.font === 'courier' ? '"Courier New", Consolas, monospace' : 'Arial, Helvetica, sans-serif';
  const sizePx = op.sizeMM * view.scale;
  if (sizePx <= 0) return;
  const widthPx = pdfTextWidthMM(op.text, op.font, op.sizeMM) * view.scale;
  const u = op.anchor === 'center' ? -widthPx / 2 : 0;
  const v = op.baseline === 'middle' ? -0.35 * sizePx : 0;
  const anchor = view.toPx(op);
  context.save();
  context.translate(anchor.x, anchor.y);
  // Screen Y points down, so a counter-clockwise paper angle is a clockwise
  // canvas one.
  context.rotate(-op.angle);
  context.fillStyle = clipped ? PLOT_PREVIEW_CLIPPED_COLOR : plotPreviewCssColor(op.color);
  if (sizePx < PLOT_PREVIEW_GREEK_PX) {
    context.globalAlpha *= PLOT_PREVIEW_GREEK_ALPHA;
    context.fillRect(u, -v - sizePx * 0.7, widthPx, sizePx * 0.7);
  } else {
    context.font = `${sizePx}px ${family}`;
    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
    context.fillText(op.text, u, -v);
  }
  context.restore();
}

export function drawPlotPreviewOps(context, view, ops, clipped) {
  for (const op of ops) {
    if (op.kind === 'stroke') drawPlotPreviewStroke(context, view, op, clipped);
    else if (op.kind === 'fill') drawPlotPreviewFill(context, view, op, clipped);
    else if (op.kind === 'text') drawPlotPreviewText(context, view, op, clipped);
  }
}

function plotPreviewRect(context, view, box) {
  const corner = view.toPx({ x: box.xMM, y: box.yMM + box.heightMM });
  context.rect(corner.x, corner.y, box.widthMM * view.scale, box.heightMM * view.scale);
}

export function renderPlotPreview(target, context, plan) {
  const widthPx = target.clientWidth || target.width || 0;
  const heightPx = target.clientHeight || target.height || 0;
  const ratio = window.devicePixelRatio || 1;
  if (widthPx <= 0 || heightPx <= 0) return null;
  if (target.width !== Math.round(widthPx * ratio)) target.width = Math.round(widthPx * ratio);
  if (target.height !== Math.round(heightPx * ratio)) target.height = Math.round(heightPx * ratio);

  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, widthPx, heightPx);
  const page = plan && plan.page;
  if (!page) return null;
  const view = plotPreviewView(page, widthPx, heightPx);
  if (!view) return null;

  const sheet = view.toPx({ x: 0, y: page.heightMM });
  context.fillStyle = '#f4f4f4';
  context.fillRect(sheet.x, sheet.y, page.widthMM * view.scale, page.heightMM * view.scale);

  // Two passes over the same ops through complementary clips: the amber one
  // outside the clip rectangle, the real one inside it. Splitting them by
  // clip rather than by op means a single line that crosses the boundary is
  // shown half plotted and half lost, which is what actually happens. The
  // clip is the picked area (Window/Display/Extents) intersected with the
  // printable rectangle — the same one output/pdf.js clips to — not the
  // printable rectangle alone, so this also shows geometry outside a picked
  // Window being cut off, not just geometry past the sheet's margin.
  const ops = plan.ops || [];
  const clipMM = plan.clipMM || plan.printable;
  if (clipMM) {
    context.save();
    context.beginPath();
    context.rect(0, 0, widthPx, heightPx);
    plotPreviewRect(context, view, clipMM);
    context.clip('evenodd');
    context.globalAlpha = PLOT_PREVIEW_CLIPPED_ALPHA;
    drawPlotPreviewOps(context, view, ops, true);
    context.restore();

    context.save();
    context.beginPath();
    plotPreviewRect(context, view, clipMM);
    context.clip();
    drawPlotPreviewOps(context, view, ops, false);
    context.restore();
  }

  context.strokeStyle = '#7a7a7a';
  context.lineWidth = 1;
  context.strokeRect(sheet.x + 0.5, sheet.y + 0.5,
    page.widthMM * view.scale - 1, page.heightMM * view.scale - 1);

  if (plan.printable) {
    context.strokeStyle = '#a8a8a8';
    context.setLineDash([4, 3]);
    context.beginPath();
    plotPreviewRect(context, view, plan.printable);
    context.stroke();
    context.setLineDash([]);
  }
  return view;
}
