import zlib from 'node:zlib';
import { boot, DEFAULT_BUNDLE } from './harness.mjs';

const BUNDLE = process.argv[2] || DEFAULT_BUNDLE;

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) { passed++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
function near(a, b, tolerance = 1e-6) {
  return Math.abs(a - b) <= tolerance;
}

const { api } = boot(BUNDLE);

const MM_PER_POINT = 25.4 / 72;

// ---------------------------------------------------------------------------
// A PDF, assembled by hand. `bodies[n]` is object n+1: a string for a plain
// object, or { dict, data } for a stream. The cross-reference table is written
// properly even though the reader never consults one, so the same bytes are a
// file any other reader would open.
// ---------------------------------------------------------------------------
function latin1(text) {
  return Buffer.from(text, 'latin1');
}

function streamBody(dict, data) {
  const bytes = typeof data === 'string' ? latin1(data) : data;
  return Buffer.concat([latin1(`<< ${dict} /Length ${bytes.length} >>\nstream\n`), bytes, latin1('\nendstream')]);
}

function assemble(bodies, trailerExtra = '', root = 1) {
  const parts = [latin1('%PDF-1.7\n')];
  const offsets = [];
  let size = parts[0].length;
  bodies.forEach((body, index) => {
    const bytes = Buffer.isBuffer(body) ? body : latin1(body);
    const chunk = Buffer.concat([latin1(`${index + 1} 0 obj\n`), bytes, latin1('\nendobj\n')]);
    offsets.push(size);
    size += chunk.length;
    parts.push(chunk);
  });
  let tail = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) tail += `${String(offset).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<< /Size ${bodies.length + 1} /Root ${root} 0 R ${trailerExtra}>>\nstartxref\n${size}\n%%EOF\n`;
  parts.push(latin1(tail));
  return new Uint8Array(Buffer.concat(parts));
}

// The common case: one page, one content stream, optional resources.
function onePage(content, options = {}) {
  const box = options.mediaBox || '[0 0 400 300]';
  const page = `<< /Type /Page /Parent 2 0 R /MediaBox ${box} ${options.pageExtra || ''} `
    + `/Resources << ${options.resources || ''} >> /Contents 4 0 R >>`;
  const stream = options.deflate
    ? streamBody('/Filter /FlateDecode', zlib.deflateSync(latin1(content)))
    : streamBody('', content);
  return assemble([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    page,
    stream,
    ...(options.extra || []),
  ], options.trailerExtra || '');
}

function readPage(bytes, index = 0) {
  const opened = api.openPdf(bytes);
  if (opened.error) return { error: opened.error };
  return { doc: opened.doc, plan: api.readPdfPage(opened.doc, index) };
}

function kinds(plan, kind) {
  return plan.ops.filter(op => op.kind === kind);
}

function allSubpaths(plan) {
  return kinds(plan, 'stroke').flatMap(op => op.subpaths);
}

const pt = value => value * MM_PER_POINT;

// --- Inflate agrees with zlib ------------------------------------------------
{
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
  let agreed = true;
  for (let round = 0; round < 60; round++) {
    const length = Math.floor(random() * (round % 6 === 0 ? 120000 : 4000));
    const source = Buffer.alloc(length);
    for (let index = 0; index < length; index++) {
      source[index] = round % 3 === 0 ? Math.floor(random() * 256)
        : round % 3 === 1 ? '0123456789 .-lmcS\n'.charCodeAt(Math.floor(random() * 18))
          : 65 + (index % 3);
    }
    for (const level of [0, 1, 9]) {
      const viaZlib = new Uint8Array(zlib.deflateSync(source, { level }));
      const viaRaw = new Uint8Array(zlib.deflateRawSync(source, { level }));
      if (!same(api.inflateBytes(viaZlib), source) || !same(api.inflateBytes(viaRaw), source)) agreed = false;
    }
  }
  check('inflate reproduces what zlib compressed, wrapped or raw, at every level', agreed);

  const fixed = Buffer.from('10 20 m 30 40 l S\n'.repeat(200));
  const packed = new Uint8Array(zlib.deflateSync(fixed, { strategy: zlib.constants.Z_FIXED }));
  check('inflate reads fixed-Huffman blocks', same(api.inflateBytes(packed), fixed));

  const long = Buffer.from('1 0 0 1 0 0 cm 0 0 m 100 100 l S\n'.repeat(3000));
  const cut = new Uint8Array(zlib.deflateSync(long)).subarray(0, 200);
  const partial = api.inflateBytes(cut);
  check('a truncated stream gives back what it held',
    partial.length > 0 && same(partial, long.subarray(0, partial.length)), `${partial.length} bytes`);
}

// --- The other filters --------------------------------------------------------
{
  // The LZW example from the PDF specification itself.
  const lzw = api.pdfLzwDecode(Uint8Array.from([0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01]));
  check('LZW decodes the specification example',
    Buffer.from(lzw).toString('latin1') === '-----A---B', Buffer.from(lzw).toString('latin1'));

  const runLength = api.pdfRunLengthDecode(Uint8Array.from([2, 65, 66, 67, 254, 68, 128, 99]));
  check('RunLength expands literal and repeated runs and stops at the end marker',
    Buffer.from(runLength).toString('latin1') === 'ABCDDD');

  const ascii85 = api.pdfAscii85Decode(latin1('87cURD]i,"Ebo80~>'));
  check('ASCII85 decodes, including a short final group',
    Buffer.from(ascii85).toString('latin1') === 'Hello World!', Buffer.from(ascii85).toString('latin1'));
}

