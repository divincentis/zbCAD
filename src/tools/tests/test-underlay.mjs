import { boot, DEFAULT_BUNDLE, registerStubImage } from './harness.mjs';

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

// A minimal but structurally real JPEG: SOI, a SOF0 frame header declaring
// 96x64 in three components, then EOI. The PDF writer reads its size and
// component count straight out of these bytes, so a synthetic header exercises
// exactly the code path a real photo would.
const JPEG_BYTES = [
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x60, 0x03,
  0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  0xff, 0xd9,
];
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function toBase64(bytes) {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : NaN;
    const c = index + 2 < bytes.length ? bytes[index + 2] : NaN;
    out += BASE64[a >> 2];
    out += BASE64[((a & 3) << 4) | (Number.isNaN(b) ? 0 : b >> 4)];
    out += Number.isNaN(b) ? '=' : BASE64[((b & 15) << 2) | (Number.isNaN(c) ? 0 : c >> 6)];
    out += Number.isNaN(c) ? '=' : BASE64[c & 63];
  }
  return out;
}
const JPEG_DATA_URL = `data:image/jpeg;base64,${toBase64(JPEG_BYTES)}`;
registerStubImage(JPEG_DATA_URL, 96, 64);

function descriptor(widthPx = 96, heightPx = 64, name = 'roof-aerial') {
  return { name, widthPx, heightPx, data: JPEG_DATA_URL };
}

function placeImage(origin, options = {}) {
  api.startImagePlacement(options.descriptor || descriptor());
  if (options.width) api.submitCommandText(String(options.width));
  api.commitPoint(origin);
  return api.state.underlays[api.state.underlays.length - 1];
}

function drawLine(a, b) {
  api.startCommand('LINE');
  api.commitPoint(a);
  api.commitPoint(b);
  api.finishCurrent();
}

function selectUnderlay(id, add = false) {
  if (!add) api.state.selected.clear();
  api.state.selected.add(api.underlaySelectionId(id));
}

// Which pixel of the raster sits under a world point.
function pixelUnder(underlay, world) {
  const local = api.underlayWorldToLocal(underlay, world);
  return { x: local.x / underlay.unitsPerPixel, y: local.y / underlay.unitsPerPixel };
}

// Where a given pixel of the raster has ended up in world space.
function worldOfPixel(underlay, pixel) {
  const cos = Math.cos(underlay.rotation);
  const sin = Math.sin(underlay.rotation);
  const u = pixel.x * underlay.unitsPerPixel;
  const v = pixel.y * underlay.unitsPerPixel;
  return {
    x: underlay.origin.x + u * cos - v * sin,
    y: underlay.origin.y + u * sin + v * cos,
  };
}

// selectAt measures entity distance against the live cursor, not against the
// point it is handed, because it normally runs straight after a pointer event
// has set it. Tests have to place the cursor themselves.
function clickAt(world, add = false) {
  api.state.mouseScreen = api.worldToScreen(world);
  api.state.mouseWorld = world;
  api.selectAt(world, add);
}

await api.newDrawing(true);
api.setAllSnapTypes(false);

// --- Image sizing rules -----------------------------------------------------
{
  check('fit scale leaves a small image alone', api.imageFitScale(800, 600, 2400) === 1);
  check('fit scale shrinks by the long edge', near(api.imageFitScale(4800, 1200, 2400), 0.5));
  check('fit scale uses height when it is longer', near(api.imageFitScale(1200, 4800, 2400), 0.5));

  const target = api.imageTargetSize(4800, 1200, 2400);
  check('target size caps the long edge', target.widthPx === 2400, `got ${target.widthPx}`);
  check('target size keeps the aspect ratio', target.heightPx === 600, `got ${target.heightPx}`);

  const small = api.imageTargetSize(300, 200, 2400);
  check('an already-small image is not enlarged', small.widthPx === 300 && small.heightPx === 200);

  check('file name loses its extension', api.underlayNameFromFile('site plan.PNG') === 'site plan');
  check('a blank file name still yields a name', api.underlayNameFromFile('') === 'image');
}

