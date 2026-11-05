// The engine half of drainage.html: the 2021 IPC tables as transcribed, how sizes the tables
// don't list are rated, how a gutter run is laid out, how scuppers and drains are sized, and what
// a file may carry.
import {boot, suite} from './harness.mjs';

const ev = boot(), t = suite();
const E = ev(`({ T1106_2, T1106_3, T1106_6, EQ11_1, flowOf, designArea, rateLeader, rateGutter, drainSize, weirHead,
  weirWidth, outletCap, placeOutlets, tributary, analyze, rates, newProject, newArea, newRun, checkProject, exampleProject,
  materialsCsv, headline, shapeArea, frac })`);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const box = (w, h) => ({ kind: 'box', w, h });
const half = d => ({ kind: 'half', d });

// ---- the tables, as printed in the 2021 IPC ----
t.eq(E.EQ11_1, 0.0104, 'Equation 11-1 constant');
t.eq(E.T1106_2.map(r => [r.size, r.gpm]), [[2, 34], [3, 87], [4, 180], [5, 311], [6, 538], [8, 1117], [10, 2050], [12, 3272], [15, 5543]],
  'Table 1106.2, vertical drain column');
t.eq(E.T1106_3.length, 19, 'Table 1106.3 has 19 rows');
t.eq(E.T1106_6.length, 19, 'Table 1106.6 has 19 rows');
for (const e of E.T1106_3) {
  const r = E.rateLeader(e);
  t.ok(r.gpm === e.gpm && r.rule === 'listed', `every Table 1106.3 size rates as printed: ${JSON.stringify(e)}`);
}
for (const e of E.T1106_6) {
  const g = e.kind === 'half' ? half(e.d) : box(e.w, e.h);
  const r = E.rateGutter(g, e.slope);
  t.ok(near(r.gpm, e.gpm) && r.rule === 'listed', `every Table 1106.6 row rates as printed: ${JSON.stringify(e)} got ${r.gpm}`);
}
t.ok(E.rateLeader({ kind: 'rect', w: 5, h: 4 }).rule === 'listed', 'a rectangular leader turned on its side is still the listed size');

// ---- sizes the tables don't list ----
{
  const r = E.rateLeader({ kind: 'rect', w: 2, h: 3 });
  t.ok(r.gpm === 54 && r.rule === 'area', '2×3 (6 sq in) is rated as the 2½" round (4.9 sq in), 54 gpm, not the 2½×3 (7.5)');
  t.eq(E.rateLeader({ kind: 'rect', w: 3, h: 4 }).gpm, 92, '3×4 (12 sq in) falls short of the 4" round (12.6), so 92 gpm');
  t.eq(E.rateLeader({ kind: 'rect', w: 6, h: 6 }).gpm, 563, '6×6 rates as the 5½×5½');
  const big = E.rateLeader({ kind: 'rect', w: 10, h: 10 });
  t.ok(big.gpm === 1208 && big.rule === 'area', 'a size beyond the table is held to the largest listed size, never extrapolated');
  t.eq(E.rateLeader({ kind: 'round', d: 1.5 }).gpm, 0, 'a size smaller than any listed has no rating');
}
{
  const r = E.rateGutter(half(5), 1 / 16);
  t.ok(near(r.gpm, 74 * Math.sqrt(0.5)) && r.adj && r.rule === 'slope', '5" half-round at 1/16 is its 1/8 row reduced by √½');
  t.ok(near(E.rateGutter(half(8), 1 / 2).gpm, 247), 'a steeper slope than any listed row never raises the rating');
  t.ok(near(E.rateGutter(box(5, 8), 1 / 4).gpm, 651), 'a listed section uses its own row, not a better-shaped one of the same area (4×10)');
  t.ok(near(E.rateGutter(box(5, 8), 1 / 16).gpm, 651 / 2), 'a listed section on a flatter slope is reduced from its own row');
  const k = E.rateGutter({ kind: 'k', top: 6, bottom: 4.25, depth: 4 }, 1 / 16);
  t.ok(k.rule === 'area' && near(k.gpm, 157 * Math.sqrt(1 / 4)), '6" K-style (20.5 sq in) rates as the 3×5 at 1/4, reduced to 1/16');
  const b12 = E.rateGutter(box(12, 8), 1 / 16), b86 = E.rateGutter(box(8, 6), 1 / 16);
  t.ok(b12.beyond && near(b12.gpm, b86.gpm), 'a box larger than any listed section is held to the table and says so');
  t.ok(!E.rateGutter(box(5, 8), 1 / 16).beyond, 'a listed section is not beyond the table');
  t.ok(near(E.rateGutter(half(8), 1 / 16).gpm, 172) && !E.rateGutter(half(8), 1 / 16).adj, 'a printed row wins over its steeper row reduced (174.7)');
  t.ok(near(E.rateGutter(box(3, 5), 1 / 8).gpm, 157 * Math.sqrt(0.5)), 'between columns, the next steeper row is reduced, not the steepest');
}

