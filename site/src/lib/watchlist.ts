/**
 * watchlist.ts — the saved-properties store. Ported from SWC's src/lib/trip.ts
 * (claims-D claims 39/40), including its write-safety pattern verbatim:
 *
 *   version-guard  →  try/catch setItem  →  READ-BACK BYTE-VERIFY  →  dispatch
 *   the change event ONLY on confirmed success.
 *
 * Every step is there because of a real defect. The old SWC version swallowed a
 * quota / Safari-private-mode failure and dispatched the change event anyway, so
 * every listener repainted as though the write had worked and the user was told
 * their property was saved when nothing had been stored. A silent lie is worse
 * than a visible failure — callers get a boolean and MUST surface `false`.
 *
 * `toggle()` returns four states and every call site must handle all four.
 * Collapsing 'failed' into 'removed' is a documented past bug in the reference
 * and TypeScript will not catch it, because both are strings.
 *
 * ── THE ADDITION THE REFERENCE DOES NOT HAVE ────────────────────────────────
 * EXPORT / IMPORT. Grep the SWC source for export/import/download-blob across
 * src/lib and src/components and there are no matches — the reference has no
 * export path at all, and your own data is therefore the least durable thing in
 * the system. Two silent loss paths:
 *
 *   (a) BROWSER EVICTION. WebKit's ITP deletes all script-writable storage,
 *       localStorage included, after 7 days of Safari use with no interaction
 *       with the site. A Pages site you check weekly sits exactly on that
 *       boundary; a 10-day trip erases every property you were evaluating, with
 *       no notification and nothing to restore from.
 *
 *   (b) CANDIDATE-SET CHURN, which is quieter and far more frequent. Detail
 *       pages exist for the published candidate set, and that set is recomputed
 *       every run. Any weights change, or simply enough new candidates
 *       outranking a saved one, un-generates its /deal/<id>/ page and leaves
 *       this store holding a 404.
 *
 * So: exportBlob() / importJson(), a "last exported N days ago" nudge driven by
 * EXPORT_KEY, and — see WatchlistTray — a saved row whose parcel is no longer in
 * the payload renders in an explicit "no longer scored" state, never as a dead
 * link. No network calls anywhere in this module.
 */

export interface WatchItem {
  id: string;
  county: string;
  state: string;
  /** Score AT THE TIME IT WAS SAVED. Kept so a row that later leaves the payload
   *  can still show something true about why it was saved. */
  /** null = NOT SCORED. Never 0. `String(null)` reached data-score as the
   *  string "null", Number() made it NaN, and the guard below then rewrote
   *  NaN to 0 — so every unscored property (all 8 Lane-1 rows, all 150 TN
   *  rows) was saved to the watchlist and rendered as a hard score of 0. */
  score: number | null;
  savedAt: string;
}

const KEY = 'brdf:watchlist';
const EXPORT_KEY = 'brdf:watchlist:lastExport';
const VERSION = 1;
export const CHANGE_EVENT = 'brdf:watchlist';
/** Bounds a share URL, and nothing else. Notes live in a separate, uncapped
 *  store for exactly the reference's reason: a bounded shareable store is the
 *  wrong place for private notes. */
export const MAX_ITEMS = 60;

function coerce(i: unknown): WatchItem | null {
  if (!i || typeof i !== 'object') return null;
  const o = i as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id === '') return null;
  return {
    id: o.id,
    county: typeof o.county === 'string' ? o.county : '',
    state: typeof o.state === 'string' ? o.state : '',
    score: typeof o.score === 'number' && Number.isFinite(o.score) ? o.score : null,
    savedAt: typeof o.savedAt === 'string' ? o.savedAt : '',
  };
}

function read(): WatchItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.items)) return [];
    if (parsed.v !== VERSION) return [];
    return parsed.items.map(coerce).filter((x: WatchItem | null): x is WatchItem => x !== null);
  } catch {
    return [];
  }
}

function write(items: WatchItem[]): boolean {
  // Refuse to overwrite a store written by a NEWER build. read() returns [] on
  // an unknown version, so without this a stale cached bundle would rebuild the
  // key from nothing and destroy the whole watchlist.
  try {
    const cur = localStorage.getItem(KEY);
    if (cur) {
      const v = JSON.parse(cur)?.v;
      if (typeof v === 'number' && v > VERSION) return false;
    }
  } catch {
    /* corrupt is not newer — fall through so a mangled store can be replaced */
  }
  const payload = JSON.stringify({ v: VERSION, items });
  try {
    localStorage.setItem(KEY, payload);
  } catch {
    return false; // quota exceeded, or Safari private mode (throws on any write)
  }
  try {
    if (localStorage.getItem(KEY) !== payload) return false; // read-back verify
  } catch {
    return false;
  }
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { count: items.length } }));
  } catch {
    /* SSR / no window — the write itself still succeeded */
  }
  return true;
}

export function getItems(): WatchItem[] {
  return read();
}
export function has(id: string): boolean {
  return read().some((i) => i.id === id);
}
export function count(): number {
  return read().length;
}
export function remove(id: string): boolean {
  return write(read().filter((i) => i.id !== id));
}
export function clear(): boolean {
  return write([]);
}

export function toggle(item: Omit<WatchItem, 'savedAt'>): 'added' | 'removed' | 'full' | 'failed' {
  const items = read();
  if (items.some((i) => i.id === item.id)) {
    return write(items.filter((i) => i.id !== item.id)) ? 'removed' : 'failed';
  }
  if (items.length >= MAX_ITEMS) return 'full';
  const ok = write([...items, { ...item, savedAt: new Date().toISOString() }]);
  return ok ? 'added' : 'failed';
}

// --- Export / import -------------------------------------------------------

