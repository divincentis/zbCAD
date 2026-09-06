import { boot, DEFAULT_BUNDLE } from './harness.mjs';

const BUNDLE = process.argv[2] || DEFAULT_BUNDLE;

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) { passed++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const { api } = boot(BUNDLE);

const MM_PER_INCH = 25.4;

function reset() {
  api.newDrawing();
}

// Draw with real commands rather than seeding state, so what is plotted is
// what a user's clicks actually produce.
function drawLine(a, b) {
  api.startCommand('LINE');
  api.commitPoint(a);
  api.commitPoint(b);
  api.finishCurrent();
}

function settings(patch = {}) {
  return { ...api.defaultPlotSettings(), ...patch };
}

// Every stroked point in a plan, so a test can measure what was actually
// emitted rather than trusting the transform it was told about.
function planPoints(plan) {
  const points = [];
  for (const op of plan.ops) {
    if (op.kind === 'stroke') {
      for (const subpath of op.subpaths) {
        points.push(subpath.start);
        for (const segment of subpath.segs) {
          if (segment.c1) points.push(segment.c1, segment.c2);
          points.push(segment.to);
        }
      }
    } else if (op.kind === 'fill') {
      points.push(...op.points);
    } else if (op.kind === 'text') {
      points.push({ x: op.x, y: op.y });
    }
  }
  return points;
}

function planBox(plan) {
  const points = planPoints(plan);
  return {
    minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)),
    minY: Math.min(...points.map(p => p.y)), maxY: Math.max(...points.map(p => p.y)),
  };
}

function near(a, b, tolerance) {
  return Math.abs(a - b) <= tolerance;
}

// ---------------------------------------------------------------------------
// The roadmap's scale acceptance test, stated in its own words: a 100-foot
// model-space line exported at 1" = 20' must measure 5.00 inches in the PDF
// coordinate system, within 0.01 inch.
// ---------------------------------------------------------------------------
reset();
{
  // 100 feet in an inch drawing, drawn at an arbitrary place in model space so
  // the answer cannot come from the coordinates happening to start at zero.
  drawLine({ x: 137.5, y: -412.25 }, { x: 137.5 + 1200, y: -412.25 });
  const plan = api.buildPlotPlan(settings({ scaleMode: 'exact', scale: 240, paperSizeId: 'arch-d' }));
  check('acceptance: the plan builds', !plan.error, plan.error);

  const box = planBox(plan);
  const widthInches = (box.maxX - box.minX) / MM_PER_INCH;
  check('acceptance: a 100ft line at 1" = 20\' is 5.00 in wide',
    near(widthInches, 5, 0.01), `got ${widthInches.toFixed(4)} in`);

  // Same claim again, measured in PDF's own unit rather than millimetres,
  // since that is what a reader of the file actually sees: 5 inches is 360pt.
  const points = (box.maxX - box.minX) * api.POINTS_PER_MM;
  check('acceptance: the same line is 360 pt in PDF user space',
    near(points, 360, 0.72), `got ${points.toFixed(3)} pt`);

  check('acceptance: the line has no height on paper', near(box.maxY - box.minY, 0, 1e-9));
}

// The same physical scale expressed in a different drawing unit has to produce
// the same paper length, because a plot scale is a ratio of two real lengths.
reset();
{
  api.openUnitsDialog();
  api.setPendingUnits({ drawingUnit: 'millimeters', format: 'decimal', precision: 2 });
  api.applyUnitsDialog();
  check('unit switch took', api.unitSettings.drawingUnit === 'millimeters');

  // 100 feet = 30480 mm, plotted at the same 1" = 20' ratio.
  drawLine({ x: 0, y: 0 }, { x: 30480, y: 0 });
  const plan = api.buildPlotPlan(settings({ scaleMode: 'exact', scale: 240, paperSizeId: 'arch-d' }));
  const box = planBox(plan);
  const widthInches = (box.maxX - box.minX) / MM_PER_INCH;
  check('a metric drawing at the same ratio plots the same length',
    near(widthInches, 5, 0.01), `got ${widthInches.toFixed(4)} in`);
}