// --- Placement --------------------------------------------------------------
{
  await api.newDrawing(true);
  const placed = placeImage({ x: 10, y: 20 });
  check('IMAGE places one underlay', api.state.underlays.length === 1);
  check('placement records the origin', placed.origin.x === 10 && placed.origin.y === 20);
  check('placement defaults to one unit per pixel', placed.unitsPerPixel === 1);
  check('placement records the pixel size', placed.widthPx === 96 && placed.heightPx === 64);
  check('a placed image is faded by default', placed.fade > 0);
  check('a placed image does not plot by default', placed.plot === false);
  check('a placed image is not locked', placed.locked === false);
  check('the placed image is selected', api.state.selected.has(api.underlaySelectionId(placed.id)));
  check('placement returns to SELECT', api.mode === 'SELECT');

  check('underlay width is pixels times scale', near(api.underlayWidth(placed), 96));
  check('underlay height is pixels times scale', near(api.underlayHeight(placed), 64));
}

// --- Typed width at placement time ------------------------------------------
{
  await api.newDrawing(true);
  const placed = placeImage({ x: 0, y: 0 }, { width: 480 });
  check('a typed width sets the scale', near(api.underlayWidth(placed), 480), `got ${api.underlayWidth(placed)}`);
  check('a typed width keeps the aspect ratio', near(api.underlayHeight(placed), 320),
    `got ${api.underlayHeight(placed)}`);
}

// --- Geometry: corners, bbox, containment -----------------------------------
{
  await api.newDrawing(true);
  const placed = placeImage({ x: 5, y: 7 }, { width: 96 });
  const corners = api.underlayCorners(placed);
  check('corner 0 is the origin', near(corners[0].x, 5) && near(corners[0].y, 7));
  check('corner 2 is the far corner', near(corners[2].x, 101) && near(corners[2].y, 71));
  const box = api.underlayBBox(placed);
  check('bbox spans the image', near(box.minX, 5) && near(box.maxX, 101)
    && near(box.minY, 7) && near(box.maxY, 71));
  check('a point inside is contained', api.underlayContainsPoint(placed, { x: 50, y: 40 }));
  check('a point outside is not contained', !api.underlayContainsPoint(placed, { x: 4.9, y: 40 }));
  check('a point past the top is not contained', !api.underlayContainsPoint(placed, { x: 50, y: 71.1 }));
}

// --- Calibration ------------------------------------------------------------
// The realistic case: two arbitrary points that land on no quadrant, endpoint
// or axis, at an angle that is not a multiple of 45°, which is what a user
// picking two roof corners off an aerial actually produces.
{
  await api.newDrawing(true);
  const placed = placeImage({ x: 0, y: 0 });
  const from = { x: 13.4271, y: 8.9137 };
  const to = { x: 61.8823, y: 39.2664 };
  const measuredBefore = Math.hypot(to.x - from.x, to.y - from.y);
  const KNOWN = 125.75;

  api.startCommand('CALIBRATE');
  check('CALIBRATE picks the only image automatically', api.underlayStage === 'FIRST',
    `stage was ${api.underlayStage}`);
  api.commitPoint(from);
  api.commitPoint(to);
  check('CALIBRATE asks for the distance last', api.underlayStage === 'DISTANCE',
    `stage was ${api.underlayStage}`);
  api.submitCommandText(String(KNOWN));

  const after = api.state.underlays[0];
  check('calibration scaled the image', !near(after.unitsPerPixel, 1));

  // The property that matters, stated the way a user would: the two features
  // of the image that were picked are now the typed distance apart on the
  // drawing. The world points themselves never move — the image moves under
  // them — so the assertion has to follow the pixels, not the picks.
  const pixelFrom = pixelUnder(placed, from);
  const pixelTo = pixelUnder(placed, to);
  const featureFrom = worldOfPixel(after, pixelFrom);
  const featureTo = worldOfPixel(after, pixelTo);
  const measuredAfter = Math.hypot(featureTo.x - featureFrom.x, featureTo.y - featureFrom.y);
  check('the calibrated distance matches what was typed', near(measuredAfter, KNOWN, 1e-6),
    `got ${measuredAfter}, wanted ${KNOWN}`);

  // The first pick is the anchor: the image feature under it must still be
  // under it, or the thing the user measured from walks out from under them.
  check('the feature under the first pick stays put',
    near(featureFrom.x, from.x, 1e-9) && near(featureFrom.y, from.y, 1e-9),
    `feature moved to ${featureFrom.x},${featureFrom.y} from ${from.x},${from.y}`);

  // And the second feature has moved, since the image grew around the anchor.
  const featureToBefore = worldOfPixel(placed, pixelTo);
  check('the far feature moves when the image is rescaled',
    !near(featureTo.x, featureToBefore.x, 1e-6));

  const expectedFactor = KNOWN / measuredBefore;
  check('the scale factor is the distance ratio', near(after.unitsPerPixel, expectedFactor, 1e-9),
    `got ${after.unitsPerPixel}, wanted ${expectedFactor}`);
  api.undo();
  check('undo restores the original scale', near(api.state.underlays[0].unitsPerPixel, 1));
}

