/* ==========================================================================
 * Caseload Manager — app.js  (offline caseload, task & diary manager)
 * --------------------------------------------------------------------------
 * Vanilla ES6+. No frameworks, no build step, no network calls.
 * Architecture:
 *   - One central `state` object (patients / tasks / diary / settings / meta).
 *   - Mutations go through `save()` then `render()` (simple publish loop).
 *   - Storage is abstracted behind `Storage` (localStorage -> IndexedDB).
 *   - A tiny hash router shows one view at a time.
 * ========================================================================== */

'use strict';

/* --------------------------------------------------------------------------
 * 1. Constants & default state
 * ------------------------------------------------------------------------ */
const SCHEMA_VERSION = 2;
const LS_KEY = 'caseload_manager_state_v1';       // localStorage record
const IDB_NAME = 'caseload_manager';
const IDB_STORE = 'kv';
const IDB_KEY = 'state';
const RECOVER_KEY = 'caseload_manager_corrupt_backup_v1';   // preserved unreadable save
const LS_SIZE_LIMIT = 3 * 1024 * 1024;            // ~3 MB, then switch to IndexedDB

/** Create a fresh default state object. */
function defaultState() {
  return {
    patients: [],
    tasks: [],
    diary: [],
    settings: {
      theme: 'light',
      workdayStart: '08:00',
      workdayEnd: '18:00',
      quickWinMinutes: 15,
      clinicalTargetHours: 0,
      waitWarningDays: 42,                  // days-in-stage breach warning
      caseloadView: {                       // persisted caseload view prefs
        mode: 'table', sortKey: 'daysInStage', dir: 'desc',
        groupBy: 'none', pathway: 'all', search: '', breachOnly: false,
      },
      supervisionView: {                    // its own prefs for the Supervision view
        mode: 'table', sortKey: 'daysInStage', dir: 'desc',
        groupBy: 'cmsStatus', pathway: 'all', search: '', breachOnly: false,
      },
      // ADHD priority scoring weights (tunable in Settings > Priority scoring)
      weights: { daysInStage: 0.4, dueProximity: 0.3, dread: 15, time: 0.2, priority: 5 },
      rewardAnimation: true,                // celebratory pulse on task completion
      suggestCount: 5,                      // tasks auto-suggested for today
      tasksView: { filter: 'all', sort: 'score', dir: 'desc', groupBy: 'patient' },  // Tasks view prefs
      diaryDate: null,                      // currently-shown diary day (null = today)
      diaryView: 'day',                     // day | week | month
      diaryZoom: 1,                         // timeline scale (1 = fill the screen)
      sidebarCollapsed: false,              // desktop: collapse the sidebar to an icon rail
      density: 'comfy',                     // comfy | compact  (spacing / how much fits)
      textSize: 'md',                       // sm | md | lg      (typography scale)
      todayCollapsed: {},                   // Today cards folded to their title, keyed by card id
    },
    meta: {
      schemaVersion: SCHEMA_VERSION,
      backend: 'localStorage',
      savedAt: null,
      autoPlannedDate: null,            // last day due-today tasks were auto-added to the plan
    },
  };
}

/* --------------------------------------------------------------------------
 * 2. Small utilities
 * ------------------------------------------------------------------------ */
const $ = (sel, root = document) => root.querySelector(sel);

/** RFC4122-ish UUID (crypto if available). */
function uuid() {
  if (self.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Local date as YYYY-MM-DD (not UTC, avoids off-by-one). */
function todayISO(d = new Date()) {
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

/** Add N days to an ISO date string. */
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return todayISO(d);
}

/** Whole calendar days from a YYYY-MM-DD date to today. Never negative. */
function daysSinceISO(iso) {
  if (!iso) return 0;
  const from = new Date(iso + 'T00:00:00');
  if (Number.isNaN(from.getTime())) return 0;
  const diff = Math.round((new Date(todayISO() + 'T00:00:00') - from) / 86400000);
  return diff > 0 ? diff : 0;
}

/**
 * Live "days in stage" — the figure stored on the patient plus one for each
 * whole day since it was last set (`daysInStageAsOf`). It ticks over on its
 * own, so a patient imported at 42 days reads 43 the next day without a
 * re-import. Falls back to the stored number when no anchor is known, so
 * pre-existing saves never jump.
 */
function daysInStageOf(p) {
  if (!p) return 0;
  return Math.max(0, (Number(p.daysInStage) || 0) + daysSinceISO(p.daysInStageAsOf));
}

/**
 * Give any patient that has no wait anchor one dated today, so their days in
 * stage starts counting from now (a first run on old data never jumps
 * forward). Returns true when something changed and needs saving.
 */
function seedStageAnchors() {
  const today = todayISO();
  let changed = false;
  for (const p of state.patients) {
    if (p && !p.daysInStageAsOf) { p.daysInStageAsOf = today; changed = true; }
  }
  return changed;
}

/** Escape untrusted text before injecting into HTML. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* --------------------------------------------------------------------------
 * Inline SVG icon set (Phase C). Stroke-based paths on a 24px grid using
 * currentColor, so icons inherit theme colours and need no CDN/font files.
 * ------------------------------------------------------------------------ */
const ICON_PATHS = {
  today: '<path d="M8 2v3M16 2v3M3.5 8h17"/><rect x="3" y="5" width="18" height="16" rx="2"/><path d="m9 14 2 2 4-4"/>',
  tasks: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3 6 1.6 1.6L7.2 5M3 12l1.6 1.6L7.2 11M3 18l1.6 1.6L7.2 17"/>',
  caseload: '<path d="M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1"/><circle cx="9" cy="8" r="3.2"/><path d="M22 20v-1a4 4 0 0 0-3-3.87M16 4.13A4 4 0 0 1 16 12"/>',
  supervision: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  diary: '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M8 2.5v4M16 2.5v4M3 9.5h18M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.64 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z"/>',
  overdue: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  quick: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="m5 12 4.5 4.5L19 7"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  pin: '<path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3H7l3-3-1-6Z"/>',
  dots: '<circle cx="12" cy="5" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.7" fill="currentColor" stroke="none"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
};

/** Render an inline SVG icon by name. */
function icon(name, cls = 'icon') {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
}

/** Human-friendly relative label for a due date. */
function dueLabel(iso) {
  if (!iso) return 'No due date';
  const today = todayISO();
  if (iso === today) return 'Due today';
  if (iso < today) {
    const days = Math.round((new Date(today) - new Date(iso)) / 86400000);
    return `${days} day${days === 1 ? '' : 's'} overdue`;
  }
  const days = Math.round((new Date(iso) - new Date(today)) / 86400000);
  if (days === 1) return 'Due tomorrow';
  return `Due in ${days} days`;
}

/** Human-readable byte size. */
function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

/* --------------------------------------------------------------------------
 * 3. Storage wrapper — localStorage with automatic IndexedDB fallback
 * ------------------------------------------------------------------------ */

/** Promise wrappers around the tiny IndexedDB key/value store. */
const idb = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in self)) return reject(new Error('IndexedDB unavailable'));
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
  },
  async get(key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  },
  async set(key, value) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  async del(key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};

const Storage = {
  backend: 'localStorage',
  recoveredRaw: null,   // raw text of an unreadable save (this boot)
  justRecovered: false, // true only on the boot where corruption was found

  /** Decide which backend holds the data on startup. */
  async init() {
    // Prefer localStorage when it already holds a record.
    try {
      if (localStorage.getItem(LS_KEY)) { this.backend = 'localStorage'; return; }
    } catch (_) { /* storage blocked */ }
    // Otherwise check IndexedDB.
    try {
      const existing = await idb.get(IDB_KEY);
      if (existing) { this.backend = 'indexedDB'; return; }
    } catch (_) { /* idb unavailable */ }
    this.backend = 'localStorage';
  },

  /** Load and parse the saved state, or null if none/garbage. */
  async load() {
    let raw = null;
    try {
      if (this.backend === 'indexedDB') {
        raw = await idb.get(IDB_KEY);
      } else {
        raw = localStorage.getItem(LS_KEY);
        if (!raw) raw = await idb.get(IDB_KEY); // fall back if promoted previously
      }
    } catch (err) {
      console.warn('Could not read saved state:', err);
      return null;
    }
    if (!raw) return null;

    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return migrate(parsed);
    } catch (err) {
      // Corrupt payload — keep an untouched copy so nothing is silently lost,
      // then move it out of the live key so the app boots cleanly next time.
      console.error('Saved data could not be parsed:', err);
      this.recoveredRaw = text;
      this.justRecovered = true;
      try { localStorage.setItem(RECOVER_KEY, text); } catch (_) { /* quota */ }
      try { localStorage.removeItem(LS_KEY); } catch (_) {}
      try { await idb.del(IDB_KEY); } catch (_) { /* idb unavailable */ }
      return null;
    }
  },

  /** True when an unreadable save has been preserved for the user. */
  hasRecovered() {
    try { return !!localStorage.getItem(RECOVER_KEY); } catch (_) { return false; }
  },
  getRecovered() {
    try { return localStorage.getItem(RECOVER_KEY); } catch (_) { return null; }
  },
  clearRecovered() {
    try { localStorage.removeItem(RECOVER_KEY); } catch (_) {}
  },

  /** Persist state to the active backend, promoting to IndexedDB if needed. */
  async save(state) {
    const json = JSON.stringify(state);
    state.meta.backend = this.backend;
    state.meta.savedAt = new Date().toISOString();

    if (this.backend === 'localStorage') {
      try {
        localStorage.setItem(LS_KEY, json);
        if (json.length > LS_SIZE_LIMIT) await this._promote(json);
        return;
      } catch (_) {
        // Quota exceeded or blocked -> upgrade to IndexedDB.
        await this._promote(json);
        return;
      }
    }
    await idb.set(IDB_KEY, json);
  },

  /** Move the payload into IndexedDB and drop the localStorage copy. */
  async _promote(json) {
    try {
      await idb.set(IDB_KEY, json);
      try { localStorage.removeItem(LS_KEY); } catch (_) {}
      this.backend = 'indexedDB';
      refreshStoragePill();
      toast('Large caseload detected — switched storage to IndexedDB.', 'success');
    } catch (err) {
      console.error('IndexedDB promotion failed:', err);
      toast('Storage full and IndexedDB unavailable. Export a backup!', 'error');
    }
  },

  /** Wipe both stores (used by Settings > Reset). */
  async clear() {
    try { localStorage.removeItem(LS_KEY); } catch (_) {}
    try { await idb.del(IDB_KEY); } catch (_) {}
  },
};

/** Fill in any missing fields on older/partial backups. */
function migrate(data) {
  const base = defaultState();
  const out = Object.assign({}, base, data);
  out.settings = Object.assign({}, base.settings, data.settings || {});
  out.settings.weights = Object.assign({}, base.settings.weights, (data.settings || {}).weights || {});
  out.settings.tasksView = Object.assign({}, base.settings.tasksView, (data.settings || {}).tasksView || {});
  out.settings.supervisionView = Object.assign({}, base.settings.supervisionView, (data.settings || {}).supervisionView || {});
  // v1 → v2: the Supervision view first shipped grouping by "None"; make CMS status the default.
  const prevSchema = (data.meta && data.meta.schemaVersion) || 0;
  if (prevSchema < 2 && out.settings.supervisionView.groupBy === 'none') {
    out.settings.supervisionView.groupBy = 'cmsStatus';
  }
  out.meta = Object.assign({}, base.meta, data.meta || {});
  out.patients = Array.isArray(out.patients) ? out.patients : [];
  out.tasks = Array.isArray(out.tasks) ? out.tasks : [];
  out.diary = Array.isArray(out.diary) ? out.diary : [];
  out.meta.schemaVersion = SCHEMA_VERSION;
  return out;
}

/* --------------------------------------------------------------------------
 * 4. Application state + save/render loop
 * ------------------------------------------------------------------------ */
let state = defaultState();

/** Persist then re-render. All mutations should end here. */
async function save() {
  await Storage.save(state);
  render();
}

function render() {
  applyTheme();
  applyDensity();
  applyLayout();
  renderView();          // also refreshes the sidebar nav + smart lists
  refreshStoragePill();
  syncDrawerTasks();
}

/* --------------------------------------------------------------------------
 * 5. Router
 * ------------------------------------------------------------------------ */
const ROUTES = [
  { id: 'today',    label: 'Today',    render: renderToday },
  { id: 'tasks',    label: 'Tasks',    render: renderTasks },
  { id: 'caseload', label: 'Caseload', render: renderCaseload },
  { id: 'supervision', label: 'Supervision', render: renderSupervision },
  { id: 'diary',    label: 'Diary',    render: renderDiary },
  { id: 'settings', label: 'Settings', render: renderSettings },
];

