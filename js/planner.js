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

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  eventFile: null,
  eventMeta: null,
  allSessions: [],
  planner: null,
  global: null,
  activeTab: 'notes',
  notesSearchQuery: '',
  tasksFilter: 'all',
  dirty: false,
};

// ── Utilities ────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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

function currencyOptions(selected = 'AUD') {
  return CURRENCIES.map((c) => `<option value="${c}"${c === selected ? ' selected' : ''}>${c}</option>`).join('')
}

function tzDatalist() {
  const tzs = typeof Intl !== 'undefined' && Intl.supportedValuesOf
    ? Intl.supportedValuesOf('timeZone')
    : []
  return tzs.map((tz) => `<option value="${tz}">`).join('')
}

function parseBudget(str) {
  const n = parseFloat(String(str || '').replace(/[^0-9.]/g, ''))
  return isNaN(n) ? 0 : n
}

// ── Tab system ───────────────────────────────────────────────────────────────

const TABS = ['notes', 'contacts', 'tasks', 'org', 'team', 'itinerary', 'receipts', 'summary'];

const PANEL_IDS = {
  notes:     'plannerNotesPanel',
  contacts:  'plannerContactsPanel',
  tasks:     'plannerTasksPanel',
  org:       'plannerOrgPanel',
  team:      'plannerTeamPanel',
  itinerary: 'plannerItineraryPanel',
  receipts:  'plannerReceiptsPanel',
  summary:   'plannerSummaryPanel',
};

const TAB_BTN_IDS = {
  notes:     'showNotesTab',
  contacts:  'showContactsTab',
  tasks:     'showTasksTab',
  org:       'showOrgTab',
  team:      'showTeamTab',
  itinerary: 'showItineraryTab',
  receipts:  'showReceiptsTab',
  summary:   'showSummaryTab',
};

function setActiveTab(tab) {
  const next = TABS.includes(tab) ? tab : 'notes';
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
  flight:   { label: '✈ Flight',    icon: 'fas fa-plane-departure', returnIcon: 'fas fa-plane-arrival' },
  train:    { label: '🚂 Train',    icon: 'fas fa-train' },
  bus:      { label: '🚌 Bus',      icon: 'fas fa-bus' },
  ferry:    { label: '⛴ Ferry',    icon: 'fas fa-ship' },
  car:      { label: '🚗 Transfer', icon: 'fas fa-car' },
  other:    { label: '↔ Other',    icon: 'fas fa-route' },
};

function travelIcon(mode, isReturn) {
  const m = TRAVEL_MODES[mode] || TRAVEL_MODES.other;
  return isReturn && m.returnIcon ? m.returnIcon : m.icon;
}

