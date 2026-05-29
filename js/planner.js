import {
  loadThemes,
  normalizeThemeId,
  setCurrentThemeId,
  applyThemeClass,
  applyEventColors,
  getCurrentThemeId,
} from './modules/theme.js';

import {
  loadPlanner,
  savePlanner,
  makeItemId,
  makeSessionId,
  exportPlannerJson,
  parsePlannerImport,
  savePlannerViaApi,
  loadGlobal,
  saveGlobal,
} from './modules/plannerStorage.js';

import { escapeHtml, parseSponsorIds } from './modules/utils.js';

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  eventFile: null,
  eventMeta: null,
  allSessions: [],
  planner: null,
  global: null,
  activeTab: 'personal',
  notesSearchQuery: '',
  tasksFilter: 'all',
  dirty: false,
};

// ── Utilities ────────────────────────────────────────────────────────────────

const esc = escapeHtml;

function getTimezone() {
  return state.eventMeta?.timezone || undefined;
}

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', timeZone: getTimezone(),
  });
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: getTimezone(),
  });
}

function groupByDate(sessions) {
  const groups = {};
  sessions.forEach((s) => {
    const key = new Date(s.startTime).toLocaleDateString('en-CA', { timeZone: getTimezone() });
    (groups[key] ??= []).push(s);
  });
  return groups;
}

function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Toast & dirty state ──────────────────────────────────────────────────────

let _toastTimer = null;

function showToast() {
  const el = document.getElementById('plannerSaveToast');
  if (!el) return;
  clearTimeout(_toastTimer);
  el.classList.add('is-visible');
  _toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2500);
}

function markDirty(flag) {
  state.dirty = flag;
  const el = document.getElementById('plannerDirtyState');
  if (!el) return;
  const dot = el.querySelector('i');
  const label = el.querySelector('span');
  if (flag) {
    dot?.classList.replace('text-emerald-400', 'text-amber-400');
    if (label) label.textContent = 'Unsaved changes';
  } else {
    dot?.classList.replace('text-amber-400', 'text-emerald-400');
    if (label) label.textContent = 'Saved';
  }
}

let _saveTimer = null;

function scheduleAutoSave() {
  markDirty(true);
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    savePlanner(state.eventFile, state.planner);
    markDirty(false);
    showToast();
  }, 600);
}

// ── Theme ────────────────────────────────────────────────────────────────────

function applyTheme() {
  const meta = state.eventMeta || {};
  const themeVal = meta.theme;
  const themeId = typeof themeVal === 'object' ? themeVal?.id : themeVal;
  applyThemeClass(themeId ? normalizeThemeId(themeId) : getCurrentThemeId());
  applyEventColors(
    typeof themeVal === 'object' ? themeVal?.primaryColor : meta.primaryColor,
    typeof themeVal === 'object' ? themeVal?.secondaryColor : meta.secondaryColor,
    typeof themeVal === 'object' ? themeVal?.tertiaryColor : meta.tertiaryColor,
  );
}

// ── Constants ────────────────────────────────────────────────────────────────

const CURRENCIES = ['AUD', 'USD', 'EUR', 'GBP', 'NZD', 'CHF', 'CAD', 'JPY', 'SGD']

const RECEIPT_CATEGORIES = [
  { value: 'food',          label: 'Food & Drink' },
  { value: 'travel',        label: 'Travel / Transport' },
  { value: 'accommodation', label: 'Accommodation' },
  { value: 'customer',      label: 'Customer' },
  { value: 'team',          label: 'Team' },
  { value: 'misc',          label: 'Misc' },
]

function currencyOptions(selected = 'AUD') {
  return CURRENCIES.map((c) => `<option value="${c}"${c === selected ? ' selected' : ''}>${c}</option>`).join('')
}

function tzDatalist() {
  const tzs = typeof Intl !== 'undefined' && Intl.supportedValuesOf
    ? Intl.supportedValuesOf('timeZone')
    : []
  return tzs.map((tz) => `<option value="${tz}">`).join('')
}

