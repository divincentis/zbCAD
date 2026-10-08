// Boots panels.html's script inside a Node vm with a stubbed DOM. Like the scheduler, the page
// is one classic <script>, so every top-level function and `let` is reachable through ev() and
// no test hook is needed. The DOM stub and the reporter are the scheduler's own.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeEl, suite} from '../schedule/harness.mjs';

export {suite};
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PAGE = path.resolve(HERE, '../../../../panels.html');

export function boot(page = process.argv[2] || DEFAULT_PAGE, { autosave = null } = {}) {
  const html = fs.readFileSync(page, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no inline <script> in ' + page);
  const store = new Map(autosave == null ? [] : [['panels.autosave', typeof autosave === 'string' ? autosave : JSON.stringify(autosave)]]);
  const els = {}, timers = [];
  const $ = sel => (els[sel] ||= makeEl(sel));
  const document = { querySelector: $, getElementById: id => $('#' + id), addEventListener() {}, createElement: makeEl, body: makeEl('body'), activeElement: null };
  const sandbox = {
    console, document, confirm: () => true,
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: k => store.delete(k) },
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
    addEventListener() {}, Blob: class {}, URL: { createObjectURL: () => '', revokeObjectURL() {} }, FileReader: class {},
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(m[1], ctx, { filename: 'panels.html' });
  const ev = code => vm.runInContext(code, ctx);
  const api = {
    ev, $, store,
    flush() { while (timers.length) timers.shift()(); },
    get P() { return ev('P'); },
    load(project) { ev('loadProject')(project); return ev('P'); },
    // One package on one profile. `profile` and `def` patch the default profile and the package
    // defaults; each facet row patches a new facet, with params and layout merged, not replaced.
    make({ profile = {}, def = {}, units = {} } = {}, facets = []) {
      const p = ev('newProject')(), pk = p.packages[0];
      Object.assign(p.units, units);
      Object.assign(p.profiles.find(q => q.id === pk.def.profileId), profile);
      Object.assign(pk.def, def);
      for (const row of facets) {
        const { params, layout, ...rest } = row;
        const f = ev('newFacet')(p, pk, rest);
        Object.assign(f.params, params); Object.assign(f.layout, layout);
      }
      api.load(p);
      return ev('compute')();
    },
    // The layout of the facet carrying this ID, from a fresh compute().
    layout(mark) { const f = ev('P').facets.find(f => f.mark === mark); return ev('compute')().L.get(f.id); },
    select(mark) { const f = ev('P').facets.find(f => f.mark === mark); ev('S').f = f.id; ev('S').pk = ev('pkgOf')(f).id; return f; },
    // Send a typed value through the same path a change event in the inputs pane takes.
    type(bind, t, value, extra = {}) {
      const r = ev('applyField')({ dataset: { b: bind, t, ...extra }, value, checked: value === true });
      if (!r) ev('changed')();
      return r;
    },
  };
  return api;
}
