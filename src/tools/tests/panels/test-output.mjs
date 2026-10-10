// What leaves the page: quantities, cut list views, the drawing plan, the PDF package, CSV
// and saved files, and the edits that reach them through the inputs pane.
import {boot, suite} from './harness.mjs';
const t = suite(), app = boot();
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const DATE = 'Oct 8, 2026';
// The project default, p2, and what its 24" coil (23-7/8" as slit) covers once the seams are formed.
const SNAP = '1-3/4" snap-lock, 17-3/4" on 23-7/8" coil';

// ===== first visit opens a new project at its setup step =====
{
  t.eq([app.ev('S').t, app.P.facets.map(f => [f.mark, f.kind, f.template, f.inputMode]), app.P.name], ['setup', [['R1', 'roof', 'rect', 'slope']], 'Untitled project'], 'a first visit starts a project: one rectangle of roof, on the setup step');
  t.eq(app.P.def.allow, { eave: 4 }, 'with a 4" eave overhang as the one allowance set');
  const html = () => app.$('#inputs').innerHTML;
  t.ok(['p.name', 'p.jobNo', 'd.profileId', 'f.kind', 'f.template'].every(b => html().includes(`data-b="${b}"`)) && !html().includes('data-b="m.w"'), 'which asks for the job, the profile and the first facet, and no dimensions yet');
  app.type('f.kind', 'sel', 'wall');
  t.eq([app.ev('S').t, app.P.facets[0].mark], ['setup', 'W1'], 'answering it stays on the step');
  t.ok(app.ev('untouched')() === false, 'and the project now has something to lose');
  app.ev('ACT').sel({ dataset: { t: 'facet', id: app.P.facets[0].id } });
  t.ok(app.ev('S').t === 'facet' && html().includes('data-b="m.w"'), 'its button goes on to the facet\'s dimensions');
  app.ev('CMD').new();
  t.eq([app.ev('S').t, app.P.facets.length, app.ev('untouched')()], ['setup', 1, true], 'New starts the same way');
  t.ok(/data-act="sel" data-t="project"><span>Project settings/.test(app.$('#tree').innerHTML), 'project settings have a row of their own in the tree');
}

// ===== the sample =====
{
  app.ev('ACT').sample();
  const R = app.ev('compute')();
  t.eq(app.P.facets.map(f => f.mark), ['R1', 'R2', 'R3', 'R4'], 'sample facets are R1-R4');
  // A 40 x 28 hip roof has 1,120 sf of plan area whatever its facets look like. The sample is
  // entered the way a roof is taped, on the slope: 17'-6" at 9:12 is 14' of run.
  t.eq(R.warn, [], 'the sample opens without a warning');
  t.ok(app.P.facets.every(f => f.inputMode === 'slope'), 'sample: dimensions are on the slope');
  t.ok(near(R.total.plan, 40 * 28, 1e-6) && near(R.total.slope, 40 * 28 * Math.hypot(12, 9) / 12, 1e-6), 'sample: plan area is the footprint, slope area is that over cos(pitch)');
  const marks = R.pk[0].facets.flatMap(f => app.ev('byMark')(R.L.get(f.id).pieces));
  t.ok(marks.length > 0 && new Set(marks.map(r => r.p.id)).size === marks.length && marks.reduce((a, r) => a + r.qty, 0) === R.total.count, 'IDs are unique across the project, and their quantities account for every piece');
  const front = app.ev('byMark')(R.L.get(app.P.facets[0].id).pieces);
  t.ok(front.filter(r => r.p.square).length === 1 && front.find(r => r.p.square).qty === 8 && front.filter(r => !r.p.square).every(r => r.qty === 1), 'the eight full panels under the ridge share an ID; each hip cut, being handed, has its own');
  const q = R.total, parts = q.wAllow + q.wLap + q.wAngle + q.wRip + q.wRound;
  t.ok(Math.abs(parts - (q.cover - q.slope)) < 0.01, 'acceptance: waste components sum to the waste total within 0.01 sf');
  t.ok(near(app.ev('wasteOf')(q).sf, q.cover - q.slope) && q.gross > q.cover, 'waste is coverage less roof; gross is more than coverage');
  t.ok(near(q.cover, q.lf * 17.75 / 12) && near(q.gross, q.lf * 23.875 / 12), 'coverage and gross are linear length x coverage and sheet width');
  app.flush();
  t.ok(JSON.parse(app.store.get('panels.autosave')).facets.length === 4, 'and it is autosaved');
  // Coverage is the stock coil less the seam's material, so it is the coil that is round, not the panel.
  t.eq(app.P.profiles.map(p => [p.type, p.sheetW, p.sheetW - p.cover]), [
    ['ssmr-snap', 20, 6.125], ['ssmr-snap', 23.875, 6.125], ['ssmr-snap', 20, 5.125], ['ssmr-snap', 23.875, 5.125], ['ssmr-snap', 20, 5.3125], ['ssmr-snap', 23.875, 5.3125],
    ['ssmr-mech', 16, 4], ['ssmr-mech', 20, 4], ['ssmr-mech', 23.875, 4], ['ssmr-mech', 20, 5.8125], ['ssmr-mech', 23.875, 5.8125],
    ['flush', 16, 4], ['flush', 20, 4], ['flush', 23.875, 4], ['flush', 20, 5], ['flush', 23.875, 5], ['exposed', 38, 2]], 'starter profiles: each seam on the stock coils that leave it 12" or more of coverage, and 36" exposed');
  const dflt = app.P.profiles.find(p => p.id === app.P.def.profileId);
  t.eq([dflt.name, dflt.cover, dflt.rib], [SNAP, 17.75, 1.75], 'the default is the 1-3/4" snap-lock on a nominal 24" coil');
  t.ok(new Set(app.P.profiles.map(p => p.name)).size === app.P.profiles.length, 'every starter has a name of its own');
  t.ok(app.P.profiles.every(p => /verify with manufacturer/.test(p.mfr)), 'each marked to verify with the manufacturer');
}

