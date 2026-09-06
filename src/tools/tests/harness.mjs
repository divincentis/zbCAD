// Boots the built single-file bundle inside a Node vm with a stub DOM/canvas,
// then hands back window.__cadPrototype. Nothing here is app logic — it exists
// only so the real bundle can run without a browser.
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// The build output, so a suite run with no argument tests what was just built.
export const DEFAULT_BUNDLE = fileURLToPath(new URL('../../dist/cad.html', import.meta.url));

const NOOP = () => {};

function makeStyle() {
  return new Proxy({}, { get: () => '', set: () => true });
}

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach(x => set.add(x)),
    remove: (...c) => c.forEach(x => set.delete(x)),
    toggle: (c, on) => (on === undefined ? (set.has(c) ? set.delete(c) : set.add(c)) : (on ? set.add(c) : set.delete(c))),
    contains: c => set.has(c),
  };
}

function makeCtx() {
  const base = {
    measureText: text => ({ width: String(text).length * 6 }),
    getImageData: () => ({ data: [] }),
    createLinearGradient: () => ({ addColorStop: NOOP }),
    canvas: null,
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      // Any drawing call the renderer makes is a no-op; any style property
      // reads back as whatever was last assigned.
      return NOOP;
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
}

function makeElement(id = '', tag = 'div') {
  const children = [];
  const base = {
    id,
    tagName: tag.toUpperCase(),
    hidden: false,
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    disabled: false,
    selectedIndex: 0,
    width: 1200,
    height: 800,
    clientWidth: 1200,
    clientHeight: 800,
    offsetWidth: 1200,
    offsetHeight: 800,
    style: makeStyle(),
    classList: makeClassList(),
    dataset: {},
    children,
    options: [],
    parentNode: null,
    // Cached, the way a real canvas hands back the same context every time.
    // dom.js captures its context once at boot, so a fresh stub per call would
    // leave what the renderer actually draws impossible to observe.
    getContext: () => (base.context ??= makeCtx()),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800, x: 0, y: 0 }),
    appendChild(child) { children.push(child); child.parentNode = base; return child; },
    removeChild(child) { const i = children.indexOf(child); if (i >= 0) children.splice(i, 1); return child; },
    replaceChildren(...next) { children.length = 0; next.forEach(c => children.push(c)); },
    append(...next) { next.forEach(c => children.push(c)); },
    remove() {},
    insertBefore(child) { children.push(child); return child; },
    addEventListener: NOOP,
    removeEventListener: NOOP,
    dispatchEvent: () => true,
    setAttribute: NOOP,
    getAttribute: () => null,
    removeAttribute: NOOP,
    hasAttribute: () => false,
    focus: NOOP,
    blur: NOOP,
    click: NOOP,
    select: NOOP,
    scrollIntoView: NOOP,
    setSelectionRange: NOOP,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol') return undefined;
      return NOOP;
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
}

