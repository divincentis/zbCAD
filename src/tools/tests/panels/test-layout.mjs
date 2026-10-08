// The layout engine: which pieces a facet gets, how long they are, and what they cover.
import {boot, suite} from './harness.mjs';
const t = suite(), app = boot();
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const sum = (a, f) => a.reduce((s, x, i) => s + f(x, i), 0);
const shoelace = pts => Math.abs(sum(pts, (p, i) => p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1])) / 2;
// A profile and defaults with nothing switched on, so each block adds only what it is testing.
const plain = { profile: { cover: 16, sheetW: 20, maxLen: 0, minLen: 0, lap: 6, type: 'exposed' }, def: { allow: {}, round: 0.25, ripMin: 0 } };
const mk = (o, facets) => app.make({ profile: { ...plain.profile, ...o.profile }, def: { ...plain.def, ...o.def }, units: o.units }, facets);
// The five causes of waste have to account for all of it, on every facet these suites build.
const wasteAdds = (L, msg) => { const q = L.q; t.ok(Math.abs(q.wAllow + q.wLap + q.wAngle + q.wRip + q.wRound - (q.cover - q.slope)) < 0.01, 'waste components sum to the total: ' + msg); };

// ===== the spec's acceptance tests =====
{
  // Rectangle 480 x 300, 16" SSMR from the left rake, 2" eave overhang -> 30 strips of 302".
  mk({ profile: { type: 'ssmr-snap' }, def: { allow: { eave: 2 } } }, [{ template: 'rect', params: { w: 480, h: 300 } }]);
  let L = app.layout('R1');
  t.eq(L.strips.length, 30, 'acceptance: 30 strips');
  t.ok(L.pieces.length === 30 && L.pieces.every(p => p.len === 302), 'acceptance: each 302"');
  t.eq([...new Set(L.pieces.map(p => p.id))], ['R1-01'], 'thirty identical panels are one ID');
  t.ok(L.pieces.every(p => !p.splice) && L.q.splices === 0, 'no splices on single-piece runs');
  wasteAdds(L, 'rectangle');

  // Same facet, max 240, lap 6 -> two pieces per strip totalling 308", splice flagged on all 30.
  app.select('R1'); app.ev('P').profiles.find(q => q.id === 'p2').maxLen = 240; app.ev('changed')();
  L = app.layout('R1');
  t.ok(L.strips.length === 30 && L.strips.every(s => s.pieces.length === 2 && near(s.pieces[0].len + s.pieces[1].len, 308)), 'acceptance: 2 pieces per strip totalling 308"');
  t.ok(L.pieces.every(p => p.splice) && L.q.splices === 30, 'acceptance: splice flagged on all 30');
  t.ok(L.strips.every(s => s.pieces[0].id === 'R1-01' && s.pieces[1].id === 'R1-02'), 'the eave pieces are one ID and the pieces above them another');
  t.eq(L.strips[0].pieces.map(p => p.len), [240, 68], 'max + remainder: full piece at the eave');
  t.ok(L.warn.some(w => /REQUIRES SPLICE/.test(w)), 'and the splice is warned about');
  wasteAdds(L, 'split rectangle');
  t.ok(near(L.q.wLap, 30 * 6 * 16 / 144) && near(L.q.wAllow, 480 * 2 / 144), 'laps and allowance are each what they should be');

  // Centred hip triangle -> the cut list is mirror-symmetric and the angle cuts match.
  mk({ def: { allow: { eave: 1 } } }, [{ template: 'tri', params: { w: 331, h: 187.5 }, layout: { start: 'center-seam' } }]);
  L = app.layout('R1');
  const ps = L.pieces, n = ps.length;
  t.ok(n > 4 && ps.every((p, i) => near(p.len, ps[n - 1 - i].len) && near(p.short, ps[n - 1 - i].short)), 'acceptance: hip triangle lengths and short sides mirror');
  t.ok(ps.every((p, i) => p.angT != null && near(p.angT, -ps[n - 1 - i].angT)), 'acceptance: left and right angle cuts match');
  t.ok(near(Math.abs(ps[0].angT), Math.atan2(187.5, 165.5) * 180 / Math.PI), 'and the angle is the hip line off square');
  wasteAdds(L, 'triangle');

  // Plan + pitch: 120" plan run at 6:12 -> 134.16" slope.
  mk({}, [{ template: 'rect', inputMode: 'plan', pitch: 6, params: { w: 96, h: 120 } }]);
  L = app.layout('R1');
  t.eq(+L.pts[2][1].toFixed(2), 134.16, 'acceptance: 120" plan run at 6:12 is 134.16" on the slope');
  t.ok(near(L.pts[1][0], 96), 'dimensions along the eave are not stretched');
  t.ok(near(L.q.plan, 96 * 120 / 144) && near(L.q.slope, 96 * 134.1640786 / 144, 1e-5), 'plan area is slope area x cos(pitch)');

  // Unit parser.
  const parse = app.ev('parseLen');
  t.eq(parse(`10'-6 1/2"`), 126.5, `acceptance: 10'-6 1/2"`);
  t.eq(+parse('3.2 m').toFixed(2), 125.98, 'acceptance: 3.2 m');
  t.eq(parse('=96+24'), 120, 'acceptance: =96+24');
}