// ===== packages, cut list views, drawing, package output =====
{
  const p = app.ev('sampleProject')();
  p.name = 'Hip roof (test)'; p.jobNo = '26-114'; p.address = '12 Mill Rd';
  p.profiles.find(q => q.id === 'p2').maxLen = 180;
  p.packages.push({ id: 'kw', name: 'East wall', prefix: '', facetIds: [] });
  p.profiles.find(q => q.id === 'p17').color = 'Galvalume'; p.def.allow.base = 1;
  const wall = app.ev('newFacet')(p, p.packages[1], { kind: 'wall', name: 'North gable', template: 'gable', ov: { profileId: 'p17' } });
  Object.assign(wall.params, { w: 360, h: 120, h2: 210 });
  wall.openings.push({ x: 61, y: 0, w: 38, h: 84 });
  app.load(p);
  const R = app.ev('compute')(), [roof, walls] = R.pk;
  t.eq(R.pk.map(g => g.facets.length), [4, 1], 'facets sit in their own package');
  t.eq(app.P.facets[4].mark, 'W1', 'the wall is W1');
  t.ok(near(R.total.slope, roof.q.slope + walls.q.slope) && R.total.count === roof.q.count + walls.q.count, 'project total is the sum of the packages');
  t.ok(roof.q.planKnown && !R.total.planKnown, 'plan area is only reported where every facet has a pitch');
  t.ok(near(roof.q.trim.hip, 8 * R.L.get(app.P.facets[0].id).edges[1].len / 12), 'trim length adds up by edge type, per facet');
  t.ok(roof.q.splices === R.L.get(app.P.facets[0].id).q.splices * 2 + R.L.get(app.P.facets[2].id).q.splices * 2 && roof.q.splices > 0, 'splice locations are counted per facet and rolled up');
  t.eq(walls.q.splices, 0, 'none on the exposed-fastener wall');

  // Production view.
  const prod = app.ev('production')([roof]);
  t.ok(prod.every((x, i) => !i || x.len < prod[i - 1].len), 'production rows run longest first, one per ordered length');
  t.eq(prod.reduce((s, x) => s + x.qty, 0), roof.q.count, 'and account for every piece');
  t.ok(/R1-\d+ ×\d+/.test(prod[0].ids) && /R2-\d+ ×\d+/.test(prod[0].ids), 'a row lists each ID to mark and how many of it');
  t.ok(prod.every(r => r.profile === SNAP), 'each row names its profile');
  const both = app.ev('production')(R.pk);
  t.ok(both.some(r => r.color === 'Galvalume' && /^W1-/.test(r.ids)) && both.filter(r => r.color === 'Galvalume').every(r => !/R\d/.test(r.ids)), 'different profile and color never share a row');
  const buy = app.ev('purchasing')(R.pk);
  t.eq(buy.map(r => [r.profile, r.color]), [[SNAP, ''], ['36" exposed fastener (R / PBR)', 'Galvalume']], 'purchasing summary by profile and color');
  t.ok(near(buy[0].count, roof.q.count) && near(buy[1].gross, walls.q.gross), 'with piece count and gross area');

  // The drawing plan.
  const L = R.L.get(app.P.facets[0].id), plan = app.ev('facetPlan')(L, 720, 480), txt = plan.ops.filter(o => o.k === 'text');
  t.ok(L.pieces.every(p => txt.some(o => o.s === p.id)), 'every piece is labelled on the layout');
  const idOps = txt.filter(o => o.id);
  t.ok(idOps.filter(o => o.rot === -90).length > idOps.length / 2 && Math.max(...idOps.map(o => o.size)) > 9, 'IDs read up the panel, as large as the strip allows');
  const blanks = plan.ops.filter(o => o.blank), cut = L.pieces.filter(p => !p.square), X = v => plan.tx.ox + (v - plan.tx.xmin) * plan.tx.s;
  t.ok(cut.length > 0 && blanks.length === cut.length && blanks.every((b, i) => near(b.pts[0][0], X(cut[i].ca)) && near(b.pts[1][0], X(cut[i].cb)) && near(b.pts[0][1] - b.pts[2][1], cut[i].raw * plan.tx.s)), 'a piece cut on an angle shows the square blank it is trimmed from');
  t.ok(plan.ops.indexOf(blanks[blanks.length - 1]) < plan.ops.findIndex(o => o.k === 'poly' && o.fill), 'drawn under the pieces, so only the offcut shows');
  t.eq(app.ev('facetPlan')(L, 200, 150, { thumb: true }).ops.filter(o => o.blank).length, 0, 'and left off the overview tiles');
  t.ok(txt.some(o => o.s === 'Eave 480') && txt.some(o => /^Hip /.test(o.s)), 'edges are labelled with type and dimension');
  t.ok(txt.some(o => o.s === 'SPLICE'), 'splice seams are tagged');
  t.ok(txt.some(o => o.s === 'panel run') && txt.some(o => o.s === 'lay'), 'run and lay direction arrows');
  t.ok(plan.ops.some(o => o.k === 'poly' && o.dash && o.stroke === 'accent'), 'the allowance line is dashed outside the facet');
  const xy = plan.ops.flatMap(o => o.k === 'poly' ? o.pts : o.k === 'line' ? [[o.x1, o.y1], [o.x2, o.y2]] : [[o.x, o.y]]);
  t.ok(xy.every(q => q[0] >= 0 && q[0] <= 720 && q[1] >= 0 && q[1] <= 480), 'nothing is drawn off the sheet');
  const s = plan.tx.s, outline = plan.ops.find(o => o.k === 'poly' && o.stroke === 'ink');
  t.ok(near(outline.pts[1][0] - outline.pts[0][0], 480 * s) && near(outline.pts[0][1] - outline.pts[2][1], L.pts[2][1] * s), 'one scale in both directions');
  const Lw = R.L.get(app.P.facets[4].id);
  t.ok(app.ev('facetPlan')(Lw, 720, 480).ops.some(o => o.k === 'text' && /^rip /.test(o.s)) === Lw.pieces.some(p => p.rip != null), 'partial rips are dimensioned when there are any');
  t.ok(app.ev('planSVG')(plan.ops).includes('>R1-01<'), 'the plan renders to SVG');

  // Acceptance: on Letter, no clipped or overlapping panel IDs. Boxes are taken from the same
  // font metrics the PDF is set with.
  const tw = app.ev('textW'), box = o => {
    const w = tw(o.s, o.size), h = o.size * 0.72;
    return o.rot ? [o.x - h, o.y - w / 2, o.x, o.y + w / 2] : [o.x - w / 2, o.y - h, o.x + w / 2, o.y];
  };
  for (const f of app.P.facets) {
    const Lf = R.L.get(f.id), ids = app.ev('facetPlan')(Lf, 416, 430).ops.filter(o => o.id).map(box);
    t.eq(ids.length, Lf.pieces.length, `${f.mark}: every ID is placed`);
    t.ok(ids.every(b => b[0] >= 0 && b[2] <= 416 && b[1] >= 0 && b[3] <= 430), `${f.mark}: no ID is clipped by the sheet`);
    let clash = 0;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { const a = ids[i], b = ids[j]; if (a[0] < b[2] - 0.2 && b[0] < a[2] - 0.2 && a[1] < b[3] - 0.2 && b[1] < a[3] - 0.2) clash++; }
    t.eq(clash, 0, `${f.mark}: no two IDs overlap`);
  }

  // The package.
  const pages = app.ev('reportPages')(DATE), titles = pages.map(x => x.title), pdf = app.ev('buildPDF')(DATE);
  t.ok(pages.every(x => x.w === 792 && x.h === 612), 'Letter landscape');
  t.eq(titles[0], 'Hip roof (test)', 'sheet 1 is the cover');
  const order = ['Overview: Main roof', 'Facet R1: Front', 'Production cut list: Main roof', 'Coil order'].map(x => titles.indexOf(x));
  t.ok(order.every((x, i) => x > 0 && (!i || x > order[i - 1])), 'then overview, facet sheets, production list, coil order');
  const cover = pages[0].ops.filter(o => o.k === 'text'), at = x => cover.find(o => o.s === x);
  t.ok(at('Quantities and waste') && at('Package total') && at('Quantities and waste').y > at('Package').y && at('Package total').y > at('Quantities and waste').y && !titles.includes('Quantities and waste'), 'quantities and waste are on the cover, under the package list');
  t.ok(pages.every(pg => pg.ops.some(o => o.s === 'zbCAD' && o.bold) && pg.ops.some(o => /zbcad\.com/.test(o.s)) && pg.ops.filter(o => o.k === 'line' && o.stroke === 'bg').length === 3), 'every sheet carries the zbCAD mark and name');
  t.ok(app.P.facets.every(f => titles.some(x => x.startsWith('Facet ' + f.mark))), 'a sheet for every facet');
  const text = pg => pg.ops.filter(o => o.k === 'text').map(o => o.s);
  t.ok(pages.every((pg, i) => text(pg).includes(`Page ${i + 1} of ${pages.length}`) && text(pg).some(x => /lengths in inches · Verify all dimensions in field\./.test(x)) && text(pg).some(x => /Hip roof \(test\) · Job 26-114/.test(x))), 'title block on every sheet: project, units note, verify note, page x of y');
  const r1 = pages[titles.indexOf('Facet R1: Front')];
  t.ok(text(r1).some(x => /^R1-\d+$/.test(x)) && text(r1).includes('Qty') && text(r1).includes('SPL') && text(r1).includes('Short side') && r1.ops.some(o => o.k === 'poly'), 'a facet sheet carries the drawing and its cut list');
  t.ok(pages.flatMap(x => x.ops).every(o => o.k !== 'text' || (o.x >= 0 && o.x <= 792 && o.y >= 0 && o.y <= 612)), 'no text is placed off a sheet');
  t.ok(/^%PDF-1\.4\n/.test(pdf) && /%%EOF\n$/.test(pdf), 'PDF header and trailer');
  t.ok(!/[^\x00-\x7f]/.test(pdf), 'PDF is pure ASCII, so its offsets survive being saved as text');
  t.eq((pdf.match(/\/Type \/Page /g) || []).length, pages.length, 'one page object per sheet');
  // Every xref entry has to point at the object it claims to, or readers refuse the file.
  const xref = +pdf.match(/startxref\n(\d+)/)[1], rows = pdf.slice(xref).match(/\d{10} 00000 n /g);
  t.ok(pdf.startsWith('xref', xref) && rows.every((r, i) => pdf.startsWith(`${i + 1} 0 obj`, +r.slice(0, 10))), 'xref offsets are exact');
  t.ok([...pdf.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)].every(m => +m[1] === m[2].length), 'stream lengths are exact');
  t.eq(app.ev('buildPDF')(DATE), pdf, 'same project, same bytes');
  t.eq(app.ev('pdfStr')('6" (x) \\ · ½ ☃ –'), '6" \\(x\\) \\\\ \\267 \\275 ? \\226', 'text escaping');
  const one = app.ev('reportPages')(DATE, 'kw').map(x => x.title);
  t.ok(one.includes('Facet W1: North gable') && !one.some(x => /R1/.test(x)) && one.includes('Overview: East wall'), 'a package can be exported alone');
  app.P.sheet = 'tabloid';
  t.ok(app.ev('reportPages')(DATE).every(x => x.w === 1224 && x.h === 792), 'Tabloid landscape');
  app.P.sheet = 'letter';
  // Print uses the same sheets, as SVG.
  app.ev('CMD').print();
  t.ok((app.$('#print').innerHTML.match(/<svg /g) || []).length === pages.length && /size:11in 8.5in/.test(app.$('#pagesize').textContent), 'print lays the same sheets out as SVG at the sheet size');

  // CSV.
  const loc = app.ev('buildCSV')('loc').trim().split('\r\n'), len = app.ev('buildCSV')('len').trim().split('\r\n');
  t.ok(loc.length === 1 + app.P.facets.reduce((a, f) => a + app.ev('byMark')(R.L.get(f.id).pieces).length, 0) && loc.slice(1).reduce((a, r) => a + +r.split(',')[1], 0) === R.total.count, 'facet CSV: one row per ID, with quantities that account for every piece');
  t.ok(loc[1].startsWith('R1-01,1,Main roof,R1 Front,"1-3/4"" snap-lock, 17-3/4"" on 23-7/8"" coil",,'), 'with ID, quantity, package, facet and profile');
  t.ok(loc.some(r => /REQUIRES SPLICE/.test(r)), 'and the splice flag');
  t.eq(len.length, 1 + app.ev('production')(R.pk).length, 'production CSV: one row per length');
  t.ok(/^\d+,180,180,/.test(len[1]), 'with the length as displayed and in decimal inches');
  app.P.units.fmt = 'ftin';
  t.ok(/^\d+,"15'-0""",180,/.test(app.ev('buildCSV')('len').split('\r\n')[1]), 'displayed units follow the project setting');
  t.ok(app.ev('reportPages')(DATE)[0].ops.some(o => /lengths in feet and inches/.test(o.s)), 'and so does the units note');
  app.P.units.fmt = 'frac';

  // A report can show lengths its own way without touching the screen's setting.
  app.P.units.pdf = 'dec'; app.P.units.csv = 'mm';
  const dec = app.ev('reportPages')(DATE);
  t.ok(dec[0].ops.some(o => /lengths in decimal inches/.test(o.s)) && dec.flatMap(x => x.ops).some(o => o.s === '180.00'), 'the PDF can take its own length format');
  t.ok(/^\d+,4572,180,/.test(app.ev('buildCSV')('len').split('\r\n')[1]), 'and so can the CSV, which still carries decimal inches');
  t.eq([app.P.units.fmt, app.ev('fmtLen')(180)], ['frac', '180'], 'neither changes what the screen shows');
  t.eq(app.ev('checkProject')(JSON.parse(JSON.stringify(app.P))).units, { bare: 'in', fmt: 'frac', prec: 16, area: 'sf', pdf: 'dec', csv: 'mm' }, 'and both are saved with the project');
  app.P.units.pdf = app.P.units.csv = null;

  // North arrow.
  const north = o => app.ev('facetPlan')(app.ev('compute')().L.get(app.P.facets[0].id), 720, 480).ops.filter(x => x.s === 'N');
  t.eq(north().length, 0, 'no north arrow unless one is asked for');
  app.select('R1'); app.type('f.north', 'numopt', '90');
  const N = north()[0], shaft = app.ev('facetPlan')(app.ev('compute')().L.get(app.P.facets[0].id), 720, 480).ops.filter(x => x.k === 'line').pop();
  t.ok(N && Math.abs(shaft.y2 - shaft.y1) < 1e-6 && shaft.x2 > shaft.x1, 'north at 90 degrees points to the right of the sheet');
  t.ok(app.ev('reportPages')(DATE).find(x => x.title.startsWith('Facet R1')).ops.some(x => x.s === 'N'), 'and it is on the facet sheet');
  app.type('f.north', 'numopt', '');
  t.eq(app.P.facets[0].north, null, 'blank removes it');
}

