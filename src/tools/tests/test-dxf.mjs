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
const TAU = Math.PI * 2;

// Read a DXF back as group-code pairs so assertions can name a code rather
// than grepping for a substring that might appear anywhere.
function pairs(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const out = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    out.push([Number(lines[index].trim()), lines[index + 1]]);
  }
  return out;
}

// Every record of a given type, as a map of code -> list of values.
function recordsOfType(text, type) {
  const all = pairs(text);
  const found = [];
  for (let index = 0; index < all.length; index++) {
    if (all[index][0] !== 0 || all[index][1] !== type) continue;
    const record = new Map();
    let cursor = index + 1;
    while (cursor < all.length && all[cursor][0] !== 0) {
      const [code, value] = all[cursor];
      if (!record.has(code)) record.set(code, []);
      record.get(code).push(value);
      cursor++;
    }
    found.push(record);
  }
  return found;
}

function firstOf(record, code) {
  const values = record.get(code);
  return values ? values[0] : undefined;
}

function drawLine(a, b) {
  api.startCommand('LINE');
  api.commitPoint(a);
  api.commitPoint(b);
  api.finishCurrent();
}

function exportText() {
  return api.buildDxfDocument(api.buildDxfPlan());
}

await api.newDrawing(true);
api.setAllSnapTypes(false);

// --- File structure ---------------------------------------------------------
{
  await api.newDrawing(true);
  drawLine({ x: 0, y: 0 }, { x: 10, y: 5 });
  const text = exportText();

  check('the file declares R2000', text.includes('AC1015'));
  check('the file ends with EOF', text.trimEnd().endsWith('EOF'));
  check('the file uses CRLF', text.includes('\r\n'));

  for (const section of ['HEADER', 'TABLES', 'BLOCKS', 'ENTITIES', 'OBJECTS']) {
    check(`the file has a ${section} section`, text.includes(`SECTION\r\n  2\r\n${section}`)
      || pairs(text).some(([code, value], index, all) =>
        code === 0 && value === 'SECTION' && all[index + 1] && all[index + 1][1] === section),
      `missing ${section}`);
  }

  const sectionOpens = pairs(text).filter(([code, value]) => code === 0 && value === 'SECTION').length;
  const sectionCloses = pairs(text).filter(([code, value]) => code === 0 && value === 'ENDSEC').length;
  check('every section is closed', sectionOpens === sectionCloses,
    `${sectionOpens} open, ${sectionCloses} closed`);

  const tableOpens = pairs(text).filter(([code, value]) => code === 0 && value === 'TABLE').length;
  const tableCloses = pairs(text).filter(([code, value]) => code === 0 && value === 'ENDTAB').length;
  check('every table is closed', tableOpens === tableCloses,
    `${tableOpens} open, ${tableCloses} closed`);

  // Handles must be unique or a reader rejects the file.
  const handles = pairs(text).filter(([code]) => code === 5 || code === 105).map(pair => pair[1]);
  check('every handle is unique', new Set(handles).size === handles.length,
    `${handles.length} handles, ${new Set(handles).size} distinct`);
  check('handles were actually written', handles.length > 10);

  // Group codes come in pairs; an odd line count means a truncated record.
  const lineCount = text.split('\r\n').filter((line, index, all) => index < all.length - 1).length;
  check('the file is an even number of lines', lineCount % 2 === 0, `${lineCount} lines`);

  const mandatory = ['$ACADVER', '$INSUNITS', '$LUNITS', '$EXTMIN', '$EXTMAX'];
  for (const variable of mandatory) {
    check(`the header carries ${variable}`, text.includes(variable));
  }
}

// --- Entity mapping ---------------------------------------------------------
{
  await api.newDrawing(true);
  drawLine({ x: 1.5, y: 2.25 }, { x: 11.75, y: -3.5 });
  const text = exportText();
  const lines = recordsOfType(text, 'LINE');
  check('a LINE exports as LINE', lines.length === 1);
  check('the start point survives', near(Number(firstOf(lines[0], 10)), 1.5)
    && near(Number(firstOf(lines[0], 20)), 2.25));
  check('the end point survives', near(Number(firstOf(lines[0], 11)), 11.75)
    && near(Number(firstOf(lines[0], 21)), -3.5));
  check('the entity names its layer', firstOf(lines[0], 8) === '0');
}