// ===== units =====
{
  app.make();
  const parse = app.ev('parseLen'), fmt = app.ev('fmtLen');
  for (const [s, v] of [['120', 120], ['120"', 120], ['120 in', 120], ['120.5', 120.5], ['120 1/2', 120.5], ['120-1/2', 120.5], ['120 1/2"', 120.5], ["10'", 120], ['10 ft', 120],
    ["10'6", 126], [`10' 6"`, 126], [`10'-6"`, 126], ["10.5'", 126], ['10.5 ft', 126], ['320 cm', 320 / 2.54], ['3200mm', 3200 / 25.4], ['=(96+24)*2-12/4', 237], ['-1/2', -0.5]])
    t.ok(near(parse(s), v), `parse ${s}`);
  for (const s of ['', 'abc', '=96+', '=alert(1)', "10'x", '1/0'])t.ok(Number.isNaN(parse(s)), `"${s}" is refused`);
  t.eq([parse('10', 'ft'), +parse('3200', 'mm').toFixed(3)], [120, 125.984], 'a bare number takes the chosen unit');
  t.eq([fmt(126.5, 'dec'), fmt(126.5, 'frac'), fmt(126.5, 'ftin'), fmt(126.5, 'ft'), fmt(126.5, 'mm')], ['126.50', '126 1/2', `10'-6 1/2"`, "10.54'", '3213'], 'the five output formats');
  t.eq([fmt(126.3, 'frac', 16), fmt(126.3, 'frac', 8), fmt(126.3, 'frac', 4), fmt(126.3, 'frac', 2)], ['126 5/16', '126 1/4', '126 1/4', '126 1/2'], 'fraction precision');
  t.eq(fmt(143.99, 'ftin', 16), `12'-0"`, 'a rounded-up inch carries into the feet');
  // Whatever a field shows has to read back as the same length, whatever a bare number means.
  for (const f of ['frac', 'dec', 'ftin', 'ft', 'mm']) for (const bare of ['in', 'ft', 'mm']) {
    Object.assign(app.P.units, { fmt: f, bare });
    for (const v of [0, 0.0625, 11.9375, 126.5, 5000.25]) t.ok(Math.abs(parse(app.ev('fmtField')(v)) - v) < 0.003, `field round trip ${v} as ${f}, bare ${bare}`);
  }
  const pitch = app.ev('parsePitch');
  t.ok(near(pitch('6:12'), 6) && near(pitch('6/12'), 6) && near(pitch('6'), 6) && near(pitch('26.565 deg'), 6, 1e-3) && near(pitch('50%'), 6), 'pitch as rise, degrees or percent');
  t.ok(Number.isNaN(pitch('steep')) && Number.isNaN(pitch('95 deg')), 'bad pitch refused');
  t.eq(app.ev('fmtPitch')(6), '6:12 (26.6°)', 'pitch shown both ways');
  Object.assign(app.P.units, { area: 'sq' }); t.eq(app.ev('fmtArea')(1252), '12.52 sq', 'squares');
  Object.assign(app.P.units, { area: 'm2' }); t.eq(app.ev('fmtArea')(1000), '92.9 m²', 'square metres');
}