// ===== files =====
{
  const check = app.ev('checkProject'), saved = JSON.parse(JSON.stringify(app.P));
  t.eq(JSON.parse(JSON.stringify(check(saved))), saved, 'a saved project reloads unchanged');
  t.ok(!('pieces' in saved) && !JSON.stringify(saved).includes('R1-01'), 'panels are derived: a save holds inputs only');
  t.eq(saved.v, 1, 'the schema carries a version');
  t.throws(() => check(null), /not a panel layout/, 'null rejected');
  t.throws(() => check({ tasks: [] }), /not a panel layout/, 'another tool\'s file rejected');
  t.throws(() => check({ ...saved, v: 2 }), /newer version/, 'a newer schema is refused, not guessed at');
  const odd = check({ profiles: [{ cover: 'wide', type: 'nope', maxLen: -5 }, 7], packages: [{ facetIds: ['a', 'ghost'], def: { profileId: 'gone', split: 'sideways', round: 0.3, allow: { eave: 'x', hip: 2 } } }, 7],
    facets: [{ id: 'a', template: 'custom', pts: [[0, 0], ['a', 1]], inputMode: 'plan', pitch: 'steep', params: { w: -3 }, layout: { start: 'sideways', angle: 400 }, edges: [{ type: 'eave', allow: 2 }, { type: 'bogus' }, null], openings: [null, { w: 20 }], ov: { split: 'nope', lap: 4 } },
      { id: 'b', kind: 'wall', template: 'tri' }, null] });
  const f = odd.facets[0], d = odd.def;
  t.eq([odd.profiles.length, odd.profiles[0].cover, odd.profiles[0].type, odd.profiles[0].maxLen], [1, 16, 'ssmr-snap', 480], 'bad profile values fall back');
  t.eq([odd.packages.length, d.profileId, d.split, d.round, d.allow], [1, odd.profiles[0].id, 'max', 0.25, { hip: 2 }], 'bad default values fall back');
  t.eq([f.template, f.pitch, f.params.w, f.layout.start, f.layout.angle, f.edges, f.openings.length, f.ov], ['rect', null, 240, 'left', 0, [{ type: 'eave', allow: 2 }, { type: null, allow: null }, { type: null, allow: null }], 1, { lap: 4 }], 'bad facet values fall back');
  t.eq(odd.facets[1].template, 'rect', 'a roof template on a wall falls back');
  t.eq(odd.packages[0].facetIds, [odd.facets[0].id, odd.facets[1].id], 'an unknown facet id is dropped and an unclaimed facet is adopted');
  {
    // Defaults were once per package: the first package's become the project's, and a later
    // package's differences survive as overrides on its facets.
    const was = { profiles: saved.profiles, facets: [{ id: 'a' }, { id: 'b' }, { id: 'c', ov: { split: 'eave' } }],
      packages: [{ facetIds: ['a'], def: { profileId: 'p2', split: 'max', lap: 4, allow: { eave: 2 } } }, { facetIds: ['b', 'c'], def: { profileId: 'p7', split: 'equal', allow: { eave: 9 } } }] };
    const now = check(was), [a, b, c] = now.facets;
    t.eq([now.def.profileId, now.def.lap, now.def.allow, now.packages.map(k => Object.keys(k).sort())], ['p2', 4, { eave: 2 }, [['extraPanels', 'facetIds', 'id', 'name', 'prefix'], ['extraPanels', 'facetIds', 'id', 'name', 'prefix']]], 'older file: the first package\'s defaults become the project\'s');
    t.eq([a.ov, b.ov, c.ov], [{}, { profileId: 'p7', split: 'equal', lap: 6 }, { split: 'eave', profileId: 'p7', lap: 6 }], 'older file: a later package\'s profile, split and lap carry over as facet overrides');
  }
  app.load(odd);
  t.ok(app.ev('compute')().total.count > 0, 'and the result lays out');
  t.eq(check({ ...saved, facets: [{ ...saved.facets[0], layout: { dir: 'edge', dirEdge: 1.5 } }] }).facets[0].layout.dirEdge, 2, 'an edge is named by a whole number, whatever the file says');
  // A project can check out field by field and still be one the engine cannot draw. It must
  // not take the open project's place before that is known.
  const open = app.P.name;
  app.ev('globalThis.realLayout = layoutFacet; layoutFacet = (f, e) => { if (P.name === "Trouble") throw new Error("boom"); return realLayout(f, e); }');
  t.throws(() => app.load({ ...saved, name: 'Trouble' }), /could not be laid out/, 'a project the engine cannot draw is refused');
  t.ok(app.P.name === open && app.ev('R').L.size === app.P.facets.length && app.ev('R').total.count > 0, 'and the one that was open is still open, and still laid out');
  app.ev('layoutFacet = realLayout');

  const fresh = boot(undefined, { autosave: saved });
  t.eq(fresh.P.facets.length, 5, 'autosave is restored on boot');
  t.eq(boot(undefined, { autosave: '{not json' }).P.facets.length, 1, 'a corrupt autosave falls back to a new project');
  t.eq(boot(undefined, { autosave: { groups: [], facets: [] } }).P.facets.length, 1, 'and so does one in another format');
  // The new project's autosave is about to land on the same key, so what could not be opened is set aside first.
  const future = boot(undefined, { autosave: { ...saved, v: 2 } });
  t.eq([future.P.facets.length, JSON.parse(future.store.get('panels.autosave.bad')).v], [1, 2], 'an autosave from a newer version is set aside, not written over');
  t.ok(/could not be opened/.test(future.$('#toast').textContent), 'and the page says a new project was started');
  future.flush();
  t.eq([JSON.parse(future.store.get('panels.autosave')).v, JSON.parse(future.store.get('panels.autosave.bad')).facets.length], [1, 5], 'it is still there once the new project has autosaved');
  t.eq(boot(undefined, { autosave: '{not json' }).store.get('panels.autosave.bad'), '{not json', 'a corrupt one is set aside as it was');
  t.ok(!fresh.store.has('panels.autosave.bad') && !boot().store.has('panels.autosave.bad'), 'a good autosave, or none, leaves nothing behind');

  // Profile libraries travel between projects.
  app.load(app.ev('sampleProject')());
  t.eq(app.ev('importProfiles')({ profiles: [{ name: 'Acme 16', cover: 16, sheetW: 21, type: 'ssmr-mech', lap: 8 }, { id: 'p1', name: 'Acme 24', cover: 24 }] }), 2, 'importing a library adds its profiles');
  t.eq(app.P.profiles.length, 19, 'alongside the ones already there');
  t.ok(new Set(app.P.profiles.map(q => q.id)).size === 19, 'under ids of their own');
  t.throws(() => app.ev('importProfiles')({ profiles: [] }), /no profiles/, 'an empty library is refused');
}