// Upload file to API server (saves to receipts/<event-slug>/ on disk) or,
// when no server is configured, encode as a base64 data URL stored in localStorage
// via the planner JSON. Files > 1.5 MB are rejected in the no-API path to stay
// within localStorage's ~5 MB quota.
async function uploadOrReadFile(file) {
  const apiEndpoint = localStorage.getItem('editorApiEndpoint') || '';
  if (apiEndpoint) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('eventFile', state.eventFile);
    const res  = await fetch(`${apiEndpoint.replace(/\/$/, '')}/api/receipts`, { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return { path: data.path, label: file.name };
  }
  const MAX_BYTES = 1_500_000;
  if (file.size > MAX_BYTES) {
    throw new Error(`File too large to store locally (${(file.size / 1_048_576).toFixed(1)} MB). Connect the API server to upload larger files.`);
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve({ path: reader.result, label: file.name });
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

function fileDisplayName(filePath, fileLabel) {
  if (!filePath) return '';
  return fileLabel || (filePath.startsWith('data:') ? 'Attached file' : filePath.split('/').pop());
}

function parseBudget(str) {
  const n = parseFloat(String(str || '').replace(/[^0-9.]/g, ''))
  return isNaN(n) ? 0 : n
}

// ── Tab system ───────────────────────────────────────────────────────────────

const TABS = ['contacts', 'tasks', 'sponsor', 'personal', 'team', 'documents', 'receipts', 'summary'];

const PANEL_IDS = {
  contacts:  'plannerContactsPanel',
  tasks:     'plannerTasksPanel',
  sponsor:   'plannerSponsorPanel',
  personal:  'plannerPersonalPanel',
  team:      'plannerTeamPanel',
  documents: 'plannerDocumentsPanel',
  receipts:  'plannerReceiptsPanel',
  summary:   'plannerSummaryPanel',
};

const TAB_BTN_IDS = {
  contacts:  'showContactsTab',
  tasks:     'showTasksTab',
  sponsor:   'showSponsorTab',
  personal:  'showPersonalTab',
  team:      'showTeamTab',
  documents: 'showDocumentsTab',
  receipts:  'showReceiptsTab',
  summary:   'showSummaryTab',
};

function setActiveTab(tab) {
  const next = TABS.includes(tab) ? tab : TABS[0];
  state.activeTab = next;
  TABS.forEach((t) => {
    const panel = document.getElementById(PANEL_IDS[t]);
    const btn   = document.getElementById(TAB_BTN_IDS[t]);
    const active = t === next;
    panel?.classList.toggle('hidden', !active);
    if (btn) {
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    }
  });
}

// ── Session Notes tab ────────────────────────────────────────────────────────

function starRatingHtml(sessionId, rating) {
  return [1, 2, 3, 4, 5].map((n) => {
    const filled = n <= rating;
    return `<button type="button" class="star-btn text-lg leading-none transition-colors ${filled ? 'text-yellow-400' : 'text-gray-300 hover:text-yellow-300'}"
      data-note-id="${esc(sessionId)}" data-rating="${n}" aria-label="Rate ${n} star${n > 1 ? 's' : ''}">
      <i class="${filled ? 'fas' : 'far'} fa-star"></i>
    </button>`;
  }).join('');
}

function noteCardHtml(session, note) {
  const sid = session.id;
  const time = fmtTime(session.startTime);
  const track = Array.isArray(session.track) ? session.track.join(', ') : (session.track || '');
  const hasNote = note.notes || note.rating || note.attended;

  return `
    <details class="planner-note-card rounded-md border border-gray-200 overflow-hidden" data-session-id="${esc(sid)}" ${hasNote ? 'open' : ''}>
      <summary class="flex items-center gap-3 px-4 py-3 cursor-pointer select-none hover:bg-gray-50 transition-colors list-none">
        <i class="fas fa-chevron-right note-card-chevron text-gray-400 text-xs flex-shrink-0 transition-transform"></i>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium text-gray-800 truncate">${esc(session.title)}</p>
          <p class="text-xs text-gray-500">${esc(time)}${session.location ? ` · ${esc(session.location)}` : ''}${track ? ` · ${esc(track)}` : ''}</p>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          ${note.attended ? '<span class="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">Attended</span>' : ''}
          ${note.rating ? `<span class="text-xs text-yellow-500">${'★'.repeat(note.rating)}</span>` : ''}
          ${note.notes ? '<i class="fas fa-file-lines text-gray-400 text-xs"></i>' : ''}
        </div>
      </summary>
      <div class="px-4 pb-4 pt-2 border-t border-gray-100 space-y-3 bg-white">
        <div class="flex items-center gap-6 flex-wrap">
          <label class="inline-flex items-center gap-2 cursor-pointer text-sm text-gray-700">
            <input type="checkbox" class="h-4 w-4 rounded" data-note-field="attended" data-note-id="${esc(sid)}" ${note.attended ? 'checked' : ''}>
            Attended
          </label>
          <div class="flex items-center gap-1" role="group" aria-label="Rating">
            <span class="text-sm text-gray-500 mr-1">Rating:</span>
            ${starRatingHtml(sid, note.rating)}
            ${note.rating ? `<button type="button" class="ml-1 text-xs text-gray-400 hover:text-gray-600 clear-rating-btn" data-note-id="${esc(sid)}" title="Clear rating">✕</button>` : ''}
          </div>
        </div>
        <label class="block">
          <span class="text-xs font-medium text-gray-400 block mb-1">Notes</span>
          <textarea data-note-field="notes" data-note-id="${esc(sid)}" rows="3"
            class="w-full rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white p-2 resize-y"
            placeholder="Your notes for this session…">${esc(note.notes)}</textarea>
        </label>
      </div>
    </details>`;
}

function renderNotesTab() {
  const withData = document.getElementById('notesWithData');
  const empty    = document.getElementById('notesEmptyState');
  const results  = document.getElementById('notesSearchResults');
  if (!withData) return;

  // Sessions that have non-empty notes data
  const noted = state.allSessions.filter((s) => {
    const note = state.planner.sessionNotes[s.id];
    return note && (note.notes || note.rating || note.attended);
  });

  // Clear search results when re-rendering
  if (results) { results.innerHTML = ''; results.classList.add('hidden'); }

  empty?.classList.toggle('hidden', noted.length > 0);

  if (noted.length === 0) {
    withData.innerHTML = '';
    return;
  }

  const groups = groupByDate(noted);
  const sortedDates = Object.keys(groups).sort();

  withData.innerHTML = sortedDates.map((date) => {
    const dayLabel = fmtDate(`${date}T12:00:00`);
    const cards = groups[date].map((session) => {
      const note = state.planner.sessionNotes[session.id] || {
        sessionId: session.id,
        sessionTitle: session.title,
        sessionStartTime: session.startTime,
        attended: false,
        rating: 0,
        notes: '',
      };
      return noteCardHtml(session, note);
    }).join('');
    return `
      <div class="mb-4">
        <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2 px-1">${esc(dayLabel)}</h3>
        <div class="space-y-1">${cards}</div>
      </div>`;
  }).join('');
}

function handleNoteChange(sessionId, field, value) {
  const session = state.allSessions.find((s) => s.id === sessionId);
  if (!state.planner.sessionNotes[sessionId]) {
    state.planner.sessionNotes[sessionId] = {
      sessionId,
      sessionTitle: session?.title || '',
      sessionStartTime: session?.startTime || '',
      attended: false,
      rating: 0,
      notes: '',
    };
  }
  state.planner.sessionNotes[sessionId][field] = value;
  scheduleAutoSave();
}

// ── Contacts tab ─────────────────────────────────────────────────────────────

function contactCardHtml(contact, open = false) {
  const headerText = [contact.name, contact.org].filter(Boolean).join(' · ') || 'New contact';
  return `
    <details class="rounded-md border border-gray-200 overflow-hidden" data-contact-id="${esc(contact.id)}" ${open ? 'open' : ''}>
      <summary class="flex items-center gap-3 px-4 py-3 cursor-pointer select-none hover:bg-gray-50 transition-colors list-none">
        <i class="fas fa-chevron-right text-gray-400 text-xs flex-shrink-0 transition-transform contact-chevron"></i>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium text-gray-800 truncate">${esc(headerText)}</p>
          ${contact.email ? `<p class="text-xs text-gray-500 truncate">${esc(contact.email)}</p>` : ''}
        </div>
        ${contact.followUp ? '<span class="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium flex-shrink-0">Follow up</span>' : ''}
        <button type="button" class="delete-contact-btn flex-shrink-0 text-gray-400 hover:text-red-500 transition-colors px-1" data-contact-id="${esc(contact.id)}" title="Delete contact" aria-label="Delete contact">
          <i class="fas fa-trash text-xs"></i>
        </button>
      </summary>
      <div class="px-4 pb-4 pt-3 border-t border-gray-100 bg-white">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label class="editor-form-field">
            <span class="editor-field-label">Name</span>
            <input type="text" data-contact-id="${esc(contact.id)}" data-contact-field="name" value="${esc(contact.name)}" class="h-10 w-full rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3" placeholder="Full name">
          </label>
          <label class="editor-form-field">
            <span class="editor-field-label">Organisation</span>
            <input type="text" data-contact-id="${esc(contact.id)}" data-contact-field="org" value="${esc(contact.org)}" class="h-10 w-full rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3" placeholder="Company / team">
          </label>
          <label class="editor-form-field">
            <span class="editor-field-label">Email</span>
            <input type="email" data-contact-id="${esc(contact.id)}" data-contact-field="email" value="${esc(contact.email)}" class="h-10 w-full rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3">
          </label>
          <label class="editor-form-field">
            <span class="editor-field-label">LinkedIn URL</span>
            <input type="url" data-contact-id="${esc(contact.id)}" data-contact-field="linkedin" value="${esc(contact.linkedin)}" class="h-10 w-full rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3">
          </label>
          <label class="editor-form-field sm:col-span-2">
            <span class="editor-field-label">Where / how you met</span>
            <input type="text" data-contact-id="${esc(contact.id)}" data-contact-field="whereMet" value="${esc(contact.whereMet)}" class="h-10 w-full rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3" placeholder="e.g. Session on Drupal CMS, hallway track…">
          </label>
          <label class="editor-form-field sm:col-span-2">
            <span class="editor-field-label">Notes</span>
            <textarea data-contact-id="${esc(contact.id)}" data-contact-field="notes" rows="2"
              class="w-full rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white p-2 resize-y">${esc(contact.notes)}</textarea>
          </label>
          <label class="inline-flex items-center gap-2 cursor-pointer text-sm text-gray-700 sm:col-span-2">
            <input type="checkbox" class="h-4 w-4 rounded" data-contact-id="${esc(contact.id)}" data-contact-field="followUp" ${contact.followUp ? 'checked' : ''}>
            Follow-up needed
          </label>
        </div>
      </div>
    </details>`;
}

function renderContactsTab() {
  const list  = document.getElementById('contactsList');
  const empty = document.getElementById('contactsEmptyState');
  if (!list) return;
  const contacts = state.planner.contacts;
  empty?.classList.toggle('hidden', contacts.length > 0);
  list.innerHTML = contacts.map((c, i) => contactCardHtml(c, i === 0)).join('');
}

function addContact() {
  const contact = {
    id: makeItemId('c'), name: '', org: '', email: '',
    linkedin: '', whereMet: '', followUp: false, notes: '',
  };
  state.planner.contacts.unshift(contact);
  renderContactsTab();
  scheduleAutoSave();
  // Open the first details element after render
  document.querySelector('#contactsList details')?.setAttribute('open', '');
}

function deleteContact(id) {
  state.planner.contacts = state.planner.contacts.filter((c) => c.id !== id);
  renderContactsTab();
  scheduleAutoSave();
}

function handleContactChange(id, field, value) {
  const contact = state.planner.contacts.find((c) => c.id === id);
  if (!contact) return;
  contact[field] = value;
  // Refresh the summary text without re-rendering the whole list
  const details = document.querySelector(`[data-contact-id="${id}"]`)?.closest('details');
  if (details && (field === 'name' || field === 'org' || field === 'email')) {
    const summary = details.querySelector('summary p.text-sm');
    const emailEl = details.querySelector('summary p.text-xs');
    if (summary) {
      const headerText = [contact.name, contact.org].filter(Boolean).join(' · ') || 'New contact';
      summary.textContent = headerText;
    }
    if (emailEl) emailEl.textContent = contact.email || '';
  }
  scheduleAutoSave();
}

// ── Tasks tab ────────────────────────────────────────────────────────────────

function buildSessionOptions(selectedId) {
  const none = `<option value="">— No linked session —</option>`;
  const opts = state.allSessions.map((s) => {
    const time = fmtTime(s.startTime);
    const label = `${time} ${s.title}`.slice(0, 60);
    return `<option value="${esc(s.id)}" ${s.id === selectedId ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');
  return none + opts;
}

function taskRowHtml(task) {
  return `
    <div class="flex items-start gap-3 p-3 rounded-md border border-gray-200 bg-white group" data-task-id="${esc(task.id)}">
      <input type="checkbox" class="mt-0.5 h-4 w-4 rounded flex-shrink-0" data-task-id="${esc(task.id)}" data-task-field="done" ${task.done ? 'checked' : ''} aria-label="Mark task done">
      <div class="flex-1 min-w-0 space-y-2">
        <input type="text" data-task-id="${esc(task.id)}" data-task-field="text"
          value="${esc(task.text)}"
          placeholder="What needs to be done…"
          class="w-full text-sm ${task.done ? 'line-through text-gray-400' : 'text-gray-800'} border-0 border-b border-transparent hover:border-gray-200 focus:border-gray-300 focus:ring-0 bg-transparent p-0 pb-0.5 transition-colors">
        <select data-task-id="${esc(task.id)}" data-task-field="sessionId"
          class="w-full text-xs rounded border-gray-200 text-gray-500 bg-transparent py-0.5 pr-6">
          ${buildSessionOptions(task.sessionId)}
        </select>
      </div>
      <button type="button" class="delete-task-btn flex-shrink-0 text-gray-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100 mt-0.5" data-task-id="${esc(task.id)}" title="Delete task" aria-label="Delete task">
        <i class="fas fa-trash text-xs"></i>
      </button>
    </div>`;
}

function renderTasksTab() {
  const list  = document.getElementById('tasksList');
  const empty = document.getElementById('tasksEmptyState');
  if (!list) return;

  const filter = state.tasksFilter;
  const filtered = state.planner.tasks.filter((t) => {
    if (filter === 'open') return !t.done;
    if (filter === 'done') return t.done;
    return true;
  });
  // Open tasks first, then done
  const sorted = [
    ...filtered.filter((t) => !t.done),
    ...filtered.filter((t) => t.done),
  ];

  empty?.classList.toggle('hidden', sorted.length > 0);
  list.innerHTML = sorted.map(taskRowHtml).join('');
}

function addTask() {
  state.planner.tasks.unshift({
    id: makeItemId('t'), text: '', done: false, sessionId: null,
  });
  renderTasksTab();
  scheduleAutoSave();
  list?.querySelector('input[type="text"]')?.focus();
  document.querySelector('#tasksList input[type="text"]')?.focus();
}

function deleteTask(id) {
  state.planner.tasks = state.planner.tasks.filter((t) => t.id !== id);
  renderTasksTab();
  scheduleAutoSave();
}

function handleTaskChange(id, field, value) {
  const task = state.planner.tasks.find((t) => t.id === id);
  if (!task) return;
  task[field] = field === 'done' ? Boolean(value) : (value || null);
  if (field === 'done') {
    renderTasksTab(); // re-sort on done toggle
  }
  scheduleAutoSave();
}

// ── Org tab ──────────────────────────────────────────────────────────────────

const TRAVEL_MODES = {
  flight:    { label: '✈ Flight',    icon: 'fas fa-plane-departure', returnIcon: 'fas fa-plane-arrival' },
  train:     { label: '🚂 Train',    icon: 'fas fa-train' },
  bus:       { label: '🚌 Bus',      icon: 'fas fa-bus' },
  ferry:     { label: '⛴ Ferry',    icon: 'fas fa-ship' },
  car:       { label: '🚗 Transfer', icon: 'fas fa-car' },
  taxi:      { label: '🚕 Taxi',     icon: 'fas fa-taxi' },
  rideshare: { label: '📱 Rideshare', icon: 'fas fa-car-side' },
  other:     { label: '↔ Other',    icon: 'fas fa-route' },
};

function travelIcon(mode, isReturn) {
  const m = TRAVEL_MODES[mode] || TRAVEL_MODES.other;
  return isReturn && m.returnIcon ? m.returnIcon : m.icon;
}

function sortLegs(legs) {
  return [...legs].sort((a, b) => {
    const ka = `${a.date || '9999-99-99'}${a.departTime || ''}`;
    const kb = `${b.date || '9999-99-99'}${b.departTime || ''}`;
    return ka.localeCompare(kb);
  });
}

function makeLeg() {
  return { id: makeItemId('leg'), mode: 'flight', date: '', ref: '', from: '', to: '', departTime: '', arriveTime: '', departTz: '', arriveTz: '', confirmation: '', notes: '', filePath: '', fileLabel: '', receiptId: '' };
}

function legCardHtml(leg, direction) {
  const modeOptions = Object.entries(TRAVEL_MODES)
    .map(([val, { label }]) => `<option value="${val}"${leg.mode === val ? ' selected' : ''}>${label}</option>`)
    .join('');
  const d = direction;
  const li = esc(leg.id);
  const f = (field, type = 'text', placeholder = '') =>
    `<input type="${type}" data-leg-id="${li}" data-direction="${d}" data-leg-field="${field}" value="${esc(leg[field] || '')}" placeholder="${placeholder}" class="h-8 w-full rounded border-gray-300 text-xs bg-white px-2 drupal-blue-focus">`;
  return `
    <div class="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2" data-leg-id="${li}" data-direction="${d}">
      <div class="flex items-center gap-2 flex-wrap">
        <select data-leg-id="${li}" data-direction="${d}" data-leg-field="mode"
          class="h-8 rounded border-gray-300 text-xs bg-white px-2 drupal-blue-focus flex-shrink-0">
          ${modeOptions}
        </select>
        <div class="flex-1 min-w-0 grid grid-cols-[1fr_auto_1fr] items-center gap-1">
          ${f('from', 'text', 'From')}
          <span class="text-gray-400 text-xs px-0.5">→</span>
          ${f('to', 'text', 'To')}
        </div>
        ${f('date', 'date')}
        <button type="button" class="remove-leg-btn flex-shrink-0 text-gray-300 hover:text-red-500 transition-colors"
          data-leg-id="${li}" data-direction="${d}" aria-label="Remove leg">
          <i class="fas fa-times text-xs"></i>
        </button>
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
        ${f('ref', 'text', 'Ref / number')}
        ${f('confirmation', 'text', 'Confirmation #')}
        <div></div>
        <div class="relative">
          <span class="absolute left-2 top-1/2 -translate-y-1/2 text-[0.6rem] text-gray-400 pointer-events-none">Dep</span>
          <input type="time" data-leg-id="${li}" data-direction="${d}" data-leg-field="departTime" value="${esc(leg.departTime || '')}" class="h-8 w-full rounded border-gray-300 text-xs bg-white pl-7 pr-2 drupal-blue-focus">
        </div>
        <div class="relative">
          <span class="absolute left-2 top-1/2 -translate-y-1/2 text-[0.6rem] text-gray-400 pointer-events-none">Arr</span>
          <input type="time" data-leg-id="${li}" data-direction="${d}" data-leg-field="arriveTime" value="${esc(leg.arriveTime || '')}" class="h-8 w-full rounded border-gray-300 text-xs bg-white pl-7 pr-2 drupal-blue-focus">
        </div>
        <div></div>
        <input type="text" list="tzList" data-leg-id="${li}" data-direction="${d}" data-leg-field="departTz" value="${esc(leg.departTz || '')}" placeholder="Dep timezone" class="h-8 w-full rounded border-gray-300 text-xs bg-white px-2 drupal-blue-focus">
        <input type="text" list="tzList" data-leg-id="${li}" data-direction="${d}" data-leg-field="arriveTz" value="${esc(leg.arriveTz || '')}" placeholder="Arr timezone" class="h-8 w-full rounded border-gray-300 text-xs bg-white px-2 drupal-blue-focus">
      </div>
      <div class="flex items-center gap-2 pt-2 border-t border-gray-100">
        <span class="text-[0.7rem] font-medium text-gray-400 uppercase tracking-wide flex-shrink-0">Receipt</span>
        ${leg.filePath
          ? `<a href="${esc(leg.filePath)}" target="_blank" class="text-xs text-blue-600 hover:underline truncate flex-1">${esc(fileDisplayName(leg.filePath, leg.fileLabel))}</a>`
          : '<span class="text-xs text-gray-400 flex-1 italic">No file attached</span>'
        }
        <button type="button" class="leg-attach-btn h-7 px-2 border border-gray-300 rounded text-xs text-gray-600 hover:bg-gray-50 flex-shrink-0"
          data-leg-id="${li}" data-direction="${d}" aria-label="Attach receipt file for this leg">
          <i class="fas fa-paperclip mr-1 text-[0.65rem]" aria-hidden="true"></i>${leg.filePath ? 'Replace' : 'Attach'}
        </button>
      </div>
    </div>`;
}

function personalLegRowHtml(leg, direction) {
  const icon   = travelIcon(leg.mode || 'flight', direction === 'return');
  const from   = leg.from || '';
  const to     = leg.to   || '';
  const date   = leg.date
    ? new Date(leg.date + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : '';
  const ref    = leg.ref || '';
  const route  = (from || to) ? `${esc(from)} → ${esc(to)}` : '';
  const meta   = [date, ref].filter(Boolean).join(' · ');
  const summary = [route, meta].filter(Boolean).join(' · ');
  const li = esc(leg.id);
  return `
    <div class="flex items-center gap-2 p-2.5 rounded-lg border border-gray-200 bg-white" data-personal-leg-id="${li}" data-personal-leg-dir="${direction}">
      <i class="${icon} text-gray-400 flex-shrink-0 w-4 text-center text-xs"></i>
      <span class="flex-1 min-w-0 text-xs text-gray-700 truncate">${summary || 'New leg — click Edit to add details'}</span>
      <button type="button" class="personal-leg-edit-btn h-7 px-2.5 border border-gray-300 rounded-md text-xs text-gray-600 hover:bg-gray-50 transition-colors flex-shrink-0"
        data-personal-leg-id="${li}" data-personal-leg-dir="${direction}" aria-label="Edit ${direction} leg${from || to ? ': ' + from + (from && to ? ' to ' + to : '') : ''}">
        <i class="fas fa-pen-to-square mr-1 text-[0.65rem]" aria-hidden="true"></i>Edit
      </button>
      <button type="button" class="personal-leg-remove-btn flex-shrink-0 text-gray-300 hover:text-red-500 transition-colors"
        data-personal-leg-id="${li}" data-personal-leg-dir="${direction}" aria-label="Remove ${direction} leg${from || to ? ': ' + from + (from && to ? ' to ' + to : '') : ''}">
        <i class="fas fa-times text-xs" aria-hidden="true"></i>
      </button>
    </div>`;
}

function renderAssignmentLegsInModal(assignment) {
  const empty = '<p class="text-xs text-gray-400 italic py-1">No legs yet. Click Add leg to start.</p>';
  const outEl = document.getElementById('assignmentOutboundLegs');
  const retEl = document.getElementById('assignmentReturnLegs');
  const sortedOut = sortLegs(assignment.outboundLegs || []);
  const sortedRet = sortLegs(assignment.returnLegs   || []);
  if (outEl) outEl.innerHTML = sortedOut.length ? sortedOut.map((l) => legCardHtml(l, 'outbound')).join('') : empty;
  if (retEl) retEl.innerHTML = sortedRet.length ? sortedRet.map((l) => legCardHtml(l, 'return')).join('') : empty;
}

const TIMELINE_COLORS = [
  { bg: '#dbeafe', border: '#93c5fd', text: '#1e40af' },
  { bg: '#d1fae5', border: '#6ee7b7', text: '#065f46' },
  { bg: '#ede9fe', border: '#c4b5fd', text: '#5b21b6' },
  { bg: '#ffedd5', border: '#fdba74', text: '#9a3412' },
  { bg: '#fce7f3', border: '#f9a8d4', text: '#9d174d' },
];

function assignmentCardHtml(assignment) {
  const member = state.global?.teamMembers.find((m) => m.id === assignment.memberId);
  if (!member) return '';
  const accomNames = (state.planner.org.accommodations || [])
    .filter((acc) => acc.assignments?.some((a) => a.memberId === assignment.memberId && (a.checkIn || a.checkOut)))
    .map((acc) => acc.name || 'Unnamed').join(', ');
  const outLegs = assignment.outboundLegs || [];
  const retLegs = assignment.returnLegs  || [];
  const firstOut = outLegs.find((l) => l.date);
  const firstRet = retLegs.find((l) => l.date);
  const badges = [
    firstOut && `<span class="inline-flex items-center text-[0.65rem] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500" title="Outbound from ${esc(firstOut.from || '?')}, ${outLegs.length} leg${outLegs.length !== 1 ? 's' : ''}"><i class="fas fa-plane-departure text-[0.55rem] mr-0.5"></i>${outLegs.length > 1 ? `×${outLegs.length}` : ''}</span>`,
    firstRet && `<span class="inline-flex items-center text-[0.65rem] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500" title="Return from ${esc(firstRet.from || '?')}, ${retLegs.length} leg${retLegs.length !== 1 ? 's' : ''}"><i class="fas fa-plane-arrival text-[0.55rem] mr-0.5"></i>${retLegs.length > 1 ? `×${retLegs.length}` : ''}</span>`,
    (assignment.budget || assignment.budgetActual) && `<span class="inline-flex items-center text-[0.65rem] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500"><i class="fas fa-wallet text-[0.55rem] mr-0.5"></i>${assignment.budget ? esc(assignment.budget) : ''}${assignment.budgetActual ? ` / ${esc(assignment.budgetActual)}` : ''}${assignment.currency ? ` ${esc(assignment.currency)}` : ''}</span>`,
    accomNames        && `<span class="text-[0.65rem] text-gray-400">${esc(accomNames)}</span>`,
  ].filter(Boolean).join('');
  return `
    <div class="flex items-center gap-3 p-3 rounded-lg border border-gray-200 bg-white" data-assignment-id="${esc(assignment.memberId)}">
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium text-gray-800">${esc(member.name || 'Unnamed')}</p>
        <div class="flex items-center gap-2 mt-0.5 flex-wrap">
          ${member.role ? `<span class="text-xs text-gray-400">${esc(member.role)}</span>` : ''}
          ${badges}
        </div>
      </div>
      <button type="button" class="edit-assignment-btn h-8 px-3 border border-gray-300 rounded-md text-xs text-gray-600 hover:bg-gray-50 transition-colors flex-shrink-0" data-member-id="${esc(assignment.memberId)}" aria-label="Edit assignment for ${esc(member.name || 'member')}">
        <i class="fas fa-pen-to-square mr-1.5 text-[0.65rem]" aria-hidden="true"></i>Edit
      </button>
      <button type="button" class="remove-assignment-btn flex-shrink-0 text-gray-300 hover:text-red-500 transition-colors" data-member-id="${esc(assignment.memberId)}" aria-label="Remove ${esc(member.name || 'member')} from event">
        <i class="fas fa-times text-xs" aria-hidden="true"></i>
      </button>
    </div>`;
}

function accommodationCardHtml(acc, colorIdx) {
  const col = TIMELINE_COLORS[colorIdx % TIMELINE_COLORS.length];
  const stayCount = (acc.assignments || []).filter((a) => a.checkIn || a.checkOut).length;
  return `
    <div class="flex items-center gap-3 p-3 rounded-lg border bg-white" style="border-color:${col.border}" data-accom-id="${esc(acc.id)}">
      <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${col.bg};border:2px solid ${col.border}"></span>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium text-gray-800">${esc(acc.name || 'New Accommodation')}</p>
        <div class="flex items-center gap-2 mt-0.5">
          ${acc.address ? `<span class="text-xs text-gray-400 truncate">${esc(acc.address)}</span>` : ''}
          ${stayCount ? `<span class="text-[0.65rem] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500"><i class="fas fa-person text-[0.55rem] mr-1"></i>${stayCount} stay${stayCount !== 1 ? 's' : ''}</span>` : ''}
          ${(acc.budget || acc.budgetActual) ? `<span class="text-[0.65rem] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500"><i class="fas fa-wallet text-[0.55rem] mr-0.5"></i>${acc.budget ? esc(acc.budget) : ''}${acc.budgetActual ? ` / ${esc(acc.budgetActual)}` : ''}${acc.currency ? ` ${esc(acc.currency)}` : ''}</span>` : ''}
        </div>
      </div>
      <button type="button" class="edit-accommodation-btn h-8 px-3 border border-gray-300 rounded-md text-xs text-gray-600 hover:bg-gray-50 transition-colors flex-shrink-0" data-accom-id="${esc(acc.id)}" aria-label="Edit ${esc(acc.name || 'accommodation')}">
        <i class="fas fa-pen-to-square mr-1.5 text-[0.65rem]" aria-hidden="true"></i>Edit
      </button>
      <button type="button" class="delete-accommodation-btn flex-shrink-0 text-gray-300 hover:text-red-500 transition-colors" data-accom-id="${esc(acc.id)}" aria-label="Remove ${esc(acc.name || 'accommodation')}">
        <i class="fas fa-times text-xs" aria-hidden="true"></i>
      </button>
    </div>`;
}

function renderTimeline() {
  const container = document.getElementById('orgTimeline');
  if (!container) return;

  const { teamAssignments = [], accommodations = [], timeline = {} } = state.planner.org;

  if (!teamAssignments.length) {
    container.innerHTML = '<p class="text-xs text-gray-400 py-2">Assign team members to this event to see the timeline.</p>';
    return;
  }

  // Determine date range — use stored or derive from event + flight dates
  let startStr = timeline.startDate;
  let endStr   = timeline.endDate;

  if (!startStr || !endStr) {
    const eventDates   = state.allSessions.map((s) => s.startTime.slice(0, 10)).sort();
    const flightDates  = teamAssignments.flatMap((a) => [
      ...(a.outboundLegs || []).map((l) => l.date),
      ...(a.returnLegs   || []).map((l) => l.date),
      // legacy compat
      a.flightOut?.date, a.flightReturn?.date,
    ]).filter(Boolean).sort();
    const all          = [...eventDates, ...flightDates].filter(Boolean).sort();
    if (!all.length) {
      container.innerHTML = '<p class="text-xs text-gray-400 py-2">Set a date range above or add flight dates to see the timeline.</p>';
      return;
    }
    const first = new Date(all[0]        + 'T00:00:00'); first.setDate(first.getDate() - 1);
    const last  = new Date(all[all.length - 1] + 'T00:00:00'); last.setDate(last.getDate() + 1);
    startStr = startStr || localDateStr(first);
    endStr   = endStr   || localDateStr(last);
  }

  // Build day list
  const days = [];
  let cur = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');
  if (cur > end || (end - cur) / 86400000 > 90) {
    container.innerHTML = '<p class="text-xs text-gray-400 py-2">Date range is invalid or exceeds 90 days.</p>';
    return;
  }
  while (cur <= end) { days.push(localDateStr(cur)); cur.setDate(cur.getDate() + 1); }

  // Populate inputs if derived
  const si = document.getElementById('timelineStartDate');
  const ei = document.getElementById('timelineEndDate');
  if (si && !si.value) si.value = startStr;
  if (ei && !ei.value) ei.value = endStr;

  const eventDaySet = new Set(state.allSessions.map((s) =>
    new Date(s.startTime).toLocaleDateString('en-CA', { timeZone: getTimezone() })
  ));
  const todayStr = localDateStr(new Date());
  const colorMap = Object.fromEntries(accommodations.map((a, i) => [a.id, TIMELINE_COLORS[i % TIMELINE_COLORS.length]]));

  function dayAccomMap(memberId) {
    const map = {};
    accommodations.forEach((acc) => {
      const ma = acc.assignments?.find((a) => a.memberId === memberId);
      if (!ma?.checkIn || !ma?.checkOut) return;
      let d = new Date(ma.checkIn + 'T00:00:00');
      const e = new Date(ma.checkOut + 'T00:00:00');
      while (d <= e) { map[localDateStr(d)] = acc; d.setDate(d.getDate() + 1); }
    });
    return map;
  }

  const headerCells = days.map((day) => {
    const isEvent = eventDaySet.has(day);
    const isToday = day === todayStr;
    const label   = new Date(day + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const cls     = isToday ? 'tl-head-today' : isEvent ? 'tl-head-event' : 'tl-head-normal';
    return `<th style="min-width:54px" class="${cls} text-center text-[0.65rem] px-1 py-2 whitespace-nowrap border-l border-gray-100">${label}${isToday ? '<br><span style="font-size:0.5rem">●</span>' : ''}</th>`;
  }).join('');

  const rows = teamAssignments.map((assignment) => {
    const member = state.global?.teamMembers.find((m) => m.id === assignment.memberId);
    if (!member) return '';
    const dam = dayAccomMap(assignment.memberId);

    // Build day→mode maps (first leg per day wins) for both directions
    const outDayMode = {};
    const retDayMode = {};
    (assignment.outboundLegs || []).filter((l) => l.date).forEach((l) => {
      if (!outDayMode[l.date]) outDayMode[l.date] = l.mode || 'other';
    });
    (assignment.returnLegs || []).filter((l) => l.date).forEach((l) => {
      if (!retDayMode[l.date]) retDayMode[l.date] = l.mode || 'other';
    });
    // Legacy compat
    if (assignment.flightOut?.date && !outDayMode[assignment.flightOut.date])
      outDayMode[assignment.flightOut.date] = 'flight';
    if (assignment.flightReturn?.date && !retDayMode[assignment.flightReturn.date])
      retDayMode[assignment.flightReturn.date] = 'flight';

    const cells = days.map((day) => {
      const accom   = dam[day];
      const outMode = outDayMode[day];
      const retMode = retDayMode[day];
      const isEvent = eventDaySet.has(day);
      const isToday = day === todayStr;
      const cellCls = accom ? '' : isToday ? 'tl-cell-today' : isEvent ? 'tl-cell-event' : '';
      const bgStyle = accom ? `background:color-mix(in srgb,${colorMap[accom.id].bg} 55%,var(--surface-0))` : '';

      let content = '';
      if (outMode && retMode) {
        const outIco = travelIcon(outMode, false);
        const retIco = travelIcon(retMode, true);
        content = `<i class="${outIco}" style="color:#7c3aed;font-size:0.6rem" title="${esc(member.name)} outbound + return"></i><i class="${retIco}" style="color:#7c3aed;font-size:0.6rem;margin-left:2px"></i>`;
      } else if (outMode) {
        content = `<i class="${travelIcon(outMode, false)}" style="color:#2563eb;font-size:0.7rem" title="${esc(member.name)} outbound"></i>`;
      } else if (retMode) {
        content = `<i class="${travelIcon(retMode, true)}" style="color:#059669;font-size:0.7rem" title="${esc(member.name)} return"></i>`;
      }

      return `<td style="${bgStyle}" class="${cellCls} text-center px-1 py-2 border-l border-gray-100">${content}</td>`;
    }).join('');
    return `<tr class="border-t border-gray-100"><td class="text-xs font-medium text-gray-700 pr-3 py-2 whitespace-nowrap border-r border-gray-200" style="min-width:90px">${esc(member.name || 'Unnamed')}</td>${cells}</tr>`;
  }).filter(Boolean).join('');

  const legend = accommodations.map((acc, i) => {
    const c = TIMELINE_COLORS[i % TIMELINE_COLORS.length];
    return `<span class="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium" style="background:${c.bg};color:${c.text};border:1px solid ${c.border}"><i class="fas fa-bed text-[0.6rem]"></i>${esc(acc.name || 'Unnamed')}</span>`;
  }).join('');

  container.innerHTML = rows
    ? `<div class="overflow-x-auto rounded-lg border border-gray-200"><table class="w-full text-sm" style="border-collapse:collapse"><thead class="bg-gray-50"><tr><th class="text-left text-xs font-semibold text-gray-500 pr-3 py-2 whitespace-nowrap border-r border-gray-200" style="min-width:90px">Member</th>${headerCells}</tr></thead><tbody>${rows}</tbody></table></div>${legend ? `<div class="flex flex-wrap gap-2 mt-3">${legend}</div>` : ''}`
    : '<p class="text-xs text-gray-400 py-2">No valid team assignments to display.</p>';
}

function refreshAssignMemberSelect() {
  const sel = document.getElementById('assignMemberSelect');
  if (!sel) return;
  const assignedIds = new Set((state.planner.org.teamAssignments || []).map((a) => a.memberId));
  const available   = (state.global?.teamMembers || []).filter((m) => !assignedIds.has(m.id));
  sel.innerHTML = `<option value="">＋ Assign team member…</option>` +
    available.map((m) => `<option value="${esc(m.id)}">${esc(m.name || 'Unnamed')}${m.role ? ` — ${esc(m.role)}` : ''}</option>`).join('');
  sel.parentElement?.classList.toggle('hidden', (state.global?.teamMembers || []).length === 0);
}

function renderOrgTab() {
  const org = state.planner.org;

  const boothInfo  = document.getElementById('orgBoothInfo');
  const boothNotes = document.getElementById('orgBoothNotes');
  if (boothInfo)  boothInfo.value  = org.boothInfo  || '';
  if (boothNotes) boothNotes.value = org.boothNotes || '';

  const sponsorBudgetEl   = document.getElementById('orgSponsorBudget')
  const sponsorActualEl   = document.getElementById('orgSponsorActual')
  const sponsorCurrencyEl = document.getElementById('orgSponsorCurrency')
  if (sponsorBudgetEl)   sponsorBudgetEl.value      = org.sponsorBudget   || ''
  if (sponsorActualEl)   sponsorActualEl.value       = org.sponsorActual   || ''
  if (sponsorCurrencyEl) sponsorCurrencyEl.innerHTML = currencyOptions(org.sponsorCurrency || 'AUD')

  const teamList  = document.getElementById('orgTeamList');
  const teamEmpty = document.getElementById('orgTeamEmpty');
  if (teamList) {
    teamList.innerHTML = (org.teamAssignments || []).map(assignmentCardHtml).filter(Boolean).join('');
    teamEmpty?.classList.toggle('hidden', (org.teamAssignments || []).length > 0);
  }
  refreshAssignMemberSelect();

  const accomList  = document.getElementById('orgAccommodationsList');
  const accomEmpty = document.getElementById('orgAccommodationsEmpty');
  if (accomList) {
    accomList.innerHTML = (org.accommodations || []).map((acc, i) => accommodationCardHtml(acc, i)).join('');
    accomEmpty?.classList.toggle('hidden', (org.accommodations || []).length > 0);
  }

  const swagList  = document.getElementById('orgSwagList');
  const swagEmpty = document.getElementById('orgSwagEmpty');
  if (swagList) {
    swagList.innerHTML = (org.swag || []).map((item) => swagCardHtml(item)).join('');
    swagEmpty?.classList.toggle('hidden', (org.swag || []).length > 0);
  }

  const delivList  = document.getElementById('orgDeliverablesList');
  const delivEmpty = document.getElementById('orgDeliverablesEmpty');
  if (delivList) {
    delivList.innerHTML = (org.deliverables || []).map((item) => checklistItemHtml(item, 'deliverables')).join('');
    delivEmpty?.classList.toggle('hidden', (org.deliverables || []).length > 0);
  }

  renderTimeline();
  renderTrackedSessions('sponsor');
  renderSponsorBudgetBreakdown();
}

// ── Assignment modal ──────────────────────────────────────────────────────────

function openAssignmentModal(memberId) {
  const modal  = document.getElementById('assignmentModal');
  const member = state.global?.teamMembers.find((m) => m.id === memberId);
  if (!modal || !member) return;

  const assignment = (state.planner.org.teamAssignments || []).find((a) => a.memberId === memberId);
  if (!assignment) return;

  // One-time migration from flat flightOut/flightReturn → legs arrays
  if (assignment.flightOut !== undefined || assignment.flightReturn !== undefined) {
    if (!assignment.outboundLegs) {
      assignment.outboundLegs = assignment.flightOut?.date
        ? [{ ...makeLeg(), date: assignment.flightOut.date, ref: assignment.flightOut.flightNo || '', from: assignment.flightOut.from || '', to: assignment.flightOut.to || '', confirmation: assignment.flightOut.confirmation || '' }]
        : [];
    }
    if (!assignment.returnLegs) {
      assignment.returnLegs = assignment.flightReturn?.date
        ? [{ ...makeLeg(), date: assignment.flightReturn.date, ref: assignment.flightReturn.flightNo || '', from: assignment.flightReturn.from || '', to: assignment.flightReturn.to || '', confirmation: assignment.flightReturn.confirmation || '' }]
        : [];
    }
    delete assignment.flightOut;
    delete assignment.flightReturn;
    scheduleAutoSave();
  }

  // Ensure arrays exist
  assignment.outboundLegs = assignment.outboundLegs || [];
  assignment.returnLegs   = assignment.returnLegs   || [];

  modal.dataset.memberId = memberId;
  document.getElementById('assignmentModalSubtitle').textContent =
    `${member.name || 'Unnamed'}${member.role ? ` · ${member.role}` : ''}`;

  renderAssignmentLegsInModal(assignment);

  document.getElementById('assignmentBudget').value = assignment.budget       || '';
  document.getElementById('assignmentActual').value = assignment.budgetActual || '';
  document.getElementById('assignmentNotes').value  = assignment.notes        || '';
  const currencyEl = document.getElementById('assignmentCurrency');
  if (currencyEl) currencyEl.innerHTML = currencyOptions(assignment.currency || 'AUD');

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  modal.querySelector('input, select')?.focus();
}


// ── Accommodation modal ───────────────────────────────────────────────────────

function renderAccomMembersSection(acc) {
  const allAssignments = state.planner.org.teamAssignments || [];
  const noMembersEl    = document.getElementById('accomNoMembers');
  const wrapper        = document.getElementById('accomMemberStaysWrapper');
  const select         = document.getElementById('accomMemberSelect');

  if (!allAssignments.length) {
    noMembersEl?.classList.remove('hidden');
    wrapper?.classList.add('hidden');
    return;
  }
  noMembersEl?.classList.add('hidden');
  wrapper?.classList.remove('hidden');

  const prevValue   = select?.value || '';
  const assignedIds = new Set((acc.assignments || []).map((s) => s.memberId));

  if (select) {
    select.innerHTML = `<option value="">— Select to view or add —</option>` +
      allAssignments.map((a) => {
        const m = state.global?.teamMembers.find((tm) => tm.id === a.memberId);
        if (!m) return '';
        return `<option value="${esc(m.id)}"${prevValue === m.id ? ' selected' : ''}>${esc(m.name || 'Unnamed')}${assignedIds.has(m.id) ? ' ✓' : ''}</option>`;
      }).filter(Boolean).join('');
  }

  if (prevValue && select?.value === prevValue) {
    loadMemberStayFields(acc, prevValue);
  } else {
    document.getElementById('accomMemberFields')?.classList.add('hidden');
    const removeBtn = document.getElementById('accomRemoveMemberBtn');
    if (removeBtn) removeBtn.classList.add('opacity-0', 'pointer-events-none');
  }
}

function loadMemberStayFields(acc, memberId) {
  const stay      = (acc.assignments || []).find((s) => s.memberId === memberId) || {};
  const hasStay   = !!(acc.assignments || []).find((s) => s.memberId === memberId);
  const fields    = document.getElementById('accomMemberFields');
  const removeBtn = document.getElementById('accomRemoveMemberBtn');

  fields?.classList.remove('hidden');
  if (removeBtn) {
    if (hasStay) removeBtn.classList.remove('opacity-0', 'pointer-events-none');
    else         removeBtn.classList.add('opacity-0', 'pointer-events-none');
  }

  const checkIn  = document.getElementById('accomMemberCheckIn');
  const checkOut = document.getElementById('accomMemberCheckOut');
  const currency = document.getElementById('accomMemberCurrency');
  const budget   = document.getElementById('accomMemberBudget');
  const actual   = document.getElementById('accomMemberActual');
  if (checkIn)  checkIn.value  = stay.checkIn      || '';
  if (checkOut) checkOut.value = stay.checkOut     || '';
  if (currency) currency.innerHTML = currencyOptions(stay.currency || 'AUD');
  if (budget)   budget.value   = stay.budget       || '';
  if (actual)   actual.value   = stay.budgetActual || '';
}

function openAccommodationModal(id) {
  const modal = document.getElementById('accommodationModal');
  if (!modal) return;
  const acc = (state.planner.org.accommodations || []).find((a) => a.id === id);
  if (!acc) return;

  modal.dataset.accomId = id;
  document.getElementById('accomName').value         = acc.name         || '';
  document.getElementById('accomAddress').value      = acc.address      || '';
  document.getElementById('accomConfirmation').value = acc.confirmation || '';
  document.getElementById('accomNotes').value        = acc.notes        || '';

  renderAccomDocStatus(acc, 'accomDocStatus', 'accomAttachDocBtn');
  renderAccomMembersSection(acc);

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  modal.querySelector('input')?.focus();
}


function checklistItemHtml(item, listType) {
  const hasDate = listType === 'deliverables';
  return `
    <div class="flex items-center gap-2 p-2 rounded border border-gray-200 bg-white group" data-${listType}-id="${esc(item.id)}">
      <input type="checkbox" class="h-4 w-4 rounded flex-shrink-0" data-${listType}-id="${esc(item.id)}" data-${listType}-field="done" ${item.done ? 'checked' : ''}>
      <input type="text" data-${listType}-id="${esc(item.id)}" data-${listType}-field="label" value="${esc(item.label)}"
        placeholder="Item…"
        class="flex-1 h-8 border-0 border-b border-transparent hover:border-gray-200 focus:border-gray-300 focus:ring-0 bg-transparent text-sm ${item.done ? 'line-through text-gray-400' : 'text-gray-800'} px-1 transition-colors">
      ${hasDate ? `<input type="date" data-${listType}-id="${esc(item.id)}" data-${listType}-field="dueDate" value="${esc(item.dueDate || '')}" class="h-8 rounded border-gray-200 text-xs bg-white px-2 text-gray-500 w-32">` : ''}
      <button type="button" class="delete-${listType}-btn flex-shrink-0 text-gray-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100" data-${listType}-id="${esc(item.id)}" aria-label="Remove ${esc(item.label || listType + ' item')}">
        <i class="fas fa-times text-xs" aria-hidden="true"></i>
      </button>
    </div>`;
}

function swagCardHtml(item) {
  const fmt = (n) => n ? parseFloat(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null;
  const budget = fmt(item.budget);
  const actual = fmt(item.actual);
  const cur    = item.currency ? `${item.currency} ` : '';
  const qty    = parseInt(item.quantity, 10);
  const hasBudget = budget || actual;
  const subtitle  = [budget ? `Budget: ${cur}${budget}` : '', actual ? `Actual: ${cur}${actual}` : ''].filter(Boolean).join(' · ');
  return `<div class="flex items-center gap-2.5 py-2.5 px-3 rounded-lg border border-gray-200 bg-white" data-swag-id="${esc(item.id)}">
    <input type="checkbox" class="h-4 w-4 rounded flex-shrink-0 swag-done-check" data-swag-id="${esc(item.id)}" ${item.done ? 'checked' : ''} aria-label="Mark ${esc(item.name || 'swag item')} as completed">
    <div class="flex-1 min-w-0">
      <p class="text-sm font-medium ${item.done ? 'line-through text-gray-400' : 'text-gray-800'} truncate">${esc(item.name || 'Untitled swag item')}</p>
      ${hasBudget ? `<p class="text-xs text-gray-400 truncate mt-0.5">${esc(subtitle)}</p>` : ''}
    </div>
    ${!isNaN(qty) && qty > 0 ? `<span class="text-[0.65rem] font-semibold bg-gray-100 text-gray-500 rounded-full px-2 py-0.5 flex-shrink-0">×${qty}</span>` : ''}
    <button type="button" class="edit-swag-btn flex-shrink-0 h-7 w-7 inline-flex items-center justify-center border border-gray-200 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors" data-swag-id="${esc(item.id)}" aria-label="Edit ${esc(item.name || 'swag item')}">
      <i class="fas fa-pen-to-square text-[0.65rem]" aria-hidden="true"></i>
    </button>
  </div>`;
}

// renderOrgTab is defined above in the Org tab section

// ── Itinerary tab ────────────────────────────────────────────────────────────

function makeItineraryItem(memberId, date) {
  return { id: makeItemId('it'), memberId, date, time: '', title: '', location: '', notes: '', done: false }
}

function renderItineraryTab() {
  const container = document.getElementById('itineraryGrid')
  if (!container) return

  const { teamAssignments = [], timeline = {} } = state.planner.org
  const itinerary = state.planner.itinerary || []

  if (!teamAssignments.length) {
    container.innerHTML = '<p class="text-xs text-gray-400 py-2">Assign team members in the <strong>Org</strong> tab to see the itinerary grid.</p>'
    return
  }

  // Derive date range from stored inputs, or event/leg/itinerary dates
  const startInput = document.getElementById('itineraryStartDate')
  const endInput   = document.getElementById('itineraryEndDate')
  let startStr = startInput?.value || ''
  let endStr   = endInput?.value   || ''

  if (!startStr || !endStr) {
    const eventDates  = state.allSessions.map((s) => s.startTime.slice(0, 10)).sort()
    const legDates    = teamAssignments.flatMap((a) => [
      ...(a.outboundLegs || []).map((l) => l.date),
      ...(a.returnLegs   || []).map((l) => l.date),
    ]).filter(Boolean).sort()
    const itemDates   = itinerary.map((i) => i.date).filter(Boolean).sort()
    const all         = [...eventDates, ...legDates, ...itemDates].filter(Boolean).sort()
    if (all.length) {
      const first = new Date(all[0] + 'T00:00:00'); first.setDate(first.getDate() - 1)
      const last  = new Date(all[all.length - 1] + 'T00:00:00'); last.setDate(last.getDate() + 1)
      startStr = startStr || localDateStr(first)
      endStr   = endStr   || localDateStr(last)
      if (startInput && !startInput.value) startInput.value = startStr
      if (endInput   && !endInput.value)   endInput.value   = endStr
    }
  }

  // Fallback: use org timeline dates if still unresolved
  if (!startStr || !endStr) {
    const orgTimeline = state.planner.org?.timeline || {}
    if (!startStr && orgTimeline.startDate) { startStr = orgTimeline.startDate; if (startInput && !startInput.value) startInput.value = startStr }
    if (!endStr   && orgTimeline.endDate)   { endStr   = orgTimeline.endDate;   if (endInput   && !endInput.value)   endInput.value   = endStr }
  }

  if (!startStr || !endStr) {
    container.innerHTML = '<p class="text-xs text-gray-400 py-2">Set a date range above, or set one in the Org → Timeline section.</p>'
    return
  }

  const days = []
  let cur = new Date(startStr + 'T00:00:00')
  const end = new Date(endStr + 'T00:00:00')
  if (cur > end || (end - cur) / 86400000 > 90) {
    container.innerHTML = '<p class="text-xs text-gray-400 py-2">Date range is invalid or exceeds 90 days.</p>'
    return
  }
  while (cur <= end) { days.push(localDateStr(cur)); cur.setDate(cur.getDate() + 1) }

  const todayStr = localDateStr(new Date())
  const eventDaySet = new Set(state.allSessions.map((s) =>
    new Date(s.startTime).toLocaleDateString('en-CA', { timeZone: getTimezone() })
  ))

  const headerCells = days.map((day) => {
    const isToday = day === todayStr
    const isEvent = eventDaySet.has(day)
    const cls     = isToday ? 'tl-head-today' : isEvent ? 'tl-head-event' : 'tl-head-normal'
    const label   = new Date(day + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    return `<th style="min-width:80px" class="${cls} text-center text-[0.65rem] px-1 py-2 whitespace-nowrap border-l border-gray-100">${label}${isToday ? '<br><span style="font-size:0.5rem">●</span>' : ''}</th>`
  }).join('')

  const rows = teamAssignments.map((assignment) => {
    const member = state.global?.teamMembers.find((m) => m.id === assignment.memberId)
    if (!member) return ''
    const cells = days.map((day) => {
      const items = itinerary.filter((i) => i.memberId === assignment.memberId && i.date === day)
        .sort((a, b) => (a.time || '').localeCompare(b.time || ''))
      const isToday = day === todayStr
      const isEvent = eventDaySet.has(day)
      const cellCls = isToday ? 'tl-cell-today' : isEvent ? 'tl-cell-event' : ''
      const pills   = items.map((item) =>
        `<span class="block text-[0.6rem] px-1 py-0.5 rounded ${item.done ? 'line-through text-gray-400 bg-gray-100' : 'bg-blue-50 text-blue-700'} truncate cursor-pointer itinerary-cell-item" data-item-id="${esc(item.id)}" title="${esc(item.title)}">${esc(item.title.slice(0, 15))}${item.title.length > 15 ? '…' : ''}</span>`
      ).join('')
      return `<td class="${cellCls} px-1 py-1 border-l border-gray-100 align-top cursor-pointer itinerary-cell" data-member-id="${esc(assignment.memberId)}" data-date="${esc(day)}" style="min-width:80px">${pills || '<span class="block text-[0.55rem] text-gray-300 text-center py-1">+</span>'}</td>`
    }).join('')
    return `<tr class="border-t border-gray-100"><td class="text-xs font-medium text-gray-700 pr-3 py-2 whitespace-nowrap border-r border-gray-200" style="min-width:90px">${esc(member.name || 'Unnamed')}</td>${cells}</tr>`
  }).filter(Boolean).join('')

  container.innerHTML = `<div class="overflow-x-auto rounded-lg border border-gray-200"><table class="w-full text-sm" style="border-collapse:collapse"><thead class="bg-gray-50"><tr><th class="text-left text-xs font-semibold text-gray-500 pr-3 py-2 whitespace-nowrap border-r border-gray-200" style="min-width:90px">Member</th>${headerCells}</tr></thead><tbody>${rows}</tbody></table></div>`
}

function renderItineraryDayItems(memberId, date) {
  const container = document.getElementById('itineraryDayItems')
  if (!container) return
  const modal   = document.getElementById('itineraryDayModal')
  const isPersonal = modal?.dataset.ctx === 'personal'
  const pool    = isPersonal ? (state.planner.personal?.itinerary || []) : (state.planner.itinerary || [])
  const items   = pool
    .filter((i) => isPersonal ? i.date === date : i.memberId === memberId && i.date === date)
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''))

  if (!items.length) {
    container.innerHTML = '<p class="text-xs text-gray-400 italic py-1">No items yet. Click Add item to start.</p>'
    return
  }
  container.innerHTML = items.map((item) => `
    <div class="flex items-start gap-2 p-2 rounded-md border border-gray-200 bg-white" data-itinerary-item-id="${esc(item.id)}">
      <input type="checkbox" class="mt-0.5 h-4 w-4 rounded flex-shrink-0 itinerary-done-check" data-item-id="${esc(item.id)}" ${item.done ? 'checked' : ''} aria-label="Mark '${esc(item.title || 'item')}' as done">
      <div class="flex-1 min-w-0">
        <p class="text-sm ${item.done ? 'line-through text-gray-400' : 'text-gray-800'} font-medium">${esc(item.title)}</p>
        <div class="flex items-center gap-2 mt-0.5 flex-wrap">
          ${item.time ? `<span class="text-xs text-gray-500"><i class="fas fa-clock text-[0.6rem] mr-0.5"></i>${esc(item.time)}</span>` : ''}
          ${item.location ? `<span class="text-xs text-gray-500"><i class="fas fa-location-dot text-[0.6rem] mr-0.5"></i>${esc(item.location)}</span>` : ''}
          ${item.notes ? `<span class="text-xs text-gray-400 truncate">${esc(item.notes)}</span>` : ''}
        </div>
      </div>
      <button type="button" class="itinerary-edit-btn flex-shrink-0 text-gray-400 hover:text-blue-500 transition-colors" data-item-id="${esc(item.id)}" aria-label="Edit '${esc(item.title || 'item')}'">
        <i class="fas fa-pen-to-square text-xs" aria-hidden="true"></i>
      </button>
      <button type="button" class="itinerary-delete-btn flex-shrink-0 text-gray-300 hover:text-red-500 transition-colors" data-item-id="${esc(item.id)}" aria-label="Delete '${esc(item.title || 'item')}'">
        <i class="fas fa-times text-xs" aria-hidden="true"></i>
      </button>
    </div>`).join('')
}

function openItineraryDayModal(memberId, date) {
  const modal = document.getElementById('itineraryDayModal')
  if (!modal) return
  const isStandalone = !memberId || !date
  modal.dataset.memberId = memberId || ''
  modal.dataset.date     = date || ''

  const titleEl    = document.getElementById('itineraryDayModalTitle')
  const subtitleEl = document.getElementById('itineraryDayModalSubtitle')
  const memberRow  = document.getElementById('itineraryFormMemberRow')
  const addBtn     = document.getElementById('addItineraryItemBtn')
  const form       = document.getElementById('itineraryAddForm')

  if (isStandalone) {
    if (titleEl)    titleEl.textContent    = 'Add Itinerary Item'
    if (subtitleEl) subtitleEl.textContent = 'Select a team member and date below'
    // Populate member select
    const assignments = state.planner.org?.teamAssignments || []
    const memberSelect = document.getElementById('itineraryFormMember')
    if (memberSelect) {
      memberSelect.innerHTML = assignments.map((a) => {
        const m = state.global?.teamMembers.find((tm) => tm.id === a.memberId)
        return m ? `<option value="${esc(m.id)}">${esc(m.name || 'Unnamed')}</option>` : ''
      }).filter(Boolean).join('')
    }
    memberRow?.classList.remove('hidden')
    addBtn?.classList.add('hidden')
    if (form) form.classList.remove('hidden')
    document.getElementById('itineraryDayItems').innerHTML = ''
  } else {
    const member = state.global?.teamMembers.find((m) => m.id === memberId)
    if (titleEl)    titleEl.textContent    = 'Itinerary'
    if (subtitleEl) subtitleEl.textContent = `${member?.name || 'Unnamed'} · ${new Date(date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}`
    memberRow?.classList.add('hidden')
    addBtn?.classList.remove('hidden')
    if (form) form.classList.add('hidden')
    renderItineraryDayItems(memberId, date)
  }

  document.getElementById('itineraryFormTitle').value    = ''
  document.getElementById('itineraryFormTime').value     = ''
  document.getElementById('itineraryFormLocation').value = ''
  document.getElementById('itineraryFormNotes').value    = ''
  document.getElementById('itineraryFormEditId').value   = ''
  modal.classList.remove('hidden')
  document.body.style.overflow = 'hidden'
  if (isStandalone) document.getElementById('itineraryFormTitle')?.focus()
}

function closeItineraryDayModal() {
  const modal   = document.getElementById('itineraryDayModal')
  if (!modal) return
  const isPersonal = modal.dataset.ctx === 'personal'
  modal.classList.add('hidden')
  modal.dataset.ctx = ''
  document.body.style.overflow = ''
  if (isPersonal) renderPersonalItinerary()
  else renderItineraryTab()
}

function openPersonalDayModal(date) {
  const modal = document.getElementById('itineraryDayModal')
  if (!modal) return
  modal.dataset.ctx      = 'personal'
  modal.dataset.memberId = ''
  modal.dataset.date     = date || ''

  const titleEl    = document.getElementById('itineraryDayModalTitle')
  const subtitleEl = document.getElementById('itineraryDayModalSubtitle')
  if (titleEl)    titleEl.textContent    = 'Itinerary'
  if (subtitleEl) subtitleEl.textContent = date
    ? new Date(date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
    : ''

  document.getElementById('itineraryFormMemberRow')?.classList.add('hidden')
  const addBtn = document.getElementById('addItineraryItemBtn')
  if (addBtn) addBtn.classList.remove('hidden')
  const form = document.getElementById('itineraryAddForm')
  if (form) form.classList.add('hidden')
  ;['itineraryFormTitle','itineraryFormTime','itineraryFormLocation','itineraryFormNotes','itineraryFormEditId']
    .forEach((id) => { const el = document.getElementById(id); if (el) el.value = '' })

  renderItineraryDayItems('', date)
  modal.classList.remove('hidden')
  document.body.style.overflow = 'hidden'
}

function wireItineraryPanel() {
  // Modal wiring (shared by personal tab itinerary)
  const modal = document.getElementById('itineraryDayModal')
  if (!modal) return

  function getModalCtx() {
    return { memberId: modal.dataset.memberId, date: modal.dataset.date }
  }

  document.getElementById('addItineraryItemBtn')?.addEventListener('click', () => {
    const form = document.getElementById('itineraryAddForm')
    if (form) { form.classList.remove('hidden'); document.getElementById('itineraryFormTitle')?.focus() }
    document.getElementById('itineraryFormEditId').value = ''
    document.getElementById('itineraryFormTitle').value    = ''
    document.getElementById('itineraryFormTime').value     = ''
    document.getElementById('itineraryFormLocation').value = ''
    document.getElementById('itineraryFormNotes').value    = ''
  })

  document.getElementById('itineraryFormCancel')?.addEventListener('click', () => {
    document.getElementById('itineraryAddForm')?.classList.add('hidden')
  })

  document.getElementById('itineraryFormSave')?.addEventListener('click', () => {
    const titleEl = document.getElementById('itineraryFormTitle')
    const title   = titleEl?.value.trim()
    if (!title) { titleEl?.focus(); return }

    // Determine context: standalone (member row visible) vs cell-opened
    const memberRow    = document.getElementById('itineraryFormMemberRow')
    const isStandalone = !memberRow?.classList.contains('hidden')
    let memberId, date
    if (isStandalone) {
      memberId = document.getElementById('itineraryFormMember')?.value || ''
      date     = document.getElementById('itineraryFormDate')?.value   || ''
      if (!memberId) { document.getElementById('itineraryFormMember')?.focus(); return }
      if (!date)     { document.getElementById('itineraryFormDate')?.focus();   return }
    } else {
      const ctx = getModalCtx()
      memberId  = ctx.memberId
      date      = ctx.date
    }

    const isPersonal   = modal.dataset.ctx === 'personal'
    const targetArr = isPersonal ? (state.planner.personal.itinerary ??= []) : (state.planner.itinerary ??= [])
    const editId    = document.getElementById('itineraryFormEditId')?.value || ''
    if (editId) {
      const item = targetArr.find((i) => i.id === editId)
      if (item) {
        item.title    = title
        item.time     = document.getElementById('itineraryFormTime').value
        item.location = document.getElementById('itineraryFormLocation').value
        item.notes    = document.getElementById('itineraryFormNotes').value
      }
    } else {
      const item = makeItineraryItem(isPersonal ? null : memberId, date)
      item.title    = title
      item.time     = document.getElementById('itineraryFormTime').value
      item.location = document.getElementById('itineraryFormLocation').value
      item.notes    = document.getElementById('itineraryFormNotes').value
      targetArr.push(item)
    }
    document.getElementById('itineraryAddForm')?.classList.add('hidden')
    if (isStandalone) {
      closeItineraryDayModal()
    } else {
      renderItineraryDayItems(isPersonal ? '' : memberId, date)
    }
    scheduleAutoSave()
  })

  // Item done / edit / delete
  modal.addEventListener('change', (e) => {
    if (e.target.classList.contains('itinerary-done-check')) {
      const id      = e.target.dataset.itemId
      const isPersonal = modal.dataset.ctx === 'personal'
      const pool    = isPersonal ? (state.planner.personal?.itinerary || []) : (state.planner.itinerary || [])
      const item    = pool.find((i) => i.id === id)
      if (item) { item.done = e.target.checked; renderItineraryDayItems(isPersonal ? '' : modal.dataset.memberId, modal.dataset.date); scheduleAutoSave() }
    }
  })

  modal.addEventListener('click', (e) => {
    if (e.target === modal) { closeItineraryDayModal(); return }

    const editBtn = e.target.closest('.itinerary-edit-btn')
    if (editBtn) {
      const id      = editBtn.dataset.itemId
      const isPersonal = modal.dataset.ctx === 'personal'
      const pool    = isPersonal ? (state.planner.personal?.itinerary || []) : (state.planner.itinerary || [])
      const item    = pool.find((i) => i.id === id)
      if (!item) return
      const form = document.getElementById('itineraryAddForm')
      if (form) form.classList.remove('hidden')
      document.getElementById('itineraryFormEditId').value   = id
      document.getElementById('itineraryFormTitle').value    = item.title
      document.getElementById('itineraryFormTime').value     = item.time
      document.getElementById('itineraryFormLocation').value = item.location
      document.getElementById('itineraryFormNotes').value    = item.notes
      document.getElementById('itineraryFormTitle')?.focus()
      return
    }

    const delBtn = e.target.closest('.itinerary-delete-btn')
    if (delBtn) {
      const id      = delBtn.dataset.itemId
      const isPersonal = modal.dataset.ctx === 'personal'
      if (isPersonal) {
        state.planner.personal.itinerary = (state.planner.personal.itinerary || []).filter((i) => i.id !== id)
      } else {
        state.planner.itinerary = (state.planner.itinerary || []).filter((i) => i.id !== id)
      }
      renderItineraryDayItems(isPersonal ? '' : modal.dataset.memberId, modal.dataset.date)
      scheduleAutoSave()
      return
    }
  })

  document.getElementById('itineraryDayModalClose')?.addEventListener('click', closeItineraryDayModal)
  document.getElementById('itineraryDayModalDone')?.addEventListener('click',  closeItineraryDayModal)

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) closeItineraryDayModal()
  })
}

// ── Receipts tab ─────────────────────────────────────────────────────────────

function makeReceipt() {
  return { id: makeItemId('rc'), name: '', date: '', amount: '', currency: 'AUD', category: 'misc', filePath: '', fileLabel: '', notes: '' }
}

function receiptCardHtml(receipt) {
  const catLabel = RECEIPT_CATEGORIES.find((c) => c.value === receipt.category)?.label || 'Misc'
  return `
    <details class="rounded-md border border-gray-200 overflow-hidden" data-receipt-id="${esc(receipt.id)}">
      <summary class="flex items-center gap-3 px-4 py-3 cursor-pointer select-none hover:bg-gray-50 transition-colors list-none">
        <i class="fas fa-chevron-right text-gray-400 text-xs flex-shrink-0 transition-transform receipt-chevron"></i>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium text-gray-800">${esc(receipt.name || 'New Receipt')}</p>
          <p class="text-xs text-gray-500">${receipt.date ? esc(receipt.date) : ''}${receipt.amount ? ` · ${esc(receipt.amount)} ${esc(receipt.currency || '')}` : ''} · <span class="text-gray-400">${esc(catLabel)}</span></p>
        </div>
        ${receipt.filePath ? '<span class="text-xs text-blue-500 flex-shrink-0"><i class="fas fa-paperclip text-[0.65rem]"></i></span>' : ''}
        <button type="button" class="delete-receipt-btn flex-shrink-0 text-gray-400 hover:text-red-500 transition-colors px-1" data-receipt-id="${esc(receipt.id)}" aria-label="Delete receipt: ${esc(receipt.name || 'receipt')}">
          <i class="fas fa-trash text-xs" aria-hidden="true"></i>
        </button>
      </summary>
      <div class="px-4 pb-4 pt-3 border-t border-gray-100 bg-white">
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <label class="editor-form-field sm:col-span-2">
            <span class="editor-field-label">Description</span>
            <input type="text" data-receipt-id="${esc(receipt.id)}" data-receipt-field="name" value="${esc(receipt.name)}"
              class="h-9 w-full rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3" placeholder="What was this for?">
          </label>
          <label class="editor-form-field">
            <span class="editor-field-label">Date</span>
            <input type="date" data-receipt-id="${esc(receipt.id)}" data-receipt-field="date" value="${esc(receipt.date)}"
              class="h-9 w-full rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3">
          </label>
          <label class="editor-form-field">
            <span class="editor-field-label">Amount</span>
            <input type="text" data-receipt-id="${esc(receipt.id)}" data-receipt-field="amount" value="${esc(receipt.amount)}"
              class="h-9 w-full rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3" placeholder="0.00">
          </label>
          <label class="editor-form-field">
            <span class="editor-field-label">Category</span>
            <select data-receipt-id="${esc(receipt.id)}" data-receipt-field="category"
              class="h-9 w-full rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3">
              ${RECEIPT_CATEGORIES.map((c) => `<option value="${c.value}"${receipt.category === c.value ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}
            </select>
          </label>
          <label class="editor-form-field">
            <span class="editor-field-label">Currency</span>
            <select data-receipt-id="${esc(receipt.id)}" data-receipt-field="currency"
              class="h-9 w-full rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3">
              ${currencyOptions(receipt.currency || 'AUD')}
            </select>
          </label>
          <label class="editor-form-field">
            <span class="editor-field-label">File attachment</span>
            <div class="flex items-center gap-2">
              ${receipt.filePath ? `<a href="${esc(receipt.filePath)}" target="_blank" class="text-xs drupal-blue-text truncate flex-1">${esc(fileDisplayName(receipt.filePath, receipt.fileLabel))}</a>` : '<span class="text-xs text-gray-400 flex-1">No file attached</span>'}
              <button type="button" class="receipt-attach-btn h-8 px-2 border border-gray-300 rounded text-xs text-gray-600 hover:bg-gray-50 flex-shrink-0" data-receipt-id="${esc(receipt.id)}">
                <i class="fas fa-paperclip text-[0.65rem]"></i>
              </button>
            </div>
          </label>
          <label class="editor-form-field sm:col-span-3">
            <span class="editor-field-label">Notes</span>
            <textarea data-receipt-id="${esc(receipt.id)}" data-receipt-field="notes" rows="2"
              class="w-full rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white p-2 resize-y" placeholder="Any extra details…">${esc(receipt.notes)}</textarea>
          </label>
        </div>
      </div>
    </details>`
}

function renderReceiptsTab() {
  const list  = document.getElementById('receiptsList')
  const empty = document.getElementById('receiptsEmptyState')
  if (!list) return
  const receipts = state.planner.receipts || []
  empty?.classList.toggle('hidden', receipts.length > 0)
  list.innerHTML = receipts.map(receiptCardHtml).join('')
}

function wireReceiptsPanel() {
  const panel = document.getElementById('plannerReceiptsPanel')
  if (!panel) return

  document.getElementById('addReceiptBtn')?.addEventListener('click', () => {
    const r = makeReceipt()
    state.planner.receipts = [...(state.planner.receipts || []), r]
    renderReceiptsTab()
    scheduleAutoSave()
    renderPersonalBudgetBreakdown(); renderSponsorBudgetBreakdown()
    // Open the new card
    setTimeout(() => {
      const el = document.querySelector(`[data-receipt-id="${r.id}"]`)
      el?.setAttribute('open', '')
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }, 20)
  })

  panel.addEventListener('input', (e) => {
    const id    = e.target.dataset.receiptId
    const field = e.target.dataset.receiptField
    if (!id || !field) return
    const receipt = (state.planner.receipts || []).find((r) => r.id === id)
    if (!receipt) return
    receipt[field] = e.target.value
    // Update summary line in the details summary without full re-render
    const details = e.target.closest('details[data-receipt-id]')
    if (details && (field === 'name' || field === 'amount' || field === 'date')) {
      const nameEl   = details.querySelector('summary p.text-sm')
      const detailEl = details.querySelector('summary p.text-xs')
      if (nameEl)   nameEl.textContent   = receipt.name || 'New Receipt'
      if (detailEl) detailEl.textContent = `${receipt.date || ''}${receipt.amount ? ` · ${receipt.amount} ${receipt.currency || ''}` : ''}`
    }
    if (field === 'amount') { renderPersonalBudgetBreakdown(); renderSponsorBudgetBreakdown(); }
    scheduleAutoSave()
  })

  panel.addEventListener('change', (e) => {
    const id    = e.target.dataset.receiptId
    const field = e.target.dataset.receiptField
    if (!id || !field) return
    const receipt = (state.planner.receipts || []).find((r) => r.id === id)
    if (!receipt) return
    receipt[field] = e.target.value
    if (field === 'category' || field === 'amount' || field === 'currency') { renderPersonalBudgetBreakdown(); renderSponsorBudgetBreakdown(); }
    scheduleAutoSave()
  })

  panel.addEventListener('click', (e) => {
    // Delete receipt
    const deleteBtn = e.target.closest('.delete-receipt-btn')
    if (deleteBtn) {
      e.preventDefault(); e.stopPropagation()
      if (window.confirm('Delete this receipt?')) {
        state.planner.receipts = (state.planner.receipts || []).filter((r) => r.id !== deleteBtn.dataset.receiptId)
        renderReceiptsTab()
        scheduleAutoSave()
        renderPersonalBudgetBreakdown(); renderSponsorBudgetBreakdown()
      }
      return
    }

    // Attach file
    const attachBtn = e.target.closest('.receipt-attach-btn')
    if (attachBtn) {
      const rid = attachBtn.dataset.receiptId
      const fileInput = document.getElementById('receiptFileInput')
      if (!fileInput) return
      fileInput.dataset.receiptId = rid
      fileInput.click()
      return
    }
  })

  // Chevron rotation
  panel.addEventListener('toggle', (e) => {
    const chevron = e.target.querySelector('.receipt-chevron')
    if (chevron) chevron.classList.toggle('rotate-90', e.target.open)
  }, true)

  document.getElementById('receiptFileInput')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const rid     = e.target.dataset.receiptId
    const receipt = (state.planner.receipts || []).find((r) => r.id === rid)
    if (!receipt) { e.target.value = ''; return }

    try {
      const { path, label } = await uploadOrReadFile(file)
      receipt.filePath  = path
      receipt.fileLabel = label
    } catch (err) { window.alert(err.message); e.target.value = ''; return }

    renderReceiptsTab()
    renderDocumentsTab()
    scheduleAutoSave()
    e.target.value = ''
  })
}

// ── Summary tab ───────────────────────────────────────────────────────────────

let _charts = {}

function destroyCharts(...keys) {
  keys.forEach((k) => { if (_charts[k]) { _charts[k].destroy(); delete _charts[k] } })
}

function buildEventBudgetData(planner) {
  const cats = {
    travel:        { label: 'Travel',        budget: 0, actual: 0, items: [], receipts: [] },
    accommodation: { label: 'Accommodation', budget: 0, actual: 0, items: [], receipts: [] },
    food:          { label: 'Food & Drink',  budget: 0, actual: 0, items: [], receipts: [] },
    customer:      { label: 'Customer',      budget: 0, actual: 0, items: [], receipts: [] },
    team:          { label: 'Team',          budget: 0, actual: 0, items: [], receipts: [] },
    misc:          { label: 'Misc',          budget: 0, actual: 0, items: [], receipts: [] },
    sponsor:       { label: 'Sponsor',       budget: 0, actual: 0, items: [], receipts: [] },
    swag:          { label: 'Swag',          budget: 0, actual: 0, items: [], receipts: [] },
  }
  const org = planner.org || {}

  // Team assignments → travel
  ;(org.teamAssignments || []).forEach((a) => {
    const m = state.global?.teamMembers.find((tm) => tm.id === a.memberId)
    const b = parseBudget(a.budget); const ac = parseBudget(a.budgetActual)
    cats.travel.budget += b; cats.travel.actual += ac
    if (b || ac) cats.travel.items.push({ label: m?.name || 'Unnamed', budget: b, actual: ac })
  })

  // Accommodation stays → accommodation
  ;(org.accommodations || []).forEach((acc) => {
    ;(acc.assignments || []).forEach((stay) => {
      const m = state.global?.teamMembers.find((tm) => tm.id === stay.memberId)
      const b = parseBudget(stay.budget); const ac = parseBudget(stay.budgetActual)
      cats.accommodation.budget += b; cats.accommodation.actual += ac
      if (b || ac) cats.accommodation.items.push({ label: `${m?.name || 'Unnamed'} @ ${acc.name || 'Accommodation'}`, budget: b, actual: ac })
    })
  })

  // Sponsor
  const sb = parseBudget(org.sponsorBudget); const sa = parseBudget(org.sponsorActual)
  cats.sponsor.budget += sb; cats.sponsor.actual += sa
  if (sb || sa) cats.sponsor.items.push({ label: 'Company / Sponsor', budget: sb, actual: sa })

  // Swag items
  ;(org.swag || []).forEach((item) => {
    const b = parseBudget(item.budget); const ac = parseBudget(item.actual)
    cats.swag.budget += b; cats.swag.actual += ac
    if (b || ac) cats.swag.items.push({ label: item.name || 'Swag item', budget: b, actual: ac })
  })

  // Receipts by category
  ;(planner.receipts || []).forEach((r) => {
    const cat = r.category || 'misc'
    const amt = parseBudget(r.amount)
    if (amt && cats[cat]) {
      cats[cat].actual += amt
      cats[cat].receipts.push({ label: r.name || 'Receipt', amount: amt, currency: r.currency || '', date: r.date || '' })
    }
  })

  return cats
}

function buildPersonalBudgetData(planner) {
  const cats = {
    travel:        { label: 'Travel',        budget: 0, actual: 0, items: [], receipts: [] },
    accommodation: { label: 'Accommodation', budget: 0, actual: 0, items: [], receipts: [] },
    food:          { label: 'Food & Drink',  budget: 0, actual: 0, items: [], receipts: [] },
    customer:      { label: 'Customer',      budget: 0, actual: 0, items: [], receipts: [] },
    team:          { label: 'Team',          budget: 0, actual: 0, items: [], receipts: [] },
    misc:          { label: 'Misc',          budget: 0, actual: 0, items: [], receipts: [] },
  }
  const personal = planner.personal || {}

  const tb = parseBudget(personal.budget); const ta = parseBudget(personal.budgetActual)
  cats.travel.budget += tb; cats.travel.actual += ta
  if (tb || ta) cats.travel.items.push({ label: 'My travel', budget: tb, actual: ta })

  ;(personal.accommodations || []).forEach((acc) => {
    const ab = parseBudget(acc.budget); const aa = parseBudget(acc.budgetActual)
    cats.accommodation.budget += ab; cats.accommodation.actual += aa
    if (ab || aa) cats.accommodation.items.push({ label: acc.name || 'Accommodation', budget: ab, actual: aa })
  })

  ;(planner.receipts || []).forEach((r) => {
    const cat = r.category || 'misc'
    const amt = parseBudget(r.amount)
    if (amt && cats[cat]) {
      cats[cat].actual += amt
      cats[cat].receipts.push({ label: r.name || 'Receipt', amount: amt, currency: r.currency || '', date: r.date || '' })
    }
  })

  return cats
}

function sumEventBudgetTotals(planner) {
  const cats = buildEventBudgetData(planner)
  let budget = 0, actual = 0
  Object.values(cats).forEach((c) => { budget += c.budget; actual += c.actual })
  return { budget, actual }
}

function renderSummaryTab() {
  const activeToggle = document.getElementById('summaryThisEvent')?.classList.contains('hidden') ? 'all' : 'this'
  if (activeToggle === 'all') {
    renderSummaryAllEvents()
  } else {
    renderSummaryThisEvent()
  }
}

function renderSummaryThisEvent() {
  const statsGrid = document.getElementById('summaryStatsGrid')
  if (!statsGrid) return

  const isPersonal = state.planner?.mode === 'personal'
  document.getElementById('summaryMemberChartSection')?.classList.toggle('hidden', isPersonal)

  const tasks    = state.planner.tasks || []
  const contacts = state.planner.contacts || []
  const notes    = state.planner.sessionNotes || {}
  const receipts = state.planner.receipts || []

  const tasksDone    = tasks.filter((t) => t.done).length
  const tasksOpen    = tasks.filter((t) => !t.done).length
  const contactCount = contacts.length
  const notedCount   = Object.values(notes).filter((n) => n.notes || n.rating || n.attended).length
  const receiptCount = receipts.length
  const receiptTotal = receipts.reduce((s, r) => s + parseBudget(r.amount), 0)

  function statCard(icon, label, value, sub) {
    return `<div class="rounded-lg border border-gray-200 bg-gray-50 p-2 text-center">
      <p class="text-[0.6rem] text-gray-400 uppercase tracking-widest mb-0.5">${esc(label)}</p>
      <p class="text-base font-semibold text-gray-800">${esc(String(value))}</p>
      ${sub ? `<p class="text-[0.6rem] text-gray-400">${esc(sub)}</p>` : ''}
      <i class="${icon} text-gray-300 text-xs block"></i>
    </div>`
  }

  function renderCategoryChart(cats) {
    destroyCharts('category')
    const catCanvas = document.getElementById('budgetCategoryChart')
    const activeCats = Object.entries(cats).filter(([, c]) => c.budget > 0 || c.actual > 0)
    if (catCanvas && activeCats.length) {
      _charts.category = new Chart(catCanvas, {
        type: 'bar',
        data: {
          labels: activeCats.map(([, c]) => c.label),
          datasets: [
            { label: 'Budget', data: activeCats.map(([, c]) => c.budget), backgroundColor: 'rgba(59,130,246,0.55)', borderColor: '#3b82f6', borderWidth: 1 },
            { label: 'Actual', data: activeCats.map(([, c]) => c.actual), backgroundColor: 'rgba(16,185,129,0.55)', borderColor: '#10b981', borderWidth: 1 },
          ],
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          plugins: {
            legend: { position: 'top' },
            tooltip: { callbacks: { footer: () => 'Click to drill down' } },
          },
          aspectRatio: 3,
          scales: { x: { beginAtZero: true } },
          onClick(_, elements) {
            if (!elements.length) return
            const [key] = activeCats[elements[0].index]
            openDrilldown(key, cats[key])
          },
        },
      })
    } else if (catCanvas) {
      catCanvas.getContext('2d').clearRect(0, 0, catCanvas.width, catCanvas.height)
    }
  }

  if (isPersonal) {
    const personal = state.planner.personal || {}
    const totalLegs = (personal.outboundLegs?.length || 0) + (personal.returnLegs?.length || 0)
    let accomNights = 0
    ;(personal.accommodations || []).forEach((acc) => {
      if (acc.checkIn && acc.checkOut) {
        const n = Math.round((new Date(acc.checkOut) - new Date(acc.checkIn)) / 86400000)
        if (n > 0) accomNights += n
      }
    })
    const personalItinerary = personal.itinerary || []
    const itinDone = personalItinerary.filter((i) => i.done).length
    const itinOpen = personalItinerary.filter((i) => !i.done).length

    const cats = buildPersonalBudgetData(state.planner)
    let totalBudget = 0, totalActual = 0
    Object.values(cats).forEach((c) => { totalBudget += c.budget; totalActual += c.actual })

    statsGrid.innerHTML = [
      statCard('fas fa-plane',        'Travel legs',    totalLegs),
      statCard('fas fa-bed',          'Nights',         accomNights),
      statCard('fas fa-list-check',   'Tasks',          tasksDone + ' / ' + (tasksDone + tasksOpen), `${tasksOpen} open`),
      statCard('fas fa-map-pin',      'Itinerary',      itinDone + ' / ' + (itinDone + itinOpen),    `${itinOpen} open`),
      statCard('fas fa-address-book', 'Contacts',       contactCount),
      statCard('fas fa-file-lines',   'Sessions noted', notedCount),
      statCard('fas fa-receipt',      'Receipts',       receiptCount, receiptTotal ? receiptTotal.toLocaleString() : ''),
      (totalBudget || totalActual) ? statCard('fas fa-wallet', 'My budget', totalBudget.toLocaleString()) : '',
      (totalBudget || totalActual) ? statCard('fas fa-coins',  'My actual', totalActual.toLocaleString()) : '',
    ].filter(Boolean).join('')

    renderCategoryChart(cats)
    destroyCharts('member')
    return
  }

  // ── Sponsor mode ─────────────────────────────────────────────────────────────
  const org          = state.planner.org
  const assignments  = org.teamAssignments || []
  const accommodations = org.accommodations || []

  const memberCount  = assignments.length
  const totalLegs    = assignments.reduce((s, a) => s + (a.outboundLegs?.length || 0) + (a.returnLegs?.length || 0), 0)
  const totalNights  = accommodations.reduce((sum, acc) =>
    sum + (acc.assignments || []).reduce((s2, a) => {
      if (!a.checkIn || !a.checkOut) return s2
      const n = Math.round((new Date(a.checkOut) - new Date(a.checkIn)) / 86400000)
      return s2 + (n > 0 ? n : 0)
    }, 0), 0)
  const itinerary = state.planner.itinerary || []
  const itinDone  = itinerary.filter((i) => i.done).length
  const itinOpen  = itinerary.filter((i) => !i.done).length

  const cats = buildEventBudgetData(state.planner)
  let totalBudget = 0, totalActual = 0
  Object.values(cats).forEach((c) => { totalBudget += c.budget; totalActual += c.actual })

  statsGrid.innerHTML = [
    statCard('fas fa-users',        'Members',        memberCount),
    statCard('fas fa-plane',        'Travel legs',    totalLegs),
    statCard('fas fa-bed',          'Nights',         totalNights),
    statCard('fas fa-list-check',   'Tasks',          tasksDone + ' / ' + (tasksDone + tasksOpen), `${tasksOpen} open`),
    statCard('fas fa-map-pin',      'Itinerary',      itinDone + ' / ' + (itinDone + itinOpen),    `${itinOpen} open`),
    statCard('fas fa-address-book', 'Contacts',       contactCount),
    statCard('fas fa-file-lines',   'Sessions noted', notedCount),
    statCard('fas fa-receipt',      'Receipts',       receiptCount, receiptTotal ? receiptTotal.toLocaleString() : ''),
    (totalBudget || totalActual) ? statCard('fas fa-wallet', 'Total budget', totalBudget.toLocaleString()) : '',
    (totalBudget || totalActual) ? statCard('fas fa-coins',  'Total actual', totalActual.toLocaleString()) : '',
  ].filter(Boolean).join('')

  renderCategoryChart(cats)

  // ── Per-member chart ─────────────────────────────────────────────────────────
  destroyCharts('member')
  const memberCanvas = document.getElementById('budgetMemberChart')
  const memberData = assignments.map((a) => {
    const m    = state.global?.teamMembers.find((tm) => tm.id === a.memberId)
    const b    = parseBudget(a.budget)
    const ac   = parseBudget(a.budgetActual)
    let accomB = 0, accomAc = 0
    ;(org.accommodations || []).forEach((acc) => {
      const stay = (acc.assignments || []).find((s) => s.memberId === a.memberId)
      if (stay) { accomB += parseBudget(stay.budget); accomAc += parseBudget(stay.budgetActual) }
    })
    return { name: m?.name || 'Unnamed', budget: b + accomB, actual: ac + accomAc, memberId: a.memberId, memberBudget: b, memberActual: ac, accomBudget: accomB, accomActual: accomAc }
  }).filter((d) => d.budget || d.actual)

  if (memberCanvas && memberData.length) {
    _charts.member = new Chart(memberCanvas, {
      type: 'bar',
      data: {
        labels: memberData.map((d) => d.name),
        datasets: [
          { label: 'Budget', data: memberData.map((d) => d.budget), backgroundColor: 'rgba(99,102,241,0.55)', borderColor: '#6366f1', borderWidth: 1 },
          { label: 'Actual', data: memberData.map((d) => d.actual), backgroundColor: 'rgba(245,158,11,0.55)', borderColor: '#f59e0b', borderWidth: 1 },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        plugins: {
          legend: { position: 'top' },
          tooltip: { callbacks: { footer: () => 'Click to drill down' } },
        },
        aspectRatio: 3,
        scales: { x: { beginAtZero: true } },
        onClick(_, elements) {
          if (!elements.length) return
          const d = memberData[elements[0].index]
          openMemberDrilldown(d, state.planner)
        },
      },
    })
  } else if (memberCanvas) {
    memberCanvas.getContext('2d').clearRect(0, 0, memberCanvas.width, memberCanvas.height)
  }
}

function renderSummaryAllEvents() {
  const statsRow = document.getElementById('globalSummaryStatsRow')
  if (!statsRow) return

  // Scan localStorage for all planner keys
  const events = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key?.startsWith('drupalconPlanner_') || key === 'drupalconPlanner_global') continue
    try {
      const data = JSON.parse(localStorage.getItem(key) || '{}')
      const { budget, actual } = sumEventBudgetTotals(data)
      const rawDate = data._lastModified || ''
      const label   = (data._eventFile || key.replace('drupalconPlanner_', '')).replace('.json', '')
      events.push({ label, budget, actual, date: rawDate })
    } catch { /* skip corrupt */ }
  }
  events.sort((a, b) => a.date.localeCompare(b.date))

  const totalBudget = events.reduce((s, e) => s + e.budget, 0)
  const totalActual = events.reduce((s, e) => s + e.actual, 0)

  function statCard(icon, label, value) {
    return `<div class="rounded-lg border border-gray-200 bg-gray-50 p-3 text-center min-w-[100px]">
      <p class="text-[0.65rem] text-gray-400 uppercase tracking-widest mb-1">${esc(label)}</p>
      <p class="text-xl font-semibold text-gray-800">${esc(String(value))}</p>
      <i class="${icon} text-gray-300 text-xs mt-0.5 block"></i>
    </div>`
  }
  statsRow.innerHTML = [
    statCard('fas fa-calendar-check', 'Events tracked', events.length),
    statCard('fas fa-wallet',  'Total budget', totalBudget.toLocaleString()),
    statCard('fas fa-coins',   'Total actual', totalActual.toLocaleString()),
  ].join('')

  destroyCharts('global')
  const canvas = document.getElementById('globalBudgetChart')
  if (!canvas) return

  if (events.length) {
    _charts.global = new Chart(canvas, {
      type: 'line',
      data: {
        labels: events.map((e) => e.label),
        datasets: [
          { label: 'Budget', data: events.map((e) => e.budget), borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', tension: 0.3, fill: true, pointRadius: 5, pointHoverRadius: 7 },
          { label: 'Actual', data: events.map((e) => e.actual), borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', tension: 0.3, fill: true, pointRadius: 5, pointHoverRadius: 7 },
        ],
      },
      options: {
        responsive: true,
        aspectRatio: 3,
        plugins: { legend: { position: 'top' } },
        scales: { y: { beginAtZero: true } },
      },
    })
  } else {
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height)
  }
}

function openDrilldown(catKey, catData) {
  const modal   = document.getElementById('summaryDrilldownModal')
  const title   = document.getElementById('drilldownTitle')
  const content = document.getElementById('drilldownContent')
  if (!modal || !content) return

  if (title) title.textContent = catData.label

  let html = ''

  // Line items
  if (catData.items.length) {
    html += `<div class="mb-4">
      <p class="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">Line Items</p>
      <table class="w-full text-sm">
        <thead><tr class="text-xs text-gray-400 border-b border-gray-100">
          <th class="text-left py-1 pr-3 font-medium">Item</th>
          <th class="text-right py-1 pr-3 font-medium">Budget</th>
          <th class="text-right py-1 font-medium">Actual</th>
        </tr></thead>
        <tbody>${catData.items.map((item) => `
          <tr class="border-b border-gray-50">
            <td class="py-1.5 pr-3 text-gray-700">${esc(item.label)}</td>
            <td class="py-1.5 pr-3 text-right text-gray-600">${item.budget ? item.budget.toLocaleString() : '—'}</td>
            <td class="py-1.5 text-right ${item.actual > item.budget && item.budget ? 'text-red-500' : 'text-gray-600'}">${item.actual ? item.actual.toLocaleString() : '—'}</td>
          </tr>`).join('')}
        </tbody>
        <tfoot><tr class="font-semibold text-gray-800 border-t border-gray-200">
          <td class="pt-2 pr-3">Total</td>
          <td class="pt-2 pr-3 text-right">${catData.budget ? catData.budget.toLocaleString() : '—'}</td>
          <td class="pt-2 text-right ${catData.actual > catData.budget && catData.budget ? 'text-red-500' : ''}">${catData.actual ? catData.actual.toLocaleString() : '—'}</td>
        </tr></tfoot>
      </table>
    </div>`
  }

  // Receipts
  if (catData.receipts.length) {
    html += `<div>
      <p class="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">Receipts</p>
      <table class="w-full text-sm">
        <thead><tr class="text-xs text-gray-400 border-b border-gray-100">
          <th class="text-left py-1 pr-3 font-medium">Description</th>
          <th class="text-left py-1 pr-3 font-medium">Date</th>
          <th class="text-right py-1 font-medium">Amount</th>
        </tr></thead>
        <tbody>${catData.receipts.map((r) => `
          <tr class="border-b border-gray-50">
            <td class="py-1.5 pr-3 text-gray-700">${esc(r.label)}</td>
            <td class="py-1.5 pr-3 text-gray-500 text-xs">${esc(r.date)}</td>
            <td class="py-1.5 text-right text-gray-600">${r.amount.toLocaleString()} ${esc(r.currency)}</td>
          </tr>`).join('')}
        </tbody>
        <tfoot><tr class="font-semibold text-gray-800 border-t border-gray-200">
          <td class="pt-2 pr-3" colspan="2">Total receipts</td>
          <td class="pt-2 text-right">${catData.receipts.reduce((s, r) => s + r.amount, 0).toLocaleString()}</td>
        </tr></tfoot>
      </table>
    </div>`
  }

  if (!html) html = '<p class="text-sm text-gray-400 italic">No data recorded for this category.</p>'

  content.innerHTML = html
  modal.classList.remove('hidden')
  document.body.style.overflow = 'hidden'
}

function openMemberDrilldown(memberData, planner) {
  const modal   = document.getElementById('summaryDrilldownModal')
  const title   = document.getElementById('drilldownTitle')
  const content = document.getElementById('drilldownContent')
  if (!modal || !content) return

  if (title) title.textContent = memberData.name

  const org = planner.org || {}

  // Accommodation stays for this member
  const stays = []
  ;(org.accommodations || []).forEach((acc) => {
    const stay = (acc.assignments || []).find((s) => s.memberId === memberData.memberId)
    if (stay) stays.push({ property: acc.name || 'Accommodation', budget: parseBudget(stay.budget), actual: parseBudget(stay.budgetActual) })
  })

  // Receipts (not per-member currently, so omit)
  const rows = [
    { label: 'Travel allocation', budget: memberData.memberBudget, actual: memberData.memberActual },
    ...stays.map((s) => ({ label: `Accommodation: ${s.property}`, budget: s.budget, actual: s.actual })),
  ].filter((r) => r.budget || r.actual)

  let html = `<table class="w-full text-sm">
    <thead><tr class="text-xs text-gray-400 border-b border-gray-100">
      <th class="text-left py-1 pr-3 font-medium">Category</th>
      <th class="text-right py-1 pr-3 font-medium">Budget</th>
      <th class="text-right py-1 font-medium">Actual</th>
    </tr></thead>
    <tbody>${rows.map((r) => `
      <tr class="border-b border-gray-50">
        <td class="py-1.5 pr-3 text-gray-700">${esc(r.label)}</td>
        <td class="py-1.5 pr-3 text-right text-gray-600">${r.budget ? r.budget.toLocaleString() : '—'}</td>
        <td class="py-1.5 text-right ${r.actual > r.budget && r.budget ? 'text-red-500' : 'text-gray-600'}">${r.actual ? r.actual.toLocaleString() : '—'}</td>
      </tr>`).join('')}
    </tbody>
    <tfoot><tr class="font-semibold text-gray-800 border-t border-gray-200">
      <td class="pt-2 pr-3">Total</td>
      <td class="pt-2 pr-3 text-right">${memberData.budget ? memberData.budget.toLocaleString() : '—'}</td>
      <td class="pt-2 text-right ${memberData.actual > memberData.budget && memberData.budget ? 'text-red-500' : ''}">${memberData.actual ? memberData.actual.toLocaleString() : '—'}</td>
    </tr></tfoot>
  </table>`

  if (!rows.length) html = '<p class="text-sm text-gray-400 italic">No budget data for this member.</p>'

  content.innerHTML = html
  modal.classList.remove('hidden')
  document.body.style.overflow = 'hidden'
}

function wireSummaryPanel() {
  // This/All toggle
  document.getElementById('summaryToggleThis')?.addEventListener('click', () => {
    document.getElementById('summaryThisEvent')?.classList.remove('hidden')
    document.getElementById('summaryAllEvents')?.classList.add('hidden')
    document.getElementById('summaryToggleThis')?.classList.add('is-active')
    document.getElementById('summaryToggleAll')?.classList.remove('is-active')
    renderSummaryThisEvent()
  })
  document.getElementById('summaryToggleAll')?.addEventListener('click', () => {
    document.getElementById('summaryAllEvents')?.classList.remove('hidden')
    document.getElementById('summaryThisEvent')?.classList.add('hidden')
    document.getElementById('summaryToggleAll')?.classList.add('is-active')
    document.getElementById('summaryToggleThis')?.classList.remove('is-active')
    renderSummaryAllEvents()
  })

  // Drilldown modal close
  const drillModal = document.getElementById('summaryDrilldownModal')
  document.getElementById('drilldownModalClose')?.addEventListener('click', closeDrilldown)
  drillModal?.addEventListener('click', (e) => { if (e.target === drillModal) closeDrilldown() })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drillModal && !drillModal.classList.contains('hidden')) closeDrilldown()
  })
}

function closeDrilldown() {
  document.getElementById('summaryDrilldownModal')?.classList.add('hidden')
  document.body.style.overflow = ''
}

// ── Export / Import ──────────────────────────────────────────────────────────

function handleExport() {
  exportPlannerJson(state.eventFile, state.planner);
}

function handleImport(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = parsePlannerImport(e.target.result);
      state.planner = parsed;
      state.eventFile = parsed._eventFile;
      renderAll();
      savePlanner(state.eventFile, state.planner);
      showToast();
    } catch (err) {
      window.alert(`Import failed: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

async function handleSaveToFile() {
  const apiEndpoint = localStorage.getItem('editorApiEndpoint') || '';
  if (!apiEndpoint) {
    window.alert('No API server configured. Set one up in the editor first.');
    return;
  }
  const btn = document.getElementById('plannerSaveFileBtn');
  if (btn) btn.disabled = true;
  try {
    await savePlannerViaApi(apiEndpoint, state.eventFile, state.planner);
    showToast();
  } catch (err) {
    window.alert(`Save to file failed: ${err.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Tracked Sessions ─────────────────────────────────────────────────────────

const TRACKED_REASONS = [
  { value: 'presenting', label: 'Presenting / speaking', icon: 'fa-microphone' },
  { value: 'followup',   label: 'Follow up',             icon: 'fa-bookmark' },
  { value: 'other',      label: 'Other',                 icon: 'fa-tag' },
];

let _trackedSessionCtx = null; // 'sponsor' | 'personal'
let _trackedSessionId  = null; // string ID when editing, null when adding

function syncSponsoredSessions() {
  const sponsorId = state.planner?.org?.sponsorId;
  if (!sponsorId) return;
  const tracked    = (state.planner.org.trackedSessions    ??= []);
  const autoAdded  = (state.planner.org.autoAddedSponsoredSessions ??= []);
  const trackedIds = new Set(tracked.map((t) => t.sessionId));
  const autoSet    = new Set(autoAdded);
  let changed = false;
  for (const session of state.allSessions) {
    if (!parseSponsorIds(session.sponsorIds).includes(sponsorId)) continue;
    if (trackedIds.has(session.id)) continue;
    if (autoSet.has(session.id)) continue; // user removed it — don't re-add
    tracked.push({
      id: makeItemId('ts'),
      sessionId: session.id,
      sessionTitle: session.title || '',
      sessionTime: session.startTime || '',
      reason: 'presenting',
      customReason: '',
      notes: '',
    });
    autoAdded.push(session.id);
    trackedIds.add(session.id);
    autoSet.add(session.id);
    changed = true;
  }
  if (changed) {
    scheduleAutoSave();
    renderTrackedSessions('sponsor');
  }
}

function getTrackedList(ctx) {
  if (ctx === 'sponsor')    return (state.planner.org.trackedSessions    ??= []);
  if (ctx === 'personal') return (state.planner.personal.trackedSessions ??= []);
  return [];
}

function trackedSessionCardHtml(ts, ctx) {
  const reasonObj   = TRACKED_REASONS.find((r) => r.value === ts.reason);
  const reasonLabel = ts.reason === 'other' ? (ts.customReason || 'Other') : (reasonObj?.label || '');
  const icon        = reasonObj?.icon || 'fa-tag';
  const badgeClass  = ts.reason === 'presenting' ? 'bg-blue-50 text-blue-600'
    : ts.reason === 'followup' ? 'bg-amber-50 text-amber-600'
    : 'bg-gray-100 text-gray-500';
  const subtitle = [
    ts.sessionTime ? fmtTime(ts.sessionTime) : '',
    ts.notes       ? ts.notes               : '',
  ].filter(Boolean).join(' · ');
  return `<div class="flex items-center gap-2 py-2 px-3 rounded-lg border border-gray-200 bg-white" data-ts-id="${esc(ts.id)}">
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2 flex-wrap min-w-0">
        <p class="text-sm font-medium text-gray-800 truncate">${esc(ts.sessionTitle || 'Untitled session')}</p>
        ${reasonLabel ? `<span class="inline-flex items-center gap-1 px-1.5 py-px rounded text-[0.65rem] font-medium flex-shrink-0 ${badgeClass}"><i class="fas ${esc(icon)} text-[0.55rem]"></i>${esc(reasonLabel)}</span>` : ''}
      </div>
      ${subtitle ? `<p class="text-xs text-gray-400 truncate mt-0.5">${esc(subtitle)}</p>` : ''}
    </div>
    <button type="button" class="edit-tracked-session-btn flex-shrink-0 h-7 w-7 inline-flex items-center justify-center border border-gray-200 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors"
      data-ts-ctx="${esc(ctx)}" data-ts-id="${esc(ts.id)}" aria-label="Edit tracked session: ${esc(ts.sessionTitle || 'session')}">
      <i class="fas fa-pen-to-square text-[0.65rem]" aria-hidden="true"></i>
    </button>
  </div>`;
}

function renderTrackedSessions(ctx) {
  const listId  = ctx === 'sponsor' ? 'sponsorTrackedSessionsList'  : 'personalTrackedSessionsList';
  const emptyId = ctx === 'sponsor' ? 'sponsorTrackedSessionsEmpty' : 'personalTrackedSessionsEmpty';
  const countId = ctx === 'sponsor' ? 'sponsorTrackedCount'         : 'personalTrackedCount';
  const listEl  = document.getElementById(listId);
  const emptyEl = document.getElementById(emptyId);
  const countEl = document.getElementById(countId);
  if (!listEl) return;
  const list = getTrackedList(ctx);
  listEl.innerHTML = list.map((ts) => trackedSessionCardHtml(ts, ctx)).join('');
  emptyEl?.classList.toggle('hidden', list.length > 0);
  if (countEl) { countEl.textContent = list.length; countEl.classList.toggle('hidden', list.length === 0); }
}

function openTrackedSessionModal(ctx, tsId, sessionOverride) {
  _trackedSessionCtx = ctx;
  _trackedSessionId  = tsId || null;

  const modal = document.getElementById('trackedSessionModal');
  if (!modal) return;

  const list     = getTrackedList(ctx);
  const existing = tsId ? list.find((ts) => ts.id === tsId) : null;
  const session  = sessionOverride || (existing ? state.allSessions.find((s) => s.id === existing.sessionId) : null);

  const infoTitleEl = document.getElementById('trackedSessionInfoTitle');
  const infoTimeEl  = document.getElementById('trackedSessionInfoTime');
  if (infoTitleEl) infoTitleEl.textContent = existing?.sessionTitle || session?.title || '';
  if (infoTimeEl)  infoTimeEl.textContent  = existing?.sessionTime ? fmtTime(existing.sessionTime) : (session ? fmtTime(session.startTime) : '');

  modal.dataset.sessionId    = existing?.sessionId    || session?.id    || '';
  modal.dataset.sessionTitle = existing?.sessionTitle || session?.title || '';
  modal.dataset.sessionTime  = existing?.sessionTime  || session?.startTime || '';

  const reason = existing?.reason || 'followup';
  modal.querySelectorAll('input[name="trackedSessionReason"]').forEach((r) => { r.checked = r.value === reason; });

  const customEl = document.getElementById('trackedSessionCustomReason');
  if (customEl) {
    customEl.value = existing?.customReason || '';
    customEl.classList.toggle('hidden', reason !== 'other');
  }

  const notesEl = document.getElementById('trackedSessionNotes');
  if (notesEl) notesEl.value = existing?.notes || '';

  const delBtn = document.getElementById('trackedSessionDeleteBtn');
  if (delBtn) delBtn.classList.toggle('invisible', !existing);

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeTrackedSessionModal() { _trackedModal.close(); }

function saveTrackedSession() {
  const ctx   = _trackedSessionCtx;
  const tsId  = _trackedSessionId;
  const modal = document.getElementById('trackedSessionModal');
  if (!modal || !ctx) return;

  const list         = getTrackedList(ctx);
  const reason       = modal.querySelector('input[name="trackedSessionReason"]:checked')?.value || 'other';
  const customReason = document.getElementById('trackedSessionCustomReason')?.value.trim() || '';
  const notes        = document.getElementById('trackedSessionNotes')?.value.trim() || '';

  if (tsId) {
    const existing = list.find((ts) => ts.id === tsId);
    if (existing) Object.assign(existing, { reason, customReason, notes });
  } else {
    list.push({
      id:           makeItemId('ts'),
      sessionId:    modal.dataset.sessionId,
      sessionTitle: modal.dataset.sessionTitle,
      sessionTime:  modal.dataset.sessionTime,
      reason,
      customReason,
      notes,
    });
  }

  renderTrackedSessions(ctx);
  scheduleAutoSave();
  closeTrackedSessionModal();
}

function wireTrackedSessionModal() {
  const modal = document.getElementById('trackedSessionModal');
  if (!modal) return;

  _trackedModal.wire();

  document.getElementById('trackedSessionSaveBtn')?.addEventListener('click', saveTrackedSession);

  document.getElementById('trackedSessionDeleteBtn')?.addEventListener('click', () => {
    const ctx  = _trackedSessionCtx;
    const tsId = _trackedSessionId;
    if (!ctx || !tsId) return;
    const list = getTrackedList(ctx);
    const idx  = list.findIndex((ts) => ts.id === tsId);
    if (idx !== -1) list.splice(idx, 1);
    renderTrackedSessions(ctx);
    scheduleAutoSave();
    closeTrackedSessionModal();
  });

  modal.addEventListener('change', (e) => {
    if (e.target.name === 'trackedSessionReason') {
      const customEl = document.getElementById('trackedSessionCustomReason');
      if (customEl) customEl.classList.toggle('hidden', e.target.value !== 'other');
    }
  });
}

function wireTrackedSessionSearch(ctx) {
  const searchInputId   = ctx === 'sponsor' ? 'sponsorSessionSearchInput'   : 'personalSessionSearchInput';
  const searchResultsId = ctx === 'sponsor' ? 'sponsorSessionSearchResults' : 'personalSessionSearchResults';
  const listId          = ctx === 'sponsor' ? 'sponsorTrackedSessionsList'  : 'personalTrackedSessionsList';

  const searchInput   = document.getElementById(searchInputId);
  const searchResults = document.getElementById(searchResultsId);
  const listEl        = document.getElementById(listId);

  searchInput?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q || !searchResults) { searchResults?.classList.add('hidden'); return; }

    const tracked = new Set(getTrackedList(ctx).map((ts) => ts.sessionId));
    const matches = state.allSessions.filter((s) =>
      s.title?.toLowerCase().includes(q) || s.location?.toLowerCase().includes(q)
    ).slice(0, 25);

    if (!matches.length) {
      searchResults.innerHTML = '<p class="text-xs text-gray-400 px-3 py-2">No sessions found.</p>';
    } else {
      searchResults.innerHTML = matches.map((s) => {
        const already = tracked.has(s.id);
        return `<button type="button" class="tracked-session-result w-full text-left px-3 py-2 transition-colors text-sm ${already ? 'opacity-50 cursor-default' : 'hover:bg-gray-50'}" data-session-id="${esc(s.id)}" ${already ? 'disabled' : ''}>
          <p class="text-gray-800 truncate">${esc(s.title)}</p>
          <p class="text-xs text-gray-400">${esc(fmtTime(s.startTime))}${s.location ? ` · ${esc(s.location)}` : ''}${already ? ' · Already tracked' : ''}</p>
        </button>`;
      }).join('');
    }
    searchResults.classList.remove('hidden');
  });

  searchResults?.addEventListener('click', (e) => {
    const btn = e.target.closest('.tracked-session-result');
    if (!btn || btn.disabled) return;
    const session = state.allSessions.find((s) => s.id === btn.dataset.sessionId);
    if (!session) return;
    searchResults.innerHTML = '';
    searchResults.classList.add('hidden');
    if (searchInput) searchInput.value = '';
    openTrackedSessionModal(ctx, null, session);
  });

  listEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('.edit-tracked-session-btn');
    if (btn) openTrackedSessionModal(btn.dataset.tsCtx, btn.dataset.tsId);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest(`#${searchInputId}`) && !e.target.closest(`#${searchResultsId}`)) {
      searchResults?.classList.add('hidden');
    }
  });
}

// ── Personal tab ───────────────────────────────────────────────────────────

function renderPersonalItinerary() {
  renderPersonalTimeline()
}

function renderPersonalTimeline() {
  const container = document.getElementById('personalTimeline')
  if (!container) return
  const personal = state.planner.personal
  if (!personal) return

  const outLegs = personal.outboundLegs  || []
  const retLegs = personal.returnLegs    || []
  const accoms  = personal.accommodations || []
  const items   = personal.itinerary     || []

  // Derive date range from inputs, falling back to leg/accom/event/item dates
  const si = document.getElementById('personalTimelineStart')
  const ei = document.getElementById('personalTimelineEnd')
  let startStr = si?.value || ''
  let endStr   = ei?.value || ''

  if (!startStr || !endStr) {
    const all = [
      ...outLegs.map((l) => l.date), ...retLegs.map((l) => l.date),
      ...accoms.flatMap((a) => [a.checkIn, a.checkOut]),
      ...state.allSessions.map((s) => s.startTime.slice(0, 10)),
      ...items.map((i) => i.date),
    ].filter(Boolean).sort()
    if (!all.length) {
      container.innerHTML = '<p class="text-xs text-gray-400 py-2">Add travel legs or accommodation dates to see the timeline.</p>'
      return
    }
    const first = new Date(all[0] + 'T00:00:00'); first.setDate(first.getDate() - 1)
    const last  = new Date(all[all.length - 1] + 'T00:00:00'); last.setDate(last.getDate() + 1)
    if (!startStr) { startStr = localDateStr(first); if (si && !si.value) si.value = startStr }
    if (!endStr)   { endStr   = localDateStr(last);  if (ei && !ei.value) ei.value = endStr }
  }

  const days = []
  let cur = new Date(startStr + 'T00:00:00')
  const end = new Date(endStr + 'T00:00:00')
  if (cur > end || (end - cur) / 86400000 > 90) {
    container.innerHTML = '<p class="text-xs text-gray-400 py-2">Date range is invalid or exceeds 90 days.</p>'
    return
  }
  while (cur <= end) { days.push(localDateStr(cur)); cur.setDate(cur.getDate() + 1) }

  // Append any itinerary item dates that fall outside the range
  const daySet = new Set(days)
  const extraDays = [...new Set(items.map((i) => i.date).filter(Boolean))].filter((d) => !daySet.has(d)).sort()
  const allDays = [...days, ...extraDays]

  const eventDaySet = new Set(state.allSessions.map((s) =>
    new Date(s.startTime).toLocaleDateString('en-CA', { timeZone: getTimezone() })
  ))
  const todayStr = localDateStr(new Date())

  // Day → travel mode
  const outDayMode = {}
  const retDayMode = {}
  outLegs.filter((l) => l.date).forEach((l) => { if (!outDayMode[l.date]) outDayMode[l.date] = l.mode || 'other' })
  retLegs.filter((l) => l.date).forEach((l) => { if (!retDayMode[l.date]) retDayMode[l.date] = l.mode || 'other' })

  // Per-accommodation day sets and color mapping
  const accomDaySets = accoms.map((acc) => {
    const s = new Set()
    if (acc.checkIn && acc.checkOut) {
      let d = new Date(acc.checkIn + 'T00:00:00')
      const e = new Date(acc.checkOut + 'T00:00:00')
      while (d <= e) { s.add(localDateStr(d)); d.setDate(d.getDate() + 1) }
    }
    return s
  })

  function accomForDay(day) {
    for (let i = 0; i < accoms.length; i++) {
      if (accomDaySets[i].has(day)) return { acc: accoms[i], color: TIMELINE_COLORS[i % TIMELINE_COLORS.length] }
    }
    return null
  }

  // Itinerary items by date
  const byDate = {}
  items.forEach((item) => { (byDate[item.date] ??= []).push(item) })

  const headerCells = allDays.map((day) => {
    const isToday = day === todayStr
    const isEvent = eventDaySet.has(day)
    const cls     = isToday ? 'tl-head-today' : isEvent ? 'tl-head-event' : 'tl-head-normal'
    const label   = new Date(day + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    return `<th style="min-width:80px" class="${cls} text-center text-[0.65rem] px-1 py-2 whitespace-nowrap border-l border-gray-100">${label}${isToday ? '<br><span style="font-size:0.5rem">●</span>' : ''}</th>`
  }).join('')

  // Row 1: travel + accommodation
  const travelCells = allDays.map((day) => {
    const match   = accomForDay(day)
    const outMode = outDayMode[day]
    const retMode = retDayMode[day]
    const isToday = day === todayStr
    const isEvent = eventDaySet.has(day)
    const cellCls = match ? '' : isToday ? 'tl-cell-today' : isEvent ? 'tl-cell-event' : ''
    const bgStyle = match ? `background:color-mix(in srgb,${match.color.bg} 55%,var(--surface-0))` : ''
    let content = ''
    if (outMode && retMode) {
      content = `<i class="${travelIcon(outMode, false)}" style="color:#7c3aed;font-size:0.6rem" title="Outbound + return"></i><i class="${travelIcon(retMode, true)}" style="color:#7c3aed;font-size:0.6rem;margin-left:2px"></i>`
    } else if (outMode) {
      content = `<i class="${travelIcon(outMode, false)}" style="color:#2563eb;font-size:0.7rem" title="Outbound"></i>`
    } else if (retMode) {
      content = `<i class="${travelIcon(retMode, true)}" style="color:#059669;font-size:0.7rem" title="Return"></i>`
    }
    return `<td style="${bgStyle}" class="${cellCls} text-center px-1 py-1.5 border-l border-gray-100">${content}</td>`
  }).join('')

  // Row 2: itinerary items
  const itinCells = allDays.map((day) => {
    const dayItems = (byDate[day] || []).sort((a, b) => (a.time || '').localeCompare(b.time || ''))
    const isToday  = day === todayStr
    const isEvent  = eventDaySet.has(day)
    const cellCls  = isToday ? 'tl-cell-today' : isEvent ? 'tl-cell-event' : ''
    const pills    = dayItems.map((item) =>
      `<span class="block text-[0.6rem] px-1 py-0.5 rounded ${item.done ? 'line-through text-gray-400 bg-gray-100' : 'bg-blue-50 text-blue-700'} truncate cursor-pointer" title="${esc(item.title)}">${esc(item.title.slice(0, 15))}${item.title.length > 15 ? '…' : ''}</span>`
    ).join('')
    return `<td class="${cellCls} px-1 py-1 border-l border-gray-100 align-top cursor-pointer personal-itinerary-cell" data-date="${esc(day)}" style="min-width:80px">${pills || '<span class="block text-[0.55rem] text-gray-300 text-center py-1">+</span>'}</td>`
  }).join('')

  const legend = accoms.length
    ? `<div class="flex flex-wrap gap-2 mt-2">${accoms.map((acc, i) => {
        const c = TIMELINE_COLORS[i % TIMELINE_COLORS.length]
        return `<span class="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium" style="background:${c.bg};color:${c.text};border:1px solid ${c.border}"><i class="fas fa-bed text-[0.6rem] mr-0.5"></i>${esc(acc.name || 'Accommodation')}</span>`
      }).join('')}</div>`
    : ''

  container.innerHTML = `<div class="overflow-x-auto rounded-lg border border-gray-200"><table class="w-full text-sm" style="border-collapse:collapse"><thead class="bg-gray-50"><tr>${headerCells}</tr></thead><tbody><tr class="border-t border-gray-200">${travelCells}</tr><tr class="border-t border-gray-100">${itinCells}</tr></tbody></table></div>${legend}`
}

function personalAccomCardHtml(accom) {
  const checkIn  = accom.checkIn  ? new Date(accom.checkIn  + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const checkOut = accom.checkOut ? new Date(accom.checkOut + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const dates = (checkIn && checkOut) ? `${checkIn} → ${checkOut}` : checkIn || checkOut || '';
  const meta  = [dates, accom.confirmation ? `#${accom.confirmation}` : ''].filter(Boolean).join(' · ');
  const ai    = esc(accom.id);
  return `<div class="flex items-center gap-2 p-2.5 rounded-lg border border-gray-200 bg-white">
    <i class="fas fa-bed text-gray-400 flex-shrink-0 w-4 text-center text-xs"></i>
    <div class="flex-1 min-w-0">
      <p class="text-sm font-medium text-gray-800 truncate">${esc(accom.name || 'Unnamed accommodation')}</p>
      ${meta ? `<p class="text-xs text-gray-400 mt-0.5 truncate">${esc(meta)}</p>` : ''}
    </div>
    <button type="button" class="personal-accom-edit-btn h-7 px-2.5 border border-gray-300 rounded-md text-xs text-gray-600 hover:bg-gray-50 transition-colors flex-shrink-0" data-personal-accom-id="${ai}" aria-label="Edit ${esc(accom.name || 'accommodation')}">
      <i class="fas fa-pen-to-square mr-1 text-[0.65rem]" aria-hidden="true"></i>Edit
    </button>
    <button type="button" class="personal-accom-remove-btn flex-shrink-0 text-gray-300 hover:text-red-500 transition-colors" data-personal-accom-id="${ai}" aria-label="Remove ${esc(accom.name || 'accommodation')}">
      <i class="fas fa-times text-xs" aria-hidden="true"></i>
    </button>
  </div>`;
}

function renderPersonalAccomList() {
  const list  = document.getElementById('personalAccomList');
  const empty = document.getElementById('personalAccomEmpty');
  if (!list) return;
  const accoms = state.planner?.personal?.accommodations || [];
  list.innerHTML = accoms.map(personalAccomCardHtml).join('');
  empty?.classList.toggle('hidden', accoms.length > 0);
}

function renderBudgetBreakdownInto(containerId, cats, currency) {
  const container  = document.getElementById(containerId)
  if (!container) return
  const activeCats = Object.entries(cats).filter(([, c]) => c.budget > 0 || c.actual > 0)
  if (!activeCats.length) { container.classList.add('hidden'); return }

  const totalB    = activeCats.reduce((s, [, c]) => s + c.budget, 0)
  const totalA    = activeCats.reduce((s, [, c]) => s + c.actual, 0)
  const remaining = totalB - totalA
  const over      = remaining < 0
  const showTotal = activeCats.length > 1
  const fmt = (n) => n ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'

  container.classList.remove('hidden')
  container.innerHTML = `
    <div class="grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-1">
      <span class="text-[0.6rem] font-semibold uppercase tracking-widest text-gray-300 pb-0.5">Category</span>
      <span class="text-[0.6rem] font-semibold uppercase tracking-widest text-gray-300 text-right pb-0.5">Budget</span>
      <span class="text-[0.6rem] font-semibold uppercase tracking-widest text-gray-300 text-right pb-0.5">Actual</span>
      ${activeCats.map(([, c]) => `
        <span class="text-gray-500 truncate">${esc(c.label)}</span>
        <span class="text-gray-400 tabular-nums text-right">${fmt(c.budget)}</span>
        <span class="text-gray-600 tabular-nums text-right">${fmt(c.actual)}</span>
      `).join('')}
      ${showTotal ? `
        <div class="col-span-3 h-px bg-gray-200 my-0.5"></div>
        <span class="text-gray-700 font-medium">Total</span>
        <span class="text-gray-500 font-medium tabular-nums text-right">${fmt(totalB)}</span>
        <span class="text-gray-700 font-medium tabular-nums text-right">${fmt(totalA)}</span>
      ` : ''}
    </div>
    ${totalB > 0 ? `
      <div class="flex items-center justify-between mt-2 pt-1.5 border-t border-gray-200 font-medium ${over ? 'text-red-500' : 'text-emerald-600'}">
        <span>${over ? 'Over budget' : 'Remaining'}</span>
        <span class="tabular-nums">${currency} ${fmt(Math.abs(remaining))}</span>
      </div>
    ` : ''}
  `
}

function renderPersonalBudgetBreakdown() {
  renderBudgetBreakdownInto(
    'personalBudgetBreakdown',
    buildPersonalBudgetData(state.planner),
    state.planner?.personal?.currency || 'AUD'
  )
}

function renderSponsorBudgetBreakdown() {
  renderBudgetBreakdownInto(
    'sponsorBudgetBreakdown',
    buildEventBudgetData(state.planner),
    state.planner?.org?.sponsorCurrency || 'AUD'
  )
}

function renderPersonalTab() {
  const personal = state.planner.personal
  if (!personal) return

  // Budget fields
  const budgetEl   = document.getElementById('personalBudget')
  const actualEl   = document.getElementById('personalActual')
  const currencyEl = document.getElementById('personalCurrency')
  const notesEl    = document.getElementById('personalNotes')
  if (budgetEl)   budgetEl.value       = personal.budget       || ''
  if (actualEl)   actualEl.value       = personal.budgetActual || ''
  if (currencyEl) currencyEl.innerHTML = currencyOptions(personal.currency || 'AUD')
  if (notesEl)    notesEl.value        = personal.notes        || ''

  // Legs
  const outContainer = document.getElementById('personalOutboundLegs')
  const retContainer = document.getElementById('personalReturnLegs')
  const outEmpty     = document.getElementById('personalOutboundEmpty')
  const retEmpty     = document.getElementById('personalReturnEmpty')

  const outLegs = sortLegs(personal.outboundLegs || [])
  const retLegs = sortLegs(personal.returnLegs   || [])

  if (outContainer) outContainer.innerHTML = outLegs.map((l) => personalLegRowHtml(l, 'outbound')).join('')
  if (retContainer) retContainer.innerHTML = retLegs.map((l) => personalLegRowHtml(l, 'return')).join('')
  if (outEmpty) outEmpty.classList.toggle('hidden', outLegs.length > 0)
  if (retEmpty) retEmpty.classList.toggle('hidden', retLegs.length > 0)

  renderPersonalTimeline()
  renderPersonalItinerary()
  renderTrackedSessions('personal')
  renderPersonalAccomList()
  renderPersonalBudgetBreakdown()
}

// ── Shared modal lifecycle helper ────────────────────────────────────────────

function createModal(modalId, { onSave, onDone, onDelete, onClose } = {}) {
  const getEl  = () => document.getElementById(modalId);
  const isOpen = () => !getEl()?.classList.contains('hidden');

  function open(focusId) {
    const modal = getEl();
    if (!modal) return;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    document.body.style.paddingRight = scrollbarWidth ? `${scrollbarWidth}px` : '';
    modal.classList.remove('hidden');
    (focusId ? document.getElementById(focusId) : modal.querySelector('input:not([type=hidden]),select,textarea'))?.focus();
  }

  function close() {
    const modal = getEl();
    if (!modal) return;
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
    onClose?.();
  }

  function wire() {
    const modal = getEl();
    if (!modal) return;
    document.getElementById(`${modalId}Close`)?.addEventListener('click', close);
    document.getElementById(`${modalId}Done`)?.addEventListener('click', () => { onDone?.(); close(); });
    if (onDelete) {
      document.getElementById(`${modalId}Delete`)?.addEventListener('click', () => { onDelete(); close(); });
    }
    if (onSave) {
      modal.addEventListener('input',  onSave);
      modal.addEventListener('change', onSave);
    }
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });
  }

  return { open, close, wire };
}

const _trackedModal = createModal('trackedSessionModal', {
  onClose: () => { _trackedSessionCtx = null; _trackedSessionId = null; },
});

// ── Personal leg modal ───────────────────────────────────────────────────────

let _personalLeg = { direction: null, id: null };

function savePersonalLeg() {
  const { direction, id } = _personalLeg;
  if (!direction || !id) return;
  const personal = state.planner.personal;
  if (!personal) return;
  const legs = direction === 'outbound' ? (personal.outboundLegs || []) : (personal.returnLegs || []);
  const leg  = legs.find((l) => l.id === id);
  if (!leg) return;
  leg.mode         = document.getElementById('personalLegModalMode')?.value         || 'flight';
  leg.date         = document.getElementById('personalLegModalDate')?.value         || '';
  leg.ref          = document.getElementById('personalLegModalRef')?.value          || '';
  leg.from         = document.getElementById('personalLegModalFrom')?.value         || '';
  leg.to           = document.getElementById('personalLegModalTo')?.value           || '';
  leg.departTime   = document.getElementById('personalLegModalDepartTime')?.value   || '';
  leg.arriveTime   = document.getElementById('personalLegModalArriveTime')?.value   || '';
  leg.departTz     = document.getElementById('personalLegModalDepartTz')?.value     || '';
  leg.arriveTz     = document.getElementById('personalLegModalArriveTz')?.value     || '';
  leg.confirmation = document.getElementById('personalLegModalConfirmation')?.value || '';
  scheduleAutoSave();
}

const _personalLegModal = createModal('personalLegModal', {
  onSave: savePersonalLeg,
  onDelete: () => {
    const { direction, id } = _personalLeg;
    if (!direction || !id) return;
    const personal = state.planner.personal;
    if (!personal) return;
    if (direction === 'outbound') personal.outboundLegs = (personal.outboundLegs || []).filter((l) => l.id !== id);
    else                          personal.returnLegs   = (personal.returnLegs   || []).filter((l) => l.id !== id);
    scheduleAutoSave();
  },
  onClose: () => {
    _personalLeg = { direction: null, id: null };
    renderPersonalTab();
  },
});

function openPersonalLegModal(direction, legId) {
  const legs = direction === 'outbound'
    ? (state.planner.personal?.outboundLegs || [])
    : (state.planner.personal?.returnLegs   || []);
  const leg = legs.find((l) => l.id === legId);
  if (!leg) return;
  _personalLeg = { direction, id: legId };
  document.getElementById('personalLegModalTitle').textContent = direction === 'outbound' ? 'Outbound Leg' : 'Return Leg';
  const modeSelect = document.getElementById('personalLegModalMode');
  if (modeSelect) {
    modeSelect.innerHTML = Object.entries(TRAVEL_MODES)
      .map(([val, { label }]) => `<option value="${val}"${leg.mode === val ? ' selected' : ''}>${label}</option>`)
      .join('');
  }
  document.getElementById('personalLegModalDate').value         = leg.date         || '';
  document.getElementById('personalLegModalRef').value          = leg.ref          || '';
  document.getElementById('personalLegModalFrom').value         = leg.from         || '';
  document.getElementById('personalLegModalTo').value           = leg.to           || '';
  document.getElementById('personalLegModalDepartTime').value   = leg.departTime   || '';
  document.getElementById('personalLegModalArriveTime').value   = leg.arriveTime   || '';
  document.getElementById('personalLegModalDepartTz').value     = leg.departTz     || '';
  document.getElementById('personalLegModalArriveTz').value     = leg.arriveTz     || '';
  document.getElementById('personalLegModalConfirmation').value = leg.confirmation || '';
  renderPersonalLegReceiptStatus(leg);
  _personalLegModal.open('personalLegModalFrom');
}

function renderPersonalLegReceiptStatus(leg) {
  const container = document.getElementById('personalLegReceiptStatus');
  if (!container) return;
  const receipt = leg?.receiptId ? (state.planner.receipts || []).find((r) => r.id === leg.receiptId) : null;
  if (receipt) {
    container.innerHTML = `
      <i class="fas fa-link text-[0.65rem] text-blue-400 flex-shrink-0" aria-hidden="true"></i>
      <span class="text-xs text-gray-700 truncate flex-1">${esc(receipt.name || 'Receipt entry')}</span>
      <button type="button" id="personalLegViewReceiptBtn"
        class="h-8 px-3 border border-blue-200 rounded-md text-xs text-blue-600 hover:bg-blue-50 transition-colors flex-shrink-0">
        <i class="fas fa-arrow-right mr-1 text-[0.65rem]" aria-hidden="true"></i>View in Receipts
      </button>
      <button type="button" id="personalLegUnlinkReceiptBtn"
        class="h-8 px-2 border border-gray-300 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors flex-shrink-0"
        aria-label="Unlink receipt">
        <i class="fas fa-unlink text-[0.65rem]" aria-hidden="true"></i>
      </button>`;
  } else if (leg?.filePath) {
    container.innerHTML = `
      <i class="fas fa-paperclip text-[0.65rem] text-gray-400 flex-shrink-0" aria-hidden="true"></i>
      <span class="text-xs text-gray-600 truncate flex-1">${esc(fileDisplayName(leg.filePath, leg.fileLabel))}</span>
      <button type="button" id="personalLegAttachBtn"
        class="h-8 px-3 border border-gray-300 rounded-md text-xs text-gray-600 hover:bg-gray-50 transition-colors flex-shrink-0">
        <i class="fas fa-paperclip mr-1 text-[0.65rem]" aria-hidden="true"></i>Replace
      </button>
      <button type="button" id="personalLegCreateReceiptBtn"
        class="h-8 px-3 border border-gray-300 rounded-md text-xs text-gray-600 hover:bg-gray-50 transition-colors flex-shrink-0">
        <i class="fas fa-receipt mr-1 text-[0.65rem]" aria-hidden="true"></i>Create receipt
      </button>`;
  } else {
    container.innerHTML = `
      <span class="text-xs text-gray-400 flex-1 italic">No receipt attached</span>
      <button type="button" id="personalLegAttachBtn"
        class="h-8 px-3 border border-gray-300 rounded-md text-xs text-gray-600 hover:bg-gray-50 transition-colors flex-shrink-0">
        <i class="fas fa-paperclip mr-1 text-[0.65rem]" aria-hidden="true"></i>Attach file
      </button>
      <button type="button" id="personalLegCreateReceiptBtn"
        class="h-8 px-3 border border-gray-300 rounded-md text-xs text-gray-600 hover:bg-gray-50 transition-colors flex-shrink-0">
        <i class="fas fa-receipt mr-1 text-[0.65rem]" aria-hidden="true"></i>Create receipt
      </button>`;
  }
}

function createReceiptForPersonalLeg() {
  const { direction, id } = _personalLeg;
  if (!direction || !id) return;
  const legs = direction === 'outbound' ? state.planner.personal?.outboundLegs : state.planner.personal?.returnLegs;
  const leg  = legs?.find((l) => l.id === id);
  if (!leg) return;

  const modeLabel = TRAVEL_MODES[leg.mode]?.label.replace(/^\S+\s/, '') || leg.mode;
  const route     = [leg.from, leg.to].filter(Boolean).join(' → ');
  const name      = [modeLabel, route].filter(Boolean).join(route ? ': ' : '') || 'Travel receipt';

  const receipt    = makeReceipt();
  receipt.name     = name;
  receipt.date     = leg.date     || '';
  receipt.category = 'travel';
  if (leg.filePath) receipt.filePath = leg.filePath;

  state.planner.receipts = [...(state.planner.receipts || []), receipt];
  leg.receiptId = receipt.id;

  scheduleAutoSave();
  renderPersonalLegReceiptStatus(leg);
  renderReceiptsTab();
}

function wirePersonalLegModal() {
  _personalLegModal.wire();

  const modal = document.getElementById('personalLegModal');
  if (!modal) return;

  modal.addEventListener('click', (e) => {
    if (e.target.closest('#personalLegAttachBtn')) {
      document.getElementById('personalLegFileInput')?.click();
      return;
    }
    if (e.target.closest('#personalLegCreateReceiptBtn')) {
      createReceiptForPersonalLeg();
      return;
    }
    if (e.target.closest('#personalLegViewReceiptBtn')) {
      const { direction, id } = _personalLeg;
      if (!direction || !id) return;
      const legs = direction === 'outbound' ? state.planner.personal?.outboundLegs : state.planner.personal?.returnLegs;
      const leg  = legs?.find((l) => l.id === id);
      _personalLegModal.close();
      setActiveTab('receipts');
      setTimeout(() => {
        const el = leg?.receiptId ? document.querySelector(`details[data-receipt-id="${leg.receiptId}"]`) : null;
        el?.setAttribute('open', '');
        el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);
      return;
    }
    if (e.target.closest('#personalLegUnlinkReceiptBtn')) {
      const { direction, id } = _personalLeg;
      if (!direction || !id) return;
      const legs = direction === 'outbound' ? state.planner.personal?.outboundLegs : state.planner.personal?.returnLegs;
      const leg  = legs?.find((l) => l.id === id);
      if (leg) { leg.receiptId = ''; scheduleAutoSave(); renderPersonalLegReceiptStatus(leg); }
      return;
    }
  });

  document.getElementById('personalLegFileInput')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const { direction, id } = _personalLeg;
    if (!direction || !id) return;
    const legs = direction === 'outbound' ? state.planner.personal?.outboundLegs : state.planner.personal?.returnLegs;
    const leg  = legs?.find((l) => l.id === id);
    if (!leg) { e.target.value = ''; return; }

    try {
      const { path, label } = await uploadOrReadFile(file);
      leg.filePath  = path;
      leg.fileLabel = label;
    } catch (err) { window.alert(err.message); e.target.value = ''; return; }

    if (leg.receiptId) {
      const receipt = (state.planner.receipts || []).find((r) => r.id === leg.receiptId);
      if (receipt) { receipt.filePath = leg.filePath; renderReceiptsTab(); }
    }

    scheduleAutoSave();
    renderPersonalLegReceiptStatus(leg);
    renderDocumentsTab();
    e.target.value = '';
  });
}

// ── Swag modal ────────────────────────────────────────────────────────────────

let _swagId = null;

function saveSwag() {
  if (!_swagId) return;
  const item = (state.planner.org.swag || []).find((x) => x.id === _swagId);
  if (!item) return;
  item.name     = document.getElementById('swagModalName')?.value     || '';
  item.quantity = parseInt(document.getElementById('swagModalQuantity')?.value, 10) || 1;
  item.budget   = document.getElementById('swagModalBudget')?.value   || '';
  item.actual   = document.getElementById('swagModalActual')?.value   || '';
  item.notes    = document.getElementById('swagModalNotes')?.value    || '';
  item.currency = document.getElementById('swagModalCurrency')?.value || 'AUD';
  item.done     = document.getElementById('swagModalDoneCheck')?.checked ?? false;
  scheduleAutoSave();
}

const _swagModal = createModal('swagModal', {
  onSave: saveSwag,
  onDelete: () => {
    state.planner.org.swag = (state.planner.org.swag || []).filter((x) => x.id !== _swagId);
    scheduleAutoSave();
  },
  onClose: () => {
    _swagId = null;
    renderOrgTab();
    renderSponsorBudgetBreakdown();
  },
});

function openSwagModal(id) {
  const item = (state.planner.org.swag || []).find((x) => x.id === id);
  if (!item) return;
  _swagId = item.id;
  document.getElementById('swagModalName').value        = item.name     || '';
  document.getElementById('swagModalQuantity').value    = item.quantity ?? 1;
  document.getElementById('swagModalBudget').value      = item.budget   || '';
  document.getElementById('swagModalActual').value      = item.actual   || '';
  document.getElementById('swagModalNotes').value       = item.notes    || '';
  document.getElementById('swagModalDoneCheck').checked = !!item.done;
  const currEl = document.getElementById('swagModalCurrency');
  if (currEl) { currEl.innerHTML = currencyOptions(); currEl.value = item.currency || 'AUD'; }
  _swagModal.open('swagModalName');
}

function wireSwagModal() { _swagModal.wire(); }

// ── Personal accommodation modal ─────────────────────────────────────────────

let _personalAccomId = null;

function savePersonalAccom() {
  if (!_personalAccomId) return;
  const accom = (state.planner.personal?.accommodations || []).find((a) => a.id === _personalAccomId);
  if (!accom) return;
  accom.name         = document.getElementById('personalAccomModalName')?.value         || '';
  accom.address      = document.getElementById('personalAccomModalAddress')?.value      || '';
  accom.confirmation = document.getElementById('personalAccomModalConfirmation')?.value || '';
  accom.checkIn      = document.getElementById('personalAccomModalCheckIn')?.value      || '';
  accom.checkOut     = document.getElementById('personalAccomModalCheckOut')?.value     || '';
  accom.notes        = document.getElementById('personalAccomModalNotes')?.value        || '';
  accom.budget       = document.getElementById('personalAccomModalBudget')?.value       || '';
  accom.budgetActual = document.getElementById('personalAccomModalActual')?.value       || '';
  accom.currency     = document.getElementById('personalAccomModalCurrency')?.value     || 'AUD';
  scheduleAutoSave();
  renderPersonalTimeline();
  renderPersonalBudgetBreakdown();
}

const _personalAccomModal = createModal('personalAccomModal', {
  onSave: savePersonalAccom,
  onDelete: () => {
    const personal = state.planner.personal;
    personal.accommodations = (personal.accommodations || []).filter((a) => a.id !== _personalAccomId);
    scheduleAutoSave();
  },
  onClose: () => {
    _personalAccomId = null;
    renderPersonalAccomList();
    renderPersonalTimeline();
    renderPersonalBudgetBreakdown();
  },
});

function openPersonalAccomModal(id) {
  const accom = (state.planner.personal?.accommodations || []).find((a) => a.id === id);
  if (!accom) return;
  _personalAccomId = id;
  document.getElementById('personalAccomModalName').value         = accom.name         || '';
  document.getElementById('personalAccomModalAddress').value      = accom.address      || '';
  document.getElementById('personalAccomModalConfirmation').value = accom.confirmation || '';
  document.getElementById('personalAccomModalCheckIn').value      = accom.checkIn      || '';
  document.getElementById('personalAccomModalCheckOut').value     = accom.checkOut     || '';
  document.getElementById('personalAccomModalNotes').value        = accom.notes        || '';
  document.getElementById('personalAccomModalBudget').value       = accom.budget       || '';
  document.getElementById('personalAccomModalActual').value       = accom.budgetActual || '';
  const currEl = document.getElementById('personalAccomModalCurrency');
  if (currEl) { currEl.innerHTML = currencyOptions(); currEl.value = accom.currency || 'AUD'; }
  renderAccomDocStatus(accom, 'personalAccomDocStatus', 'personalAccomAttachDocBtn');
  _personalAccomModal.open('personalAccomModalName');
}

function renderAccomDocStatus(accom, statusId, attachBtnId) {
  const container = document.getElementById(statusId);
  if (!container) return;
  if (accom?.filePath) {
    container.innerHTML = `
      <i class="fas fa-paperclip text-[0.65rem] text-gray-400 flex-shrink-0" aria-hidden="true"></i>
      <a href="${esc(accom.filePath)}" target="_blank"
        class="text-xs text-blue-600 hover:underline truncate flex-1">
        ${esc(fileDisplayName(accom.filePath, accom.fileLabel))}
      </a>
      <button type="button" id="${attachBtnId}"
        class="h-8 px-3 border border-gray-300 rounded-md text-xs text-gray-600 hover:bg-gray-50 transition-colors flex-shrink-0">
        <i class="fas fa-paperclip mr-1 text-[0.65rem]" aria-hidden="true"></i>Replace
      </button>`;
  } else {
    container.innerHTML = `
      <span class="text-xs text-gray-400 flex-1 italic">No document attached</span>
      <button type="button" id="${attachBtnId}"
        class="h-8 px-3 border border-gray-300 rounded-md text-xs text-gray-600 hover:bg-gray-50 transition-colors flex-shrink-0">
        <i class="fas fa-paperclip mr-1 text-[0.65rem]" aria-hidden="true"></i>Attach
      </button>`;
  }
}

function wirePersonalAccomModal() {
  _personalAccomModal.wire();

  const modal = document.getElementById('personalAccomModal');
  if (!modal) return;

  modal.addEventListener('click', (e) => {
    if (e.target.closest('#personalAccomAttachDocBtn')) {
      document.getElementById('personalAccomFileInput')?.click();
    }
  });

  document.getElementById('personalAccomFileInput')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const accom = (state.planner.personal?.accommodations || []).find((a) => a.id === _personalAccomId);
    if (!accom) { e.target.value = ''; return; }
    try {
      const { path, label } = await uploadOrReadFile(file);
      accom.filePath  = path;
      accom.fileLabel = label;
    } catch (err) { window.alert(err.message); e.target.value = ''; return; }
    scheduleAutoSave();
    renderAccomDocStatus(accom, 'personalAccomDocStatus', 'personalAccomAttachDocBtn');
    renderPersonalAccomList();
    renderDocumentsTab();
    e.target.value = '';
  });
}