// ===== a rectangle that is not a whole number of panels =====
{
  mk({}, [{ template: 'rect', params: { w: 247.5, h: 173.25 } }]);
  let L = app.layout('R1');
  t.eq(L.pieces.length, 16, '247.5 / 16 needs 16 strips');
  t.ok(near(L.pieces[15].rip, 7.5) && L.pieces.slice(0, 15).every(p => p.rip === null), 'only the last is ripped, to 7 1/2');
  t.ok(L.pieces.every(p => p.square && p.angB == null && p.angT == null), 'all square, no angles');
  t.ok(near(L.q.cover, 16 * 16 * 173.25 / 144) && near(L.q.gross, 16 * 20 * 173.25 / 144), 'coverage and gross area use coverage and sheet width');
  t.ok(near(L.q.wRip, 8.5 * 173.25 / 144), 'the unused width of the edge strip is rip waste');
  t.eq(L.edges.map(e => e.type), ['eave', 'rake', 'ridge', 'rake'], 'rectangle edges type themselves');
  t.ok(L.warn.some(w => /no overhang/.test(w)), 'an eave with zero allowance is flagged');
  wasteAdds(L, 'ripped rectangle');
  app.select('R1');
  app.type('y.start', 'sel', 'right');
  L = app.layout('R1');
  t.ok(near(L.pieces[0].x1, 247.5) && near(L.pieces[15].rip, 7.5) && near(L.pieces[15].ca, 0), 'starting right numbers from the right and rips the left');
  app.type('y.start', 'sel', 'center-seam');
  L = app.layout('R1');
  t.ok(near(L.pieces[0].rip, L.pieces[L.pieces.length - 1].rip) && L.strips.some(s => near(s.a, 123.75)), 'centred seam: equal rips, seam on the centreline');
  app.type('y.start', 'sel', 'center-panel');
  t.ok(app.layout('R1').strips.some(s => near((s.a + s.b) / 2, 123.75) && near(s.b - s.a, 16)), 'centred panel');
  app.type('y.start', 'sel', 'left'); app.type('y.offset', 'len', '5');
  L = app.layout('R1');
  t.ok(near(L.pieces[0].rip, 5) && near(L.pieces[1].ca, 5), 'a typed offset makes a 5" starter');
  app.type('y.offset', 'len', '0'); app.type('d.ripMin', 'len', '6'); app.type('y.balance', 'chk', true);
  L = app.layout('R1');
  t.ok(near(L.pieces[0].rip, 11.75) && near(L.pieces[L.pieces.length - 1].rip, 11.75), 'balancing shares the leftover, plus half a panel each where half of it would be too thin');
  app.type('d.ripMin', 'len', '3');
  t.ok(near(app.layout('R1').pieces[0].rip, 3.75), 'or just the leftover where that is wide enough');
  app.type('d.ripMin', 'len', '6'); app.type('y.balance', 'chk', false); app.type('y.offset', 'len', '3');
  t.ok(app.layout('R1').warn.some(w => /Edge rip under/.test(w) && /R1-01/.test(w)), 'a rip under the minimum is flagged');
}

// ===== edge allowances: out, back, and in from the side =====
{
  mk({ def: { allow: { eave: 1.5, ridge: 0.75, rake: 2 } } }, [{ template: 'rect', params: { w: 100, h: 200 } }]);
  let L = app.layout('R1');
  t.ok(L.pieces.every(p => near(p.y0, -1.5) && near(p.y1, 199.25) && p.len === 200.75), 'eave lengthens, ridge cuts back');
  t.ok(near(L.pieces[0].ca, 2) && near(L.pieces[L.pieces.length - 1].cb, 98), 'a rake inset moves the layout limit');
  t.eq(L.strips.length, 6, 'so 96" of layout takes 6 strips, not 7');
  t.ok(near(L.q.slope, 100 * 200 / 144), 'allowances never change the roof area');
  t.ok(L.q.wAllow < 0, 'a net cutback shows as negative allowance waste');
  wasteAdds(L, 'allowances');
  app.select('R1');
  app.type('e.2.type', 'selnull', 'headwall');
  t.ok(app.layout('R1').pieces.every(p => p.len === 201.5), 'retyping the top edge drops the ridge cutback');
  app.type('e.0.allow', 'lenopt', '3');
  t.ok(app.layout('R1').pieces.every(p => near(p.y0, -3)), 'one edge can override its type');
  app.type('e.0.allow', 'lenopt', '');
  t.ok(app.layout('R1').pieces.every(p => near(p.y0, -1.5)), 'and blank goes back to the package value');
  // A hip cutback is square to the hip line, not along the panel.
  mk({ def: { allow: { hip: 1 } } }, [{ template: 'tri', params: { w: 200, h: 100 } }]);
  L = app.layout('R1');
  t.ok(near(Math.max(...L.off.map(p => p[1])), 100 - Math.SQRT2, 1e-6), 'hip lines move in 1" square to themselves and meet lower');
}

