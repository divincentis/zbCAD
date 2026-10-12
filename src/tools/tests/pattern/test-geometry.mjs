// What each tool develops, checked against things that are true whatever the code does:
// a true length is the distance between the same two points on the flat, an unrolled surface
// keeps its area, and a fitting that is symmetric gives pieces that are the same blank.
import {boot, suite} from './harness.mjs';
const t = suite(), app = boot();
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
const TAU = Math.PI * 2;
const area = l => Math.abs(l.slice(1).reduce((s, q, i) => s + l[i][0] * q[1] - q[0] * l[i][1], 0)) / 2;
const span = (l, k) => Math.max(...l.map(q => q[k])) - Math.min(...l.map(q => q[k]));
const go = h => app.open('#' + h).run();
const row = (res, name) => res.table.rows.find(r => r[0] === name);
const names = res => res.pieces.map(q => `${q.name} x${q.qty}`);

// ===== triangulation: the table's true lengths are the flat pattern's own distances =====
for (const h of ['tool=rtr', 'tool=rtr&ox=5&oy=-3&k=3', 'tool=rect&pc=1', 'tool=rect&pc=1&ox=7&oy=4&w2=30', 'tool=ecc', 'tool=ecc&ox=-6&oy=9&d2=22']) {
  const { res } = go(h), pc = res.pieces[0], at = {};
  pc.labels.forEach(l => (at[l.t] ||= []).push(l.p));
  const end = res.table.rows.findIndex((r, i) => i && r.grp), lines = res.table.rows.slice(1, end);
  const off = lines.filter(r => {
    const [, a, b] = r[0].match(/^(.+?) – (.+?)(?: \(diagonal\))?$/);
    return !at[a].some(p => at[b].some(q => near(Math.hypot(p[0] - q[0], p[1] - q[1]), r[1].len)));
  });
  t.ok(res.pieces.length === 1 && lines.length > 8 && off.length === 0, `${h}: every true length is a distance on the flat (${off.map(r => r[0])})`);
  t.ok(pc.cut[0].every(q => isFinite(q[0]) && isFinite(q[1])) && near(Math.hypot(pc.cut[0][0][0] - pc.cut[0].at(-1)[0], pc.cut[0][0][1] - pc.cut[0].at(-1)[1]), 0), `${h}: the outline is closed`);
}

// ===== the flat is the fitting seen from outside =====
{
  // Corner C1, the point above it and the middle of the right side all lie on the right face.
  const { res } = go('tool=rect&pc=1&seam=0&ox=7&oy=4'), at = Object.fromEntries(res.pieces[0].labels.map(l => [l.t, l.p]));
  const A = [12, -8, 0], B = [7 + 6, 4 - 5, 12], C = [12, 0, 0], inside = [3.5, 2, 6];
  const u = B.map((v, i) => v - A[i]), w = C.map((v, i) => v - A[i]), n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const seen = n.reduce((s, v, i) => s + v * ((A[i] + B[i] + C[i]) / 3 - inside[i]), 0);
  const a = at.C1, b = at['C1′'], c = at.M2, flat = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  t.ok(seen * flat > 0, 'three points wind the same way on the flat as they do seen from outside');
  t.ok(res.notes.some(s => /outside face up/.test(s)), 'and the notes say which face is up');
}