{
  await api.newDrawing(true);
  api.startCommand('CIRCLE');
  api.commitPoint({ x: 4.2, y: -1.8 });
  api.commitPoint({ x: 4.2 + 3.75, y: -1.8 });
  const text = exportText();
  const circles = recordsOfType(text, 'CIRCLE');
  check('a CIRCLE exports as CIRCLE', circles.length === 1);
  check('the centre survives', near(Number(firstOf(circles[0], 10)), 4.2)
    && near(Number(firstOf(circles[0], 20)), -1.8));
  check('the radius survives', near(Number(firstOf(circles[0], 40)), 3.75));
}

// --- Arcs: degrees, counter-clockwise ---------------------------------------
{
  await api.newDrawing(true);
  // Three points that produce an arc with an awkward, non-canonical sweep.
  api.startCommand('ARC');
  api.commitPoint({ x: 0, y: 0 });
  api.commitPoint({ x: 6.4, y: 4.1 });
  api.commitPoint({ x: 13.1, y: 1.2 });
  const source = api.state.entities[0];
  const text = exportText();
  const arcs = recordsOfType(text, 'ARC');
  check('an ARC exports as ARC', arcs.length === 1);

  const startDeg = Number(firstOf(arcs[0], 50));
  const endDeg = Number(firstOf(arcs[0], 51));
  check('arc angles are written in degrees', startDeg >= 0 && startDeg < 360 && endDeg >= 0 && endDeg < 360,
    `${startDeg}, ${endDeg}`);
  check('the start angle matches the entity',
    near(startDeg, ((source.startAngle * 360 / TAU) % 360 + 360) % 360, 1e-6));

  // The property that matters: the sweep survives, counter-clockwise.
  const sourceSweep = source.endAngle - source.startAngle;
  let writtenSweep = (endDeg - startDeg) * TAU / 360;
  if (writtenSweep <= 0) writtenSweep += TAU;
  check('the arc sweep survives', near(writtenSweep, sourceSweep, 1e-6),
    `wrote ${writtenSweep}, entity ${sourceSweep}`);
  check('the radius survives', near(Number(firstOf(arcs[0], 40)), source.radius, 1e-9));
}

// --- Polyline bulges cross over verbatim ------------------------------------
{
  await api.newDrawing(true);
  const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }];
  const bulges = [0.4142135623730951, 0, -0.2679491924311227, 0];
  api.addPolyline(points, true, bulges);
  const text = exportText();
  const polylines = recordsOfType(text, 'LWPOLYLINE');
  check('a PLINE exports as LWPOLYLINE', polylines.length === 1);
  check('the vertex count is written', Number(firstOf(polylines[0], 90)) === 4);
  check('the closed flag is set', (Number(firstOf(polylines[0], 70)) & 1) === 1);

  const writtenBulges = (polylines[0].get(42) || []).map(Number);
  check('only curved segments carry a bulge', writtenBulges.length === 2,
    `wrote ${writtenBulges.length}`);
  check('the first bulge crosses over unchanged', near(writtenBulges[0], bulges[0], 1e-12));
  check('the negative bulge keeps its sign', near(writtenBulges[1], bulges[2], 1e-12));
}

// --- Layers -----------------------------------------------------------------
{
  await api.newDrawing(true);
  api.createLayer('Roof Edge');
  const layer = api.layers.find(candidate => candidate.name === 'Roof Edge');
  api.setLayerColor(layer.id, '#ff8800');
  api.setLayerLinetype(layer.id, 'dashed');
  api.setLayerLineweight(layer.id, 0.5);
  api.setCurrentLayer(layer.id);
  drawLine({ x: 0, y: 0 }, { x: 5, y: 0 });

  const text = exportText();
  const layers = recordsOfType(text, 'LAYER');
  const exported = layers.find(record => firstOf(record, 2) === 'Roof Edge');
  check('the layer is in the table', Boolean(exported));
  check('the true colour is exact', Number(firstOf(exported, 420)) === 0xff8800,
    `got ${Number(firstOf(exported, 420)).toString(16)}`);
  check('an indexed colour is written too', Number.isFinite(Number(firstOf(exported, 62))));
  check('the linetype is named', firstOf(exported, 6) === 'DASHED');
  check('the lineweight is in hundredths of a mm', Number(firstOf(exported, 370)) === 50,
    `got ${firstOf(exported, 370)}`);
  check('the layer is marked plottable', Number(firstOf(exported, 290)) === 1);

  const linetypes = recordsOfType(text, 'LTYPE');
  const dashed = linetypes.find(record => firstOf(record, 2) === 'DASHED');
  check('the linetype has a table entry', Boolean(dashed));
  check('the linetype has a real pattern', (dashed.get(49) || []).length > 0);

  // A non-printing layer must say so.
  api.toggleLayerPrintable(layer.id);
  const second = recordsOfType(exportText(), 'LAYER')
    .find(record => firstOf(record, 2) === 'Roof Edge');
  check('a non-printing layer writes plot 0', Number(firstOf(second, 290)) === 0);
}