// ===== hip face from plan dimensions =====
{
  const k = Math.hypot(12, 7) / 12, top = 153 * k;
  mk({ def: { allow: { eave: 1.25 } } }, [{ template: 'trap', inputMode: 'plan', pitch: 7, params: { w: 437, top: 131, h: 153 }, layout: { start: 'center-seam' } }]);
  const L = app.layout('R1'), ps = L.pieces, n = ps.length;
  t.ok(near(L.q.slope * 144, (437 + 131) / 2 * top), 'area is the true slope area');
  t.eq(L.edges.map(e => e.type), ['eave', 'hip', 'ridge', 'hip'], 'hip face edges');
  t.ok(ps.every((p, i) => near(p.len, ps[n - 1 - i].len) && near(p.lenL, ps[n - 1 - i].lenR)), 'symmetric facet, symmetric cut list');
  t.ok(ps.every(p => near(p.y0, -1.25)), 'every piece starts 1 1/4 below the eave line');
  const mid = ps.filter(p => p.ca >= 153 && p.cb <= 284);
  t.ok(mid.length > 0 && mid.every(p => p.square && near(p.raw, top + 1.25)), 'panels under the ridge are square and full length');
  // A hip panel is ordered at its long side, which sits on the hip line.
  const hip = ps.find(p => p.cb <= 153 && p.rip === null);
  t.ok(near(hip.lenR, hip.cb / 153 * top + 1.25) && near(hip.short, hip.ca / 153 * top + 1.25) && near(hip.raw, hip.lenR), 'ordered at the long side; short side recorded');
  t.ok(near(hip.angT, Math.atan2(top, 153) * 180 / Math.PI) && hip.angB == null, 'with the top cut angle off square');
  t.ok(L.q.wAngle > 0, 'the offcut is angle-cut waste');
  wasteAdds(L, 'hip face');
}

// ===== the other templates =====
{
  mk({}, [{ template: 'para', params: { w: 200, h: 150, skew: 37 } }, { template: 'angled', params: { w: 120, top: 300, h: 200, side: 'left' } }, { template: 'angled', params: { w: 300, top: 120, h: 200, side: 'right' } },
    { kind: 'wall', template: 'gable', params: { w: 360, h: 120, h2: 210 } }, { kind: 'wall', template: 'shed', params: { w: 240, h: 96, h2: 144, side: 'right' } }]);
  let L = app.layout('R1');
  const skewA = Math.atan2(150, 37) * 180 / Math.PI, lf = L.pieces.find(p => p.cb <= 37 && p.rip === null), rt = L.pieces.find(p => p.ca >= 200 && p.cb <= 237);
  t.ok(near(L.q.slope * 144, 200 * 150) && near(lf.angT, skewA) && lf.angB == null && near(rt.angB, skewA) && rt.angT == null, 'parallelogram: the same angle cut, at the top on one side and the bottom on the other');
  wasteAdds(L, 'parallelogram');
  L = app.layout('R2');
  t.eq(L.edges.map(e => e.type), ['eave', 'rake', 'ridge', 'valley'], 'angled left, wider at the top: a valley');
  t.ok(L.pieces.filter(p => p.cb <= 0).every(p => p.angB != null && p.y0 > 0), 'valley pieces start on the valley line');
  t.eq(app.layout('R3').edges.map(e => e.type), ['eave', 'hip', 'ridge', 'rake'], 'angled right, narrower at the top: a hip');
  L = app.layout('W1');
  t.eq(L.edges.map(e => e.type), ['base', 'corner', 'top', 'top', 'corner'], 'gable wall edges');
  t.ok(near(L.q.slope * 144, 360 * 120 + 360 * 90 / 2) && near(Math.max(...L.pieces.map(p => p.raw)), 210), 'gable wall area and peak');
  wasteAdds(L, 'gable wall');
  L = app.layout('W2');
  t.ok(near(L.q.slope * 144, 240 * (96 + 144) / 2) && near(L.pieces[L.pieces.length - 1].raw, 144), 'shed wall rises to the high side');
  t.eq(app.P.facets.map(f => f.mark), ['R1', 'R2', 'R3', 'W1', 'W2'], 'roofs are R, walls are W');
}