// --- A drawing plotted to PDF reads back as the plan it was plotted from -----
{
  await api.newDrawing(true);
  const line = (a, b) => { api.startCommand('LINE'); api.commitPoint(a); api.commitPoint(b); api.finishCurrent(); };
  line({ x: 0, y: 0 }, { x: 120, y: 0 });
  line({ x: 120, y: 0 }, { x: 120, y: 80 });
  api.startCommand('CIRCLE');
  api.commitPoint({ x: 60, y: 40 });
  api.commitPoint({ x: 80, y: 40 });
  api.startCommand('TEXT');
  api.commitPoint({ x: 10, y: 60 });
  api.submitCommandText('5');
  api.submitCommandText('0');
  api.submitCommandText('ROOF PLAN');
  api.finishCurrent();

  const settings = { ...api.defaultPlotSettings(), paperSizeId: 'ansi-b', scaleMode: 'fit' };
  const plan = api.buildPlotPlan(settings);
  const text = api.buildPdfDocument(plan, 'round trip');
  const { plan: back, error } = readPage(new Uint8Array(latin1(text)));
  check('zbCAD\'s own plot opens', !error, error);

  check('the page comes back the size of the sheet',
    near(back.page.widthMM, plan.page.widthMM, 1e-3) && near(back.page.heightMM, plan.page.heightMM, 1e-3),
    `${back.page.widthMM} x ${back.page.heightMM}`);

  const wrote = plan.ops.filter(op => op.kind === 'stroke').flatMap(op => op.subpaths);
  const read = allSubpaths(back);
  check('every stroked subpath comes back', read.length === wrote.length, `${read.length} of ${wrote.length}`);
  let worst = 0;
  let sameShape = read.length === wrote.length;
  for (let index = 0; sameShape && index < wrote.length; index++) {
    const a = wrote[index];
    const b = read[index];
    if (a.segs.length !== b.segs.length || Boolean(a.closed) !== Boolean(b.closed)) { sameShape = false; break; }
    worst = Math.max(worst, Math.abs(a.start.x - b.start.x), Math.abs(a.start.y - b.start.y));
    a.segs.forEach((segment, at) => {
      const other = b.segs[at];
      if (segment.type !== other.type) sameShape = false;
      worst = Math.max(worst, Math.abs(segment.to.x - other.to.x), Math.abs(segment.to.y - other.to.y));
      if (segment.type === 'c' && other.type === 'c') {
        worst = Math.max(worst, Math.abs(segment.c1.x - other.c1.x), Math.abs(segment.c2.y - other.c2.y));
      }
    });
  }
  check('with the same segments, curves as curves', sameShape);
  // The writer keeps four decimals of a point, which is 0.00004 mm.
  check('to within the writer\'s own rounding', worst < 1e-4, `${worst} mm`);

  const wroteText = plan.ops.find(op => op.kind === 'text');
  const readText = kinds(back, 'text')[0];
  check('text comes back as text', readText && readText.text === 'ROOF PLAN', readText && readText.text);
  check('at the same place, size and angle', readText
    && near(readText.x, wroteText.x, 1e-3) && near(readText.y, wroteText.y, 1e-3)
    && near(readText.sizeMM, wroteText.sizeMM, 1e-3) && near(readText.angle, wroteText.angle, 1e-6));
  check('in the monospaced stand-in it was written in', readText && readText.font === 'courier');
  check('and as wide as the writer\'s metrics say it is',
    readText && near(readText.widthMM, api.pdfTextWidthMM('ROOF PLAN', 'courier', wroteText.sizeMM), 1e-3));

  // And once more round: what was read writes out to the same operators.
  const again = readPage(new Uint8Array(latin1(api.buildPdfDocument({ ...plan, ops: back.ops }, 'again')))).plan;
  check('a plan read from a PDF writes a PDF that reads the same',
    allSubpaths(again).length === read.length && kinds(again, 'text')[0]?.text === 'ROOF PLAN');
}

// --- What falls outside the plot window was clipped, and stays clipped --------
{
  await api.newDrawing(true);
  api.startCommand('LINE');
  api.commitPoint({ x: -50, y: 5 });
  api.commitPoint({ x: 50, y: 5 });
  api.finishCurrent();
  api.startCommand('LINE');
  api.commitPoint({ x: -50, y: 500 });
  api.commitPoint({ x: 50, y: 500 });
  api.finishCurrent();
  const settings = {
    ...api.defaultPlotSettings(), paperSizeId: 'ansi-b', scaleMode: 'exact', scale: 1, area: 'window',
    window: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, center: false,
  };
  const plan = api.buildPlotPlan(settings);
  const back = readPage(new Uint8Array(latin1(api.buildPdfDocument(plan)))).plan;
  const subpaths = allSubpaths(back);
  check('a line wholly outside the clip is not read at all', subpaths.length === 1, `${subpaths.length}`);
  const only = subpaths[0];
  // A hundred inches of line, of which the ten inside the window survive.
  check('a line across the clip edges is cut at them',
    near(only.start.x, plan.clipMM.xMM, 1e-3) && near(only.segs[0].to.x - only.start.x, 254, 1e-3),
    `${only.start.x} -> ${only.segs[0].to.x}, clip at ${plan.clipMM.xMM}`);
}

// --- File structure: compressed objects, no table, lengths that come later ---
{
  // Everything a modern writer does at once: the catalog, page tree and page
  // live inside a compressed object stream, the content stream's /Length is a
  // reference to an object that follows it, and there is no classic xref
  // table or trailer — only an (unread) cross-reference stream's dictionary.
  const inner = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 200 100] >>',
    '<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 5 0 R >>',
  ];
  let header = '';
  let body = '';
  inner.forEach((text, index) => { header += `${index + 1} ${body.length} `; body += `${text} `; });
  const objStm = zlib.deflateSync(latin1(header + body));
  const content = zlib.deflateSync(latin1('10 10 m 190 90 l S'));
  const bytes = new Uint8Array(Buffer.concat([
    latin1('%PDF-1.5\n'),
    latin1(`4 0 obj\n<< /Type /ObjStm /N 3 /First ${header.length} /Filter /FlateDecode /Length ${objStm.length} >>\nstream\n`),
    objStm, latin1('\nendstream\nendobj\n'),
    latin1('5 0 obj\n<< /Filter /FlateDecode /Length 6 0 R >>\nstream\n'), content, latin1('\nendstream\nendobj\n'),
    latin1(`6 0 obj\n${content.length}\nendobj\n`),
    latin1('7 0 obj\n<< /Type /XRef /Size 8 /Root 1 0 R /W [1 2 1] /Length 0 >>\nstream\n\nendstream\nendobj\n'),
    latin1('startxref\n0\n%%EOF\n'),
  ]));
  const { plan, error } = readPage(bytes);
  check('a file with object streams and no xref table opens', !error, error);
  const subpaths = plan ? allSubpaths(plan) : [];
  check('its page size is inherited from the page tree',
    plan && near(plan.page.widthMM, pt(200), 1e-6) && near(plan.page.heightMM, pt(100), 1e-6));
  check('and its compressed content is read through a forward-referenced length',
    subpaths.length === 1 && near(subpaths[0].start.x, pt(10), 1e-6) && near(subpaths[0].segs[0].to.y, pt(90), 1e-6));
}

// --- An appended revision replaces what it redefines --------------------------
{
  const original = onePage('0 0 m 100 0 l S');
  const revised = Buffer.concat([
    Buffer.from(original),
    latin1('4 0 obj\n<< /Length 16 >>\nstream\n0 0 m 0 100 l S\nendstream\nendobj\n'),
    latin1('xref\n4 1\n0000000000 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R /Prev 0 >>\nstartxref\n0\n%%EOF\n'),
  ]);
  const plan = readPage(new Uint8Array(revised)).plan;
  const to = allSubpaths(plan)[0].segs[0].to;
  check('the later definition of an object wins', near(to.x, 0, 1e-6) && near(to.y, pt(100), 1e-6), JSON.stringify(to));
}