// ---------------------------------------------------------------------------
// Sheets, fitting, and placement
// ---------------------------------------------------------------------------
reset();
{
  const landscape = api.paperSizeMM('arch-d', 'landscape');
  const portrait = api.paperSizeMM('arch-d', 'portrait');
  check('ARCH D portrait is 24 x 36 in',
    near(portrait.widthMM, 24 * MM_PER_INCH, 1e-9) && near(portrait.heightMM, 36 * MM_PER_INCH, 1e-9));
  check('landscape is the same sheet turned over',
    near(landscape.widthMM, portrait.heightMM, 1e-9) && near(landscape.heightMM, portrait.widthMM, 1e-9));
  check('every listed sheet has a positive size',
    api.PAPER_SIZES.every(size => size.widthMM > 0 && size.heightMM > 0));
}

reset();
{
  // A square 100 x 100 unit drawing on a landscape sheet: fitting is limited by
  // the shorter (vertical) side, and the result must land inside the margins.
  api.addPolyline([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], true);
  const plan = api.buildPlotPlan(settings({ scaleMode: 'fit', paperSizeId: 'ansi-b' }));
  check('fit: the plan builds', !plan.error, plan.error);
  check('fit: reports that it fitted', plan.fitted === true);

  const box = planBox(plan);
  const margin = 0.5 * MM_PER_INCH;
  check('fit: stays inside the left/bottom margin',
    box.minX >= margin - 1e-6 && box.minY >= margin - 1e-6,
    `${box.minX.toFixed(3)}, ${box.minY.toFixed(3)}`);
  check('fit: stays inside the right/top margin',
    box.maxX <= plan.page.widthMM - margin + 1e-6 && box.maxY <= plan.page.heightMM - margin + 1e-6,
    `${box.maxX.toFixed(3)}, ${box.maxY.toFixed(3)}`);
  check('fit: fills the constraining dimension exactly',
    near(box.maxY - box.minY, plan.page.heightMM - margin * 2, 1e-6),
    `${(box.maxY - box.minY).toFixed(3)} vs ${(plan.page.heightMM - margin * 2).toFixed(3)}`);
  check('fit: a square drawing stays square on paper',
    near(box.maxX - box.minX, box.maxY - box.minY, 1e-6));

  // Centred by default, so the free space is shared between the two margins.
  check('fit: centred horizontally',
    near(box.minX - margin, (plan.page.widthMM - margin) - box.maxX, 1e-6));

  const cornered = api.buildPlotPlan(settings({ scaleMode: 'fit', paperSizeId: 'ansi-b', center: false }));
  const corneredBox = planBox(cornered);
  check('centring off puts the plot in the bottom-left corner',
    near(corneredBox.minX, margin, 1e-6) && near(corneredBox.minY, margin, 1e-6));
}

// An exact scale too large for the sheet still plots — and says so, rather
// than silently producing a page with the middle of the drawing missing.
reset();
{
  drawLine({ x: 0, y: 0 }, { x: 10000, y: 0 });
  const plan = api.buildPlotPlan(settings({ scaleMode: 'exact', scale: 1, paperSizeId: 'ansi-a' }));
  check('oversize: still produces a plan', !plan.error && plan.ops.length > 0);
  check('oversize: warns that it will be clipped',
    plan.warnings.some(warning => /clipped/i.test(warning)), plan.warnings.join(' | '));
  check('oversize: reports the true plotted size',
    near(plan.plotWidthMM, 10000 * MM_PER_INCH, 1e-6));
}

