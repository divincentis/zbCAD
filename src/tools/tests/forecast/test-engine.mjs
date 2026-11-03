// The engine half of forecast.html: how each kind of line forecasts, how the rates fall back
// when they can't be measured yet, where the weeks left come from, and what a file may carry.
import {boot, suite} from './harness.mjs';

const ev = boot(), t = suite();
const E = ev(`({ newProject, newCode, newWeek, checkProject, sortedWeeks, series, analyze, trend, status, headline,
  lineTxt, trendTxt, rateTxt, weeksTxt, about, exampleProject, nextId, isDate, addDays })`);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// A job built from a list of weeks, each a map of code id to {q, h, p}.
function job(codes, weeks, recent = 3) {
  const P = E.newProject();
  P.recent = recent;
  codes.forEach((c, i) => P.codes.push(E.newCode('c' + (i + 1), c)));
  weeks.forEach((e, i) => { const W = E.newWeek('w' + (i + 1), E.addDays('2026-01-02', 7 * i)); W.e = e; P.weeks.push(W); });
  return P;
}
const row = (A, i) => A.rows[i];

// ---- the worked example: 200 SQ at 2.0 hrs, 80 in for 200 hrs ----
{
  const P = job([{ kind: 'qty', unit: 'SQ', qty: 200, hours: 400 }], [
    { c1: { q: 20, h: 60 } }, { c1: { q: 20, h: 56 } }, { c1: { q: 20, h: 42 } }, { c1: { q: 20, h: 42 } },
  ], 2);
  const r = row(E.analyze(P), 0);
  t.ok(near(r.pct, 0.4), 'percent complete comes from quantity: 80 of 200');
  t.ok(near(r.earned, 160), 'earned hours are the budget hours for the work in place');
  t.ok(near(r.spent, 200), 'hours used add up');
  t.ok(near(r.eac.plan, 440), 'plan: 200 used + 120 left × 2.0');
  t.ok(near(r.eac.sofar, 500), 'so far: 200 used + 120 left × 2.5');
  t.ok(near(r.eac.recent, 452), 'recent (last 2 weeks): 200 used + 120 left × 2.1');
  t.eq(r.status, 'over', 'a recent forecast of 452 against 400 is 13% over, so red');
}

// ---- falling back when a rate can't be measured ----
{
  const P = job([{ kind: 'qty', unit: 'SQ', qty: 100, hours: 100 }], [{ c1: { h: 30 } }]);
  const r = row(E.analyze(P), 0);
  t.ok(!r.measured.sofar && !r.measured.recent, 'hours with nothing installed: no measured rate');
  t.ok(near(r.eac.recent, 130) && near(r.eac.sofar, 130), 'with no rate the forecast is the hours used plus the remaining work at the planned pace');
  t.ok(/nothing to show yet/.test(E.lineTxt(r, E.analyze(P))), 'the card says it is assuming the plan');
}
{
  // The recent window is the line's own last N active weeks, so a paused line keeps its pace.
  const P = job([{ kind: 'qty', unit: 'SQ', qty: 100, hours: 100 }, { kind: 'qty', unit: 'LF', qty: 10, hours: 10 }],
    [{ c1: { q: 10, h: 20 } }, { c2: { q: 1, h: 1 } }, { c2: { q: 1, h: 1 } }, { c2: { q: 1, h: 1 } }], 2);
  const r = row(E.analyze(P), 0);
  t.ok(r.measured.recent && near(r.rate.recent, 2), 'a line idle for the last weeks still has a recent pace from its own last active weeks');
}
{
  const P = job([{ kind: 'qty', unit: 'SQ', qty: 50, hours: 100 }], [{ c1: { q: 30, h: 60 } }, { c1: { q: 30, h: 60 } }]);
  const r = row(E.analyze(P), 0);
  t.ok(r.finished && r.beyond, 'installing more than the budget quantity marks the line finished and beyond');
  t.ok(near(r.eac.recent, 120) && near(r.pct, 1), 'a finished line forecasts what it used, and is 100% done, not 120%');
}
{
  const P = job([{ kind: 'qty', unit: 'SQ', qty: 0, hours: 50 }], [{ c1: { h: 10 } }]);
  const r = row(E.analyze(P), 0);
  t.ok(r.noQty, 'hours with no budget quantity are flagged');
}

// ---- percent done lines ----
{
  const P = job([{ kind: 'lump', hours: 60 }], [{ c1: { p: 40, h: 30 } }, { c1: { h: 6 } }, { c1: { p: 50, h: 6 } }]);
  const W = E.sortedWeeks(P), s = E.series(P.codes[0], W);
  t.eq(s.map(x => x.q), [40, 0, 10], 'percent done becomes weekly units: the change, with a blank week keeping the last percent');
  const r = row(E.analyze(P), 0);
  t.ok(near(r.pct, 0.5) && near(r.earned, 30), 'percent done earns its share of the budget');
  t.ok(near(r.eac.plan, 42 + 30), 'plan: 42 used + the other half of 60');
  t.ok(near(r.eac.sofar, 84), 'so far: 42 hours for half of it doubles to 84');
}