// --- Rotation and crop ---------------------------------------------------------
{
  // A landscape drawing saved as a portrait page turned a quarter turn.
  const turned = readPage(onePage('0 0 m 200 0 l S', { mediaBox: '[0 0 200 100]', pageExtra: '/Rotate 90' })).plan;
  check('a rotated page is as wide as it is displayed',
    near(turned.page.widthMM, pt(100), 1e-6) && near(turned.page.heightMM, pt(200), 1e-6));
  const edge = allSubpaths(turned)[0];
  check('and its content turns clockwise with it',
    near(edge.start.x, 0, 1e-6) && near(edge.start.y, pt(200), 1e-6)
    && near(edge.segs[0].to.x, 0, 1e-6) && near(edge.segs[0].to.y, 0, 1e-6),
    JSON.stringify(edge));

  const cropped = readPage(onePage('100 100 m 150 120 l S 0 0 m 50 50 l S',
    { mediaBox: '[0 0 300 300]', pageExtra: '/CropBox [100 100 300 300]' })).plan;
  check('the crop box is the page', near(cropped.page.widthMM, pt(200), 1e-6));
  const kept = allSubpaths(cropped);
  check('measured from its own corner, with what lies outside it dropped',
    kept.length === 1 && near(kept[0].start.x, 0, 1e-6) && near(kept[0].segs[0].to.x, pt(50), 1e-6));

  const scaled = readPage(onePage('0 0 m 72 0 l S', { pageExtra: '/UserUnit 2' })).plan;
  check('UserUnit scales the whole page', near(allSubpaths(scaled)[0].segs[0].to.x, 50.8, 1e-6));
}

// --- Refusals ------------------------------------------------------------------
{
  check('something that is not a PDF is refused', Boolean(api.openPdf(new Uint8Array(latin1('just some text, not a pdf at all'))).error));
  const locked = api.openPdf(onePage('0 0 m 1 1 l S', { trailerExtra: '/Encrypt 9 0 R ' }));
  check('an encrypted PDF is refused with a reason', /encrypted/i.test(locked.error || ''), locked.error);
  const empty = api.openPdf(new Uint8Array(latin1('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer << /Root 1 0 R >>')));
  check('a PDF with no pages is refused', Boolean(empty.error));
}

// --- The graphics state --------------------------------------------------------
{
  const content = [
    '2 w 1 0 0 RG [6 3] 0 d',
    'q 2 0 0 2 10 20 cm 0 0 m 50 0 l S Q',     // scaled and shifted, then restored
    '0 0 m 50 0 l S',                          // same style, back in page space
    '0 0 1 rg 100 100 40 20 re f',             // a plain rectangle
    '0 0 0 1 k 200 100 60 60 re 210 110 40 40 re f*',   // a frame, by the even-odd rule
    '0.5 g 0 0 m 10 0 20 10 20 20 c 30 30 40 40 v 50 50 60 60 y h f',
  ].join('\n');
  const plan = readPage(onePage(content, { deflate: true })).plan;
  const strokes = kinds(plan, 'stroke');
  check('a scaled stroke carries a scaled width and dash',
    near(strokes[0].widthMM, pt(4), 1e-6) && near(strokes[0].dash[0], pt(12), 1e-6));
  check('at transformed coordinates',
    near(strokes[0].subpaths[0].start.x, pt(10), 1e-6) && near(strokes[0].subpaths[0].segs[0].to.x, pt(110), 1e-6)
    && near(strokes[0].subpaths[0].start.y, pt(20), 1e-6));
  check('Q restores the matrix, so the next stroke is a different width and a separate op',
    strokes.length === 2 && near(strokes[1].widthMM, pt(2), 1e-6) && near(strokes[1].subpaths[0].segs[0].to.x, pt(50), 1e-6));
  check('stroke colour is RGB as written', strokes[0].color.join() === '1,0,0');

  const fills = kinds(plan, 'fill');
  check('a rectangle fills as a four-point polygon',
    fills[0].points && fills[0].points.length === 4 && fills[0].color.join() === '0,0,1'
    && near(fills[0].points[2].x, pt(140), 1e-6) && near(fills[0].points[2].y, pt(120), 1e-6));
  check('nested rectangles under f* keep both contours and the rule',
    fills[1].subpaths && fills[1].subpaths.length === 2 && fills[1].evenOdd === true);
  check('CMYK black is black', fills[1].color.every(level => near(level, 0, 1e-9)));
  const curved = fills[2];
  check('c, v and y all arrive as cubic curves',
    curved.subpaths && curved.subpaths[0].segs.length === 3 && curved.subpaths[0].segs.every(segment => segment.type === 'c'));
  const [first, second, third] = curved.subpaths[0].segs;
  check('v takes its first control point from the current point',
    near(second.c1.x, first.to.x, 1e-9) && near(second.c1.y, first.to.y, 1e-9));
  check('y takes its second control point from the end point',
    near(third.c2.x, third.to.x, 1e-9) && near(third.c2.y, third.to.y, 1e-9));
  check('grey is grey', near(curved.color[0], 0.5, 1e-9) && near(curved.color[2], 0.5, 1e-9));
}

// --- Runs of same-style lines become one stroke --------------------------------
{
  let content = '0.5 w ';
  for (let index = 0; index < 500; index++) content += `${index} 0 m ${index} 50 l S `;
  content += '1 0 0 RG 0 0 m 5 5 l S';
  const plan = readPage(onePage(content)).plan;
  const strokes = kinds(plan, 'stroke');
  // The page is 400 points wide, so the lines at x = 0 to 400 are on it.
  check('five hundred separate lines in one pen are a single op', strokes.length === 2 && strokes[0].subpaths.length === 401,
    `${strokes.length} ops, ${strokes[0].subpaths.length} subpaths`);
  check('and the ones off the page were dropped', strokes[0].subpaths.every(subpath => subpath.start.x <= pt(400) + 1e-9));
}