function wirePersonalPanel() {
  const panel = document.getElementById('plannerPersonalPanel')
  if (!panel) return

  function ensurePersonal() {
    if (!state.planner.personal) state.planner.personal = {
      outboundLegs: [], returnLegs: [], accommodations: [],
      budget: '', budgetActual: '', currency: 'AUD', notes: ''
    }
    return state.planner.personal
  }

  document.getElementById('addPersonalOutboundLegBtn')?.addEventListener('click', () => {
    const personal  = ensurePersonal()
    const newLeg = makeLeg()
    personal.outboundLegs = [...(personal.outboundLegs || []), newLeg]
    renderPersonalTab()
    scheduleAutoSave()
    openPersonalLegModal('outbound', newLeg.id)
  })

  document.getElementById('addPersonalReturnLegBtn')?.addEventListener('click', () => {
    const personal  = ensurePersonal()
    const newLeg = makeLeg()
    personal.returnLegs = [...(personal.returnLegs || []), newLeg]
    renderPersonalTab()
    scheduleAutoSave()
    openPersonalLegModal('return', newLeg.id)
  })

  // Add accommodation
  document.getElementById('addPersonalAccomBtn')?.addEventListener('click', () => {
    const personal   = ensurePersonal()
    const newAccom = { id: makeItemId('ia'), name: '', address: '', checkIn: '', checkOut: '', confirmation: '', budget: '', budgetActual: '', currency: 'AUD', notes: '' }
    personal.accommodations = [...(personal.accommodations || []), newAccom]
    scheduleAutoSave()
    renderPersonalAccomList()
    openPersonalAccomModal(newAccom.id)
  })

  // Budget + notes field delegation
  panel.addEventListener('input',  handlePersonalField)
  panel.addEventListener('change', handlePersonalField)

  // Timeline date range inputs — override the auto-derived range
  document.getElementById('personalTimelineStart')?.addEventListener('change', () => { renderPersonalTimeline(); renderPersonalItinerary() })
  document.getElementById('personalTimelineEnd')?.addEventListener('change',   () => { renderPersonalTimeline(); renderPersonalItinerary() })

  function handlePersonalField(e) {
    const personal = ensurePersonal()
    // Budget / notes
    if (e.target.id === 'personalBudget')   { personal.budget       = e.target.value; scheduleAutoSave(); renderPersonalBudgetBreakdown(); return }
    if (e.target.id === 'personalActual')   { personal.budgetActual = e.target.value; scheduleAutoSave(); renderPersonalBudgetBreakdown(); return }
    if (e.target.id === 'personalCurrency') { personal.currency     = e.target.value; scheduleAutoSave(); renderPersonalBudgetBreakdown(); return }
    if (e.target.id === 'personalNotes')    { personal.notes        = e.target.value; scheduleAutoSave(); return }

    // Leg fields (data-leg-id / data-direction / data-leg-field)
    const { legId, direction, legField } = e.target.dataset
    if (legId && direction && legField) {
      const legs = direction === 'outbound' ? personal.outboundLegs : personal.returnLegs
      const leg  = (legs || []).find((l) => l.id === legId)
      if (leg) {
        leg[legField] = e.target.value
        scheduleAutoSave()
        if (legField === 'date' || legField === 'mode') { renderPersonalTimeline(); renderPersonalItinerary() }
      }
    }
  }

  panel.addEventListener('click', (e) => {
    // Accommodation edit → open modal
    const accomEditBtn = e.target.closest('.personal-accom-edit-btn')
    if (accomEditBtn) { openPersonalAccomModal(accomEditBtn.dataset.personalAccomId); return }

    // Accommodation remove (× button)
    const accomRemoveBtn = e.target.closest('.personal-accom-remove-btn')
    if (accomRemoveBtn) {
      const personal = ensurePersonal()
      personal.accommodations = (personal.accommodations || []).filter((a) => a.id !== accomRemoveBtn.dataset.personalAccomId)
      scheduleAutoSave()
      renderPersonalAccomList()
      renderPersonalTimeline()
      renderPersonalBudgetBreakdown()
      return
    }

    // Edit travel leg → open modal
    const editLegBtn = e.target.closest('.personal-leg-edit-btn')
    if (editLegBtn) {
      openPersonalLegModal(editLegBtn.dataset.personalLegDir, editLegBtn.dataset.personalLegId)
      return
    }
    // Remove travel leg (compact row ×)
    const removeLegBtn = e.target.closest('.personal-leg-remove-btn')
    if (removeLegBtn) {
      const personal = ensurePersonal()
      const { personalLegId, personalLegDir } = removeLegBtn.dataset
      if (personalLegDir === 'outbound') personal.outboundLegs = (personal.outboundLegs || []).filter((l) => l.id !== personalLegId)
      else                               personal.returnLegs   = (personal.returnLegs   || []).filter((l) => l.id !== personalLegId)
      renderPersonalTab()
      scheduleAutoSave()
      return
    }

    // Personal itinerary — cell click opens day modal
    const personalCell = e.target.closest('.personal-itinerary-cell')
    if (personalCell) { openPersonalDayModal(personalCell.dataset.date); return }
  })

  wireTrackedSessionSearch('personal')
}