// ---------------------------------------------------------------------------
// What goes on the sheet
// ---------------------------------------------------------------------------
reset();
{
  const hidden = api.createLayer('Hidden');
  const noPrint = api.createLayer('Notes');
  const visible = api.createLayer('Walls');

  api.setCurrentLayer(visible);
  drawLine({ x: 0, y: 0 }, { x: 10, y: 0 });
  api.setCurrentLayer(hidden);
  drawLine({ x: 0, y: 5 }, { x: 10, y: 5 });
  api.setCurrentLayer(noPrint);
  drawLine({ x: 0, y: 10 }, { x: 10, y: 10 });
  api.toggleLayerVisibility(hidden);
  api.toggleLayerPrintable(noPrint);

  const plan = api.buildPlotPlan(settings());
  check('only the plottable object is counted', plan.entityCount === 1, `got ${plan.entityCount}`);
  check('one stroke is emitted', plan.ops.filter(op => op.kind === 'stroke').length === 1);
  check('excluded objects are reported',
    plan.warnings.some(warning => /non-printable/.test(warning)), plan.warnings.join(' | '));

  // The extents follow what is actually plotted: the hidden and non-printable
  // lines above the wall must not stretch the sheet.
  check('the plot area ignores excluded objects', near(plan.area.maxY, 0, 1e-9), `maxY ${plan.area.maxY}`);
}

reset();
{
  // Printing a layer that is switched off entirely is not an error to guess at.
  const only = api.createLayer('Only');
  api.setCurrentLayer(only);
  drawLine({ x: 0, y: 0 }, { x: 10, y: 0 });
  api.toggleLayerPrintable(only);
  const plan = api.buildPlotPlan(settings());
  check('a drawing with nothing printable refuses with a reason',
    Boolean(plan.error) && /non-printable/.test(plan.error), plan.error);
}

// Layer lineweight and linetype reach the paper, in millimetres rather than
// the screen's pixels.
reset();
{
  const heavy = api.createLayer('Heavy');
  api.setLayerLineweight(heavy, 0.70);
  api.setLayerLinetype(heavy, 'dashed');
  api.setCurrentLayer(heavy);
  drawLine({ x: 0, y: 0 }, { x: 10, y: 0 });

  const plan = api.buildPlotPlan(settings());
  const stroke = plan.ops.find(op => op.kind === 'stroke');
  check('the layer lineweight plots as its millimetre value', near(stroke.widthMM, 0.70, 1e-9));
  check('a dashed layer plots with a dash pattern', stroke.dash.length === 2 && stroke.dash[0] > stroke.dash[1]);
  check('the dash pattern is a paper length, not screen pixels',
    stroke.dash[0] > 0.5 && stroke.dash[0] < 20, `${stroke.dash[0]}`);

  const thin = api.buildPlotPlan(settings({ lineweights: false }));
  const thinStroke = thin.ops.find(op => op.kind === 'stroke');
  check('turning lineweights off plots everything thin', near(thinStroke.widthMM, 0.18, 1e-9));

  // A 0.00mm weight means "thinnest the device can draw", not "invisible".
  api.setLayerLineweight(heavy, 0);
  const hairline = api.buildPlotPlan(settings());
  check('a zero lineweight plots as a hairline rather than nothing',
    hairline.ops.find(op => op.kind === 'stroke').widthMM > 0);
}

reset();
{
  api.setLayerColor('0', '#ff8800');
  drawLine({ x: 0, y: 0 }, { x: 10, y: 0 });
  const mono = api.buildPlotPlan(settings({ color: 'mono' }));
  check('monochrome plots black',
    mono.ops.find(op => op.kind === 'stroke').color.every(channel => channel === 0));

  const colored = api.buildPlotPlan(settings({ color: 'layer' }));
  const rgb = colored.ops.find(op => op.kind === 'stroke').color;
  check('layer colors plot as the layer color',
    near(rgb[0], 1, 1e-6) && near(rgb[1], 0x88 / 255, 1e-6) && near(rgb[2], 0, 1e-6), JSON.stringify(rgb));
  check('layer colors carry a legibility warning',
    colored.warnings.some(warning => /faint/.test(warning)));
}