// --- Clipping ------------------------------------------------------------------
{
  const content = [
    'q 0 0 50 50 re W n',
    '10 10 m 100 10 l S',          // crosses the clip's right edge
    '200 200 m 300 300 l S',       // nowhere near it
    '0 1 0 rg 40 40 30 30 re f',   // a fill half in, half out
    'Q 200 200 m 300 300 l S',     // and after the restore it is visible again
  ].join('\n');
  const plan = readPage(onePage(content)).plan;
  const subpaths = allSubpaths(plan);
  check('a clip rectangle cuts a line at its edge',
    subpaths.length === 2 && near(subpaths[0].segs[0].to.x, pt(50), 1e-6), `${subpaths.length}`);
  const fill = kinds(plan, 'fill')[0];
  const xs = (fill.points || fill.subpaths[0].segs.map(segment => segment.to).concat(fill.subpaths[0].start)).map(point => point.x);
  check('and trims a fill to itself', near(Math.max(...xs), pt(50), 1e-6) && near(Math.min(...xs), pt(40), 1e-6));
  check('the clip ends with the Q that closes it', near(subpaths[1].start.x, pt(200), 1e-6));
}

// --- Form XObjects -------------------------------------------------------------
{
  const form = streamBody('/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Matrix [3 0 0 3 100 50]', '0 0 m 10 10 l S 0 0 m 50 0 l S');
  const plan = readPage(onePage('/Fm1 Do 0 0 m 5 5 l S', { resources: '/XObject << /Fm1 5 0 R >>', extra: [form] })).plan;
  const subpaths = allSubpaths(plan);
  check('a form is drawn through its own matrix',
    near(subpaths[0].start.x, pt(100), 1e-6) && near(subpaths[0].segs[0].to.x, pt(130), 1e-6) && near(subpaths[0].segs[0].to.y, pt(80), 1e-6));
  check('clipped to its own bounding box', near(subpaths[1].segs[0].to.x, pt(130), 1e-6), JSON.stringify(subpaths[1]));
  check('and leaves the page\'s state as it found it', near(subpaths[2].segs[0].to.x, pt(5), 1e-6));
}

// --- Text ----------------------------------------------------------------------
{
  const helvetica = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  const plain = readPage(onePage('BT /F1 12 Tf 100 200 Td (Hello) Tj ET',
    { resources: '/Font << /F1 5 0 R >>', extra: [helvetica] })).plan;
  const hello = kinds(plain, 'text')[0];
  check('a shown string is a text op', hello && hello.text === 'Hello');
  check('placed at the text matrix', near(hello.x, pt(100), 1e-6) && near(hello.y, pt(200), 1e-6));
  check('sized by the font size', near(hello.sizeMM, pt(12), 1e-6));
  check('and as wide as Helvetica makes it', near(hello.widthMM, api.pdfTextWidthMM('Hello', 'helvetica', pt(12)), 1e-6));

  // Rotated a quarter turn by the text matrix, on a page whose axes are scaled.
  const turned = readPage(onePage('2 0 0 2 0 0 cm BT /F1 10 Tf 0 1 -1 0 50 60 Tm (UP) Tj ET',
    { resources: '/Font << /F1 5 0 R >>', extra: [helvetica] })).plan;
  const up = kinds(turned, 'text')[0];
  check('the text matrix and the page matrix both apply',
    near(up.angle, Math.PI / 2, 1e-9) && near(up.sizeMM, pt(20), 1e-6) && near(up.x, pt(100), 1e-6) && near(up.y, pt(120), 1e-6));

  // One operator, three table cells: the gaps are kerning numbers.
  const row = readPage(onePage('BT /F1 10 Tf 20 100 Td [(REV) -4000 (DATE) -4000 (BY)] TJ ET',
    { resources: '/Font << /F1 5 0 R >>', extra: [helvetica] })).plan;
  const cells = kinds(row, 'text');
  check('a row written as one operator is cut at its column gaps',
    cells.length === 3 && cells.map(cell => cell.text).join('|') === 'REV|DATE|BY', cells.map(cell => cell.text).join('|'));
  const revWidth = api.pdfTextWidthMM('REV', 'helvetica', pt(10));
  check('with each cell where its own column starts', near(cells[1].x, pt(20) + revWidth + pt(40), 1e-6), `${cells[1].x}`);

  // Ordinary kerning and a word-sized gap stay one string.
  const kerned = readPage(onePage('BT /F1 10 Tf 20 100 Td [(A) 80 (V) -300 (B)] TJ ET',
    { resources: '/Font << /F1 5 0 R >>', extra: [helvetica] })).plan;
  check('kerning does not split a word, and a word gap becomes a space',
    kinds(kerned, 'text').length === 1 && kinds(kerned, 'text')[0].text === 'AV B', kinds(kerned, 'text').map(op => op.text).join('|'));

  // Letter-at-a-time placement, the way printer drivers write a line.
  const stepWidth = 0.556 * 10;
  const typed = readPage(onePage(`BT /F1 10 Tf 20 100 Td (1) Tj ${stepWidth} 0 Td (2) Tj ${stepWidth} 0 Td (3) Tj ET`,
    { resources: '/Font << /F1 5 0 R >>', extra: [helvetica] })).plan;
  check('runs that follow one another on a baseline are stored as one', kinds(typed, 'text').length === 1 && kinds(typed, 'text')[0].text === '123',
    kinds(typed, 'text').map(op => op.text).join('|'));

  const hidden = readPage(onePage('BT /F1 10 Tf 3 Tr 20 100 Td (OCR LAYER) Tj ET',
    { resources: '/Font << /F1 5 0 R >>', extra: [helvetica] })).plan;
  check('invisible text puts nothing on the page', kinds(hidden, 'text').length === 0);

  // A subset font addressed by glyph number, readable only through /ToUnicode.
  const cmap = streamBody('', '/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n'
    + '1 begincodespacerange <0000> <FFFF> endcodespacerange\n'
    + '2 beginbfchar <0003> <0052> <0004> <00D8> endbfchar\n'
    + '1 beginbfrange <0010> <0012> <0031> endbfrange\nendcmap end end');
  const composite = '<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Arial /Encoding /Identity-H '
    + '/DescendantFonts [7 0 R] /ToUnicode 6 0 R >>';
  const descendant = '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+Arial /DW 500 /W [3 [700] 16 18 600] >>';
  const mapped = readPage(onePage('BT /F1 10 Tf 20 100 Td <00030004001000110012> Tj ET',
    { resources: '/Font << /F1 5 0 R >>', extra: [composite, cmap, descendant] })).plan;
  const decoded = kinds(mapped, 'text')[0];
  check('two-byte codes are decoded through the ToUnicode map', decoded && decoded.text === 'RØ123', decoded && decoded.text);
  check('and measured with the descendant font\'s widths',
    decoded && near(decoded.widthMM, pt((700 + 500 + 600 * 3) / 1000 * 10), 1e-6), decoded && String(decoded.widthMM));

  const noMap = '<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Arial /Encoding /Identity-H /DescendantFonts [6 0 R] >>';
  const blind = readPage(onePage('BT /F1 10 Tf 20 100 Td <00030004> Tj ET',
    { resources: '/Font << /F1 5 0 R >>', extra: [noMap, descendant.replace('7', '6')] })).plan;
  check('a font with no way back to characters is reported, not guessed',
    kinds(blind, 'text').length === 0 && blind.skipped.text === 1);

  const custom = '<< /Type /Font /Subtype /TrueType /BaseFont /Arial /FirstChar 65 /LastChar 67 /Widths [600 600 600] '
    + '/Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [65 /degree /plusminus /Oslash] >> >>';
  const symbols = readPage(onePage('BT /F1 10 Tf 20 100 Td (ABC) Tj ET',
    { resources: '/Font << /F1 5 0 R >>', extra: [custom] })).plan;
  check('an encoding\'s differences are read by glyph name', kinds(symbols, 'text')[0].text === '°±Ø', kinds(symbols, 'text')[0].text);
  check('glyph names cover accents and code points',
    api.pdfGlyphNameToText('Eacute') === 'É' && api.pdfGlyphNameToText('uni2300') === '⌀' && api.pdfGlyphNameToText('g123') === '');
}

