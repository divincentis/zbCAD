import { AUTOSAVE_DB_NAME, AUTOSAVE_DB_VERSION, AUTOSAVE_OPEN_TIMEOUT_MS, AUTOSAVE_STAMP_SUFFIX, AUTOSAVE_STORE_NAME } from '../core/constants.js';

// Where the autosaved drawing lives.
//
// Autosave runs after every edit, so whatever it costs is paid on every edit.
// localStorage is synchronous: the write blocked the main thread for ~1.5 ms at
// 100 entities and ~20 ms at 4,000, on top of the serialisation. IndexedDB
// writes are asynchronous, so the same save costs the edit nothing beyond the
// serialising it was already doing.
//
// The one thing IndexedDB cannot do is finish a write while the page is being
// torn down — a transaction opened from `beforeunload` is routinely aborted.
// So that path still writes synchronously, to localStorage, and recovery
// compares the two copies by timestamp and takes the newer one. localStorage is
// therefore three things: the unload snapshot, the fallback when IndexedDB is
// unavailable (private windows refuse to open a database), and the place older
// versions of this app left their autosave.
//
// Timestamps live in a sibling `.at` key rather than in an envelope around the
// text, so the localStorage copy stays exactly what it has always been: the
// drawing JSON, readable by any version of this app.

let autosaveDbPromise = null;

// Resolves to null rather than rejecting when the database is unavailable, so
// every caller has one fallback path instead of two.
export function openAutosaveDb() {
  if (autosaveDbPromise) return autosaveDbPromise;
  autosaveDbPromise = new Promise(resolve => {
    let request;
    try {
      if (!window.indexedDB) { resolve(null); return; }
      request = window.indexedDB.open(AUTOSAVE_DB_NAME, AUTOSAVE_DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(AUTOSAVE_STORE_NAME)) db.createObjectStore(AUTOSAVE_STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
    // A browser that neither opens the database nor refuses it — a blocked or
    // wedged upgrade — would otherwise leave every autosave waiting forever on
    // a promise that never settles. Falling back to localStorage for the rest
    // of the session is worth more than the database was.
    setTimeout(() => resolve(null), AUTOSAVE_OPEN_TIMEOUT_MS);
  });
  return autosaveDbPromise;
}

// Resolves on transaction completion rather than on request success: a request
// can succeed and its transaction still abort, and it is the commit that means
// the drawing survives the tab.
function runAutosaveTransaction(db, mode, run) {
  return new Promise((resolve, reject) => {
    let transaction;
    let request;
    try {
      transaction = db.transaction(AUTOSAVE_STORE_NAME, mode);
      request = run(transaction.objectStore(AUTOSAVE_STORE_NAME));
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(request ? request.result : undefined);
    transaction.onerror = () => reject(transaction.error || new Error('autosave store transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('autosave store transaction aborted'));
  });
}

function localAutosaveRecord(key) {
  const text = window.localStorage.getItem(key);
  if (typeof text !== 'string' || !text) return null;
  const stamp = Number(window.localStorage.getItem(key + AUTOSAVE_STAMP_SUFFIX));
  return { text, savedAt: Number.isFinite(stamp) ? stamp : 0, source: 'local' };
}

function clearLocalAutosaveRecord(key) {
  try {
    if (window.localStorage.getItem(key) === null) return;
    window.localStorage.removeItem(key);
    window.localStorage.removeItem(key + AUTOSAVE_STAMP_SUFFIX);
  } catch {
    // Leaving the copy behind is harmless: it is older than the one just
    // committed, and recovery compares timestamps.
  }
}

// The newest copy of one slot, whichever store holds it. An untimestamped
// localStorage copy is an autosave written by an older version of this app, so
// it reads as the oldest thing on offer.
export async function readAutosaveRecord(key) {
  let stored = null;
  const db = await openAutosaveDb();
  if (db) {
    try {
      const record = await runAutosaveTransaction(db, 'readonly', store => store.get(key));
      if (record && typeof record.text === 'string' && record.text) {
        stored = { text: record.text, savedAt: Number(record.savedAt) || 0, source: 'db' };
      }
    } catch {
      // A failed read is not a missing drawing: fall through to localStorage.
    }
  }
  const local = localAutosaveRecord(key);
  if (!stored) return local;
  if (!local) return stored;
  return local.savedAt > stored.savedAt ? local : stored;
}

export async function writeAutosaveRecord(key, text) {
  const db = await openAutosaveDb();
  if (!db) {
    writeAutosaveRecordSync(key, text);
    return 'local';
  }
  try {
    await runAutosaveTransaction(db, 'readwrite', store => store.put({ text, savedAt: Date.now() }, key));
  } catch {
    // A database that opens and then refuses to write (a storage policy, a
    // quota) must not cost the drawing an autosave: degrade to the synchronous
    // store, which recovery prefers anyway once it carries the newer stamp.
    writeAutosaveRecordSync(key, text);
    return 'local';
  }
  // The synchronous copy exists only to survive an unload. Once the same
  // drawing is committed to the database, a duplicate left behind can only
  // become a stale candidate for recovery.
  clearLocalAutosaveRecord(key);
  return 'db';
}

// The unload path. Throws like any other localStorage write when the store is
// full or unavailable; the caller decides what a failure there means.
export function writeAutosaveRecordSync(key, text) {
  window.localStorage.setItem(key, text);
  window.localStorage.setItem(key + AUTOSAVE_STAMP_SUFFIX, String(Date.now()));
}
