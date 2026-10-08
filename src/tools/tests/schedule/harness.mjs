// Boots schedule.html's script inside a Node vm with a stubbed DOM and returns handles for
// driving it. The scheduler has no test hook of its own and needs none: its script is one
// classic <script>, so every top-level function and `let` stays reachable through ev().
//
// The DOM stub records what the app writes (innerHTML, value, listeners) and decodes nothing.
// Anything that depends on real layout, focus or HTML parsing still needs a browser.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PAGE = path.resolve(HERE, '../../../../schedule.html');

// Unknown properties become child stubs, which is what lets `form.dur.value` work without
// listing every field the dialogs have.
function makeEl(tag) {
  const listeners = {}, kids = {};
  const base = {
    tagName: tag, innerHTML: '', textContent: '', value: '', returnValue: '', open: false,
    clientHeight: 600, clientWidth: 1200, offsetWidth: 800, scrollLeft: 0, checked: false, disabled: false,
    dataset: {}, style: { setProperty() {}, removeProperty() {} }, files: [], __listeners: listeners,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
    removeEventListener() {}, setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    appendChild(c) { return c; }, remove() {}, contains: () => false, closest: () => null, matches: () => false,
    focus() {}, blur() {}, select() {}, click() {}, setSelectionRange() {},
    showModal() { this.open = true; }, close() { this.open = false; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 600 }),
    querySelectorAll: () => [],
    querySelector(sel) { return (kids[sel] ||= makeEl(sel)); },
    fire(t, ev) { for (const fn of listeners[t] || []) fn(ev); },
  };
  return new Proxy(base, {
    get(o, k) {
      if (k in o || typeof k === 'symbol' || k === 'then' || k === 'onclose' || k === 'onclick') return o[k];
      return (o[k] = makeEl(String(k)));
    },
  });
}

// Just enough XML for importMSP to read what exportMSP writes: elements and text, no attributes
// kept, no namespaces. Not a general parser.
function parseXML(text) {
  const dec = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const root = { localName: '#doc', children: [], text: '' }, stack = [root];
  const re = /<\?[^>]*\?>|<\/([\w:.-]+)\s*>|<([\w:.-]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1]) stack.pop();
    else if (m[2]) {
      const el = { localName: m[2].replace(/^.*:/, ''), children: [], text: '' };
      Object.defineProperty(el, 'textContent', { get() { return this.text + this.children.map(c => c.textContent).join(''); } });
      top.children.push(el);
      if (!m[4]) stack.push(el);
    } else if (m[5]) top.text += dec(m[5]);
  }
  return { documentElement: root.children[0], getElementsByTagName: () => [] };
}

export function boot(page = DEFAULT_PAGE, { autosave = null, prefs = null } = {}) {
  const html = fs.readFileSync(page, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no inline <script> in ' + page);
  const store = new Map(autosave == null ? [] : [['cpm.autosave', typeof autosave === 'string' ? autosave : JSON.stringify(autosave)]]);
  if (prefs != null) store.set('cpm.prefs', typeof prefs === 'string' ? prefs : JSON.stringify(prefs));
  const els = {}, timers = [], confirms = [];
  const $ = sel => (sel === 'dialog[open]' ? null : (els[sel] ||= makeEl(sel)));
  const document = {
    querySelector: $, getElementById: id => $('#' + id), querySelectorAll: () => [],
    addEventListener() {}, createElement: makeEl, body: makeEl('body'), activeElement: null,
  };
  const sandbox = {
    console, document, innerWidth: 1400, confirm: msg => { confirms.push(msg); return sandbox.__confirm; }, __confirm: true,
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: k => store.delete(k) },
    // Timers are queued, not run: the app only uses them for toasts, scrolling and the autosave
    // debounce, and a suite that cares calls flush().
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
    addEventListener() {}, print() {}, DOMParser: class { parseFromString(t) { return parseXML(t); } },
    Blob: class {}, URL: { createObjectURL: () => '', revokeObjectURL() {} },
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(m[1], ctx, { filename: 'schedule.html' });
  const ev = code => vm.runInContext(code, ctx);
  return {
    ev, $, store, confirms,
    flush() { while (timers.length) timers.shift()(); },
    setConfirm(v) { sandbox.__confirm = v; },
    get P() { return ev('P'); }, get S() { return ev('S'); },
    // Replace the schedule the way opening a file does.
    load(project) { ev('loadProject')(project); return ev('P').tasks; },
    // Build a one-level project from short rows; preds name rows, exactly as typed in the table.
    make({ start = '2026-10-12', status = null, calendar, rows }) {
      const p = { v: 1, name: 't', start, status, calendar, tasks: rows.map((r, i) => ({ uid: i + 1, name: r.name || 'T' + (i + 1), dur: r.dur ?? 1, level: r.level || 0, preds: [], pct: r.pct || 0, as: r.as || null, af: r.af || null, cons: r.cons || null, trade: r.trade || '' })) };
      this.load(p);
      rows.forEach((r, i) => { if (r.pred) { const t = ev('P').tasks[i], res = ev('parsePreds')(r.pred, t); if (res.err) throw new Error(res.err); t.preds = res.preds; } });
      ev('refresh')();
      return ev('P').tasks;
    },
    toast() { return $('#toast').textContent; },
    fmt: n => ev('isoOf')(n),
  };
}

// Minimal reporter in the shape run.sh greps for.
export function suite() {
  let pass = 0; const fails = [];
  const t = {
    ok(cond, msg) { if (cond) pass++; else fails.push(msg); },
    eq(a, b, msg) { if (Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b)) pass++; else fails.push(`${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); },
    throws(fn, re, msg) { try { fn(); fails.push(msg + ': did not throw'); } catch (e) { if (!re || re.test(e.message)) pass++; else fails.push(`${msg}: threw "${e.message}"`); } },
    done() {
      console.log(`${pass} passed, ${fails.length} failed`);
      if (fails.length) { console.log('FAILURES:'); for (const f of fails) console.log('  ' + f); process.exit(1); }
    },
  };
  return t;
}