// --- Layers switched off in the file stay off ----------------------------------
{
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R 6 0 R] /D << /OFF [6 0 R] >> >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Properties << /On 5 0 R /Off 6 0 R >> >> /Contents 4 0 R >>',
    streamBody('', '/OC /On BDC 0 0 m 10 0 l S EMC /OC /Off BDC 0 0 m 20 0 l S EMC 0 0 m 30 0 l S'),
    '<< /Type /OCG /Name (Walls) >>',
    '<< /Type /OCG /Name (Demo) >>',
  ];
  const plan = readPage(assemble(bodies)).plan;
  const ends = allSubpaths(plan).map(subpath => Math.round(subpath.segs[0].to.x / MM_PER_POINT));
  check('content on a layer the file turns off is left out', ends.join() === '10,30', ends.join());
}

// --- Inline images are stepped over; image XObjects are located ----------------
{
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x60, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
  const image = streamBody('/Type /XObject /Subtype /Image /Width 96 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode', jpeg);
  const inline = Buffer.concat([
    latin1('0 0 m 10 0 l S\nBI /W 2 /H 2 /CS /G /BPC 8 ID '), Buffer.from([0x45, 0x49, 0x00, 0xff]), latin1(' EI\n0 0 m 20 0 l S\n'),
    latin1('q 200 0 0 100 50 60 cm /Im1 Do Q'),
  ]);
  const { doc, plan } = readPage(onePage(inline, { resources: '/XObject << /Im1 5 0 R >>', extra: [image] }));
  check('the operators after an inline image are still read',
    allSubpaths(plan).length === 2 && plan.skipped.inlineImages === 1, `${allSubpaths(plan).length} ${plan.skipped.inlineImages}`);
  const placed = kinds(plan, 'image')[0];
  check('an image is located by its corner and edges',
    placed && near(placed.origin.x, pt(50), 1e-6) && near(placed.edgeX.x, pt(200), 1e-6) && near(placed.edgeY.y, pt(100), 1e-6));
  const url = api.pdfImageDataUrl(doc, placed);
  check('a JPEG comes out as the bytes that went in', url === `data:image/jpeg;base64,${jpeg.toString('base64')}`, url);

  // A page that is only that picture is a scan.
  const scanBytes = onePage('q 400 0 0 300 0 0 cm /Im1 Do Q', { resources: '/XObject << /Im1 5 0 R >>', extra: [image] });
  const scanned = api.pdfPageUnderlay(api.openPdf(scanBytes).doc, 0, 'survey.pdf');
  check('a page that is one photograph is handed back as a scan',
    scanned.scan && scanned.scan.data === url && near(scanned.scan.widthMM, pt(400), 1e-6) && near(scanned.scan.angle, 0, 1e-9));

  const fax = streamBody('/Type /XObject /Subtype /Image /Width 96 /Height 64 /ImageMask true /Filter /CCITTFaxDecode', Buffer.from([1, 2, 3]));
  const faxPage = onePage('q 400 0 0 300 0 0 cm /Im1 Do Q', { resources: '/XObject << /Im1 5 0 R >>', extra: [fax] });
  const refused = api.pdfPageUnderlay(api.openPdf(faxPage).doc, 0, 'scan.pdf');
  check('a scan in a format the browser cannot decode says so', /scan/i.test(refused.error || ''), refused.error);
  const blank = api.pdfPageUnderlay(api.openPdf(onePage('q Q')).doc, 0, 'blank.pdf');
  check('a blank page says so', Boolean(blank.error));
}