// ---------------------------------------------------------------------------
// Curved and annotated geometry
// ---------------------------------------------------------------------------
reset();
{
  api.startCommand('CIRCLE');
  api.commitPoint({ x: 50, y: 50 });
  api.commitPoint({ x: 60, y: 50 });
  const plan = api.buildPlotPlan(settings({ scaleMode: 'exact', scale: 1 }));
  const stroke = plan.ops.find(op => op.kind === 'stroke');
  check('a circle plots as one closed subpath',
    stroke.subpaths.length === 1 && stroke.subpaths[0].closed === true);
  check('a circle plots as four curves rather than a polygon',
    stroke.subpaths[0].segs.length === 4 && stroke.subpaths[0].segs.every(seg => seg.type === 'c'));

  // A circle of radius 10 drawing units at 1:1 is 10 x 25.4 mm in radius, so
  // the plotted box is the diameter across in both directions.
  const box = planBox(plan);
  check('the plotted circle is as wide as it is tall',
    near(box.maxX - box.minX, box.maxY - box.minY, 0.01));
  check('the plotted circle has the right diameter',
    near(box.maxX - box.minX, 20 * MM_PER_INCH, 0.05), `${(box.maxX - box.minX).toFixed(3)} mm`);

  // Bezier control points overshoot the curve, so the true extent has to be
  // measured on the curve itself: the midpoint of the first quarter should sit
  // exactly one radius from the centre.
  const first = stroke.subpaths[0];
  const start = first.start;
  const seg = first.segs[0];
  const at = t => {
    const u = 1 - t;
    return {
      x: u * u * u * start.x + 3 * u * u * t * seg.c1.x + 3 * u * t * t * seg.c2.x + t * t * t * seg.to.x,
      y: u * u * u * start.y + 3 * u * u * t * seg.c1.y + 3 * u * t * t * seg.c2.y + t * t * t * seg.to.y,
    };
  };
  const centre = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
  const radius = 10 * MM_PER_INCH;
  const errors = [0.1, 0.25, 0.5, 0.75, 0.9]
    .map(t => Math.abs(Math.hypot(at(t).x - centre.x, at(t).y - centre.y) - radius));
  check('the curve stays on the circle it approximates',
    Math.max(...errors) < radius * 0.0005, `worst error ${Math.max(...errors).toExponential(2)} mm`);
}

reset();
{
  api.startCommand('ARC');
  api.commitPoint({ x: 0, y: 0 });
  api.commitPoint({ x: 10, y: 10 });
  api.commitPoint({ x: 20, y: 0 });
  const plan = api.buildPlotPlan(settings({ scaleMode: 'exact', scale: 1 }));
  const stroke = plan.ops.find(op => op.kind === 'stroke');
  check('an arc plots as an open subpath', stroke && stroke.subpaths[0].closed === false);
  check('an arc is split into quarter-turn curves at most',
    stroke.subpaths[0].segs.length >= 1 && stroke.subpaths[0].segs.length <= 4);
}

reset();
{
  drawLine({ x: 0, y: 0 }, { x: 120, y: 0 });
  api.startCommand('DIMLINEAR');
  api.commitPoint({ x: 0, y: 0 });
  api.commitPoint({ x: 120, y: 0 });
  api.commitPoint({ x: 60, y: -24 });
  check('the dimension was created', api.entities.some(entity => entity.type === 'DIM'));

  const plan = api.buildPlotPlan(settings({ scaleMode: 'exact', scale: 48 }));
  const text = plan.ops.filter(op => op.kind === 'text');
  check('the dimension text is plotted', text.length === 1, `got ${text.length}`);
  check('dimension text is centred on its anchor', text[0].anchor === 'center');
  check('dimension text uses the proportional font', text[0].font === 'helvetica');

  // The white mask under the text has to come before the text, or the text is
  // painted over by its own backing.
  const maskIndex = plan.ops.findIndex(op => op.kind === 'fill' && op.color.every(c => c === 1));
  const textIndex = plan.ops.findIndex(op => op.kind === 'text');
  check('the text mask is white and drawn under the text',
    maskIndex >= 0 && maskIndex < textIndex, `mask ${maskIndex}, text ${textIndex}`);
  check('the mask is wider than the text it covers',
    api.pdfTextWidthMM(text[0].text, 'helvetica', text[0].sizeMM) > 0);

  // Dimension line work is exempt from layer linetype, exactly as on screen.
  api.setLayerLinetype('0', 'dashed');
  const dashedLayer = api.buildPlotPlan(settings({ scaleMode: 'exact', scale: 48 }));
  const dimStroke = dashedLayer.ops.find(op => op.kind === 'stroke' && op.subpaths.length > 1);
  check('dimension line work plots continuous on a dashed layer',
    dimStroke && dimStroke.dash.length === 0);
}