// ===== custom perimeters =====
{
  // A dormer-style cut-out in the eave.
  const pts = [[0, 0], [91, 0], [91, 40.5], [149, 40.5], [149, 0], [263, 0], [233, 171], [22, 171]];
  mk({}, [{ template: 'custom', pts }]);
  const D = app.layout('R1');
  t.ok(near(sum(D.strips, s => sum(s.pieces, p => sum(p.polys, c => shoelace(c)))), shoelace(pts), 1e-6), 'a concave polygon is covered exactly');
  t.ok(D.pieces.filter(p => p.ca >= 91 && p.cb <= 149).every(p => near(p.y0, 40.5)), 'pieces over the cut-out start at its head');
  t.ok(D.edges[2].type === 'eave' && D.edges[1].type === 'rake', 'the cut-out head is an eave, its sides rakes');
  wasteAdds(D, 'concave polygon');
  mk({}, [{ template: 'custom', pts: [...pts].reverse() }]);
  t.eq(app.layout('R1').pieces.map(p => +p.len.toFixed(6)), D.pieces.map(p => +p.len.toFixed(6)), 'clockwise or counter-clockwise gives the same pieces');

  // Walked: length then turn. A 30-60-90 corner, so nothing lands on a round number.
  const walk = [{ len: 200, turn: 90 }, { len: 100, turn: 60 }, { len: 115.470054, turn: 30 }, { len: 100, turn: 90 }, { len: 157.735027, turn: 90 }];
  mk({}, [{ template: 'custom', custom: 'walk', walk }]);
  let L = app.layout('R1');
  t.ok(L.pts.gap < 1e-3 && !L.warn.some(w => /does not close/.test(w)), 'a walked perimeter that closes');
  t.ok(near(L.q.slope * 144, 200 * 100 + 150 * 57.735027, 1e-2), 'and has the right area');
  app.select('R1'); app.type('wk.2.len', 'len', '90');
  L = app.layout('R1');
  t.ok(L.warn.some(w => /does not close/.test(w)), 'one that does not close is flagged');
  app.type('wk.2.len', 'len', '115.470054'); app.type('f.custom', 'sel', 'xy');
  t.ok(near(app.layout('R1').q.slope * 144, 200 * 100 + 150 * 57.735027, 1e-2), 'switching to X/Y points keeps the shape');
  app.type('f.custom', 'sel', 'walk');
  t.ok(app.P.facets[0].walk.every((w, i) => near(w.len, walk[i].len, 1e-3) && near(w.turn, walk[i].turn, 1e-3)), 'and back to the same walk');
  mk({}, [{ template: 'custom', pts: [[0, 0], [200, 100], [200, 0], [0, 150]] }]);
  L = app.layout('R1');
  t.ok(L.pieces.length === 0 && L.warn.some(w => /crosses itself/.test(w)), 'a self-crossing outline is refused');
  mk({}, [{ template: 'trap', params: { w: 300, top: 9, h: 120 } }]);
  t.ok(app.layout('R1').warn.some(w => /shorter than one/.test(w)), 'an edge shorter than the coverage width is flagged');

  // The inputs are told which dimensions each of those is about.
  const bf = () => app.ev('badFields')(app.layout('R1')).sort();
  t.eq(bf(), ['m.top'], 'a short ridge points at the ridge length');
  mk({}, [{ template: 'rect', params: { w: 300, h: 9 } }]);
  t.eq(bf(), ['m.h'], 'a short rake points at the slope height');
  mk({}, [{ template: 'custom', pts: [[0, 0], [200, 100], [200, 0], [0, 150]] }]);
  t.eq(bf(), ['m.', 'pt.', 'wk.'], 'a self-crossing outline points at every shape dimension');
  mk({}, [{ template: 'custom', pts: [[0, 0], [200, 0], [200, 100], [195, 100], [0, 100]] }]);
  t.eq(bf(), ['pt.2.', 'pt.3.'], 'a short edge of a custom outline points at its two corners');
  mk({}, [{ template: 'custom', custom: 'walk', walk: [{ len: 200, turn: 90 }, { len: 100, turn: 90 }, { len: 150, turn: 90 }, { len: 100, turn: 90 }] }]);
  t.eq(bf(), ['wk.'], 'a perimeter that does not close points at the walk');
  mk({}, [{ template: 'rect' }]);
  t.eq(bf(), [], 'a sound facet points at nothing');
}