// ---- flows and the hydraulics ----
t.ok(near(E.flowOf(3.2, 1000), 33.28), 'GPM = R × A × 0.0104');
t.eq(E.designArea(1000, 400), 1200, 'half of a wall that sheds onto the roof is added (IPC 1106.4)');
t.eq(E.drainSize(87).size, 3, 'exactly a table value takes that size');
t.eq(E.drainSize(87.5).size, 4, 'just over takes the next size');
t.eq(E.drainSize(6000), null, 'beyond 15" there is no size');
t.ok(near(E.weirHead(2.9 * 10 * 8, 10), 4), 'weir head: 232 gpm over a 10" opening is 4" deep');
t.ok(near(E.weirWidth(232, 4), 10), 'weir width is the inverse');
{
  const ds = { kind: 'rect', w: 3, h: 4 };
  t.eq(E.outletCap(ds, 0.5).mode, 'weir', 'shallow water over an outlet is a weir');
  t.eq(E.outletCap(ds, 3).mode, 'orifice', 'deep water is an orifice');
  t.ok(near(E.outletCap(ds, 3).gpm, 0.6 * (12 / 144) * Math.sqrt(2 * 32.174 * 0.25) * 448.83), 'orifice flow from Cd·A·√(2gh)');
}

// ---- laying out a run ----
t.eq(E.placeOutlets(100, 2, []), [25, 75], 'outlets centred in equal shares');
{
  const xs = E.placeOutlets(100, 2, [[20, 30]]);
  t.ok(xs[0] === 20 || xs[0] === 30, 'an outlet landing in a keep-out moves to its edge');
  t.eq(E.placeOutlets(10, 1, [[0, 10]]), [0], 'a keep-out covering the run leaves its ends');
  t.eq(E.placeOutlets(10, 1, [[-1, 11]]), null, 'with nowhere to go there is no layout');
}
{
  const tr = E.tributary(100, [25, 75]);
  t.ok(tr.share[0] === 50 && tr.seg === 25 && tr.gap === 50, 'each outlet collects to the midpoints; the gutter carries 25 ft each way');
}

const job = (rain1, areas, o = {}) => { const P = E.newProject(); Object.assign(P, { rain1 }, o); P.areas = areas; return P; };
{
  // 60 ft at 3 in/hr from 3000 sf: 93.6 gpm.
  const run = E.newRun('r1', { len: 60, area: 3000 });
  const J = E.analyze(job(3, [E.newArea('a1', 'steep', { runs: [run] })]));
  const r = J.areas[0].runs[0];
  t.ok(near(r.Q, 93.6), '60 ft run flow');
  t.ok(r.status === 'ok' && r.pick.n >= 2, 'it needs at least two downspouts to stay within 50 ft');
  t.ok(r.pick.gap <= 50, 'spacing limit honored');
  t.ok(r.pick.checks.every(c => c.ok), 'Auto prefers a layout that clears every check, advice included');
  t.ok(r.alts.every((a, i) => i === 0 || a.n > r.alts[i - 1].n), 'one choice per downspout count, fewest first');
  run.keep = [[25, 35]];
  const k = E.analyze(job(3, [E.newArea('a1', 'steep', { runs: [run] })])).areas[0].runs[0];
  t.ok(k.pick.xs.every(x => !(x > 25 && x < 35)), 'no downspout lands in a keep-out');
  run.keep = []; run.ds = 'd2x3';
  const f = E.analyze(job(3, [E.newArea('a1', 'steep', { runs: [run] })])).areas[0].runs[0];
  t.ok(f.pick.ds.id === 'd2x3' && f.pick.qMax <= 54, 'a chosen downspout gets as many as it takes');
  t.eq(f.alts.length, 1, 'a chosen downspout offers no other sizes');
}
{
  const run = E.newRun('r1', { len: 0, area: 1000 });
  t.eq(E.analyze(job(3, [E.newArea('a1', 'steep', { runs: [run] })])).areas[0].runs[0].status, 'empty', 'a run with no length is not sized');
  run.len = 40;
  t.eq(E.analyze(job(0, [E.newArea('a1', 'steep', { runs: [run] })])).areas[0].runs[0].status, 'empty', 'nothing is sized without a rainfall');
}