// ── Render all tabs ──────────────────────────────────────────────────────────

function renderAll() {
  renderContactsTab();
  renderTasksTab();
  renderOrgTab();
  renderPersonalTab();
  renderTeamTab();
  renderDocumentsTab();
  renderReceiptsTab();
  renderSummaryTab();
}

// ── Event delegation ─────────────────────────────────────────────────────────

function wireNotesPanel() {
  const panel = document.getElementById('plannerNotesPanel');
  if (!panel) return;

  panel.addEventListener('change', (e) => {
    const field = e.target.dataset.noteField;
    const id    = e.target.dataset.noteId;
    if (!field || !id) return;
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    handleNoteChange(id, field, value);
    // Update the attended badge in summary without full re-render
    if (field === 'attended') {
      const details = e.target.closest('details[data-session-id]');
      const badge = details?.querySelector('summary .text-emerald-700');
      if (e.target.checked && !badge) {
        const badgeContainer = details?.querySelector('summary .flex.items-center.gap-2');
        if (badgeContainer) {
          const span = document.createElement('span');
          span.className = 'text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium';
          span.textContent = 'Attended';
          badgeContainer.prepend(span);
        }
      } else if (!e.target.checked && badge) {
        badge.closest('span')?.remove();
      }
    }
  });

  panel.addEventListener('input', (e) => {
    const field = e.target.dataset.noteField;
    const id    = e.target.dataset.noteId;
    if (field === 'notes' && id) handleNoteChange(id, 'notes', e.target.value);
  });

  panel.addEventListener('click', (e) => {
    // Star rating
    const starBtn = e.target.closest('.star-btn');
    if (starBtn) {
      const id     = starBtn.dataset.noteId;
      const rating = Number(starBtn.dataset.rating);
      handleNoteChange(id, 'rating', rating);
      // Re-render just this card's rating section
      const details = starBtn.closest('details[data-session-id]');
      if (details) {
        const ratingGroup = details.querySelector('[role="group"]');
        if (ratingGroup) {
          const note = state.planner.sessionNotes[id] || { rating: 0 };
          ratingGroup.innerHTML = `
            <span class="text-sm text-gray-500 mr-1">Rating:</span>
            ${starRatingHtml(id, note.rating)}
            ${note.rating ? `<button type="button" class="ml-1 text-xs text-gray-400 hover:text-gray-600 clear-rating-btn" data-note-id="${esc(id)}" title="Clear rating">✕</button>` : ''}`;
        }
      }
      return;
    }
    // Clear rating
    const clearBtn = e.target.closest('.clear-rating-btn');
    if (clearBtn) {
      const id = clearBtn.dataset.noteId;
      handleNoteChange(id, 'rating', 0);
      const details = clearBtn.closest('details[data-session-id]');
      if (details) {
        const ratingGroup = details.querySelector('[role="group"]');
        if (ratingGroup) {
          ratingGroup.innerHTML = `
            <span class="text-sm text-gray-500 mr-1">Rating:</span>
            ${starRatingHtml(id, 0)}`;
        }
      }
    }
  });

  // Chevron rotation on details toggle
  panel.addEventListener('toggle', (e) => {
    const chevron = e.target.querySelector('.note-card-chevron');
    if (chevron) chevron.classList.toggle('rotate-90', e.target.open);
  }, true);

  // Search input — filter sessions and show results
  const searchInput   = document.getElementById('notesSearchInput');
  const searchResults = document.getElementById('notesSearchResults');

  searchInput?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) {
      searchResults?.classList.add('hidden');
      if (searchResults) searchResults.innerHTML = '';
      return;
    }
    const matches = state.allSessions.filter((s) => {
      const track = Array.isArray(s.track) ? s.track.join(' ') : (s.track || '');
      return (
        s.title?.toLowerCase().includes(q) ||
        s.location?.toLowerCase().includes(q) ||
        track.toLowerCase().includes(q)
      );
    }).slice(0, 30);

    if (!searchResults) return;
    if (!matches.length) {
      searchResults.innerHTML = '<p class="text-xs text-gray-400 px-3 py-2">No sessions found.</p>';
      searchResults.classList.remove('hidden');
      return;
    }
    searchResults.innerHTML = matches.map((s) => {
      const time  = fmtTime(s.startTime);
      const track = Array.isArray(s.track) ? s.track.join(', ') : (s.track || '');
      return `<button type="button" class="notes-search-result w-full text-left px-3 py-2 hover:bg-gray-50 transition-colors" data-session-id="${esc(s.id)}">
        <p class="text-sm text-gray-800 truncate">${esc(s.title)}</p>
        <p class="text-xs text-gray-400">${esc(time)}${s.location ? ` · ${esc(s.location)}` : ''}${track ? ` · ${esc(track)}` : ''}</p>
      </button>`;
    }).join('');
    searchResults.classList.remove('hidden');
  });

  // Click on a search result row — add session note and re-render
  searchResults?.addEventListener('click', (e) => {
    const btn = e.target.closest('.notes-search-result');
    if (!btn) return;
    const sid = btn.dataset.sessionId;
    const session = state.allSessions.find((s) => s.id === sid);
    if (!session) return;
    // Add stub note if not present
    if (!state.planner.sessionNotes[sid]) {
      state.planner.sessionNotes[sid] = {
        sessionId: sid,
        sessionTitle: session.title,
        sessionStartTime: session.startTime,
        attended: false,
        rating: 0,
        notes: '',
      };
    }
    searchResults.innerHTML = '';
    searchResults.classList.add('hidden');
    if (searchInput) searchInput.value = '';
    renderNotesTab();
    scheduleAutoSave();
    // Scroll to and open the newly added card
    setTimeout(() => {
      const el = document.querySelector(`[data-session-id="${sid}"]`);
      if (el) { el.setAttribute('open', ''); el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    }, 50);
  });
}

