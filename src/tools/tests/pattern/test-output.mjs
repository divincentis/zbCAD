// What leaves the page: the link, the DXF, the CSV and the full-size PDF, and the states in
// which nothing may leave it at all.
import {boot, suite, dxfEntities} from './harness.mjs';
const t = suite();
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const IN = 72;

// ===== the link is the saved fitting =====
{
  const app = boot('#tool=elbow&n=3&lb=1');
  t.eq([app.link.tool, app.link.n, app.link.ang, app.link.lb], ['elbow', '3', '90', '1'], 'a short link is filled out with the tool\'s defaults');
  t.eq(app.document.title, 'Elbow / miter · Sheet Metal Layout', 'and the tab is named for the fitting');
  app.type('dia', '10');
  t.eq(app.link.dia, '10', 'an edit is in the link at once');
  app.open('#tool=cone&u=mm&d1=500&d2=250&h=300');
  t.eq([app.title(), app.link.u, app.link.d1], ['Cone / reducer 1 pattern', 'mm', '500'], 'a link opened over the page replaces it');
  t.eq(app.ev('S').vals.elbow.dia, '254', 'and what was entered in another tool is carried into the link\'s units');
  app.open('#tool=elbow&u=in');
  t.eq([app.link.tool, app.link.u, app.link.dia], ['elbow', 'in', '8'], 'a link names its whole fitting: fields it leaves out are defaults');
}

// ===== a drawing that does not match the form cannot be exported =====
{
  const app = boot();
  t.eq([app.title(), app.msgs(), app.canExport()], ['Rectangle to round 1 pattern', '', [true, true, true, true]], 'a valid fitting can go anywhere');
  const good = app.press('dxf').data;
  app.type('dia', '12 1/');
  t.eq([app.msgs(), app.canExport(), app.press('dxf'), app.press('csv')], ['Check the highlighted values.', [false, false, false, false], null, null], 'half a fraction: nothing exports');
  t.eq(app.title(), 'Rectangle to round 1 pattern', 'though the last drawing stays up');
  app.type('dia', '-3');
  t.eq(app.msgs(), 'Round diameter must be greater than 0.', 'a value out of range says which and why');
  app.type('dia', '12');
  t.ok(app.msgs() === '' && app.canExport().every(Boolean) && app.press('dxf').data === good, 'put right, it is the same fitting again');
  app.open('#tool=branch&db=13');
  t.eq([app.title(), app.msgs(), app.canExport()], ['Branch / tee / lateral', 'Branch diameter must not exceed the main diameter.', [false, false, false, false]], 'an error with no drawing of its own to keep shows none');
  t.eq(app.$('#gridlbl').textContent, '', 'not even a grid size');
  app.type('k', '200');
  app.type('db', '8');
  t.ok(/using 48/.test(app.msgs()) && app.canExport().every(Boolean), 'a clamped count is a note, not an error');
}

