// Data integrity: opening files, the clipboard across schedules, what reaches the HTML,
// progress edits that would contradict themselves, and the trade filter.
import {boot, suite} from './harness.mjs';
const page = process.argv[2];
const h = boot(page), t = suite(), ev = h.ev;
const sd = x => h.fmt(x._sd), fd = x => h.fmt(x._fd);
const cell = (task, col, val) => ev('commitCell')(String(task.uid), col, val);
const uids = () => h.P.tasks.map(x => x.uid);
const unique = a => new Set(a).size === a.length;
const select = (...ids) => ev(`sel=new Set(${JSON.stringify(ids)})`);
const open = (name, text) => h.$('#fileIn').__listeners.change[0]({ target: { files: [{ name, text: async () => text }], value: '' } });
const base = (tasks, extra = {}) => ({ v: 1, name: 'f', start: '2026-10-12', status: null, calendar: { workdays: [1, 2, 3, 4, 5], holidays: [] }, tasks, ...extra });

// ---- clipboard identity (CPM-06)
{
  const A = () => h.make({ rows: [{ name: 'a1' }, { name: 'a2', pred: '1' }, { name: 'a3', pred: '2' }] });
  const cut = (...ids) => { select(...ids); ev('clip=makeClip(true)'); ev('deleteSel')(true); };
  const paste = () => { select(); ev('pasteClip')(); };

  A(); cut(2); paste();
  t.eq([uids(), h.P.tasks[2].preds[0].uid, h.P.tasks[1].preds[0].uid], [[1, 3, 2], 1, 2], 'same schedule: a cut task comes back with its ID and both links');
  paste();
  t.ok(unique(uids()) && h.P.tasks[3].preds[0].uid === 1, 'pasting it again makes a copy with a new ID, still linked at home');
  t.ok(h.P.nextUid > Math.max(...uids()), 'nextUid is past every ID');

  A(); cut(2); ev('CMD').undo(); paste();
  t.ok(unique(uids()) && uids().length === 4, 'cut, undo, paste: a copy, never a duplicate ID');
  ev('CMD').undo(); ev('CMD').redo(); t.ok(unique(uids()), 'and undo/redo of the paste keeps IDs unique');

  // The review's two cross-schedule cases: an outside link must not find a stranger, an ID must not be reused.
  A(); cut(2);
  h.load(base([{ uid: 1, name: 'stranger', dur: 3 }])); paste();
  let pasted = h.P.tasks.find(x => x.name === 'a2');
  t.eq(pasted.preds, [], 'another schedule: the link to "ID 1" is not attached to an unrelated task');
  t.ok(/left behind/.test(h.toast()), 'and the user is told the link was dropped');
  ev('CMD').insert();
  t.ok(unique(uids()) && h.P.nextUid > Math.max(...uids()), 'insert after a cross-schedule paste gets a fresh ID: ' + uids());

  A(); select(1, 2); ev('clip=makeClip(false)');
  h.load(base([{ uid: 1, name: 'x' }, { uid: 2, name: 'y' }])); paste();
  const [c1, c2] = ['a1', 'a2'].map(n => h.P.tasks.find(x => x.name === n));
  t.ok(unique(uids()) && c2.preds.length === 1 && c2.preds[0].uid === c1.uid, 'a copied block keeps the link inside it, pointed at the copy');
}