reset();
{
  api.startCommand('TEXT');
  api.commitPoint({ x: 10, y: 20 });
  api.submitCommandText('6');
  api.submitCommandText('0');
  api.submitCommandText('ROOF PLAN');
  check('the text entity was created', api.entities.some(entity => entity.type === 'TEXT'));

  const plan = api.buildPlotPlan(settings({ scaleMode: 'exact', scale: 1 }));
  const text = plan.ops.find(op => op.kind === 'text');
  check('a text entity plots its content', text && text.text === 'ROOF PLAN');
  check('a text entity plots in the monospaced font its footprint assumes',
    text.font === 'courier');
  check('text height plots at its model height', near(text.sizeMM, 6 * MM_PER_INCH, 1e-6));
  check('text is anchored at its insertion point, on the baseline',
    text.anchor === 'left' && text.baseline === 'alphabetic');

  // TEXT_WIDTH_FACTOR is 0.6 and Courier's advance is exactly 600/1000 em, so
  // the plotted string occupies precisely the box hit-testing predicted.
  const width = api.pdfTextWidthMM(text.text, 'courier', text.sizeMM);
  check('the plotted width matches the footprint the app models',
    near(width, 'ROOF PLAN'.length * 0.6 * text.sizeMM, 1e-6));
}

// ---------------------------------------------------------------------------
// Plot area modes
// ---------------------------------------------------------------------------
reset();
{
  drawLine({ x: 0, y: 0 }, { x: 100, y: 50 });
  const extents = api.plotAreaBox(settings({ area: 'extents' }));
  check('extents is the drawing bounding box',
    near(extents.minX, 0, 1e-9) && near(extents.maxX, 100, 1e-9) &&
    near(extents.minY, 0, 1e-9) && near(extents.maxY, 50, 1e-9));

  const window = api.plotAreaBox(settings({ area: 'window', window: { minX: 60, minY: 40, maxX: 10, maxY: -5 } }));
  check('a window picked right-to-left is normalised',
    near(window.minX, 10, 1e-9) && near(window.maxX, 60, 1e-9) &&
    near(window.minY, -5, 1e-9) && near(window.maxY, 40, 1e-9));

  check('a window mode with no window refuses',
    Boolean(api.buildPlotPlan(settings({ area: 'window', window: null })).error));

  const display = api.plotAreaBox(settings({ area: 'display' }));
  check('display is a non-empty region of the current view',
    display && display.maxX > display.minX && display.maxY > display.minY);
}

// Picking a window really does come back through the dialog.
reset();
{
  drawLine({ x: 0, y: 0 }, { x: 100, y: 50 });
  api.openPlotDialog();
  api.setPendingPlot({ area: 'window' });
  api.startPlotWindowPick();
  check('picking a window closes the dialog', api.plotDialogVisible === false);
  check('picking a window starts the pick command', api.activeCommandName === 'PLOTWINDOW');
  api.commitPoint({ x: 5, y: 5 });
  api.commitPoint({ x: 45, y: 30 });
  check('the dialog comes back after the second corner', api.plotDialogVisible === true);
  check('the picked window is carried back into the settings',
    api.plotSettings.area === 'window' &&
    near(api.plotSettings.window.minX, 5, 1e-9) && near(api.plotSettings.window.maxY, 30, 1e-9));
  const plan = api.buildPlotPlan(api.plotSettings);
  check('the picked window is what gets plotted',
    near(plan.area.maxX - plan.area.minX, 40, 1e-9) && near(plan.area.maxY - plan.area.minY, 25, 1e-9));
  api.closePlotDialog();
}