// ===== editing through the inputs pane =====
{
  app.load(app.ev('sampleProject')());
  app.select('R1');
  t.ok(/Could not read/.test(app.type('m.w', 'len', 'wide')), 'a bad length is refused with a message');
  t.ok(/at least/.test(app.type('m.w', 'len', '0', { min: '1' })), 'and so is a zero width');
  t.eq(app.P.facets[0].params.w, 480, 'neither changed the project');
  app.type('m.w', 'len', "44'6");
  t.eq(app.P.facets[0].params.w, 534, 'a good one lands');
  app.ev('CMD').undo(); t.eq(app.P.facets[0].params.w, 480, 'undo');
  app.ev('CMD').redo(); t.eq(app.P.facets[0].params.w, 534, 'redo');
  app.type('u.bare', 'sel', 'ft'); app.type('m.w', 'len', '40');
  t.eq(app.P.facets[0].params.w, 480, 'a bare number follows the project setting');
  app.type('u.bare', 'sel', 'in');
  app.type('f.pitch', 'pitch', '30 deg');
  t.ok(near(app.P.facets[0].pitch, 12 * Math.tan(Math.PI / 6)), 'pitch can be typed in degrees');
  app.type('f.pitch', 'pitch', '6:12');

  // The facet form folds away what is not typed for every facet, under a line saying how it is set.
  const pane = () => app.$('#inputs').innerHTML, fold = k => app.ev('ACT').fold({ dataset: { k } });
  app.ev('S').t = 'facet'; app.ev('refresh')();
  t.ok(['m.w', 'e.0.type', 'o.profileId'].every(b => pane().includes(`data-b="${b}"`)) && ['y.start', 'o.split', 'op.0.x'].every(b => !pane().includes(`data-b="${b}"`)), 'shape, edges and profile are in view; layout, laps and openings are folded');
  t.ok(pane().includes('Square to the eave · from the centered seam') && pane().includes('project defaults') && />none</.test(pane()), 'a folded section says what it is set to');
  const depth = app.ev('undo').length;
  fold('layout');
  t.ok(pane().includes('data-b="y.start"') && app.ev('undo').length === depth, 'unfolding one shows its fields, and is not an edit');
  fold('layout');
  app.type('o.split', 'selnull', 'equal'); app.ev('ACT').addOpen(); app.ev('changed')();
  t.ok(pane().includes("this facet's own split") && pane().includes('data-b="op.0.x"'), 'an override shows in the summary, and adding an opening unfolds the openings');
  app.ev('CMD').undo(); app.ev('CMD').undo(); fold('op');

  // A profile switch on the package reaches every facet that does not override it.
  app.type('d.profileId', 'sel', 'p17');
  t.ok(app.layout('R1').e.W === 36 && app.layout('R3').e.W === 36, 'the package profile drives its facets');
  app.type('o.profileId', 'selnull', 'p1');
  t.ok(app.layout('R1').e.W === 13.875 && app.layout('R3').e.W === 36, 'unless a facet overrides it');
  app.ev('S').prof = 'p1'; app.ev('ACT').delProfile(); app.ev('changed')();
  t.ok(!('profileId' in app.P.facets[0].ov) && app.layout('R1').e.W === 36, 'deleting a profile drops the overrides that used it');
  app.ev('ACT').cloneProfile(); app.ev('changed')();
  t.ok(/\(copy\)$/.test(app.P.profiles[app.P.profiles.length - 1].name), 'profiles can be cloned');

  const before = app.layout('R1').pts.map(p => p.map(v => +v.toFixed(6)));
  app.type('f.template', 'sel', 'custom');
  t.eq(app.layout('R1').pts.map(p => p.map(v => +v.toFixed(6))), before, 'converting to a custom perimeter keeps the shape');
  app.type('f.template', 'sel', 'rect');
  t.eq([app.P.facets[0].params.w, app.P.facets[0].params.h], [480, 210], 'and back to a rectangle keeps its extents');
  app.type('f.kind', 'sel', 'wall');
  t.eq([app.P.facets[0].mark, app.P.facets[0].inputMode, app.P.facets[0].pitch], ['W1', 'slope', null], 'a roof made a wall becomes W1, in slope mode');
  app.type('f.kind', 'sel', 'roof');
  t.eq(app.P.facets[0].mark, 'R1', 'and back');

  // Mirror duplicate: the opposite hand of an off-center facet.
  app.type('f.template', 'sel', 'trap'); app.type('m.top', 'len', '100'); app.type('m.inset', 'lenopt', '60'); app.type('y.start', 'sel', 'left');
  app.type('e.1.type', 'selnull', 'valley');
  app.ev('ACT').mirFacet(); app.ev('changed')();
  const a = app.layout('R1'), b = app.layout(app.P.packages[0].facetIds.map(id => app.P.facets.find(f => f.id === id))[1].mark);
  t.eq(b.f.mark, 'R5', 'the mirror takes the next free ID and sits after its source');
  t.eq([b.f.params.inset, b.f.layout.start], [480 - 100 - 60, 'right'], 'inset and start edge are flipped');
  t.eq(b.edges.map(e => e.type), ['eave', 'hip', 'ridge', 'valley'], 'edge overrides follow their edges across');
  t.eq(b.pieces.map(p => +p.len.toFixed(4)), a.pieces.map(p => +p.len.toFixed(4)), 'and the cut list matches strip for strip');
  app.ev('ACT').delFacet(); app.ev('changed')();
  t.eq(app.P.facets.length, 4, 'delete');

  // Moving between packages.
  app.ev('ACT').addPackage(); app.ev('changed')();
  app.select('R1'); app.type('f.$pk', 'sel', app.P.packages[1].id);
  t.eq(app.P.packages.map(k => k.facetIds.length), [3, 1], 'a facet can be moved to another package');
  t.eq(app.ev('compute')().pk[1].q.count, app.layout('R1').q.count, 'and its totals go with it');
}