function wireContactsPanel() {
  const panel = document.getElementById('plannerContactsPanel');
  if (!panel) return;

  panel.addEventListener('input', (e) => {
    const id    = e.target.dataset.contactId;
    const field = e.target.dataset.contactField;
    if (id && field && e.target.type !== 'checkbox') handleContactChange(id, field, e.target.value);
  });

  panel.addEventListener('change', (e) => {
    const id    = e.target.dataset.contactId;
    const field = e.target.dataset.contactField;
    if (id && field && e.target.type === 'checkbox') handleContactChange(id, field, e.target.checked);
  });

  panel.addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('.delete-contact-btn');
    if (deleteBtn) {
      e.preventDefault(); // prevent details toggle
      e.stopPropagation();
      if (window.confirm('Delete this contact?')) deleteContact(deleteBtn.dataset.contactId);
    }
  });

  panel.addEventListener('toggle', (e) => {
    const chevron = e.target.querySelector('.contact-chevron');
    if (chevron) chevron.classList.toggle('rotate-90', e.target.open);
  }, true);

  document.getElementById('addContactBtn')?.addEventListener('click', addContact);
}

function wireTasksPanel() {
  const panel = document.getElementById('plannerTasksPanel');
  if (!panel) return;

  panel.addEventListener('input', (e) => {
    const id    = e.target.dataset.taskId;
    const field = e.target.dataset.taskField;
    if (id && field && field === 'text') handleTaskChange(id, 'text', e.target.value);
  });

  panel.addEventListener('change', (e) => {
    const id    = e.target.dataset.taskId;
    const field = e.target.dataset.taskField;
    if (!id || !field) return;
    if (field === 'done')      handleTaskChange(id, 'done', e.target.checked);
    if (field === 'sessionId') handleTaskChange(id, 'sessionId', e.target.value || null);
  });

  panel.addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('.delete-task-btn');
    if (deleteBtn) deleteTask(deleteBtn.dataset.taskId);
  });

  document.getElementById('addTaskBtn')?.addEventListener('click', addTask);

  document.getElementById('tasksFilterSelect')?.addEventListener('change', (e) => {
    state.tasksFilter = e.target.value;
    renderTasksTab();
  });
}