function currentRouteId() {
  const id = (location.hash || '').replace(/^#\/?/, '');
  return ROUTES.some((r) => r.id === id) ? id : 'today';
}

/** Route → icon name for the sidebar. */
const ROUTE_ICONS = { today: 'today', tasks: 'tasks', caseload: 'caseload', supervision: 'supervision', diary: 'diary', settings: 'settings' };

function renderNav() {
  const active = currentRouteId();
  const primary = ROUTES.filter((r) => r.id !== 'settings');
  const link = (r, extra = '') => `
    <a class="side-link ${extra}" href="#/${r.id}" title="${r.label}" ${r.id === active ? 'aria-current="page"' : ''}>
      <span class="side-link__icon">${icon(ROUTE_ICONS[r.id] || 'tasks')}</span>
      <span class="side-link__label">${r.label}</span>
    </a>`;
  $('#nav').innerHTML = primary.map((r) => link(r)).join('');
  renderSmartLists();
}

/** Live Smart lists in the sidebar: task filters + long waits. */
function renderSmartLists() {
  const host = $('#side-lists');
  if (!host) return;
  host.innerHTML = '';
}

/** Close the off-canvas sidebar (mobile) and reset the toggle state. */
function closeSidebar() {
  const sb = $('#sidebar');
  if (sb) sb.classList.remove('sidebar--open');
  const bd = $('#sidebar-backdrop');
  if (bd) bd.hidden = true;
  const btn = document.querySelector('.topbar__menu');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function renderView() {
  const route = ROUTES.find((r) => r.id === currentRouteId()) || ROUTES[0];
  const view = $('#view');
  // Re-rendering rebuilds the caseload scroller, so remember where it was.
  const prevScroll = (view.querySelector('.caseload-table-scroll') || {}).scrollTop || 0;
  view.innerHTML = route.render();
  // The diary gets a wider canvas and stretches to fill the screen.
  view.classList.toggle('view--diary', route.id === 'diary');
  // Caseload-style views fill the screen so a long list scrolls in place, not the page.
  const caseView = route.id === 'caseload' || route.id === 'supervision';
  view.classList.toggle('view--caseload', caseView);
  view.classList.toggle('view--caseload-table', caseView && caseloadConfig(route.id).mode === 'table');
  const scroller = view.querySelector('.caseload-table-scroll');
  if (scroller && prevScroll) scroller.scrollTop = prevScroll;
  renderNav();
  updateThemeToggle();
  // Ensure topnav classes match current nav structure
  const topnav = $('.topnav');
  if (topnav) {
    const nav = $('#nav');
    const lists = $('#side-lists');
    if (nav && !nav.classList.contains('topnav__nav')) nav.classList.add('topnav__nav');
    if (lists && !lists.classList.contains('topnav__lists')) lists.classList.add('topnav__lists');
  }
  // An open caseload menu lives inside a scrolling/clipping container, so move
  // it to the viewport layer where it can't be cut off.
  if (caseloadMenuId) placeCaseloadMenu();
}

window.addEventListener('hashchange', () => {
  caseloadMenuId = null;
  closeDrawer();
  closeSidebar();
  renderView();
  if (pendingDrawerId) { const id = pendingDrawerId; pendingDrawerId = null; openDrawer(id); }
});

/* --------------------------------------------------------------------------
 * 6. Derived data helpers
 * ------------------------------------------------------------------------ */
const activeTasks = () => state.tasks.filter((t) => !t.isCompleted);
const patientName = (id) => (state.patients.find((p) => p.patientId === id) || {}).name || '—';
const tasksFor = (patientId) => state.tasks.filter((t) => t.patientId === patientId);

function countOverdue() {
  const today = todayISO();
  return activeTasks().filter((t) => t.dueDate && t.dueDate < today).length;
}
function countDueToday() {
  const today = todayISO();
  return activeTasks().filter((t) => t.dueDate === today).length;
}

/** Patients past the wait warning — same rule as the Caseload "Long waits" filter. */
function longWaitPatients() {
  const threshold = Number(state.settings.waitWarningDays) || 42;
  return state.patients
    .filter((p) => daysInStageOf(p) >= threshold)
    .sort((a, b) => daysInStageOf(b) - daysInStageOf(a));
}

/* --------------------------------------------------------------------------
 * 6b. ADHD priority scoring (Phase 4)
 * ------------------------------------------------------------------------ */

/** Defaults used by "reset weights" in Settings. */
const DEFAULT_WEIGHTS = { daysInStage: 0.4, dueProximity: 0.3, dread: 15, time: 0.2, priority: 5 };

/**
 * 0–160 metric of how "due" a task is. Overdue scores highest, then due today,
 * then a rolling 13-day horizon. Powers the dueProximity component.
 */
function dueProximity(iso) {
  if (!iso) return 0;
  const days = Math.round((new Date(iso) - new Date(todayISO())) / 86400000);
  if (days < 0) return 100 + Math.min(60, -days * 6); // overdue: 100 → 160
  if (days === 0) return 95;                          // due today
  return Math.max(0, 95 - days * 7);                  // future, fading to 0
}

/**
 * ADHD priority score — higher = act sooner. Components, all tunable:
 *   wait  = min(daysInStage, 120)         × weights.daysInStage
 *   due   = dueProximity() 0–160          × weights.dueProximity
 *   dread = dreadScore (1–5)              × weights.dread
 *   time  = estimatedMinutes              × weights.time
 *   prio  = high 2 / medium 1 / low 0     × weights.priority
 */
function taskScore(t) {
  const w = state.settings.weights || DEFAULT_WEIGHTS;
  const p = t.patientId ? state.patients.find((x) => x.patientId === t.patientId) : null;
  const wait = Math.min(daysInStageOf(p), 120);
  const dread = Number(t.dreadScore) || 0;
  const est = Number(t.estimatedMinutes) || 0;
  const prio = t.priority === 'high' ? 2 : t.priority === 'low' ? 0 : 1;
  return wait * w.daysInStage + dueProximity(t.dueDate) * w.dueProximity
       + dread * w.dread + est * w.time + prio * w.priority;
}

const isOverdue = (t) => !!t.dueDate && t.dueDate < todayISO();
const isDueToday = (t) => !!t.dueDate && t.dueDate === todayISO();
function patientBreach(t) {
  if (!t.patientId) return false;
  const p = state.patients.find((x) => x.patientId === t.patientId);
  return !!p && daysInStageOf(p) >= (state.settings.waitWarningDays || 42);
}
function isUrgent(t) {
  return isOverdue(t) || isDueToday(t) || patientBreach(t) || t.priority === 'high';
}
function isQuickWin(t) {
  const qw = Number(state.settings.quickWinMinutes) || 15;
  return !isUrgent(t) && ((Number(t.estimatedMinutes) || 0) <= qw || (Number(t.dreadScore) || 3) <= 2);
}
const quickWins = () => activeTasks().filter(isQuickWin);

/** Active tasks, most urgent first. */
const activeByScore = () => activeTasks().slice().sort((a, b) => taskScore(b) - taskScore(a));

/** Tasks the user has planned for today. */
const allocatedToday = () => activeTasks().filter((t) => t.allocatedDate === todayISO());
const plannedToday = (t) => t.allocatedDate === todayISO();

/**
 * Once per day, auto-add active due-today tasks to today’s plan so the
 * Today view (and its time budget) always reflect the day’s due work.
 * Guarded by meta.autoPlannedDate so a task the user removes from the plan
 * stays removed for the rest of the day.
 */
function autoPlanDueToday() {
  const today = todayISO();
  if (state.meta.autoPlannedDate === today) return false;
  let changed = false;
  activeTasks().forEach((t) => {
    if (isDueToday(t) && !t.allocatedDate) { t.allocatedDate = today; changed = true; }
  });
  state.meta.autoPlannedDate = today;
  return changed;
}

/** Auto-suggested tasks for today (not already planned). */
function suggestForToday(n) {
  const used = new Set(allocatedToday().map((t) => t.taskId));
  const horizon = addDays(todayISO(), 2);
  return activeByScore()
    .filter((t) => !used.has(t.taskId))
    .filter((t) => !t.dueDate || t.dueDate <= horizon)
    .slice(0, n || Number(state.settings.suggestCount) || 5);
}

/** Highest active-task priority score attached to a patient (0 = none). */
function patientScore(patientId) {
  return activeTasks()
    .filter((t) => t.patientId === patientId)
    .reduce((max, t) => Math.max(max, taskScore(t)), 0);
}

/** Minutes between the configured workday start and end. */
function workdayMinutes() {
  const [sh, sm] = (state.settings.workdayStart || '08:00').split(':').map(Number);
  const [eh, em] = (state.settings.workdayEnd || '18:00').split(':').map(Number);
  return Math.max(0, (eh * 60 + em) - (sh * 60 + sm));
}

/* --------------------------------------------------------------------------
 * 7. Views
 * ------------------------------------------------------------------------ */

/* ---- Today --------------------------------------------------------- */
/** A bulleted summary of hour totals, used by the Diary day/week cards. */
function statList(rows) {
  return `<ul class="stat-list">
    ${rows.map((r) => `
      <li class="stat-list__row${r.total ? ' stat-list__row--total' : ''}">
        <span class="stat-list__label">${r.id ? `<span class="hours-dot hours-dot--${r.id}"></span>` : ''}${esc(r.label)}</span>
        <strong class="stat-list__value">${esc(r.value)}</strong>
      </li>`).join('')}
  </ul>`;
}

/**
 * A titled card. Pass an `id` to make the header a collapse toggle: the body
 * folds away to just the title, and the folded state is remembered per id in
 * settings.todayCollapsed.
 */
function sectionPanel(title, tone, listHTML, { id = null, collapsed = false } = {}) {
  if (!id) {
    return `<div class="panel panel--${tone}">
      <div class="panel__title">${esc(title)}</div>
      <div class="panel__list">${listHTML}</div>
    </div>`;
  }
  const bodyId = `card-body-${id}`;
  return `<div class="panel panel--${tone}${collapsed ? ' panel--collapsed' : ''}">
    <button type="button" class="panel__title panel__title--btn" data-action="toggle-card"
            data-card="${esc(id)}" aria-expanded="${collapsed ? 'false' : 'true'}"
            aria-controls="${bodyId}" title="${collapsed ? 'Expand' : 'Collapse'} card">
      <span class="panel__title-text">${esc(title)}</span>
      <span class="panel__chevron" aria-hidden="true">${icon('chevron')}</span>
    </button>
    <div class="panel__list" id="${bodyId}">${listHTML}</div>
  </div>`;
}

/** Has the given Today card been folded to its title? */
function isCardCollapsed(id) {
  return !!(state.settings.todayCollapsed && state.settings.todayCollapsed[id]);
}

/** Inline quick-add bar: type + Enter. Shared by the Tasks and Today views. */
function quickAddForm() {
  return `<form class="quick-add" data-action="quick-add-form">
    <span class="quick-add__icon" aria-hidden="true">${icon('plus')}</span>
    <input class="quick-add__input" id="quick-add-input" type="text" name="q"
           placeholder="Add a task…   try “call Sam tomorrow 30m”"
           aria-label="Quick add task" autocomplete="off" />
    <button class="btn btn--primary" type="submit">Add</button>
  </form>`;
}

/** A single task row. Patient is always shown first, then the task itself. */
function taskItem(t, { allocated = false } = {}) {
  const od = isOverdue(t);
  const p = t.patientId ? state.patients.find((x) => x.patientId === t.patientId) : null;
  const patientLabel = p ? esc(p.name) : 'General';
  const meta = [];
  meta.push(`<span class="${od ? 'due-overdue' : ''}">${esc(dueLabel(t.dueDate))}</span>`);
  if (t.estimatedMinutes) meta.push(`${esc(t.estimatedMinutes)} min`);
  if (t.dreadScore) meta.push(`dread ${esc(t.dreadScore)}/5`);
  if (t.priority && t.priority !== 'medium') meta.push(esc(t.priority));
  const score = Math.round(taskScore(t));
  const allocLabel = allocated ? 'Remove from today' : "Add to today's plan";
  return `<li class="task-row ${od ? 'task-row--overdue' : ''}" data-task="${esc(t.taskId)}">
    <button class="task-row__check" data-action="toggle-task" data-id="${esc(t.taskId)}"
            aria-label="Mark complete" title="Mark complete"></button>
    <div class="task-row__main">
      <span class="task-row__top">
        <span class="task-row__patient">${patientLabel}</span>
        <span class="task-row__meta">${meta.join(' · ')}</span>
      </span>
      <button type="button" class="task-row__title task-row__title--btn" data-action="edit-task"
              data-id="${esc(t.taskId)}" title="Edit task">${esc(t.title)}</button>
    </div>
    <span class="task-row__score" title="ADHD priority score">${score}</span>
    <div class="task-row__actions">
      <button class="btn--icon" data-action="${allocated ? 'unallocate-task' : 'allocate-task'}" data-id="${esc(t.taskId)}"
              aria-label="${allocLabel}" title="${allocLabel}">${icon(allocated ? 'x' : 'pin')}</button>
      <button class="btn--icon" data-action="edit-task" data-id="${esc(t.taskId)}"
              aria-label="Edit task" title="Edit task">${icon('edit')}</button>
      <button class="btn--icon" data-action="delete-task" data-id="${esc(t.taskId)}"
              aria-label="Delete task" title="Delete task">${icon('trash')}</button>
    </div>
  </li>`;
}

/** A tappable stat pill that opens a review modal (add its tasks to today’s plan). */
function statPill(tone, value, label, key) {
  return `<button type="button" class="stat stat--compact stat--${tone}"
    data-action="open-focus" data-focus="${esc(key)}"
    title="Review ${esc(label)}">
    <span class="stat__value">${esc(value)}</span>
    <span class="stat__label">${esc(label)}</span>
  </button>`;
}

/** Active tasks behind a Today stat pill: overdue, due today, or quick wins. */
function focusTasks(kind) {
  if (kind === 'quick') return activeByScore().filter(isQuickWin);
  if (kind === 'today') return activeByScore().filter(isDueToday);
  return activeByScore().filter(isOverdue);
}

/** One task row inside the focus modal, with an add/remove-from-plan toggle. */
function focusTaskRow(t, kind) {
  const od = isOverdue(t);
  const planned = plannedToday(t);
  const p = t.patientId ? state.patients.find((x) => x.patientId === t.patientId) : null;
  const patientLabel = p ? esc(p.name) : 'General';
  const meta = [];
  meta.push(`<span class="${od ? 'due-overdue' : ''}">${esc(dueLabel(t.dueDate))}</span>`);
  if (t.estimatedMinutes) meta.push(`${esc(t.estimatedMinutes)} min`);
  if (t.dreadScore) meta.push(`dread ${esc(t.dreadScore)}/5`);
  if (t.priority && t.priority !== 'medium') meta.push(esc(t.priority));
  const score = Math.round(taskScore(t));
  const label = planned ? 'Remove from today’s plan' : 'Add to today’s plan';
  return `<li class="task-row ${od ? 'task-row--overdue' : ''}" data-task="${esc(t.taskId)}">
    <button class="task-row__check" data-action="toggle-task" data-id="${esc(t.taskId)}"
            aria-label="Mark complete" title="Mark complete"></button>
    <div class="task-row__main">
      <span class="task-row__top">
        <span class="task-row__patient">${patientLabel}</span>
        <span class="task-row__meta">${meta.join(' · ')}</span>
      </span>
      <span class="task-row__title">${esc(t.title)}</span>
    </div>
    <span class="task-row__score" title="ADHD priority score">${score}</span>
    <div class="task-row__actions">
      <button class="btn btn--sm ${planned ? '' : 'btn--primary'}"
              data-action="focus-toggle-plan" data-id="${esc(t.taskId)}" data-focus="${esc(kind)}"
              aria-pressed="${planned}" aria-label="${label}" title="${label}">
        ${planned ? '✓ In plan' : '＋ Add'}
      </button>
    </div>
  </li>`;
}

/** A patient row with a "send to supervision" button (Long waits modal). */
function patientSupervisionRow(p) {
  const days = daysInStageOf(p);
  const awaiting = (p.cmsStatus || '') === 'Awaiting';
  const open = tasksFor(p.patientId).filter((t) => !t.isCompleted).length;
  const meta = [p.pathway || 'No pathway', `${days} days`, open ? `${open} open` : 'none open'];
  const label = awaiting ? 'Already awaiting supervision' : 'Send to supervision (CMS status: Awaiting)';
  return `<li class="task-row" data-patient="${esc(p.patientId)}">
    ${tagSwatch(p.colorTag)}
    <div class="task-row__main">
      <span class="task-row__top">
        <span class="task-row__patient">${esc(p.name)}</span>
        <span class="task-row__meta">${meta.map((s) => esc(s)).join(' · ')}</span>
      </span>
      <span class="task-row__title">${esc(p.patientId)}</span>
    </div>
    <div class="task-row__actions">
      <button class="btn btn--sm ${awaiting ? '' : 'btn--primary'}"
              data-action="send-supervision" data-id="${esc(p.patientId)}"
              aria-pressed="${awaiting}" aria-label="${label}" title="${label}">
        ${awaiting ? '✓ Awaiting' : '＋ Supervision'}
      </button>
      <button class="btn--icon" data-action="open-drawer" data-id="${esc(p.patientId)}"
              aria-label="Open details" title="Open details">${icon('caseload')}</button>
    </div>
  </li>`;
}

/** Which focus modal is open, so it can be refreshed after a state change. */
let focusModalKind = null;

/**
 * Modal opened by the Today “Overdue” / “Due today” / “Quick wins” pills: the
 * relevant tasks with a per-task add/remove-from-plan control, plus “add all”.
 * The “longwait” kind opens the patient-based Long waits modal instead.
 */
function openFocusModal(kind, focusTaskId) {
  if (kind === 'longwait') { openLongWaitModal(focusTaskId); return; }
  const cfg = kind === 'quick'
    ? { label: 'Quick wins', emoji: '⚡' }
    : kind === 'today'
      ? { label: 'Due today', emoji: '📅' }
      : { label: 'Overdue', emoji: '⏰' };
  const list = focusTasks(kind);
  const unplanned = list.filter((t) => !plannedToday(t));
  const count = list.length;
  const emptyText = kind === 'quick' ? 'qualifying as a quick win' : kind === 'today' ? 'due today' : 'overdue';
  const body = `
    <p class="modal__hint">Choose the tasks to add to today’s plan, or add them all.
      Completed tasks drop off the list automatically.</p>
    ${unplanned.length ? `<div class="btn-row" style="margin-bottom:var(--space-4)">
      <button class="btn btn--primary" data-action="focus-add-all" data-focus="${esc(kind)}">
        ＋ Add all ${unplanned.length} to today’s plan
      </button>
    </div>` : ''}
    ${count
      ? `<ul class="task-list">${list.map((t) => focusTaskRow(t, kind)).join('')}</ul>`
      : `<p class="field-row__hint">Nothing ${emptyText} right now. 🎉</p>`}`;
  openModal({
    title: `${cfg.emoji} ${cfg.label} — ${count} task${count === 1 ? '' : 's'}`,
    body,
    actions: [{ label: 'Done', variant: 'primary', onClick: closeModal }],
  });
  focusModalKind = kind;
  if (focusTaskId) {
    const id = window.CSS && CSS.escape ? CSS.escape(focusTaskId) : focusTaskId;
    const btn = document.querySelector(`#modal-root [data-action="focus-toggle-plan"][data-id="${id}"]`);
    if (btn) btn.focus();
  }
}

/** Modal opened by the Today “Long waits” pill: patients past the wait warning. */
function openLongWaitModal(focusPatientId) {
  const list = longWaitPatients();
  const threshold = Number(state.settings.waitWarningDays) || 42;
  const body = `
    <p class="modal__hint">Patients at ${threshold}+ days in their current stage.
      Send the ones you want to review to Supervision (sets their CMS status to “Awaiting”).</p>
    ${list.length
      ? `<ul class="task-list">${list.map(patientSupervisionRow).join('')}</ul>`
      : '<p class="field-row__hint">No patients past the wait warning. 🎉</p>'}`;
  openModal({
    title: `⏳ Long waits — ${list.length} patient${list.length === 1 ? '' : 's'}`,
    body,
    actions: [{ label: 'Done', variant: 'primary', onClick: closeModal }],
  });
  focusModalKind = 'longwait';
  if (focusPatientId) {
    const id = window.CSS && CSS.escape ? CSS.escape(focusPatientId) : focusPatientId;
    const btn = document.querySelector(`#modal-root [data-action="send-supervision"][data-id="${id}"]`);
    if (btn) btn.focus();
  }
}

/** Rebuild the focus modal if one is open, so it stays in sync with state changes. */
function refreshFocusModal(focusTaskId) {
  if (focusModalKind && !$('#modal-root').hidden) openFocusModal(focusModalKind, focusTaskId);
}

/**
 * A slimline schedule strip for the day: a single thin line spanning the
 * working day, with one coloured bar per diary booking (width = duration),
 * time labels underneath, and a live "now" marker. Click a bar to edit.
 */
function todayTimelineHTML(iso) {
  const events = eventsOn(iso).slice().sort((a, b) => minutesOf(a.startTime) - minutesOf(b.startTime));
  let dayStart = minutesOf(state.settings.workdayStart);
  let dayEnd = minutesOf(state.settings.workdayEnd);
  events.forEach((e) => {
    dayStart = Math.min(dayStart, minutesOf(e.startTime));
    dayEnd = Math.max(dayEnd, minutesOf(e.endTime));
  });
  dayStart = Math.floor(dayStart / 60) * 60;
  dayEnd = Math.ceil(dayEnd / 60) * 60;
  if (dayEnd - dayStart < 60) dayEnd = dayStart + 60;
  const span = dayEnd - dayStart;
  const pos = (m) => ((m - dayStart) / span) * 100;

  // Time labels under the line (every hour, or every two on a long day).
  const labelStep = span > 360 ? 120 : 60;
  const labels = [];
  for (let m = dayStart; m <= dayEnd; m += labelStep) {
    const edge = m === dayStart ? ' timeline__axis-label--first' : (m === dayEnd ? ' timeline__axis-label--last' : '');
    labels.push(`<span class="timeline__axis-label${edge}" style="left:${pos(m)}%">${fmtTime(m)}</span>`);
  }

  const bars = events.map((e) => {
    const s = minutesOf(e.startTime);
    const en = minutesOf(e.endTime);
    const left = pos(Math.max(dayStart, s));
    const width = Math.max(1.2, pos(Math.min(dayEnd, en)) - left);
    const pname = e.patientId ? patientName(e.patientId) : '';
    const tip = `${e.title} · ${fmtTime(s)}–${fmtTime(en)}${pname ? ' · ' + pname : ''}`;
    return `<button type="button" class="timeline__bar timeline__bar--${esc(e.category)}"
      style="left:${left}%;width:${width}%"
      data-action="edit-event" data-id="${esc(e.eventId)}" data-date="${esc(iso)}"
      title="${esc(tip)}" aria-label="${esc(tip)}"></button>`;
  }).join('');

  const nowMin = nowMinutes();
  const nowInRange = nowMin >= dayStart && nowMin <= dayEnd;
  const nowLine = `<div class="timeline__now" data-now-line data-axis="x"
      data-day-start="${dayStart}" data-day-end="${dayEnd}"${nowInRange ? '' : ' hidden'}
      style="left:${pos(nowMin)}%"><span class="timeline__now-label" data-now-label>${fmtTime(nowMin)}</span></div>`;

  const range = `${fmtTime(dayStart)}–${fmtTime(dayEnd)}`;
  const count = events.length;
  const aria = `Your diary for today, ${range}. ${count ? count + ' booking' + (count === 1 ? '' : 's') : 'No bookings yet'}.`;

  return `<section class="schedule" role="group" aria-label="${esc(aria)}">
    <div class="schedule__head">
      <span class="schedule__title">Today’s schedule</span>
      <span class="schedule__range">${range}</span>
    </div>
    <div class="timeline">
      <div class="timeline__line">
        ${bars}
        ${nowLine}
      </div>
      <div class="timeline__axis">${labels.join('')}</div>
    </div>
  </section>`;
}

function renderToday() {
  const head = `
    <header class="view__head">
      <h1 class="view__title">Today</h1>
      <p class="view__subtitle">
        Your day at a glance. Tap Overdue or Quick wins to review those tasks
        and add the ones you want to today’s plan.
      </p>
    </header>`;

  const quickAdd = quickAddForm();

  if (!state.patients.length && !state.tasks.length) {
    return head + quickAdd + emptyState({
      icon: '📥',
      title: 'Nothing loaded yet',
      text: 'Import your IAPTUS caseload CSV or load demo data to explore the layout.',
      actions: `
        <button class="btn" data-action="load-demo">Load demo data</button>
        <button class="btn btn--primary" data-action="open-import">Import CSV</button>`,
    });
  }

  const todayIso = todayISO();
  const overdue  = activeByScore().filter(isOverdue);
  const dueToday = activeByScore().filter(isDueToday);
  const urgent   = activeByScore().filter((t) => isUrgent(t) && !isOverdue(t) && !isDueToday(t));
  const quick    = activeByScore().filter(isQuickWin);
  const plan     = allocatedToday().sort((a, b) => taskScore(b) - taskScore(a));
  const planMinutes = plan.reduce((n, t) => n + (Number(t.estimatedMinutes) || 0), 0);
  const budget = workdayMinutes();
  const booked = bookedMinutesForDay(todayIso);
  const freeMin = freeMinutesForDay(todayIso);
  // Due-today tasks are auto-merged into the plan; this keeps the few the user
  // deliberately removed from the plan still visible, instead of vanishing.
  const dueUnplanned = dueToday.filter((t) => !plannedToday(t));
  const suggestions = suggestForToday().filter((t) => !plan.some((p) => p.taskId === t.taskId));

  const longWaits = longWaitPatients();
  const cards = `
    <div class="stat-grid stat-grid--compact">
      ${statPill('warning', overdue.length, 'Overdue', 'overdue')}
      ${statPill('accent', dueToday.length, 'Due today', 'today')}
      ${statPill('success', quick.length, 'Quick wins', 'quick')}
      ${statPill('danger', longWaits.length, 'Long waits', 'longwait')}
    </div>`;

  const sections = [];

  // Today’s plan + time budget (always near top, with free time awareness)
  // The bar shows the working day: diary bookings first (blue), then the planned
  // tasks drawn inside whatever free time is left (purple).
  const planPct = budget ? Math.min(100, Math.round((planMinutes / budget) * 100)) : 0;
  const bookedPct = budget ? Math.min(100, Math.round((booked / budget) * 100)) : 0;
  const plannedPct = Math.max(0, Math.min(100 - bookedPct, planPct));
  sections.unshift(sectionPanel("Today’s plan", 'accent', `
    <div class="plan-bar" role="img" aria-label="${hoursLabel(booked)} booked in diary and ${planMinutes} min planned of a ${budget} min working day; ${hoursLabel(freeMin)} free">
      <div class="plan-bar__seg plan-bar__seg--booked" style="width:${bookedPct}%" title="Booked in diary: ${hoursLabel(booked)}"></div>
      <div class="plan-bar__seg plan-bar__seg--planned" style="width:${plannedPct}%" title="Planned tasks: ${planMinutes} min"></div>
    </div>
    <p class="field-row__hint"><span class="plan-key plan-key--planned"></span>${planMinutes} min planned of ${budget} min working day · <span class="plan-key plan-key--booked"></span>${hoursLabel(booked)} booked in diary · ${hoursLabel(freeMin)} free.</p>
    ${plan.length
      ? `<ul class="task-list">${plan.map((t) => taskItem(t, { allocated: true })).join('')}</ul>`
      : '<p class="field-row__hint">Nothing planned yet — due-today tasks are added automatically; otherwise accept a suggestion or pin a task.</p>'}`,
    { id: 'plan', collapsed: isCardCollapsed('plan') }));

  if (dueUnplanned.length) {
    sections.push(sectionPanel('📅 Due today', 'accent',
      `<ul class="task-list">${dueUnplanned.map((t) => taskItem(t, { allocated: plannedToday(t) })).join('')}</ul>`,
      { id: 'due', collapsed: isCardCollapsed('due') }));
  }
  if (urgent.length) {
    sections.push(sectionPanel('🔥 Urgent — long waits / high priority', 'warning',
      `<ul class="task-list">${urgent.map((t) => taskItem(t, { allocated: plannedToday(t) })).join('')}</ul>`,
      { id: 'urgent', collapsed: isCardCollapsed('urgent') }));
  }

  if (suggestions.length) {
    sections.push(sectionPanel('✨ Suggested for today', 'accent', `
      <div class="btn-row" style="margin-bottom:var(--space-3)">
        <button class="btn" data-action="accept-suggestions">Add all suggestions</button>
      </div>
      <ul class="task-list">${suggestions.map((t) => taskItem(t)).join('')}</ul>`,
      { id: 'suggested', collapsed: isCardCollapsed('suggested') }));
  }

  const nothing = !overdue.length && !dueToday.length && !urgent.length && !quick.length && !plan.length;
  const empty = nothing ? '<div class="panel"><p class="field-row__hint">No tasks need attention right now. 🎉</p></div>' : '';

  // A Gantt-style bar of the day's diary bookings, above the plan.
  const timeline = todayTimelineHTML(todayIso);

  return head + quickAdd + cards + timeline + sections.join('') + empty;
}
/* ---- Tasks (spreadsheet) ------------------------------------------ */

const PRIORITY_RANK = { low: 0, medium: 1, high: 2 };

/** Sort value for a task under the given Tasks-table column key. */
function taskSortValue(t, key) {
  switch (key) {
    case 'due': return t.dueDate || '9999-12-31';
    case 'patient': return patientName(t.patientId).toLowerCase();
    case 'priority': return PRIORITY_RANK[t.priority] ?? 1;
    case 'est': return Number(t.estimatedMinutes) || 0;
    case 'dread': return Number(t.dreadScore) || 0;
    case 'title': return (t.title || '').toLowerCase();
    default: return taskScore(t);            // 'score'
  }
}

/** Sort a task list by the current Tasks-view sort key + direction. */
function sortTaskList(list) {
  const cfg = state.settings.tasksView;
  const dir = cfg.dir === 'asc' ? 1 : -1;
  return list.slice().sort((a, b) => {
    const va = taskSortValue(a, cfg.sort);
    const vb = taskSortValue(b, cfg.sort);
    if (va < vb) return -dir;
    if (va > vb) return dir;
    return taskScore(b) - taskScore(a) || (a.title || '').localeCompare(b.title || '');
  });
}

/** Split the (already filtered) task list into table groups. */
function groupTasksForTable(list) {
  const groupBy = state.settings.tasksView.groupBy;
  if (groupBy === 'none') return [{ label: '', tasks: list }];
  if (groupBy === 'due') {
    const today = todayISO();
    return [
      { label: '⏰ Overdue', tasks: list.filter((t) => t.dueDate && t.dueDate < today) },
      { label: '📅 Due today', tasks: list.filter((t) => t.dueDate === today) },
      { label: '🗓 Upcoming', tasks: list.filter((t) => t.dueDate && t.dueDate > today) },
      { label: '📭 No due date', tasks: list.filter((t) => !t.dueDate) },
    ].filter((g) => g.tasks.length);
  }
  // Group by patient — alphabetical, with general (no-patient) tasks last.
  const buckets = new Map();
  state.patients.slice().sort((a, b) => a.name.localeCompare(b.name))
    .forEach((p) => buckets.set(p.patientId, { label: p.name, patient: p, tasks: [] }));
  const general = { label: 'General — no patient', tasks: [] };
  list.forEach((t) => {
    const b = t.patientId ? buckets.get(t.patientId) : null;
    (b || general).tasks.push(t);
  });
  const groups = [...buckets.values()].filter((g) => g.tasks.length);
  if (general.tasks.length) groups.push(general);
  return groups;
}

/** The group header row for the Tasks table. */
function groupRowHTML(g) {
  let sub = '';
  if (g.patient) {
    const days = daysInStageOf(g.patient);
    const breach = days >= (state.settings.waitWarningDays || 42);
    sub = `<span class="group-sub">${esc(g.patient.pathway || 'No pathway')} · ${days} day${days === 1 ? '' : 's'}${breach ? ' · ⚠ breach' : ''}</span>`;
  }
  return `<tr class="group-row"><td colspan="9">
    <span class="group-name">${esc(g.label)}</span>${sub}<span class="group-count">${g.tasks.length}</span>
  </td></tr>`;
}

/** One spreadsheet row for a task. */
function taskTableRow(t) {
  const od = isOverdue(t);
  const allocated = plannedToday(t);
  const p = t.patientId ? state.patients.find((x) => x.patientId === t.patientId) : null;
  const score = Math.round(taskScore(t));
  const prio = t.priority && t.priority !== 'medium'
    ? `<span class="prio prio--${esc(t.priority)}"><span class="prio__dot"></span>${esc(t.priority)}</span>`
    : '<span class="muted">—</span>';
  const allocLabel = allocated ? 'Remove from today' : "Add to today's plan";
  return `<tr class="task-line${od ? ' task-line--overdue' : ''}" data-task="${esc(t.taskId)}">
    <td class="col-check">
      <button class="task-row__check" data-action="toggle-task" data-id="${esc(t.taskId)}"
              aria-label="Mark complete" title="Mark complete"></button>
    </td>
    <td class="col-task"><button type="button" class="task-line__title task-line__title--btn" data-action="edit-task"
              data-id="${esc(t.taskId)}" title="Edit task">${esc(t.title)}</button>${
      allocated ? ' <span class="task-line__pin" title="On today’s plan">📌</span>' : ''}</td>
    <td class="col-patient">${p
      ? `<button class="link-btn" data-action="open-drawer" data-id="${esc(p.patientId)}">${esc(p.name)}</button>`
      : '<span class="muted">General</span>'}</td>
    <td class="col-due${od ? ' due-overdue' : ''}">${esc(dueLabel(t.dueDate))}</td>
    <td class="col-prio">${prio}</td>
    <td class="col-est num">${t.estimatedMinutes ? esc(t.estimatedMinutes) : '<span class="muted">—</span>'}</td>
    <td class="col-dread num">${t.dreadScore ? esc(t.dreadScore) : '<span class="muted">—</span>'}</td>
    <td class="col-score num"><strong>${score}</strong></td>
    <td class="col-actions">
      <button class="btn--icon" data-action="${allocated ? 'unallocate-task' : 'allocate-task'}" data-id="${esc(t.taskId)}"
              aria-label="${allocLabel}" title="${allocLabel}">${icon(allocated ? 'x' : 'pin')}</button>
      <button class="btn--icon" data-action="edit-task" data-id="${esc(t.taskId)}"
              aria-label="Edit task" title="Edit task">${icon('edit')}</button>
      <button class="btn--icon" data-action="delete-task" data-id="${esc(t.taskId)}"
              aria-label="Delete task" title="Delete task">${icon('trash')}</button>
    </td>
  </tr>`;
}

/** Sortable column header for the Tasks table. */
function taskTh(key, label, cls = '') {
  const cfg = state.settings.tasksView;
  const on = cfg.sort === key;
  const arrow = on ? (cfg.dir === 'asc' ? ' ▲' : ' ▼') : '';
  return `<th scope="col" class="${cls}" aria-sort="${on ? (cfg.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">
    <button class="th-sort${on ? ' th-sort--on' : ''}" data-action="sort-tasks" data-key="${key}">${label}${arrow}</button>
  </th>`;
}

function renderTasks() {
  const cfg = state.settings.tasksView;
  const filter = cfg.filter;

  const head = `
    <header class="view__head">
      <h1 class="view__title">Tasks</h1>
      <p class="view__subtitle">
        Every open task in one table, grouped by patient. Click a column
        heading to sort — overdue and high-priority work rises to the top.
      </p>
    </header>`;

  // Inline quick-add (Phase D): type + Enter. Understands simple dates & durations.
  const quickAdd = quickAddForm();

  if (!state.tasks.length) {
    return head + quickAdd + emptyState({
      icon: '✅',
      title: 'No tasks yet',
      text: 'Type in the bar above to add a task, or open a patient from the Caseload to attach one to them.',
    });
  }

  const filters = [
    ['all', 'All'], ['overdue', 'Overdue'], ['today', 'Due today'],
    ['upcoming', 'Upcoming'], ['quick', 'Quick wins'], ['none', 'No date'],
  ];
  const tabs = `<div class="pathway-tabs" role="group" aria-label="Filter tasks">
    ${filters.map(([k, label]) =>
      `<button class="path-tab ${filter === k ? 'path-tab--on' : ''}" data-action="task-filter" data-filter="${k}">${label}</button>`).join('')}
  </div>`;

  const groupSel = `<label class="group-label">Group
    <select data-action="task-group">
      <option value="patient" ${cfg.groupBy === 'patient' ? 'selected' : ''}>Patient</option>
      <option value="due" ${cfg.groupBy === 'due' ? 'selected' : ''}>Due status</option>
      <option value="none" ${cfg.groupBy === 'none' ? 'selected' : ''}>None</option>
    </select>
  </label>`;

  // Filter (All = unfiltered). Completed tasks are always excluded here.
  let list = activeByScore();
  if (filter === 'overdue') list = list.filter(isOverdue);
  else if (filter === 'today') list = list.filter(isDueToday);
  else if (filter === 'upcoming') list = list.filter((t) => t.dueDate && t.dueDate > todayISO());
  else if (filter === 'quick') list = list.filter(isQuickWin);
  else if (filter === 'none') list = list.filter((t) => !t.dueDate);

  const groups = groupTasksForTable(list);
  const tbody = groups.length
    ? groups.map((g) => {
        const headRow = cfg.groupBy === 'none' ? '' : groupRowHTML(g);
        return headRow + sortTaskList(g.tasks).map(taskTableRow).join('');
      }).join('')
    : `<tr><td class="table-empty" colspan="9">Nothing matches this filter. 🎉</td></tr>`;

  const table = `
    <div class="panel table-wrap">
      <table class="data-table task-table">
        <thead>
          <tr>
            <th scope="col" class="col-check" aria-label="Done"></th>
            ${taskTh('title', 'Task', 'col-task')}
            ${taskTh('patient', 'Patient', 'col-patient')}
            ${taskTh('due', 'Due', 'col-due')}
            ${taskTh('priority', 'Priority', 'col-prio')}
            ${taskTh('est', 'Est', 'col-est num')}
            ${taskTh('dread', 'Dread', 'col-dread num')}
            ${taskTh('score', 'Score', 'col-score num')}
            <th scope="col" class="col-actions" aria-label="Actions"></th>
          </tr>
        </thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>`;

  const completed = state.tasks.filter((t) => t.isCompleted).length;
  const openTotal = state.tasks.length - completed;
  const foot = `<p class="field-row__hint" style="margin-top:var(--space-3)">
    ${list.length} of ${openTotal} open task${openTotal === 1 ? '' : 's'} shown${
      completed ? ` · ${completed} completed hidden` : ''}.
  </p>`;

  return head + quickAdd + `<div class="caseload-controls">${tabs}${groupSel}</div>` + table + foot;
}

/* ---- Caseload ------------------------------------------------------ */

/** Fixed colour palette with agreed meanings (Settings-free, ADHD-friendly). */
const CASELOAD_PALETTE = [
  ['', 'No tag'],
  ['#c0342b', 'Red — long wait / urgent'],
  ['#b4690e', 'Amber — caution'],
  ['#2f7d32', 'Green — on track'],
  ['#2a5db0', 'Blue — clinical focus'],
  ['#7c3aed', 'Purple — review soon'],
];

/**
 * A distinct shape per palette colour, so patient tags stay readable without
 * relying on hue alone (red = triangle, amber = square, green = circle,
 * blue = diamond, purple = star; custom colours fall back to a circle).
 */
const TAG_SHAPES = {};
/** Human name for a palette colour (used as the swatch tooltip). */
function paletteTitle(colorTag) {
  const hit = CASELOAD_PALETTE.find(([c]) => c && c.toLowerCase() === String(colorTag || '').toLowerCase());
  return hit ? hit[1] : 'Custom colour';
}
/** Colour patient swatch. Empty string when untagged. */
function tagSwatch(colorTag) {
  if (!colorTag) return '';
  return `<span class="tag" style="--tag:${esc(colorTag)}" title="${esc(paletteTitle(colorTag))}" aria-hidden="true"></span>`;
}

let caseloadMenuId = null;   // patient whose row/card menu is open
let drawerPatientId = null;  // patient whose drawer is open
let expandedPatients = new Set();  // caseload patients whose task list is expanded (all collapsed by default)

/** Number of incomplete tasks bound to a patient. */
function activeCount(patientId) {
  return tasksFor(patientId).filter((t) => !t.isCompleted).length;
}

/** True when the patient carries a CMS status (i.e. belongs in Supervision). */
const hasCmsStatus = (p) => !!p && String(p.cmsStatus || '').trim() !== '';

/** View-prefs slice backing whichever caseload-style view is on screen. */
function caseloadConfig(viewId = currentRouteId()) {
  return viewId === 'supervision' ? state.settings.supervisionView : state.settings.caseloadView;
}

/** The patients a caseload-style view draws from (Supervision is CMS-only). */
function caseloadPatients(viewId = currentRouteId()) {
  return viewId === 'supervision' ? state.patients.filter(hasCmsStatus) : state.patients;
}

/** Copy patients, filtered + sorted per the given view's settings. */
function caseloadList(viewId = currentRouteId()) {
  const cfg = caseloadConfig(viewId);
  const q = (cfg.search || '').toLowerCase();
  const list = caseloadPatients(viewId).filter((p) =>
    (cfg.pathway === 'all' || p.pathway === cfg.pathway) &&
    (!cfg.breachOnly || daysInStageOf(p) >= (Number(state.settings.waitWarningDays) || 42)) &&
    (!q || p.name.toLowerCase().includes(q) || p.patientId.toLowerCase().includes(q))
  );
  const dir = cfg.dir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    let cmp = 0;
    if (cfg.sortKey === 'name') cmp = (a.name || '').localeCompare(b.name || '');
    else if (cfg.sortKey === 'patientId') cmp = String(a.patientId).localeCompare(String(b.patientId));
    else if (cfg.sortKey === 'tasks') cmp = activeCount(a.patientId) - activeCount(b.patientId);
    else if (cfg.sortKey === 'score') cmp = patientScore(a.patientId) - patientScore(b.patientId);
    else cmp = daysInStageOf(a) - daysInStageOf(b); // daysInStage (default)
    return cmp * dir || (a.name || '').localeCompare(b.name || '');
  });
}