// --- A hidden layer travels as a negative colour index ----------------------
{
  await api.newDrawing(true);
  api.createLayer('Hidden');
  const layer = api.layers.find(candidate => candidate.name === 'Hidden');
  api.setCurrentLayer(layer.id);
  drawLine({ x: 0, y: 0 }, { x: 1, y: 1 });
  api.setCurrentLayer('0');
  api.toggleLayerVisibility(layer.id);

  const exported = recordsOfType(exportText(), 'LAYER')
    .find(record => firstOf(record, 2) === 'Hidden');
  check('a hidden layer has a negative colour index', Number(firstOf(exported, 62)) < 0,
    `got ${firstOf(exported, 62)}`);
}

// --- Text -------------------------------------------------------------------
{
  await api.newDrawing(true);
  api.startCommand('TEXT');
  api.commitPoint({ x: 2, y: 3 });
  api.commitDistance(12);
  api.submitCommandText('0');
  api.submitCommandText('ROOF PLAN');

  const text = exportText();
  const texts = recordsOfType(text, 'TEXT');
  check('TEXT exports as TEXT', texts.length === 1, `got ${texts.length}`);
  if (texts.length) {
    check('the string survives', firstOf(texts[0], 1) === 'ROOF PLAN');
    check('the height survives', near(Number(firstOf(texts[0], 40)), 12));
    check('the position survives', near(Number(firstOf(texts[0], 10)), 2)
      && near(Number(firstOf(texts[0], 20)), 3));
    check('a text style is named', firstOf(texts[0], 7) === 'Standard');
  }
  const styles = recordsOfType(text, 'STYLE');
  check('the style table names a monospace font',
    styles.some(record => String(firstOf(record, 3)).includes('cour')));
}

// --- Dimensions carry a DIMENSION entity and its picture --------------------
{
  await api.newDrawing(true);
  drawLine({ x: 0, y: 0 }, { x: 120, y: 0 });
  api.startCommand('DIMLINEAR');
  api.commitPoint({ x: 0, y: 0 });
  api.commitPoint({ x: 120, y: 0 });
  api.commitPoint({ x: 60, y: -24 });

  const text = exportText();
  const dims = recordsOfType(text, 'DIMENSION');
  check('a dimension exports as DIMENSION', dims.length === 1, `got ${dims.length}`);
  if (dims.length) {
    const blockName = firstOf(dims[0], 2);
    check('the dimension names a block', String(blockName).startsWith('*D'), String(blockName));
    check('the dimension names a style', Boolean(firstOf(dims[0], 3)));
    check('the measurement is written', near(Number(firstOf(dims[0], 42)), 120, 1e-6),
      `got ${firstOf(dims[0], 42)}`);
    check('the extension origins are written',
      near(Number(firstOf(dims[0], 13)), 0) && near(Number(firstOf(dims[0], 14)), 120));

    // Bit 32 says the picture lives in a block, which it does.
    check('the block-reference flag is set', (Number(firstOf(dims[0], 70)) & 32) === 32,
      `flags ${firstOf(dims[0], 70)}`);

    // And the block must actually exist and hold geometry.
    const blocks = recordsOfType(text, 'BLOCK');
    const block = blocks.find(record => firstOf(record, 2) === blockName);
    check('the dimension block is defined', Boolean(block));
    const blockRecords = recordsOfType(text, 'BLOCK_RECORD');
    check('the block has a BLOCK_RECORD',
      blockRecords.some(record => firstOf(record, 2) === blockName));
    // The picture is lines plus a terminator, reusing the plot renderer.
    check('the dimension block holds line work', recordsOfType(text, 'LINE').length >= 3,
      `${recordsOfType(text, 'LINE').length} lines`);
    check('the dimension block holds a terminator', recordsOfType(text, 'SOLID').length >= 1);
    check('the dimension block holds its text',
      recordsOfType(text, 'TEXT').some(record => String(firstOf(record, 1)).length > 0));
  }

  const dimStyles = recordsOfType(text, 'DIMSTYLE');
  check('a dimension style table entry exists', dimStyles.length >= 1);
  if (dimStyles.length) {
    check('the style carries a text height', Number(firstOf(dimStyles[0], 140)) > 0);
    check('the style carries an arrow size', Number(firstOf(dimStyles[0], 41)) > 0);
  }
}