function wireOrgPanel() {
  const panel = document.getElementById('plannerSponsorPanel');
  if (!panel) return;

  // ── Booth fields ────────────────────────────────────────────────────────────
  panel.addEventListener('input', (e) => {
    if (e.target.id === 'orgBoothInfo')       { state.planner.org.boothInfo       = e.target.value; scheduleAutoSave(); return; }
    if (e.target.id === 'orgBoothNotes')      { state.planner.org.boothNotes      = e.target.value; scheduleAutoSave(); return; }
    if (e.target.id === 'orgSponsorBudget')   { state.planner.org.sponsorBudget   = e.target.value; scheduleAutoSave(); renderSponsorBudgetBreakdown(); return; }
    if (e.target.id === 'orgSponsorActual')   { state.planner.org.sponsorActual   = e.target.value; scheduleAutoSave(); renderSponsorBudgetBreakdown(); return; }

    const delivId    = e.target.dataset.deliverablesId;
    const delivField = e.target.dataset.deliverablesField;
    if (delivId && delivField && delivField !== 'done') {
      const item = state.planner.org.deliverables.find((x) => x.id === delivId);
      if (item) { item[delivField] = e.target.value; scheduleAutoSave(); }
    }
  });

  panel.addEventListener('change', (e) => {
    if (e.target.id === 'orgSponsorCurrency') { state.planner.org.sponsorCurrency = e.target.value; scheduleAutoSave(); renderSponsorBudgetBreakdown(); return; }

    // Timeline date range
    if (e.target.id === 'timelineStartDate') {
      state.planner.org.timeline = { ...state.planner.org.timeline, startDate: e.target.value };
      renderTimeline(); scheduleAutoSave(); return;
    }
    if (e.target.id === 'timelineEndDate') {
      state.planner.org.timeline = { ...state.planner.org.timeline, endDate: e.target.value };
      renderTimeline(); scheduleAutoSave(); return;
    }

    // Assign team member select
    if (e.target.id === 'assignMemberSelect') {
      const memberId = e.target.value;
      if (!memberId) return;
      const already = (state.planner.org.teamAssignments || []).some((a) => a.memberId === memberId);
      if (!already) {
        state.planner.org.teamAssignments = [
          ...(state.planner.org.teamAssignments || []),
          { memberId, outboundLegs: [], returnLegs: [], budget: '', budgetActual: '', currency: 'AUD', notes: '' },
        ];
        renderOrgTab();
        scheduleAutoSave();
        openAssignmentModal(memberId);
      }
      e.target.value = '';
      return;
    }

    if (e.target.classList.contains('swag-done-check')) {
      const id   = e.target.dataset.swagId;
      const item = state.planner.org.swag.find((x) => x.id === id);
      if (item) { item.done = e.target.checked; scheduleAutoSave(); renderOrgTab(); }
      return;
    }
    const delivId    = e.target.dataset.deliverablesId;
    const delivField = e.target.dataset.deliverablesField;
    if (delivId && delivField === 'done') {
      const item = state.planner.org.deliverables.find((x) => x.id === delivId);
      if (item) {
        item.done = e.target.checked;
        const row = e.target.closest(`[data-deliverables-id="${delivId}"]`);
        row?.querySelector('[data-deliverables-field="label"]')?.classList.toggle('line-through', item.done);
        row?.querySelector('[data-deliverables-field="label"]')?.classList.toggle('text-gray-400', item.done);
        scheduleAutoSave();
      }
    }
  });

  panel.addEventListener('click', (e) => {
    // Assignment edit / remove
    const editAssign = e.target.closest('.edit-assignment-btn');
    if (editAssign) { openAssignmentModal(editAssign.dataset.memberId); return; }

    const removeAssign = e.target.closest('.remove-assignment-btn');
    if (removeAssign) {
      const mid = removeAssign.dataset.memberId;
      state.planner.org.teamAssignments = (state.planner.org.teamAssignments || []).filter((a) => a.memberId !== mid);
      // Also remove from accommodation assignments
      (state.planner.org.accommodations || []).forEach((acc) => {
        acc.assignments = (acc.assignments || []).filter((a) => a.memberId !== mid);
      });
      renderOrgTab(); scheduleAutoSave(); return;
    }

    // Accommodation edit / delete
    const editAccom = e.target.closest('.edit-accommodation-btn');
    if (editAccom) { openAccommodationModal(editAccom.dataset.accomId); return; }

    const delAccom = e.target.closest('.delete-accommodation-btn');
    if (delAccom) {
      state.planner.org.accommodations = (state.planner.org.accommodations || []).filter((a) => a.id !== delAccom.dataset.accomId);
      renderOrgTab(); scheduleAutoSave(); return;
    }

    const editSwag = e.target.closest('.edit-swag-btn');
    if (editSwag) { openSwagModal(editSwag.dataset.swagId); return; }
    if (e.target.closest('.delete-deliverables-btn')) {
      const id = e.target.closest('.delete-deliverables-btn').dataset.deliverablesId;
      state.planner.org.deliverables = state.planner.org.deliverables.filter((x) => x.id !== id);
      renderOrgTab(); scheduleAutoSave();
    }
  });

  document.getElementById('addAccommodationBtn')?.addEventListener('click', () => {
    const acc = { id: makeItemId('acc'), name: '', address: '', confirmation: '', notes: '', assignments: [] };
    state.planner.org.accommodations = [...(state.planner.org.accommodations || []), acc];
    renderOrgTab();
    scheduleAutoSave();
    openAccommodationModal(acc.id);
  });

  document.getElementById('addSwagBtn')?.addEventListener('click', () => {
    const item = { id: makeItemId('sw'), name: '', quantity: 1, budget: '', actual: '', currency: 'AUD', done: false, notes: '' };
    state.planner.org.swag.push(item);
    renderOrgTab();
    scheduleAutoSave();
    openSwagModal(item.id);
  });

  document.getElementById('addDeliverableBtn')?.addEventListener('click', () => {
    state.planner.org.deliverables.push({ id: makeItemId('dv'), label: '', done: false, dueDate: '' });
    renderOrgTab(); scheduleAutoSave();
  });

  // ── Assignment modal ────────────────────────────────────────────────────────
  const assignModal = document.getElementById('assignmentModal');
  if (assignModal) {
    function getAssignment() {
      return (state.planner.org.teamAssignments || []).find((a) => a.memberId === assignModal.dataset.memberId);
    }

    function handleAssignField(e) {
      const assignment = getAssignment();
      if (!assignment) return;

      if (e.target.id === 'assignmentBudget')   { assignment.budget       = e.target.value; scheduleAutoSave(); return; }
      if (e.target.id === 'assignmentActual')   { assignment.budgetActual = e.target.value; scheduleAutoSave(); return; }
      if (e.target.id === 'assignmentCurrency') { assignment.currency     = e.target.value; scheduleAutoSave(); return; }
      if (e.target.id === 'assignmentNotes')    { assignment.notes        = e.target.value; scheduleAutoSave(); return; }

      const { legId, direction, legField } = e.target.dataset;
      if (legId && direction && legField) {
        const legs = direction === 'outbound' ? assignment.outboundLegs : assignment.returnLegs;
        const leg  = legs?.find((l) => l.id === legId);
        if (leg) { leg[legField] = e.target.value; scheduleAutoSave(); }
      }
    }

    document.getElementById('addOutboundLegBtn')?.addEventListener('click', () => {
      const assignment = getAssignment();
      if (!assignment) return;
      assignment.outboundLegs.push(makeLeg());
      renderAssignmentLegsInModal(assignment);
      scheduleAutoSave();
    });

    document.getElementById('addReturnLegBtn')?.addEventListener('click', () => {
      const assignment = getAssignment();
      if (!assignment) return;
      assignment.returnLegs.push(makeLeg());
      renderAssignmentLegsInModal(assignment);
      scheduleAutoSave();
    });

    assignModal.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.remove-leg-btn');
      if (removeBtn) {
        const { legId, direction } = removeBtn.dataset;
        const assignment = getAssignment();
        if (!assignment) return;
        if (direction === 'outbound') assignment.outboundLegs = assignment.outboundLegs.filter((l) => l.id !== legId);
        else assignment.returnLegs = assignment.returnLegs.filter((l) => l.id !== legId);
        renderAssignmentLegsInModal(assignment);
        scheduleAutoSave();
        return;
      }

      const attachBtn = e.target.closest('.leg-attach-btn');
      if (attachBtn) {
        const legFileInput = document.getElementById('legFileInput');
        if (!legFileInput) return;
        legFileInput.dataset.legId  = attachBtn.dataset.legId;
        legFileInput.dataset.legDir = attachBtn.dataset.direction;
        legFileInput.click();
      }
    });

    document.getElementById('legFileInput')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const legId  = e.target.dataset.legId;
      const legDir = e.target.dataset.legDir;
      if (!legId) { e.target.value = ''; return; }

      let foundLeg = null;
      let foundAssignment = null;
      for (const a of (state.planner.org?.teamAssignments || [])) {
        const legs = legDir === 'outbound' ? a.outboundLegs : a.returnLegs;
        const leg  = (legs || []).find((l) => l.id === legId);
        if (leg) { foundLeg = leg; foundAssignment = a; break; }
      }
      if (!foundLeg) { e.target.value = ''; return; }

      try {
        const { path, label } = await uploadOrReadFile(file);
        foundLeg.filePath  = path;
        foundLeg.fileLabel = label;
      } catch (err) { window.alert(err.message); e.target.value = ''; return; }

      scheduleAutoSave();
      if (foundAssignment) renderAssignmentLegsInModal(foundAssignment);
      renderDocumentsTab();
      e.target.value = '';
    });

    createModal('assignmentModal', { onSave: handleAssignField, onClose: () => renderOrgTab() }).wire();
  }

  // ── Accommodation modal ─────────────────────────────────────────────────────
  const accomModal = document.getElementById('accommodationModal');
  if (accomModal) {
    function getAccom() {
      return (state.planner.org.accommodations || []).find((a) => a.id === accomModal.dataset.accomId);
    }

    const MEMBER_FIELD_MAP = {
      accomMemberCheckIn:  'checkIn',
      accomMemberCheckOut: 'checkOut',
      accomMemberCurrency: 'currency',
      accomMemberBudget:   'budget',
      accomMemberActual:   'budgetActual',
    };

    function handleAccomField(e) {
      const acc = getAccom();
      if (!acc) return;
      if      (e.target.id === 'accomName')         { acc.name         = e.target.value; }
      else if (e.target.id === 'accomAddress')      { acc.address      = e.target.value; }
      else if (e.target.id === 'accomConfirmation') { acc.confirmation = e.target.value; }
      else if (e.target.id === 'accomNotes')        { acc.notes        = e.target.value; }
      else if (MEMBER_FIELD_MAP[e.target.id]) {
        const memberId = document.getElementById('accomMemberSelect')?.value;
        if (!memberId) return;
        acc.assignments = acc.assignments || [];
        let stay = acc.assignments.find((s) => s.memberId === memberId);
        if (!stay) {
          stay = { memberId, checkIn: '', checkOut: '', budget: '', budgetActual: '', currency: 'AUD' };
          acc.assignments.push(stay);
          // Mark option with ✓ and show remove button
          const opt = accomModal.querySelector(`#accomMemberSelect option[value="${CSS.escape(memberId)}"]`);
          if (opt && !opt.textContent.endsWith(' ✓')) opt.textContent += ' ✓';
          const removeBtn = document.getElementById('accomRemoveMemberBtn');
          if (removeBtn) removeBtn.classList.remove('opacity-0', 'pointer-events-none');
        }
        stay[MEMBER_FIELD_MAP[e.target.id]] = e.target.value;
      }
      scheduleAutoSave();
    }

    createModal('accommodationModal', {
      onSave: handleAccomField,
      onDelete: () => {
        const id = accomModal.dataset.accomId;
        state.planner.org.accommodations = (state.planner.org.accommodations || []).filter((a) => a.id !== id);
        scheduleAutoSave();
      },
      onClose: () => renderOrgTab(),
    }).wire();

    accomModal.addEventListener('click', (e) => {
      if (e.target.closest('#accomAttachDocBtn')) {
        document.getElementById('accomFileInput')?.click();
      }
    });

    document.getElementById('accomFileInput')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const acc = getAccom();
      if (!acc) { e.target.value = ''; return; }
      try {
        const { path, label } = await uploadOrReadFile(file);
        acc.filePath  = path;
        acc.fileLabel = label;
      } catch (err) { window.alert(err.message); e.target.value = ''; return; }
      scheduleAutoSave();
      renderAccomDocStatus(acc, 'accomDocStatus', 'accomAttachDocBtn');
      renderOrgTab();
      renderDocumentsTab();
      e.target.value = '';
    });

    document.getElementById('accomMemberSelect')?.addEventListener('change', (e) => {
      const acc = getAccom();
      if (!acc) return;
      const memberId = e.target.value;
      if (memberId) {
        loadMemberStayFields(acc, memberId);
      } else {
        document.getElementById('accomMemberFields')?.classList.add('hidden');
        const removeBtn = document.getElementById('accomRemoveMemberBtn');
        if (removeBtn) removeBtn.classList.add('opacity-0', 'pointer-events-none');
      }
    });

    document.getElementById('accomRemoveMemberBtn')?.addEventListener('click', () => {
      const acc      = getAccom();
      if (!acc) return;
      const select   = document.getElementById('accomMemberSelect');
      const memberId = select?.value;
      if (!memberId) return;
      acc.assignments = (acc.assignments || []).filter((s) => s.memberId !== memberId);
      // Strip ✓ from the option
      const opt = select.querySelector(`option[value="${CSS.escape(memberId)}"]`);
      if (opt) opt.textContent = opt.textContent.replace(' ✓', '');
      // Clear fields and hide remove button
      ['accomMemberCheckIn','accomMemberCheckOut','accomMemberBudget','accomMemberActual'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      const currEl = document.getElementById('accomMemberCurrency');
      if (currEl) currEl.innerHTML = currencyOptions('AUD');
      const removeBtn = document.getElementById('accomRemoveMemberBtn');
      if (removeBtn) removeBtn.classList.add('opacity-0', 'pointer-events-none');
      scheduleAutoSave();
    });
  }

  // ── Sponsor search ────────────────────────────────────────────────────────
  function renderSponsorLinked() {
    const sponsorId    = state.planner.org.sponsorId || ''
    const sponsors     = state.eventMeta?.sponsors   || []
    const linked       = sponsors.find((s) => s.id === sponsorId)
    const searchRow    = document.getElementById('sponsorSearchRow')
    const resultsEl    = document.getElementById('sponsorSearchResults')
    const linkedCard   = document.getElementById('sponsorLinkedCard')
    const unlinkBtn    = document.getElementById('unlinkSponsorBtn')

    if (linked) {
      searchRow?.classList.add('hidden')
      resultsEl?.classList.add('hidden')
      linkedCard?.classList.remove('hidden')
      unlinkBtn?.classList.remove('hidden')
      const nameEl = document.getElementById('sponsorLinkedName')
      const tierEl = document.getElementById('sponsorLinkedTier')
      const urlEl  = document.getElementById('sponsorLinkedUrl')
      if (nameEl) nameEl.textContent = linked.title || ''
      if (tierEl) tierEl.textContent = linked.tier  || ''
      if (urlEl) {
        if (linked.link) { urlEl.href = linked.link; urlEl.classList.remove('hidden') }
        else             { urlEl.classList.add('hidden') }
      }
    } else {
      searchRow?.classList.remove('hidden')
      linkedCard?.classList.add('hidden')
      unlinkBtn?.classList.add('hidden')
    }
  }

  renderSponsorLinked()

  document.getElementById('sponsorSearchInput')?.addEventListener('input', (e) => {
    const query   = e.target.value.trim().toLowerCase()
    const results = document.getElementById('sponsorSearchResults')
    if (!results) return
    if (!query) { results.classList.add('hidden'); results.innerHTML = ''; return }
    const sponsors = state.eventMeta?.sponsors || []
    const matches  = sponsors.filter((s) => s.title?.toLowerCase().includes(query))
    if (!matches.length) {
      results.innerHTML = '<li class="px-4 py-2 text-xs text-gray-400 italic">No sponsors found</li>'
    } else {
      results.innerHTML = matches.map((s) =>
        `<li class="px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 cursor-pointer flex items-center justify-between gap-2 sponsor-result-item" data-sponsor-id="${esc(s.id)}">
          <span>${esc(s.title || '')}</span>
          <span class="text-xs text-gray-400 flex-shrink-0">${esc(s.tier || '')}</span>
        </li>`
      ).join('')
    }
    results.classList.remove('hidden')
  })

  document.getElementById('sponsorSearchResults')?.addEventListener('click', (e) => {
    const item = e.target.closest('.sponsor-result-item')
    if (!item) return
    state.planner.org.sponsorId = item.dataset.sponsorId
    document.getElementById('sponsorSearchInput').value = ''
    document.getElementById('sponsorSearchResults').classList.add('hidden')
    renderSponsorLinked()
    syncSponsoredSessions()
    scheduleAutoSave()
  })

  document.getElementById('unlinkSponsorBtn')?.addEventListener('click', () => {
    state.planner.org.sponsorId = ''
    renderSponsorLinked()
    scheduleAutoSave()
  })

  // Close results on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#sponsorSearchRow') && !e.target.closest('#sponsorSearchResults')) {
      document.getElementById('sponsorSearchResults')?.classList.add('hidden')
    }
  }, { capture: false })

  wireTrackedSessionSearch('sponsor')
}