// ===== DXF =====
{
  const app = boot(), of = h => dxfEntities(app.open('#' + h).press('dxf').data), by = (e, ty, ly) => e.filter(q => q.type === ty && (!ly || q.layer === ly));
  const raw = app.open('#tool=rect&pc=2&ox=3&lb=1').press('dxf');
  t.ok(raw.name === 'rect-pattern.dxf' && /^[\x00-\x7f]*$/.test(raw.data) && /\$INSUNITS\r\n70\r\n1\r\n/.test(raw.data), 'plain ASCII, in inches');
  t.ok(/\$INSUNITS\r\n70\r\n4\r\n/.test(app.open('#tool=rect&u=mm').press('dxf').data), 'or millimetres');
  const rect = dxfEntities(raw.data);
  t.eq(by(rect, 'TEXT').filter(q => /piece/.test(q.text)).map(q => q.text), ['Rectangle transition - piece 1 of 2', 'Rectangle transition - piece 2 of 2'], 'piece names in characters R12 has');
  t.ok(by(rect, 'TEXT').some(q => q.text === "C1'") && !by(of('tool=rect&pc=2&ox=3'), 'TEXT').some(q => q.text === "C1'"), 'point labels only when they are on');
  const rtr = of('tool=rtr');
  t.eq([by(rtr, 'POLYLINE', 'CUT').map(q => q.closed), by(rtr, 'LINE', 'CUT').length, by(rtr, 'LINE', 'BEND').length, by(rtr, 'LINE', 'FORM').length], [[true], 0, 8, 20], 'an outline is one closed polyline; breaks and roll lines are lines on their own layers');
  t.eq(by(rtr, 'POLYLINE')[0].pts.length, 34, 'with each corner once');
  const cone = of('tool=cone&d1=18&d2=10&h=10&pc=2'), c = by(cone, 'POLYLINE', 'CUT')[0], s = Math.hypot(10, 4);
  const rad = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]) / (2 * Math.sin(2 * Math.atan(Math.abs(a[2]))));
  t.ok(c.closed && c.pts.length === 4 && near(rad(c.pts[0], c.pts[1]), 9 * s / 4, 1e-4) && near(rad(c.pts[2], c.pts[3]), 9 * s / 4 - s, 1e-4) && !c.pts[1][2] && !c.pts[3][2], 'a cone is two true arcs and two straight edges');
  t.eq(by(cone, 'TEXT').map(q => q.text), ['Cone segment - CUT 2'], 'under its name and quantity');
  t.eq(by(of('tool=cone&d1=18&d2=10&h=10'), 'POLYLINE')[0].pts.filter(q => q[2]).length, 4, 'a wide one in arcs short enough to keep their bulge moderate');
  const elbow = of('tool=elbow');
  t.eq([by(elbow, 'POLYLINE', 'CUT').map(q => q.closed), by(elbow, 'LINE', 'CUT').length], [[true, true], 0], 'an elbow\'s two patterns are two outlines');
  t.eq(by(of('tool=branch'), 'POLYLINE', 'CUT').map(q => q.closed), [true, true, true], 'the main template is its sheet and the opening in it');
}

// ===== CSV =====
{
  const app = boot('#tool=cone'), csv = app.press('csv');
  t.ok(csv.name === 'cone-pattern.csv' && csv.data.startsWith('﻿Item,Value,\n') && /\nSlant height,10\.7703,\n/.test(csv.data), 'the table, behind a mark that tells a spreadsheet it is UTF-8');
}

// ===== grid =====
{
  const app = boot(), grid = h => app.open('#' + h).$('#gridlbl').textContent;
  t.eq([grid('tool=rtr'), grid('tool=cone&d1=1&d2=0.5&h=0.75'), grid('tool=cone&d1=0.2&d2=0.1&h=0.1'), grid('tool=cone&u=mm&d1=30&d2=20&h=10')], ['Grid 6″', 'Grid 1/4″', 'Grid 1/32″', 'Grid 5 mm'], 'an inch grid is a size a tape measure has');
}