// ===== what a field takes, and when the panes are redrawn =====
{
  app.load(app.ev('sampleProject')()); app.select('R1'); app.ev('S').t = 'facet'; app.ev('refresh')();
  const pane = () => app.$('#inputs').innerHTML, S = app.ev('S'), check = app.ev('checkProject');
  t.ok(/not a number/.test(app.type('c.extra', 'num', '12 ft')) && /whole number/.test(app.type('p.idMax', 'int', '7.5')) && app.type('c.extra', 'num', ' 12.5 ') === undefined && app.P.coil.extra === 12.5,
    'a number field takes a number, and not one with something after it');

  // A commit changes the project at once. The panes are redrawn when the keystroke or click that
  // caused it is over: redrawn sooner, they take the next field or the pressed button away with them.
  const depth = app.ev('undo').length, was = pane(), typed = value => ({ target: { dataset: { b: 'm.w', t: 'len', min: '1' }, tagName: 'INPUT', type: 'text', value } });
  app.$('#inputs').fire('change', typed('500'));
  t.eq([app.P.facets[0].params.w, app.ev('undo').length, pane() === was], [500, depth + 1, true], 'a committed field changes the project and its history at once, and leaves the pane as it is');
  app.ev('CMD').undo(); app.ev('CMD').redo();
  t.eq(app.P.facets[0].params.w, 500, 'undo and redo see it straight away');
  app.$('#inputs').fire('change', typed('510')); app.flush();
  t.ok(pane().includes('data-b="m.w" data-t="len" value="510&quot;"'), 'the pane is redrawn once the gesture is over');
  app.$('#inputs').fire('change', typed('wide'));
  t.eq([app.P.facets[0].params.w, app.ev('undo').length], [510, depth + 2], 'a refused commit changes neither');
  t.ok(/Could not read/.test(app.$('#toast').textContent), 'and says why');
  app.flush();

  // Whatever a field takes has to be there the next time the project opens, so each one's limits
  // are checkProject's own. Every number in every view is put at each end of its range and
  // read back through a save; then one past each end is refused.
  const at = (p, b) => {
    const ks = b.split('.'), root = ks.shift(), f = p.facets.find(x => x.id === S.f), i = +ks[0];
    const o = { p, u: p.units, c: p.coil, k: p.packages.find(k => k.id === S.pk), d: p.def, f, y: f.layout, m: f.params, o: f.ov, q: p.profiles.find(q => q.id === S.prof) || p.profiles[0],
      e: f.edges[i], pt: f.pts[i], wk: f.walk[i], op: f.openings[i] }[root];
    return (/^(e|pt|wk|op)$/.test(root) ? ks.slice(1) : ks).reduce((a, k) => a == null ? a : a[k], o);
  };
  const fields = () => [...pane().matchAll(/<input ([^>]*)>/g)].map(m => Object.fromEntries([...m[1].matchAll(/data-(\w+)="([^"]*)"/g)].map(a => [a[1], a[2]]))).filter(d => /^(len|lenopt|num|numopt|int|pitch)$/.test(d.t));
  const seen = new Set();
  const sweep = view => {
    for (const d of fields()) {
      seen.add(d.b.replace(/\.\d+(?=\.|$)/g, '.N'));
      for (const v of [d.max ?? '5000', d.min].filter(x => x != null)) {
        const r = app.type(d.b, d.t, v, d), now = at(app.P, d.b), back = at(check(JSON.parse(JSON.stringify(app.P))), d.b);
        t.ok(r === undefined && now === +v && back === now, `${view}: ${d.b} takes ${v} and keeps it through a save (${r ?? now}, then ${back})`);
      }
      for (const v of [d.max != null && String(+d.max + 1), d.min != null && String(+d.min - 1)].filter(Boolean)) t.ok(!!app.type(d.b, d.t, v, d), `${view}: ${d.b} refuses ${v}`);
    }
  };
  const view = (name, set) => { set(); app.ev('refresh')(); sweep(name); };
  Object.assign(S.open, { layout: true, ov: true, op: true });
  view('trapezoid', () => { app.type('y.dir', 'sel', 'angle'); app.type('o.lapMode', 'selnull', 'stagger'); app.ev('ACT').addOpen(); app.ev('changed')(); });
  for (const tp of ['tri', 'para', 'angled']) view(tp, () => app.type('f.template', 'sel', tp));
  view('custom points', () => app.type('f.template', 'sel', 'custom'));
  view('custom walk', () => { app.type('pt.1.1', 'len', '40'); app.type('f.custom', 'sel', 'walk'); });
  for (const tp of ['gable', 'shed']) view(tp, () => { app.type('f.kind', 'sel', 'wall'); app.type('f.template', 'sel', tp); });
  view('package', () => { S.t = 'package'; });
  view('profile', () => { S.t = 'profiles'; });
  view('project, staggered', () => { S.t = 'project'; app.type('d.lapMode', 'sel', 'stagger'); });
  view('project, purlins', () => app.type('d.lapMode', 'sel', 'purlin'));
  for (const b of ['m.w', 'm.h', 'm.top', 'm.inset', 'm.apex', 'm.skew', 'm.h2', 'pt.N.N', 'wk.N.len', 'wk.N.turn', 'f.walk0', 'e.N.allow', 'op.N.x', 'op.N.w', 'y.angle', 'y.offset', 'f.north', 'f.pitch', 'o.lap', 'o.stagger', 'k.extraPanels',
    'q.cover', 'q.sheetW', 'q.rib', 'q.maxLen', 'q.minLen', 'q.lap', 'q.minSlope', 'q.psf', 'c.maxFt', 'c.maxLb', 'c.extra', 'p.idMax', 'd.lap', 'd.stagger', 'd.purlinSp', 'd.purlin0', 'd.ripMin', 'd.allow.eave', 'd.allow.jamb'])
    t.ok(seen.has(b), `the sweep reached ${b}`);
}

// ===== review and output =====
{
  const p = app.ev('sampleProject')();
  p.packages.push({ id: 'kw', name: 'East wall', prefix: '', facetIds: [] });
  app.ev('newFacet')(p, p.packages[1], { kind: 'wall', params: { ...app.ev('newParams')(), w: 240, h: 6 } });
  app.load(p);
  const pane = () => app.$('#inputs').innerHTML;
  // Catch what would be downloaded, inside the page, and put the real thing back afterwards.
  const files = app.ev('var realDownload = download, outFiles = []; download = (name, text) => { outFiles.push([name, text.length]); }; outFiles');
  t.ok(/data-t="output"><span>Review and output<\/span><u[^>]*>!<\/u><i>3<\/i>/.test(app.$('#tree').innerHTML), 'the tree ends in a review and output row carrying the warning count');
  app.ev('CMD').output();
  t.ok(app.ev('S').t === 'output' && ['pdf', 'print', 'csvLoc', 'csvLen', 'csvCoil'].every(k => pane().includes(`data-k="${k}"`)), 'it lists every output in one place');
  t.ok(pane().includes('Whole project, 2 packages') && pane().includes('East wall only') && />3 warnings</.test(pane()), 'says what it covers, and how many warnings that carries');
  const all = app.ev('compute')().pk.reduce((a, g) => a + g.q.count, 0), roof = app.ev('compute')().pk[0].q.count;
  t.ok(pane().includes(`${all} panels to make`), 'and how many panels');
  app.ev('ACT').out({ dataset: { k: 'csvLen' } });
  app.type('s.out', 'selnull', p.packages[0].id); app.ev('refresh')();
  t.ok(pane().includes(`${roof} panels to make`) && pane().includes('No warnings.'), 'limited to a package, the count and the warnings are that package\'s');
  app.ev('ACT').out({ dataset: { k: 'csvLen' } }); app.ev('ACT').out({ dataset: { k: 'pdf' } });
  t.eq(files.map(x => x[0]), ['Sample-40-x-28-hip-roof-cut-list-by-length.csv', 'Sample-40-x-28-hip-roof-Main-roof-cut-list-by-length.csv', 'Sample-40-x-28-hip-roof-Main-roof.pdf'], 'a package\'s files carry its name');
  t.ok(files[1][1] < files[0][1], 'and hold only that package');
  app.ev('download = realDownload');
  app.P.packages.pop(); app.P.facets.pop(); app.ev('changed')();
  t.ok(app.ev('outScope')() === null && !pane().includes('data-b="s.out"'), 'with one package there is nothing to choose');

  // A report in its own units leaves the screen's alone, warnings included.
  app.make({ units: { fmt: 'ftin', pdf: 'dec', csv: 'mm' }, def: { ripMin: 6 } }, [{ template: 'rect', mark: 'R10', params: { w: 92, h: 120 } }]);
  const warned = () => app.ev('R').warn.map(w => w.m).join(' '), onScreen = warned();
  t.ok(/Edge rip under the 0'-6" minimum/.test(onScreen), 'a warning words its lengths the way the screen shows them');
  app.ev('buildPDF')(DATE); t.eq(warned(), onScreen, 'and still does after a PDF in decimal inches');
  app.ev('buildCSV')('loc'); t.eq(warned(), onScreen, 'or a CSV in millimeters');
  // The ID is what a piece is marked with: its column widens for a long one and never cuts it short.
  app.select('R10'); app.type('k.prefix', 'text', 'ABC');
  const sheet = app.ev('reportPages')(DATE).find(pg => /^Facet R10/.test(pg.title)), listed = sheet.ops.filter(o => o.k === 'text' && !o.id && /^ABC/.test(o.s));
  t.eq([...new Set(listed.map(o => o.s))], ['ABC-R10-01', 'ABC-R10-02'], 'a ten-character ID is printed whole in the facet\'s cut list');
  const idX = listed[0].x, next = Math.min(...sheet.ops.filter(o => o.k === 'text' && o.size === 7.5 && o.y === listed[0].y && o.x > idX).map(o => o.x - (o.anchor === 'end' ? app.ev('textW')(o.s, 7.5) : 0)));
  t.ok(idX + app.ev('textW')('ABC-R10-01', 7.5) * 1.06 < next, 'and does not run into the quantity beside it');
  // A PDF of one package asks whether that package has anything in it.
  app.ev('ACT').addPackage(); app.ev('changed')();
  const shots = app.ev('var realDl = download, made = []; download = name => { made.push(name); }; made'), say = () => app.$('#toast').textContent;
  app.$('#toast').textContent = ''; app.ev('CMD').pdf(app.P.packages[1].id);
  t.ok(shots.length === 0 && /no panels/.test(say()), 'a package with no panels makes no PDF, though the project has some');
  app.$('#toast').textContent = ''; app.ev('CMD').pdf(app.P.packages[0].id); app.ev('CMD').pdf();
  t.ok(shots.length === 2 && say() === '', 'the package that has them does, and so does the project');
  app.ev('download = realDl');
  // Two profiles can carry one name; they are still two profiles to buy.
  app.make({}, [{ template: 'rect', params: { w: 240, h: 120 } }, { template: 'rect', params: { w: 240, h: 96 } }]);
  app.ev('S').prof = 'p2'; app.ev('ACT').cloneProfile(); app.type('q.name', 'text', SNAP); app.type('q.cover', 'len', '12');
  app.select('R2'); app.type('o.profileId', 'selnull', app.ev('S').prof);
  t.eq(app.ev('purchasing')(app.ev('compute')().pk).map(r => [r.profile, r.count]), [[SNAP, 14], [SNAP, 20]], 'profiles that share a name are bought as the two they are');
  app.select('R1'); app.type('k.extraPanels', 'int', '9999', { max: '9999' });
  t.ok(app.ev('coilOrder')(app.ev('compute')().pk).reduce((a, r) => a + r.lf, 0) > 9999 * 2 * 8, 'and the coil order copes with as many extra panels as a package can ask for');
}

// ===== coil order =====
{
  // 20 ft of eave in 16" panels on 20" coil: fifteen 10 ft pieces, 150 ft, 250 sf of 24 ga.
  const plain = { profile: { cover: 16, sheetW: 20, maxLen: 0, minLen: 0, lap: 6, type: 'exposed' }, def: { allow: {}, round: 0.25, ripMin: 0 } };
  app.make(plain, [{ template: 'rect', params: { w: 240, h: 120 } }]);
  const coils = () => app.ev('coilOrder')(app.ev('compute')().pk);
  let [c] = coils();
  t.eq([coils().length, c.width, c.gauge, c.n], [1, 20, '24 ga', 1], 'one coil per width, gauge and color when nothing limits it');
  t.ok(near(c.lf, 150) && near(c.sf, 250) && near(c.lb, 250 * 1.156) && near(c.each, 150), 'linear length, stretch-out area and weight from the gauge');
  t.eq(app.type('c.maxFt', 'numopt', '60'), undefined, 'a max coil length is a project setting');
  [c] = coils();
  t.eq([c.n, c.each, c.ordLf], [3, 50, 150], 'a length limit splits the order into equal coils of whole panels');
  app.type('c.extra', 'num', '10');
  [c] = coils();
  t.ok(c.n === 3 && near(c.each, 55) && c.each <= 60, 'the extra per coil is added to each without passing the limit');
  app.type('c.extra', 'num', '0'); app.type('c.maxFt', 'numopt', ''); app.type('c.maxLb', 'numopt', '100');
  [c] = coils();
  t.ok(c.n === 3 && c.each === 50 && c.eachLb <= 100 && near(c.eachLb, 50 * 20 / 12 * 1.156), 'a weight limit does the same through the coil weight');
  app.type('c.maxFt', 'numopt', '25');
  t.eq([coils()[0].n, coils()[0].each], [8, 20], 'the tighter of the two limits governs');
  app.type('c.maxFt', 'numopt', '8');
  [c] = coils();
  t.ok(c.over && c.n === 15 && c.each === 10 && app.ev('coilNotes')([c]).some(x => /longer than the coil limit/.test(x)), 'a panel longer than the limit is ordered over it and flagged');
  app.type('c.maxFt', 'numopt', '');
  app.P.profiles.find(q => q.id === 'p2').psf = 2;
  t.ok(near(coils()[0].lb, 500), 'a profile can state its own coil weight');
  Object.assign(app.P.profiles.find(q => q.id === 'p2'), { psf: null, gauge: '.032 aluminum' });
  [c] = coils();
  t.ok(c.lb === null && c.noWt && c.n === 1 && app.ev('coilNotes')([c]).some(x => /No weight is known/.test(x)), 'an unrecognized gauge has no weight, and the weight limit is not applied');
  t.eq(['24 ga', '26ga G90', '22', '0.032'].map(gauge => app.ev('coilPsf')({ gauge })), [1.156, 0.906, 1.406, null], 'gauge text is read loosely');
  // A second profile is a second coil.
  app.P.profiles.find(q => q.id === 'p2').gauge = '24 ga';
  app.ev('newFacet')(app.P, app.P.packages[0], { ov: { profileId: 'p17' } });
  t.eq(coils().map(r => [r.width, r.gauge]), [[20, '24 ga'], [38, '26 ga']], 'a coil per stretch out and gauge, narrowest first');
  const back = app.ev('checkProject')(JSON.parse(JSON.stringify({ ...app.P, coil: { maxFt: 500, maxLb: 'x', extra: 3 }, profiles: [{ ...app.P.profiles[0], psf: 1.2 }] })));
  t.eq([back.coil, back.profiles[0].psf], [{ maxFt: 500, maxLb: null, extra: 3 }, 1.2], 'coil limits and coil weight are saved with the project');
  t.eq(app.ev('checkProject')({ packages: [], facets: [] }).coil, { maxFt: null, maxLb: null, extra: 0 }, 'and an older file opens with no limits');
  const csv = app.ev('buildCSV')('coil').trim().split('\r\n');
  t.ok(csv.length === 3 && csv[0].startsWith('Coil width (in),Gauge,Color,Profiles,Panel length (ft)') && csv[1].startsWith('20,24 ga,,"1-3/4"" snap-lock, 17-3/4"" on 23-7/8"" coil",150,250,289,3,50,'), 'coil order CSV');
  const pages = app.ev('reportPages')(DATE), pg = pages.find(x => x.title === 'Coil order'), txt = pg.ops.filter(o => o.k === 'text').map(o => o.s);
  t.ok(txt.includes('Length each') && txt.includes('50 ft') && txt.some(x => /No coil is over 100 lb/.test(x)), 'the package carries a coil order sheet');
  app.ev('S').tab = 'cut'; app.ev('ACT').cutView({ dataset: { v: 'coil' } });
  t.ok(/Coil order/.test(app.$('#pane').innerHTML) && /<td class="r">50 ft<\/td>/.test(app.$('#pane').innerHTML), 'and the cut list has a coil order view');
  app.ev('S').tab = 'layout'; app.ev('S').cut = 'loc';
}

// ===== extra panels =====
{
  // Fifteen 10 ft panels and, on a second facet, fifteen 8 ft ones: the spares are 10 ft.
  const plain = { profile: { cover: 16, sheetW: 20, maxLen: 0, minLen: 0, lap: 6, type: 'exposed' }, def: { allow: {}, round: 0.25, ripMin: 0 } };
  app.make(plain, [{ template: 'rect', params: { w: 240, h: 120 } }, { template: 'rect', params: { w: 240, h: 96 } }]);
  const R0 = app.ev('compute')(), waste = app.ev('wasteOf')(R0.total).pct;
  t.eq(app.ev('production')(R0.pk).map(r => [r.qty, r.len, r.ids]), [[15, 120, 'R1-01 ×15'], [15, 96, 'R2-01 ×15']], 'no extras unless asked for');
  t.eq(app.type('k.extraPanels', 'int', '3'), undefined, 'extra panels are a package setting');
  const R = app.ev('compute')(), g = R.pk[0];
  t.eq(app.ev('production')(R.pk).map(r => [r.qty, r.len, r.ids]), [[15, 120, 'R1-01 ×15'], [3, 120, 'EXTRA'], [15, 96, 'R2-01 ×15']], 'that many more of the longest panel, marked EXTRA');
  const buy = app.ev('purchasing')(R.pk)[0];
  t.ok(buy.count === 33 && near(buy.lf, 150 + 120 + 30) && near(buy.gross, 300 * 20 / 12), 'the summary counts them as bought');
  t.ok(near(app.ev('coilOrder')(R.pk)[0].lf, 300), 'and so does the coil order');
  t.ok(R.total.count === 30 && near(app.ev('wasteOf')(R.total).pct, waste), 'but they are not roof: layout quantities and waste do not move');
  t.eq(app.ev('ordered')(g), { count: 33, lf: 300 }, 'ordered pieces and length include them');
  t.ok(app.ev('buildCSV')('len').split('\r\n')[2].startsWith('3,120,120,EXTRA,'), 'the production CSV lists them');
  t.ok(app.ev('reportPages')(DATE)[0].ops.some(o => /Includes 3 extra panels/.test(o.s)), 'and the cover says so');
  app.ev('newFacet')(app.P, app.P.packages[0], { ov: { profileId: 'p17' }, params: { ...app.ev('newParams')(), w: 72, h: 60 } });
  t.eq(app.ev('production')(app.ev('compute')().pk).filter(r => r.ids === 'EXTRA').map(r => [r.qty, r.len, r.profile]), [[3, 120, SNAP], [3, 60, '36" exposed fastener (R / PBR)']], 'each profile gets its own, at its own longest length');
  t.eq(app.ev('checkProject')(JSON.parse(JSON.stringify(app.P))).packages[0].extraPanels, 3, 'saved with the package');
  // A second package orders its own number, or none.
  app.ev('ACT').addPackage(); app.ev('newFacet')(app.P, app.P.packages[1], { params: { ...app.ev('newParams')(), w: 240, h: 72 } }); app.ev('changed')();
  t.eq(app.ev('compute')().pk.map(g => g.extra.map(x => [x.qty, x.len])), [[[3, 120], [3, 60]], []], 'a package with none set orders none');
  app.type('k.extraPanels', 'int', '5');
  t.eq(app.ev('compute')().pk[1].extra.map(x => [x.qty, x.len]), [[5, 72]], 'and each package orders its own number');
  t.ok(app.ev('reportPages')(DATE)[0].ops.some(o => /Includes 11 extra panels: each package's own number/.test(o.s)), 'the cover totals them');
  const old = JSON.parse(JSON.stringify(app.P)); for (const k of old.packages) delete k.extraPanels; old.extraPanels = 2;
  t.eq(app.ev('checkProject')(old).packages.map(k => k.extraPanels), [2, 2], 'an older file\'s project-wide number carries to each package');
}
t.done();