// ---- a refused file changes nothing (CPM-07)
{
  h.make({ rows: [{ name: 'keep' }, { name: 'me', pred: '1' }] });
  cell(h.P.tasks[0], 'name', 'kept'); h.flush();
  const P0 = h.P, undo0 = ev('undoS').length, saved0 = h.store.get('cpm.autosave');
  select(1);
  const refused = async (label, text, re) => {
    const asked = h.confirms.length;
    await open('bad.json', text); h.flush();
    t.ok(h.P === P0 && ev('undoS').length === undo0 && ev('sel').has(1) && h.store.get('cpm.autosave') === saved0, `${label}: schedule, undo, selection and autosave untouched`);
    t.ok(re.test(h.toast()), `${label}: says why (${h.toast()})`);
    t.eq(h.confirms.length, asked, `${label}: refused before asking to discard the open schedule`);
  };
  const J = (tasks, extra) => JSON.stringify(base(tasks, extra));
  await refused('predecessors not a list', J([{ uid: 1, preds: 5 }]), /Row 1: the predecessor list/);
  await refused('duplicate IDs', J([{ uid: 3 }, { uid: 7 }, { uid: 3 }]), /Rows 1 and 3 share one task ID/);
  await refused('duration as text', J([{ uid: 1, dur: '5' }]), /Row 1: the duration isn’t a number/);
  await refused('infinite duration', J([{ uid: 1 }]).replace('"uid":1', '"uid":1,"dur":1e999'), /duration isn’t a number/);
  await refused('impossible date', J([{ uid: 1, as: '2026-13-40' }]), /Row 1: the actual start isn’t a valid date/);
  await refused('unknown constraint', J([{ uid: 1, cons: { type: 'ASAP!', date: '2026-10-12' } }]), /constraint type/);
  await refused('unknown link type', J([{ uid: 1 }, { uid: 2, preds: [{ uid: 1, type: 'XX' }] }]), /link type/);
  await refused('fractional ID', J([{ uid: 1.5 }]), /ID that isn’t a whole number/);
  await refused('bad holiday', J([], { calendar: { holidays: [{ d: 'soon' }] } }), /Holiday 1/);
  await refused('bad project start', J([], { start: 'Monday' }), /project start/);
  await refused('newer file version', J([], { v: 2 }), /newer version/);
  await refused('not a schedule', '{"hello":1}', /isn’t a schedule/);
  await refused('not JSON', 'hello', /isn’t a schedule/);
  await refused('not Project XML', '<html><body/></html>', /isn’t an MS Project XML/);

  // Older and looser files still open, and say what was repaired.
  await open('old.json', JSON.stringify({ tasks: [{ name: 'no id' }, { name: 'null preds', preds: null }, { uid: 9, name: 'dangling', preds: [{ uid: 1 }, { uid: 44, type: 'SS', lag: 2 }] }] })); h.flush();
  t.ok(h.P !== P0 && unique(uids()) && uids().every(u => Number.isInteger(u) && u > 0), 'a file without IDs or a calendar opens, with IDs assigned: ' + uids());
  t.eq([h.P.tasks[1].preds, h.P.tasks[2].preds.length, h.P.calendar.workdays], [[], 0, [1, 2, 3, 4, 5]], 'null predecessors and a missing calendar are defaults');
  t.ok(/links pointed at tasks that aren’t in the file/.test(h.toast()), 'dropped links are reported: ' + h.toast());
  t.eq(ev('undoS').length, 0, 'an opened file starts a fresh undo history');

  // Autosave goes through the same door, and an unreadable one is parked, not lost.
  const good = boot(page, { autosave: base([{ uid: 4, name: 'restored', dur: 2 }]) });
  t.eq([good.P.tasks.length, good.P.tasks[0].name], [1, 'restored'], 'a valid autosave is restored');
  for (const bad of [JSON.stringify(base([{ uid: 1 }, { uid: 1 }])), '{"tasks":[{"uid":1,"dur":"x"}]}', '{oops']) {
    const b = boot(page, { autosave: bad }); b.flush();
    t.ok(b.P.tasks.length > 5 && b.store.get('cpm.autosave.bad') === bad && /couldn’t be read/.test(b.toast()), 'an unreadable autosave boots the sample and is kept aside');
  }
}