// --- Calibration refuses nonsense -------------------------------------------
{
  await api.newDrawing(true);
  const placed = placeImage({ x: 0, y: 0 });
  const result = api.calibrateUnderlay(placed, { x: 3, y: 3 }, { x: 3, y: 3 }, 10);
  check('two identical points are refused', Boolean(result.error));
  const negative = api.calibrateUnderlay(placed, { x: 0, y: 0 }, { x: 10, y: 0 }, -5);
  check('a negative distance is refused', Boolean(negative.error));
  const zero = api.calibrateUnderlay(placed, { x: 0, y: 0 }, { x: 10, y: 0 }, 0);
  check('a zero distance is refused', Boolean(zero.error));
}

// --- Transforms over a mixed selection --------------------------------------
{
  await api.newDrawing(true);
  const placed = placeImage({ x: 0, y: 0 }, { width: 96 });
  drawLine({ x: 0, y: 0 }, { x: 10, y: 10 });
  const lineId = api.state.entities[0].id;

  api.state.selected.clear();
  api.state.selected.add(lineId);
  api.state.selected.add(api.underlaySelectionId(placed.id));

  api.startCommand('MOVE');
  api.commitPoint({ x: 0, y: 0 });
  api.commitPoint({ x: 7.25, y: -3.5 });

  const movedUnderlay = api.state.underlays[0];
  const movedLine = api.state.entities[0];
  check('MOVE carries the underlay', near(movedUnderlay.origin.x, 7.25) && near(movedUnderlay.origin.y, -3.5));
  check('MOVE carries the geometry too', near(movedLine.a.x, 7.25) && near(movedLine.a.y, -3.5));
  check('MOVE leaves the image scale alone', near(movedUnderlay.unitsPerPixel, 1));

  api.undo();
  check('undo restores the underlay position', near(api.state.underlays[0].origin.x, 0));
  check('undo restores the line together with it', near(api.state.entities[0].a.x, 0));
  api.redo();
  check('redo re-applies to the underlay', near(api.state.underlays[0].origin.x, 7.25));
}

// --- ROTATE -----------------------------------------------------------------
{
  await api.newDrawing(true);
  const placed = placeImage({ x: 10, y: 0 }, { width: 96 });
  selectUnderlay(placed.id);
  api.startCommand('ROTATE');
  api.commitPoint({ x: 0, y: 0 });
  api.submitCommandText('90');

  const rotated = api.state.underlays[0];
  check('ROTATE turns the image', near(rotated.rotation, Math.PI / 2, 1e-9),
    `rotation ${rotated.rotation}`);
  check('ROTATE swings the origin about the base',
    near(rotated.origin.x, 0, 1e-9) && near(rotated.origin.y, 10, 1e-9),
    `origin ${rotated.origin.x},${rotated.origin.y}`);

  // A rotated image still measures the same: rotation must not touch scale.
  check('ROTATE leaves the size alone', near(api.underlayWidth(rotated), 96));

  // The corner opposite the origin should have rotated with it.
  const corners = api.underlayCorners(rotated);
  check('the rotated frame stays rectangular',
    near(Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y), 96, 1e-6)
    && near(Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y), 64, 1e-6));
}

// --- SCALE ------------------------------------------------------------------
{
  await api.newDrawing(true);
  const placed = placeImage({ x: 4, y: 6 }, { width: 96 });
  selectUnderlay(placed.id);
  api.startCommand('SCALE');
  api.commitPoint({ x: 0, y: 0 });
  api.submitCommandText('2.5');

  const scaled = api.state.underlays[0];
  check('SCALE multiplies the image scale', near(scaled.unitsPerPixel, 2.5));
  check('SCALE moves the origin away from the base',
    near(scaled.origin.x, 10) && near(scaled.origin.y, 15));
  check('SCALE changes the measured width', near(api.underlayWidth(scaled), 240));
}

