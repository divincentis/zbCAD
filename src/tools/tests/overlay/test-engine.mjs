// The engine half of overlay.html: where the plan lands on the photo for every way of moving
// it, what the styling does to the plan's pixels, and what a project file is allowed to carry.
import {boot, suite} from './harness.mjs';

const ev = boot(), t = suite();
const E = ev(`({ toWorld, toPlan, boxOf, boxPoint, dragGrip, rotateTo, mirrored, movedBy, snapRot, alignTwo, fitPlan,
  clampCrop, pinWorld, freezePins, styledPlan, spread, shrinkDarkest, checkProject, newProject, sniff, normAngle })`);
const near = (a, b, eps = 1e-6) => Array.isArray(a) ? a.every((v, i) => Math.abs(v - b[i]) < eps) : Math.abs(a - b) < eps;
const r2 = p => p.map(v => Math.round(v * 1e6) / 1e6);

// ---- placement ----
const crop = { x: 100, y: 50, w: 400, h: 200 };
const T0 = E.fitPlan(crop, 1000, 800);
t.ok(near(E.boxOf(T0, crop).ctr, [500, 400]), 'a fresh plan is centred on the photo');
t.ok(near(T0.sx, 2) && near(T0.sy, 2), 'a fresh plan fills 80% of the tighter side: 0.8 × 1000 / 400');

const T1 = { ox: 30, oy: -12, rot: 0.7, sx: 1.7, sy: 0.6, fx: -1 };
t.ok(near(E.toPlan(T1, ...E.toWorld(T1, 123, 456)), [123, 456]), 'toPlan undoes toWorld, rotated, stretched and mirrored');

// A side grip moves one side only: the opposite side and the other dimension stay.
{
  const B = E.boxOf(T1, crop), right = E.boxPoint(B, 1, 0), left = E.boxPoint(B, -1, 0);
  const p = [right[0] + B.u[0] * 50, right[1] + B.u[1] * 50];   // 50 px further out along the plan's width
  const T = E.dragGrip(T1, crop, 1, 0, p, true), B2 = E.boxOf(T, crop);
  t.ok(near(E.boxPoint(B2, -1, 0), left), 'side grip: the opposite side stays put');
  t.ok(near(2 * B2.hw, 2 * B.hw + 50), 'side grip: the width grows by the drag');
  t.ok(near(B2.hh, B.hh) && near(T.sy, T1.sy), 'side grip: the height is untouched, keep or no keep');
  t.ok(near(T.rot, T1.rot) && T.fx === -1, 'side grip: rotation and mirror are kept');
}
// A corner grip with keep scales both ways together about the opposite corner.
{
  const B = E.boxOf(T0, crop), opp = E.boxPoint(B, -1, -1), c = E.boxPoint(B, 1, 1);
  const T = E.dragGrip(T0, crop, 1, 1, [c[0] + 80, c[1] + 10], true), B2 = E.boxOf(T, crop);
  t.ok(near(E.boxPoint(B2, -1, -1), opp), 'corner grip: the opposite corner stays put');
  t.ok(near(T.sx / T.sy, T0.sx / T0.sy), 'corner grip with keep: proportions held');
  t.ok(T.sx > T0.sx, 'corner grip with keep: dragging out makes it bigger');
  const F = E.dragGrip(T0, crop, 1, 1, [c[0] + 80, c[1] + 10], false), B3 = E.boxOf(F, crop);
  t.ok(near(E.boxPoint(B3, 1, 1), [c[0] + 80, c[1] + 10]), 'corner grip without keep: the corner follows the pointer');
  t.ok(near(2 * B3.hw, 2 * B.hw + 80) && near(2 * B3.hh, 2 * B.hh + 10), 'corner grip without keep: each side stretches on its own');
}
// The grips mean the same side on screen when the plan is mirrored.
{
  const M = E.mirrored(T0, crop), B = E.boxOf(M, crop), right = E.boxPoint(B, 1, 0);
  const T = E.dragGrip(M, crop, 1, 0, [right[0] + 40, right[1]], false);
  t.ok(near(E.boxPoint(E.boxOf(T, crop), 1, 0), [right[0] + 40, right[1]]), 'mirrored: the right grip still drags the right side');
  t.ok(near(E.boxOf(M, crop).ctr, E.boxOf(T0, crop).ctr), 'mirroring keeps the plan in place');
  t.ok(near(E.toWorld(M, crop.x, crop.y)[0], E.toWorld(T0, crop.x + crop.w, crop.y)[0]), 'mirroring swaps left and right');
}
// A grip cannot turn the plan inside out.
{
  const B = E.boxOf(T0, crop), left = E.boxPoint(B, -1, 0);
  const T = E.dragGrip(T0, crop, 1, 0, [left[0] - 300, left[1]], false);
  t.ok(T.sx > 0 && near(T.sx * crop.w, 4), 'dragging a side past the other stops at the minimum size');
}
// Rotation turns about the middle of the crop.
{
  const T = E.rotateTo(T0, crop, Math.PI / 2);
  t.ok(near(E.boxOf(T, crop).ctr, E.boxOf(T0, crop).ctr), 'rotating keeps the middle of the plan where it was');
  t.ok(near(E.toWorld(T, crop.x + crop.w, crop.y + crop.h / 2), [500, 400 + 400]), 'a quarter turn clockwise sends the right edge down');
  t.ok(near(E.snapRot(Math.PI / 2 + 0.01, 0.02), Math.PI / 2), 'near a quarter turn snaps to it');
  t.ok(near(E.snapRot(0.3, 0.02), 0.3), 'far from one does not');
  t.ok(near(E.normAngle(3 * Math.PI / 2), -Math.PI / 2), 'angles are kept in (-π, π]');
}
t.ok(near(E.toWorld(E.movedBy(T1, 5, -7), 10, 10), [E.toWorld(T1, 10, 10)[0] + 5, E.toWorld(T1, 10, 10)[1] - 7]), 'moving shifts every point the same');