// ---- time-based lines and the weeks left ----
{
  // Production: 100 SQ at 1 hr, 20 SQ a week for 20 hrs → right on plan, 80 hrs and 4 weeks to go.
  const P = job([{ kind: 'qty', unit: 'SQ', qty: 100, hours: 100 }, { kind: 'time', hours: 200 }],
    [{ c1: { q: 20, h: 20 }, c2: { h: 40 } }]);
  const A = E.analyze(P);
  t.ok(near(A.weeksLeft.recent, 4), 'weeks left: 80 production hours to come at 20 a week');
  t.ok(near(row(A, 1).eac.recent, 40 + 4 * 40), 'a time-based line burns its weekly hours for the weeks left');
  t.eq(row(A, 1).status, 'good', 'and on plan it lands on its budget');
}
{
  // Same job with a slow crew: half the pace makes the time-based line run long too.
  const P = job([{ kind: 'qty', unit: 'SQ', qty: 100, hours: 100 }, { kind: 'time', hours: 200 }],
    [{ c1: { q: 10, h: 20 }, c2: { h: 40 } }]);
  const A = E.analyze(P);
  t.ok(near(A.weeksLeft.recent, 9) && near(A.weeksLeft.plan, 4.5), 'a slow crew means more weeks left, except at the planned pace');
  t.ok(near(row(A, 1).eac.recent, 40 + 9 * 40), 'and the time-based line follows it over budget');
  t.eq(row(A, 1).status, 'over', 'which turns it red');
}
{
  const P = job([{ kind: 'time', hours: 100 }], [{ c1: { h: 40 } }]);
  const A = E.analyze(P);
  t.ok(A.weeksLeft.recent === 0 && near(row(A, 0).eac.recent, 40), 'with no measured work left, a time-based line stops where it is');
  const Q = job([{ kind: 'time', hours: 100 }], []);
  t.ok(near(row(E.analyze(Q), 0).eac.recent, 100), 'before any report, a time-based line forecasts its budget');
}

// ---- groups, change orders, status ----
{
  const P = job([{ kind: 'qty', unit: 'SQ', qty: 10, hours: 10 }, { kind: 'qty', unit: 'SQ', qty: 10, hours: 30, co: true }],
    [{ c1: { q: 5, h: 5 }, c2: { q: 5, h: 30 } }]);
  const A = E.analyze(P);
  t.ok(near(A.orig.budget, 10) && near(A.co.budget, 30) && near(A.all.budget, 40), 'change orders total apart from the original scope');
  t.eq(A.orig.status, 'good', 'a change order running over does not color the original scope');
  t.eq(A.co.status, 'over', 'it shows in its own group');
}
t.eq([E.status(100, 103), E.status(100, 104), E.status(100, 110), E.status(100, 111), E.status(100, 60)],
  ['good', 'watch', 'watch', 'over', 'good'], 'green to 3% over, amber to 10%, red beyond; under is green');
t.eq(E.status(0, 5), 'over', 'hours against no budget are over');
{
  // Work done is weighed by budget hours, and time-based lines are left out of it.
  const P = job([{ kind: 'qty', unit: 'SQ', qty: 10, hours: 300 }, { kind: 'qty', unit: 'LF', qty: 10, hours: 100 }, { kind: 'time', hours: 600 }],
    [{ c1: { q: 5, h: 150 }, c2: { q: 10, h: 100 } }]);
  t.ok(near(E.analyze(P).orig.workPct, (150 + 100) / 400), 'work done: 150 + 100 earned of 400 measured budget hours');
}

// ---- the job's pace and the trend ----
{
  const P = job([{ kind: 'qty', unit: 'SQ', qty: 100, hours: 100 }, { kind: 'time', hours: 100 }],
    [{ c1: { q: 10, h: 20 }, c2: { h: 40 } }, { c1: { q: 20, h: 20 }, c2: { h: 40 } }, { c2: { h: 40 } }]);
  const A = E.analyze(P);
  t.eq(A.pace.map(p => p.pace), [0.5, 1, null], 'weekly pace is planned hours for the work done over hours spent; time-based hours are not crew pace');
  const tr = E.trend(P);
  t.eq(tr.length, 3, 'one trend point per week');
  t.ok(near(tr[0].orig, E.analyze(P, 1).orig.eac.recent), 'each point is the forecast as it stood that week');
}
{
  // Weeks are taken in date order however they were entered.
  const P = job([{ kind: 'qty', unit: 'SQ', qty: 100, hours: 100 }], []);
  const a = E.newWeek('w1', '2026-02-13'), b = E.newWeek('w2', '2026-02-06');
  a.e = { c1: { q: 10, h: 40 } }; b.e = { c1: { q: 10, h: 10 } };
  P.weeks.push(a, b);
  t.eq(E.sortedWeeks(P).map(w => w.id), ['w2', 'w1'], 'weeks sort by week-ending date');
  t.ok(near(E.analyze(P, 1).rows[0].spent, 10), 'analyze(P, 1) is the earliest week, not the first entered');
}