// --- MIRROR keeps the raster readable ---------------------------------------
{
  await api.newDrawing(true);
  const placed = placeImage({ x: 10, y: 10 }, { width: 96 });
  selectUnderlay(placed.id);
  api.startCommand('MIRROR');
  api.commitPoint({ x: 0, y: 0 });
  api.commitPoint({ x: 0, y: 10 });
  api.submitCommandText('Y');

  const mirrored = api.state.underlays[0];
  const box = api.underlayBBox(mirrored);
  // Reflected about x = 0, the image that spanned x 10..106 must now span
  // -106..-10, and its scale must be unchanged.
  check('MIRROR reflects the frame', near(box.minX, -106, 1e-6) && near(box.maxX, -10, 1e-6),
    `box ${box.minX}..${box.maxX}`);
  check('MIRROR keeps the image scale', near(mirrored.unitsPerPixel, 1));
  check('MIRROR keeps the image the same size', near(api.underlayWidth(mirrored), 96));
}

// --- Selection, locking and layers ------------------------------------------
{
  await api.newDrawing(true);
  const placed = placeImage({ x: 0, y: 0 }, { width: 100 });
  api.state.selected.clear();

  clickAt({ x: 50, y: 30 });
  check('clicking an image selects it', api.state.selected.has(api.underlaySelectionId(placed.id)));

  api.state.selected.clear();
  clickAt({ x: -20, y: -20 });
  check('clicking away from it selects nothing', api.state.selected.size === 0);

  // Locking is what lets you trace over an image without fighting it.
  api.state.underlays[0].locked = true;
  api.state.selected.clear();
  clickAt({ x: 50, y: 30 });
  check('a locked image is not selectable', api.state.selected.size === 0);
  check('a locked image reports itself unselectable', !api.underlayIsSelectable(api.state.underlays[0]));
  api.state.underlays[0].locked = false;

  // Geometry drawn on top must win a contested pick.
  drawLine({ x: 40, y: 30 }, { x: 60, y: 30 });
  const lineId = api.state.entities[0].id;
  api.state.selected.clear();
  clickAt({ x: 50, y: 30 });
  check('geometry outranks the image underneath it', api.state.selected.has(lineId),
    `selected ${[...api.state.selected].join(',')}`);

  // Just off the line, still inside the frame, the image is offered again.
  api.state.selected.clear();
  clickAt({ x: 50, y: 5 });
  check('clicking clear of the geometry picks the image',
    api.state.selected.has(api.underlaySelectionId(placed.id)),
    `selected ${[...api.state.selected].join(',')}`);
}

// --- Hidden and locked layers -----------------------------------------------
{
  await api.newDrawing(true);
  // The current layer cannot be locked or hidden, so the image goes on a
  // second layer, which is also the realistic arrangement: an underlay lives
  // on its own layer precisely so it can be switched off in one action.
  api.createLayer('Underlay');
  const imageLayer = api.layers.find(layer => layer.name === 'Underlay');
  api.setCurrentLayer(imageLayer.id);
  const placed = placeImage({ x: 0, y: 0 }, { width: 100 });
  check('the image lands on the current layer', api.state.underlays[0].layerId === imageLayer.id);
  api.setCurrentLayer('0');

  selectUnderlay(placed.id);
  api.toggleLayerLock(imageLayer.id);
  check('an image on a locked layer is not selectable', !api.underlayIsSelectable(api.state.underlays[0]));
  check('locking a layer drops its image from the selection',
    !api.state.selected.has(api.underlaySelectionId(placed.id)));
  api.toggleLayerLock(imageLayer.id);
  check('unlocking the layer restores selectability', api.underlayIsSelectable(api.state.underlays[0]));

  selectUnderlay(placed.id);
  api.toggleLayerVisibility(imageLayer.id);
  check('an image on a hidden layer is not selectable', !api.underlayIsSelectable(api.state.underlays[0]));
  check('hiding a layer drops its image from the selection',
    !api.state.selected.has(api.underlaySelectionId(placed.id)));
  api.toggleLayerVisibility(imageLayer.id);

  check('the image is still there', api.state.underlays.length === 1 && placed.id === api.state.underlays[0].id);
}