// ---- nothing from the model becomes markup (CPM-08)
{
  const X = '<img src=x onerror=alert(1)>"\'&', LT = /<img|onerror=alert\(1\)>"/;
  const html = () => [h.$('#tbody').innerHTML, h.$('#gbody').innerHTML, h.$('#foot').innerHTML, h.$('#fTrade').innerHTML, h.$('#tradeList').innerHTML, h.$('#facts').innerHTML, h.$('#print').innerHTML].join('\n');
  h.load(base([{ uid: 1, name: 'Group ' + X, level: 0 }, { uid: 2, name: X, notes: X, trade: X, level: 1, dur: 3 }, { uid: 3, name: 'plain', level: 1, preds: [{ uid: 2, type: 'FS', lag: 0 }] }], { name: X }));
  ev('prefs').color = 'trade'; ev('render')(); ev('openInfo')(2); ev('doPrint')('letter');
  t.ok(!LT.test(html()), 'names, notes, trades and the project name are escaped everywhere they are drawn');
  t.ok(html().includes('&lt;img src=x onerror=alert(1)&gt;&quot;'), 'and still shown, as text');
  t.eq(h.P.tasks[1].name, X, 'the stored text is untouched');

  // Output escaping must hold even if a value slips past the file check, so plant them directly.
  h.load(base([{ uid: 1, dur: 2, cons: { type: 'SNET', date: '2026-10-13' } }, { uid: 2, dur: 2, preds: [{ uid: 1, type: 'FS', lag: 0 }] }]));
  const [a, b] = h.P.tasks;
  a.cons.type = X; a.dur = X; a.pct = X; b._preds[0].type = X; b.uid = X;
  ev('render')(); ev('doPrint')('letter');
  t.ok(!LT.test(html()), 'hostile constraint type, duration, percent, link type and ID are escaped at the table and the chart');
  ev('prefs').color = 'crit';
}

// ---- progress and actual dates cannot contradict each other (CPM-09)
{
  const issue = () => h.P.tasks.map(x => ev('progressIssue')(x)).join('');
  const info = (task, set) => { ev('openInfo')(task.uid); const f = h.$('#dlgInfo form'); set(f); const d = h.$('#dlgInfo'); d.returnValue = 'ok'; d.onclose(); };
  const snap = x => [x.as, x.af, x.pct].join();

  await open('odd.json', JSON.stringify(base([{ uid: 1, dur: 5, as: '2026-10-19', af: '2026-10-16', pct: 100 }, { uid: 2, dur: 5, pct: 100 }])));
  let [a, b] = h.P.tasks;
  t.eq([a.as, a.af], ['2026-10-19', '2026-10-16'], 'a contradictory file opens with its dates as recorded, not invented');
  t.ok(/actual finish is before its actual start/.test(a._err) && /100% complete but has no actual finish/.test(b._err), 'each contradiction is flagged on its row');
  t.ok(/2 tasks have progress that contradicts/.test(h.toast()), 'and counted when the file opens');
  t.ok(a._fd >= a._sd, 'the bar is not drawn backwards');

  [a] = h.make({ rows: [{ dur: 5 }] });
  cell(a, 'pct', '100'); [a] = h.P.tasks;
  t.eq(snap(a), '2026-10-12,2026-10-16,100', 'completing in the grid records both dates');
  let was = snap(a), undo = ev('undoS').length;
  cell(a, 'start', '10/20/26'); [a] = h.P.tasks;
  t.ok(snap(a) === was && ev('undoS').length === undo && /can’t be after the actual finish/.test(h.toast()), 'grid: start past the actual finish is refused: ' + snap(a));
  ev('setStart')(a, a._sd + 9); [a] = h.P.tasks;
  t.eq(snap(a), was, 'drag: the same move is refused the same way');
  cell(a, 'finish', '10/9/26'); [a] = h.P.tasks;
  t.ok(snap(a) === was && /can’t be before the actual start/.test(h.toast()), 'grid: finish before the actual start is refused');
  info(a, f => { f.af.value = '2026-10-08'; }); [a] = h.P.tasks;
  t.ok(snap(a) === was && /Nothing was changed/.test(h.toast()), 'Info: the same contradiction is refused');
  ev('CMD').undo(); ev('CMD').redo(); t.eq(snap(h.P.tasks[0]), was, 'undo/redo return the same consistent state');

  // Accepted edits, by every route, leave a consistent task.
  cell(h.P.tasks[0], 'start', '10/13/26'); t.eq([snap(h.P.tasks[0]), issue()], ['2026-10-13,2026-10-16,100', ''], 'grid: a start inside the actual span is taken');
  cell(h.P.tasks[0], 'finish', '10/20/26'); t.eq([snap(h.P.tasks[0]), issue()], ['2026-10-13,2026-10-20,100', ''], 'grid: a later finish is taken');
  cell(h.P.tasks[0], 'pct', '40'); t.eq([snap(h.P.tasks[0]), issue()], ['2026-10-13,,40', ''], 'lowering % reopens the task');
  cell(h.P.tasks[0], 'pct', '0'); t.eq([snap(h.P.tasks[0]), issue()], [',,0', ''], '0% clears the actual start');
  info(h.P.tasks[0], f => { f.af.value = '2026-10-15'; }); t.eq([snap(h.P.tasks[0]), issue()], ['2026-10-12,2026-10-15,100', ''], 'Info: a finish alone implies a start and 100%');
  info(h.P.tasks[0], f => { f.af.value = ''; f.pct.value = '100'; }); t.eq([snap(h.P.tasks[0]), issue()], ['2026-10-12,,99', ''], 'Info: 100% without a finish date stays in progress');
  info(h.P.tasks[0], f => { f.as.value = ''; }); t.eq([snap(h.P.tasks[0]), issue()], [',,0', ''], 'Info: clearing the start clears the progress');
  info(h.P.tasks[0], f => { f.dur.value = '0'; f.pct.value = '60'; }); t.eq([snap(h.P.tasks[0]), h.P.tasks[0].mside, issue()], ['2026-10-12,2026-10-12,100', 's', ''], 'Info: a milestone with progress is done, on one date');
  cell(h.P.tasks[0], 'start', '10/14/26'); t.eq([snap(h.P.tasks[0]), sd(h.P.tasks[0]), issue()], ['2026-10-14,2026-10-14,100', '2026-10-14', ''], 'moving a completed milestone moves its one date');
}