// ===== panel direction =====
{
  mk({}, [{ template: 'para', params: { w: 192, h: 150, skew: 37 }, layout: { dir: 'edge', dirEdge: 1 } }]);
  let L = app.layout('R1');
  // Laid parallel to the rake of a parallelogram, every panel is the same length and nothing is ripped.
  const run = Math.hypot(37, 150), across = 192 * 150 / run;
  t.ok(L.pieces.every(p => near(p.raw, run + 16 * 37 / 150, 1e-6) || p.rip != null), 'parallel to the skewed rake: equal runs');
  t.eq(L.strips.length, Math.ceil(across / 16), 'strip count is the width square to the panels');
  t.ok(near(sum(L.pieces, p => sum(p.polys, shoelace)), 192 * 150, 1e-6), 'and the facet is still covered exactly');
  wasteAdds(L, 'parallel to an edge');
  const plan = app.ev('facetPlan')(L, 700, 500), xy = plan.ops.filter(o => o.k === 'poly').flatMap(o => o.pts);
  t.ok(xy.every(p => p[0] > 0 && p[0] < 700 && p[1] > 0 && p[1] < 500), 'the turned layout is drawn back in the eave frame, on the sheet');
  app.select('R1'); app.type('y.dir', 'sel', 'angle'); app.type('y.angle', 'num', '20');
  L = app.layout('R1');
  t.ok(near(L.theta, 20 * Math.PI / 180) && near(sum(L.pieces, p => sum(p.polys, shoelace)), 192 * 150, 1e-6), 'a typed angle');
}