// --- Radial and diameter dimensions -----------------------------------------
{
  await api.newDrawing(true);
  api.startCommand('CIRCLE');
  api.commitPoint({ x: 30, y: 20 });
  api.commitPoint({ x: 42, y: 20 });
  api.startCommand('DIMRADIUS');
  api.commitPoint({ x: 42, y: 20 });
  api.commitPoint({ x: 38, y: 24 });

  const dims = recordsOfType(exportText(), 'DIMENSION');
  check('a radius dimension exports', dims.length === 1, `got ${dims.length}`);
  if (dims.length) {
    check('a radius dimension has kind 4', (Number(firstOf(dims[0], 70)) & 7) === 4,
      `flags ${firstOf(dims[0], 70)}`);
    check('a radius dimension writes a chord point', dims[0].has(15));
    check('the radius is the measurement', near(Number(firstOf(dims[0], 42)), 12, 1e-6),
      `got ${firstOf(dims[0], 42)}`);
  }
}

// --- The round trip ---------------------------------------------------------
// The strongest assertion available: build a drawing with one of everything,
// write it, read it back, and compare geometry. Properties, not coordinates
// copied out of a previous run.
{
  await api.newDrawing(true);
  drawLine({ x: 0, y: 0 }, { x: 37.5, y: 12.25 });
  api.addPolyline(
    [{ x: 0, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 40 }],
    false,
    [0.3, 0, 0],
  );
  api.startCommand('CIRCLE');
  api.commitPoint({ x: 60, y: 60 });
  api.commitPoint({ x: 67.5, y: 60 });
  api.startCommand('ARC');
  api.commitPoint({ x: 80, y: 0 });
  api.commitPoint({ x: 86.4, y: 4.1 });
  api.commitPoint({ x: 93.1, y: 1.2 });

  const before = api.entities.map(entity => ({ ...entity }));
  const text = exportText();

  const parsed = api.parseDxfText(text);
  check('the written file parses', !parsed.error, parsed.error);

  const result = api.dxfPlanToDocument(parsed.plan, { name: 'Round trip' });
  check('the parsed plan makes a document', !result.error, result.error);

  const after = result.document.entities;
  check('the round trip keeps the entity count', after.length === before.length,
    `${before.length} out, ${after.length} back`);

  const line = after.find(entity => entity.type === 'LINE');
  check('the line came back', Boolean(line));
  if (line) {
    check('the line keeps its start', near(line.a.x, 0) && near(line.a.y, 0));
    check('the line keeps its end', near(line.b.x, 37.5) && near(line.b.y, 12.25));
  }

  const circle = after.find(entity => entity.type === 'CIRCLE');
  check('the circle came back', Boolean(circle));
  if (circle) {
    check('the circle keeps its radius', near(circle.radius, 7.5, 1e-9));
    check('the circle keeps its centre', near(circle.center.x, 60) && near(circle.center.y, 60));
  }

  const arcBefore = before.find(entity => entity.type === 'ARC');
  const arcAfter = after.find(entity => entity.type === 'ARC');
  check('the arc came back', Boolean(arcAfter));
  if (arcBefore && arcAfter) {
    check('the arc keeps its radius', near(arcAfter.radius, arcBefore.radius, 1e-6));
    check('the arc keeps its centre',
      near(arcAfter.center.x, arcBefore.center.x, 1e-6)
      && near(arcAfter.center.y, arcBefore.center.y, 1e-6));
    const sweepBefore = arcBefore.endAngle - arcBefore.startAngle;
    const sweepAfter = arcAfter.endAngle - arcAfter.startAngle;
    check('the arc keeps its sweep', near(sweepAfter, sweepBefore, 1e-6),
      `${sweepAfter} vs ${sweepBefore}`);
    // Tangency-style property: the arc's own endpoints must land where they did.
    const endBefore = {
      x: arcBefore.center.x + arcBefore.radius * Math.cos(arcBefore.endAngle),
      y: arcBefore.center.y + arcBefore.radius * Math.sin(arcBefore.endAngle),
    };
    const endAfter = {
      x: arcAfter.center.x + arcAfter.radius * Math.cos(arcAfter.endAngle),
      y: arcAfter.center.y + arcAfter.radius * Math.sin(arcAfter.endAngle),
    };
    check('the arc endpoint lands in the same place',
      near(endAfter.x, endBefore.x, 1e-6) && near(endAfter.y, endBefore.y, 1e-6));
  }

  const plineBefore = before.find(entity => entity.type === 'PLINE');
  const plineAfter = after.find(entity => entity.type === 'PLINE');
  check('the polyline came back', Boolean(plineAfter));
  if (plineBefore && plineAfter) {
    check('the polyline keeps its vertex count',
      plineAfter.points.length === plineBefore.points.length);
    check('the polyline keeps its bulge',
      near(plineAfter.bulges[0], plineBefore.bulges[0], 1e-9),
      `${plineAfter.bulges && plineAfter.bulges[0]} vs ${plineBefore.bulges[0]}`);
    check('the polyline keeps its open/closed state',
      Boolean(plineAfter.closed) === Boolean(plineBefore.closed));
  }

  check('the round trip reports what it did', result.report.entityCount === after.length);
}

