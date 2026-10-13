// Boots pattern.html's script inside a Node vm with a stubbed DOM. The page is one classic
// <script>: the geometry, the field definitions and the DXF writer are top-level and reachable
// through ev(); everything else lives in the UI closure and is driven the way a person drives
// it — a link in the address bar, a value in a field, a button — and read back from what it
// writes and what it downloads. The DOM stub and the reporter are the scheduler's own.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeEl, suite} from '../schedule/harness.mjs';

export {suite};
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PAGE = path.resolve(HERE, '../../../../pattern.html');

export function boot(hash = '', page = process.argv[2] || DEFAULT_PAGE) {
  const html = fs.readFileSync(page, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no inline <script> in ' + page);
  const els = {}, win = {}, saved = [];
  const $ = sel => (els[sel] ||= makeEl(sel));
  // The 3D check draws on a canvas; nothing here looks at what it drew.
  const g2d = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
  $('#c3').getContext = () => g2d;
  $('#form').contains = () => true;
  // The stub keeps innerHTML and textContent apart; the title is written through both.
  Object.defineProperty($('#ptitle'), 'textContent', { set(v) { this.innerHTML = v; }, get() { return this.innerHTML; } });
  const anchor = () => { const a = makeEl('a'); a.click = () => saved.push({ name: a.download, type: a.href.type, data: a.href.parts[0] }); return a; };
  const document = {
    title: '', getElementById: id => $('#' + id), querySelector: $, querySelectorAll: () => [],
    createElement: tag => (tag === 'a' ? anchor() : makeEl(tag)), body: makeEl('body'), documentElement: makeEl('html'),
  };
  const sandbox = {
    console, document, URLSearchParams,
    location: { hash }, history: { replaceState(_s, _t, h) { sandbox.location.hash = h; } },
    getComputedStyle: () => ({ getPropertyValue: () => '#000' }),
    addEventListener(t, fn) { (win[t] ||= []).push(fn); }, setTimeout() {}, clearTimeout() {},
    Blob: class { constructor(parts, opt) { this.parts = parts; this.type = opt.type; } },
    URL: { createObjectURL: blob => blob, revokeObjectURL() {} },
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(m[1], ctx, { filename: 'pattern.html' });
  const ev = code => vm.runInContext(code, ctx);
  const api = {
    ev, $, document,
    // What following a link, or Back, does to a page that is already open.
    open(h) { sandbox.location.hash = h; for (const fn of win.hashchange || []) fn(); return api; },
    // The link the address bar now holds, as its parameters.
    get link() { return Object.fromEntries(new URLSearchParams(sandbox.location.hash.slice(1))); },
    // A value typed or picked in the form.
    type(k, value) { $('#form').fire('input', { target: { id: 'f_' + k, value } }); return api; },
    msgs() { return $('#msgs').innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); },
    title() { return $('#ptitle').innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); },
    canExport() { return ['dxf', 'svgx', 'csv', 'prt'].map(id => !$('#' + id).disabled); },
    // Press a button and take what it downloaded. A disabled button does nothing, as in a browser.
    press(id) { if ($('#' + id).disabled) return null; saved.length = 0; $('#' + id).onclick(); return saved[0] || null; },
    // The parsed form and the tool's result for it, the way update() gets them.
    run() { const t = ev('toolDef')(), q = ev('parsed')(); return { ...q, res: q.bad.length ? null : t.run(q.p) }; },
    // The print dialog: open it, set what is given, and return its summary line and the PDF.
    print(opts = {}) {
      $('#prt').onclick();
      for (const [k, v] of Object.entries(opts)) $('#p_' + k)[typeof v === 'boolean' ? 'checked' : 'value'] = v;
      $('#pdlg').fire('input', {});
      const sum = $('#psum').innerHTML.replace(/<[^>]+>/g, ''), ok = !$('#pgo').disabled;
      saved.length = 0; if (ok) $('#pgo').onclick();
      const pdf = saved[0] ? Buffer.from(saved[0].data).toString('latin1') : '';
      return { sum, ok, pdf, name: saved[0]?.name, pages: [...pdf.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map(q => [+q[1], +q[2]]) };
    },
  };
  return api;
}

// A DXF as its entities: [{ type, layer, pts: [[x, y, bulge]], closed, text }], enough to
// check what the writer sent without a full reader.
export function dxfEntities(text) {
  const L = text.split('\r\n'), pairs = [];
  for (let i = 0; i + 1 < L.length; i += 2) pairs.push([+L[i], L[i + 1]]);
  const out = []; let cur = null, poly = null;
  for (const [c, v] of pairs.slice(pairs.findIndex(q => q[1] === 'ENTITIES') + 1)) {
    if (c === 0) {
      if (v === 'VERTEX') { cur = [0, 0, 0]; poly.pts.push(cur); continue; }
      if (v === 'SEQEND' || v === 'ENDSEC' || v === 'EOF') { cur = null; continue; }
      cur = null; poly = { type: v, pts: [] }; out.push(poly);
      if (v === 'LINE') poly.pts.push([0, 0], [0, 0]);
    } else if (Array.isArray(cur)) { if (c === 10) cur[0] = +v; else if (c === 20) cur[1] = +v; else if (c === 42) cur[2] = +v; }
    else if (poly) {
      if (c === 8) poly.layer = v; else if (c === 70) poly.closed = (+v & 1) === 1; else if (c === 1) poly.text = v;
      else if (poly.type === 'LINE') { if (c === 10) poly.pts[0][0] = +v; else if (c === 20) poly.pts[0][1] = +v; else if (c === 11) poly.pts[1][0] = +v; else if (c === 21) poly.pts[1][1] = +v; }
    }
  }
  return out;
}