// --- The stored form of a page -------------------------------------------------
{
  const plan = {
    page: { widthMM: 279.4, heightMM: 215.9 },
    ops: [
      { kind: 'stroke', widthMM: 0.25, dash: [3, 1.5], color: [1, 0, 0], subpaths: [
        { start: { x: 10, y: 20 }, segs: [{ type: 'l', to: { x: 110.0004, y: 20 } }, { type: 'l', to: { x: 110, y: 5.5 } }], closed: true },
        { start: { x: 1, y: 1 }, segs: [{ type: 'c', c1: { x: 2, y: 3 }, c2: { x: 4, y: 3 }, to: { x: 5, y: 1 } }], closed: false },
      ] },
      { kind: 'fill', color: [0, 0, 0], points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 3 }] },
      { kind: 'fill', color: [1, 1, 1], evenOdd: true, subpaths: [
        { start: { x: 50, y: 50 }, segs: [{ type: 'l', to: { x: 60, y: 50 } }, { type: 'l', to: { x: 60, y: 60 } }], closed: true },
      ] },
      { kind: 'text', text: 'A;B|C,D 50% Ø "q"', x: 12.5, y: 99.25, angle: Math.PI / 6, sizeMM: 3.5, widthMM: 40, font: 'courier', color: [0, 0, 1] },
      { kind: 'image', origin: { x: 0, y: 0 }, edgeX: { x: 1, y: 0 }, edgeY: { x: 0, y: 1 } },
    ],
  };
  const encoded = api.encodeVectorUnderlay(plan);
  check('a page is measured in micrometres', encoded.widthPx === 279400 && encoded.heightPx === 215900);
  check('and marked as vector data', api.isVectorUnderlayData(encoded.data) && !api.isVectorUnderlayData('data:image/jpeg;base64,AAAA'));
  check('images are counted, not carried', encoded.counts.images === 1 && encoded.counts.strokes === 1 && encoded.counts.fills === 2);
  check('the payload is plain enough to sit in JSON unescaped', JSON.stringify(encoded.data).length === encoded.data.length + 2);

  const ops = api.vectorUnderlayOps(encoded.data, (x, y) => ({ x: x / 1000, y: y / 1000 }), 1 / 1000);
  check('every op comes back, in order', ops.map(op => op.kind).join() === 'stroke,fill,fill,text');
  const stroke = ops[0];
  check('a stroke keeps its style', near(stroke.widthMM, 0.25, 1e-9) && stroke.dash.join() === '3,1.5' && stroke.color.join() === '1,0,0');
  check('its points, to the micrometre', near(stroke.subpaths[0].segs[0].to.x, 110, 1e-9) && near(stroke.subpaths[0].segs[1].to.y, 5.5, 1e-9));
  check('its closed flag', stroke.subpaths[0].closed === true && stroke.subpaths[1].closed === false);
  const curve = stroke.subpaths[1].segs[0];
  check('and its curves', curve.type === 'c' && near(curve.c1.y, 3, 1e-9) && near(curve.c2.x, 4, 1e-9) && near(curve.to.x, 5, 1e-9));
  check('a polygon fill comes back as a closed contour', ops[1].subpaths[0].closed && ops[1].subpaths[0].segs.length === 2);
  check('the even-odd rule survives', ops[2].evenOdd === true && ops[1].evenOdd === false);
  const text = ops[3];
  check('text survives every character that could be mistaken for a separator', text.text === 'A;B|C,D 50% Ø "q"', text.text);
  check('with its place, angle, size, width and face',
    near(text.x, 12.5, 1e-9) && near(text.angle, Math.PI / 6, 1e-5) && near(text.sizeMM, 3.5, 1e-9)
    && near(text.widthMM, 40, 1e-9) && text.font === 'courier');

  const calls = [];
  api.traceVectorPath('M10 20l5 0-5 5zM0 0c1 2 3 4 5 6', {
    moveTo: (x, y) => calls.push(`M${x},${y}`),
    lineTo: (x, y) => calls.push(`L${x},${y}`),
    bezierCurveTo: (a, b, c, d, x, y) => calls.push(`C${a},${b},${c},${d},${x},${y}`),
    closePath: () => calls.push('Z'),
  });
  check('a path replays as absolute canvas calls', calls.join(' ') === 'M10,20 L15,20 L10,25 Z M0,0 C1,2,3,4,5,6', calls.join(' '));

  let threw = null;
  try { api.eachVectorRecord('zbv1;S,,|Mxl;;F|;T1,2|%E0%A4%A;garbage', () => {}); } catch (error) { threw = error; }
  check('a damaged payload is skipped over rather than thrown on', threw === null, String(threw));
}

// --- Paper colours on a dark canvas --------------------------------------------
{
  const screen = color => api.underlayScreenColor(color);
  check('black ink draws white', screen([0, 0, 0]).every(level => near(level, 1, 1e-9)));
  check('the white of the sheet draws as the canvas', screen([1, 1, 1]).every(level => near(level, 0x11 / 255, 1e-9)));
  const red = screen([1, 0, 0]);
  check('a red line is still red', red[0] > 0.99 && red[1] < 0.1 && red[2] < 0.1);
  const navy = screen([0, 0, 0.4]);
  check('a dark colour is lightened, keeping its hue', navy[2] > navy[0] && navy[0] > 0.5);
}

// --- Placing a page ------------------------------------------------------------
const helveticaFont = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
function sheet(label) {
  // An ANSI B sheet (17 x 11 in) with a line exactly ten inches long.
  return onePage(`72 72 m 792 72 l S BT /F1 12 Tf 72 100 Td (${label}) Tj ET`,
    { mediaBox: '[0 0 1224 792]', resources: '/Font << /F1 5 0 R >>', extra: [helveticaFont] });
}

{
  await api.newDrawing(true);
  const started = api.startPdfPlacement({ doc: api.openPdf(sheet('A-101')).doc, name: 'floor plan.pdf' });
  check('a one-page PDF goes straight to placement', started && api.underlayStage === 'PLACE', api.underlayStage);
  check('offering full size', /1:1/.test(api.promptText), api.promptText);
  check('a bare number at that prompt is not a distance', api.commandCapabilities.takesDistance === false);

  api.submitCommandText('1/4"=1\'');
  check('a title-block scale is understood', /1\/4" = 1'-0"/.test(api.promptText), api.promptText);
  api.commitPoint({ x: 100, y: 50 });

  const placed = api.state.underlays[0];
  check('the page is placed as an underlay', api.state.underlays.length === 1 && api.state.mode === 'SELECT');
  check('holding line work rather than a picture', api.underlayIsVector(placed) && !placed.data.startsWith('data:'));
  check('named for its file', placed.name === 'floor plan');
  check('with its corner where it was put', near(placed.origin.x, 100) && near(placed.origin.y, 50));
  // 17 inches of paper at 1/4" = 1'-0" is 68 feet.
  check('and at the size the scale makes it', near(api.underlayWidth(placed), 17 * 48, 1e-6) && near(api.underlayHeight(placed), 11 * 48, 1e-6),
    `${api.underlayWidth(placed)} x ${api.underlayHeight(placed)}`);
  check('it is selected, like a placed image', api.state.selected.has(api.underlaySelectionId(placed.id)));
  check('a one-page file is not kept waiting', api.pendingPdf === null);
  check('its properties describe a sheet, not pixels', /PDF page, 17 × 11 in/.test(api.underlaySourceLabel(placed)), api.underlaySourceLabel(placed));

  let threw = null;
  try { api.drawNow(); api.drawNow(); } catch (error) { threw = error; }
  check('it draws without throwing', threw === null, String(threw && threw.stack));
  check('the display list has the line and the label',
    api.vectorDisplayList(placed.data).map(item => item.kind).join() === 'stroke,text');

  // The ten-inch line, found through the placement: 480 units long in world.
  const ops = api.vectorUnderlayOps(placed.data, (x, y) => ({
    x: placed.origin.x + x * placed.unitsPerPixel, y: placed.origin.y + y * placed.unitsPerPixel,
  }), placed.unitsPerPixel);
  const run = ops[0].subpaths[0];
  check('a ten-inch line on the sheet is forty feet in the drawing',
    near(run.segs[0].to.x - run.start.x, 480, 1e-3) && near(run.start.x, 100 + 48, 1e-3), `${run.segs[0].to.x - run.start.x}`);

  // Saved and reopened.
  const saved = api.exportDocumentText();
  await api.newDrawing(true);
  const loaded = await api.importDocumentText(saved, 'reopened');
  check('a drawing with a PDF page saves and reopens', loaded !== false && api.state.underlays.length === 1
    && api.state.underlays[0].data === placed.data && api.underlayIsVector(api.state.underlays[0]));

  // Undo takes it away, redo brings it back with the same payload.
  await api.newDrawing(true);
  api.startPdfPlacement({ doc: api.openPdf(sheet('A-102')).doc, name: 'b.pdf' });
  check('the scale last used is offered again', /1\/4" = 1'-0"/.test(api.promptText), api.promptText);
  api.submitCommandText('1:100');
  check('a metric ratio is understood too', near(api.state.underlay.scale, 100));
  api.submitCommandText('nonsense');
  check('something that is not a scale is refused, and the scale kept', near(api.state.underlay.scale, 100) && /scale/.test(api.promptText));
  api.submitCommandText('1');
  api.commitPoint({ x: 0, y: 0 });
  check('at full size a 17-inch sheet is 17 units wide in an inch drawing', near(api.underlayWidth(api.state.underlays[0]), 17, 1e-9));
  api.undo();
  check('undo removes the page', api.state.underlays.length === 0);
  api.redo();
  check('redo restores it', api.state.underlays.length === 1 && api.underlayIsVector(api.state.underlays[0]));
}