export interface ExportFile {
  app: 'blue-ridge-deal-finder';
  v: number;
  exportedAt: string;
  watchlist: WatchItem[];
  notes: Record<string, string>;
}

/** Build the export payload. The caller turns it into a Blob and a download —
 *  this module never touches the DOM, so it stays unit-testable. */
export function buildExport(notes: Record<string, string>): ExportFile {
  return {
    app: 'blue-ridge-deal-finder',
    v: VERSION,
    exportedAt: new Date().toISOString(),
    watchlist: read(),
    notes,
  };
}

export function markExported(): void {
  try {
    localStorage.setItem(EXPORT_KEY, new Date().toISOString());
  } catch {
    /* the export still happened; the nudge just won't reset */
  }
}

/** Whole days since the last export, or null if never exported. */
export function daysSinceExport(): number | null {
  try {
    const raw = localStorage.getItem(EXPORT_KEY);
    if (!raw) return null;
    const t = new Date(raw).getTime();
    if (Number.isNaN(t)) return null;
    return Math.floor((Date.now() - t) / 86400000);
  } catch {
    return null;
  }
}

export interface ImportResult {
  ok: boolean;
  added: number;
  duplicates: number;
  capped: number;
  notes: number;
  error?: string;
}

/**
 * Import an export file. MERGES — never replaces — because an import that
 * silently wiped a watchlist would be the same data-loss event this whole
 * export path exists to prevent, just triggered by the recovery step.
 */
export function importJson(text: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, added: 0, duplicates: 0, capped: 0, notes: 0, error: 'That file is not valid JSON.' };
  }
  const o = parsed as Partial<ExportFile>;
  if (!o || o.app !== 'blue-ridge-deal-finder' || !Array.isArray(o.watchlist)) {
    return {
      ok: false, added: 0, duplicates: 0, capped: 0, notes: 0,
      error: 'That file is not a Blue Ridge Deal Finder export.',
    };
  }
  const items = read();
  const have = new Set(items.map((i) => i.id));
  let added = 0;
  let duplicates = 0;
  let capped = 0;
  for (const raw of o.watchlist) {
    const it = coerce(raw);
    if (!it) continue;
    if (have.has(it.id)) {
      duplicates++;
      continue;
    }
    // `items` grows as we push, so items.length IS the running total. Adding
    // `added` too would double-count and cap early.
    if (items.length >= MAX_ITEMS) {
      capped++;
      continue;
    }
    items.push(it);
    have.add(it.id);
    added++;
  }
  // Count what ACTUALLY landed, after persistence — not before it. Reporting
  // "imported 12" from a refused write, on the recovery path where the user has
  // no other copy, is the worst possible place to be optimistic.
  const wrote = added === 0 ? true : write(items);
  const noteCount = o.notes && typeof o.notes === 'object' ? importNotes(o.notes) : 0;
  return {
    ok: wrote,
    added: wrote ? added : 0,
    duplicates,
    capped,
    notes: noteCount,
    ...(wrote ? {} : { error: 'This device refused the write — nothing was stored.' }),
  };
}

// --- Private notes: a SECOND store, deliberately -----------------------------
// Split for the reference's reason (claims-D claim 39): the watchlist is capped
// to bound a share URL, and a lifetime of private notes is the wrong thing to
// cap or to pack into a URL that gets pasted into texts and emails. Uncapped,
// never shared, never leaves the browser.

const NOTES_KEY = 'brdf:notes';
export const NOTES_CHANGE_EVENT = 'brdf:notes';
export const NOTE_MAX = 2000;

export function getNotes(): Record<string, string> {
  try {
    const raw = localStorage.getItem(NOTES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== VERSION || typeof parsed.notes !== 'object') return {};
    return parsed.notes as Record<string, string>;
  } catch {
    return {};
  }
}

function writeNotes(notes: Record<string, string>): boolean {
  const payload = JSON.stringify({ v: VERSION, notes });
  try {
    localStorage.setItem(NOTES_KEY, payload);
    if (localStorage.getItem(NOTES_KEY) !== payload) return false;
  } catch {
    return false;
  }
  try {
    window.dispatchEvent(new CustomEvent(NOTES_CHANGE_EVENT));
  } catch {
    /* SSR */
  }
  return true;
}

/** UPSERT — never a no-op on an unsaved property. The reference's rating setters
 *  began `if (!it) return`, so a control on an item the user had not already
 *  saved looked like it worked and silently did nothing. That defect is the
 *  reason the two stores were split in the first place. */
export function setNote(id: string, note: string): boolean {
  const notes = getNotes();
  const clean = String(note ?? '').slice(0, NOTE_MAX);
  if (clean.trim() === '') delete notes[id];
  else notes[id] = clean;
  return writeNotes(notes);
}

function importNotes(incoming: Record<string, unknown>): number {
  const notes = getNotes();
  let n = 0;
  for (const [id, v] of Object.entries(incoming)) {
    if (typeof v !== 'string' || v.trim() === '') continue;
    if (notes[id]) continue; // never clobber a note that is already here
    notes[id] = v.slice(0, NOTE_MAX);
    n++;
  }
  if (n === 0) return 0;
  return writeNotes(notes) ? n : 0;
}

// A tab whose write failed (private mode, quota) would otherwise stay degraded
// for its whole lifetime, and `storage` is the ONLY cross-tab signal —
// CHANGE_EVENT is a same-window CustomEvent and never crosses tabs. The pairing
// is required for correct cross-tab sync; neither half is sufficient alone.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY && e.key !== NOTES_KEY && e.key !== null) return;
    try {
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { crossTab: true } }));
      window.dispatchEvent(new CustomEvent(NOTES_CHANGE_EVENT, { detail: { crossTab: true } }));
    } catch {
      /* nothing to repaint */
    }
  });
}