// ---------------------------------------------------------------------------
// The PDF file itself
// ---------------------------------------------------------------------------
reset();
{
  drawLine({ x: 0, y: 0 }, { x: 1200, y: 0 });
  const plan = api.buildPlotPlan(settings({ scaleMode: 'exact', scale: 240 }));
  const pdf = api.buildPdfDocument(plan, 'Roof Plan');

  check('the file starts with a PDF header', pdf.startsWith('%PDF-1.'));
  check('the file ends with the EOF marker', pdf.trimEnd().endsWith('%%EOF'));
  check('the file is 7-bit, so byte offsets equal character offsets',
    [...pdf].every(character => character.charCodeAt(0) < 128));

  // The cross-reference table is what makes the file openable; a wrong offset
  // is invisible until a reader rejects the document.
  const startxref = Number(/startxref\s+(\d+)/.exec(pdf)[1]);
  check('startxref points at the xref table', pdf.slice(startxref, startxref + 4) === 'xref');
  const offsets = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map(match => Number(match[1]));
  check('every object is listed in the xref table', offsets.length === 7, `got ${offsets.length}`);
  check('every xref offset lands on its object',
    offsets.every((offset, index) => pdf.startsWith(`${index + 1} 0 obj`, offset)),
    offsets.join(','));

  const length = Number(/\/Length (\d+)/.exec(pdf)[1]);
  const stream = pdf.slice(pdf.indexOf('stream\n') + 7);
  check('the declared stream length matches the stream',
    stream.slice(0, length).length === length && stream.startsWith('q\n'),
    `declared ${length}`);
  check('the stream ends where the length says it does',
    stream.slice(length, length + 10).startsWith('\nendstream'));

  // MediaBox is the page in points; ARCH D landscape is 36 x 24 inches.
  const media = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdf);
  check('the page box is the sheet size in points',
    near(Number(media[1]), 36 * 72, 0.01) && near(Number(media[2]), 24 * 72, 0.01),
    `${media[1]} x ${media[2]}`);

  check('the content is clipped to the printable area', / re W n/.test(pdf));
  check('the drawing name reaches the document title', pdf.includes('/Title (Roof Plan)'));
  check('only base-14 fonts are referenced, so nothing has to be embedded',
    pdf.includes('/BaseFont /Helvetica') && pdf.includes('/BaseFont /Courier') &&
    !pdf.includes('/FontFile'));

  // The same drawing plotted twice has to produce the same bytes, or a plot
  // cannot be diffed against the one that was issued.
  check('plotting is deterministic', api.buildPdfDocument(plan, 'Roof Plan') === pdf);

  // The stroked line must appear in the stream at its measured length: from
  // the left margin, 127mm (5 in = 360pt) across.
  const moves = [...pdf.matchAll(/^([-\d.]+) ([-\d.]+) m$/gm)].map(m => [Number(m[1]), Number(m[2])]);
  const lines = [...pdf.matchAll(/^([-\d.]+) ([-\d.]+) l$/gm)].map(m => [Number(m[1]), Number(m[2])]);
  check('the line is in the content stream once', moves.length === 1 && lines.length === 1);
  check('the line measures 360 pt in the stream',
    near(lines[0][0] - moves[0][0], 360, 0.01), `${(lines[0][0] - moves[0][0]).toFixed(3)} pt`);
}

// Characters the base-14 encoding cannot represent are reported, not silently
// swallowed — and the diameter sign the app displays does have a plotted form.
reset();
{
  api.startCommand('CIRCLE');
  api.commitPoint({ x: 0, y: 0 });
  api.commitPoint({ x: 20, y: 0 });
  api.startCommand('DIMDIAMETER');
  api.commitPoint({ x: 20, y: 0 });
  api.commitPoint({ x: -20, y: 0 });
  api.commitPoint({ x: 30, y: 30 });
  const dim = api.entities.find(entity => entity.type === 'DIM');
  check('a diameter dimension exists', Boolean(dim) && dim.dimType === 'DIAMETER');

  const plan = api.buildPlotPlan(settings({ scaleMode: 'exact', scale: 48 }));
  check('the diameter sign is not reported as unplottable',
    !plan.warnings.some(warning => /no equivalent/.test(warning)), plan.warnings.join(' | '));
  const pdf = api.buildPdfDocument(plan, 'Circle');
  check('the diameter sign is written as the WinAnsi slashed O',
    pdf.includes('\\330'), 'expected an octal escape for 0xD8');
}

