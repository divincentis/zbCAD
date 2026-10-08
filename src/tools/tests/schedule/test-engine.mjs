// Scheduling correctness: milestones as instants, elapsed lags, retained logic for work in
// progress, remaining duration, and the status date surviving an XML round trip.
// Project start is Monday 2026-10-12, Monday–Friday, no holidays, unless a test says otherwise.
import {boot, suite} from './harness.mjs';
const h = boot(process.argv[2]), t = suite(), ev = h.ev;
const sd = x => h.fmt(x._sd), fd = x => h.fmt(x._fd);
const span = x => sd(x) + '..' + fd(x);
const cell = (task, col, val) => ev('commitCell')(String(task.uid), col, val);
const TYPES = ['FS', 'SS', 'FF', 'SF'];

// ---- completed milestones stay instants (CPM-01)
{
  let [ntp, b] = h.make({ rows: [{ dur: 0 }, { dur: 5, pred: '1' }] });
  const before = span(b);
  cell(ntp, 'pct', '100'); [ntp, b] = h.P.tasks;
  t.eq(span(b), before, 'completing NTP must not move its successor');
  t.ok(ntp._ms && ntp.dur === 0 && ntp._es === ntp._ef, 'completed NTP is still an instant');
  t.eq([ntp.as, ntp.af, ntp.mside, ntp.pct], ['2026-10-12', '2026-10-12', 's', 100], 'NTP actuals and side');
  t.ok(/<Milestone>1<\/Milestone>/.test(ev('exportMSP')().split('\n').find(l => l.startsWith('<Task><UID>1</UID>'))), 'completed NTP exports as a milestone');

  // save/load, undo/redo keep the same answer
  const saved = JSON.parse(ev('ser')());
  ev('CMD').undo(); t.eq(h.P.tasks[0].pct, 0, 'undo clears completion');
  ev('CMD').redo(); t.eq(span(h.P.tasks[1]), before, 'redo restores it without moving B');
  const again = h.load(saved); t.eq([span(again[0]), span(again[1])], ['2026-10-12..2026-10-12', before], 'JSON round trip keeps milestone and successor');

  let [a, m] = h.make({ rows: [{ dur: 5 }, { dur: 0, pred: '1' }] });
  t.eq(sd(m), '2026-10-16', 'finish-side milestone shows on the day its predecessor ends');
  cell(m, 'pct', '100'); [a, m] = h.P.tasks;
  t.eq([a._tf, a._ff, m._tf, sd(m), m.mside], [0, 0, 0, '2026-10-16', 'f'], 'completing a finish-side milestone adds no negative float');

  let c; [a, m, c] = h.make({ rows: [{ dur: 0 }, { dur: 0, pred: '1' }, { dur: 5, pred: '2' }] });
  const chain = span(c);
  cell(h.P.tasks[0], 'pct', '100'); cell(h.P.tasks[1], 'pct', '100');
  t.eq(span(h.P.tasks[2]), chain, 'a chain of completed milestones does not move what follows');

  [m] = h.make({ rows: [{ dur: 0 }] });
  cell(m, 'pct', '50'); t.eq(h.P.tasks[0].pct, 100, 'a milestone is 0% or 100%');
  cell(h.P.tasks[0], 'pct', '0'); t.eq([h.P.tasks[0].as, h.P.tasks[0].af, h.P.tasks[0].mside], [null, null, null], 'un-completing a milestone clears its record');

  // Every template opens with a milestone; marking it done used to push the whole job a day.
  for (const tpl of ev('TEMPLATES')) {
    ev('buildTemplate')(tpl); h.P.start = '2026-10-12'; ev('refresh')();
    const finish = h.S.finish, first = h.P.tasks.find(x => !x._sum && x.dur === 0);
    t.ok(!h.S.cyc && !h.P.tasks.some(x => x._err), `template ${tpl.id} schedules cleanly`);
    cell(first, 'pct', '100');
    t.eq(h.S.finish, finish, `template ${tpl.id}: completing "${first.name}" keeps the finish`);
  }
}