// ---- the No trade filter (CPM-10)
{
  const names = () => ev('visRows').map(x => x.name);
  const choose = v => h.$('#fTrade').fire('change', { target: { value: v } });
  h.load(base([{ uid: 1, name: 'Area', level: 0 }, { uid: 2, name: 'tear-off', level: 1, trade: 'Roofing' }, { uid: 3, name: 'walk', level: 1 }, { uid: 4, name: 'gutters', level: 0, trade: 'Sheet metal' }]));
  const opt = h.$('#fTrade').innerHTML.match(/<option value="([^"]*)">\(No trade\)/);
  t.ok(opt && !/[\u0000-\u001f&<>]/.test(opt[1]) && opt[1] !== '', 'the No trade option carries a value HTML will hand back unchanged');
  choose(opt[1]);
  t.eq(names(), ['Area', 'walk'], 'No trade shows the unassigned task under its summary');
  t.eq([h.$('#fTrade').value, ev('fTrade')], [opt[1], opt[1]], 'and the dropdown still says so');
  cell(h.P.tasks[2], 'name', 'site walk'); t.eq(names(), ['Area', 'site walk'], 'it holds through an edit');
  ev('doPrint')('letter'); t.ok(h.$('#print').innerHTML.includes('No trade') && !h.$('#print').innerHTML.includes('gutters'), 'and into print');
  choose('Roofing'); t.eq(names(), ['Area', 'tear-off'], 'one trade');
  choose(''); t.eq(names().length, 4, 'all trades');
  t.ok(!ev('S').trades.some(x => x === opt[1]), 'no real trade can equal the reserved value');
  cell(h.P.tasks[3], 'trade', ' none'); t.eq(h.P.tasks[3].trade, 'none', 'typing it as a trade gives the trimmed word, a different string');

  // A filter left naming a trade that has gone is dropped before rows are picked, not one render later.
  choose('Roofing'); cell(h.P.tasks[1], 'trade', 'Roofers');
  t.eq([ev('fTrade'), names().length], ['', 4], 'renaming the filtered trade shows everything in the same render');
  choose(opt[1]); cell(h.P.tasks[2], 'trade', 'General');
  t.eq([ev('fTrade'), names().length], ['', 4], 'and so does assigning the last untraded task');
}