function makeLeg() {
  return { id: makeItemId('leg'), mode: 'flight', date: '', ref: '', from: '', to: '', departTime: '', arriveTime: '', departTz: '', arriveTz: '', confirmation: '', notes: '' };
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
    </div>`;
}

function renderAssignmentLegsInModal(assignment) {
  const empty = '<p class="text-xs text-gray-400 italic py-1">No legs yet. Click Add leg to start.</p>';
  const outEl = document.getElementById('assignmentOutboundLegs');
  const retEl = document.getElementById('assignmentReturnLegs');
  if (outEl) outEl.innerHTML = (assignment.outboundLegs || []).length
    ? assignment.outboundLegs.map((l) => legCardHtml(l, 'outbound')).join('')
    : empty;
  if (retEl) retEl.innerHTML = (assignment.returnLegs || []).length
    ? assignment.returnLegs.map((l) => legCardHtml(l, 'return')).join('')
    : empty;
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
      <button type="button" class="edit-assignment-btn h-8 px-3 border border-gray-300 rounded-md text-xs text-gray-600 hover:bg-gray-50 transition-colors flex-shrink-0" data-member-id="${esc(assignment.memberId)}">
        <i class="fas fa-pen-to-square mr-1.5 text-[0.65rem]"></i>Edit
      </button>
      <button type="button" class="remove-assignment-btn flex-shrink-0 text-gray-300 hover:text-red-500 transition-colors" data-member-id="${esc(assignment.memberId)}" aria-label="Remove from event">
        <i class="fas fa-times text-xs"></i>
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
      <button type="button" class="edit-accommodation-btn h-8 px-3 border border-gray-300 rounded-md text-xs text-gray-600 hover:bg-gray-50 transition-colors flex-shrink-0" data-accom-id="${esc(acc.id)}">
        <i class="fas fa-pen-to-square mr-1.5 text-[0.65rem]"></i>Edit
      </button>
      <button type="button" class="delete-accommodation-btn flex-shrink-0 text-gray-300 hover:text-red-500 transition-colors" data-accom-id="${esc(acc.id)}" aria-label="Remove">
        <i class="fas fa-times text-xs"></i>
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
    swagList.innerHTML = (org.swag || []).map((item) => checklistItemHtml(item, 'swag')).join('');
    swagEmpty?.classList.toggle('hidden', (org.swag || []).length > 0);
  }

  const delivList  = document.getElementById('orgDeliverablesList');
  const delivEmpty = document.getElementById('orgDeliverablesEmpty');
  if (delivList) {
    delivList.innerHTML = (org.deliverables || []).map((item) => checklistItemHtml(item, 'deliverables')).join('');
    delivEmpty?.classList.toggle('hidden', (org.deliverables || []).length > 0);
  }

  renderTimeline();
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

function closeAssignmentModal() {
  const modal = document.getElementById('assignmentModal');
  if (!modal) return;
  modal.classList.add('hidden');
  document.body.style.overflow = '';
  renderOrgTab();
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

  renderAccomMembersSection(acc);

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  modal.querySelector('input')?.focus();
}

function closeAccommodationModal() {
  const modal = document.getElementById('accommodationModal');
  if (!modal) return;
  modal.classList.add('hidden');
  document.body.style.overflow = '';
  renderOrgTab();
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
      <button type="button" class="delete-${listType}-btn flex-shrink-0 text-gray-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100" data-${listType}-id="${esc(item.id)}" aria-label="Remove item">
        <i class="fas fa-times text-xs"></i>
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
  const items = (state.planner.itinerary || [])
    .filter((i) => i.memberId === memberId && i.date === date)
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''))

  if (!items.length) {
    container.innerHTML = '<p class="text-xs text-gray-400 italic py-1">No items yet. Click Add item to start.</p>'
    return
  }
  container.innerHTML = items.map((item) => `
    <div class="flex items-start gap-2 p-2 rounded-md border border-gray-200 bg-white" data-itinerary-item-id="${esc(item.id)}">
      <input type="checkbox" class="mt-0.5 h-4 w-4 rounded flex-shrink-0 itinerary-done-check" data-item-id="${esc(item.id)}" ${item.done ? 'checked' : ''} aria-label="Mark done">
      <div class="flex-1 min-w-0">
        <p class="text-sm ${item.done ? 'line-through text-gray-400' : 'text-gray-800'} font-medium">${esc(item.title)}</p>
        <div class="flex items-center gap-2 mt-0.5 flex-wrap">
          ${item.time ? `<span class="text-xs text-gray-500"><i class="fas fa-clock text-[0.6rem] mr-0.5"></i>${esc(item.time)}</span>` : ''}
          ${item.location ? `<span class="text-xs text-gray-500"><i class="fas fa-location-dot text-[0.6rem] mr-0.5"></i>${esc(item.location)}</span>` : ''}
          ${item.notes ? `<span class="text-xs text-gray-400 truncate">${esc(item.notes)}</span>` : ''}
        </div>
      </div>
      <button type="button" class="itinerary-edit-btn flex-shrink-0 text-gray-400 hover:text-blue-500 transition-colors" data-item-id="${esc(item.id)}" title="Edit">
        <i class="fas fa-pen-to-square text-xs"></i>
      </button>
      <button type="button" class="itinerary-delete-btn flex-shrink-0 text-gray-300 hover:text-red-500 transition-colors" data-item-id="${esc(item.id)}" title="Delete">
        <i class="fas fa-times text-xs"></i>
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
  const modal = document.getElementById('itineraryDayModal')
  if (!modal) return
  modal.classList.add('hidden')
  document.body.style.overflow = ''
  renderItineraryTab()
}