// ── Team tab (global team members) ───────────────────────────────────────────

function teamMemberCardHtml(member) {
  return `
    <div class="flex items-center gap-3 p-3 rounded-lg border border-gray-200 bg-white" data-member-id="${esc(member.id)}">
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium text-gray-800">${esc(member.name || 'Unnamed')}</p>
        <div class="flex items-center gap-3 mt-0.5">
          ${member.role  ? `<span class="text-xs text-gray-400">${esc(member.role)}</span>` : ''}
          ${member.phone ? `<span class="text-xs text-gray-400"><i class="fas fa-phone text-[0.6rem] mr-1"></i>${esc(member.phone)}</span>` : ''}
        </div>
      </div>
      <button type="button" class="edit-team-member-btn h-8 px-3 border border-gray-300 rounded-md text-xs text-gray-600 hover:bg-gray-50 transition-colors flex-shrink-0" data-member-id="${esc(member.id)}">
        <i class="fas fa-pen-to-square mr-1.5 text-[0.65rem]"></i>Edit
      </button>
    </div>`;
}

function renderTeamTab() {
  const list  = document.getElementById('teamMembersList');
  const empty = document.getElementById('teamMembersEmpty');
  if (!list) return;
  const members = state.global?.teamMembers || [];
  list.innerHTML = members.map(teamMemberCardHtml).join('');
  empty?.classList.toggle('hidden', members.length > 0);
}