// ---- elapsed lags count from the milestone's own instant (CPM-02)
{
  let [n, b] = h.make({ rows: [{ dur: 0 }, { dur: 1, pred: '1FS+1ed' }] });
  t.eq(sd(b), '2026-10-13', 'Monday NTP + FS+1ed starts Tuesday');
  t.eq([n._tf, n._ff, b._tf], [0, 0, 0], 'and the backward pass agrees: no float either way');
  [n, b] = h.make({ rows: [{ dur: 0, cons: { type: 'SNET', date: '2026-10-16' } }, { dur: 1, pred: '1FS+1ed' }] });
  t.eq(sd(b), '2026-10-19', 'Friday-morning milestone + 1ed lands on Saturday, so Monday');
  [n, b] = h.make({ rows: [{ dur: 1 }, { dur: 1, pred: '1FS+1ed' }] });
  t.eq(sd(b), '2026-10-14', 'ordinary task: Monday end + 1ed is Tuesday end, so Wednesday (unchanged)');

  // A milestone driven across a weekend belongs to Monday morning, not to the Friday before it.
  let a, m;
  [a, m] = h.make({ rows: [{ dur: 5 }, { dur: 0, pred: '1FS+1ed' }] }); t.eq(sd(m), '2026-10-19', 'milestone FS+1ed after a Friday finish shows Monday');
  [a, m] = h.make({ rows: [{ dur: 5 }, { dur: 0, pred: '1FS+3ed' }] }); t.eq(sd(m), '2026-10-19', 'milestone FS+3ed after a Friday finish is Monday end of day');
  [a, m] = h.make({ rows: [{ dur: 5 }, { dur: 0, pred: '1FS+4ed' }] }); t.eq(sd(m), '2026-10-20', 'milestone FS+4ed after a Friday finish is Tuesday');

  // A milestone is the same instant as the task end it sits on, so a link from it must give the
  // same dates, late dates and float as the same link from that end. Holiday on Wed 10/21.
  const calendar = { workdays: [1, 2, 3, 4, 5], holidays: [{ d: '2026-10-21', n: 'x' }] };
  const key = x => [x._es, x._ef, x._ls, x._lf, x._tf].join();
  for (const ty of TYPES) for (const lag of [-3, -1, 1, 2, 3, 5]) for (const dur of [0, 1, 3]) {
    const l = (row, type) => row + type + (lag > 0 ? '+' : '') + lag + 'ed';
    // finish side: M sits on A's finish. Row 4 keeps the project end fixed so float is comparable.
    let x = h.make({ calendar, rows: [{ dur: 5 }, { dur: 0, pred: '1' }, { dur, pred: l(2, ty) }, { dur: 20 }] })[2];
    let y = h.make({ calendar, rows: [{ dur: 5 }, { dur: 0, pred: '1' }, { dur, pred: l(1, 'F' + ty[1]) }, { dur: 20 }] })[2];
    t.eq(key(x), key(y), `finish-side milestone ${ty}${lag}ed into ${dur}d equals the link from the task end`);
    // start side: M sits on A's start, three days in.
    const at = { type: 'SNET', date: '2026-10-15' };
    x = h.make({ calendar, rows: [{ dur: 5, cons: at }, { dur: 0, cons: at }, { dur, pred: l(2, ty) }, { dur: 20 }] })[2];
    y = h.make({ calendar, rows: [{ dur: 5, cons: at }, { dur: 0, cons: at }, { dur, pred: l(1, 'S' + ty[1]) }, { dur: 20 }] })[2];
    t.eq(key(x), key(y), `start-side milestone ${ty}${lag}ed into ${dur}d equals the link from the task start`);
  }
}

// ---- ordinary links: the two-task cases the fixes must not disturb
{
  for (const ty of TYPES) for (const lag of [-2, 0, 2]) for (const dur of [1, 5]) {
    const [a, b] = h.make({ rows: [{ dur: 5, cons: { type: 'SNET', date: '2026-10-19' } }, { dur, pred: '1' + ty + (lag ? (lag > 0 ? '+' : '') + lag + 'd' : '') }] });
    const from = ty[0] === 'F' ? a._ef : a._es, want = Math.max(0, ty[1] === 'F' ? from + lag - dur : from + lag);
    t.eq(b._es, want, `${ty}${lag}d into ${dur}d`);
    t.ok(b._tf >= 0 && a._tf >= 0, `${ty}${lag}d: no negative float without a constraint`);
  }
}