// ---- the critical-path toggle hides the red and nothing else
{
  // Two critical tasks, one with float, so "no red" is told apart from "nothing was critical".
  h.make({ rows: [{ name: 'crit-a', dur: 3 }, { name: 'crit-b', dur: 4, pred: '1' }, { name: 'slack', dur: 2, pred: '1' }] });
  const RED = /class="row grid crit|class="c"|ar c"|var\(--crit\)|critical/;
  const drawn = () => { ev('render')(); ev('doPrint')('letter'); return [h.$('#tbody').innerHTML, h.$('#gbody').innerHTML, h.$('#print').innerHTML]; };
  const facts = () => [h.S.crit, h.P.tasks.map(x => [x._crit, x._tf]), ev('exportMSP')().match(/<Critical>1/g).length];
  const before = facts();
  let [tb, gb, pr] = drawn();
  t.ok(ev('showCrit')() && /row grid crit/.test(tb) && /class="c"/.test(gb) && /ar c"/.test(gb) && /Red = critical/.test(pr), 'on by default: names, bars, arrows and the print legend are red');
  t.eq((tb.match(/row grid crit/g) || []).length, 2, 'and only the two critical rows');

  ev('CMD').crit(); [tb, gb, pr] = drawn();
  t.ok(!RED.test(tb) && !RED.test(gb) && !RED.test(pr), 'off: no red in the table, the chart or the printed pages');
  t.ok(/Gray = baseline/.test(pr) && !/> · Gray/.test(pr), 'the print legend keeps the rest, with no stray separator');
  t.eq(facts(), before, 'the schedule itself is untouched: count, float and the export still mark the critical tasks');
  t.ok(/<b>2<\/b> critical/.test(h.$('#foot').innerHTML), 'and the on-screen count stays');
  t.eq(JSON.parse(h.store.get('cpm.prefs')).crit, false, 'the choice is remembered');
  ev('fShow="crit"'); t.eq(ev('visible')().length, 2, 'the Critical filter still works with the red off'); ev('fShow=""');

  ev('prefs').color = 'trade'; cell(h.P.tasks[0], 'trade', 'Concrete'); [tb, gb, pr] = drawn();
  t.ok(!RED.test(gb) && /Bar color = trade · Gray/.test(pr), 'by trade: no red outline either');
  ev('CMD').crit(); [tb, gb, pr] = drawn();
  t.ok(/stroke:var\(--crit\)/.test(gb) && /red outline = critical/.test(pr), 'back on: the outline and its legend return');
  ev('prefs').color = 'crit';
}

// ---- the template picker greets a first visit, and only a first visit
{
  const first = boot(page), dlg = first.$('#dlgNew');
  t.ok(dlg.open && /Blank schedule/.test(first.$('#tplList').innerHTML), 'no autosave: the picker opens at boot');
  const sample = first.P.name;
  dlg.returnValue = 'cancel'; dlg.onclose();
  t.eq(first.P.name, sample, 'dismissing it keeps the sample');
  const id = first.ev('TEMPLATES')[1].id;
  dlg.returnValue = id; dlg.onclose();
  t.ok(first.P.name !== sample && first.P.tasks.length > 0 && first.confirms.length === 0, 'picking a template loads it without a discard warning');

  first.ev('openNew')(); dlg.returnValue = 'blank'; dlg.onclose();
  t.eq(first.confirms.length, 1, 'from the New button the warning still stands');

  const back = boot(page, { autosave: base([{ uid: 1, name: 'mine', dur: 2 }]) });
  t.ok(!back.$('#dlgNew').open && back.P.tasks[0].name === 'mine', 'an autosaved schedule opens straight to the work');
}
t.done();