/** Group a sorted list by pathway, status or CMS status. */
function groupPatients(list, key) {
  const groups = new Map();
  const label = key === 'status' ? (p) => p.status || 'No status'
    : key === 'cmsStatus' ? (p) => p.cmsStatus || 'No CMS status'
    : (p) => p.pathway || 'No pathway';
  for (const p of list) {
    const g = label(p);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function renderCaseload() { return caseloadViewHTML('caseload'); }
function renderSupervision() { return caseloadViewHTML('supervision'); }

/** Shared shell for the Caseload and Supervision views. */
function caseloadViewHTML(viewId) {
  const cfg = caseloadConfig(viewId);
  const isSupervision = viewId === 'supervision';
  const head = `
    <header class="view__head">
      <h1 class="view__title">${isSupervision ? 'Supervision' : 'Caseload'}</h1>
      <p class="view__subtitle">${isSupervision
        ? 'Only patients carrying a CMS status — every caseload control works here too.'
        : 'Sort, group and colour-code your caseload, and send patients to Supervision.'}</p>
      ${isSupervision ? '' : `<div class="btn-row" style="margin-top:var(--space-3)">
        <button class="btn btn--primary" data-action="open-import">Import CSV</button>
        <button class="btn" data-action="new-patient">＋ Add patient</button>
      </div>`}
    </header>`;

  if (!state.patients.length) {
    return head + emptyState({
      icon: '🧑‍⚕️',
      title: 'No patients yet',
      text: 'Import your IAPTUS caseload CSV, add someone manually, or load demo data to preview the views.',
      actions: `
        <button class="btn" data-action="load-demo">Load demo data</button>
        <button class="btn" data-action="new-patient">＋ Add patient</button>
        <button class="btn btn--primary" data-action="open-import">Import CSV</button>`,
    });
  }

  const pool = caseloadPatients(viewId);

  if (isSupervision && !pool.length) {
    return head + emptyState({
      icon: '🛡️',
      title: 'Nobody in supervision yet',
      text: 'Add a CMS status on a patient (in Caseload → open a patient → Details), or map a CMS column when importing a CSV. Patients with a CMS status show up here.',
      actions: `<button class="btn" data-action="goto-caseload">Go to Caseload</button>`,
    });
  }

  const pathways = [...new Set(pool.map((p) => p.pathway).filter(Boolean))].sort();

  const pathwayTabs = pathways.map((p) => `
    <button class="path-tab ${cfg.pathway === p ? 'path-tab--on' : ''}" data-action="path-tab" data-pathway="${esc(p)}">${esc(p)}</button>`).join('');

  const controls = `
    <div class="caseload-controls">
      <div class="seg" role="group" aria-label="View mode">
        <button class="seg__btn ${cfg.mode === 'table' ? 'seg__btn--on' : ''}" data-action="set-caseload-mode" data-mode="table">Table</button>
        <button class="seg__btn ${cfg.mode === 'cards' ? 'seg__btn--on' : ''}" data-action="set-caseload-mode" data-mode="cards">Cards</button>
      </div>
      <div class="pathway-tabs" role="group" aria-label="Filter by pathway">
        <button class="path-tab ${cfg.pathway === 'all' ? 'path-tab--on' : ''}" data-action="path-tab" data-pathway="all">All</button>
        ${pathwayTabs}
      </div>
      <input class="search" type="search" placeholder="Search name or ID…" aria-label="Search patients"
             data-action="search-caseload" value="${esc(cfg.search || '')}" />
      ${cfg.breachOnly ? `<button class="path-tab path-tab--on" data-action="clear-breach"
          title="Clear the long-wait filter">Long waits ${icon('x')}</button>` : ''}
      ${cfg.mode === 'table' ? `
        <label class="group-label">Group by
          <select data-action="group-caseload">
            <option value="none" ${cfg.groupBy === 'none' ? 'selected' : ''}>None</option>
            <option value="pathway" ${cfg.groupBy === 'pathway' ? 'selected' : ''}>Pathway</option>
            ${isSupervision
              ? `<option value="cmsStatus" ${cfg.groupBy === 'cmsStatus' ? 'selected' : ''}>CMS status</option>`
              : `<option value="status" ${cfg.groupBy === 'status' ? 'selected' : ''}>Status</option>`}
          </select>
        </label>` : ''}
    </div>`;

  return head + controls + `<div id="caseload-body">${caseloadBodyHTML(viewId)}</div>`;
}

/** Render only the table/cards area (used by live search to keep focus). */
function caseloadBodyHTML(viewId = currentRouteId()) {
  const cfg = caseloadConfig(viewId);
  const list = caseloadList(viewId);
  return cfg.mode === 'cards'
    ? renderPatientCards(list, viewId)
    : renderPatientTable(list, cfg, viewId);
}

/**
 * Quick "add to Supervision" toggle shown ahead of the patient ID in the
 * Caseload view only. Patients not yet supervised get CMS status "Awaiting";
 * supervised ones are removed (CMS status cleared), so the button toggles
 * membership of the Supervision view either way.
 */
function addSupervisionBtn(p, viewId) {
  if (viewId !== 'caseload') return '';
  const inSupervision = hasCmsStatus(p);
  const label = inSupervision
    ? `Remove from Supervision (CMS status: ${p.cmsStatus})`
    : 'Add to Supervision (sets CMS status to Awaiting)';
  return `<button class="btn--icon supervision-add${inSupervision ? ' supervision-add--on' : ''}"
          data-action="toggle-supervision" data-id="${esc(p.patientId)}"
          aria-pressed="${inSupervision}" aria-label="${esc(label)}" title="${esc(label)}">${icon('supervision')}</button>`;
}

/* ---- Table view --------------------------------------------------- */
function renderPatientTable(list, cfg, viewId = 'caseload') {
  const showCms = viewId === 'supervision';
  const cols = showCms ? 9 : 8;
  const th = (key, label) => {
    const on = cfg.sortKey === key;
    const arrow = on ? (cfg.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th scope="col" aria-sort="${on ? (cfg.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">
      <button class="th-sort ${on ? 'th-sort--on' : ''}" data-action="sort-caseload" data-key="${key}">
        ${label}${arrow}
      </button>
    </th>`;
  };

  const rowHTML = (p) => {
    const breach = daysInStageOf(p) >= (state.settings.waitWarningDays || 42);
    const menuOpen = caseloadMenuId === p.patientId;
    const menu = menuOpen ? rowMenuHTML(p) : '';
    const tagged = p.colorTag ? ' caseload-row--tagged' : '';
    const style = p.colorTag ? ` style="--row-accent:${esc(p.colorTag)}"` : '';
    return `<tr class="caseload-row${tagged}"${style}>
      <td class="mono"><span class="id-wrap">${addSupervisionBtn(p, viewId)}${tagSwatch(p.colorTag)}<span>${esc(p.patientId)}</span></span></td>
      <td><button class="link-btn" data-action="open-drawer" data-id="${esc(p.patientId)}">${esc(p.name)}</button></td>
      <td>${esc(p.pathway || '—')}</td>
      ${showCms ? `<td>${hasCmsStatus(p) ? esc(p.cmsStatus) : '—'}</td>` : ''}
      <td class="${breach ? 'wait-badge wait-badge--danger' : ''}">${esc(daysInStageOf(p))}${breach ? ' ⚠' : ''}</td>
      <td class="row-tasks">${patientTasksHTML(p)}</td>
      <td class="num">${patientScore(p.patientId) ? Math.round(patientScore(p.patientId)) : '—'}</td>
      <td class="row-actions">
        <button class="btn--icon" data-action="toggle-rownav" data-id="${esc(p.patientId)}" aria-haspopup="menu"
                aria-expanded="${menuOpen}" aria-label="Actions for ${esc(p.name)}">${icon('dots')}</button>
        ${menu}
      </td>
      <td class="row-tail" aria-hidden="true"></td>
    </tr>`;
  };

  let tbody;
  if (cfg.groupBy === 'none') {
    tbody = list.map(rowHTML).join('');
  } else {
    tbody = groupPatients(list, cfg.groupBy).map(([g, items]) => `
      <tr class="group-row"><td colspan="${cols}">${esc(g)} <span class="group-count">${items.length}</span></td></tr>
      ${items.map(rowHTML).join('')}`).join('');
  }

  return `
    <div class="panel table-panel">
      <div class="caseload-table-scroll">
        <table class="data-table">
          <thead><tr>
            ${th('patientId', 'ID')}
            ${th('name', 'Name')}
            <th scope="col">Pathway</th>
            ${showCms ? '<th scope="col">CMS status</th>' : ''}
            ${th('daysInStage', 'Days in stage')}
            ${th('tasks', 'Tasks')}
            ${th('score', 'Priority')}
            <th scope="col" aria-label="Actions"></th>
            <th scope="col" class="col-tail" aria-hidden="true"></th>
          </tr></thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>
      <p class="field-row__hint" style="margin-top:var(--space-3)">
        ${list.length} of ${caseloadPatients(viewId).length} patient${caseloadPatients(viewId).length === 1 ? '' : 's'} shown.
      </p>
    </div>`;
}

/* ---- Card view ---------------------------------------------------- */
function renderPatientCards(list, viewId = 'caseload') {
  if (!list.length) return `<div class="panel"><p class="field-row__hint">No patients match this filter.</p></div>`;
  return `
    <div class="patient-grid">
      ${list.map((p) => {
        const days = daysInStageOf(p);
        const breach = days >= (state.settings.waitWarningDays || 42);
        const overdue = tasksFor(p.patientId).some((t) => !t.isCompleted && t.dueDate && t.dueDate < todayISO());
        const menuOpen = caseloadMenuId === p.patientId;
        const tagged = p.colorTag ? ' patient-card--tagged' : '';
        const style = p.colorTag ? ` style="--tag:${esc(p.colorTag)}"` : '';
        return `<article class="patient-card${tagged} ${breach ? 'patient-card--breach' : ''} ${overdue ? 'patient-card--overdue' : ''}"${style}>
          <div class="patient-card__top">
            ${addSupervisionBtn(p, viewId)}
            ${tagSwatch(p.colorTag)}
            <span class="mono patient-card__id">${esc(p.patientId)}</span>
            <button class="btn--icon" data-action="toggle-rownav" data-id="${esc(p.patientId)}" aria-haspopup="menu"
                    aria-expanded="${menuOpen}" aria-label="Actions for ${esc(p.name)}">${icon('dots')}</button>
          </div>
          <button class="patient-card__name" data-action="open-drawer" data-id="${esc(p.patientId)}">${esc(p.name)}</button>
          <div class="patient-card__chips">
            <span class="chip">${esc(p.pathway || 'No pathway')}</span>
            ${hasCmsStatus(p) ? `<span class="chip" title="CMS status">🛡 ${esc(p.cmsStatus)}</span>` : ''}
            <span class="chip ${breach ? 'chip--danger' : ''}">⏱ ${days} days</span>
            ${patientScore(p.patientId) ? `<span class="chip" title="ADHD priority score">▲ ${Math.round(patientScore(p.patientId))}</span>` : ''}
            ${overdue ? '<span class="chip chip--danger">⚠ overdue</span>' : ''}
          </div>
          ${patientTasksHTML(p)}
          ${menuOpen ? rowMenuHTML(p) : ''}
        </article>`;
      }).join('')}
    </div>`;
}

/* ---- Row / card context menu -------------------------------------- */
function rowMenuHTML(p) {
  const swatches = CASELOAD_PALETTE.map(([c, title]) =>
    `<button class="swatch ${(p.colorTag || '') === c ? 'swatch--on' : ''}" data-action="set-color"
             data-id="${esc(p.patientId)}" data-color="${c}" title="${esc(title)}"
             aria-label="${esc(title)}" style="background:${c || 'var(--surface-3)'}"></button>`).join('');
  return `
    <div class="row-menu" data-menu>
      <div class="row-menu__label">Colour</div>
      <div class="swatches">${swatches}
        <label class="swatch swatch--custom" title="Custom colour">
          <input type="color" data-action="color-custom" data-id="${esc(p.patientId)}"
                 value="${esc(p.colorTag || '#0f766e')}" aria-label="Custom colour" />
        </label>
      </div>
      <div class="row-menu__label">Actions</div>
      <button class="row-menu__item" data-action="send-supervision" data-id="${esc(p.patientId)}">
        ${(p.cmsStatus || '') === 'Awaiting' ? '✓ Awaiting supervision' : 'Send to supervision'}
      </button>
      <button class="row-menu__item" data-action="add-task" data-id="${esc(p.patientId)}">＋ Add task</button>
      <button class="row-menu__item" data-action="open-drawer" data-id="${esc(p.patientId)}">Open details</button>
      <button class="row-menu__item" data-action="edit-patient" data-id="${esc(p.patientId)}">Edit details</button>
      <button class="row-menu__item row-menu__item--danger" data-action="delete-patient" data-id="${esc(p.patientId)}">Delete patient</button>
    </div>`;
}

/** Re-anchor an open row/card menu to the viewport so the scroll containers
 *  around it (the table pane, the caseload body) can't clip it, and clamp it
 *  so it stays on screen. */
function placeCaseloadMenu() {
  const menu = document.querySelector('.row-menu');
  if (!menu) return;
  const anchor = menu.parentElement && menu.parentElement.querySelector('[data-action="toggle-rownav"]');
  if (!anchor) return;
  const gap = 4, pad = 8;
  const a = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const maxLeft = Math.max(pad, window.innerWidth - mw - pad);
  const left = Math.min(Math.max(pad, a.right - mw), maxLeft);
  let top = a.bottom + gap;
  if (top + mh > window.innerHeight - pad) top = a.top - gap - mh;   // flip above when it won't fit below
  top = Math.min(Math.max(pad, top), Math.max(pad, window.innerHeight - mh - pad));
  menu.style.position = 'fixed';
  menu.style.right = 'auto';
  menu.style.left = Math.round(left) + 'px';
  menu.style.top = Math.round(top) + 'px';
}

/** Close the caseload menu without a full re-render (used once its row scrolls
 *  out of the pane, or when the pane/window is resized). */
function closeCaseloadMenu() {
  caseloadMenuId = null;
  const menu = document.querySelector('.row-menu');
  if (menu) menu.remove();
  const btn = document.querySelector('[data-action="toggle-rownav"][aria-expanded="true"]');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

/** Follow the anchor while its scroll container moves; close once the row it
 *  belongs to has scrolled out of the pane. */
function refreshCaseloadMenu() {
  const menu = document.querySelector('.row-menu');
  const anchor = menu && menu.parentElement && menu.parentElement.querySelector('[data-action="toggle-rownav"]');
  if (!menu || !anchor) return;
  const a = anchor.getBoundingClientRect();
  const pane = menu.closest('.caseload-table-scroll');
  if (pane) {
    const p = pane.getBoundingClientRect();
    if (a.bottom < p.top || a.top > p.bottom) return closeCaseloadMenu();
  }
  if (a.bottom < 0 || a.top > window.innerHeight) return closeCaseloadMenu();
  placeCaseloadMenu();
}

/* ---- Patient drawer ----------------------------------------------- */
let drawerLastFocused = null;   // trigger to focus after the drawer closes

function openDrawer(patientId) {
  const root = $('#drawer-root');
  if (!root.classList.contains('open')) drawerLastFocused = document.activeElement;
  drawerPatientId = patientId;
  renderDrawer();
  root.classList.add('open');
  root.setAttribute('aria-hidden', 'false');
  const first = root.querySelector('.drawer button, .drawer [href], .drawer input, .drawer select, .drawer textarea');
  if (first) first.focus();
}

function closeDrawer() {
  const root = $('#drawer-root');
  root.classList.remove('open');
  root.setAttribute('aria-hidden', 'true');
  const content = $('#drawer-content');
  if (content) content.innerHTML = '';   // no focusable nodes while hidden
  drawerPatientId = null;
  if (drawerLastFocused && document.contains(drawerLastFocused)) drawerLastFocused.focus();
  drawerLastFocused = null;
}

/** The task list markup for a patient's drawer. Pass `editable` to make each
    task's text open the task editor (used by the Caseload task lists). */
function drawerTasksHTML(p, { editable = false } = {}) {
  const tasks = tasksFor(p.patientId);
  return tasks.length
    ? `<ul class="task-list">${tasks.map((t) => {
        const strike = t.isCompleted ? ' task-row__title--strike' : '';
        const title = editable
          ? `<button class="task-row__title task-row__title--btn${strike}" data-action="edit-task"
                     data-id="${esc(t.taskId)}" title="Edit task">${esc(t.title)}</button>`
          : `<span class="task-row__title${strike}">${esc(t.title)}</span>`;
        return `
        <li class="task-row ${t.isCompleted ? 'task-row--done' : ''}">
          <button class="task-row__check" data-action="toggle-task" data-id="${esc(t.taskId)}"
                  aria-label="Mark ${t.isCompleted ? 'incomplete' : 'complete'}">${t.isCompleted ? '✓' : ''}</button>
          ${title}
          <span class="task-row__meta">${esc(dueLabel(t.dueDate))}</span>
          <button class="btn--icon" data-action="delete-task" data-id="${esc(t.taskId)}"
                  aria-label="Delete task" title="Delete task">${icon('trash')}</button>
        </li>`;
      }).join('')}</ul>`
    : '<p class="field-row__hint">No tasks yet — add one below.</p>';
}

/** Keep the open drawer's task list in sync after task changes (notes untouched). */
function syncDrawerTasks() {
  const host = $('#drawer-tasks');
  if (!host || !drawerPatientId) return;
  const p = state.patients.find((x) => x.patientId === drawerPatientId);
  if (p) host.innerHTML = drawerTasksHTML(p);
}

/** Collapsible per-patient task list used in the Caseload table and cards. */
function patientTasksHTML(p) {
  const tasks = tasksFor(p.patientId);
  const active = tasks.filter((t) => !t.isCompleted).length;
  const open = expandedPatients.has(p.patientId);
  const label = !tasks.length ? 'No tasks'
    : active ? `${active} active task${active === 1 ? '' : 's'}`
    : 'No active tasks';
  return `
    <div class="ptasks ${open ? 'ptasks--open' : ''}">
      <button class="ptasks__toggle" data-action="toggle-patient-tasks" data-id="${esc(p.patientId)}"
              aria-expanded="${open}" title="${open ? 'Minimise tasks' : 'Show tasks'}">
        <span class="ptasks__caret" aria-hidden="true">${open ? '▾' : '▸'}</span>
        <span>${label}</span>
      </button>
      ${open ? `<div class="ptasks__list">
        ${drawerTasksHTML(p, { editable: true })}
        <button class="ptasks__add" data-action="add-task" data-id="${esc(p.patientId)}">＋ Add task</button>
      </div>` : ''}
    </div>`;
}

function renderDrawer() {
  const p = state.patients.find((x) => x.patientId === drawerPatientId);
  if (!p) { closeDrawer(); return; }
  const days = daysInStageOf(p);
  const breach = days >= (state.settings.waitWarningDays || 42);
  const taskList = `<div id="drawer-tasks">${drawerTasksHTML(p)}</div>`;
  // Suggestions for the free-text fields, drawn from what's already in use.
  const pathways = [...new Set(state.patients.map((x) => x.pathway).filter(Boolean))].sort();
  const statuses = [...new Set(state.patients.map((x) => x.status).filter(Boolean))].sort();
  const cmsValues = [...new Set(state.patients.map((x) => x.cmsStatus).filter(Boolean))].sort();
  const paletteOpts = CASELOAD_PALETTE.map(([c, title]) =>
    `<option value="${esc(c)}" ${(p.colorTag || '') === c ? 'selected' : ''}>${esc(title)}</option>`).join('');

  $('#drawer-content').innerHTML = `
    <div class="drawer__head${p.colorTag ? ' drawer__head--tagged' : ''}"${p.colorTag ? ` style="--tag:${esc(p.colorTag)}"` : ''}>
      <div class="drawer__head-row">
        <h2 class="drawer__title"><span class="tag-wrap">${tagSwatch(p.colorTag)}${esc(p.name)}</span></h2>
        <button class="btn--icon" data-action="close-drawer" aria-label="Close">${icon('x')}</button>
      </div>
      <div class="patient-card__chips">
        <span class="chip">${esc(p.pathway || 'No pathway')}</span>
        <span class="chip ${breach ? 'chip--danger' : ''}">⏱ ${days} days in stage</span>
        <span class="chip">${esc(p.status || '—')}</span>
        ${hasCmsStatus(p) ? `<span class="chip" title="CMS status">🛡 ${esc(p.cmsStatus)}</span>` : ''}
      </div>
    </div>

    <div class="drawer__section">
      <h3 class="panel__title">Details <span class="field-row__hint">(edit any value, then save)</span></h3>
      <div class="task-form">
        <label>Name *
          <input id="drawer-name" type="text" maxlength="120" autocomplete="off" value="${esc(p.name || '')}" />
        </label>
        <div class="task-form__grid">
          <label>Pathway
            <input id="drawer-pathway" type="text" list="drawer-pathway-options" autocomplete="off"
                   placeholder="e.g. Treatment" value="${esc(p.pathway || '')}" />
            <datalist id="drawer-pathway-options">${pathways.map((x) => `<option value="${esc(x)}"></option>`).join('')}</datalist>
          </label>
          <label>Status
            <input id="drawer-status" type="text" list="drawer-status-options" autocomplete="off"
                   placeholder="e.g. Active" value="${esc(p.status || '')}" />
            <datalist id="drawer-status-options">${statuses.map((x) => `<option value="${esc(x)}"></option>`).join('')}</datalist>
          </label>
          <label>CMS status
            <input id="drawer-cms" type="text" list="drawer-cms-options" autocomplete="off"
                   placeholder="e.g. In supervision" value="${esc(p.cmsStatus || '')}"
                   title="Shows the patient in the Supervision view" />
            <datalist id="drawer-cms-options">${cmsValues.map((x) => `<option value="${esc(x)}"></option>`).join('')}</datalist>
          </label>
          <label>Days in stage
            <input id="drawer-days" type="number" min="0" step="1" value="${days}"
                   title="Counts up by one automatically each day since it was last set" />
          </label>
          <label>Colour tag
            <select id="drawer-color">${paletteOpts}</select>
          </label>
          <label>Patient ID
            <input id="drawer-pid" type="text" readonly title="The ID can't be changed — linked tasks keep using it."
                   value="${esc(p.patientId)}" />
          </label>
        </div>
      </div>
      <div class="btn-row" style="margin-top:var(--space-3)">
        <button class="btn btn--primary" data-action="drawer-save-details" data-id="${esc(p.patientId)}">Save details</button>
      </div>
    </div>

    <div class="drawer__section">
      <h3 class="panel__title">Working notes <span class="field-row__hint">(stays local, not an EPR)</span></h3>
      <textarea id="drawer-notes" class="notes-input" rows="3"
        placeholder="Brief notes…">${esc(p.notes || '')}</textarea>
      <div class="btn-row" style="margin-top:var(--space-2)">
        <button class="btn btn--primary" data-action="drawer-save-notes">Save notes</button>
      </div>
    </div>

    <div class="drawer__section">
      <div class="drawer__section-head">
        <h3 class="panel__title">Tasks</h3>
        <button class="btn" data-action="add-task" data-id="${esc(p.patientId)}">＋ Add task</button>
      </div>
      ${taskList}
    </div>

    <div class="drawer__section">
      <div class="btn-row">
        <button class="btn" data-action="send-supervision" data-id="${esc(p.patientId)}">
          ${(p.cmsStatus || '') === 'Awaiting' ? '✓ Awaiting supervision' : 'Send to supervision'}
        </button>
        <button class="btn btn--danger" data-action="delete-patient" data-id="${esc(p.patientId)}">Delete patient</button>
      </div>
    </div>`;
}

/**
 * Update the "send to supervision" affordances in an open drawer without a
 * full re-render, so any unsaved edits in the form are preserved.
 */
function refreshDrawerSupervision(p) {
  const awaiting = (p.cmsStatus || '') === 'Awaiting';
  const btn = document.querySelector('.drawer [data-action="send-supervision"]');
  if (btn) btn.textContent = awaiting ? '✓ Awaiting supervision' : 'Send to supervision';
  const input = document.querySelector('#drawer-cms');
  if (input) input.value = p.cmsStatus || '';
  const chips = document.querySelector('.drawer__head .patient-card__chips');
  if (chips) {
    const chip = chips.querySelector('.chip[title="CMS status"]');
    if (p.cmsStatus) {
      const html = `<span class="chip" title="CMS status">🛡 ${esc(p.cmsStatus)}</span>`;
      if (chip) chip.outerHTML = html;
      else chips.insertAdjacentHTML('beforeend', html);
    } else if (chip) {
      chip.remove();
    }
  }
}

/* ---- Task create / edit modal ------------------------------------- */
let taskModalPatientId = null;
let taskModalTaskId = null;   // when editing an existing task

/* ---- Patient create / edit modal ---------------------------------- */
let patientModalId = null;    // patientId when editing, null when adding

/**
 * Open the task modal. Pass a patientId to bind a new task to a patient, or a
 * taskId to edit an existing task.
 */
function openTaskModal(patientId, taskId = null) {
  const existing = taskId ? state.tasks.find((t) => t.taskId === taskId) : null;
  taskModalTaskId = existing ? existing.taskId : null;
  taskModalPatientId = existing ? existing.patientId : (patientId || null);

  const v = existing || {
    title: '', dueDate: todayISO(), priority: 'medium',
    estimatedMinutes: 15, dreadScore: 2, allocatedDate: null,
  };

  const title = existing ? 'Edit task' : 'New task';
  const est = Number(v.estimatedMinutes) || 15;
  const estOpts = [5, 15, 30, 60, 120];
  const patientOpts = [
    '<option value="">General — no patient</option>',
    ...state.patients.slice().sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => `<option value="${esc(p.patientId)}" ${taskModalPatientId === p.patientId ? 'selected' : ''}>${esc(p.name)}</option>`),
  ].join('');

  openModal({
    title,
    body: `
      <p class="modal__hint">Capture a task in seconds. Pick the patient first, then what needs doing.</p>
      <div class="task-form">
        <label>Task *
          <input id="task-title" type="text" maxlength="120" placeholder="e.g. Send outcome measures"
                 autocomplete="off" value="${esc(v.title || '')}" />
        </label>
        <div class="task-form__grid">
          <label>Patient
            <select id="task-patient">${patientOpts}</select>
          </label>
          <label>Due date
            <input id="task-due" type="date" value="${esc(v.dueDate || '')}" />
          </label>
          <label>Priority
            <select id="task-priority">
              ${[['low','Low'],['medium','Medium'],['high','High']].map(([val, lab]) =>
                `<option value="${val}" ${v.priority === val ? 'selected' : ''}>${lab}</option>`).join('')}
            </select>
          </label>
          <label>Est. time
            <select id="task-est">
              ${estOpts.map((m) => `<option value="${m}" ${est === m ? 'selected' : ''}>${m < 60 ? m + ' min' : (m / 60) + ' hour' + (m > 60 ? 's' : '')}</option>`).join('')}
            </select>
          </label>
          <label>Dread score (1–5)
            <select id="task-dread" title="How much you dread this — feeds the ADHD priority score">
              ${[1,2,3,4,5].map((n) => `<option value="${n}" ${Number(v.dreadScore) === n ? 'selected' : ''}>${n}${['',' — easy',' — fine',' — meh',' — ugh',' — horrible'][n]}</option>`).join('')}
            </select>
          </label>
        </div>
        <label class="task-form__check">
          <input id="task-plan" type="checkbox" ${v.allocatedDate === todayISO() ? 'checked' : ''} />
          Add to today's plan
        </label>
        <p class="field-row__hint">
          Waiting time, due date, estimated time and dread score all raise the ADHD
          priority score — tune their weight in Settings.
        </p>
      </div>`,
    actions: [
      { label: 'Cancel', onClick: closeModal },
      { label: existing ? 'Save changes' : 'Create task', variant: 'primary', onClick: submitTask },
    ],
  });
  const titleEl = $('#task-title');
  if (titleEl) { titleEl.focus(); titleEl.select(); }
}

/* ---- Quick add (Phase D) ------------------------------------------- */

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Parse a natural-language quick-add string.
 * Returns { title, dueDate, estimatedMinutes }.
 * Supports: today, tomorrow, "next week", "in N days/weeks", weekday names,
 * and durations like "30m" / "1h" / "45 min".
 */
function parseQuickTask(raw) {
  let text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return { title: '', dueDate: null, estimatedMinutes: null };
  const base = new Date(todayISO() + 'T00:00:00');
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const strip = (re) => { text = text.replace(re, ' ').replace(/\s+/g, ' ').trim(); };
  let dueDate = null;
  let estimatedMinutes = null;

  // Duration: "30m", "1h", "45 min", "for 2 hours", "~15m"
  let m = text.match(/\b(?:for\s+|~)?(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i);
  if (m) {
    const n = Number(m[1]);
    estimatedMinutes = /^h/i.test(m[2]) ? n * 60 : n;
    strip(new RegExp('\\b(?:for\\s+|~)?' + m[1] + '\\s*' + m[2] + '\\b', 'i'));
  }

  // Relative: "in N days / weeks"
  m = text.match(/\bin\s+(\d+)\s+(days?|weeks?)\b/i);
  if (m) {
    const n = Number(m[1]) * (/^week/i.test(m[2]) ? 7 : 1);
    const d = new Date(base); d.setDate(d.getDate() + n); dueDate = iso(d);
    strip(/\bin\s+\d+\s+(?:days?|weeks?)\b/i);
  }

  if (!dueDate) {
    let low = text.toLowerCase();
    if (/\btomorrow\b|\btom\b/.test(low)) {
      const d = new Date(base); d.setDate(d.getDate() + 1); dueDate = iso(d);
      strip(/\b(?:tomorrow|tom)\b/i);
    } else if (/\btoday\b/.test(low)) {
      dueDate = todayISO();
      strip(/\btoday\b/i);
    } else if (/\bnext\s+week\b/.test(low)) {
      const d = new Date(base); d.setDate(d.getDate() + 7); dueDate = iso(d);
      strip(/\bnext\s+week\b/i);
    } else {
      low = text.toLowerCase();
      const wd = low.match(/\b(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|wed|thurs|thur|thu|fri|sat)\b/);
      if (wd) {
        const key = wd[2].slice(0, 3);
        const target = WEEKDAY_NAMES.findIndex((w) => w.slice(0, 3) === key);
        if (target >= 0) {
          let diff = (target - base.getDay() + 7) % 7;
          if (diff === 0) diff = 7;
          if (wd[1]) diff += 7;                     // "next monday" → the one after
          const d = new Date(base); d.setDate(d.getDate() + diff); dueDate = iso(d);
          strip(new RegExp('\\b(?:next\\s+)?' + wd[2] + '\\b', 'i'));
        }
      }
    }
  }

  return { title: text.trim(), dueDate, estimatedMinutes };
}

/** Create a general (no-patient) task from the quick-add input. */
function createQuickTask(raw) {
  const source = raw != null ? raw : (($('#quick-add-input') || {}).value || '');
  if (!String(source).trim()) return false;
  const parsed = parseQuickTask(source);
  if (!parsed.title) { toast('Type something to add.', 'error'); return false; }
  state.tasks.push({
    taskId: uuid(),
    title: parsed.title,
    patientId: null,
    dueDate: parsed.dueDate,
    priority: 'medium',
    estimatedMinutes: parsed.estimatedMinutes || 15,
    dreadScore: 3,
    isCompleted: false,
    completedAt: null,
    // Due-today tasks auto-join today's plan (mirrors autoPlanDueToday).
    allocatedDate: parsed.dueDate === todayISO() ? todayISO() : null,
  });
  const bits = [parsed.title];
  if (parsed.dueDate) bits.push(dueLabel(parsed.dueDate));
  toast(`Added “${bits.join(' · ')}”.`, 'success');
  save();
  return true;
}

function submitTask() {
  const title = ($('#task-title') || {}).value || '';
  if (!title.trim()) { toast('Give the task a title.', 'error'); return; }
  const allocated = !!($('#task-plan') || {}).checked;
  const fields = {
    title: title.trim(),
    patientId: ($('#task-patient') || {}).value || null,
    dueDate: ($('#task-due') || {}).value || null,
    priority: ($('#task-priority') || {}).value || 'medium',
    estimatedMinutes: Number(($('#task-est') || {}).value) || 15,
    dreadScore: Number(($('#task-dread') || {}).value) || 3,
  };

  if (taskModalTaskId) {
    const t = state.tasks.find((x) => x.taskId === taskModalTaskId);
    if (t) {
      Object.assign(t, fields);
      // Respect the checkbox on edit — don't fight an explicit remove from plan.
      t.allocatedDate = allocated ? todayISO() : null;
      toast('Task updated.');
    }
  } else {
    state.tasks.push({
      taskId: uuid(),
      ...fields,
      isCompleted: false,
      completedAt: null,
      // New due-today tasks auto-join the plan (mirrors autoPlanDueToday).
      allocatedDate: (allocated || fields.dueDate === todayISO()) ? todayISO() : null,
    });
    toast('Task added.');
  }
  closeModal();
  save();
}

/* ---- Patient add / edit / delete ---------------------------------- */

/** A friendly, unique patient ID for manually-added patients. */
function suggestedPatientId() {
  for (let n = 1; n < 100000; n++) {
    const id = `LOCAL-${String(n).padStart(4, '0')}`;
    if (!state.patients.some((p) => p.patientId === id)) return id;
  }
  return `LOCAL-${uuid().slice(0, 8)}`;
}

/**
 * Open the patient modal. Pass a patientId to edit, or nothing to add.
 * Adding is how you enter patients without an IAPTUS CSV export.
 */
function openPatientModal(patientId = null) {
  const existing = patientId ? state.patients.find((p) => p.patientId === patientId) : null;
  patientModalId = existing ? existing.patientId : null;

  const pathways = [...new Set(state.patients.map((p) => p.pathway).filter(Boolean))].sort();
  const statuses = [...new Set(state.patients.map((p) => p.status).filter(Boolean))].sort();
  const cmsValues = [...new Set(state.patients.map((p) => p.cmsStatus).filter(Boolean))].sort();
  const currentColor = existing ? (existing.colorTag || '') : '';
  const paletteOpts = CASELOAD_PALETTE.map(([c, title]) =>
    `<option value="${esc(c)}" ${currentColor === c ? 'selected' : ''}>${esc(title)}</option>`).join('');

  const v = existing || {
    name: '', patientId: suggestedPatientId(), pathway: '', daysInStage: 0, status: '', cmsStatus: '', colorTag: '',
  };

  openModal({
    title: existing ? 'Edit patient' : 'New patient',
    body: `
      <p class="modal__hint">${existing
        ? 'Update this patient’s details. Their ID stays fixed so linked tasks keep working.'
        : 'Add someone to your caseload manually — only the name is required.'}</p>
      <div class="task-form">
        <label>Name *
          <input id="patient-name" type="text" maxlength="120" placeholder="e.g. Alex Morgan"
                 autocomplete="off" value="${esc(v.name || '')}" />
        </label>
        <div class="task-form__grid">
          <label>Patient ID
            <input id="patient-id" type="text" maxlength="60" placeholder="e.g. IAP-1234"
                   ${existing ? 'readonly title="Patient ID cannot be changed after adding"' : ''}
                   value="${esc(v.patientId || '')}" />
          </label>
          <label>Pathway
            <input id="patient-pathway" type="text" list="patient-pathway-options" placeholder="e.g. Treatment"
                   autocomplete="off" value="${esc(v.pathway || '')}" />
            <datalist id="patient-pathway-options">${pathways.map((p) => `<option value="${esc(p)}"></option>`).join('')}</datalist>
          </label>
          <label>Status
            <input id="patient-status" type="text" list="patient-status-options" placeholder="e.g. Active"
                   autocomplete="off" value="${esc(v.status || '')}" />
            <datalist id="patient-status-options">${statuses.map((s) => `<option value="${esc(s)}"></option>`).join('')}</datalist>
          </label>
          <label>CMS status
            <input id="patient-cms" type="text" list="patient-cms-options" placeholder="e.g. In supervision"
                   autocomplete="off" value="${esc(v.cmsStatus || '')}"
                   title="Shows the patient in the Supervision view" />
            <datalist id="patient-cms-options">${cmsValues.map((s) => `<option value="${esc(s)}"></option>`).join('')}</datalist>
          </label>
          <label>Days in stage
            <input id="patient-days" type="number" min="0" step="1" value="${daysInStageOf(v)}"
                   title="Counts up by one automatically each day since it was last set" />
          </label>
          <label>Colour tag
            <select id="patient-color">${paletteOpts}</select>
          </label>
        </div>
      </div>`,
    actions: [
      { label: 'Cancel', onClick: closeModal },
      { label: existing ? 'Save changes' : 'Add patient', variant: 'primary', onClick: submitPatient },
    ],
  });
  const nameEl = $('#patient-name');
  if (nameEl) nameEl.focus();
}

function submitPatient() {
  const name = (($('#patient-name') || {}).value || '').trim();
  if (!name) { toast('Give the patient a name.', 'error'); return; }
  const pathway = (($('#patient-pathway') || {}).value || '').trim();
  const status = (($('#patient-status') || {}).value || '').trim();
  const cmsStatus = (($('#patient-cms') || {}).value || '').trim();
  const daysInStage = Math.max(0, Number(($('#patient-days') || {}).value) || 0);
  const colorTag = (($('#patient-color') || {}).value) || null;
  const now = new Date().toISOString();

  if (patientModalId) {
    const p = state.patients.find((x) => x.patientId === patientModalId);
    if (p) {
      p.name = name;
      p.pathway = pathway;
      p.status = status;
      p.cmsStatus = cmsStatus;
      p.daysInStage = daysInStage;
      p.daysInStageAsOf = todayISO();
      p.colorTag = colorTag;
      p.updatedAt = now;
      toast('Patient updated.');
    }
  } else {
    let pid = (($('#patient-id') || {}).value || '').trim() || suggestedPatientId();
    if (state.patients.some((x) => x.patientId === pid)) {
      toast('That patient ID is already in use.', 'error');
      return;
    }
    state.patients.push({
      patientId: pid, name, pathway, daysInStage, status, cmsStatus,
      colorTag, notes: '', updatedAt: now,
      daysInStageAsOf: todayISO(),
    });
    toast('Patient added.', 'success');
  }
  const editedId = patientModalId;
  const pendingNotes = ($('#drawer-notes') || {}).value;   // preserve unsaved drawer notes
  closeModal();
  save();
  // If editing the patient whose drawer is open, refresh the whole drawer header.
  if (editedId && drawerPatientId === editedId) {
    renderDrawer();
    const notesEl = $('#drawer-notes');
    if (notesEl && pendingNotes != null) notesEl.value = pendingNotes;
  }
}

/** Confirm, then delete a patient along with their tasks. */
function confirmDeletePatient(patientId) {
  const p = state.patients.find((x) => x.patientId === patientId);
  if (!p) return;
  const taskCount = state.tasks.filter((t) => t.patientId === patientId).length;
  const eventCount = state.diary.filter((e) => e.patientId === patientId).length;
  openModal({
    title: `Delete ${p.name}?`,
    body: `<p>This removes <strong>${esc(p.name)}</strong> and their ${taskCount}
        task${taskCount === 1 ? '' : 's'} from this device.${eventCount
        ? ` Their ${eventCount} diary entr${eventCount === 1 ? 'y' : 'ies'} will be kept but no longer linked to them.`
        : ''} This can’t be undone — export a backup first if you’re unsure.</p>`,
    actions: [
      { label: 'Cancel', onClick: closeModal },
      { label: 'Delete patient', variant: 'danger', onClick: () => deletePatient(patientId) },
    ],
  });
}

async function deletePatient(patientId) {
  const p = state.patients.find((x) => x.patientId === patientId);
  if (!p) return;
  state.patients = state.patients.filter((x) => x.patientId !== patientId);
  state.tasks = state.tasks.filter((t) => t.patientId !== patientId);
  // Keep diary events (they are a record of worked hours) but unbind them.
  state.diary.forEach((e) => { if (e.patientId === patientId) e.patientId = null; });
  caseloadMenuId = null;
  if (drawerPatientId === patientId) { patientModalId = null; closeDrawer(); }
  closeModal();
  await save();
  toast(`${p.name} deleted.`, 'success');
}

/* ---- Diary & hours ------------------------------------------------- */
const CATEGORIES = [
  { id: 'clinical',     label: 'Clinical',     tone: 'accent' },
  { id: 'admin',        label: 'Admin',        tone: 'warning' },
  { id: 'non-clinical', label: 'Non-clinical', tone: 'success' },
];

/** "HH:MM" → minutes since midnight. */
function minutesOf(hhmm) {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
/** minutes since midnight → "HH:MM". */
function fmtTime(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
const eventMinutes = (e) => Math.max(0, minutesOf(e.endTime) - minutesOf(e.startTime));
const categoryLabel = (id) => (CATEGORIES.find((c) => c.id === id) || {}).label || id;

/** Sum event durations (minutes) by category, plus a grand total. */
function hoursByCategory(events) {
  const totals = { clinical: 0, admin: 0, 'non-clinical': 0, total: 0 };
  events.forEach((e) => {
    const m = eventMinutes(e);
    if (totals[e.category] != null) totals[e.category] += m;
    totals.total += m;
  });
  return totals;
}
/** Minutes → "1.5h" / "2h". */
const hoursLabel = (min) => `${(min / 60).toFixed(min % 60 === 0 ? 0 : 1)}h`;
/** Does a (possibly recurring) event have an occurrence on `iso`? */
function occursOn(e, iso) {
  const r = e.recurrence;
  if (!r || !r.freq || r.freq === 'none') return e.date === iso;
  if (r.exdates && r.exdates.includes(iso)) return false;   // this occurrence was removed
  if (iso < e.date) return false;
  if (iso === e.date) return true;                    // the anchor date always occurs
  if (r.until && iso > r.until) return false;
  const start = new Date(e.date + 'T00:00:00');
  const d = new Date(iso + 'T00:00:00');
  const dayDiff = Math.round((d - start) / 86400000);
  if (dayDiff > 3660) return false;                   // safety cap (~10 years)
  const step = Math.max(1, Number(r.interval) || 1);
  if (r.freq === 'daily') return dayDiff % step === 0;
  if (r.freq === 'weekly') {
    if (Math.floor(dayDiff / 7) % step !== 0) return false;
    const wds = (r.weekdays && r.weekdays.length) ? r.weekdays : [start.getDay()];
    return wds.includes(d.getDay());
  }
  if (r.freq === 'monthly') {
    const months = (d.getFullYear() - start.getFullYear()) * 12 + (d.getMonth() - start.getMonth());
    if (months % step !== 0) return false;
    const lastOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return d.getDate() === Math.min(start.getDate(), lastOfMonth);
  }
  return false;
}

/** True when an event is a repeating series (not a one-off). */
const isRecurring = (e) => !!(e.recurrence && e.recurrence.freq && e.recurrence.freq !== 'none');

/** Events occurring on a given day, with recurring rules expanded. */
const eventsOn = (iso) => state.diary
  .filter((e) => occursOn(e, iso))
  .map((e) => (e.date === iso ? e : { ...e, date: iso }));

/** Events occurring across an inclusive ISO date range (recurring expanded). */
function eventsInRange(startIso, endIso) {
  const out = [];
  for (let d = startIso; d <= endIso; d = addDays(d, 1)) out.push(...eventsOn(d));
  return out;
}
function bookedMinutesForDay(iso) {
  return eventsOn(iso).reduce((n, e) => n + eventMinutes(e), 0);
}

function freeMinutesForDay(iso) {
  const budget = workdayMinutes();
  const booked = bookedMinutesForDay(iso);
  const free = budget - booked;
  return free < 0 ? 0 : free;
}

/** Monday-based start of the week containing `iso`. */
function startOfWeekISO(iso) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return todayISO(d);
}
function weekEvents(iso) {
  const start = startOfWeekISO(iso);
  return eventsInRange(start, addDays(start, 6));
}

/** Add N months to an ISO date, clamping the day to the month's length. */
function addMonths(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return todayISO(d);
}

/** Move the diary anchor by one unit of the active view (day / week / month). */
function shiftDiary(dir) {
  const view = state.settings.diaryView || 'day';
  const base = state.settings.diaryDate || todayISO();
  if (view === 'week') state.settings.diaryDate = addDays(base, dir * 7);
  else if (view === 'month') state.settings.diaryDate = addMonths(base, dir);
  else state.settings.diaryDate = addDays(base, dir);
}

/** Small stacked category bar (month grid cells). */
function stackedSegs(totals) {
  return CATEGORIES.map((c) => {
    const pct = totals.total ? (totals[c.id] / totals.total) * 100 : 0;
    return pct > 0 ? `<span class="hours-bar__seg hours-bar__seg--${c.id}" style="width:${pct}%"></span>` : '';
  }).join('');
}

/** Minutes since midnight, right now. */
function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * What's happening now / up next on `iso`.
 * `status`: 'current' | 'next' | 'none'; `minutes` is left (current) or until start (next).
 */
function nextUpInfo(iso) {
  if (iso !== todayISO()) return { status: 'none' };
  const now = nowMinutes();
  const evs = eventsOn(iso).slice().sort((a, b) => minutesOf(a.startTime) - minutesOf(b.startTime));
  const current = evs.find((e) => minutesOf(e.startTime) <= now && now < minutesOf(e.endTime));
  if (current) return { status: 'current', event: current, minutes: minutesOf(current.endTime) - now };
  const next = evs.find((e) => minutesOf(e.startTime) > now);
  if (next) return { status: 'next', event: next, minutes: minutesOf(next.startTime) - now };
  return { status: 'none' };
}

/** Live "happening now / up next" side card for today's diary. */
function nextUpCard(iso) {
  const info = nextUpInfo(iso);
  if (info.status === 'current') {
    const e = info.event;
    return `<div class="panel panel--accent" id="diary-next">
      <h2 class="panel__title">▶ Happening now</h2>
      <p class="next-up__title">${esc(e.title)}</p>
      <p class="field-row__hint">${fmtTime(minutesOf(e.startTime))}–${fmtTime(minutesOf(e.endTime))} · ${esc(categoryLabel(e.category))} · ${info.minutes} min left</p>
    </div>`;
  }
  if (info.status === 'next') {
    const e = info.event;
    return `<div class="panel" id="diary-next">
      <h2 class="panel__title">⏭ Up next</h2>
      <p class="next-up__title">${esc(e.title)}</p>
      <p class="field-row__hint">${fmtTime(minutesOf(e.startTime))}–${fmtTime(minutesOf(e.endTime))} · in ${info.minutes} min</p>
    </div>`;
  }
  return `<div class="panel" id="diary-next">
    <h2 class="panel__title">⏭ Up next</h2>
    <p class="field-row__hint">Nothing else scheduled. Space to breathe. 🌿</p>
  </div>`;
}

/** Reposition the live "now" lines and refresh the up-next card. */
let lastTickDate = todayISO();

function tickDiaryClocks() {
  // If the clock has rolled past midnight, refresh the view so day-based
  // figures (days in stage, due dates, "today" markers) update in place.
  const today = todayISO();
  if (today !== lastTickDate) {
    lastTickDate = today;
    renderView();
  }
  const now = nowMinutes();
  document.querySelectorAll('[data-now-line]').forEach((el) => {
    const start = Number(el.dataset.dayStart) || 0;
    const end = Number(el.dataset.dayEnd) || 1440;
    const inRange = now >= start && now <= end;
    el.hidden = !inRange;
    if (!inRange) return;
    const pct = `${((now - start) / Math.max(1, end - start)) * 100}%`;
    if (el.dataset.axis === 'x') el.style.left = pct;
    else el.style.top = pct;
    const label = el.querySelector('[data-now-label]');
    if (label) label.textContent = fmtTime(now);
  });
  const chip = document.getElementById('diary-next');
  if (chip && state.settings.diaryDate === todayISO()) chip.outerHTML = nextUpCard(state.settings.diaryDate);
}

function renderDiary() {
  const date = state.settings.diaryDate || todayISO();
  const view = state.settings.diaryView || 'day';

  const head = `
    <header class="view__head">
      <h1 class="view__title">Diary</h1>
      <p class="view__subtitle">
        Time-block your day and see Clinical vs Admin vs Non-clinical hours add up.
      </p>
    </header>`;

  const segBtn = (id, label) => `<button class="seg__btn ${view === id ? 'seg__btn--on' : ''}" data-action="diary-view" data-view="${id}">${label}</button>`;
  const zoomIdx = DIARY_ZOOM_LEVELS.indexOf(diaryZoomLevel());
  const zoomCtl = view === 'month' ? '' : `
      <div class="diary-zoom" role="group" aria-label="Timeline size">
        <button class="btn btn--sm" data-action="diary-zoom-out" aria-label="Smaller timeline"
                title="Smaller timeline"${zoomIdx <= 0 ? ' disabled' : ''}>−</button>
        <button class="btn btn--sm diary-zoom__label" data-action="diary-zoom-reset"
                title="Fit the timeline to the screen">${zoomIdx <= 0 ? 'Fit' : `${DIARY_ZOOM_LEVELS[zoomIdx]}×`}</button>
        <button class="btn btn--sm" data-action="diary-zoom-in" aria-label="Larger timeline"
                title="Larger timeline"${zoomIdx >= DIARY_ZOOM_LEVELS.length - 1 ? ' disabled' : ''}>＋</button>
      </div>`;
  const toolbar = `
    <div class="diary-toolbar">
      <div class="seg" role="group" aria-label="Diary view">
        ${segBtn('day', 'Day')}${segBtn('week', 'Week')}${segBtn('month', 'Month')}
      </div>
      <button class="btn" data-action="diary-prev" aria-label="Previous">‹</button>
      <input class="diary-date" type="date" value="${esc(date)}" data-action="diary-date" aria-label="Diary date" />
      <button class="btn" data-action="diary-next" aria-label="Next">›</button>
      <button class="btn" data-action="diary-today">Today</button>
      ${zoomCtl}
      <span class="spacer"></span>
      <button class="btn btn--primary" data-action="new-event">＋ New event</button>
    </div>`;

  const body = view === 'day' ? diaryDayHTML(date)
    : view === 'week' ? diaryWeekHTML(date)
    : diaryMonthHTML(date);

  return head + toolbar + body;
}

function diaryDayHTML(date) {
  const dayEvents = eventsOn(date).slice().sort((a, b) => minutesOf(a.startTime) - minutesOf(b.startTime));
  const dayTotals = hoursByCategory(dayEvents);
  const wk = hoursByCategory(weekEvents(date));
  const target = Number(state.settings.clinicalTargetHours) || 0;
  const weekStart = startOfWeekISO(date);
  const prettyDate = new Date(date + 'T00:00:00')
    .toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

  // Stacked hours bar for the selected day.
  const seg = (id) => {
    const pct = dayTotals.total ? (dayTotals[id] / dayTotals.total) * 100 : 0;
    return pct > 0 ? `<div class="hours-bar__seg hours-bar__seg--${id}" style="width:${pct}%" title="${categoryLabel(id)} ${hoursLabel(dayTotals[id])}"></div>` : '';
  };
  const bar = `<div class="hours-bar" role="img" aria-label="Clinical ${hoursLabel(dayTotals.clinical)}, Admin ${hoursLabel(dayTotals.admin)}, Non-clinical ${hoursLabel(dayTotals['non-clinical'])}">
    ${seg('clinical')}${seg('admin')}${seg('non-clinical')}
  </div>`;

  // Day summary card — bulleted totals for the selected day + stacked hours bar.
  const dayCard = `
    <div class="panel panel--accent">
      <h2 class="panel__title">Day totals</h2>
      <p class="field-row__hint">${esc(prettyDate)}</p>
      ${statList([
        { id: 'clinical', label: 'Clinical', value: hoursLabel(dayTotals.clinical) },
        { id: 'admin', label: 'Admin', value: hoursLabel(dayTotals.admin) },
        { id: 'non-clinical', label: 'Non-clinical', value: hoursLabel(dayTotals['non-clinical']) },
        { label: 'Total', value: hoursLabel(dayTotals.total), total: true },
      ])}
      ${bar}
    </div>`;

  // Timeline bounds — expand to fit any early/late events.
  let dayStart = minutesOf(state.settings.workdayStart);
  let dayEnd = minutesOf(state.settings.workdayEnd);
  dayEvents.forEach((e) => {
    dayStart = Math.min(dayStart, minutesOf(e.startTime));
    dayEnd = Math.max(dayEnd, minutesOf(e.endTime));
  });
  dayStart = Math.floor(dayStart / 60) * 60;
  dayEnd = Math.ceil(dayEnd / 60) * 60;
  if (dayEnd - dayStart < 30) dayEnd = dayStart + 30;
  const band = dayEnd - dayStart;
  const pos = (m) => ((m - dayStart) / band) * 100;   // % down the timeline
  const slotH = (30 / band) * 100;

  const slots = [];
  for (let m = dayStart; m < dayEnd; m += 30) {
    slots.push(`<button type="button" class="diary-slot" tabindex="-1" data-action="new-event" data-date="${date}" data-minute="${m}"
      aria-label="Add event at ${fmtTime(m)}" style="top:${pos(m)}%;height:${slotH}%"></button>`);
  }
  const hourMarks = [];
  for (let m = dayStart; m <= dayEnd; m += 60) {
    hourMarks.push(`<div class="diary-hour" style="top:${pos(m)}%">${fmtTime(m)}</div>`);
  }
  const blocks = dayEvents.map((e) => {
    const pname = e.patientId ? patientName(e.patientId) : '';
    const tip = `${e.title}${pname ? ' · ' + pname : ''} (${fmtTime(minutesOf(e.startTime))}–${fmtTime(minutesOf(e.endTime))})`;
    return `<button type="button" class="diary-event diary-event--${esc(e.category)}" style="top:${pos(minutesOf(e.startTime))}%;height:${(eventMinutes(e) / band) * 100}%"
      data-action="edit-event" data-id="${esc(e.eventId)}" data-date="${esc(e.date)}" title="${esc(tip)}">
      <span class="diary-event__title">${esc(e.title)}</span>
      <span class="diary-event__meta">${fmtTime(minutesOf(e.startTime))}–${fmtTime(minutesOf(e.endTime))}${pname ? ' · ' + esc(pname) : ''}</span>
      ${isRecurring(e) ? '<span class="diary-event__repeat" title="Repeating">🔁</span>' : ''}
    </button>`;
  }).join('');

  // Live "now" line (today only); repositioned every 30s by tickDiaryClocks().
  const nowMin = nowMinutes();
  const nowLine = date === todayISO()
    ? `<div class="diary-now-line" data-now-line data-day-start="${dayStart}" data-day-end="${dayEnd}"${nowMin >= dayStart && nowMin <= dayEnd ? '' : ' hidden'} style="top:${pos(nowMin)}%"><span class="diary-now-line__label" data-now-label>${fmtTime(nowMin)}</span></div>`
    : '';

  const timeline = `
    <div class="panel diary-main">
      <h2 class="panel__title">${esc(prettyDate)}</h2>
      <div class="diary-grid">
        <div class="diary-hours">${hourMarks.join('')}</div>
        <div class="diary-track" data-band-start="${dayStart}" data-band-end="${dayEnd}">${slots.join('')}${blocks}${nowLine}<div class="diary-hover" hidden><span class="diary-hover__label"></span></div></div>
      </div>
      <p class="field-row__hint" style="margin-top:var(--space-3)">Click a slot (or drag across several) to add a block.</p>
    </div>`;

  // Suggested tasks to drag into the day (day view only) - sorted by task score
  let suggestions = activeTasks()
    .filter((t) => !allocatedToday().some((a) => a.taskId === t.taskId))
    .map((t) => ({ t, s: taskScore(t) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.t)
    .slice(0, 20);
  if (!suggestions.length) {
    suggestions = activeTasks()
      .map((t) => ({ t, s: taskScore(t) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.t)
      .slice(0, 20);
  } else {
    suggestions = suggestions
      .map((t) => ({ t, s: taskScore(t) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.t);
  }
  const suggestPanel = `
    <div class="panel">
      <h2 class="panel__title">Suggested tasks</h2>
      <p class="field-row__hint">Drag to a time slot to add to this day</p>
      <div class="diary-suggest diary-suggest--scroll">
        ${suggestions.length ? suggestions.map((t) => {
          const p = t.patientId ? patientName(t.patientId) : '';
          const est = t.estimatedMinutes ? ` · ${t.estimatedMinutes}m` : '';
          const sc = Math.round(taskScore(t));
          return `<div class="diary-suggest__item" draggable="true" data-drag-type="task" data-task-id="${esc(t.taskId)}" title="Drag to add to diary · Score ${sc}">
            <div class="diary-suggest__title">${esc(t.title)}</div>
            <div class="diary-suggest__meta">${p ? esc(p) : 'General'}${est} · ★ ${sc}</div>
          </div>`;
        }).join('') : `<div class="field-row__hint">No tasks to suggest</div>`}
      </div>
    </div>`;

  // This week summary card + target comparison.
  const pct = target ? Math.min(100, Math.round(((wk.clinical / 60) / target) * 100)) : 0;
  const weekPanel = `
    <div class="panel panel--accent">
      <h2 class="panel__title">This week</h2>
      <p class="field-row__hint">Mon ${esc(weekStart)} – Sun ${esc(addDays(weekStart, 6))}</p>
      ${statList([
        { id: 'clinical', label: 'Clinical', value: hoursLabel(wk.clinical) },
        { id: 'admin', label: 'Admin', value: hoursLabel(wk.admin) },
        { id: 'non-clinical', label: 'Non-clinical', value: hoursLabel(wk['non-clinical']) },
        { label: 'Total', value: hoursLabel(wk.total), total: true },
      ])}
      ${target ? `
        <div style="margin-top:var(--space-3)">
          <div class="plan-bar"><div class="plan-bar__fill" style="width:${pct}%"></div></div>
          <p class="field-row__hint">Clinical ${hoursLabel(wk.clinical)} of ${target}h target (${pct}%).</p>
        </div>` : `<p class="field-row__hint">Set a weekly clinical target in Settings to compare.</p>`}
    </div>`;

  return `<div class="diary-layout">${timeline}<div class="diary-side">${date === todayISO() ? nextUpCard(date) : ''}${dayCard}${suggestPanel}${weekPanel}</div></div>`;
}

/** Week view: a Mon–Fri time grid, one column per working day. */
function diaryWeekHTML(date) {
  const days = [0, 1, 2, 3, 4].map((i) => addDays(startOfWeekISO(date), i));  // Mon–Fri only
  const evsByDay = {};
  let minM = minutesOf(state.settings.workdayStart);
  let maxM = minutesOf(state.settings.workdayEnd);
  days.forEach((d) => {
    const evs = eventsOn(d).slice().sort((a, b) => minutesOf(a.startTime) - minutesOf(b.startTime));
    evsByDay[d] = evs;
    evs.forEach((e) => {
      minM = Math.min(minM, minutesOf(e.startTime));
      maxM = Math.max(maxM, minutesOf(e.endTime));
    });
  });
  const startM = Math.floor(minM / 60) * 60;
  let endM = Math.ceil(maxM / 60) * 60;
  if (endM - startM < 30) endM = startM + 30;
  const band = endM - startM;
  const pos = (m) => ((m - startM) / band) * 100;   // % down the timeline
  const slotH = (30 / band) * 100;
  const hover = '<div class="diary-hover" hidden><span class="diary-hover__label"></span></div>';

  const hourMarks = [];
  for (let m = startM; m <= endM; m += 60) {
    hourMarks.push(`<div class="diary-hour" style="top:${pos(m)}%">${fmtTime(m)}</div>`);
  }

  const today = todayISO();
  const head = days.map((d) => {
    const dt = new Date(d + 'T00:00:00');
    // Per-day figure counts clinical hours only (not admin / non-clinical).
    const tot = hoursByCategory(evsByDay[d]);
    return `<div class="diary-week__day${d === today ? ' diary-week__day--today' : ''}">
      <span class="diary-week__dow">${dt.toLocaleDateString(undefined, { weekday: 'short' })}</span>
      <span class="diary-week__num">${dt.getDate()}</span>
      <span class="diary-week__tot" title="Clinical hours">${tot.clinical ? hoursLabel(tot.clinical) : ''}</span>
    </div>`;
  }).join('');

  const cols = days.map((d) => {
    const slots = [];
    for (let m = startM; m < endM; m += 30) {
      slots.push(`<button type="button" class="diary-slot" tabindex="-1" data-action="new-event" data-date="${d}" data-minute="${m}"
        aria-label="Add event ${d} at ${fmtTime(m)}" style="top:${pos(m)}%;height:${slotH}%"></button>`);
    }
    const blocks = evsByDay[d].map((e) => {
      const pname = e.patientId ? patientName(e.patientId) : '';
      return `<button type="button" class="diary-event diary-event--${esc(e.category)}" style="top:${pos(minutesOf(e.startTime))}%;height:${(eventMinutes(e) / band) * 100}%"
        data-action="edit-event" data-id="${esc(e.eventId)}" data-date="${esc(e.date)}" title="${esc(e.title)}${pname ? ' · ' + esc(pname) : ''}">
        <span class="diary-event__title">${esc(e.title)}</span>
        <span class="diary-event__meta">${fmtTime(minutesOf(e.startTime))}${pname ? ' · ' + esc(pname) : ''}</span>
        ${isRecurring(e) ? '<span class="diary-event__repeat" title="Repeating">🔁</span>' : ''}
      </button>`;
    }).join('');
    return `<div class="diary-track" data-band-start="${startM}" data-band-end="${endM}">${slots.join('')}${blocks}${hover}</div>`;
  }).join('');

  // Live "now" line across the grid when today is one of the shown working days.
  const nowMin = nowMinutes();
  const weekNow = (today >= days[0] && today <= days[4])
    ? `<div class="diary-week__now" data-now-line data-day-start="${startM}" data-day-end="${endM}"${nowMin >= startM && nowMin <= endM ? '' : ' hidden'} style="top:${pos(nowMin)}%"></div>`
    : '';

  const wkTotals = hoursByCategory(days.flatMap((d) => evsByDay[d]));
  const target = Number(state.settings.clinicalTargetHours) || 0;
  const pct = target ? Math.min(100, Math.round(((wkTotals.clinical / 60) / target) * 100)) : 0;

  const weekCard = `
    <div class="panel panel--accent">
      <h2 class="panel__title">Work week <span class="panel__subhead">Mon–Fri</span></h2>
      <p class="field-row__hint">Mon ${esc(days[0])} – Fri ${esc(days[4])}</p>
      ${statList([
        { id: 'clinical', label: 'Clinical', value: hoursLabel(wkTotals.clinical) },
        { id: 'admin', label: 'Admin', value: hoursLabel(wkTotals.admin) },
        { id: 'non-clinical', label: 'Non-clinical', value: hoursLabel(wkTotals['non-clinical']) },
        { label: 'Total', value: hoursLabel(wkTotals.total), total: true },
      ])}
      ${target ? `
        <div style="margin-top:var(--space-3)">
          <div class="plan-bar"><div class="plan-bar__fill" style="width:${pct}%"></div></div>
          <p class="field-row__hint">Clinical ${hoursLabel(wkTotals.clinical)} of ${target}h target (${pct}%).</p>
        </div>` : `<p class="field-row__hint">Set a weekly clinical target in Settings to compare.</p>`}
    </div>`;

  const grid = `
    <div class="diary-scroll">
      <div class="diary-week">
        <div class="diary-week__head"><div class="diary-week__gutter"></div>${head}</div>
        <div class="diary-week__body">
          <div class="diary-hours">${hourMarks.join('')}</div>
          ${cols}${weekNow}
        </div>
      </div>
    </div>`;

  return `<div class="diary-layout"><div class="panel diary-main">${grid}
    <p class="field-row__hint" style="margin-top:var(--space-3)">Day figures show clinical hours. Click or drag a slot to add a block; click a block to edit.</p>
  </div><div class="diary-side">${weekCard}</div></div>`;
}

/** Month view: a calendar grid of the month, weekends muted. */
function diaryMonthHTML(date) {
  const anchor = new Date(date + 'T00:00:00');
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const monthStart = todayISO(new Date(year, month, 1));
  const monthEnd = todayISO(new Date(year, month + 1, 0));
  const gridStart = startOfWeekISO(monthStart);
  const gridEnd = addDays(startOfWeekISO(monthEnd), 6);
  const title = anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const today = todayISO();

  const cells = [];
  for (let d = gridStart; d <= gridEnd; d = addDays(d, 1)) {
    const dt = new Date(d + 'T00:00:00');
    const inMonth = d >= monthStart && d <= monthEnd;
    const dow = dt.getDay();
    const weekend = dow === 0 || dow === 6;
    const totals = hoursByCategory(eventsOn(d));
    const cls = `diary-cal${inMonth ? '' : ' diary-cal--muted'}${weekend ? ' diary-cal--weekend' : ''}${d === today ? ' diary-cal--today' : ''}`;
    cells.push(`<button type="button" class="${cls}"${inMonth ? ` data-action="diary-goto-day" data-date="${d}"` : ' disabled'}>
      <span class="diary-cal__num">${dt.getDate()}</span>
      ${inMonth && totals.clinical ? `<span class="diary-cal__hours" title="Clinical hours">${hoursLabel(totals.clinical)}</span>` : ''}
      ${inMonth && totals.total ? `<span class="diary-cal__bar">${stackedSegs(totals)}</span>` : ''}
    </button>`);
  }

  const monthEvents = eventsInRange(monthStart, monthEnd);
  const monthTotals = hoursByCategory(monthEvents);
  const bookedDays = new Set(monthEvents.map((e) => e.date)).size;

  const monthCard = `
    <div class="panel panel--accent">
      <h2 class="panel__title">This month <span class="panel__subhead">${esc(title)}</span></h2>
      ${statList([
        { id: 'clinical', label: 'Clinical', value: hoursLabel(monthTotals.clinical) },
        { id: 'admin', label: 'Admin', value: hoursLabel(monthTotals.admin) },
        { id: 'non-clinical', label: 'Non-clinical', value: hoursLabel(monthTotals['non-clinical']) },
        { label: 'Total', value: hoursLabel(monthTotals.total), total: true },
      ])}
      <p class="field-row__hint">${bookedDays} day${bookedDays === 1 ? '' : 's'} with hours booked.</p>
    </div>`;

  const headRow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    .map((w) => `<div class="diary-calhead">${w}</div>`).join('');
  const grid = `
    <div class="diary-scroll">
      <div class="diary-month">
        <div class="diary-month__head">${headRow}</div>
        <div class="diary-month__grid">${cells.join('')}</div>
      </div>
    </div>`;

  return `<div class="diary-layout"><div class="panel diary-main diary-main--month">
    <h2 class="panel__title">${esc(title)}</h2>${grid}
    <p class="field-row__hint" style="margin-top:var(--space-3)">Day figures show clinical hours. Click a day to open it in Day view.</p>
  </div><div class="diary-side">${monthCard}</div></div>`;
}

/* ---- Diary event modal -------------------------------------------- */
let eventModalId = null;
let eventModalOccDate = null;   // the occurrence (day) the user opened, for repeating events
let lastDragEnd = 0;   // timestamp of the last drag-create (suppresses the trailing click)

function openEventModal({ eventId = null, occurrenceDate = null, date, startMin, endMin } = {}) {
  const existing = eventId ? state.diary.find((e) => e.eventId === eventId) : null;
  eventModalId = existing ? existing.eventId : null;
  eventModalOccDate = occurrenceDate || (existing ? existing.date : null);

  const d = existing ? existing.date : (date || state.settings.diaryDate || todayISO());
  const s = existing ? minutesOf(existing.startTime) : (startMin != null ? startMin : minutesOf(state.settings.workdayStart));
  const en = existing ? minutesOf(existing.endTime) : (endMin != null ? endMin : s + 30);

  const rec = (existing && existing.recurrence) || { freq: 'none', interval: 1, weekdays: [], until: null };
  const freq = rec.freq || 'none';
  const recInterval = Math.max(1, Number(rec.interval) || 1);
  const anchorDow = new Date(d + 'T00:00:00').getDay();
  const chosenDays = (rec.weekdays && rec.weekdays.length) ? rec.weekdays : [anchorDow];
  const WEEKDAYS = [['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6], ['Sun', 0]];
  const weekdayInputs = WEEKDAYS.map(([lbl, n]) =>
    `<label class="weekday"><input type="checkbox" data-day="${n}" ${chosenDays.includes(n) ? 'checked' : ''} />${lbl}</label>`).join('');

  const patientOpts = ['<option value="">— none —</option>']
    .concat(state.patients.map((p) =>
      `<option value="${esc(p.patientId)}" ${existing && existing.patientId === p.patientId ? 'selected' : ''}>${esc(p.name)}</option>`))
    .join('');

  openModal({
    title: existing ? (isRecurring(existing) ? 'Edit repeating event' : 'Edit event') : 'New event',
    body: `
      <div class="task-form">
        <label>Title *
          <input id="event-title" type="text" maxlength="120" autocomplete="off"
                 placeholder="e.g. Assessment — J. Smith" value="${esc(existing ? existing.title : '')}" />
        </label>
        <div class="task-form__grid">
          <label>Date<input id="event-date" type="date" value="${esc(d)}" /></label>
          <label>Category
            <select id="event-category">
              ${CATEGORIES.map((c) => `<option value="${c.id}" ${existing && existing.category === c.id ? 'selected' : ''}>${c.label}</option>`).join('')}
            </select>
          </label>
          <label>Start<input id="event-start" type="time" value="${fmtTime(s)}" /></label>
          <label>End<input id="event-end" type="time" value="${fmtTime(en)}" /></label>
        </div>
        <label>Patient (optional)
          <select id="event-patient">${patientOpts}</select>
        </label>
        <div class="event-repeat">
          <div class="task-form__grid">
            <label>Repeat
              <select id="event-repeat">
                <option value="none" ${freq === 'none' ? 'selected' : ''}>Does not repeat</option>
                <option value="daily" ${freq === 'daily' ? 'selected' : ''}>Daily</option>
                <option value="weekly" ${freq === 'weekly' ? 'selected' : ''}>Weekly</option>
                <option value="monthly" ${freq === 'monthly' ? 'selected' : ''}>Monthly</option>
              </select>
            </label>
            <label id="event-interval-wrap">Every
              <span class="interval-input">
                <input id="event-interval" type="number" min="1" max="52" class="input--num" value="${recInterval}" />
                <span id="event-interval-unit"></span>
              </span>
            </label>
            <label id="event-until-wrap">Repeat until
              <input id="event-until" type="date" value="${esc(rec.until || '')}" />
            </label>
          </div>
          <fieldset id="event-weekdays" class="weekday-picker">
            <legend>Repeat on</legend>
            ${weekdayInputs}
          </fieldset>
        </div>
      </div>`,
    actions: [
      ...(existing ? [{ label: 'Delete', onClick: deleteEvent }] : []),
      { label: 'Cancel', onClick: closeModal },
      { label: existing ? 'Save changes' : 'Add event', variant: 'primary', onClick: submitEvent },
    ],
  });
  const t = $('#event-title');
  if (t) { t.focus(); t.select(); }

  // Keep the recurrence controls in step with the chosen frequency.
  syncEventRepeatFields();
  const rep = $('#event-repeat');
  if (rep) rep.addEventListener('change', syncEventRepeatFields);
  const iv = $('#event-interval');
  if (iv) iv.addEventListener('input', syncEventRepeatFields);
}

/** Show/hide recurrence controls to match the current Repeat selection. */
function syncEventRepeatFields() {
  const sel = $('#event-repeat');
  if (!sel) return;
  const freq = sel.value;
  const on = !!freq && freq !== 'none';
  const iw = $('#event-interval-wrap'); if (iw) iw.hidden = !on;
  const wd = $('#event-weekdays'); if (wd) wd.hidden = freq !== 'weekly';
  const uw = $('#event-until-wrap'); if (uw) uw.hidden = !on;
  const unit = $('#event-interval-unit');
  if (unit) {
    const n = Math.max(1, Number(($('#event-interval') || {}).value) || 1);
    const base = freq === 'daily' ? 'day' : freq === 'monthly' ? 'month' : 'week';
    unit.textContent = base + (n === 1 ? '' : 's');
  }
}

function submitEvent() {
  const title = ($('#event-title') || {}).value || '';
  if (!title.trim()) { toast('Give the event a title.', 'error'); return; }
  const start = ($('#event-start') || {}).value || '09:00';
  const end = ($('#event-end') || {}).value || '10:00';
  if (minutesOf(end) <= minutesOf(start)) { toast('End time must be after start time.', 'error'); return; }

  const fields = {
    title: title.trim(),
    date: ($('#event-date') || {}).value || todayISO(),
    startTime: start,
    endTime: end,
    category: ($('#event-category') || {}).value || 'clinical',
    patientId: ($('#event-patient') || {}).value || null,
  };

  const freq = (($('#event-repeat') || {}).value) || 'none';
  if (freq && freq !== 'none') {
    let weekdays = [...document.querySelectorAll('#event-weekdays input[type="checkbox"]')]
      .filter((c) => c.checked).map((c) => Number(c.dataset.day));
    if (freq === 'weekly' && !weekdays.length) weekdays = [new Date(fields.date + 'T00:00:00').getDay()];
    fields.recurrence = {
      freq,
      interval: Math.max(1, Number(($('#event-interval') || {}).value) || 1),
      weekdays: freq === 'weekly' ? weekdays : [],
      until: ($('#event-until') || {}).value || null,
    };
  } else {
    fields.recurrence = null;
  }

  if (eventModalId) {
    const ev = state.diary.find((e) => e.eventId === eventModalId);
    if (ev) {
      const wasRecurring = isRecurring(ev);
      Object.assign(ev, fields);
      toast(wasRecurring || isRecurring(ev) ? 'Repeating event updated.' : 'Event updated.');
    }
  } else {
    state.diary.push({ eventId: uuid(), ...fields });
    toast('Event added.');
  }
  state.settings.diaryDate = fields.date;   // follow the event's day
  closeModal();
  save();
}

function deleteEvent() {
  if (!eventModalId) { closeModal(); return; }
  const ev = state.diary.find((e) => e.eventId === eventModalId);
  if (!ev) { closeModal(); return; }

  if (!isRecurring(ev)) {
    state.diary = state.diary.filter((e) => e.eventId !== eventModalId);
    closeModal();
    toast('Event deleted.');
    save();
    return;
  }

  // Repeating event: ask whether to drop one occurrence or the whole series.
  const occ = eventModalOccDate || ev.date;
  const when = new Date(occ + 'T00:00:00')
    .toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  openModal({
    title: 'Delete repeating event',
    body: `
      <p>“${esc(ev.title)}” repeats.</p>
      <p class="field-row__hint" style="margin-top:var(--space-2)">
        Delete just <strong>${esc(when)}</strong>, or remove every occurrence in the series?
      </p>`,
    actions: [
      { label: 'Cancel', onClick: () => openEventModal({ eventId: ev.eventId, occurrenceDate: occ }) },
      { label: 'This occurrence only', onClick: () => removeOccurrence(ev, occ) },
      { label: 'Whole series', variant: 'danger', onClick: () => {
        state.diary = state.diary.filter((e) => e.eventId !== ev.eventId);
        closeModal();
        toast('Event and its repeats deleted.');
        save();
      } },
    ],
  });
}

/** Remove a single occurrence of a repeating event; drop the series if nothing remains. */
function removeOccurrence(ev, iso) {
  const r = ev.recurrence || (ev.recurrence = {});
  const ex = new Set(r.exdates || []);
  ex.add(iso);
  r.exdates = [...ex];

  let remains = false;
  for (let d = ev.date, i = 0; i < 3660 && !remains; i++, d = addDays(d, 1)) {
    if (occursOn(ev, d)) remains = true;   // occursOn already honours exdates
  }
  closeModal();
  if (!remains) {
    state.diary = state.diary.filter((e) => e.eventId !== ev.eventId);
    toast('Last occurrence removed — repeating event deleted.');
  } else {
    toast('This occurrence deleted.');
  }
  save();
}

/* ---- Settings ------------------------------------------------------ */
/** A single tunable scoring-weight number input. */
function weightField(key, label) {
  return `<label class="weight-field">${esc(label)}
    <input type="number" step="0.1" min="0" data-action="set-weight"
           data-weight="${key}" value="${esc(state.settings.weights[key])}" />
  </label>`;
}

function renderSettings() {
  const bytes = new Blob([JSON.stringify(state)]).size;
  const recovery = Storage.hasRecovered() ? `
    <div class="panel panel--warning">
      <h2 class="panel__title">⚠ Recovered data</h2>
      <p class="field-row__hint">
        A previous save could not be read, so the app started fresh. An untouched
        copy was kept in case you want to inspect or repair it. Download it before
        it is overwritten.
      </p>
      <div class="btn-row" style="margin-top:var(--space-3)">
        <button class="btn" data-action="download-recovered">Download recovered file</button>
        <button class="btn btn--danger" data-action="clear-recovered">Discard recovered file</button>
      </div>
    </div>` : '';

  return `
    <header class="view__head">
      <h1 class="view__title">Settings</h1>
      <p class="view__subtitle">Appearance, data backup and storage. Everything stays on this device.</p>
    </header>

    ${recovery}

    <div class="panel">
      <h2 class="panel__title">Appearance</h2>
      <div class="field-row">
        <div><div class="field-row__label">Theme</div>
          <div class="field-row__hint">Light, dark or high-contrast.</div></div>
        <select data-action="set-theme" aria-label="Theme">
          ${['light','dark','contrast'].map((t) =>
            `<option value="${t}" ${state.settings.theme === t ? 'selected' : ''}>${t[0].toUpperCase()+t.slice(1)}</option>`).join('')}
        </select>
      </div>
      <div class="field-row">
        <div><div class="field-row__label">Density</div>
          <div class="field-row__hint">Compact tightens spacing so more fits on screen.</div></div>
        <select data-action="set-density" aria-label="Density">
          ${[['comfy','Comfy (roomier)'],['compact','Compact']].map(([v, l]) =>
            `<option value="${v}" ${(state.settings.density || 'comfy') === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="field-row">
        <div><div class="field-row__label">Text size</div>
          <div class="field-row__hint">Scales all text up or down.</div></div>
        <select data-action="set-textsize" aria-label="Text size">
          ${[['sm','Small'],['md','Default'],['lg','Large']].map(([t, label]) =>
            `<option value="${t}" ${(state.settings.textSize || 'md') === t ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </div>
    </div>

    <div class="panel">
      <h2 class="panel__title">Working day & targets</h2>
      <div class="field-row">
        <div><div class="field-row__label">Working hours</div>
          <div class="field-row__hint">Sets the time budget for "Today’s plan".</div></div>
        <div class="btn-row">
          <input type="time" data-action="set-setting" data-key="workdayStart" value="${esc(state.settings.workdayStart)}" aria-label="Workday start" />
          <input type="time" data-action="set-setting" data-key="workdayEnd" value="${esc(state.settings.workdayEnd)}" aria-label="Workday end" />
        </div>
      </div>
      <div class="field-row">
        <div><div class="field-row__label">Clinical target (hours/week)</div>
          <div class="field-row__hint">Shown against your diary's weekly Clinical total.</div></div>
        <input type="number" min="0" step="0.5" class="input--num" data-action="set-setting" data-key="clinicalTargetHours" data-type="number" aria-label="Clinical target hours per week" value="${esc(state.settings.clinicalTargetHours)}" />
      </div>
    </div>

    <div class="panel">
      <h2 class="panel__title">ADHD priority scoring</h2>
      <p class="field-row__hint">Higher weight pushes that factor up the ranking. Tune to taste.</p>
      <div class="task-form__grid" style="margin-top:var(--space-3)">
        ${weightField('daysInStage', 'Days in stage')}
        ${weightField('dueProximity', 'Due date')}
        ${weightField('dread', 'Dread score')}
        ${weightField('time', 'Estimated time')}
        ${weightField('priority', 'Priority')}
      </div>
      <div class="field-row" style="margin-top:var(--space-4)">
        <div><div class="field-row__label">Quick win threshold</div>
          <div class="field-row__hint">Tasks at or under this many minutes count as quick wins.</div></div>
        <input type="number" min="5" step="5" class="input--num" data-action="set-setting" data-key="quickWinMinutes" data-type="number" aria-label="Quick win threshold in minutes" value="${esc(state.settings.quickWinMinutes)}" />
      </div>
      <div class="field-row">
        <div><div class="field-row__label">Breach warning (days)</div>
          <div class="field-row__hint">Days in stage before a patient is flagged as a long wait.</div></div>
        <input type="number" min="1" step="1" class="input--num" data-action="set-setting" data-key="waitWarningDays" data-type="number" aria-label="Breach warning in days" value="${esc(state.settings.waitWarningDays)}" />
      </div>
      <div class="field-row">
        <div><div class="field-row__label">Completion celebration</div>
          <div class="field-row__hint">Show a small reward animation when you finish a task.</div></div>
        <input type="checkbox" data-action="set-setting" data-key="rewardAnimation" data-type="boolean" aria-label="Completion celebration" ${state.settings.rewardAnimation ? 'checked' : ''} />
      </div>
      <div class="btn-row" style="margin-top:var(--space-3)">
        <button class="btn" data-action="reset-weights">Reset weights to defaults</button>
      </div>
    </div>

    <div class="panel">
      <h2 class="panel__title">Data & storage</h2>
      <div class="field-row">
        <div><div class="field-row__label">Storage backend</div>
          <div class="field-row__hint">localStorage with automatic IndexedDB fallback.</div></div>
        <span class="pill">${esc(Storage.backend)}</span>
      </div>
      <div class="field-row">
        <div><div class="field-row__label">Current data size</div>
          <div class="field-row__hint">${state.patients.length} patients · ${state.tasks.length} tasks · ${state.diary.length} events</div></div>
        <span class="pill">${humanBytes(bytes)}</span>
      </div>
      <div class="field-row">
        <div><div class="field-row__label">Caseload import (CSV)</div>
          <div class="field-row__hint">Import your IAPTUS caseload CSV and auto-create patients.</div></div>
        <button class="btn btn--primary" data-action="open-import">Import CSV</button>
      </div>
      <div class="field-row">
        <div><div class="field-row__label">Backup & restore</div>
          <div class="field-row__hint">Export the full state to JSON, or restore from a previous backup.</div></div>
        <div class="btn-row">
          <button class="btn" data-action="export-json">Export JSON</button>
          <button class="btn" data-action="import-json">Restore JSON</button>
        </div>
      </div>
      <div class="field-row">
        <div><div class="field-row__label">Demo data</div>
          <div class="field-row__hint">Load sample patients, tasks and diary events.</div></div>
        <div class="btn-row">
          <button class="btn" data-action="load-demo">Load demo</button>
          <button class="btn btn--danger" data-action="reset-all">Reset everything</button>
        </div>
      </div>
    </div>`;
}

/* ---- Shared: empty state ------------------------------------------ */
function emptyState({ icon, title, text, actions = '' }) {
  return `<div class="empty">
    <div class="empty__icon" aria-hidden="true">${icon}</div>
    <h2 class="empty__title">${esc(title)}</h2>
    <p>${esc(text)}</p>
    ${actions ? `<div class="btn-row">${actions}</div>` : ''}
  </div>`;
}

/* --------------------------------------------------------------------------
 * 8. UI helpers — toasts & modal
 * ------------------------------------------------------------------------ */
function toast(message, variant = 'info', ms = 3600) {
  const el = document.createElement('div');
  el.className = `toast toast--${variant}`;
  el.textContent = message;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** Play a short thocky click sound on task completion. */
function playTaskCompleteSound() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    // Low thock
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(110, now + 0.05);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.08);
    // Click
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'square';
    osc2.frequency.setValueAtTime(800, now + 0.005);
    osc2.frequency.exponentialRampToValueAtTime(400, now + 0.03);
    gain2.gain.setValueAtTime(0.0001, now + 0.005);
    gain2.gain.exponentialRampToValueAtTime(0.1, now + 0.007);
    gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.04);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.005);
    osc2.stop(now + 0.04);
    setTimeout(() => { try { ctx.close(); } catch (e) {} }, 200);
  } catch (e) {}
}

/** Small reward animation when a task is completed (respects reduced-motion). */
function celebrate() {
  if (!state.settings.rewardAnimation) return;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  toast('✅ Nice one!', 'success');
  playTaskCompleteSound();
  if (reduce) return;
  const burst = document.createElement('div');
  burst.className = 'confetti';
  burst.setAttribute('aria-hidden', 'true');
  const emojis = ['🎉', '✨', '⭐', '✅', '🎊'];
  for (let i = 0; i < 14; i++) {
    const s = document.createElement('span');
    s.textContent = emojis[i % emojis.length];
    s.style.left = `${Math.random() * 100}vw`;
    s.style.animationDelay = `${Math.random() * 0.25}s`;
    burst.appendChild(s);
  }
  document.body.appendChild(burst);
  setTimeout(() => burst.remove(), 1500);
}

let lastFocusedEl = null;   // element to restore focus to when the modal closes

function openModal({ title, body, actions = [] }) {
  const root = $('#modal-root');
  if (root.hidden) lastFocusedEl = document.activeElement;   // remember the trigger
  root.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal__head">
        <h2 class="modal__title">${esc(title)}</h2>
        <button class="btn btn--ghost" data-action="close-modal" aria-label="Close">${icon('x')}</button>
      </div>
      <div class="modal__body">${body}</div>
      ${actions.length ? `<div class="btn-row" style="margin-top:var(--space-5);justify-content:flex-end">
        ${actions.map((a, i) => `<button class="btn ${a.variant ? 'btn--' + a.variant : ''}" data-action="modal-action" data-index="${i}">${esc(a.label)}</button>`).join('')}
      </div>` : ''}
    </div>`;
  root.hidden = false;
  root._actions = actions;
  const focusable = root.querySelector('button, [href], input, select, textarea');
  if (focusable) focusable.focus();
}

function closeModal() {
  const root = $('#modal-root');
  root.hidden = true;
  root.innerHTML = '';
  root._actions = null;
  focusModalKind = null;
  // Return focus to whatever opened the modal, if it still exists.
  if (lastFocusedEl && document.contains(lastFocusedEl)) lastFocusedEl.focus();
  lastFocusedEl = null;
}

/* --------------------------------------------------------------------------
 * 8b. Command palette (Phase D) — Ctrl/Cmd+K
 * ------------------------------------------------------------------------ */
let paletteEls = null;
let pendingDrawerId = null;   // opens a drawer after navigating to Caseload

function paletteCommands() {
  const nav = (label, route, ic) => ({ label, kind: 'nav', value: route, icon: ic });
  return [
    nav('Go to Today', 'today', 'today'),
    nav('Go to Tasks', 'tasks', 'tasks'),
    nav('Go to Caseload', 'caseload', 'caseload'),
    nav('Go to Diary', 'diary', 'diary'),
    nav('Go to Settings', 'settings', 'settings'),
    { label: 'Overdue tasks', kind: 'filter', value: 'overdue', icon: 'overdue' },
    { label: 'Tasks due today', kind: 'filter', value: 'today', icon: 'clock' },
    { label: 'Quick wins', kind: 'filter', value: 'quick', icon: 'quick' },
    { label: 'Long waits', kind: 'breach', value: '1', icon: 'caseload' },
    { label: 'New task…', kind: 'new-task', value: '', icon: 'plus' },
    { label: 'New patient…', kind: 'new-patient', value: '', icon: 'plus' },
  ];
}

function buildPalette() {
  if (paletteEls) return paletteEls;
  const root = document.createElement('div');
  root.id = 'palette-root';
  root.className = 'palette-root';
  root.hidden = true;
  root.innerHTML = `
    <div class="palette__backdrop" data-palette="close"></div>
    <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
      <input class="palette__input" id="palette-input" type="text" role="combobox"
             aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list"
             placeholder="Search patients or tasks…" autocomplete="off" />
      <ul class="palette__list" id="palette-list" role="listbox" aria-label="Commands"></ul>
      <div class="palette__hint"><kbd class="kbd">↑</kbd><kbd class="kbd">↓</kbd> move ·
        <kbd class="kbd">Enter</kbd> run · <kbd class="kbd">Esc</kbd> close</div>
    </div>`;
  document.body.appendChild(root);
  const input = root.querySelector('#palette-input');
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-palette="close"]')) return closePalette();
    const li = e.target.closest('.palette__item');
    if (li) runPalette(li.dataset);
  });
  input.addEventListener('input', renderPalette);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      movePalette(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      const active = root.querySelector('.palette__item--active') || root.querySelector('.palette__item');
      if (active) runPalette(active.dataset);
    }
  });
  paletteEls = { root, input, list: root.querySelector('#palette-list') };
  return paletteEls;
}

function paletteMatches(query) {
  const q = query.trim().toLowerCase();
  const items = paletteCommands().filter((c) => !q || c.label.toLowerCase().includes(q));
  if (!q) return items;
  const patients = state.patients
    .filter((p) => (p.name || '').toLowerCase().includes(q) || String(p.patientId).toLowerCase().includes(q))
    .slice(0, 8)
    .map((p) => ({ label: p.name, sub: 'Patient · ' + p.patientId, kind: 'patient', value: p.patientId, icon: 'caseload' }));
  const tasks = activeByScore()
    .filter((t) => (t.title || '').toLowerCase().includes(q))
    .slice(0, 8)
    .map((t) => ({ label: t.title, sub: 'Task' + (t.patientId ? ' · ' + patientName(t.patientId) : ''), kind: 'task', value: t.taskId, icon: 'tasks' }));
  const completedTasks = state.tasks
    .filter((t) => t.isCompleted && (t.title || '').toLowerCase().includes(q))
    .slice(0, 6)
    .map((t) => ({ label: t.title, sub: 'Task (done)' + (t.patientId ? ' · ' + patientName(t.patientId) : ''), kind: 'task', value: t.taskId, icon: 'tasks' }));
  const add = { label: `Add task “${query.trim()}”`, kind: 'add-task', value: query.trim(), icon: 'plus' };
  return [...items, ...patients, ...tasks, ...completedTasks, add];
}

function renderPalette() {
  if (!paletteEls) return;
  const items = paletteMatches(paletteEls.input.value);
  paletteEls.list.innerHTML = items.map((c, i) => `
    <li class="palette__item ${i === 0 ? 'palette__item--active' : ''}" role="option"
        data-kind="${esc(c.kind)}" data-value="${esc(c.value || '')}">
      <span class="palette__icon">${icon(c.icon)}</span>
      <span class="palette__label">${esc(c.label)}</span>
      ${c.sub ? `<span class="palette__sub">${esc(c.sub)}</span>` : ''}
    </li>`).join('') || '<li class="palette__empty">No matches</li>';
}

function movePalette(dir) {
  const items = [...paletteEls.list.querySelectorAll('.palette__item')];
  if (!items.length) return;
  let idx = items.findIndex((el) => el.classList.contains('palette__item--active'));
  idx = (idx + dir + items.length) % items.length;
  items.forEach((el, i) => el.classList.toggle('palette__item--active', i === idx));
  items[idx].scrollIntoView({ block: 'nearest' });
}

function openPalette() {
  const { root, input } = buildPalette();
  root.hidden = false;
  input.value = '';
  renderPalette();
  input.focus();
}

function closePalette() {
  if (!paletteEls) return;
  paletteEls.root.hidden = true;
}

async function runPalette(ds) {
  const kind = ds.kind;
  const value = ds.value || '';
  closePalette();
  if (kind === 'nav') { location.hash = '#/' + value; return; }
  if (kind === 'filter') {
    state.settings.tasksView.filter = value;
    if (currentRouteId() !== 'tasks') location.hash = '#/tasks'; else await save();
    return;
  }
  if (kind === 'breach') {
    state.settings.caseloadView.breachOnly = true;
    if (currentRouteId() !== 'caseload') location.hash = '#/caseload'; else await save();
    return;
  }
  if (kind === 'new-task') { openTaskModal(null); return; }
  if (kind === 'new-patient') { openPatientModal(null); return; }
  if (kind === 'patient') {
    if (currentRouteId() === 'caseload') openDrawer(value);
    else { pendingDrawerId = value; location.hash = '#/caseload'; }
    return;
  }
  if (kind === 'task') { openTaskModal(null, value); return; }
  if (kind === 'add-task') { createQuickTask(value); return; }
}

/* --------------------------------------------------------------------------
 * 9. Backup export / import
 * ------------------------------------------------------------------------ */
function exportJSON() {
  const stamp = todayISO();
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `caseload_backup_${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('Backup downloaded.', 'success');
}

/** Kick off a file pick, then route to the right importer. */
function pickFile(accept, onLoad) {
  const input = $('#file-input');
  input.accept = accept;
  input.value = '';
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (file) onLoad(file);
  };
  input.click();
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || typeof data !== 'object' || !('patients' in data)) {
        throw new Error('Not a Caseload Manager backup');
      }
      state = migrate(data);
      seedStageAnchors();
      await save();
      toast('Backup restored successfully.', 'success');
    } catch (err) {
      console.error(err);
      toast('Could not read that file — is it a valid backup?', 'error');
    }
  };
  reader.onerror = () => toast('Failed to read the file.', 'error');
  reader.readAsText(file);
}

/* --------------------------------------------------------------------------
 * 9.5 CSV Import Engine
 * ------------------------------------------------------------------------ */

/** Aliases for auto-detecting IAPTUS columns (normalised: lowercased, no punctuation). */
const FIELD_ALIASES = {
  patientId:   ['patientid', 'clientid', 'caseloadid', 'caseid', 'id', 'ref', 'reference', 'nhsnumber', 'usid', 'serviceuserid'],
  name:        ['name', 'patientname', 'clientname', 'fullname', 'serviceuser', 'servicename'],
  pathway:     ['pathway', 'currentstage', 'stage', 'pathwaystage', 'currentpathway', 'step', 'steptype', 'treatmentpathway'],
  daysInStage: ['daysinstage', 'dayswaiting', 'waitingdays', 'days', 'waitingtime', 'timeinstage', 'timeinpathway', 'daysawaiting', 'daysinstep'],
  status:      ['status', 'currentstatus', 'casestatus', 'dischargestatus', 'caseloadstatus', 'pathwaystatus'],
  cmsStatus:   ['cmsstatus', 'cms', 'supervision', 'supervisionstatus', 'cmssupervision', 'supervisionstage'],
};

const normalizeHeader = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Guess the delimiter (comma / semicolon / tab) from the first data line. */
function detectDelimiter(text) {
  const line = (text.split('\n').find((l) => l.trim()) || '');
  let inQuotes = false;
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  let best = ',', bestN = 0;
  for (const d of [',', ';', '\t']) if (counts[d] > bestN) { bestN = counts[d]; best = d; }
  return best;
}

/**
 * Robust CSV parser: handles quoted fields, escaped quotes,
 * CRLF/LF endings and a BOM. Returns { rows, delimiter }.
 */
function parseCSV(text, delimiter) {
  text = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!delimiter) delimiter = detectDelimiter(text);

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }  // escaped quote
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  // Drop trailing blank rows.
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0].trim() === '') rows.pop();
  return { rows, delimiter };
}

/** Auto-map file headers to our schema using the alias table. */
function autoMap(headers) {
  const norm = headers.map(normalizeHeader);
  const mapping = {};
  for (const field of Object.keys(FIELD_ALIASES)) {
    const i = norm.findIndex((h) => FIELD_ALIASES[field].includes(h));
    mapping[field] = i >= 0 ? headers[i] : '';
  }
  return mapping;
}

/**
 * Upsert patients from parsed CSV rows.
 * - patientId is the key; existing patients keep their tasks/colorTag/notes/flags.
 * - Empty or malformed cells are handled gracefully (never crash).
 * Returns a summary: { added, updated, skipped }.
 */
function upsertPatients(headers, rows, mapping) {
  const idx = {};
  for (const [field, header] of Object.entries(mapping)) {
    idx[field] = header ? headers.indexOf(header) : -1;
  }

  const get = (field, i, fallback = '') => {
    const c = idx[field];
    if (c < 0) return fallback;
    const v = String(rows[i][c] ?? '').trim();
    return v === '' ? fallback : v;
  };

  const summary = { added: 0, updated: 0, skipped: 0 };
  const now = new Date().toISOString();

  for (let i = 0; i < rows.length; i++) {
    const patientId = get('patientId', i);
    if (!patientId) { summary.skipped++; continue; }

    const name = get('name', i, patientId);
    const pathway = get('pathway', i);
    const status = get('status', i);
    const cmsStatus = get('cmsStatus', i);
    const daysParsed = Number(get('daysInStage', i, '0'));
    const daysInStage = Number.isFinite(daysParsed) ? daysParsed : 0;

    const existing = state.patients.find((p) => p.patientId === patientId);
    if (existing) {
      // Update live fields only — never touch tasks, colorTag or notes.
      existing.name = name;
      if (pathway) existing.pathway = pathway;
      existing.daysInStage = daysInStage;   // refresh wait time each import
      existing.daysInStageAsOf = todayISO(); // ...and restart its daily tick
      if (status) existing.status = status;
      if (cmsStatus) existing.cmsStatus = cmsStatus;
      existing.updatedAt = now;
      summary.updated++;
    } else {
      state.patients.push({
        patientId, name, pathway, daysInStage, status, cmsStatus,
        colorTag: null, notes: '',
        updatedAt: now, daysInStageAsOf: todayISO(),
      });
      summary.added++;
    }
  }
  return summary;
}

/* ---- Import modal UI ---- */

let importSession = null; // { fileName, headers, rows, mapping, delimiter }

function openImportModal() {
  importSession = null;
  openModal({
    title: 'Import caseload CSV',
    body: importDropzoneHTML(),
    actions: [{ label: 'Cancel', onClick: closeModal }],
  });
  bindDropzone();
}

function importDropzoneHTML() {
  return `
    <div class="dropzone" id="import-dropzone" data-action="dropzone" role="button" tabindex="0" aria-label="Upload CSV">
      <div class="dropzone__icon" aria-hidden="true">📄</div>
      <p><strong>${importSession ? 'Choose a different file?' : 'Drop your IAPTUS CSV here'}</strong></p>
      <p class="dropzone__hint">or click to browse · parsed locally in your browser, never uploaded</p>
    </div>
    <input type="file" id="import-file" accept=".csv,text/csv" hidden data-action="import-file" />
    <div class="btn-row" style="margin-top:var(--space-4)">
      <button class="btn" data-action="download-sample-csv">Download sample CSV</button>
    </div>`;
}

function bindDropzone() {
  const zone = $('#import-dropzone');
  if (!zone) return;
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dropzone--over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dropzone--over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dropzone--over');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleCSVFile(file);
  });
}

function handleCSVFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const { rows, delimiter } = parseCSV(reader.result);
      if (!rows.length) { toast('That CSV looks empty.', 'error'); return; }
      const headers = rows.shift().map((h) => String(h).trim());
      if (headers.length < 2) { toast('Only found one column — is this a valid CSV?', 'error'); return; }
      // Drop rows that are entirely blank (trailing newlines, stray separators).
      const dataRows = rows.filter((r) => r.some((c) => String(c).trim() !== ''));
      if (!dataRows.length) { toast('That CSV has column headers but no data rows.', 'error'); return; }
      const blank = rows.length - dataRows.length;
      importSession = { fileName: file.name, headers, rows: dataRows, mapping: autoMap(headers), delimiter };
      renderImportMapping();
      const auto = Object.values(importSession.mapping).filter(Boolean).length;
      toast(`Read ${dataRows.length} row${dataRows.length === 1 ? '' : 's'} from ${file.name}`
        + `${auto ? ` — auto-mapped ${auto} field${auto === 1 ? '' : 's'}` : ' — please map the columns'}.`
        + `${blank ? ` (${blank} blank row${blank === 1 ? '' : 's'} ignored)` : ''}`, 'success');
    } catch (err) {
      console.error(err);
      toast('Could not parse that CSV.', 'error');
    }
  };
  reader.onerror = () => toast('Failed to read the file.', 'error');
  reader.readAsText(file);
}

function renderImportMapping() {
  const s = importSession;
  const fieldOptions = (current) =>
    ['<option value="">— select column —</option>']
      .concat(s.headers.map((h) => `<option value="${esc(h)}" ${h === current ? 'selected' : ''}>${esc(h)}</option>`))
      .join('');

  const fields = [
    ['patientId', 'Patient ID (unique) *'],
    ['name', 'Name'],
    ['pathway', 'Pathway / stage'],
    ['daysInStage', 'Days in stage / waiting time'],
    ['status', 'Status'],
    ['cmsStatus', 'CMS status'],
  ];

  const preview = s.rows.slice(0, 5);
  const delim = s.delimiter === '\t' ? 'tab' : s.delimiter;

  // Flag duplicated Patient IDs so the user knows later rows will update earlier ones.
  const idCol = s.mapping.patientId ? s.headers.indexOf(s.mapping.patientId) : -1;
  let dupes = 0;
  if (idCol >= 0) {
    const seen = new Set();
    s.rows.forEach((r) => {
      const id = String(r[idCol] ?? '').trim();
      if (!id) return;
      if (seen.has(id)) dupes++; else seen.add(id);
    });
  }
  const dupeNote = dupes
    ? `<p class="field-row__hint hint--warning" style="margin-top:var(--space-2)">
        ${dupes} duplicate Patient ID${dupes === 1 ? '' : 's'} detected — later rows will update earlier ones (nothing is duplicated).
      </p>` : '';

  openModal({
    title: 'Import caseload CSV',
    body: `
      ${importDropzoneHTML()}
      <div class="import-meta">📎 ${esc(s.fileName)} · ${s.rows.length} rows · delimiter "<span class="mono">${esc(delim)}</span>"</div>

      <div class="panel" style="margin-top:var(--space-4)">
        <h2 class="panel__title">Map columns</h2>
        <div class="mapping">
          ${fields.map(([f, label]) => `
            <label class="mapping__row">
              <span>${label}</span>
              <select data-action="import-mapping" data-field="${f}">${fieldOptions(s.mapping[f])}</select>
            </label>`).join('')}
        </div>
        <p class="field-row__hint" style="margin-top:var(--space-2)">
          * Required. Rows without a Patient ID are skipped on import.
        </p>
        ${dupeNote}
      </div>

      <div class="panel" style="margin-top:var(--space-4)">
        <h2 class="panel__title">Preview <span class="field-row__hint">(first ${preview.length} of ${s.rows.length} rows)</span></h2>
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr>${s.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
            <tbody>${preview.map((r) =>
              `<tr>${r.slice(0, s.headers.length).map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
          </table>
        </div>
      </div>

      <div class="btn-row" style="justify-content:flex-end;margin-top:var(--space-5)">
        <button class="btn btn--primary" data-action="run-import" ${s.mapping.patientId ? '' : 'disabled'}>
          Import ${s.rows.length} patient${s.rows.length === 1 ? '' : 's'}
        </button>
      </div>`,
    actions: [{ label: 'Cancel', onClick: closeModal }],
  });
}

function runImport() {
  const s = importSession;
  if (!s || !s.mapping.patientId) return;
  const res = upsertPatients(s.headers, s.rows, s.mapping);
  importSession = null;
  closeModal();
  toast(`Import complete — ${res.added} new, ${res.updated} updated, ${res.skipped} skipped.`, 'success', 5000);
  if (!location.hash.startsWith('#/caseload')) location.hash = '#/caseload';
  save();
}

function downloadSampleCSV() {
  const sample = 'Patient ID,Name,Current Stage,Days in Stage,Status,CMS Status\n' +
    'IAP-2001,Example Patient,Assessment,12,Active,In supervision\n' +
    'IAP-2002,Second Example Patient,Treatment,30,Active,\n' +
    'IAP-2003,Waiting List Example,Waiting List,64,Waiting,Awaiting supervision\n';
  const blob = new Blob([sample], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'caseload_template.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('Sample CSV downloaded.', 'success');
}

/* --------------------------------------------------------------------------
 * 10. Demo data
 * ------------------------------------------------------------------------ */
function buildDemoState() {
  const s = defaultState();
  const today = todayISO();
  const people = [
    ['IAP-1001', 'Alex Morgan',  'Treatment',    42, 'Active',  'Weekly'],
    ['IAP-1002', 'Priya Shah',   'Assessment',    9, 'Active',  ''],
    ['IAP-1003', 'Tom Reed',     'Waiting List', 67, 'Waiting', 'Awaiting supervision'],
    ['IAP-1004', 'Grace Okafor', 'Treatment',    21, 'Active',  'Fortnightly'],
    ['IAP-1005', 'Sam Whitfield','Assessment',    3, 'Active',  ''],
  ];
  const colors = ['#0f766e', '#b4690e', '#2a5db0', '#7c3aed', '#c0342b'];
  s.patients = people.map(([id, name, pathway, days, status, cmsStatus], i) => ({
    patientId: id, name, pathway, daysInStage: days, status, cmsStatus,
    colorTag: colors[i % colors.length],
    notes: '', updatedAt: new Date().toISOString(), daysInStageAsOf: today,
  }));

  s.tasks = [
    { title: 'Complete PHQ-9 review',        patientId: 'IAP-1001', dueDate: addDays(today, -3), priority: 'high',   estimatedMinutes: 30, dreadScore: 4 },
    { title: 'Book follow-up session',        patientId: 'IAP-1001', dueDate: addDays(today, 1),  priority: 'medium', estimatedMinutes: 15, dreadScore: 2 },
    { title: 'Send assessment letter',        patientId: 'IAP-1002', dueDate: today,             priority: 'high',   estimatedMinutes: 15, dreadScore: 3 },
    { title: 'Chase GP referral details',     patientId: 'IAP-1003', dueDate: addDays(today, -8), priority: 'medium', estimatedMinutes: 5,  dreadScore: 2 },
    { title: 'Update care plan',              patientId: 'IAP-1004', dueDate: addDays(today, 2),  priority: 'low',    estimatedMinutes: 60, dreadScore: 3 },
    { title: 'Draft session summary',         patientId: 'IAP-1005', dueDate: today,             priority: 'medium', estimatedMinutes: 5,  dreadScore: 1 },
    { title: 'Order outcome measures stock',  patientId: null,       dueDate: addDays(today, 5),  priority: 'low',    estimatedMinutes: 15, dreadScore: 1 },
  ].map((t) => ({
    taskId: uuid(), patientId: t.patientId, title: t.title, dueDate: t.dueDate,
    priority: t.priority,
    estimatedMinutes: t.estimatedMinutes,
    dreadScore: t.dreadScore,
    isCompleted: false, completedAt: null,
    allocatedDate: null,
  }));

  // Plan the 5-minute quick wins for today so the plan bar starts populated,
  // plus every task due today (they auto-join the plan — matches the app).
  s.tasks.filter((t) => t.estimatedMinutes <= 5 || (t.dueDate === today && (!t.isCompleted))).forEach((t) => { t.allocatedDate = today; });
  s.meta.autoPlannedDate = today;

  s.diary = [
    { title: 'Supervision',            date: today,             startTime: '09:00', endTime: '10:00', category: 'non-clinical', patientId: null, recurrence: { freq: 'weekly', interval: 1, weekdays: [], until: null } },
    { title: 'Assessment — P. Shah',   date: today,             startTime: '11:00', endTime: '12:00', category: 'clinical',     patientId: 'IAP-1002' },
    { title: 'Treatment — A. Morgan',  date: today,             startTime: '13:30', endTime: '14:30', category: 'clinical',     patientId: 'IAP-1001' },
    { title: 'Admin catch-up',         date: today,             startTime: '15:00', endTime: '16:00', category: 'admin',        patientId: null },
    { title: 'Treatment — G. Okafor',  date: addDays(today, -1), startTime: '10:00', endTime: '11:00', category: 'clinical',     patientId: 'IAP-1004' },
    { title: 'Team meeting',           date: addDays(today, -1), startTime: '14:00', endTime: '15:00', category: 'non-clinical', patientId: null, recurrence: { freq: 'weekly', interval: 1, weekdays: [], until: null } },
    { title: 'Assessment — S. Whitfield', date: addDays(today, 1), startTime: '09:30', endTime: '10:30', category: 'clinical',   patientId: 'IAP-1005' },
    { title: 'Notes & letters',        date: addDays(today, 1), startTime: '16:00', endTime: '17:00', category: 'admin',        patientId: null },
  ].map((e) => ({ eventId: uuid(), ...e }));

  s.meta.backend = Storage.backend;
  return migrate(s);
}

/* --------------------------------------------------------------------------
 * 11. Event wiring (event delegation)
 * ------------------------------------------------------------------------ */
// A fixed-position caseload menu follows its row as the container scrolls.
window.addEventListener('scroll', () => { if (caseloadMenuId) refreshCaseloadMenu(); }, true);
window.addEventListener('resize', () => { if (caseloadMenuId) refreshCaseloadMenu(); });

document.addEventListener('click', async (e) => {
  // Close modal on backdrop click
  if (e.target.id === 'modal-root') return closeModal();

  // Close the caseload context menu unless interacting with it.
  if (caseloadMenuId && !e.target.closest('.row-menu') && !e.target.closest('[data-action="toggle-rownav"]')) {
    caseloadMenuId = null;
    const route = ROUTES.find((r) => r.id === currentRouteId());
    if (route && route.render === renderCaseload) renderView();
  }

  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  switch (action) {
    case 'toggle-task': {
      const task = state.tasks.find((t) => t.taskId === el.dataset.id);
      if (task) {
        const completing = !task.isCompleted;
        // Play the tick/shrink animation on the check before the list updates.
        el.classList.add(completing ? 'task-row__check--checking' : 'task-row__check--unchecking');
        await new Promise((r) => setTimeout(r, completing ? 240 : 180));
        task.isCompleted = completing;
        task.completedAt = completing ? new Date().toISOString() : null;
        if (completing) celebrate();
        await save();
        refreshFocusModal();
      }
      break;
    }
    case 'delete-task': {
      state.tasks = state.tasks.filter((t) => t.taskId !== el.dataset.id);
      toast('Task deleted.');
      await save();
      refreshFocusModal();
      break;
    }
    case 'load-demo': {
      state = buildDemoState();
      await save();
      toast('Demo data loaded.', 'success');
      break;
    }
    case 'export-json':
      exportJSON();
      break;
    case 'import-json':
      pickFile('.json,application/json', importJSON);
      break;
    case 'open-import':
      openImportModal();
      break;
    case 'dropzone':
      $('#import-file').click();
      break;
    case 'run-import':
      runImport();
      break;
    case 'download-sample-csv':
      downloadSampleCSV();
      break;
    case 'download-recovered': {
      const raw = Storage.getRecovered();
      if (!raw) { toast('No recovered file to download.', 'error'); break; }
      const blob = new Blob([raw], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `caseload_recovered_${todayISO()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast('Recovered file downloaded.', 'success');
      break;
    }
    case 'clear-recovered':
      Storage.clearRecovered();
      toast('Recovered file discarded.');
      await save();
      break;
    case 'reset-all':
      confirmReset();
      break;
    case 'close-modal':
      closeModal();
      break;
    case 'modal-action': {
      const fn = ($('#modal-root')._actions || [])[Number(el.dataset.index)];
      if (fn && typeof fn.onClick === 'function') fn.onClick();
      break;
    }

    // ---- Sidebar shell (Phase A) ----
    case 'toggle-sidebar': {
      const sb = $('#sidebar');
      const open = !sb.classList.contains('sidebar--open');
      sb.classList.toggle('sidebar--open', open);
      const bd = $('#sidebar-backdrop');
      if (bd) bd.hidden = !open;
      el.setAttribute('aria-expanded', String(open));
      break;
    }
    case 'close-sidebar':
      closeSidebar();
      break;
    case 'toggle-sidebar-collapse':
      // Collapse behaviour removed
      break;
    case 'open-focus':
      openFocusModal(el.dataset.focus);
      break;
    case 'focus-toggle-plan': {
      const task = state.tasks.find((t) => t.taskId === el.dataset.id);
      if (task) {
        const planned = plannedToday(task);
        task.allocatedDate = planned ? null : todayISO();
        if (!planned) toast('Added to today’s plan.');
        await save();
        openFocusModal(el.dataset.focus, task.taskId);
      }
      break;
    }
    case 'focus-add-all': {
      const list = focusTasks(el.dataset.focus).filter((t) => !plannedToday(t));
      list.forEach((t) => { t.allocatedDate = todayISO(); });
      if (list.length) toast(`${list.length} task${list.length === 1 ? '' : 's'} added to today.`, 'success');
      await save();
      openFocusModal(el.dataset.focus);
      break;
    }
    case 'toggle-card': {
      const id = el.dataset.card;
      const map = state.settings.todayCollapsed || (state.settings.todayCollapsed = {});
      map[id] = !map[id];
      // Toggle in place (keeps scroll position) and persist without a re-render.
      const panel = el.closest('.panel');
      if (panel) panel.classList.toggle('panel--collapsed', map[id]);
      el.setAttribute('aria-expanded', map[id] ? 'false' : 'true');
      el.title = `${map[id] ? 'Expand' : 'Collapse'} card`;
      await Storage.save(state);
      break;
    }
    case 'smart-list': {
      state.settings.tasksView.filter = el.dataset.filter;
      closeSidebar();
      if (currentRouteId() !== 'tasks') location.hash = '#/tasks';
      else await save();
      break;
    }
    case 'goto-caseload-breach':
      state.settings.caseloadView.breachOnly = true;
      caseloadMenuId = null;
      closeSidebar();
      if (currentRouteId() !== 'caseload') location.hash = '#/caseload';
      else await save();
      break;
    case 'goto-caseload':
      closeSidebar();
      location.hash = '#/caseload';
      break;
    case 'goto-settings':
      closeSidebar();
      location.hash = '#/settings';
      break;
    case 'clear-breach':
      caseloadConfig().breachOnly = false;
      await save();
      break;

    // ---- Phase 3 caseload actions (Supervision keeps its own prefs) ----
    case 'set-caseload-mode':
      caseloadConfig().mode = el.dataset.mode;
      caseloadMenuId = null;
      await save();
      break;
    case 'path-tab':
      caseloadConfig().pathway = el.dataset.pathway;
      caseloadMenuId = null;
      await save();
      break;
    case 'sort-caseload': {
      const cfg = caseloadConfig();
      if (cfg.sortKey === el.dataset.key) cfg.dir = cfg.dir === 'asc' ? 'desc' : 'asc';
      else {
        cfg.sortKey = el.dataset.key;
        const descFirst = ['daysInStage', 'tasks', 'score'];
        cfg.dir = descFirst.includes(el.dataset.key) ? 'desc' : 'asc';
      }
      await save();
      break;
    }
    case 'toggle-rownav':
      caseloadMenuId = caseloadMenuId === el.dataset.id ? null : el.dataset.id;
      renderView();
      break;
    case 'toggle-patient-tasks': {
      const id = el.dataset.id;
      if (expandedPatients.has(id)) expandedPatients.delete(id);
      else expandedPatients.add(id);
      renderView();
      break;
    }
    case 'set-color':
      setPatientColor(el.dataset.id, el.dataset.color);
      break;
    case 'send-supervision': {
      const p = state.patients.find((x) => x.patientId === el.dataset.id);
      if (p) {
        p.cmsStatus = 'Awaiting';
        p.updatedAt = new Date().toISOString();
        caseloadMenuId = null;
        toast(`${p.name} sent to Supervision (CMS status: Awaiting).`, 'success');
        await save();
        if (drawerPatientId === p.patientId) refreshDrawerSupervision(p);
        refreshFocusModal(el.dataset.id);
      }
      break;
    }
    case 'toggle-supervision': {
      const p = state.patients.find((x) => x.patientId === el.dataset.id);
      if (!p) break;
      caseloadMenuId = null;
      const wasIn = !!(p.cmsStatus || '').trim();
      p.cmsStatus = wasIn ? '' : 'Awaiting';
      p.updatedAt = new Date().toISOString();
      toast(wasIn
        ? `${p.name} removed from Supervision.`
        : `${p.name} added to Supervision (CMS status: Awaiting).`,
      wasIn ? 'info' : 'success');
      await save();
      if (drawerPatientId === p.patientId) refreshDrawerSupervision(p);
      refreshFocusModal(el.dataset.id);
      break;
    }
    case 'add-task':
      caseloadMenuId = null;
      openTaskModal(el.dataset.id);
      break;
    case 'new-task':
      openTaskModal(null);
      break;
    case 'edit-task':
      openTaskModal(null, el.dataset.id);
      break;
    case 'allocate-task': {
      const t = state.tasks.find((x) => x.taskId === el.dataset.id);
      if (t) { t.allocatedDate = todayISO(); toast("Added to today's plan."); await save(); }
      break;
    }
    case 'unallocate-task': {
      const t = state.tasks.find((x) => x.taskId === el.dataset.id);
      if (t) { t.allocatedDate = null; await save(); }
      break;
    }
    case 'accept-suggestions': {
      const sugs = suggestForToday();
      sugs.forEach((t) => { t.allocatedDate = todayISO(); });
      toast(`${sugs.length} task${sugs.length === 1 ? '' : 's'} added to today.`, 'success');
      await save();
      break;
    }
    case 'task-filter':
      state.settings.tasksView.filter = el.dataset.filter;
      await save();
      break;
    case 'sort-tasks': {
      const cfg = state.settings.tasksView;
      const key = el.dataset.key;
      if (cfg.sort === key) cfg.dir = cfg.dir === 'asc' ? 'desc' : 'asc';
      else {
        cfg.sort = key;
        cfg.dir = ['score', 'priority', 'est', 'dread'].includes(key) ? 'desc' : 'asc';
      }
      await save();
      break;
    }
    case 'reset-weights':
      state.settings.weights = Object.assign({}, DEFAULT_WEIGHTS);
      toast('Scoring weights reset to defaults.');
      await save();
      break;
    case 'diary-prev':
      shiftDiary(-1);
      await save();
      break;
    case 'diary-next':
      shiftDiary(1);
      await save();
      break;
    case 'diary-today':
      state.settings.diaryDate = todayISO();
      await save();
      break;
    case 'diary-view':
      state.settings.diaryView = el.dataset.view || 'day';
      await save();
      break;
    case 'diary-goto-day':
      if (el.dataset.date) {
        state.settings.diaryDate = el.dataset.date;
        state.settings.diaryView = 'day';
        await save();
      }
      break;
    case 'new-event': {
      if (Date.now() - lastDragEnd < 400) break;   // a drag just created this block
      const d = el.dataset.date || state.settings.diaryDate || todayISO();
      const m = Number(el.dataset.minute);
      if (Number.isFinite(m)) {
        openEventModal({ date: d, startMin: m, endMin: m + 30 });
      } else {
        openEventModal({ date: d });
      }
      break;
    }
    case 'edit-event':
      openEventModal({ eventId: el.dataset.id, occurrenceDate: el.dataset.date || null });
      break;
    case 'diary-zoom-in':
    case 'diary-zoom-out': {
      const i = DIARY_ZOOM_LEVELS.indexOf(diaryZoomLevel());
      const step = el.dataset.action === 'diary-zoom-in' ? 1 : -1;
      const next = Math.max(0, Math.min(DIARY_ZOOM_LEVELS.length - 1, i + step));
      state.settings.diaryZoom = DIARY_ZOOM_LEVELS[next];
      await save();
      break;
    }
    case 'diary-zoom-reset':
      state.settings.diaryZoom = 1;
      await save();
      break;
    case 'new-patient':
      caseloadMenuId = null;
      openPatientModal(null);
      break;
    case 'edit-patient':
      caseloadMenuId = null;
      openPatientModal(el.dataset.id);
      break;
    case 'delete-patient':
      caseloadMenuId = null;
      confirmDeletePatient(el.dataset.id);
      break;
    case 'open-drawer':
      caseloadMenuId = null;
      openDrawer(el.dataset.id);
      break;
    case 'close-drawer':
      closeDrawer();
      break;
    case 'drawer-save-details': {
      const p = state.patients.find((x) => x.patientId === drawerPatientId);
      if (!p) break;
      const nameEl = $('#drawer-name');
      const name = String((nameEl || {}).value || '').trim();
      if (!name) {
        toast('Give the patient a name first.');
        if (nameEl) nameEl.focus();
        break;
      }
      p.name = name;
      p.pathway = String(($('#drawer-pathway') || {}).value || '').trim();
      p.status = String(($('#drawer-status') || {}).value || '').trim();
      p.cmsStatus = String(($('#drawer-cms') || {}).value || '').trim();
      const days = parseInt(($('#drawer-days') || {}).value, 10);
      p.daysInStage = Number.isFinite(days) && days > 0 ? days : 0;
      p.daysInStageAsOf = todayISO();
      p.colorTag = ($('#drawer-color') || {}).value || null;
      p.updatedAt = new Date().toISOString();
      caseloadMenuId = null;
      const pendingNotes = ($('#drawer-notes') || {}).value;   // don't lose unsaved notes
      await save();
      renderDrawer();
      const notesEl = $('#drawer-notes');
      if (notesEl && pendingNotes != null) notesEl.value = pendingNotes;
      const saveBtn = document.querySelector('[data-action="drawer-save-details"]');
      if (saveBtn) saveBtn.focus();
      toast('Patient details saved.');
      break;
    }
    case 'drawer-save-notes': {
      const p = state.patients.find((x) => x.patientId === drawerPatientId);
      if (p) {
        p.notes = ($('#drawer-notes') || {}).value || '';
        p.updatedAt = new Date().toISOString();
        await save();
        toast('Notes saved.');
      }
      break;
    }
    default:
      break;
  }
});

// Diary drag-to-create: drag across slots to block out a longer event.
let diaryDrag = null;
let diaryTaskDrag = null;

document.addEventListener('pointerdown', (e) => {
  const slot = e.target.closest('.diary-slot');
  if (!slot || (e.button != null && e.button !== 0)) return;
  const date = slot.dataset.date || null;
  diaryDrag = { date, start: Number(slot.dataset.minute), end: Number(slot.dataset.minute), moved: false };
  slot.classList.add('diary-slot--active');
});

document.addEventListener('dragstart', (e) => {
  const item = e.target.closest('.diary-suggest__item[data-drag-type="task"]');
  if (!item) return;
  const view = state.settings.diaryView || 'day';
  if (view !== 'day') { e.preventDefault(); return; }
  diaryTaskDrag = { taskId: item.dataset.taskId };
  e.dataTransfer.effectAllowed = 'copy';
  try { e.dataTransfer.setData('text/plain', item.dataset.taskId); } catch (_) {}
});

document.addEventListener('dragover', (e) => {
  if (!diaryTaskDrag) return;
  const slot = e.target.closest('.diary-slot');
  const view = state.settings.diaryView || 'day';
  if (!slot || view !== 'day') return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  document.querySelectorAll('.diary-slot--hover').forEach((s) => s.classList.remove('diary-slot--hover'));
  const startMin = Number(slot.dataset.minute) || 0;
  const task = state.tasks.find((t) => t.taskId === diaryTaskDrag.taskId);
  const est = task ? (Number(task.estimatedMinutes) || 30) : 30;
  const steps = Math.max(1, Math.ceil(est / 30));
  const track = slot.closest('.diary-track');
  const sel = track ? `.diary-slot[data-date="${slot.dataset.date}"]` : `.diary-slot[data-date="${slot.dataset.date}"]`;
  for (let i = 0; i < steps; i++) {
    const m = startMin + i * 30;
    const s = document.querySelector(`${sel}[data-minute="${m}"]`);
    if (s) s.classList.add('diary-slot--hover');
  }
  const hov = track ? track.querySelector('.diary-hover') : null;
  if (hov) {
    hov.hidden = false;
    const bandStart = Number(track.dataset.bandStart) || 0;
    const bandEnd = Number(track.dataset.bandEnd) || 1440;
    hov.style.top = `${((startMin - bandStart) / Math.max(1, bandEnd - bandStart)) * 100}%`;
    const lbl = hov.querySelector('.diary-hover__label');
    if (lbl) {
      lbl.textContent = `${fmtTime(startMin)}–${fmtTime(startMin + est)} (${est}m)`;
      lbl.hidden = false;
    }
  }
});

document.addEventListener('dragleave', (e) => {
  const slot = e.target.closest('.diary-slot');
  if (slot && !slot.contains(e.relatedTarget)) {
    document.querySelectorAll('.diary-slot--hover').forEach((s) => s.classList.remove('diary-slot--hover'));
  }
});

document.addEventListener('drop', async (e) => {
  if (!diaryTaskDrag) return;
  const slot = e.target.closest('.diary-slot');
  const view = state.settings.diaryView || 'day';
  if (!slot || view !== 'day') { diaryTaskDrag = null; document.querySelectorAll('.diary-slot--hover').forEach((s) => s.classList.remove('diary-slot--hover')); return; }
  e.preventDefault();
  document.querySelectorAll('.diary-slot--hover').forEach((s) => s.classList.remove('diary-slot--hover'));
  const date = slot.dataset.date || state.settings.diaryDate || todayISO();
  const startMin = Number(slot.dataset.minute) || minutesOf(state.settings.workdayStart);
  const task = state.tasks.find((t) => t.taskId === diaryTaskDrag.taskId);
  diaryTaskDrag = null;
  if (!task) return;
  const est = Number(task.estimatedMinutes) || 30;
  const endMin = startMin + Math.max(15, est);
  // Allocate to today if it's today
  if (date === todayISO()) {
    if (!state.todayPlan) state.todayPlan = [];
    if (!state.todayPlan.some((a) => a.taskId === task.taskId)) {
      state.todayPlan.push({ taskId: task.taskId, addedAt: new Date().toISOString() });
    }
  }
  // Create diary event
  const id = 'ev_' + Math.random().toString(36).slice(2, 10);
  state.diary = state.diary || [];
  state.diary.push({
    eventId: id,
    title: task.title,
    date,
    startTime: fmtTime(startMin),
    endTime: fmtTime(endMin),
    category: 'clinical',
    patientId: task.patientId || null,
    taskId: task.taskId,
    recurrence: { freq: 'none', interval: 1, weekdays: [], until: null },
  });
  task.updatedAt = new Date().toISOString();
  await save();
  renderView();
  toast('Added to diary');
});

document.addEventListener('dragend', () => {
  diaryTaskDrag = null;
  document.querySelectorAll('.diary-slot--hover').forEach((s) => s.classList.remove('diary-slot--hover'));
});

document.addEventListener('pointerover', (e) => {
  if (!diaryDrag) return;
  const slot = e.target.closest('.diary-slot');
  if (!slot || (slot.dataset.date || null) !== diaryDrag.date) return;   // stay within one day column
  const m = Number(slot.dataset.minute);
  if (m !== diaryDrag.start) diaryDrag.moved = true;
  diaryDrag.end = m;
  document.querySelectorAll('.diary-slot--active').forEach((s) => s.classList.remove('diary-slot--active'));
  const a = Math.min(diaryDrag.start, m), b = Math.max(diaryDrag.start, m);
  const sel = diaryDrag.date ? `.diary-slot[data-date="${diaryDrag.date}"]` : '.diary-slot';
  for (let x = a; x <= b; x += 30) {
    const s = document.querySelector(`${sel}[data-minute="${x}"]`);
    if (s) s.classList.add('diary-slot--active');
  }
});

document.addEventListener('pointerup', () => {
  if (!diaryDrag) return;
  const drag = diaryDrag;
  diaryDrag = null;
  document.querySelectorAll('.diary-slot--active').forEach((s) => s.classList.remove('diary-slot--active'));
  if (!drag.moved) return;   // a simple click is handled by the click listener
  const a = Math.min(drag.start, drag.end);
  const b = Math.max(drag.start, drag.end) + 30;
  lastDragEnd = Date.now();  // stop the trailing click from opening a second modal
  openEventModal({ date: drag.date || state.settings.diaryDate || todayISO(), startMin: a, endMin: b });
});

// Diary hover guide: a faint line + time chip that follows the pointer.
function hideDiaryHovers(except) {
  document.querySelectorAll('.diary-hover').forEach((h) => { if (h !== except) h.hidden = true; });
}
document.addEventListener('pointermove', (e) => {
  if (diaryDrag) { hideDiaryHovers(null); return; }
  const track = e.target && e.target.closest ? e.target.closest('.diary-track') : null;
  if (!track || !track.dataset.bandStart) { hideDiaryHovers(null); return; }
  const start = Number(track.dataset.bandStart);
  const end = Number(track.dataset.bandEnd);
  const rect = track.getBoundingClientRect();
  if (!rect.height || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
  const frac = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
  const mins = Math.round((start + frac * (end - start)) / 5) * 5;
  const hov = track.querySelector('.diary-hover');
  if (!hov) return;
  hideDiaryHovers(hov);
  hov.hidden = false;
  hov.style.top = `${((mins - start) / (end - start)) * 100}%`;
  const lbl = hov.querySelector('.diary-hover__label');
  if (lbl) { lbl.textContent = fmtTime(mins); lbl.hidden = rect.width < 140; }
});
document.addEventListener('pointerleave', () => hideDiaryHovers(null));
window.addEventListener('blur', () => hideDiaryHovers(null));


// Live caseload search without losing input focus
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-action="search-caseload"]');
  if (!el) return;
  caseloadConfig().search = el.value;
  const body = $('#caseload-body');
  if (body) body.innerHTML = caseloadBodyHTML();
});

function setPatientColor(patientId, color) {
  const p = state.patients.find((x) => x.patientId === patientId);
  if (!p) return;
  p.colorTag = color || null;
  caseloadMenuId = null;
  save();
}

// Theme <select> in settings + import modal controls
document.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;

  if (el.dataset.action === 'set-theme') {
    state.settings.theme = el.value;
    await save();
    return;
  }
  if (el.dataset.action === 'set-density') {
    state.settings.density = el.value;
    await save();
    return;
  }
  if (el.dataset.action === 'set-textsize') {
    state.settings.textSize = el.value;
    await save();
    return;
  }
  if (el.dataset.action === 'import-file') {
    const file = el.files && el.files[0];
    if (file) handleCSVFile(file);
    return;
  }
  if (el.dataset.action === 'import-mapping') {
    if (!importSession) return;
    importSession.mapping[el.dataset.field] = el.value;
    // Re-enable the Import button only once a Patient ID column is chosen.
    const btn = $('#modal-root [data-action="run-import"]');
    if (btn) btn.disabled = !importSession.mapping.patientId;
    return;
  }
  if (el.dataset.action === 'group-caseload') {
    caseloadConfig().groupBy = el.value;
    caseloadMenuId = null;
    await save();
    return;
  }
  if (el.dataset.action === 'color-custom') {
    // Native colour input — apply the chosen value as the patient tag.
    const p = state.patients.find((x) => x.patientId === el.dataset.id);
    if (p) {
      p.colorTag = el.value;
      caseloadMenuId = null;
      await save();
      toast(`Colour set for ${p.name}.`);
    }
    return;
  }
  if (el.dataset.action === 'task-group') {
    state.settings.tasksView.groupBy = el.value;
    await save();
    return;
  }
  if (el.dataset.action === 'set-weight') {
    state.settings.weights[el.dataset.weight] = Number(el.value) || 0;
    await save();
    return;
  }
  if (el.dataset.action === 'set-setting') {
    const key = el.dataset.key;
    const type = el.dataset.type;
    state.settings[key] = type === 'boolean' ? el.checked
      : type === 'number' ? Number(el.value)
      : el.value;
    await save();
    return;
  }
  if (el.dataset.action === 'diary-date') {
    state.settings.diaryDate = el.value || todayISO();
    await save();
    return;
  }
});

// Theme <select> in the header
const themeToggle = $('#theme-toggle');
if (themeToggle) {
  themeToggle.addEventListener('click', async () => {
    const current = state.settings.theme || 'light';
    state.settings.theme = current === 'dark' ? 'light' : 'dark';
    await save();
    updateThemeToggle();
  });
}

function updateThemeToggle() {
  const btn = $('#theme-toggle');
  if (!btn) return;
  const t = state.settings.theme || 'light';
  btn.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  btn.setAttribute('title', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  const icon = btn.querySelector('.theme-toggle__icon');
  const label = btn.querySelector('.theme-toggle__label');
  if (icon) icon.textContent = t === 'dark' ? '☾' : '☼';
  if (label) label.textContent = t === 'dark' ? 'Dark' : 'Light';
}

// Inline quick-add (Tasks view): submit via Enter or the Add button.
document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-action="quick-add-form"]');
  if (!form) return;
  e.preventDefault();
  if (createQuickTask()) {
    render();                                   // refresh lists + counts
    const input = $('#quick-add-input');
    if (input) input.focus();
  }
});

// Escape closes modal, then drawer; Tab is trapped inside an open modal
document.addEventListener('keydown', (e) => {
  // Ctrl/Cmd+K opens the command palette from anywhere
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    if (paletteEls && !paletteEls.root.hidden) closePalette(); else openPalette();
    return;
  }
  // Alt+E opens the quick task entry from anywhere (unless a modal is already open)
  if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'e' || e.key === 'E')) {
    e.preventDefault();
    if ($('#modal-root').hidden) openTaskModal(null);
    return;
  }
  // Enter in a drawer detail field saves the details (they're not inside a <form>)
  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const t = e.target;
    if (t && t.closest && t.closest('#drawer-content')
        && t.matches('#drawer-name, #drawer-pathway, #drawer-status, #drawer-days')) {
      e.preventDefault();
      const saveBtn = document.querySelector('[data-action="drawer-save-details"]');
      if (saveBtn) saveBtn.click();
      return;
    }
  }
  const modalOpen = !$('#modal-root').hidden;
  if (e.key === 'Tab' && modalOpen) {
    const items = [...$('#modal-root').querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    if (items.length) {
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    return;
  }
  if (e.key !== 'Escape') return;
  if (paletteEls && !paletteEls.root.hidden) return closePalette();
  if (modalOpen) return closeModal();
  if ($('#drawer-root').classList.contains('open')) return closeDrawer();
});

function confirmReset() {
  openModal({
    title: 'Reset everything?',
    body: '<p>This permanently deletes all patients, tasks and diary events from this device. Export a backup first if you are unsure.</p>',
    actions: [
      { label: 'Cancel', onClick: closeModal },
      { label: 'Delete everything', variant: 'danger', onClick: async () => {
        state = defaultState();
        await Storage.clear();
        await save();
        closeModal();
        toast('All data reset.', 'success');
      } },
    ],
  });
}

/* --------------------------------------------------------------------------
 * 12. Theming & storage pill
 * ------------------------------------------------------------------------ */
function applyTheme() {
  const theme = state.settings.theme || 'light';
  document.documentElement.setAttribute('data-theme', theme);
  updateThemeToggle();
}

/** Diary timeline zoom levels. 1 = fill the screen; higher = taller grid. */
const DIARY_ZOOM_LEVELS = [1, 1.25, 1.5, 2, 2.5];
function diaryZoomLevel() {
  const z = Number(state.settings.diaryZoom);
  return DIARY_ZOOM_LEVELS.includes(z) ? z : 1;
}

/** Density (how much fits on screen), text-size scale and diary zoom are
 *  attribute/variable-driven so CSS owns the numbers and each can be flipped
 *  live from Settings or the diary toolbar. */
function applyDensity() {
  const compact = state.settings.density === 'compact';
  const root = document.documentElement;
  root.setAttribute('data-density', compact ? 'compact' : 'comfy');
  root.setAttribute('data-textsize', state.settings.textSize || 'md');
  root.style.setProperty('--diary-zoom', String(diaryZoomLevel()));
}

/** Collapse/expand the top navigation (persisted). */
function applyLayout() {
  const app = $('#app');
  if (app) app.classList.remove('sidebar--collapsed');
}

function refreshStoragePill() {
  const pill = $('#storage-pill');
  if (pill) {
    const label = Storage.backend === 'indexedDB' ? 'IndexedDB' : 'localStorage';
    pill.textContent = `Storage: ${label}`;
  }
}

/* --------------------------------------------------------------------------
 * 13. Service worker (PWA) — only over http(s), never file://
 * ------------------------------------------------------------------------ */
function showOfflineReady() {
  const pill = $('#pwa-pill');
  if (pill) pill.hidden = false;
}

/** Reflect online/offline state and reassure the user the app still works. */
function watchConnectivity() {
  const sync = () => document.documentElement.classList.toggle('is-offline', navigator.onLine === false);
  window.addEventListener('offline', () => {
    sync();
    toast('You’re offline — the app keeps working from the cache.', 'info', 5000);
  });
  window.addEventListener('online', () => {
    sync();
    toast('Back online.', 'success');
  });
  sync();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!/^https?:$/.test(location.protocol)) return;
  if (navigator.serviceWorker.controller) showOfflineReady();
  navigator.serviceWorker.addEventListener('controllerchange', showOfflineReady);
  navigator.serviceWorker.register('sw.js')
    .then(() => { if (navigator.serviceWorker.controller) showOfflineReady(); })
    .catch((err) => console.warn('Service worker registration failed:', err));
}

/* --------------------------------------------------------------------------
 * 14. Boot
 * ------------------------------------------------------------------------ */
(async function init() {
  await Storage.init();
  const loaded = await Storage.load();
  const wasCorrupt = Storage.justRecovered;
  state = loaded || defaultState();
  // Give any patient saved before the live wait counter a fresh anchor so their
  // days in stage starts ticking from today (never jumping), then persist it.
  const seededWaitAnchors = seedStageAnchors();
  // Auto-merge any due-today tasks into today's plan (once per day).
  if (autoPlanDueToday() || seededWaitAnchors) await Storage.save(state);
  if (!location.hash) location.hash = '#/today';
  render();
  updateThemeToggle();
  const navSearch = document.getElementById('nav-search-btn');
  if (navSearch) navSearch.addEventListener('click', (e) => { e.preventDefault(); openPalette(); });
  registerServiceWorker();
  watchConnectivity();
  setInterval(tickDiaryClocks, 30000);
  if (wasCorrupt) {
    toast('Your saved data could not be read — the app started fresh. A recovery copy was kept (see Settings).', 'error', 9000);
  }
})();