// --- Erase ------------------------------------------------------------------
{
  await api.newDrawing(true);
  const placed = placeImage({ x: 0, y: 0 }, { width: 100 });
  drawLine({ x: 0, y: 0 }, { x: 5, y: 5 });
  selectUnderlay(placed.id);
  api.deleteSelected();
  check('erase removes the image', api.state.underlays.length === 0);
  check('erase leaves the geometry alone', api.state.entities.length === 1);
  api.undo();
  check('undo brings the image back', api.state.underlays.length === 1);
}

// --- Zoom extents -----------------------------------------------------------
{
  await api.newDrawing(true);
  placeImage({ x: 0, y: 0 }, { width: 1000 });
  const withImage = api.viewScale;
  api.zoomExtents();
  check('zoom extents fits an image-only drawing', Number.isFinite(api.viewScale) && api.viewScale > 0);
  check('zoom extents zoomed out for a large image', api.viewScale < 1.5,
    `scale ${api.viewScale} (was ${withImage})`);
}

// --- Persistence ------------------------------------------------------------
{
  await api.newDrawing(true);
  const placed = placeImage({ x: 3.5, y: -2.25 }, { width: 480 });
  api.startCommand('CALIBRATE');
  api.commitPoint({ x: 10, y: 10 });
  api.commitPoint({ x: 40.5, y: 33.25 });
  api.submitCommandText('75');
  const before = api.state.underlays[0];

  const text = api.exportDocumentText(false);
  const parsed = api.parseDocumentText(text);
  check('a drawing with an image validates', !parsed.error, parsed.error);
  check('the document carries the image', parsed.document.underlays.length === 1);

  await api.importDocumentText(text, 'round-trip.zbCAD.json');
  const after = api.state.underlays[0];
  check('round trip keeps the origin', near(after.origin.x, before.origin.x) && near(after.origin.y, before.origin.y));
  check('round trip keeps the scale', near(after.unitsPerPixel, before.unitsPerPixel));
  check('round trip keeps the pixel size', after.widthPx === before.widthPx && after.heightPx === before.heightPx);
  check('round trip keeps the image data', after.data === before.data);
  check('round trip keeps the name', after.name === before.name);
  check('round trip keeps the fade', after.fade === before.fade);
}

// --- Older documents still load ---------------------------------------------
{
  await api.newDrawing(true);
  drawLine({ x: 0, y: 0 }, { x: 10, y: 0 });
  const current = JSON.parse(api.exportDocumentText(false));
  const legacy = { ...current, version: 6 };
  delete legacy.underlays;
  delete legacy.nextUnderlayId;

  const parsed = api.parseDocumentText(JSON.stringify(legacy));
  check('a version 6 document still loads', !parsed.error, parsed.error);
  check('a version 6 document has no underlays', Array.isArray(parsed.document.underlays)
    && parsed.document.underlays.length === 0);

  await api.importDocumentText(JSON.stringify(legacy), 'legacy.zbCAD.json');
  check('loading a v6 file leaves the underlay table empty', api.state.underlays.length === 0);
  check('loading a v6 file keeps its geometry', api.state.entities.length === 1);
}

// --- A malformed underlay is rejected, not silently accepted -----------------
{
  await api.newDrawing(true);
  placeImage({ x: 0, y: 0 });
  const document = JSON.parse(api.exportDocumentText(false));

  const noData = JSON.parse(JSON.stringify(document));
  noData.underlays[0].data = 'not-a-data-url';
  check('an underlay without image data is rejected',
    Boolean(api.parseDocumentText(JSON.stringify(noData)).error));

  const badScale = JSON.parse(JSON.stringify(document));
  badScale.underlays[0].unitsPerPixel = 0;
  check('a zero scale is rejected', Boolean(api.parseDocumentText(JSON.stringify(badScale)).error));

  const badLayer = JSON.parse(JSON.stringify(document));
  badLayer.underlays[0].layerId = 'no-such-layer';
  check('an unknown layer is rejected', Boolean(api.parseDocumentText(JSON.stringify(badLayer)).error));

  const badSize = JSON.parse(JSON.stringify(document));
  badSize.underlays[0].widthPx = 0;
  check('a zero pixel width is rejected', Boolean(api.parseDocumentText(JSON.stringify(badSize)).error));
}