// --- Round trip through the document, twice, is stable ----------------------
{
  await api.newDrawing(true);
  api.addPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], true, [0.25, 0, -0.5]);
  const firstPass = exportText();
  const firstDocument = api.dxfPlanToDocument(api.parseDxfText(firstPass).plan, { name: 'A' });
  check('the first pass succeeds', !firstDocument.error, firstDocument.error);

  await api.loadDxfText(firstPass, 'stable.dxf');
  const secondPass = exportText();
  const secondDocument = api.dxfPlanToDocument(api.parseDxfText(secondPass).plan, { name: 'B' });
  check('the second pass succeeds', !secondDocument.error, secondDocument.error);

  const a = firstDocument.document.entities[0];
  const b = secondDocument.document.entities[0];
  check('a second trip changes nothing', a && b
    && a.points.length === b.points.length
    && near(a.points[0].x, b.points[0].x, 1e-9)
    && near(a.bulges[0], b.bulges[0], 1e-12),
    'geometry drifted between passes');
}

// --- Units ------------------------------------------------------------------
{
  await api.newDrawing(true);
  drawLine({ x: 0, y: 0 }, { x: 1, y: 1 });
  const inchText = exportText();
  check('inches export as INSUNITS 1', /\$INSUNITS\r\n\s*70\r\n1\r\n/.test(inchText),
    'no $INSUNITS 1');

  const parsed = api.parseDxfText(inchText);
  const result = api.dxfPlanToDocument(parsed.plan, { name: 'Units' });
  check('inches come back as inches', result.document.unitSettings.drawingUnit === 'inches',
    result.document.unitSettings.drawingUnit);

  // A millimetre file must not come back claiming an inch-only length format.
  const mmText = inchText.replace(/(\$INSUNITS\r\n\s*70\r\n)1\r\n/, '$14\r\n');
  const mmResult = api.dxfPlanToDocument(api.parseDxfText(mmText).plan, { name: 'Metric' });
  check('a millimetre file imports as millimetres',
    mmResult.document.unitSettings.drawingUnit === 'millimeters',
    mmResult.document.unitSettings.drawingUnit);
  check('a millimetre file gets a legal length format',
    mmResult.document.unitSettings.format === 'decimal',
    mmResult.document.unitSettings.format);
}

// --- Hand-written fixtures --------------------------------------------------
function fixture(body) {
  return ['0', 'SECTION', '2', 'ENTITIES', ...body, '0', 'ENDSEC', '0', 'EOF'].join('\r\n') + '\r\n';
}
function fixtureWithBlocks(blockBody, entityBody) {
  return [
    '0', 'SECTION', '2', 'BLOCKS', ...blockBody, '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES', ...entityBody, '0', 'ENDSEC',
    '0', 'EOF',
  ].join('\r\n') + '\r\n';
}

// The old POLYLINE / VERTEX / SEQEND form that R12 files still use.
{
  const text = fixture([
    '0', 'POLYLINE', '8', '0', '66', '1', '70', '1',
    '0', 'VERTEX', '8', '0', '10', '0.0', '20', '0.0', '42', '0.5',
    '0', 'VERTEX', '8', '0', '10', '10.0', '20', '0.0',
    '0', 'VERTEX', '8', '0', '10', '10.0', '20', '10.0',
    '0', 'SEQEND', '8', '0',
  ]);
  const result = api.importDxfText(text, 'legacy.dxf');
  check('the legacy POLYLINE form imports', !result.error, result.error);
  const pline = result.document.entities.find(entity => entity.type === 'PLINE');
  check('the legacy polyline has its vertices', pline && pline.points.length === 3,
    `got ${pline ? pline.points.length : 'none'}`);
  check('the legacy polyline is closed', pline && pline.closed === true);
  check('the legacy polyline keeps its bulge', pline && pline.bulges
    && near(pline.bulges[0], 0.5, 1e-12));
}

