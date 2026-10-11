import { underlayNameFromFile } from './imageImport.js';
import { pdfImageDataUrl, readPdfPage } from './pdfPage.js';
import { VECTOR_UNITS_PER_MM, encodeVectorUnderlay } from './vectorUnderlay.js';

// ---------------------------------------------------------------------------
// One page of an open PDF, as something that can be placed.
//
// Pure, like the reader beneath it: this decides what kind of underlay a page
// should become and says what was lost on the way, and leaves the placing to
// the PDF command. A page comes out one of three ways:
//
//   { descriptor, notes }  line work — a vector underlay, the usual case for
//                          anything that was plotted or exported from CAD
//   { scan }               a page that is nothing but a photograph of a
//                          drawing; the picture is handed back still encoded,
//                          to go through the ordinary image path
//   { error }              nothing here that can be shown
//
// The descriptor carries `mmPerPixel`, which an image descriptor never has: a
// PDF knows how big its sheet is, so the page can be placed at a real drawing
// scale instead of at a guess to be calibrated away.
// ---------------------------------------------------------------------------

// A scan sometimes has a stray border or a white background rectangle drawn
// under it; that much vector content does not make the page a drawing.
export const PDF_SCAN_MAX_FILLS = 2;
// The image has to be most of the page to be the page.
export const PDF_SCAN_MIN_COVERAGE = 0.25;

function pdfCountNote(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

export function pdfPageUnderlay(doc, pageIndex, fileName) {
  const plan = readPdfPage(doc, pageIndex);
  if (plan.error) return { error: plan.error };
  const base = underlayNameFromFile(fileName || 'pdf');
  const name = doc.pages.length > 1 ? `${base.slice(0, 52)} p${pageIndex + 1}` : base;
  const encoded = encodeVectorUnderlay(plan);
  const { strokes, fills, texts } = encoded.counts;
  const images = plan.ops.filter(op => op.kind === 'image');
  const pictures = images.length + plan.skipped.inlineImages;

  if (!strokes && !texts && fills <= PDF_SCAN_MAX_FILLS && pictures) {
    const pageArea = plan.page.widthMM * plan.page.heightMM;
    const largest = images.slice().sort((a, b) => b.widthMM * b.heightMM - a.widthMM * a.heightMM)[0];
    const data = largest && largest.widthMM * largest.heightMM >= pageArea * PDF_SCAN_MIN_COVERAGE
      ? pdfImageDataUrl(doc, largest) : null;
    if (!data) {
      return {
        error: 'That page is a scan stored in a format that cannot be read here. '
          + 'Save the page as a PNG or JPEG and place it with Image instead.',
      };
    }
    return {
      scan: {
        name, data,
        widthMM: largest.widthMM,
        heightMM: largest.heightMM,
        angle: Math.atan2(largest.edgeX.y, largest.edgeX.x),
      },
    };
  }
  if (!strokes && !fills && !texts) return { error: 'That page has nothing on it that can be shown.' };

  const notes = [];
  if (pictures) notes.push(`${pdfCountNote(pictures, 'image', 'images')} left out`);
  if (plan.skipped.text) {
    notes.push(`${pdfCountNote(plan.skipped.text, 'piece', 'pieces')} of text in a font that cannot be read`);
  }
  const shaded = plan.skipped.patterns + plan.skipped.shadings;
  if (shaded) notes.push(`${pdfCountNote(shaded, 'pattern or gradient fill', 'pattern or gradient fills')} left out`);
  if (plan.truncated) notes.push('the page has more line work than can be shown and was cut short');
  return {
    descriptor: {
      name,
      widthPx: encoded.widthPx,
      heightPx: encoded.heightPx,
      data: encoded.data,
      mmPerPixel: 1 / VECTOR_UNITS_PER_MM,
      rotation: 0,
    },
    counts: encoded.counts,
    notes,
  };
}