function openTeamMemberModal(id) {
  const modal  = document.getElementById('teamMemberModal');
  if (!modal) return;
  const member = id ? (state.global?.teamMembers || []).find((m) => m.id === id) : null;
  modal.dataset.memberId = id || '';
  document.getElementById('tmName').value  = member?.name  || '';
  document.getElementById('tmRole').value  = member?.role  || '';
  document.getElementById('tmPhone').value = member?.phone || '';
  document.getElementById('tmNotes').value = member?.notes || '';
  document.getElementById('teamMemberModalDelete').classList.toggle('hidden', !id);
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  document.getElementById('tmName').focus();
}


function wireTeamPanel() {
  const panel = document.getElementById('plannerTeamPanel');
  if (!panel) return;

  panel.addEventListener('click', (e) => {
    const editBtn = e.target.closest('.edit-team-member-btn');
    if (editBtn) { openTeamMemberModal(editBtn.dataset.memberId); return; }
  });

  document.getElementById('addTeamMemberBtn')?.addEventListener('click', () => openTeamMemberModal(null));

  const modal = document.getElementById('teamMemberModal');
  if (!modal) return;

  function readModalFields() {
    return {
      name:  document.getElementById('tmName').value.trim(),
      role:  document.getElementById('tmRole').value.trim(),
      phone: document.getElementById('tmPhone').value.trim(),
      notes: document.getElementById('tmNotes').value.trim(),
    };
  }

  createModal('teamMemberModal', {
    onSave: () => {
      const id = modal.dataset.memberId;
      if (!id) return;
      const member = (state.global?.teamMembers || []).find((m) => m.id === id);
      if (!member) return;
      Object.assign(member, readModalFields());
      saveGlobal(state.global);
    },
    onDone: () => {
      const id     = modal.dataset.memberId;
      const fields = readModalFields();
      if (!id) {
        state.global.teamMembers = [...(state.global?.teamMembers || []), { id: makeItemId('tm'), ...fields }];
      } else {
        const member = (state.global?.teamMembers || []).find((m) => m.id === id);
        if (member) Object.assign(member, fields);
      }
      saveGlobal(state.global);
    },
    onDelete: () => {
      const id = modal.dataset.memberId;
      if (!id) return;
      state.global.teamMembers = (state.global?.teamMembers || []).filter((m) => m.id !== id);
      saveGlobal(state.global);
    },
    onClose: () => { renderTeamTab(); refreshAssignMemberSelect(); },
  }).wire();
}

// ── Mode toggle (sponsor / personal) ─────────────────────────────────────────

// Tabs visible in each mode
const SPONSOR_TABS  = new Set(['contacts', 'tasks', 'sponsor', 'team', 'documents', 'summary']);
const PERSONAL_TABS = new Set(['personal', 'receipts', 'documents', 'summary']);

function applyMode(mode) {
  state.planner.mode = mode;
  savePlanner(state.eventFile, state.planner);

  const isSponsor  = mode === 'sponsor';
  const visibleTabs = isSponsor ? SPONSOR_TABS : PERSONAL_TABS;

  // Show/hide tab buttons based on the active mode
  TABS.forEach((tab) => {
    document.getElementById(TAB_BTN_IDS[tab])?.classList.toggle('hidden', !visibleTabs.has(tab));
  });

  // Mark the active mode button
  document.getElementById('modeToggleSponsor')?.classList.toggle('is-active', isSponsor);
  document.getElementById('modeToggleSponsor')?.setAttribute('aria-pressed', String(isSponsor));
  document.getElementById('modeTogglePersonal')?.classList.toggle('is-active', !isSponsor);
  document.getElementById('modeTogglePersonal')?.setAttribute('aria-pressed', String(!isSponsor));

  // Navigate away from the current tab if it isn't available in this mode
  const cur = state.activeTab;
  if (!visibleTabs.has(cur)) {
    setActiveTab(isSponsor ? 'contacts' : 'personal');
  }

  // Re-render summary if it's visible (stats differ by mode)
  if (state.activeTab === 'summary') renderSummaryTab();
}

// ── Documents tab ─────────────────────────────────────────────────────────────

function collectDocuments() {
  const mode = state.planner.mode || 'personal';
  const docs = [];

  if (mode === 'personal') {
    (state.planner.personal?.documents || []).forEach((d) => {
      docs.push({ ...d, isDirect: true, sourceLabel: 'Personal document', sourceIcon: 'fas fa-file-alt' });
    });

    sortLegs(state.planner.personal?.outboundLegs || []).forEach((leg) => {
      if (!leg.filePath) return;
      const route = [leg.from, leg.to].filter(Boolean).join(' → ');
      const modeInfo = TRAVEL_MODES[leg.mode] || TRAVEL_MODES.other;
      docs.push({
        id: `leg-out-${leg.id}`,
        name: fileDisplayName(leg.filePath, leg.fileLabel),
        filePath: leg.filePath,
        isDirect: false,
        sourceLabel: `Outbound travel${route ? ` · ${route}` : ''}`,
        sourceIcon: modeInfo.icon || 'fas fa-route',
      });
    });

    sortLegs(state.planner.personal?.returnLegs || []).forEach((leg) => {
      if (!leg.filePath) return;
      const route = [leg.from, leg.to].filter(Boolean).join(' → ');
      const modeInfo = TRAVEL_MODES[leg.mode] || TRAVEL_MODES.other;
      docs.push({
        id: `leg-ret-${leg.id}`,
        name: fileDisplayName(leg.filePath, leg.fileLabel),
        filePath: leg.filePath,
        isDirect: false,
        sourceLabel: `Return travel${route ? ` · ${route}` : ''}`,
        sourceIcon: modeInfo.returnIcon || modeInfo.icon || 'fas fa-route',
      });
    });

    (state.planner.personal?.accommodations || []).forEach((accom) => {
      if (!accom.filePath) return;
      docs.push({
        id: `paccom-${accom.id}`,
        name: fileDisplayName(accom.filePath, accom.fileLabel),
        filePath: accom.filePath,
        isDirect: false,
        sourceLabel: `Accommodation${accom.name ? ` · ${accom.name}` : ''}`,
        sourceIcon: 'fas fa-bed',
      });
    });

    (state.planner.receipts || []).forEach((r) => {
      if (!r.filePath) return;
      docs.push({
        id: `receipt-${r.id}`,
        name: fileDisplayName(r.filePath, r.fileLabel),
        filePath: r.filePath,
        isDirect: false,
        sourceLabel: `Receipt${r.merchant ? ` · ${r.merchant}` : ''}`,
        sourceIcon: 'fas fa-receipt',
      });
    });
  } else {
    (state.planner.org?.documents || []).forEach((d) => {
      docs.push({ ...d, isDirect: true, sourceLabel: 'Document', sourceIcon: 'fas fa-file-alt' });
    });

    (state.planner.org?.teamAssignments || []).forEach((a) => {
      const member = (state.global?.teamMembers || []).find((m) => m.id === a.memberId);
      const memberName = member?.name || 'Team member';

      sortLegs(a.outboundLegs || []).forEach((leg) => {
        if (!leg.filePath) return;
        const route = [leg.from, leg.to].filter(Boolean).join(' → ');
        const modeInfo = TRAVEL_MODES[leg.mode] || TRAVEL_MODES.other;
        docs.push({
          id: `tleg-out-${leg.id}`,
          name: fileDisplayName(leg.filePath, leg.fileLabel),
          filePath: leg.filePath,
          isDirect: false,
          sourceLabel: `${memberName} · Outbound${route ? ` · ${route}` : ''}`,
          sourceIcon: modeInfo.icon || 'fas fa-route',
        });
      });

      sortLegs(a.returnLegs || []).forEach((leg) => {
        if (!leg.filePath) return;
        const route = [leg.from, leg.to].filter(Boolean).join(' → ');
        const modeInfo = TRAVEL_MODES[leg.mode] || TRAVEL_MODES.other;
        docs.push({
          id: `tleg-ret-${leg.id}`,
          name: fileDisplayName(leg.filePath, leg.fileLabel),
          filePath: leg.filePath,
          isDirect: false,
          sourceLabel: `${memberName} · Return${route ? ` · ${route}` : ''}`,
          sourceIcon: modeInfo.returnIcon || modeInfo.icon || 'fas fa-route',
        });
      });
    });

    (state.planner.org?.accommodations || []).forEach((accom) => {
      if (!accom.filePath) return;
      docs.push({
        id: `oaccom-${accom.id}`,
        name: fileDisplayName(accom.filePath, accom.fileLabel),
        filePath: accom.filePath,
        isDirect: false,
        sourceLabel: `Team accommodation${accom.name ? ` · ${accom.name}` : ''}`,
        sourceIcon: 'fas fa-building',
      });
    });
  }

  return docs;
}

function documentCardHtml(doc) {
  const date = doc.updatedAt
    ? new Date(doc.updatedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : '';

  if (doc.isDirect) {
    return `
      <div class="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-gray-200 bg-white group" data-doc-id="${esc(doc.id)}">
        <i class="fas fa-file-alt text-gray-400 flex-shrink-0 text-sm" aria-hidden="true"></i>
        <div class="flex-1 min-w-0">
          <input type="text" class="doc-name-input w-full border-0 border-b border-transparent hover:border-gray-200 focus:border-gray-300 focus:ring-0 bg-transparent text-sm text-gray-800 px-0 py-0.5 transition-colors"
            data-doc-id="${esc(doc.id)}" value="${esc(doc.name)}" placeholder="Document name"
            aria-label="Document name for ${esc(doc.name || 'this file')}">
          ${date ? `<p class="text-xs text-gray-400 mt-0.5">Updated ${esc(date)}</p>` : ''}
        </div>
        ${doc.filePath
          ? `<a href="${esc(doc.filePath)}" target="_blank"
               class="flex-shrink-0 h-8 px-3 border border-gray-300 rounded-md text-xs text-blue-600 hover:bg-blue-50 transition-colors inline-flex items-center"
               aria-label="View ${esc(doc.name || 'document')}">
               <i class="fas fa-external-link-alt mr-1 text-[0.65rem]" aria-hidden="true"></i>View
             </a>`
          : '<span class="text-xs text-gray-400 flex-shrink-0 italic">No file</span>'
        }
        <button type="button" class="delete-doc-btn flex-shrink-0 text-gray-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
          data-doc-id="${esc(doc.id)}" aria-label="Delete ${esc(doc.name || 'document')}">
          <i class="fas fa-times text-xs" aria-hidden="true"></i>
        </button>
      </div>`;
  }

  return `
    <div class="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-gray-100 bg-gray-50">
      <i class="${esc(doc.sourceIcon)} text-gray-400 flex-shrink-0 text-sm" aria-hidden="true"></i>
      <div class="flex-1 min-w-0">
        <p class="text-sm text-gray-800 truncate">${esc(doc.name || 'Attached file')}</p>
        <p class="text-xs text-gray-400 mt-0.5">${esc(doc.sourceLabel)}</p>
      </div>
      ${doc.filePath
        ? `<a href="${esc(doc.filePath)}" target="_blank"
             class="flex-shrink-0 h-8 px-3 border border-gray-300 rounded-md text-xs text-blue-600 hover:bg-blue-50 transition-colors inline-flex items-center"
             aria-label="View ${esc(doc.name || 'document')}">
             <i class="fas fa-external-link-alt mr-1 text-[0.65rem]" aria-hidden="true"></i>View
           </a>`
        : ''
      }
    </div>`;
}

function renderDocumentsTab() {
  const list  = document.getElementById('documentsList');
  const empty = document.getElementById('documentsEmptyState');
  if (!list) return;
  const docs = collectDocuments();
  empty?.classList.toggle('hidden', docs.length > 0);
  list.innerHTML = docs.map(documentCardHtml).join('');
}

function wireDocumentsPanel() {
  const panel = document.getElementById('plannerDocumentsPanel');
  if (!panel) return;

  document.getElementById('uploadDocBtn')?.addEventListener('click', () => {
    document.getElementById('docFileInput')?.click();
  });

  document.getElementById('docFileInput')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const { path, label } = await uploadOrReadFile(file);
      const doc = {
        id: makeItemId('doc'),
        name: label,
        filePath: path,
        fileLabel: label,
        updatedAt: new Date().toISOString(),
      };
      const mode = state.planner.mode || 'personal';
      if (mode === 'sponsor') {
        state.planner.org.documents = [...(state.planner.org.documents || []), doc];
      } else {
        if (!state.planner.personal) state.planner.personal = {};
        state.planner.personal.documents = [...(state.planner.personal.documents || []), doc];
      }
      scheduleAutoSave();
      renderDocumentsTab();
    } catch (err) { window.alert(err.message); }
    e.target.value = '';
  });

  panel.addEventListener('input', (e) => {
    const input = e.target.closest('.doc-name-input');
    if (!input) return;
    const id   = input.dataset.docId;
    const mode = state.planner.mode || 'personal';
    const arr  = mode === 'sponsor' ? (state.planner.org.documents || []) : (state.planner.personal.documents || []);
    const doc  = arr.find((d) => d.id === id);
    if (doc) { doc.name = input.value; doc.updatedAt = new Date().toISOString(); scheduleAutoSave(); }
  });

  panel.addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('.delete-doc-btn');
    if (!deleteBtn) return;
    const id = deleteBtn.dataset.docId;
    if (window.confirm('Delete this document?')) {
      const mode = state.planner.mode || 'personal';
      if (mode === 'sponsor') {
        state.planner.org.documents = (state.planner.org.documents || []).filter((d) => d.id !== id);
      } else {
        state.planner.personal.documents = (state.planner.personal.documents || []).filter((d) => d.id !== id);
      }
      scheduleAutoSave();
      renderDocumentsTab();
    }
  });
}

function wireToolbar() {
  // Tab buttons
  document.getElementById('showContactsTab')?.addEventListener('click', () => setActiveTab('contacts'));
  document.getElementById('showTasksTab')?.addEventListener('click', () => setActiveTab('tasks'));
  document.getElementById('showSponsorTab')?.addEventListener('click', () => { setActiveTab('sponsor'); renderSponsorBudgetBreakdown(); });
  document.getElementById('showPersonalTab')?.addEventListener('click', () => { setActiveTab('personal'); renderPersonalBudgetBreakdown(); });
  document.getElementById('showTeamTab')?.addEventListener('click', () => setActiveTab('team'));
  document.getElementById('showDocumentsTab')?.addEventListener('click', () => setActiveTab('documents'));
  document.getElementById('showReceiptsTab')?.addEventListener('click', () => setActiveTab('receipts'));
  document.getElementById('showSummaryTab')?.addEventListener('click', () => { setActiveTab('summary'); renderSummaryTab(); });

  // Mode toggle
  document.getElementById('modeToggleSponsor')?.addEventListener('click', () => applyMode('sponsor'));
  document.getElementById('modeTogglePersonal')?.addEventListener('click', () => applyMode('personal'));

  // Export / import / save-to-file
  document.getElementById('plannerExportBtn')?.addEventListener('click', handleExport);

  const importBtn   = document.getElementById('plannerImportBtn');
  const importInput = document.getElementById('plannerImportInput');
  importBtn?.addEventListener('click', () => importInput?.click());
  importInput?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) { handleImport(file); e.target.value = ''; }
  });

  document.getElementById('plannerSaveFileBtn')?.addEventListener('click', handleSaveToFile);
}

// ── Init ─────────────────────────────────────────────────────────────────────

function revealPage() {
  document.documentElement.style.opacity = '1';
}

function updateHeader() {
  const meta = state.eventMeta;
  if (!meta) return;
  const kicker = [meta.designation, meta.location].filter(Boolean).join(' · ');
  const title  = meta.year ? `${meta.location || meta.designation} ${meta.year}` : (meta.location || meta.designation || 'Trip Notebook');
  const kickerEl = document.getElementById('plannerHeaderKicker');
  const eventEl  = document.getElementById('plannerHeaderEvent');
  const nameEl   = document.getElementById('plannerEventName');
  if (kickerEl) kickerEl.textContent = kicker || 'Conference Planner';
  if (eventEl)  eventEl.textContent  = title;
  if (nameEl)   nameEl.textContent   = title;

  // Show "Save to file" button if API is configured
  const apiEndpoint = localStorage.getItem('editorApiEndpoint') || '';
  if (apiEndpoint) document.getElementById('plannerSaveFileBtn')?.classList.remove('hidden');
}

async function init() {
  await loadThemes();
  applyThemeClass(getCurrentThemeId());

  const eventFile = localStorage.getItem('selectedEventFile');

  if (!eventFile) {
    document.getElementById('plannerNoEvent')?.classList.remove('hidden');
    document.getElementById('plannerApp')?.classList.add('hidden');
    revealPage();
    return;
  }

  state.eventFile = eventFile;

  try {
    const res  = await fetch(`./data/${eventFile}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.eventMeta   = data.event || {};
    state.allSessions = (data.items || []).map((session) => ({
      ...session,
      id: `${session.startTime}-${session.location}-${session.title}`.replace(/[^a-zA-Z0-9-]/g, '-'),
    }));
    applyTheme();
  } catch (err) {
    console.warn('Could not load event data:', err);
    state.eventMeta   = {};
    state.allSessions = [];
  }

  state.global  = loadGlobal();
  state.planner = loadPlanner(eventFile);

  syncSponsoredSessions();

  updateHeader();
  renderAll();
  applyMode(state.planner.mode || 'personal');

  wireToolbar();
  wireContactsPanel();
  wireTasksPanel();
  wireOrgPanel();
  wirePersonalPanel();
  wireTrackedSessionModal();
  wireSwagModal();
  wirePersonalLegModal();
  wirePersonalAccomModal();
  wireTeamPanel();
  wireItineraryPanel();
  wireDocumentsPanel();
  wireReceiptsPanel();
  wireSummaryPanel();

  // Inject timezone datalist once
  if (!document.getElementById('tzList')) {
    const dl = document.createElement('datalist');
    dl.id = 'tzList';
    dl.innerHTML = tzDatalist();
    document.body.appendChild(dl);
  }

  revealPage();
}

document.addEventListener('DOMContentLoaded', init);