// INSERT flattening, with rotation and a translation.
{
  const text = fixtureWithBlocks([
    '0', 'BLOCK', '2', 'MARK', '10', '0.0', '20', '0.0',
    '0', 'LINE', '8', '0', '10', '0.0', '20', '0.0', '11', '10.0', '21', '0.0',
    '0', 'ENDBLK',
  ], [
    '0', 'INSERT', '8', '0', '2', 'MARK',
    '10', '5.0', '20', '7.0', '41', '2.0', '42', '2.0', '50', '90.0',
  ]);
  const result = api.importDxfText(text, 'insert.dxf');
  check('an INSERT imports', !result.error, result.error);
  const line = result.document.entities.find(entity => entity.type === 'LINE');
  check('the INSERT was flattened to a line', Boolean(line));
  if (line) {
    // A 10-unit line, scaled x2 and turned 90 degrees, from (5,7): it must run
    // from (5,7) to (5,27).
    check('the flattened line starts at the insertion point',
      near(line.a.x, 5, 1e-6) && near(line.a.y, 7, 1e-6),
      `${line.a.x},${line.a.y}`);
    check('the flattened line is scaled and rotated',
      near(line.b.x, 5, 1e-6) && near(line.b.y, 27, 1e-6),
      `${line.b.x},${line.b.y}`);
  }
}

// A nested INSERT, to prove the transforms compose.
{
  const text = fixtureWithBlocks([
    '0', 'BLOCK', '2', 'INNER', '10', '0.0', '20', '0.0',
    '0', 'LINE', '8', '0', '10', '0.0', '20', '0.0', '11', '1.0', '21', '0.0',
    '0', 'ENDBLK',
    '0', 'BLOCK', '2', 'OUTER', '10', '0.0', '20', '0.0',
    '0', 'INSERT', '8', '0', '2', 'INNER', '10', '0.0', '20', '0.0', '41', '3.0', '42', '3.0',
    '0', 'ENDBLK',
  ], [
    '0', 'INSERT', '8', '0', '2', 'OUTER', '10', '10.0', '20', '0.0', '41', '2.0', '42', '2.0',
  ]);
  const result = api.importDxfText(text, 'nested.dxf');
  const line = result.document.entities.find(entity => entity.type === 'LINE');
  check('a nested INSERT flattens', Boolean(line));
  if (line) {
    // 1 unit, times 3, times 2, starting at x=10.
    check('nested transforms compose', near(line.b.x, 16, 1e-6) && near(line.a.x, 10, 1e-6),
      `${line.a.x} -> ${line.b.x}`);
  }
}

// An INSERT array.
{
  const text = fixtureWithBlocks([
    '0', 'BLOCK', '2', 'DOT', '10', '0.0', '20', '0.0',
    '0', 'LINE', '8', '0', '10', '0.0', '20', '0.0', '11', '1.0', '21', '0.0',
    '0', 'ENDBLK',
  ], [
    '0', 'INSERT', '8', '0', '2', 'DOT', '10', '0.0', '20', '0.0',
    '70', '3', '71', '2', '44', '10.0', '45', '20.0',
  ]);
  const result = api.importDxfText(text, 'array.dxf');
  const lines = result.document.entities.filter(entity => entity.type === 'LINE');
  check('an INSERT array expands to every copy', lines.length === 6, `got ${lines.length}`);
  const xs = [...new Set(lines.map(line => Math.round(line.a.x)))].sort((a, b) => a - b);
  const ys = [...new Set(lines.map(line => Math.round(line.a.y)))].sort((a, b) => a - b);
  check('the array columns are spaced', xs.join(',') === '0,10,20', xs.join(','));
  check('the array rows are spaced', ys.join(',') === '0,20', ys.join(','));
}

// ELLIPSE approximation.
{
  const text = fixture([
    '0', 'ELLIPSE', '8', '0',
    '10', '0.0', '20', '0.0',
    '11', '20.0', '21', '0.0',
    '40', '0.5',
    '41', '0.0', '42', '6.283185307179586',
  ]);
  const result = api.importDxfText(text, 'ellipse.dxf');
  check('an ELLIPSE imports', !result.error, result.error);
  const pline = result.document.entities.find(entity => entity.type === 'PLINE');
  check('an ELLIPSE becomes a closed polyline', pline && pline.closed === true);
  check('the approximation is reported', result.report.approximated.ELLIPSE === 1,
    JSON.stringify(result.report.approximated));
  if (pline) {
    // Every vertex must satisfy the ellipse equation: this is a property of the
    // shape, not of the sampling.
    const worst = Math.max(...pline.points.map(point =>
      Math.abs((point.x / 20) ** 2 + (point.y / 10) ** 2 - 1)));
    check('every vertex lies on the ellipse', worst < 1e-9, `worst error ${worst}`);
    const xs = pline.points.map(point => point.x);
    check('the approximation spans the major axis',
      near(Math.max(...xs), 20, 1e-6) && near(Math.min(...xs), -20, 1e-6));
  }
}