// ===== cone: radial line, exact =====
{
  const { res } = go('tool=cone&d1=18&d2=10&h=10&pc=3&k=4'), s = Math.hypot(10, 4), Ro = 9 * s / 4, Ri = Ro - s, per = TAU * 9 / Ro / 3;
  t.eq(names(res), ['Cone segment x3'], 'three segments are one pattern, cut three times');
  t.ok(near(row(res, 'Outer radius (large end)')[1].len, Ro) && near(row(res, 'Inner radius (small end)')[1].len, Ri) && near(row(res, 'Angle per piece')[1].ang, per * 180 / Math.PI), 'radii and angle are the closed form');
  t.ok(near(row(res, 'Outer arc per piece')[1].len * 3, TAU * 9) && near(row(res, 'Inner arc per piece')[1].len * 3, TAU * 5), 'the arcs add up to the two circumferences');
  t.ok(near(area(res.pieces[0].cut[0]) * 3, Math.PI * 14 * s, 0.01), 'and the segments to the lateral area');
  // The arc form of the outline: every bulged span has the radius it claims.
  const B = res.pieces[0].cutB[0], radii = B.slice(0, -1).filter(q => q[2]).map((q, i, all) => {
    const nx = B[B.indexOf(q) + 1], ch = Math.hypot(nx[0] - q[0], nx[1] - q[1]);
    return ch / (2 * Math.sin(2 * Math.atan(Math.abs(q[2]))));
  });
  t.ok(radii.length === 2 && near(radii[0], Ro, 1e-9) && near(radii[1], Ri, 1e-9) && B[0][2] > 0 && B[2][2] < 0, 'its arcs are the outer radius one way and the inner radius back');
  t.eq(names(go('tool=cone&d1=10&d2=10&pc=2').res), ['Cylinder segment x2'], 'equal diameters are a cylinder');
  t.eq(go('tool=cone&d2=0').res.pieces[0].cutB[0].filter(q => !q[0] && !q[1]).length, 1, 'a full cone comes to its apex');
  const sw = go('tool=cone&d1=10&d2=18').res;
  t.ok(near(row(sw, 'Mean diameters used')[1].len, 18) && near(row(sw, 'Mean diameters used')[2].len, 10), 'diameters given the other way round are swapped');
}

// ===== thickness: dimensions move to the mean line =====
{
  const d = h => row(go(h).res, 'Mean diameters used')[1].len;
  t.eq([d('tool=cone&t=0.25&ref=inside'), d('tool=cone&t=0.25&ref=mean'), d('tool=cone&t=0.25&ref=outside')], [18.25, 18, 17.75], 'inside adds a thickness, outside takes one off');
}

// ===== elbow: parallel line =====
{
  const { res } = go('tool=elbow&dia=8&ang=90&n=5&r=12&l=2&k=4'), ta = Math.tan(Math.PI / 16), C = TAU * 4;
  t.eq(names(res), ['End piece x2', 'Gore x3'], 'a five-piece elbow is two ends and three gores');
  t.ok(near(area(res.pieces[0].cut[0]), C * (2 + 12 * ta), 1e-9) && near(area(res.pieces[1].cut[0]), C * 24 * ta, 1e-9), 'each piece unrolls to its circumference times its centerline length');
  t.ok(near(span(res.pieces[0].cut[0], 0), C) && near(span(res.pieces[1].cut[0], 1), 24 * ta + 8 * ta), 'stretch-out is the circumference; a gore is heel-high');
  const g = row(res, 'Gore: heel / throat'), e = row(res, 'End piece: heel / throat');
  t.ok(near(g[1].len, 2 * ta * 16) && near(g[2].len, 2 * ta * 8) && near(e[1].len, 2 + 16 * ta) && near(e[2].len, 2 + 8 * ta), 'heel and throat are the radius out and in from the centerline');
  t.eq(names(go('tool=elbow&n=2').res), ['End piece x2'], 'a miter is two of one piece');
  t.ok(/Straight length is too short/.test(go('tool=elbow&n=2&l=1').res.warn.join()), 'a throat that goes negative is warned about');
}

// ===== branch =====
{
  const { res } = go('tool=branch&dm=12&db=8&beta=90&l=14&lm=24&k=4&seam=short'), el = res.table.rows.slice(1, 18).map(r => r[2].len);
  t.ok(near(Math.min(...el), 14 - 6) && near(Math.max(...el), 14 - Math.sqrt(36 - 16)) && near(el[0], 8), 'a tee is shortest over the top of the main and longest at its sides');
  const hole = res.pieces[1].cut[1];
  t.ok(near(span(hole, 0), 8, 1e-6) && near(span(hole, 1), 2 * 6 * Math.asin(4 / 6), 1e-6), 'the opening is the branch across and its arc around');
  t.ok(/must not exceed/.test(go('tool=branch&db=13').res.err) && /between 5° and 90°/.test(go('tool=branch&beta=120').res.err), 'a branch that cannot be built is an error, not a pattern');
  t.ok(/needs at least/.test(go('tool=branch&l=3').res.warn.join()) && /too short to contain/.test(go('tool=branch&lm=4').res.warn.join()), 'short lengths are warned about');
}