// --- Plotting ---------------------------------------------------------------
{
  await api.newDrawing(true);
  const placed = placeImage({ x: 0, y: 0 }, { width: 100 });
  drawLine({ x: 0, y: 0 }, { x: 100, y: 0 });

  const settings = { ...api.defaultPlotSettings() };
  const planWithout = api.buildPlotPlan(settings);
  check('an image off the plot emits no image op',
    !planWithout.ops.some(op => op.kind === 'image'));
  check('a non-plotting image still warns that it was left out',
    planWithout.warnings.some(warning => warning.includes('image')),
    planWithout.warnings.join(' | '));

  api.state.underlays[0].plot = true;
  const plan = api.buildPlotPlan(settings);
  const imageOps = plan.ops.filter(op => op.kind === 'image');
  check('a plotting image emits one image op', imageOps.length === 1);
  check('the image op is emitted before the line work',
    plan.ops.findIndex(op => op.kind === 'image') === 0);
  check('the plan counts the plotted image', plan.underlayCount === 1);

  const op = imageOps[0];
  check('the image op carries the raster', op.data === JPEG_DATA_URL);
  check('the image op carries the pixel size', op.pixelWidth === 96 && op.pixelHeight === 64);
  check('the image op has an alpha below one when faded', op.alpha > 0 && op.alpha < 1,
    `alpha ${op.alpha}`);

  // The two edge vectors must be perpendicular and in the plan's mm scale.
  const dot = op.edgeX.x * op.edgeY.x + op.edgeX.y * op.edgeY.y;
  check('the image frame is square on an unrotated image', near(dot, 0, 1e-6), `dot ${dot}`);
  check('the image frame is the plotted width',
    near(Math.hypot(op.edgeX.x, op.edgeX.y), 100 * plan.mmPerUnit, 1e-6));
  check('the image frame is the plotted height',
    near(Math.hypot(op.edgeY.x, op.edgeY.y), (100 * 64 / 96) * plan.mmPerUnit, 1e-6));
}

// --- Image-only drawings can still be plotted -------------------------------
{
  await api.newDrawing(true);
  placeImage({ x: 0, y: 0 }, { width: 100 });
  api.state.underlays[0].plot = true;
  const plan = api.buildPlotPlan({ ...api.defaultPlotSettings() });
  check('a drawing that is only an image plots', !plan.error, plan.error);
  check('extents cover the image', plan.area && near(plan.area.maxX, 100, 1e-6));
}