// A rotated ellipse must stay rotated.
{
  const text = fixture([
    '0', 'ELLIPSE', '8', '0',
    '10', '5.0', '20', '5.0',
    '11', '0.0', '21', '10.0',
    '40', '0.5',
    '41', '0.0', '42', '6.283185307179586',
  ]);
  const result = api.importDxfText(text, 'rotated-ellipse.dxf');
  const pline = result.document.entities.find(entity => entity.type === 'PLINE');
  check('a rotated ellipse imports', Boolean(pline));
  if (pline) {
    const ys = pline.points.map(point => point.y);
    const xs = pline.points.map(point => point.x);
    // Major axis along Y now: the Y spread must be the larger one.
    check('the rotated major axis runs the right way',
      near(Math.max(...ys) - Math.min(...ys), 20, 1e-6)
      && near(Math.max(...xs) - Math.min(...xs), 10, 1e-6),
      `x span ${Math.max(...xs) - Math.min(...xs)}, y span ${Math.max(...ys) - Math.min(...ys)}`);
  }
}

// SPLINE approximation through fit points.
{
  const text = fixture([
    '0', 'SPLINE', '8', '0', '70', '8', '71', '3',
    '11', '0.0', '21', '0.0',
    '11', '5.0', '21', '8.0',
    '11', '12.0', '21', '3.0',
  ]);
  const result = api.importDxfText(text, 'spline.dxf');
  const pline = result.document.entities.find(entity => entity.type === 'PLINE');
  check('a SPLINE becomes a polyline', Boolean(pline));
  check('the spline approximation is reported', result.report.approximated.SPLINE === 1);
  if (pline) {
    check('the spline keeps its fit points', pline.points.length === 3);
    check('the spline starts where it should', near(pline.points[0].x, 0) && near(pline.points[0].y, 0));
  }
}

// Unsupported entities are counted, not silently dropped.
{
  const text = fixture([
    '0', 'HATCH', '8', '0', '2', 'ANSI31',
    '0', 'LINE', '8', '0', '10', '0.0', '20', '0.0', '11', '5.0', '21', '5.0',
    '0', '3DFACE', '8', '0', '10', '0.0', '20', '0.0',
    '0', 'POINT', '8', '0', '10', '1.0', '20', '1.0',
  ]);
  const result = api.importDxfText(text, 'mixed.dxf');
  check('a file with unsupported entities still imports', !result.error, result.error);
  check('the supported entity came through', result.document.entities.length === 1,
    `got ${result.document.entities.length}`);
  check('the HATCH is reported', result.report.skipped.HATCH === 1,
    JSON.stringify(result.report.skipped));
  check('the 3DFACE is reported', result.report.skipped['3DFACE'] === 1,
    JSON.stringify(result.report.skipped));
  check('the POINT is reported', result.report.skipped.POINT === 1,
    JSON.stringify(result.report.skipped));
}

// Degenerate geometry is dropped rather than allowed to fail validation.
{
  const text = fixture([
    '0', 'LINE', '8', '0', '10', '3.0', '20', '3.0', '11', '3.0', '21', '3.0',
    '0', 'CIRCLE', '8', '0', '10', '0.0', '20', '0.0', '40', '0.0',
    '0', 'LINE', '8', '0', '10', '0.0', '20', '0.0', '11', '5.0', '21', '0.0',
  ]);
  const result = api.importDxfText(text, 'degenerate.dxf');
  check('degenerate geometry does not fail the import', !result.error, result.error);
  check('only the real line survives', result.document.entities.length === 1,
    `got ${result.document.entities.length}`);
  check('the zero-length line is reported', Boolean(result.report.skipped['zero-length LINE']));
  check('the zero-radius circle is reported', Boolean(result.report.skipped['zero-radius CIRCLE']));
}