// A minimal in-memory IndexedDB, enough for model/autosaveStore.js: open with
// an upgrade, one object store, get/put/delete inside a transaction that
// completes on a later turn. Requests resolve on a microtask and the
// transaction completes on a timer, so a request's onsuccess still runs before
// its transaction's oncomplete, the ordering the real API guarantees.
// `broken: true` is the browser that opens a database and then refuses every
// transaction — a storage policy or a private window that only fails on use.
function makeIndexedDB({ broken = false } = {}) {
  const databases = new Map();

  function makeStoreHandle(record, name) {
    const data = record.stores.get(name);
    const op = apply => {
      const request = { result: undefined, error: null, onsuccess: null, onerror: null };
      request.result = apply(data);
      queueMicrotask(() => request.onsuccess && request.onsuccess({ target: request }));
      return request;
    };
    return {
      get: key => op(map => map.get(key)),
      put: (value, key) => op(map => { map.set(key, structuredClone(value)); return key; }),
      delete: key => op(map => { map.delete(key); return undefined; }),
      clear: () => op(map => { map.clear(); return undefined; }),
    };
  }

  function makeDbHandle(record) {
    return {
      name: record.name,
      get version() { return record.version; },
      objectStoreNames: { contains: name => record.stores.has(name) },
      createObjectStore(name) {
        record.stores.set(name, new Map());
        return makeStoreHandle(record, name);
      },
      transaction(name, mode = 'readonly') {
        if (broken) throw new Error('storage is not allowed in this context');
        const storeName = Array.isArray(name) ? name[0] : name;
        if (!record.stores.has(storeName)) throw new Error(`no object store ${storeName}`);
        const tx = {
          mode,
          error: null,
          oncomplete: null,
          onerror: null,
          onabort: null,
          objectStore: () => makeStoreHandle(record, storeName),
        };
        setTimeout(() => tx.oncomplete && tx.oncomplete({ target: tx }), 0);
        return tx;
      },
      close: NOOP,
    };
  }

  return {
    databases,
    open(name, version = 1) {
      const request = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      let record = databases.get(name);
      const upgrading = !record || version > record.version;
      if (!record) { record = { name, version: 0, stores: new Map() }; databases.set(name, record); }
      request.result = makeDbHandle(record);
      setTimeout(() => {
        if (upgrading) {
          record.version = version;
          if (request.onupgradeneeded) request.onupgradeneeded({ target: request });
        }
        if (request.onsuccess) request.onsuccess({ target: request });
      }, 0);
      return request;
    },
  };
}

// `options.indexedDB: false` boots as a browser that refuses to open a database
// at all, and `'broken'` as one that opens it and then fails every read and
// write, so both localStorage fallbacks can be tested.
export function boot(bundlePath, options = {}) {
  const html = fs.readFileSync(bundlePath, 'utf8');
  // The bundle is one inline <script>; take the largest one so a small
  // bootstrap script elsewhere in the shell cannot be picked by mistake.
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const source = scripts.sort((a, b) => b.length - a.length)[0];
  if (!source) throw new Error('no inline script found in bundle');

  const elements = new Map();
  const getElementById = id => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };

  const store = new Map();
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear: () => store.clear(),
    key: i => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };

  const indexedDB = options.indexedDB === false ? null
    : makeIndexedDB({ broken: options.indexedDB === 'broken' });

  const documentStub = {
    getElementById,
    createElement: tag => makeElement('', tag),
    createElementNS: (_ns, tag) => makeElement('', tag),
    createTextNode: text => ({ textContent: text }),
    createDocumentFragment: () => makeElement('', 'fragment'),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: NOOP,
    removeEventListener: NOOP,
    execCommand: NOOP,
    activeElement: null,
    body: makeElement('body', 'body'),
    documentElement: makeElement('html', 'html'),
    readyState: 'complete',
    title: '',
  };

  const windowStub = {
    devicePixelRatio: 1,
    innerWidth: 1200,
    innerHeight: 800,
    localStorage,
    indexedDB,
    addEventListener: NOOP,
    removeEventListener: NOOP,
    requestAnimationFrame: cb => { cb(0); return 1; },
    cancelAnimationFrame: NOOP,
    getComputedStyle: () => new Proxy({}, { get: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener: NOOP, addListener: NOOP }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => Date.now() },
    alert: NOOP,
    confirm: () => true,
    prompt: () => null,
  };

  const sandbox = {
    window: windowStub,
    document: documentStub,
    localStorage,
    indexedDB,
    navigator: { userAgent: 'node', platform: 'node', clipboard: { writeText: async () => {} } },
    location: { href: 'file:///cad.html', search: '', hash: '' },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: windowStub.requestAnimationFrame,
    cancelAnimationFrame: NOOP,
    structuredClone,
    queueMicrotask,
    performance: windowStub.performance,
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: NOOP },
    FileReader: class { readAsText() {} },
    Image: class { },
    devicePixelRatio: 1,
    getComputedStyle: windowStub.getComputedStyle,
    matchMedia: windowStub.matchMedia,
    alert: NOOP,
    confirm: () => true,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  Object.setPrototypeOf(windowStub, sandbox);

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: bundlePath });

  const api = windowStub.__cadPrototype || sandbox.__cadPrototype;
  if (!api) throw new Error('bundle did not publish window.__cadPrototype');
  return { api, sandbox, localStorage, indexedDB };
}