function wireItineraryPanel() {
  // Date range inputs
  document.getElementById('itineraryStartDate')?.addEventListener('change', () => {
    renderItineraryTab(); scheduleAutoSave();
  });
  document.getElementById('itineraryEndDate')?.addEventListener('change', () => {
    renderItineraryTab(); scheduleAutoSave();
  });

  // Standalone add button (no grid cell context)
  document.getElementById('addItineraryItemStandalone')?.addEventListener('click', () => {
    openItineraryDayModal(null, null)
  })

  // Grid cell clicks (delegated from panel)
  const panel = document.getElementById('plannerItineraryPanel')
  panel?.addEventListener('click', (e) => {
    const cell = e.target.closest('.itinerary-cell')
    if (cell) {
      openItineraryDayModal(cell.dataset.memberId, cell.dataset.date)
      return
    }
  })

  // Modal wiring
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

    const editId = document.getElementById('itineraryFormEditId')?.value || ''
    if (editId) {
      const item = (state.planner.itinerary || []).find((i) => i.id === editId)
      if (item) {
        item.title    = title
        item.time     = document.getElementById('itineraryFormTime').value
        item.location = document.getElementById('itineraryFormLocation').value
        item.notes    = document.getElementById('itineraryFormNotes').value
      }
    } else {
      const item = makeItineraryItem(memberId, date)
      item.title    = title
      item.time     = document.getElementById('itineraryFormTime').value
      item.location = document.getElementById('itineraryFormLocation').value
      item.notes    = document.getElementById('itineraryFormNotes').value
      state.planner.itinerary = [...(state.planner.itinerary || []), item]
    }
    document.getElementById('itineraryAddForm')?.classList.add('hidden')
    if (isStandalone) {
      closeItineraryDayModal()
    } else {
      renderItineraryDayItems(memberId, date)
    }
    scheduleAutoSave()
  })

  // Item done / edit / delete
  modal.addEventListener('change', (e) => {
    if (e.target.classList.contains('itinerary-done-check')) {
      const id   = e.target.dataset.itemId
      const item = (state.planner.itinerary || []).find((i) => i.id === id)
      if (item) { item.done = e.target.checked; renderItineraryDayItems(modal.dataset.memberId, modal.dataset.date); scheduleAutoSave() }
    }
  })

  modal.addEventListener('click', (e) => {
    if (e.target === modal) { closeItineraryDayModal(); return }

    const editBtn = e.target.closest('.itinerary-edit-btn')
    if (editBtn) {
      const id   = editBtn.dataset.itemId
      const item = (state.planner.itinerary || []).find((i) => i.id === id)
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
      const id = delBtn.dataset.itemId
      state.planner.itinerary = (state.planner.itinerary || []).filter((i) => i.id !== id)
      renderItineraryDayItems(modal.dataset.memberId, modal.dataset.date)
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
  return { id: makeItemId('rc'), name: '', date: '', amount: '', currency: 'AUD', filePath: '', notes: '' }
}

function receiptCardHtml(receipt) {
  return `
    <details class="rounded-md border border-gray-200 overflow-hidden" data-receipt-id="${esc(receipt.id)}">
      <summary class="flex items-center gap-3 px-4 py-3 cursor-pointer select-none hover:bg-gray-50 transition-colors list-none">
        <i class="fas fa-chevron-right text-gray-400 text-xs flex-shrink-0 transition-transform receipt-chevron"></i>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium text-gray-800">${esc(receipt.name || 'New Receipt')}</p>
          <p class="text-xs text-gray-500">${receipt.date ? esc(receipt.date) : ''}${receipt.amount ? ` · ${esc(receipt.amount)} ${esc(receipt.currency || '')}` : ''}</p>
        </div>
        ${receipt.filePath ? '<span class="text-xs text-blue-500 flex-shrink-0"><i class="fas fa-paperclip text-[0.65rem]"></i></span>' : ''}
        <button type="button" class="delete-receipt-btn flex-shrink-0 text-gray-400 hover:text-red-500 transition-colors px-1" data-receipt-id="${esc(receipt.id)}" title="Delete">
          <i class="fas fa-trash text-xs"></i>
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
            <span class="editor-field-label">Currency</span>
            <select data-receipt-id="${esc(receipt.id)}" data-receipt-field="currency"
              class="h-9 w-full rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3">
              ${currencyOptions(receipt.currency || 'AUD')}
            </select>
          </label>
          <label class="editor-form-field">
            <span class="editor-field-label">File attachment</span>
            <div class="flex items-center gap-2">
              ${receipt.filePath ? `<a href="${esc(receipt.filePath)}" target="_blank" class="text-xs drupal-blue-text truncate flex-1">${esc(receipt.filePath.split('/').pop())}</a>` : '<span class="text-xs text-gray-400 flex-1">No file attached</span>'}
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
    scheduleAutoSave()
  })

  panel.addEventListener('change', (e) => {
    const id    = e.target.dataset.receiptId
    const field = e.target.dataset.receiptField
    if (!id || !field) return
    const receipt = (state.planner.receipts || []).find((r) => r.id === id)
    if (!receipt) return
    receipt[field] = e.target.value
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

  // File input change — upload to API or store locally
  document.getElementById('receiptFileInput')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const rid     = e.target.dataset.receiptId
    const receipt = (state.planner.receipts || []).find((r) => r.id === rid)
    if (!receipt) return

    const apiEndpoint = localStorage.getItem('editorApiEndpoint') || ''
    if (apiEndpoint) {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('eventFile', state.eventFile)
      try {
        const res  = await fetch(`${apiEndpoint.replace(/\/$/, '')}/api/receipts`, { method: 'POST', body: formData })
        const data = await res.json()
        if (data.ok) {
          receipt.filePath = data.path
        } else {
          window.alert(`Upload failed: ${data.error}`)
        }
      } catch (err) {
        window.alert(`Upload failed: ${err.message}`)
      }
    } else {
      // No API — store the filename only
      receipt.filePath = file.name
    }
    renderReceiptsTab()
    scheduleAutoSave()
    e.target.value = ''
  })
}

// ── Summary tab ───────────────────────────────────────────────────────────────

let _budgetChart       = null
let _globalBudgetChart = null

function renderSummaryTab() {
  const statsGrid = document.getElementById('summaryStatsGrid')
  if (!statsGrid) return

  const org = state.planner.org
  const assignments   = org.teamAssignments   || []
  const accommodations = org.accommodations   || []
  const tasks         = state.planner.tasks   || []
  const contacts      = state.planner.contacts || []
  const notes         = state.planner.sessionNotes || {}

  // Counts
  const memberCount = assignments.length
  const totalLegs   = assignments.reduce((sum, a) => sum + (a.outboundLegs?.length || 0) + (a.returnLegs?.length || 0), 0)
  const totalNights = accommodations.reduce((sum, acc) => {
    return sum + (acc.assignments || []).reduce((s2, a) => {
      if (!a.checkIn || !a.checkOut) return s2
      const nights = Math.round((new Date(a.checkOut) - new Date(a.checkIn)) / 86400000)
      return s2 + (nights > 0 ? nights : 0)
    }, 0)
  }, 0)
  const tasksDone  = tasks.filter((t) => t.done).length
  const tasksOpen  = tasks.filter((t) => !t.done).length
  const contactCount = contacts.length
  const notedCount   = Object.values(notes).filter((n) => n.notes || n.rating || n.attended).length

  // Budget totals per member
  const memberLabels   = []
  const memberBudgets  = []
  const memberActuals  = []
  let totalBudget = 0; let totalActual = 0

  assignments.forEach((a) => {
    const member = state.global?.teamMembers.find((m) => m.id === a.memberId)
    const b = parseBudget(a.budget)
    const ac = parseBudget(a.budgetActual)
    totalBudget += b; totalActual += ac
    memberLabels.push(member?.name || 'Unnamed')
    memberBudgets.push(b)
    memberActuals.push(ac)
  })
  // Add accommodation budgets to totals
  accommodations.forEach((acc) => {
    totalBudget += parseBudget(acc.budget)
    totalActual += parseBudget(acc.budgetActual)
  })

  // Stat cards
  function statCard(icon, label, value) {
    return `<div class="rounded-lg border border-gray-200 bg-gray-50 p-3 text-center">
      <p class="text-[0.65rem] text-gray-400 uppercase tracking-widest mb-1">${esc(label)}</p>
      <p class="text-xl font-semibold text-gray-800">${esc(String(value))}</p>
      <i class="${icon} text-gray-300 text-xs mt-0.5 block"></i>
    </div>`
  }
  statsGrid.innerHTML = [
    statCard('fas fa-users',        'Members',    memberCount),
    statCard('fas fa-plane',        'Legs',       totalLegs),
    statCard('fas fa-bed',          'Nights',     totalNights),
    statCard('fas fa-list-check',   'Tasks open', tasksOpen),
    statCard('fas fa-check-circle', 'Tasks done', tasksDone),
    statCard('fas fa-address-book', 'Contacts',   contactCount),
    statCard('fas fa-file-lines',   'Sessions noted', notedCount),
    (totalBudget || totalActual) ? statCard('fas fa-wallet', 'Budget', totalBudget.toLocaleString()) : '',
    (totalBudget || totalActual) ? statCard('fas fa-receipt', 'Actual', totalActual.toLocaleString()) : '',
  ].filter(Boolean).join('')

  // Budget chart — per-member horizontal bar
  const budgetCanvas = document.getElementById('budgetChart')
  if (budgetCanvas) {
    if (_budgetChart) { _budgetChart.destroy(); _budgetChart = null }
    if (memberLabels.length) {
      _budgetChart = new Chart(budgetCanvas, {
        type: 'bar',
        data: {
          labels: memberLabels,
          datasets: [
            { label: 'Budget',  data: memberBudgets, backgroundColor: 'rgba(59,130,246,0.5)', borderColor: '#3b82f6', borderWidth: 1 },
            { label: 'Actual',  data: memberActuals, backgroundColor: 'rgba(16,185,129,0.5)', borderColor: '#10b981', borderWidth: 1 },
          ],
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          plugins: { legend: { position: 'top' } },
          scales: { x: { beginAtZero: true } },
        },
      })
    } else {
      const ctx = budgetCanvas.getContext('2d')
      ctx.clearRect(0, 0, budgetCanvas.width, budgetCanvas.height)
    }
  }

  // Global: scan localStorage for other planners
  const globalLabels  = []
  const globalBudgets = []
  const globalActuals = []
  let globalTotalBudget = 0; let globalTotalActual = 0

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key?.startsWith('drupalconPlanner_') || key === 'drupalconPlanner_global') continue
    try {
      const data = JSON.parse(localStorage.getItem(key) || '{}')
      const eventLabel = data._eventFile?.replace('.json', '') || key.replace('drupalconPlanner_', '')
      let eb = 0; let ea = 0
      ;(data.org?.teamAssignments || []).forEach((a) => { eb += parseBudget(a.budget); ea += parseBudget(a.budgetActual) })
      ;(data.org?.accommodations  || []).forEach((a) => { eb += parseBudget(a.budget); ea += parseBudget(a.budgetActual) })
      globalTotalBudget += eb; globalTotalActual += ea
      globalLabels.push(eventLabel)
      globalBudgets.push(eb)
      globalActuals.push(ea)
    } catch { /* skip corrupt */ }
  }

  const globalStatsRow = document.getElementById('globalSummaryStatsRow')
  if (globalStatsRow) {
    globalStatsRow.innerHTML = [
      statCard('fas fa-calendar-check', 'Events tracked', globalLabels.length),
      statCard('fas fa-wallet',  'Total budget', globalTotalBudget.toLocaleString()),
      statCard('fas fa-receipt', 'Total actual', globalTotalActual.toLocaleString()),
    ].join('')
  }

  const globalCanvas = document.getElementById('globalBudgetChart')
  if (globalCanvas) {
    if (_globalBudgetChart) { _globalBudgetChart.destroy(); _globalBudgetChart = null }
    if (globalLabels.length) {
      _globalBudgetChart = new Chart(globalCanvas, {
        type: 'bar',
        data: {
          labels: globalLabels,
          datasets: [
            { label: 'Budget', data: globalBudgets, backgroundColor: 'rgba(59,130,246,0.5)', borderColor: '#3b82f6', borderWidth: 1 },
            { label: 'Actual', data: globalActuals, backgroundColor: 'rgba(16,185,129,0.5)', borderColor: '#10b981', borderWidth: 1 },
          ],
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          plugins: { legend: { position: 'top' } },
          scales: { x: { beginAtZero: true } },
        },
      })
    } else {
      const ctx = globalCanvas.getContext('2d')
      ctx.clearRect(0, 0, globalCanvas.width, globalCanvas.height)
    }
  }
}

function wireSummaryPanel() {
  // Nothing to wire — renderSummaryTab is called on tab switch and renderAll
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

// ── Render all tabs ──────────────────────────────────────────────────────────

function renderAll() {
  renderNotesTab();
  renderContactsTab();
  renderTasksTab();
  renderOrgTab();
  renderTeamTab();
  renderItineraryTab();
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
  const panel = document.getElementById('plannerOrgPanel');
  if (!panel) return;

  // ── Booth fields ────────────────────────────────────────────────────────────
  panel.addEventListener('input', (e) => {
    if (e.target.id === 'orgBoothInfo')  { state.planner.org.boothInfo  = e.target.value; scheduleAutoSave(); return; }
    if (e.target.id === 'orgBoothNotes') { state.planner.org.boothNotes = e.target.value; scheduleAutoSave(); return; }

    const swagId    = e.target.dataset.swagId;
    const swagField = e.target.dataset.swagField;
    if (swagId && swagField && swagField !== 'done') {
      const item = state.planner.org.swag.find((x) => x.id === swagId);
      if (item) { item[swagField] = e.target.value; scheduleAutoSave(); }
      return;
    }
    const delivId    = e.target.dataset.deliverablesId;
    const delivField = e.target.dataset.deliverablesField;
    if (delivId && delivField && delivField !== 'done') {
      const item = state.planner.org.deliverables.find((x) => x.id === delivId);
      if (item) { item[delivField] = e.target.value; scheduleAutoSave(); }
    }
  });

  panel.addEventListener('change', (e) => {
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

    const swagId    = e.target.dataset.swagId;
    const swagField = e.target.dataset.swagField;
    if (swagId && swagField === 'done') {
      const item = state.planner.org.swag.find((x) => x.id === swagId);
      if (item) {
        item.done = e.target.checked;
        const row = e.target.closest(`[data-swag-id="${swagId}"]`);
        row?.querySelector('[data-swag-field="label"]')?.classList.toggle('line-through', item.done);
        row?.querySelector('[data-swag-field="label"]')?.classList.toggle('text-gray-400', item.done);
        scheduleAutoSave();
      }
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

    if (e.target.closest('.delete-swag-btn')) {
      const id = e.target.closest('.delete-swag-btn').dataset.swagId;
      state.planner.org.swag = state.planner.org.swag.filter((x) => x.id !== id);
      renderOrgTab(); scheduleAutoSave(); return;
    }
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
    state.planner.org.swag.push({ id: makeItemId('sw'), label: '', done: false });
    renderOrgTab(); scheduleAutoSave();
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

    assignModal.addEventListener('input',  handleAssignField);
    assignModal.addEventListener('change', handleAssignField);

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
      if (e.target === assignModal) { closeAssignmentModal(); return; }
      const removeBtn = e.target.closest('.remove-leg-btn');
      if (removeBtn) {
        const { legId, direction } = removeBtn.dataset;
        const assignment = getAssignment();
        if (!assignment) return;
        if (direction === 'outbound') assignment.outboundLegs = assignment.outboundLegs.filter((l) => l.id !== legId);
        else assignment.returnLegs = assignment.returnLegs.filter((l) => l.id !== legId);
        renderAssignmentLegsInModal(assignment);
        scheduleAutoSave();
      }
    });

    document.getElementById('assignmentModalClose')?.addEventListener('click', closeAssignmentModal);
    document.getElementById('assignmentModalDone')?.addEventListener('click',  closeAssignmentModal);
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

    accomModal.addEventListener('input',  handleAccomField);
    accomModal.addEventListener('change', handleAccomField);

    document.getElementById('accommodationModalClose')?.addEventListener('click', closeAccommodationModal);
    document.getElementById('accommodationModalDone')?.addEventListener('click',  closeAccommodationModal);

    document.getElementById('accommodationModalDelete')?.addEventListener('click', () => {
      const id = accomModal.dataset.accomId;
      state.planner.org.accommodations = (state.planner.org.accommodations || []).filter((a) => a.id !== id);
      scheduleAutoSave();
      closeAccommodationModal();
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

    accomModal.addEventListener('click', (e) => { if (e.target === accomModal) closeAccommodationModal(); });
  }

  // Global Escape key handler for org modals
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (assignModal && !assignModal.classList.contains('hidden')) { closeAssignmentModal(); return; }
    if (accomModal  && !accomModal.classList.contains('hidden'))  { closeAccommodationModal(); }
  });
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

function closeTeamMemberModal() {
  const modal = document.getElementById('teamMemberModal');
  if (!modal) return;
  modal.classList.add('hidden');
  document.body.style.overflow = '';
  renderTeamTab();
  refreshAssignMemberSelect();
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

  // Live-save on input
  modal.addEventListener('input', () => {
    const id = modal.dataset.memberId;
    if (!id) return; // new member — save on Done
    const member = (state.global?.teamMembers || []).find((m) => m.id === id);
    if (!member) return;
    Object.assign(member, readModalFields());
    saveGlobal(state.global);
  });

  document.getElementById('teamMemberModalDone')?.addEventListener('click', () => {
    const id     = modal.dataset.memberId;
    const fields = readModalFields();
    if (!id) {
      // New member
      const member = { id: makeItemId('tm'), ...fields };
      state.global.teamMembers = [...(state.global?.teamMembers || []), member];
    } else {
      const member = (state.global?.teamMembers || []).find((m) => m.id === id);
      if (member) Object.assign(member, fields);
    }
    saveGlobal(state.global);
    closeTeamMemberModal();
  });

  document.getElementById('teamMemberModalDelete')?.addEventListener('click', () => {
    const id = modal.dataset.memberId;
    if (!id) return;
    state.global.teamMembers = (state.global?.teamMembers || []).filter((m) => m.id !== id);
    saveGlobal(state.global);
    closeTeamMemberModal();
  });

  document.getElementById('teamMemberModalClose')?.addEventListener('click', closeTeamMemberModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeTeamMemberModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeTeamMemberModal();
  });
}

function wireToolbar() {
  // Tab buttons
  document.getElementById('showNotesTab')?.addEventListener('click', () => setActiveTab('notes'));
  document.getElementById('showContactsTab')?.addEventListener('click', () => setActiveTab('contacts'));
  document.getElementById('showTasksTab')?.addEventListener('click', () => setActiveTab('tasks'));
  document.getElementById('showOrgTab')?.addEventListener('click', () => setActiveTab('org'));
  document.getElementById('showTeamTab')?.addEventListener('click', () => setActiveTab('team'));
  document.getElementById('showItineraryTab')?.addEventListener('click', () => setActiveTab('itinerary'));
  document.getElementById('showReceiptsTab')?.addEventListener('click', () => setActiveTab('receipts'));
  document.getElementById('showSummaryTab')?.addEventListener('click', () => { setActiveTab('summary'); renderSummaryTab(); });

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

  updateHeader();
  renderAll();

  wireToolbar();
  wireNotesPanel();
  wireContactsPanel();
  wireTasksPanel();
  wireOrgPanel();
  wireTeamPanel();
  wireItineraryPanel();
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