// ===== pieces that are the same blank are drawn once =====
{
  t.eq(names(go('tool=rtr&pc=4').res), ['Rectangle to round · pieces 1 & 3 of 4 x2', 'Rectangle to round · pieces 2 & 4 of 4 x2'], 'a centred rectangle to round: opposite quarters match');
  t.eq(names(go('tool=rtr&pc=4&w=20&d=20').res), ['Rectangle to round · pieces 1, 2, 3, 4 of 4 x4'], 'square: all four');
  t.eq(go('tool=rtr&pc=4&ox=2').res.pieces.map(q => q.qty), [1, 1, 1, 1], 'offset: none');
  const r2 = go('tool=rect&pc=2').res;
  t.eq(names(r2), ['Rectangle transition · pieces 1 & 2 of 2 x2'], 'a centred transition in halves is one pattern');
  t.ok(r2.notes.some(s => /Identical pieces/.test(s)) && !go('tool=rect&pc=2&ox=3').res.notes.some(s => /Identical pieces/.test(s)), 'and says whose labels it carries');
  const e2 = go('tool=ecc&pc=2').res;
  t.ok(e2.pieces.length === 2 && near(area(e2.pieces[0].cut[0]), area(e2.pieces[1].cut[0])), 'mirror-image halves stay two patterns');
}

// ===== what the form will not pass on =====
{
  const why = h => go(h).why.join(' ');
  t.eq(go('tool=rtr&seam=throat').p.seam, '0', 'a select value from another tool falls back to the default');
  t.ok(go('tool=rtr&seam=throat').res.pieces.length === 1 && app.link.seam === '0', 'and the link is corrected');
  t.eq(why('tool=rtr&dia=-12'), 'Round diameter must be greater than 0.', 'a negative size');
  t.eq(why('tool=rtr&w=0&h=0'), 'Rectangle width must be greater than 0. Height must be greater than 0.', 'zero sizes, each named');
  t.eq(why('tool=rtr&t=0.5&ref=outside&dia=0.25'), 'Round diameter must be larger than the material thickness.', 'a size the thickness uses up');
  t.eq(why('tool=rtr&t=-1'), 'Material thickness can\'t be less than 0.', 'negative thickness');
  t.eq([why('tool=elbow&ang=180'), why('tool=elbow&ang=0')], ['Bend angle must be less than 180.', 'Bend angle must be greater than 0.'], 'bend angle');
  t.ok(go('tool=cone&d2=0').bad.length === 0 && go('tool=rtr&ox=-5').bad.length === 0, 'a point cone and a negative offset are fine');
  t.eq(go('tool=rtr&dia=12 1/').bad, ['dia'], 'something that is not a number is only flagged');
  t.ok(go('tool=elbow&n=2&r=abc').bad.length === 0 && go('tool=elbow&n=3&r=abc').bad.join() === 'r', 'a hidden field cannot block; shown, it does');
  const k = go('tool=rtr&k=200');
  t.ok(k.p.k === 48 && /whole number from 2 to 48; using 48/.test(k.note.join()) && go('tool=rtr&k=6').note.length === 0, 'a clamped count says what it used');
}

// ===== typed numbers =====
{
  const P = app.ev('parseNum'), F = app.ev('frac');
  t.eq(['12 1/2', '12-1/2"', '-3/4', '.5', '45°', '7 in'].map(s => P(s, 'in')), [12.5, 12.5, -0.75, 0.5, 45, 7], 'fractions, signs and suffixes');
  t.ok(near(P('300mm', 'in'), 300 / 25.4) && P('300mm', 'mm') === 300 && near(P('2in', 'mm'), 50.8) && P('300mm') === 300, 'the other unit\'s suffix converts when the field has a unit');
  t.ok(['', 'abc', '12 1/', '1/0', '1e3', '5.'].every(s => !isFinite(P(s, 'in'))), 'and what is not a number is not one');
  t.eq([F(12.5), F(0.1875), F(-2.75), F(3), F(0.03125, 64), F(0.01)], ['12 1/2', '3/16', '-2 3/4', '3', '1/32', '0'], 'sixteenths, reduced');
}
t.done();