// ===== multi-piece runs =====
{
  const hipFace = [{ template: 'trap', params: { w: 610, top: 90, h: 411 }, layout: { start: 'center-seam' } }];
  mk({ profile: { cover: 36, sheetW: 38, maxLen: 240 }, def: { allow: { eave: 1.5 } } }, hipFace);
  let L = app.layout('R1');
  const checkRuns = msg => {
    t.ok(L.pieces.every(p => p.raw <= 240 + 1e-9), msg + ': nothing over the maximum');
    for (const s of L.strips) {
      const ps = s.pieces, run = ps[ps.length - 1].y1 - ps[0].y0;
      for (let i = 1; i < ps.length; i++) t.ok(near(ps[i - 1].y1 - ps[i].y0, 6), `${msg}: ${s.id} laps 6"`);
      // sum(L_i) = L_run + (n - 1) * L_lap
      t.ok(near(sum(ps, p => p.raw), run + 6 * (ps.length - 1)), `${msg}: ${s.id} pieces = run + laps`);
    }
    wasteAdds(L, msg);
  };
  checkRuns('aligned');
  const lines = () => [...new Set(L.laps.filter(l => !l.dash).map(l => l.y.toFixed(2)))];
  t.eq(lines(), ['238.50'], 'aligned: one lap line across the whole facet');
  const mid = () => L.strips.find(s => s.a <= 300 && s.b > 300).pieces;
  t.ok(mid().length === 2 && mid()[0].y0 < mid()[1].y0 && mid()[0].id !== mid()[1].id, 'pieces run from the eave up, each its own panel');
  t.ok(near(mid()[0].raw, 240) && mid()[0].lapTop === 6 && mid()[0].lapBot === 0 && mid()[1].lapBot === 6, 'lap recorded at the top of the lower piece and the bottom of the upper');
  t.ok(L.pieces.every(p => !p.splice), 'exposed fastener laps are not splices');
  const split = () => L.strips.filter(s => s.pieces.length > 1).flatMap(s => s.pieces);
  t.ok(split().some(p => p.raw < 24), 'with no minimum, a run just past the lap line leaves a stub');
  app.ev('S').prof = 'p2'; app.type('q.minLen', 'len', '24'); L = app.layout('R1'); checkRuns('rebalanced');
  t.ok(split().every(p => p.raw >= 24 - 1e-9) && L.warn.some(w => /lap moved/.test(w)), 'a remainder under the minimum borrows from its neighbour, with a warning');
  app.type('q.minLen', 'len', '0');

  app.select('R1');
  app.type('d.split', 'sel', 'equal'); L = app.layout('R1'); checkRuns('equal');
  t.ok(near(mid()[0].raw, mid()[1].raw) && near(mid()[0].raw, (412.5 + 6) / 2), 'equal: both pieces are half of run + lap');
  app.type('d.split', 'sel', 'eave'); L = app.layout('R1'); checkRuns('remainder at eave');
  t.ok(near(mid()[1].raw, 240) && mid()[0].raw < 240, 'remainder at eave: the full piece is on top');
  t.eq(lines().length, 1, 'and the lap line is still shared, measured from the top');
  app.type('d.split', 'sel', 'max');

  app.type('d.lapMode', 'sel', 'stagger'); app.type('d.stagger', 'len', '30'); L = app.layout('R1'); checkRuns('staggered');
  const tops = L.strips.filter(s => s.pieces.length > 1).map(s => [s.index % 2, +s.pieces[s.pieces.length - 2].y1.toFixed(2)]);
  t.ok(tops.filter(x => x[0] === 1).every(x => x[1] === 238.5) && tops.filter(x => x[0] === 0).every(x => x[1] === 208.5), 'staggered: alternate strips lap 30" lower');
  t.ok(L.strips.every(s => s.pieces.length <= 2), 'and staggering adds no joints');

  app.type('d.lapMode', 'sel', 'purlin'); app.type('d.purlinSp', 'len', '50'); app.type('d.purlin0', 'len', '7'); L = app.layout('R1'); checkRuns('purlins');
  t.ok(L.strips.filter(s => s.pieces.length > 1).every(s => near((s.pieces[0].y1 - 3 - 7) % 50, 0, 1e-6)), 'purlins: every lap is centred on a purlin line');
  t.ok(near(mid()[0].y1, 210), 'the highest purlin the piece can reach (207), plus half the lap');
  app.type('d.purlinSp', 'len', '300'); app.type('d.purlin0', 'len', '290'); L = app.layout('R1');
  t.ok(L.warn.some(w => /could not be snapped/.test(w)), 'a lap with no purlin in reach is reported');

  // Facet override of a package default.
  app.type('d.lapMode', 'sel', 'aligned'); app.type('o.split', 'selnull', 'equal');
  t.ok(app.ev('eff')(app.P.facets[0]).split === 'equal' && app.P.def.split === 'max', 'a facet can override the split rule');
  app.type('o.split', 'selnull', '');
  t.ok(!('split' in app.P.facets[0].ov), 'and clear the override');
  app.type('o.lap', 'lenopt', '9');
  L = app.layout('R1');
  t.ok(mid()[0].lapTop === 9 && near(mid()[0].y1 - mid()[1].y0, 9), 'a facet lap override is used in the lengths');

  // Pieces that cannot be fixed are flagged, not hidden.
  mk({ profile: { maxLen: 100, lap: 100 } }, [{ template: 'rect', params: { w: 64, h: 300 } }]);
  t.ok(app.layout('R1').warn.some(w => /Over the 100" maximum/.test(w)), 'a lap as long as the panel cannot split: flagged over max');
  mk({ profile: { minLen: 30 } }, [{ template: 'tri', params: { w: 200, h: 100 } }]);
  t.ok(app.layout('R1').warn.some(w => /Under the 30" minimum/.test(w)), 'hip corner pieces under the minimum are flagged');
}

// ===== IDs =====
{
  mk({ profile: { cover: 2 } }, [{ template: 'rect', params: { w: 240, h: 60 } }]);
  let L = app.layout('R1');
  t.eq([L.strips.length, L.pieces[0].id, L.pieces[119].id], [120, 'R1-01', 'R1-01'], 'however many strips, identical panels take one number');
  // A triangle: every strip is a different length, and the two sides are mirror images.
  mk({ profile: { cover: 2 } }, [{ template: 'tri', params: { w: 480, h: 240 } }]);
  L = app.layout('R1');
  t.eq([new Set(L.pieces.map(p => p.id)).size, L.pieces[0].id, L.pieces[239].id], [240, 'R1-001', 'R1-240'], 'three digits once a facet passes 99 different panels, numbered from the start edge');
  mk({ def: { allow: {} } }, [{ template: 'tri', params: { w: 480, h: 240 } }]);
  L = app.layout('R1');
  const twin = L.pieces.find(p => p !== L.pieces[2] && near(p.len, L.pieces[2].len));
  t.ok(twin && twin.id !== L.pieces[2].id && near(twin.angT, -L.pieces[2].angT), 'a mirror-image cut of the same length is a different panel');
  mk({ def: { allow: {} } }, [{ template: 'para', params: { w: 240, h: 120, skew: 48 } }]);
  L = app.layout('R1');
  t.ok(L.pieces.filter(p => !p.square && p.rip == null && near(p.lenL, p.lenR)).every((p, i, a) => p.id === a[0].id) && L.pieces.some(p => !p.square), 'panels cut to the same angle at both ends share an ID');
  mk({ profile: { cover: 2 } }, [{ template: 'rect', params: { w: 240, h: 60 } }]);
  app.select('R1');
  t.ok(/needs an ID/.test(app.type('f.mark', 'text', '  ')), 'a blank ID is refused');
  app.type('f.mark', 'text', 'NORTH');
  t.eq(app.P.facets[0].mark, 'NORT', 'a facet ID is at most 4 characters');
  app.type('k.prefix', 'text', 'B');
  L = app.layout('NORT');
  t.eq(L.pieces[6].id, 'B-NORT-01', 'optional package prefix');
  app.type('p.idMax', 'int', '8');
  t.ok(app.layout('NORT').warn.some(w => /8-character limit/.test(w)), 'IDs over the marking limit are flagged');
  mk({}, [{ template: 'rect', mark: 'R1' }, { template: 'rect', mark: 'R1' }]);
  t.ok(app.layout('R1').warn.some(w => /more than one facet/.test(w)), 'duplicate facet IDs are flagged');
}

// ===== openings =====
{
  mk({ profile: { cover: 12, sheetW: 14 } }, [{ kind: 'wall', template: 'rect', params: { w: 240, h: 120 }, openings: [{ x: 61, y: 0, w: 38, h: 84 }, { x: 150, y: 36, w: 48, h: 40 }] }]);
  const L = app.layout('W1');
  t.ok(near(L.q.slope * 144, 240 * 120 - 38 * 84 - 48 * 40), 'openings come off the area');
  const over = L.pieces.filter(p => p.ca >= 61 && p.cb <= 99);
  t.ok(over.length === 2 && over.every(p => near(p.y0, 84) && near(p.raw, 36)), 'pieces over the door are head-to-top only');
  const win = L.pieces.filter(p => p.ca >= 150 && p.cb <= 198);
  t.ok(win.length === 6 && win.filter(p => near(p.raw, 36)).length === 3 && win.filter(p => near(p.raw, 44)).length === 3, 'window strips get a sill piece and a head piece');
  t.ok(new Set(win.filter(p => near(p.raw, 36)).map(p => p.id)).size === 1 && new Set(win.map(p => p.id)).size === 2, 'the three sill pieces are one ID and the three head pieces another');
  t.ok(win.every(p => !p.lapTop && !p.lapBot && !p.splice), 'which are separate pieces, not a lapped run');
  const jamb = L.pieces.find(p => p.ca < 61 && p.cb > 61);
  t.ok(near(jamb.raw, 120) && jamb.shape, 'a piece that only catches the jamb is full height and cut to shape');
  wasteAdds(L, 'openings');
  app.select('W1'); app.type('d.allow.base', 'len', '1');
  t.ok(app.layout('W1').pieces.filter(p => p.ca >= 61 && p.cb <= 99).length === 2, 'a base extension does not conjure a piece in the doorway');
}

// ===== warnings about profile and wind =====
{
  mk({ profile: { type: 'ssmr-snap', minSlope: 3, hand: 'right' } }, [{ template: 'rect', pitch: 2, layout: { wind: 'left' } }, { template: 'rect', pitch: 4 }]);
  const w = app.layout('R1').warn.join('\n');
  t.ok(/below this profile's minimum of 3:12/.test(w), 'pitch below the profile minimum');
  t.ok(/lays from the right/.test(w), 'layout start against the sidelap hand');
  t.ok(/prevailing wind/.test(w), 'sidelaps open to the wind');
  t.ok(!/prevailing wind/.test(app.layout('R2').warn.join('\n')), 'wind is set facet by facet');
  {
    const check = app.ev('checkProject'), old = JSON.parse(JSON.stringify(app.P));
    t.eq(check(old).facets.map(f => f.layout.wind), ['left', ''], 'wind is saved with the facet');
    for (const f of old.facets) delete f.layout.wind;
    old.packages[0].def = { wind: 'right' };
    t.eq(check(old).facets.map(f => f.layout.wind), ['right', 'right'], 'a package-wide wind from an older file is handed to its facets');
    app.select('R1'); app.ev('copyFacet')(true);
    t.eq(app.P.facets[app.P.facets.length - 1].layout.wind, 'right', 'mirroring a facet mirrors its wind');
  }
  mk({}, [{ template: 'rect', inputMode: 'plan' }]);
  t.ok(app.layout('R1').warn.some(x => /needs a pitch/.test(x)), 'plan mode without a pitch');
  const thin = app.ev('layoutFacet')(app.P.facets[0], { ...app.ev('eff')(app.P.facets[0]), W: 0.02 });
  t.ok(thin.pieces.length === 0 && thin.warn.length > 0, 'a silly width yields a warning, not a hang');
}
t.done();