// Two matched points put both plan points exactly on their photo points.
{
  const a = [120, 80], b = [480, 230], A = [210.5, 640], B = [730, 170];
  const T = E.alignTwo(T1, a, b, A, B);
  t.ok(near(E.toWorld(T, ...a), A, 1e-6) && near(E.toWorld(T, ...b), B, 1e-6), 'two points: both land where they were clicked');
  t.ok(near(T.sx / T.sy, T1.sx / T1.sy) && T.fx === T1.fx, 'two points: the stretch and the mirror the plan already had are kept');
  t.eq(E.alignTwo(T1, a, a, A, B), null, 'two points: the same plan point twice is refused');
  t.eq(E.alignTwo(T1, a, b, A, A), null, 'two points: the same roof point twice is refused');
}

t.eq(E.clampCrop(null, 300, 200), { x: 0, y: 0, w: 300, h: 200 }, 'no crop is the whole plan');
t.eq(E.clampCrop({ x: -5, y: 150, w: 500, h: 100 }, 300, 200), { x: 0, y: 150, w: 300, h: 50 }, 'a crop from a bigger render is cut to the plan');

// Markers live on the plan and follow it; replacing the plan leaves them on the roof.
{
  const pin = { at: 'plan', x: 200, y: 100, label: 'stain' }, T = E.movedBy(T0, 40, 0);
  t.ok(near(E.pinWorld(T, pin), [E.pinWorld(T0, pin)[0] + 40, E.pinWorld(T0, pin)[1]]), 'a plan marker moves with the plan');
  const [f] = E.freezePins([pin], T0);
  t.ok(f.at === 'roof' && near([f.x, f.y], E.pinWorld(T0, pin)) && f.label === 'stain', 'freezing a marker keeps it where it was on the roof');
  t.ok(near(E.pinWorld(null, { at: 'roof', x: 3, y: 4 }), [3, 4]), 'a roof marker needs no plan');
  t.eq(E.pinWorld(null, pin), null, 'a plan marker with no plan has nowhere to be');
}