// MTEXT formatting codes are stripped, not shown.
{
  const text = fixture([
    '0', 'MTEXT', '8', '0',
    '10', '0.0', '20', '0.0', '40', '2.5', '41', '50.0', '71', '1',
    '1', '{\\fArial|b1|i0;BOLD} then plain\\Psecond line',
  ]);
  const result = api.importDxfText(text, 'mtext.dxf');
  const mtext = result.document.entities.find(entity => entity.type === 'MTEXT');
  check('MTEXT imports', Boolean(mtext));
  if (mtext) {
    check('the formatting codes are gone', !mtext.content.includes('\\f') && !mtext.content.includes('{'),
      mtext.content);
    check('the words survive', mtext.content.includes('BOLD') && mtext.content.includes('then plain'),
      mtext.content);
    check('the line break survives', mtext.content.includes('\n'), JSON.stringify(mtext.content));
    check('the wrap width survives', near(mtext.width, 50));
  }
}

// --- Layer table on import --------------------------------------------------
{
  const text = [
    '0', 'SECTION', '2', 'TABLES',
    '0', 'TABLE', '2', 'LAYER', '70', '2',
    '0', 'LAYER', '2', '0', '62', '7', '6', 'CONTINUOUS', '370', '25', '290', '1',
    '0', 'LAYER', '2', 'WALLS', '62', '1', '420', '16711680', '6', 'DASHED', '370', '50', '290', '0',
    '0', 'ENDTAB', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', 'WALLS', '10', '0.0', '20', '0.0', '11', '5.0', '21', '5.0',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\r\n') + '\r\n';

  const result = api.importDxfText(text, 'layers.dxf');
  check('the layer table imports', !result.error, result.error);
  const walls = result.document.layers.find(layer => layer.name === 'WALLS');
  check('the named layer came through', Boolean(walls));
  if (walls) {
    check('the true colour wins over the index', walls.color === '#ff0000', walls.color);
    check('the linetype came through', walls.linetype === 'dashed', walls.linetype);
    check('the lineweight came through', near(walls.lineweight, 0.5), String(walls.lineweight));
    check('the non-plotting flag came through', walls.printable === false);
  }
  const line = result.document.entities[0];
  check('the entity landed on its layer', line && walls && line.layerId === walls.id);
  check('layer 0 always exists', result.document.layers.some(layer => layer.id === '0'));
}

// A layer referenced by an entity but missing from the table is created.
{
  const text = fixture(['0', 'LINE', '8', 'GHOST', '10', '0.0', '20', '0.0', '11', '1.0', '21', '1.0']);
  const result = api.importDxfText(text, 'ghost.dxf');
  const ghost = result.document.layers.find(layer => layer.name === 'GHOST');
  check('an undeclared layer is created', Boolean(ghost));
  check('the entity uses it', result.document.entities[0].layerId === ghost.id);
}

// --- Malformed input --------------------------------------------------------
{
  check('binary DXF is refused by name',
    /binary/i.test(api.parseDxfText('AutoCAD Binary DXF\r\n ').error || ''),
    api.parseDxfText('AutoCAD Binary DXF\r\n').error);

  check('an empty file is refused', Boolean(api.parseDxfText('').error));
  check('whitespace is refused', Boolean(api.parseDxfText('   \n  ').error));
  check('a non-DXF file is refused', Boolean(api.parseDxfText('{"format":"json"}').error));
  check('a DXF with no sections is refused',
    Boolean(api.parseDxfText('  0\r\nEOF\r\n').error));

  const truncated = api.parseDxfText(['0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '8'].join('\r\n') + '\r\n');
  check('a truncated file does not throw', truncated.plan || truncated.error);
}

// --- Export refuses an empty drawing ----------------------------------------
{
  await api.newDrawing(true);
  check('exporting an empty drawing is refused', api.exportDxf() === false);
}

// --- Underlays are named as not exportable ----------------------------------
{
  await api.newDrawing(true);
  drawLine({ x: 0, y: 0 }, { x: 5, y: 5 });
  api.startImagePlacement({
    name: 'aerial', widthPx: 100, heightPx: 50,
    data: 'data:image/jpeg;base64,/9j/4AAQ',
  });
  api.commitPoint({ x: 0, y: 0 });
  const plan = api.buildDxfPlan();
  check('an underlay produces a warning',
    plan.warnings.some(warning => /image/i.test(warning)), plan.warnings.join(' | '));
  check('the drawing still exports', api.buildDxfDocument(plan).includes('EOF'));
}

// --- The download name -------------------------------------------------------
{
  await api.newDrawing(true);
  check('the export is named after the drawing', api.dxfDownloadName().endsWith('.dxf'),
    api.dxfDownloadName());
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('FAILURES:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