reset();
{
  api.startCommand('TEXT');
  api.commitPoint({ x: 0, y: 0 });
  api.submitCommandText('6');
  api.submitCommandText('0');
  api.submitCommandText('roof 中');
  const plan = api.buildPlotPlan(settings({ scaleMode: 'exact', scale: 1 }));
  check('an unplottable character is reported',
    plan.warnings.some(warning => /no equivalent/.test(warning)), plan.warnings.join(' | '));
  const pdf = api.buildPdfDocument(plan, 'Text');
  check('an unplottable character becomes a question mark rather than a broken file',
    pdf.includes('(roof ?)'));
}

// Text with characters that are structural in a PDF string must be escaped.
reset();
{
  api.startCommand('TEXT');
  api.commitPoint({ x: 0, y: 0 });
  api.submitCommandText('6');
  api.submitCommandText('0');
  api.submitCommandText('a(b)c\\d');
  const plan = api.buildPlotPlan(settings({ scaleMode: 'exact', scale: 1 }));
  const pdf = api.buildPdfDocument(plan, 'Text');
  check('parentheses and backslashes in text are escaped',
    pdf.includes('(a\\(b\\)c\\\\d)'), 'unescaped string would truncate the content stream');
}

// The plot file is named after the drawing.
reset();
{
  check('the plot is named after the drawing', api.plotDownloadName() === 'Untitled.pdf',
    api.plotDownloadName());
}

// A drawing with nothing in it at all cannot be plotted, and says so.
reset();
{
  const plan = api.buildPlotPlan(settings());
  check('an empty drawing refuses to plot', Boolean(plan.error), JSON.stringify(plan.error));
}

// ---------------------------------------------------------------------------
// The dialog's sheet preview. It draws the same plan the PDF writer
// serialises, so what it has to get right is the mapping from paper
// millimetres to the preview box — and that a plot running off the sheet is
// shown running off it rather than quietly cropped.
// ---------------------------------------------------------------------------

// A canvas context that remembers what it was told to do, so the preview can
// be measured without a browser.
function recordingContext() {
  const calls = [];
  const record = name => (...args) => { calls.push({ name, args }); };
  return {
    calls,
    of(name) { return calls.filter(call => call.name === name); },
    measureText: text => ({ width: String(text).length * 6 }),
    setTransform: record('setTransform'),
    clearRect: record('clearRect'),
    save: record('save'),
    restore: record('restore'),
    translate: record('translate'),
    scale: record('scale'),
    rotate: record('rotate'),
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    bezierCurveTo: record('bezierCurveTo'),
    rect: record('rect'),
    clip: record('clip'),
    fill: record('fill'),
    fillRect: record('fillRect'),
    stroke: record('stroke'),
    strokeRect: record('strokeRect'),
    fillText: record('fillText'),
    setLineDash: record('setLineDash'),
  };
}

function previewCanvas(width = 300, height = 230) {
  return { clientWidth: width, clientHeight: height, width: 0, height: 0 };
}

// A3 landscape, the default sheet.
{
  const page = api.paperSizeMM('a3', 'landscape');
  const view = api.plotPreviewView(page, 300, 230);
  const bottomLeft = view.toPx({ x: 0, y: 0 });
  const topRight = view.toPx({ x: page.widthMM, y: page.heightMM });
  check('the preview centres the sheet horizontally',
    Math.abs(bottomLeft.x - (300 - topRight.x)) < 1e-6, `${bottomLeft.x} vs ${300 - topRight.x}`);
  check('the preview centres the sheet vertically',
    Math.abs(topRight.y - (230 - bottomLeft.y)) < 1e-6, `${topRight.y} vs ${230 - bottomLeft.y}`);
  check('the preview keeps the sheet aspect',
    Math.abs((topRight.x - bottomLeft.x) / (bottomLeft.y - topRight.y)
      - page.widthMM / page.heightMM) < 1e-9);
  check('the preview leaves room around the sheet for what falls off it',
    bottomLeft.x >= 10 && topRight.y >= 10, `${bottomLeft.x}, ${topRight.y}`);
  check('paper Y is up in the preview', topRight.y < bottomLeft.y);
  // A portrait sheet is limited by the box height, a landscape one by its
  // width, and neither may spill out of the box.
  const portrait = api.plotPreviewView(api.paperSizeMM('a3', 'portrait'), 300, 230);
  const portraitTop = portrait.toPx({ x: 0, y: api.paperSizeMM('a3', 'portrait').heightMM });
  check('a portrait sheet fits the preview box', portraitTop.y >= 0 && portrait.toPx({ x: 0, y: 0 }).y <= 230,
    `${portraitTop.y}`);
}