// ===== full-size PDF =====
{
  const app = boot(), sizes = p => [...new Set(p.pages.map(q => q.join('x')))];
  const a = app.print();
  t.ok(/^19 sheets of pattern \+ cover \+ 1 data page\. 5×4 grid, landscape, rotated 90°\.$/.test(a.sum) && a.pages.length === 21 && a.name === 'rtr-full-scale-letter.pdf', 'the default fitting on Letter is 19 sheets, a cover and a table');
  t.eq(sizes(a), ['792x612', '612x792'], 'every page is a Letter sheet');
  t.ok(a.pdf.startsWith('%PDF-1.6') && /\/PrintScaling \/None/.test(a.pdf) && new RegExp(`/Count ${a.pages.length} `).test(a.pdf), 'a PDF that asks to be printed at size');
  t.ok(/\(\\225 C = rectangle corners/.test(a.pdf) && /1\\205 = round division/.test(a.pdf) && !/\(\? /.test(a.pdf), 'notes keep their bullets and ellipsis');
  t.ok(/\(MATCH LINE \\227 sheet A2 laps here\)/.test(a.pdf) && /\(Sheet A1 \\267 row A of 4, col 1 of 5/.test(a.pdf), 'sheets say where they go');
  t.ok(!/1\.00 1\.00 1\.00 rg/.test(a.pdf), 'and nothing is painted over the pattern');
  const signed = p => [p.pdf.match(/\(zbCAD\) Tj/g)?.length, p.pdf.match(/\(Sheet Metal Layout \\267 zbcad\.com\) Tj/g)?.length];
  t.eq(signed(a), [21, 21], 'every page is signed: cover, sheets and table');
  t.ok(/\/Info \d+ 0 R/.test(a.pdf) && /\/Title \(Rectangle to round - full-scale layout\) \/Producer \(zbCAD Sheet Metal Layout, zbcad\.com\)/.test(a.pdf), 'and so is the file');
  // The dialog keeps its settings from one opening to the next, so each is put back.
  t.ok(/\(M3\) Tj/.test(a.pdf) && !/\(M3\) Tj/.test(app.print({ labels: false }).pdf), 'point labels are a choice');
  t.eq(app.print({ labels: true, cover: false, table: false }).pages.length, 19, 'so are the cover and the table');
  t.eq(app.print({ cover: true, table: true, skip: false }).pages.length, 20 + 2, 'and the sheet nothing lands on');
  app.print({ skip: true });

  const tiny = app.print({ paper: 'custom', cw: '2', ch: '2' });
  t.ok(!tiny.ok && /Paper is too small/.test(tiny.sum) && tiny.pdf === '', 'paper smaller than its own margins prints nothing');

  // A roll: the long side is a limit, and each page is cut to what is on it.
  app.open('#tool=elbow');
  const r = app.print({ paper: 'custom', cw: '36', ch: '120' });
  t.ok(/Piece 1: 1×1 grid, portrait, 36 × 6\.905 in page; Piece 2: 1×1 grid, portrait, 36 × 8\.087 in page\./.test(r.sum), 'the summary gives each page\'s size');
  t.eq(r.pages.map(q => q[0]), [36 * IN, 36 * IN, 36 * IN, 36 * IN], 'every page is the roll\'s width');
  t.ok(r.pages.every(q => q[1] <= 8.5 * IN) && near(r.pages[1][1] / IN, 6.905, 1e-3) && near(r.pages[2][1] / IN, 8.087, 1e-3), 'and none runs past what it holds');
  const side = app.print({ orient: 'l' });
  t.eq(side.pages.slice(1, 3), [[8.5 * IN, 36 * IN], [8.5 * IN, 36 * IN]], 'fed sideways, a page keeps a letter\'s width for its footer');
  const fixed = app.print({ paper: 'archd', orient: 'auto' });
  t.eq(sizes(fixed), ['2592x1728', '1728x2592'], 'a cut sheet is never trimmed');

  // Identical pieces are printed once.
  app.open('#tool=cone&pc=12');
  const c = app.print({ paper: 'letter' });
  t.ok(/^2 sheets of pattern/.test(c.sum) && /\(1\. Cone segment \\227 cut 12\)/.test(c.pdf), 'twelve cone segments are two sheets, and the cover says cut 12');
  app.open('#tool=rtr&pc=4');
  const q = app.print();
  t.ok(/^12 sheets of pattern/.test(q.sum) && /\(1\. Rectangle to round \\267 pieces 1 & 3 of 4 \\227 cut 2\)/.test(q.pdf), 'matching quarters are printed once each pair');
  t.ok(/\(1\. Rectangle to round \\267 pieces 1 & 3 of 4\) Tj/.test(q.pdf), 'the sheet map captions a piece by name where there is room');
  app.open('#tool=rtr&pc=4&w=20&d=20');
  const long = app.print({ orient: 'p', cover: false, table: false });
  t.ok(signed(long)[0] === long.pages.length && !signed(long)[1], 'beside a long piece name the mark gives up its address line, not its place');
  app.print({ orient: 'auto', cover: true, table: true });
  app.open('#tool=rtr&pc=4&ox=2');
  t.ok(/\(4\.\) Tj/.test(app.print().pdf), 'and by its number alone where there is not');
}
t.done();