// ---- low-slope roofs ----
t.ok(near(E.rates(job(3, [])).r15, 6) && E.rates(job(3, [])).r15From === 'double', 'with no 15-minute value the rain-load rate is twice the hourly (IBC 1611.1)');
t.ok(near(E.rates(job(3, [], { rain15: 1.4 })).r15, 5.6), 'a 15-minute depth becomes a rate: × 4');
{
  // 10,000 sf at 3 in/hr: 312 gpm; 2 scuppers each way, 156 gpm each, a 4" drain (180) → 12.6"
  // circumference. At 1" in 15 minutes (4 in/hr) each passes 208 gpm, 3.4" deep over 13".
  const A = E.newArea('a1', 'low', { plan: 10000, pN: 2, sN: 2, rise: 2, sH: 4 });
  const L = E.analyze(job(3, [A], { rain15: 1 })).areas[0];
  const [p, s] = L.units;
  t.ok(near(L.Q1, 312), 'low-slope flow');
  t.ok(p.drain.size === 4 && p.b === 13 && p.why === 'circumference', 'scupper width: the 4" drain’s circumference rounded up to 13"');
  t.ok(near(s.q1, 156) && s.b >= Math.PI * 4, 'the secondary carries the full flow on its own (primary not counted)');
  t.ok(near(s.dh, E.weirHead(208, s.b)) && near(L.rain.ds, 2), 'hydraulic head at the rain-load rate, static head is the rise');
  t.ok(near(L.rain.R, 5.2 * (2 + s.dh)), 'R = 5.2 (ds + dh)');
  t.ok(p.leader && p.leader.lead.gpm >= 156, 'each primary scupper gets a downspout that carries it');
  t.eq(L.status, 'ok', 'it passes');
  A.depth = 4;
  const D = E.analyze(job(3, [A], { rain15: 1 })).areas[0], s2 = D.units[1];
  t.ok(s2.why === 'depth' && 2 + s2.dh <= 4 + 1e-9, 'a design depth widens the secondary until ds + dh fits');
  A.depth = 2;
  t.eq(E.analyze(job(3, [A])).areas[0].status, 'fail', 'a secondary inlet at the design depth fails');
  A.depth = 0; A.sH = 3;
  t.eq(E.analyze(job(3, [A])).areas[0].status, 'fail', 'a scupper under 4" high fails');
  A.sH = 4;
  const H = E.analyze(job(3, [A], { rain15: 1.5 })).areas[0].units[0];
  t.ok(H.why === 'opening' && H.dh <= 4 + 1e-9, 'a heavier rain-load rate widens the scupper to keep the water inside the opening');
}
{
  const A = E.newArea('a1', 'low', { plan: 20000, pType: 'drain', pN: 4, sType: 'none' });
  const L = E.analyze(job(3, [A])).areas[0];
  t.ok(L.units[0].drain.size === 4 && near(L.units[0].q1, 156), '624 gpm over 4 drains: 156 each, a 4" drain');
  t.eq(L.status, 'fail', 'drains behind a parapet with no secondary fail (IPC 1108.1)');
  A.parapet = false;
  t.eq(E.analyze(job(3, [A])).areas[0].status, 'ok', 'with no edge to trap water, no secondary is needed');
  Object.assign(A, { sType: 'drain', sN: 4, sHead: 1.5, depth: 6, parapet: true });
  const S = E.analyze(job(3, [A])).areas[0];
  t.ok(near(S.rain.R, 5.2 * 3.5), 'a secondary drain reports the rain load from its published head');
}

// ---- the example job, the material list and the headline ----
{
  const P = E.exampleProject(), J = E.analyze(P);
  t.eq(J.status, 'ok', 'the example job passes everything');
  t.eq(E.headline(J).status, 'ok', 'and says so');
  const gut = J.materials.filter(m => m.unit === 'LF' && /gutter$/.test(m.item)).reduce((s, m) => s + m.qty, 0);
  t.eq(gut, 192, 'gutter footage is the run lengths');
  const csv = E.materialsCsv(P, J);
  t.ok(csv.startsWith('Group,Item,Qty,Unit,Areas\n') && csv.split('\n').length === J.materials.length + 2, 'CSV: a header and one line per item');
}
t.eq(E.headline(E.analyze(job(0, []))).status, 'empty', 'no rainfall: nothing to say yet');

// ---- files ----
{
  const P = E.checkProject({ rain1: 'x', maxSpacing: -4, areas: [{ kind: 'low', plan: 'lots', pN: 0, sType: 'bogus' },
    { kind: 'steep', runs: [{ len: 50, slope: 0.3, keep: [[5, 2], [1, 3], 'x'], gutter: '<b>' }, null] }, 7],
    catalog: { gutters: [{ id: 'z', kind: 'box', w: -1, h: 4 }], downspouts: [{ id: 'q', kind: 'round', d: 3 }] } });
  t.eq(P.rain1, 0, 'junk rainfall becomes 0');
  t.eq(P.maxSpacing, 5, 'spacing is held to its range');
  t.ok(P.areas.length === 2 && P.areas[0].plan === 0 && P.areas[0].pN === 1 && P.areas[0].sType === 'scupper', 'junk area fields take defaults');
  const r = P.areas[1].runs;
  t.ok(r.length === 1 && near(r[0].slope, 1 / 16) && r[0].gutter === 'auto', 'an unlisted slope or bad id falls back');
  t.eq(r[0].keep, [[1, 3]], 'only well-formed keep-outs survive');
  t.ok(P.catalog.gutters.length === 13 && P.catalog.downspouts.length === 1, 'a catalog list with nothing valid keeps the defaults');
  const Q = E.checkProject(JSON.parse(JSON.stringify(E.exampleProject())));
  t.eq(JSON.stringify(Q), JSON.stringify(E.exampleProject()), 'a saved job round-trips unchanged');
  t.eq(E.checkProject(null).areas.length, 0, 'nothing at all gives a new job');
}

t.done();