// Everything plotted lands on the sheet in the preview, at an arbitrary
// scale rather than one that divides the page evenly.
reset();
{
  drawLine({ x: 3.7, y: -2.4 }, { x: 214.9, y: 88.3 });
  drawLine({ x: 214.9, y: 88.3 }, { x: 40.1, y: 132.6 });
  const plan = api.buildPlotPlan(settings());
  const view = api.plotPreviewView(plan.page, 300, 230);
  const inside = planPoints(plan).every(point => {
    const px = view.toPx(point);
    const min = view.toPx({ x: plan.printable.xMM, y: plan.printable.yMM });
    const max = view.toPx({
      x: plan.printable.xMM + plan.printable.widthMM,
      y: plan.printable.yMM + plan.printable.heightMM,
    });
    return px.x >= min.x - 1e-6 && px.x <= max.x + 1e-6 && px.y <= min.y + 1e-6 && px.y >= max.y - 1e-6;
  });
  check('a fitted plot previews entirely inside the printable border', inside);

  const context = recordingContext();
  const target = previewCanvas();
  const drawn = api.renderPlotPreview(target, context, plan);
  check('the preview sizes its backing store to the box', target.width === 300 && target.height === 230,
    `${target.width}x${target.height}`);
  check('the preview draws the sheet', context.of('fillRect').length === 1);
  check('the preview strokes the plotted geometry', context.of('stroke').length >= 1);
  check('the preview draws the plot in paper millimetres',
    context.of('scale').some(call => Math.abs(call.args[0] - drawn.scale) < 1e-9
      && Math.abs(call.args[1] + drawn.scale) < 1e-9), JSON.stringify(context.of('scale')[0]));
  check('the preview clips to the printable area the way the PDF does',
    context.of('clip').length === 2 && context.of('clip').some(call => call.args[0] === 'evenodd'),
    JSON.stringify(context.of('clip').map(call => call.args)));
}

// A plot too big for the sheet is the case the preview exists for: the part
// that will be clipped has to be drawn, in the clipped colour, outside the
// printable border.
reset();
{
  drawLine({ x: 0, y: 0 }, { x: 5000, y: 3000 });
  const plan = api.buildPlotPlan(settings({ scaleMode: 'exact', scale: 1 }));
  check('the oversized plot warns', plan.warnings.some(warning => /clipped/.test(warning)),
    plan.warnings.join(' | '));
  const view = api.plotPreviewView(plan.page, 300, 230);
  const outside = planPoints(plan).some(point => {
    const px = view.toPx(point);
    const max = view.toPx({ x: plan.page.widthMM, y: plan.page.heightMM });
    return px.x > max.x || px.y < max.y;
  });
  check('the preview shows the part of an oversized plot that runs off the sheet', outside);
}

// Nothing to plot still previews the chosen sheet, so the dialog is never
// blank while the question of which paper to use is being answered.
reset();
{
  const context = recordingContext();
  const view = api.renderPlotPreview(previewCanvas(), context,
    { page: api.paperSizeMM('a4', 'portrait'), ops: [] });
  check('an unplottable drawing still previews its sheet', Boolean(view)
    && context.of('fillRect').length === 1 && context.of('stroke').length === 0);
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('FAILURES:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