// --- Choosing a page -------------------------------------------------------------
{
  await api.newDrawing(true);
  const content = label => streamBody('', `72 72 m 300 72 l S BT /F1 12 Tf 72 100 Td (${label}) Tj ET`);
  const pageDict = contents => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents ${contents} 0 R >>`;
  const bytes = assemble([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>',
    pageDict(6), pageDict(7), pageDict(8),
    content('SHEET ONE'), content('SHEET TWO'), streamBody('', 'q Q'),
    helveticaFont,
  ]);
  const doc = api.openPdf(bytes).doc;
  check('a three-page file has three pages', doc.pages.length === 3);
  api.startPdfPlacement({ doc, name: 'set.pdf' });
  check('a multi-page PDF asks which page', api.underlayStage === 'PAGE' && /3 pages/.test(api.promptText) && /<1>/.test(api.promptText), api.promptText);
  api.submitCommandText('7');
  check('a page that does not exist is refused', api.underlayStage === 'PAGE' && /1 to 3/.test(api.promptText), api.promptText);
  api.submitCommandText('3');
  check('a page with nothing on it is refused, and another can be chosen', api.underlayStage === 'PAGE' && /another page/.test(api.promptText), api.promptText);
  api.submitCommandText('2');
  check('choosing a page moves on to placing it', api.underlayStage === 'PLACE');
  api.submitCommandText('1');
  api.commitPoint({ x: 0, y: 0 });
  const second = api.state.underlays[0];
  const label = api.vectorDisplayList(second.data).find(item => item.kind === 'text');
  check('the page chosen is the page placed', label && label.text === 'SHEET TWO' && second.name === 'set p2', second.name);
  check('the file is kept for the next sheet, starting after this one',
    api.pendingPdf && api.pendingPdf.pages === 3 && api.pendingPdf.nextPage === 2, JSON.stringify(api.pendingPdf));

  api.setPendingPdf({ doc, name: 'set.pdf', first: null, nextPage: 0 });
  api.startCommand('PDFATTACH');
  api.finishCurrent();
  check('Enter at the page prompt takes the page on offer', api.underlayStage === 'PLACE');
  api.finishCurrent();
  check('Enter while placing cancels', api.state.mode === 'SELECT' && api.state.underlays.length === 1);

  api.setPendingPdf(null);
  check('the command refuses to start with no file chosen', api.startCommand('PDFATTACH') === false && /PDF button/.test(api.promptText), api.promptText);

  check('scales parse the ways they are written', near(api.parseSheetScale('48'), 48) && near(api.parseSheetScale('1:50'), 50)
    && near(api.parseSheetScale('1"=20\''), 240) && near(api.parseSheetScale('2:1'), 0.5)
    && api.parseSheetScale('0') === null && api.parseSheetScale('1:0') === null && api.parseSheetScale('a=b') === null);
}

// --- A placed page transforms, calibrates and plots like any underlay ------------
{
  await api.newDrawing(true);
  api.startPdfPlacement({ doc: api.openPdf(sheet('S-1')).doc, name: 'sheet.pdf' });
  api.submitCommandText('1');
  api.commitPoint({ x: 0, y: 0 });
  const before = api.state.underlays[0];

  // The ten-inch line runs from (1, 1) to (11, 1) at full size. Say it is 240.
  api.startCommand('CALIBRATE');
  api.commitPoint({ x: 1, y: 1 });
  api.commitPoint({ x: 11, y: 1 });
  api.submitCommandText('240');
  const calibrated = api.state.underlays[0];
  check('CALIBRATE rescales a page about its first pick',
    near(calibrated.unitsPerPixel / before.unitsPerPixel, 24, 1e-9) && near(api.underlayWidth(calibrated), 17 * 24, 1e-6));
  check('without touching its line work', calibrated.data === before.data);

  // Plot it. Off by default, like an image; then on.
  const settings = { ...api.defaultPlotSettings(), paperSizeId: 'arch-e', scaleMode: 'exact', scale: 24, center: false };
  check('a page does not plot until it is told to', Boolean(api.buildPlotPlan(settings).error));
  api.state.underlays[0].plot = true;
  api.state.underlays[0].fade = 0;
  const plan = api.buildPlotPlan(settings);
  const stroke = plan.ops.find(op => op.kind === 'stroke');
  const text = plan.ops.find(op => op.kind === 'text');
  check('a page set to plot goes out as line work, not as an image',
    stroke && text && !plan.ops.some(op => op.kind === 'image'));
  // Scaled up 24x in the drawing and plotted at 1:24, the line is ten inches again.
  const run = stroke.subpaths[0];
  check('at the size the plot scale gives it', near(run.segs[0].to.x - run.start.x, 254, 1e-3), `${run.segs[0].to.x - run.start.x}`);
  check('with its text', text.text === 'S-1' && near(text.sizeMM, pt(12), 1e-3) && text.widthMM > 0);
  check('in the page\'s own black', stroke.color.every(level => near(level, 0, 1e-9)));

  api.state.underlays[0].fade = 50;
  const faded = api.buildPlotPlan(settings).ops.find(op => op.kind === 'stroke');
  check('fade plots as a lighter ink', faded.color.every(level => near(level, 0.5, 1e-9)));
  api.state.underlays[0].fade = 0;

  // Turned a quarter turn, the text turns with it.
  const turned = { ...api.state.underlays[0], rotation: Math.PI / 2 };
  api.state.underlays[0] = turned;
  const rotatedPlan = api.buildPlotPlan(settings);
  const rotatedText = rotatedPlan.ops.find(op => op.kind === 'text');
  const rotatedRun = rotatedPlan.ops.find(op => op.kind === 'stroke').subpaths[0];
  check('a rotated page plots rotated', near(rotatedText.angle, Math.PI / 2, 1e-9)
    && near(rotatedRun.segs[0].to.y - rotatedRun.start.y, 254, 1e-3) && near(rotatedRun.segs[0].to.x, rotatedRun.start.x, 1e-3));

  // And the PDF that comes out reads back as that line and that text.
  const back = readPage(new Uint8Array(latin1(api.buildPdfDocument(rotatedPlan)))).plan;
  const backRun = allSubpaths(back)[0];
  check('the plotted PDF reads back with the page\'s line in it',
    backRun && near(Math.hypot(backRun.segs[0].to.x - backRun.start.x, backRun.segs[0].to.y - backRun.start.y), 254, 1e-2));
  const backText = kinds(back, 'text')[0];
  check('and its text, at the width the page gave it',
    backText && backText.text === 'S-1' && near(backText.widthMM, text.widthMM, 0.05), backText && `${backText.widthMM} vs ${text.widthMM}`);

  let threw = null;
  try { api.openPlotDialog(); api.drawNow(); api.closePlotDialog(); } catch (error) { threw = error; }
  check('the plot preview draws a page without throwing', threw === null, String(threw && threw.stack));
}

// --- Object snap finds a page's line work ----------------------------------------
{
  await api.newDrawing(true);
  // The sheet's ten-inch line, a second line crossing it, and a curve.
  const bytes = onePage('72 72 m 792 72 l S 432 0 m 432 144 l S 100 300 m 150 400 250 400 300 300 c S 1 1 1 rg 500 500 50 50 re f',
    { mediaBox: '[0 0 1224 792]' });
  api.startPdfPlacement({ doc: api.openPdf(bytes).doc, name: 'snap.pdf' });
  api.submitCommandText('48');
  api.commitPoint({ x: 100, y: 200 });
  const placed = api.state.underlays[0];
  api.state.selected.clear();
  api.state.view.scale = 4;
  const snapAt = point => { api.state.mouseScreen = api.worldToScreen(point); return api.getSnap(point); };

  // One inch of paper is 48 units, so the line runs from (148, 248) to (628, 248).
  const end = snapAt({ x: 148.6, y: 248.4 });
  check('the end of a line on the page is an endpoint snap', end && end.type === 'END' && near(end.p.x, 148, 1e-6) && near(end.p.y, 248, 1e-6),
    JSON.stringify(end));
  const mid = snapAt({ x: 388.5, y: 248.3 });
  check('with a midpoint', mid && near(mid.p.x, 388, 1e-6) && near(mid.p.y, 248, 1e-6), JSON.stringify(mid));
  const crossing = snapAt({ x: 100 + 6 * 48 + 0.4, y: 248.5 });
  check('and an intersection with another line of the page',
    crossing && crossing.type === 'INT' && near(crossing.p.x, 388, 1e-6), JSON.stringify(crossing));
  check('nowhere near any line there is no snap', snapAt({ x: 300, y: 400 }) === null);
  check('a curve is not offered as its chord', snapAt({ x: 100 + (200 / 72) * 48, y: 200 + (300 / 72) * 48 }) === null);
  check('the edge of a white mask is not a snap', snapAt({ x: 100 + (500 / 72) * 48, y: 200 + (500 / 72) * 48 }) === null);

  // A line drawn in the drawing meets one on the page.
  api.startCommand('LINE');
  api.commitPoint({ x: 200, y: 200 });
  api.commitPoint({ x: 200, y: 300 });
  api.finishCurrent();
  const mixed = snapAt({ x: 200.3, y: 248.3 });
  check('drawn geometry and page geometry intersect each other',
    mixed && mixed.type === 'INT' && near(mixed.p.x, 200, 1e-6) && near(mixed.p.y, 248, 1e-6), JSON.stringify(mixed));

  // Rotated about its corner, the snap follows the page.
  const turned = { ...placed, rotation: Math.PI / 2 };
  api.state.underlays[0] = turned;
  const rotatedEnd = snapAt({ x: 100 - 48 + 0.4, y: 200 + 48 + 0.5 });
  check('a rotated page snaps where its lines now are',
    rotatedEnd && rotatedEnd.type === 'END' && near(rotatedEnd.p.x, 52, 1e-6) && near(rotatedEnd.p.y, 248, 1e-6), JSON.stringify(rotatedEnd));
  api.state.underlays[0] = placed;

  // Zoomed out until the whole sheet is a few pixels, there is nothing to pick.
  let dense = '0.1 w ';
  for (let index = 0; index < 400; index++) dense += `${100 + index * 0.05} 100 m ${100 + index * 0.05} 200 l S `;
  await api.newDrawing(true);
  api.startPdfPlacement({ doc: api.openPdf(onePage(dense)).doc, name: 'dense.pdf' });
  api.submitCommandText('1');
  api.commitPoint({ x: 0, y: 0 });
  api.state.view.scale = 4;
  const crowd = api.underlaySegmentsNear(api.state.underlays[0], { x: 110 / 72, y: 150 / 72 }, 10 / 4);
  check('too many lines under the cursor to tell apart offers none of them', crowd.length === 0);
  const few = api.underlaySegmentsNear(api.state.underlays[0], { x: 100 / 72, y: 150 / 72 }, 0.0005);
  check('zoomed in on the same lines, the one under the cursor is found', few.length >= 1 && few.length <= 3, `${few.length}`);

  // CALIBRATE snaps on a page, and still does not on a picture.
  api.startCommand('CALIBRATE');
  check('CALIBRATE takes snaps when the target is a PDF page', api.commandCapabilities.usesSnap === true);
  api.cancelCurrent();
}

// --- Validation ---------------------------------------------------------------
{
  await api.newDrawing(true);
  const good = JSON.parse(api.exportDocumentText());
  const underlay = {
    id: 1, layerId: '0', name: 'p', origin: { x: 0, y: 0 }, rotation: 0, unitsPerPixel: 0.001,
    widthPx: 1000, heightPx: 1000, fade: 0, locked: false, plot: false, data: 'zbv1;S000000,0,|M0 0l10 10',
  };
  good.underlays = [underlay];
  good.nextUnderlayId = 2;
  check('a saved vector underlay passes the document check', await api.importDocumentText(JSON.stringify(good), 'ok') !== false && api.state.underlays.length === 1);
  good.underlays = [{ ...underlay, data: 'not an underlay payload' }];
  await api.newDrawing(true);
  await api.importDocumentText(JSON.stringify(good), 'bad');
  check('a payload that is neither an image nor line work does not', api.state.underlays.length === 0);
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('FAILURES:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