// ---- styling ----
// A 5×1 strip: white, black, mid grey, pure yellow, transparent.
const px = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 0, 255, 0, 0, 0, 0]);
const look = { ...ev('LOOK'), weight: 0, clean: 40, color: '#1f6fff' };
{
  const o = E.styledPlan(px, 5, 1, look), a = i => o[i * 4 + 3], rgb = i => [...o.slice(i * 4, i * 4 + 3)];
  t.eq(a(0), 0, 'white goes clear');
  t.eq(a(1), 255, 'black stays solid');
  t.eq(rgb(1), [31, 111, 255], 'and takes the line color');
  t.eq(a(3), 255, 'a yellow line counts as a line, not as background');
  t.eq(a(4), 0, 'a transparent pixel counts as white');
  const lo = E.styledPlan(px, 5, 1, { ...look, clean: 0 })[2 * 4 + 3], hi = E.styledPlan(px, 5, 1, { ...look, clean: 100 })[2 * 4 + 3];
  t.ok(lo === 255 && hi === 0, `clean-up decides whether mid grey is a line: ${lo} at 0, ${hi} at 100`);
  const orig = E.styledPlan(px, 5, 1, { ...look, original: true });
  t.eq([...orig.slice(12, 15)], [255, 255, 0], 'original colors keep the yellow line yellow');
  const paper = E.styledPlan(px, 5, 1, { ...look, knockout: false });
  t.eq([...paper.slice(0, 4)], [255, 255, 255, 255], 'with the background kept, white stays white and solid');
  t.eq([...paper.slice(4, 8)], [31, 111, 255, 255], 'and the lines are still recolored');
}
// Thickness and outline on a single dot in the middle of 11×11.
{
  const n = 11, img = new Uint8ClampedArray(n * n * 4).fill(255);
  img.set([0, 0, 0, 255], (5 * n + 5) * 4);
  const count = (o, f) => { let c = 0; for (let i = 0; i < n * n; i++) if (f(o, i * 4)) c++; return c; };
  const thick = E.styledPlan(img, n, n, { ...look, weight: 2 });
  t.eq(count(thick, (o, j) => o[j + 3] === 255), 25, 'thickness 2 grows a dot to 5×5');
  const dense = E.styledPlan(img, n, n, { ...look, weight: 1 }, 2);
  t.eq(count(dense, (o, j) => o[j + 3] === 255), 25, 'a raster twice as dense takes twice the thickness per step');
  const halo = E.styledPlan(img, n, n, { ...look, weight: 1, halo: true, haloColor: '#ffffff' });
  t.eq(count(halo, (o, j) => o[j + 3] === 255), 81, 'an outline adds three more pixels all round');
  t.eq(halo[3], 0, 'beyond the outline stays clear');
  t.eq([...halo.slice((5 * n + 5) * 4, (5 * n + 5) * 4 + 3)], [31, 111, 255], 'the line sits on top of its outline');
  t.eq([...halo.slice((2 * n + 2) * 4, (2 * n + 2) * 4 + 3)], [255, 255, 255], 'the outline is its own color');
}
// spread is a true max filter: compare with brute force on random data.
{
  const w = 37, h = 23, src = new Uint8Array(w * h).map(() => Math.random() < 0.05 ? (Math.random() * 255) | 0 : 0);
  for (const r of [1, 3, 6]) {
    const got = E.spread(src, w, h, r); let ok = true;
    for (let y = 0; y < h && ok; y++) for (let x = 0; x < w && ok; x++) {
      let m = 0;
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) m = Math.max(m, src[yy * w + xx]);
      ok = got[y * w + x] === m;
    }
    t.ok(ok, `spread radius ${r} matches a brute-force max filter`);
  }
}
// Shrinking a big scan keeps a one-pixel line.
{
  const w = 8, h = 4, img = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 0; y < h; y++) img.set([0, 0, 0, 255], (y * w + 5) * 4);
  const s = E.shrinkDarkest(img, w, h, 4);
  t.eq([s.w, s.h], [2, 1], 'shrink by 4 rounds up');
  t.eq([...s.px], [255, 255, 255, 255, 0, 0, 0, 255], 'the block holding the line comes out black, the other white');
}

// ---- files ----
t.eq(E.sniff([0x25, 0x50, 0x44, 0x46]), 'pdf', 'a PDF is known by its header');
t.eq(E.sniff([0x49, 0x49, 42, 0]), 'tiff', 'a little-endian TIFF');
t.eq(E.sniff([0x4d, 0x4d, 0, 42]), 'tiff', 'a big-endian TIFF');
t.eq(E.sniff([0xff, 0xd8, 0xff, 0xe0]), 'image', 'anything else is left to the browser');
{
  const P = E.checkProject({
    title: 'x'.repeat(500), look: { clean: 400, color: 'red', weight: 2.6, opacity: -3, halo: 'yes' },
    T: { ox: 1, oy: 2, rot: 7, sx: 2, sy: 3, fx: -1 }, crop: { x: 0, y: 0, w: 0, h: 5 },
    pins: [{ at: 'plan', x: 1, y: 2, label: 'a' }, { x: 'no' }, null, { at: 'elsewhere', x: 3, y: 4 }],
    pinColor: '#ABCDEF', keep: 'no', page: 2.7, extra: 1,
  });
  t.eq(P.title.length, 200, 'a long title is cut');
  t.eq([P.look.clean, P.look.color, P.look.weight, P.look.opacity, P.look.halo], [100, '#1f6fff', 3, 0, false], 'look values are clamped or defaulted');
  t.ok(near(P.T.rot, 7 - 2 * Math.PI) && P.T.fx === -1, 'the placement comes through, angle normalised');
  t.eq(P.crop, null, 'an empty crop is dropped');
  t.eq(P.pins, [{ at: 'plan', x: 1, y: 2, label: 'a' }, { at: 'roof', x: 3, y: 4, label: '' }], 'bad markers are dropped, odd ones made safe');
  t.eq([P.pinColor, P.keep, P.page, 'extra' in P], ['#abcdef', true, 2, false], 'the rest is checked too');
  t.eq(E.checkProject(E.newProject()), E.newProject(), 'a fresh project passes through unchanged');
  t.eq(E.checkProject(null), E.newProject(), 'nothing at all is a fresh project');
  t.eq(E.checkProject({ T: { ox: 1, oy: 1, rot: 0, sx: 0, sy: 1 } }).T, null, 'a zero scale is refused');
}
t.done();
