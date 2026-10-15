// The engine half of pano.html: which way each point of the screen looks for both lenses,
// what a 360 photo's metadata says about where it sits on the sphere, how big a snapshot
// comes out, how a photo too big for the GPU is cut up, and what saved settings may carry.
import {boot, suite} from './harness.mjs';

const ev = boot(), t = suite();
const E = ev(`({ newView, clampView, viewRot, screenToDir, dirToScreen, dirToUV, aimAt, projScale, dragRate, frameIn,
  nativeLong, outputSize, snapshotSize, readGPano, initialView, panoArea, tilePlan, snapName, checkSettings, newSettings,
  fovToSlider, sliderToFov, wrapDeg, PROJ_STANDARD, PROJ_WIDE, FOV_LIMITS, DEG })`);
const near = (a, b, eps = 1e-9) => Array.isArray(a) ? a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps) : Math.abs(a - b) < eps;
const angle = (a, b) => Math.atan2(Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
const V = o => E.clampView({ ...E.newView(), ...o });
const STD = E.PROJ_STANDARD, WIDE = E.PROJ_WIDE;

// ---- which way the camera looks ----
t.ok(near(E.screenToDir(0, 0, V({})), [0, 0, 1]), 'the untouched view looks at the centre of the photo');
t.ok(near(E.dirToUV([0, 0, 1]), [0.5, 0.5]), 'straight ahead is the middle of the photo');
t.ok(near(E.screenToDir(0, 0, V({ yaw: 90 })), [1, 0, 0]), 'heading 90° turns right');
t.ok(near(E.dirToUV([1, 0, 0]), [0.75, 0.5]), 'right of centre is three quarters of the way across the photo');
t.ok(near(E.dirToUV([-1, 0, 0]), [0.25, 0.5]), 'left of centre is a quarter of the way across');
t.ok(near(E.screenToDir(0, 0, V({ pitch: 30 }))[1], Math.sin(30 * E.DEG)), 'tilt up looks up');
t.ok(near(E.dirToUV([0, 1, 0])[1], 0) && near(E.dirToUV([0, -1, 0])[1], 1), 'straight up is the top row, straight down the bottom');
t.ok(E.screenToDir(0, 1, V({}))[1] > 0 && E.screenToDir(1, 0, V({}))[0] > 0, 'screen up is up and screen right is right');

for (const proj of [STD, WIDE]) for (const fov of [proj === STD ? 20 : 40, 90, proj === STD ? 130 : 300]) {
  const v = V({ yaw: 37, pitch: -12, fov, proj }), c = E.screenToDir(0, 0, v);
  t.ok(near(angle(c, E.screenToDir(1, 0, v)), fov / 2 * E.DEG, 1e-9), `${proj ? 'wide' : 'standard'} ${fov}°: the long side's edge is half the field of view from the centre`);
}

// Level rolls about the line of sight: the centre stays put and the horizon turns.
{
  const flat = V({ yaw: 20 }), rolled = V({ yaw: 20, roll: 10 });
  t.ok(near(E.screenToDir(0, 0, flat), E.screenToDir(0, 0, rolled)), 'level leaves the centre where it was');
  const r = E.screenToDir(1, 0, rolled);
  t.ok(near(Math.asin(r[1]), Math.asin(E.screenToDir(1, 0, flat)[1]) + 0, 0.3) && Math.abs(r[1]) > 0.05, 'level lifts or drops the side of the frame off the horizon');
}

// dirToScreen undoes screenToDir everywhere on screen, rolled or not, for both lenses.
{
  let worst = 0;
  for (const proj of [STD, WIDE]) for (const roll of [0, 7.5, -30]) {
    const v = V({ yaw: -140, pitch: 55, roll, fov: proj ? 220 : 100, proj });
    for (const nx of [-1, -0.4, 0, 0.3, 1]) for (const ny of [-0.6, 0, 0.5]) {
      const back = E.dirToScreen(E.screenToDir(nx, ny, v), v);
      worst = Math.max(worst, Math.hypot(back[0] - nx, back[1] - ny));
    }
  }
  t.ok(worst < 1e-9, `dirToScreen undoes screenToDir (worst ${worst.toExponential(1)})`);
  t.eq(E.dirToScreen([0, 0, -1], V({})), null, 'a standard lens cannot see behind it');
}
t.ok([0, 1, 2].every(i => near(E.viewRot(V({ yaw: 33, pitch: 21, roll: -8 })).filter((_, k) => k % 3 === i).reduce((s, x) => s + x * x, 0), 1)),
  'the view rotation is a rotation: unit columns');

// Double-clicking turns to that spot: afterwards it sits in the middle of the frame.
{
  const v = V({ yaw: 10, pitch: 5, fov: 80 }), d = E.screenToDir(0.6, -0.3, v), a = E.aimAt(d, v);
  t.ok(near(E.dirToScreen(d, a), [0, 0], 1e-9), 'aimAt centres the direction');
  t.ok(a.fov === v.fov && a.proj === v.proj, 'aimAt keeps the zoom and the lens');
}

// A drag of one pixel turns the view by one pixel's worth at the centre of the frame.
{
  const v = V({ fov: 90 }), half = 1000, k = E.dragRate(v, half);
  t.ok(near(angle(E.screenToDir(0, 0, v), E.screenToDir(1 / half, 0, v)), k, 1e-9), 'dragRate is the angle of one pixel at the centre (standard)');
  const w = V({ fov: 200, proj: WIDE }), kw = E.dragRate(w, half);
  t.ok(near(angle(E.screenToDir(0, 0, w), E.screenToDir(1 / half, 0, w)) / kw, 1, 1e-6), 'and for the wide lens');
}

// ---- view limits ----
t.eq(E.clampView({ yaw: 190, pitch: 120, roll: 80, fov: 500, proj: STD }), { yaw: -170, pitch: 90, roll: 45, fov: 140, proj: STD }, 'clampView wraps heading and limits the rest');
t.eq(E.clampView({ yaw: -180, pitch: 0, roll: 0, fov: 1, proj: WIDE }).fov, E.FOV_LIMITS[WIDE][0], 'the wide lens has its own limits');
t.eq(E.wrapDeg(-180), 180, 'heading −180 and 180 are the same, written as 180');
t.eq(E.clampView({ proj: 'nonsense' }).proj, STD, 'an unknown lens falls back to standard');
for (const proj of [STD, WIDE]) {
  const [lo, hi] = E.FOV_LIMITS[proj];
  t.ok(near(E.sliderToFov(0, proj), hi) && near(E.sliderToFov(1000, proj), lo), `zoom slider spans the ${proj ? 'wide' : 'standard'} limits, right zooms in`);
  t.eq(E.fovToSlider(E.sliderToFov(437, proj), proj), 437, 'zoom slider round trips');
}

// ---- the frame and the saved image ----
t.eq(E.frameIn(1600, 900, 'screen'), { w: 1600, h: 900, halfLong: 800 }, '"fill the viewer" is the whole canvas');
{
  const f = E.frameIn(1600, 900, '1:1', 20);
  t.ok(near(f.w, 860) && near(f.h, 860), 'a square frame fits the canvas height less the margin');
  const p = E.frameIn(1600, 900, '9:16', 20);
  t.ok(near(p.h, 860) && near(p.w / p.h, 9 / 16) && near(p.halfLong, 430), 'a portrait frame: the long side is its height');
  const wide = E.frameIn(1000, 900, '16:9', 20);
  t.ok(near(wide.w, 960) && near(wide.halfLong, 480), 'a wide frame in a squarish canvas is limited by width');
}
t.ok(near(E.nativeLong(11904, V({ fov: 90 })), 11904 / Math.PI, 1e-6), 'native size at 90°: tan 45° × width / π');
t.ok(E.nativeLong(11904, V({ fov: 30 })) < E.nativeLong(11904, V({ fov: 90 })), 'zooming in leaves fewer photo pixels in the frame');
t.eq(E.outputSize(16 / 9, 1920), [1920, 1080], '16:9 at 1920');
t.eq(E.outputSize(9 / 16, 1920), [1080, 1920], '9:16 is 1920 tall');
t.eq(E.outputSize(1, 99999), [16384, 16384], 'no side past 16384');
{
  const s = { ...E.newSettings(), aspect: '3:2', size: 'native' };
  t.eq(E.snapshotSize(s, V({ fov: 90 }), 11904, 2), [3789, 2526], 'native: as many pixels as the photo holds at this zoom');
  t.eq(E.snapshotSize(s, V({ fov: 5 }), 11904, 2), [640, 427], 'native never goes below 640 px');
  t.eq(E.snapshotSize({ ...s, size: '3840' }, V({ fov: 90 }), 11904, 2, 2048), [2048, 1365], 'and never past what the GPU can render');
  t.eq(E.snapshotSize({ ...s, aspect: 'screen', size: '1920' }, V({}), 11904, 2), [1920, 960], '"fill the viewer" takes the canvas shape');
}

// ---- the photo's metadata ----
const xmpAttr = `junk<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description GPano:ProjectionType="equirectangular"
  GPano:FullPanoWidthPixels="6000" GPano:FullPanoHeightPixels="3000" GPano:CroppedAreaImageWidthPixels="6000"
  GPano:CroppedAreaImageHeightPixels="1000" GPano:CroppedAreaLeftPixels="0" GPano:CroppedAreaTopPixels="1200"
  GPano:PoseHeadingDegrees="200.5" GPano:InitialViewHeadingDegrees="230"/></rdf:RDF></x:xmpmeta>junk`;
const xmpElem = `<x:xmpmeta><rdf:RDF><rdf:Description><GPano:ProjectionType>equirectangular</GPano:ProjectionType>
  <GPano:InitialViewPitchDegrees>-15</GPano:InitialViewPitchDegrees></rdf:Description></rdf:RDF></x:xmpmeta>`;
{
  const a = E.readGPano(xmpAttr);
  t.eq([a.projection, a.fullW, a.cropH, a.top, a.pose, a.heading], ['equirectangular', 6000, 1000, 1200, 200.5, 230], 'GPano written as attributes');
  const b = E.readGPano(xmpElem);
  t.eq([b.projection, b.pitch, b.fullW], ['equirectangular', -15, null], 'GPano written as elements');
  t.eq(E.readGPano('no metadata here'), null, 'no XMP: no metadata');
  t.eq(E.readGPano('<x:xmpmeta><dc:title>hi</dc:title></x:xmpmeta>'), null, 'XMP without GPano: no metadata');

  t.ok(near(E.initialView(a).yaw, 29.5), 'initial heading is taken relative to the photo centre\'s heading');
  t.eq(E.initialView(E.readGPano(xmpAttr.replace(/GPano:PoseHeadingDegrees="[^"]*"/, ''))).yaw, 0, 'an initial heading without the pose is ignored');
  t.eq(E.initialView(b).pitch, -15, 'initial tilt is used');
  t.eq(E.initialView(null), E.newView(), 'no metadata: the default view');

  const area = E.panoArea(a, 3000, 500);
  t.ok(near(area.y, 0.4) && near(area.h, 1 / 3) && near(area.w, 1) && !area.full, 'a cropped band sits where the metadata puts it');
  t.ok(near(area.fullW, 3000), 'a photo resized after its metadata was written scales the sphere with it');
}
t.eq(E.panoArea(null, 11904, 5952), { x: 0, y: 0, w: 1, h: 1, fullW: 11904, full: true }, 'a 2:1 photo is the whole sphere');
{
  const p = E.panoArea(null, 8000, 2000);
  t.ok(!p.full && near(p.h, 0.5) && near(p.y, 0.25), 'a 4:1 photo without metadata wraps round, centred on the horizon');
}

// ---- tiling ----
{
  t.eq(E.tilePlan(5760, 2880, 8192).tiles.length, 1, 'a photo that fits is one texture');
  const big = E.tilePlan(11904, 5952, 8192, 32);
  t.eq([big.cols, big.rows], [2, 1], 'an 8K Insta360 photo on an 8192 GPU: two side by side');
  t.ok(big.tiles.every(x => x.src.w <= 8192 && x.src.h <= 8192), 'every tile fits the GPU, padding and all');
  const huge = E.tilePlan(30000, 15000, 4096, 32);
  t.ok(huge.tiles.every(x => x.src.w <= 4096 && x.src.h <= 4096), 'a very large photo on a small GPU still fits');
  let area = 0, inside = true;
  for (const x of huge.tiles) {
    area += x.core.w * x.core.h;
    inside &&= x.src.x <= x.core.x && x.src.y <= x.core.y && x.src.x + x.src.w >= x.core.x + x.core.w && x.src.y + x.src.h >= x.core.y + x.core.h
      && x.src.x >= 0 && x.src.y >= 0 && x.src.x + x.src.w <= 30000 && x.src.y + x.src.h <= 15000;
  }
  t.eq(area, 30000 * 15000, 'tile cores cover the photo exactly once');
  t.ok(inside, 'each tile holds its core and stays inside the photo');
  const mid = big.tiles[1];
  t.ok(mid.src.x === mid.core.x - 32, 'tiles carry their neighbours\' pixels across a join');
}

// ---- files and settings ----
t.eq(E.snapName('IMG_20260901_101500_00_012.jpg', V({ yaw: -45.4, pitch: 10.6, fov: 72 }), 'jpg'), 'IMG_20260901_101500_00_012_h-45_t11_fov72.jpg', 'snapshot name records the view');
t.eq(E.snapName('roof deck (1).insp', V({ proj: WIDE, fov: 280, pitch: -90 }), 'png'), 'roof_deck_1__h0_t-90_fov280_wide.png', 'awkward characters become underscores; the wide lens is noted');
t.eq(E.checkSettings(null), E.newSettings(), 'no saved settings: the defaults');
t.eq(E.checkSettings({ aspect: '7:3', size: '99', fmt: 'gif', quality: 'x', grid: 'yes' }), E.newSettings(), 'nonsense settings fall back one by one');
t.eq(E.checkSettings({ aspect: '9:16', size: 3840, fmt: 'png', quality: 20, grid: true }), { aspect: '9:16', size: '3840', fmt: 'png', quality: 60, grid: true }, 'good settings are kept, quality clamped');

t.done();