// ---- remaining work still obeys the logic (CPM-03)
{
  let [a, b] = h.make({ status: '2026-10-14', rows: [{ dur: 10 }, { dur: 5, pred: '1FF', as: '2026-10-12', pct: 50 }] });
  t.eq(span(a), '2026-10-15..2026-10-28', 'unstarted A resumes after the status date');
  t.eq([sd(b), b.as], ['2026-10-12', '2026-10-12'], 'actual start is kept');
  t.ok(b._ef >= a._ef, 'in-progress B cannot finish before its FF predecessor: ' + fd(b));

  [a, b] = h.make({ status: '2026-10-14', rows: [{ dur: 10 }, { dur: 5, pred: '1', as: '2026-10-12', pct: 20 }] });
  t.eq(fd(b), '2026-11-03', 'FS: four remaining days follow A');
  t.ok(/Out of sequence: started before row 1/.test(b._err), 'started ahead of an unfinished predecessor is reported');

  [a, b] = h.make({ status: '2026-10-14', rows: [{ dur: 10 }, { dur: 2, pred: '1', as: '2026-10-12', af: '2026-10-13', pct: 100 }] });
  t.eq([span(b), b.as, b.af], ['2026-10-12..2026-10-13', '2026-10-12', '2026-10-13'], 'a finished task keeps its history');
  t.ok(/Out of sequence: finished before row 1/.test(b._err), 'and the conflict is reported instead');

  [a, b] = h.make({ rows: [{ dur: 2, as: '2026-10-12', af: '2026-10-13', pct: 100 }, { dur: 5, pred: '1', as: '2026-10-14' }] });
  t.eq([fd(b), b._err], ['2026-10-20', ''], 'in sequence: nothing reported, nothing pushed');

  [b] = h.make({ status: '2026-10-14', rows: [{ dur: 5, as: '2026-10-12', pct: 50, cons: { type: 'FNET', date: '2026-10-30' } }] });
  t.eq(fd(b), '2026-10-30', 'finish-no-earlier-than still holds work in progress');

  for (const ty of TYPES) for (const lag of [-2, 0, 3]) for (const status of [null, '2026-10-14']) {
    [a, b] = h.make({ status, rows: [{ dur: 10, cons: { type: 'SNET', date: '2026-10-20' } }, { dur: 4, pred: '1' + ty + (lag ? (lag > 0 ? '+' : '') + lag + 'd' : ''), as: '2026-10-13', pct: 50 }] });
    const bound = (ty[0] === 'F' ? a._ef : a._es) + lag + (ty[1] === 'F' ? 0 : 2);
    t.ok(b._ef >= bound && sd(b) === '2026-10-13', `in progress under ${ty}${lag}d (status ${status}): finish ${fd(b)} respects the link`);
  }
}

// ---- unfinished work always has work left (CPM-04)
{
  let [a, b] = h.make({ status: '2026-10-16', rows: [{ dur: 1, as: '2026-10-12', pct: 99 }, { dur: 1, pred: '1' }] });
  t.ok(fd(a) >= '2026-10-19' && sd(b) >= '2026-10-20', `99% of one day still has a day to go: ${fd(a)}, then ${sd(b)}`);
  [a] = h.make({ status: '2026-10-16', rows: [{ dur: 2, as: '2026-10-12', pct: 99 }] }); t.eq(fd(a), '2026-10-19', 'two-day task at 99%');
  [a] = h.make({ status: '2026-10-16', rows: [{ dur: 10, as: '2026-10-12', pct: 50 }] }); t.eq(fd(a), '2026-10-23', 'ten-day task at 50% keeps five days');
  [a] = h.make({ status: '2026-10-16', rows: [{ dur: 3, as: '2026-10-12', af: '2026-10-14', pct: 100 }] }); t.eq(fd(a), '2026-10-14', 'a finished task has none');
  [a] = h.make({ status: '2026-10-16', rows: [{ dur: 3 }] }); t.eq(span(a), '2026-10-19..2026-10-21', 'an unstarted task keeps all of it');
  [a] = h.make({ status: '2026-10-16', rows: [{ dur: 0 }] }); t.ok(a._ms && a._es === a._ef, 'a milestone gains no duration from the status date');
}

// ---- XML keeps the status date (CPM-05)
{
  const trip = () => { const dates = h.P.tasks.map(span), p = ev('importMSP')(ev('exportMSP')()); h.load(p); return [dates, h.P.tasks.map(span)]; };
  h.make({ status: '2026-11-06', rows: [{ dur: 5 }] });
  t.ok(ev('exportMSP')().includes('<StatusDate>2026-11-06T17:00:00</StatusDate>'), 'export writes the status date at end of day');
  let [was, now] = trip();
  t.eq([h.P.status, now], ['2026-11-06', ['2026-11-09..2026-11-13']], 'round trip keeps the status date and the November forecast');
  t.eq(was, now, 'unstarted task unchanged');

  h.make({ rows: [{ dur: 5 }] });
  t.ok(!/StatusDate/.test(ev('exportMSP')()), 'no status date, none invented');
  [was, now] = trip(); t.eq([h.P.status, was], [null, now], 'and none comes back');

  h.make({ status: '2026-10-21', calendar: { workdays: [1, 2, 3, 4, 5, 6], holidays: [{ d: '2026-10-26', n: 'Shutdown' }] }, rows: [
    { dur: 0 }, { dur: 3, pred: '1', as: '2026-10-12', af: '2026-10-14', pct: 100 }, { dur: 6, pred: '2', as: '2026-10-15', pct: 50, trade: 'Roofing' },
    { dur: 4, pred: '3FS+3ed' }, { dur: 2, pred: '4SS+1d', cons: { type: 'SNET', date: '2026-11-04' } }, { dur: 0, pred: '5' }] });
  cell(h.P.tasks[0], 'pct', '100');
  [was, now] = trip();
  t.eq(now, was, 'started, finished and unstarted tasks survive export and import');
  t.eq([h.P.tasks[2].trade, h.P.tasks[3].preds[0].el, h.P.calendar.workdays.length], ['Roofing', true, 6], 'with trade, elapsed lag and calendar');
}
t.done();