// ---- words ----
{
  const g = (budget, recent) => ({ n: 1, budget, eac: { recent }, status: E.status(budget, recent) });
  t.ok(/right about on budget/.test(E.headline(g(1000, 1005))), 'headline: within 1% is on budget');
  t.ok(/about 50 hours under budget/.test(E.headline(g(1000, 950))), 'headline: under');
  t.ok(/a little over: about 60 hours over budget \(6%\)/.test(E.headline(g(1000, 1060))), 'headline: amber');
  t.ok(/Heading over budget: about 200 hours over \(20%\)/.test(E.headline(g(1000, 1200))), 'headline: red');
  t.eq(E.headline({ n: 0 }), '', 'no headline for an empty group');
}
t.eq([E.about(17.4), E.about(143), E.about(1563), E.about(-52)], [17, 145, 1560, 50], 'about() rounds to what is worth saying, and drops the sign');
t.eq([E.weeksTxt(0), E.weeksTxt(0.1), E.weeksTxt(1), E.weeksTxt(1.56), E.weeksTxt(0.5), E.weeksTxt(3)],
  ['no time', 'less than half a week', '1 week', '1½ weeks', '½ week', '3 weeks'], 'weeks left in words');
t.eq([E.rateTxt(2.04, 'SQ'), E.rateTxt(0.7, 'sheets'), E.rateTxt(12, 'LF'), E.rateTxt(1, '')],
  ['2.0 hrs per SQ', '0.70 hrs per sheet', '12 hrs per LF', '1.0 hrs per unit'], 'rates in words');
t.eq(E.trendTxt([{ o: 1800 }, { o: 1700 }], 'o', 1500), 'Getting better: about 100 hours less than last week’s forecast.', 'trend: better');
t.eq(E.trendTxt([{ o: 1600 }, { o: 1650 }], 'o', 1500), 'Getting worse: about 50 hours more than last week’s forecast.', 'trend: worse');
t.eq(E.trendTxt([{ o: 1600 }, { o: 1601 }], 'o', 1500), 'Holding steady since last week.', 'trend: steady');

// ---- the example job tells the story it is meant to ----
{
  const P = E.exampleProject(), A = E.analyze(P), tr = E.trend(P);
  t.eq(A.orig.status, 'watch', 'example: the original scope is amber');
  t.ok(A.orig.usedPct > A.orig.workPct, 'example: hours are running ahead of the work');
  t.ok(tr[tr.length - 1].orig < tr[tr.length - 2].orig && tr[tr.length - 2].orig < tr[tr.length - 3].orig, 'example: the forecast has been improving');
  t.eq(A.co.status, 'over', 'example: the change order is red on its own');
  t.ok(A.rows.find(r => r.code.kind === 'time').eac.recent > 280, 'example: the slow crew pushes the foreman over budget');
}

// ---- files ----
{
  const P = E.exampleProject();
  t.eq(JSON.stringify(E.checkProject(JSON.parse(JSON.stringify(P)))), JSON.stringify(P), 'a project survives a save and load unchanged');
  const bad = E.checkProject({
    title: 7, recent: 99, example: 'yes',
    codes: [{ id: 'c1', name: 'A', kind: 'weird', qty: -5, hours: 'x' }, { id: 'c1', name: 'dup' }, { id: '__proto__' }, null, { id: 'c2', kind: 'time', hours: 1e12 }],
    weeks: [
      { id: 'w1', end: '2026-02-30', e: {} },
      { id: 'w2', end: '2026-03-06', e: { c1: { q: -3, h: 8, p: 140, z: 1 }, c9: { h: 1 }, c2: { h: NaN } } },
    ],
  });
  t.eq(bad.title, '', 'a title that is not text is dropped');
  t.eq(bad.recent, 8, 'recent weeks clamp to 8');
  t.eq(bad.example, false, 'example must be true, not truthy');
  t.eq(bad.codes.map(c => c.id), ['c1', 'c2'], 'duplicate, malformed and null lines are dropped');
  t.eq([bad.codes[0].kind, bad.codes[0].qty, bad.codes[0].hours], ['qty', 0, 0], 'an unknown kind becomes measured; bad numbers become 0');
  t.eq(bad.codes[1].hours, 1e7, 'huge hours are capped');
  t.eq(bad.weeks.map(w => w.id), ['w2'], 'a week with an impossible date is dropped');
  t.eq(bad.weeks[0].e, { c1: { q: 0, p: 100, h: 8 } }, 'reports keep known fields for known lines only, clamped');
  t.eq(E.checkProject(null).codes, [], 'nothing at all gives an empty job');
}
t.eq([E.nextId('c', [{ id: 'c3' }, { id: 'c10' }]), E.nextId('w', [])], ['c11', 'w1'], 'new ids follow the highest one');
t.ok(E.isDate('2028-02-29') && !E.isDate('2027-02-29') && !E.isDate('2026-1-5'), 'dates are real ISO dates');

t.done();