// --- PDF embedding ----------------------------------------------------------
{
  await api.newDrawing(true);
  placeImage({ x: 0, y: 0 }, { width: 100 });
  api.state.underlays[0].plot = true;
  const plan = api.buildPlotPlan({ ...api.defaultPlotSettings() });
  const pdf = api.buildPdfDocument(plan, 'Underlay test');

  check('the PDF declares an image XObject', pdf.includes('/Subtype /Image'));
  check('the PDF uses the ASCII85 + DCT filter chain',
    pdf.includes('/Filter [/ASCII85Decode /DCTDecode]'));
  check('the PDF takes the size from the JPEG header',
    pdf.includes('/Width 96') && pdf.includes('/Height 64'));
  check('the PDF names the colour space', pdf.includes('/ColorSpace /DeviceRGB'));
  check('the page resources reference the image', /\/XObject << \/Im0 \d+ 0 R >>/.test(pdf));
  check('the content stream draws the image', pdf.includes('/Im0 Do'));
  check('the content stream sets a transform for it', /[\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ cm/.test(pdf));
  check('a faded image gets a transparency state', pdf.includes('/Type /ExtGState'));
  check('the transparency state is referenced', pdf.includes('/GSa0 gs'));
  check('the ASCII85 stream is terminated', pdf.includes('~>'));

  // The whole point of ASCII85: the file must stay 7-bit so it can travel as a
  // string through downloadTextFile without a UTF-8 encode corrupting it.
  let highByte = -1;
  for (let index = 0; index < pdf.length; index++) {
    if (pdf.charCodeAt(index) > 126) { highByte = index; break; }
  }
  check('the PDF is pure ASCII', highByte === -1, `first high byte at ${highByte}`);

  check('the trailer still points at the Info object', pdf.includes('/Info 7 0 R'));

  // xref offsets must still describe the file after the extra objects.
  const xrefIndex = pdf.indexOf('\nxref\n');
  const startxref = Number(/startxref\n(\d+)/.exec(pdf)[1]);
  check('startxref points at the xref table', startxref === xrefIndex + 1,
    `startxref ${startxref}, xref at ${xrefIndex + 1}`);
  const offsets = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map(match => Number(match[1]));
  check('every xref offset lands on an object header',
    offsets.every((offset, index) => pdf.startsWith(`${index + 1} 0 obj`, offset)),
    `offsets ${offsets.join(',')}`);
}

// --- A greyscale JPEG is described as greyscale -----------------------------
{
  const greyBytes = JPEG_BYTES.slice();
  greyBytes[11] = 0x01;
  const greyUrl = `data:image/jpeg;base64,${toBase64(greyBytes)}`;
  registerStubImage(greyUrl, 96, 64);
  await api.newDrawing(true);
  placeImage({ x: 0, y: 0 }, { descriptor: { name: 'grey', widthPx: 96, heightPx: 64, data: greyUrl } });
  api.state.underlays[0].plot = true;
  const plan = api.buildPlotPlan({ ...api.defaultPlotSettings() });
  const pdf = api.buildPdfDocument(plan, 'Grey');
  check('a single-component JPEG is DeviceGray', pdf.includes('/ColorSpace /DeviceGray'));
}

// --- Unit changes carry the image -------------------------------------------
{
  await api.newDrawing(true);
  const placed = placeImage({ x: 10, y: 0 }, { width: 120 });
  const widthBefore = api.underlayWidth(api.state.underlays[0]);

  api.openUnitsDialog();
  api.setPendingUnits({ drawingUnit: 'feet', format: 'decimal', precision: 2 });
  api.setUnitRescale(true);
  api.applyUnitsDialog();

  const after = api.state.underlays[0];
  // 120 inches is 10 feet: the image must shrink by the same factor the
  // geometry does, or a calibrated underlay stops lining up with its tracing.
  check('a unit change rescales the image', near(api.underlayWidth(after), widthBefore / 12, 1e-9),
    `width ${api.underlayWidth(after)} from ${widthBefore}`);
  check('a unit change moves the image origin too', near(after.origin.x, 10 / 12, 1e-9),
    `origin ${after.origin.x}`);
}

// --- The properties dialog --------------------------------------------------
{
  await api.newDrawing(true);
  const placed = placeImage({ x: 0, y: 0 }, { width: 100 });
  api.openUnderlayDialog();
  check('the dialog opens for a single image', api.underlayDialogVisible);
  check('the dialog drafts the current values', api.pendingUnderlay
    && api.pendingUnderlay.id === placed.id);

  api.setPendingUnderlay({ fade: 60, plot: true, locked: true });
  check('the draft does not touch the document yet',
    api.state.underlays[0].fade !== 60 || api.state.underlays[0].plot !== true);

  api.applyUnderlayDialog();
  check('apply writes the fade', api.state.underlays[0].fade === 60);
  check('apply writes the plot flag', api.state.underlays[0].plot === true);
  check('apply writes the lock', api.state.underlays[0].locked === true);
  check('apply closes the dialog', !api.underlayDialogVisible);

  api.undo();
  check('the dialog change is undoable', api.state.underlays[0].fade !== 60);

  // Cancel must leave nothing behind.
  api.openUnderlayDialog();
  api.setPendingUnderlay({ fade: 12 });
  api.closeUnderlayDialog();
  check('cancel discards the draft', api.state.underlays[0].fade !== 12);
  check('cancel closes the dialog', !api.underlayDialogVisible);

  api.openUnderlayDialog();
  api.deleteUnderlayFromDialog();
  check('the dialog can delete the image', api.state.underlays.length === 0);
  check('deleting closes the dialog', !api.underlayDialogVisible);
}

// --- Rendering does not throw with or without a decoded raster --------------
{
  await api.newDrawing(true);
  placeImage({ x: 0, y: 0 }, { width: 100 });
  let threw = null;
  try { api.drawNow(); } catch (error) { threw = error; }
  check('rendering an undecoded image does not throw', threw === null, String(threw));

  // Let the stub image resolve, then draw again: this is the path that calls
  // ctx.drawImage for real.
  await new Promise(resolve => setTimeout(resolve, 0));
  threw = null;
  try { api.drawNow(); } catch (error) { threw = error; }
  check('rendering a decoded image does not throw', threw === null, String(threw));
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('FAILURES:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
