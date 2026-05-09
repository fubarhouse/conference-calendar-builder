import { escapeHtml } from './utils.js';
import { icon } from './icons.js';

const SEARCH_MODAL_ID = 'eventSearchModal';
let _getEvents = () => [];
let _onSelect = async () => {};

export function configureEventSearch({ getEvents, onSelect }) {
  _getEvents = getEvents;
  _onSelect = onSelect;
}

function formatEventDateRange(startIso, endIso, timezone) {
  if (!startIso) return '';
  const tz = timezone || 'UTC';
  const startDate = new Date(startIso);
  const endDate = endIso ? new Date(endIso) : null;
  const fmtDay = (d) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', timeZone: tz }).format(d);
  const fmtMonth = (d) => new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: tz }).format(d);
  const fmtYear = (d) => new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone: tz }).format(d);
  if (!endDate) return `${fmtDay(startDate)} ${fmtMonth(startDate)} ${fmtYear(startDate)}`;
  const startYear = fmtYear(startDate);
  const endYear = fmtYear(endDate);
  const startMonth = fmtMonth(startDate);
  const endMonth = fmtMonth(endDate);
  if (startYear !== endYear) {
    return `${fmtDay(startDate)} ${startMonth} ${startYear} – ${fmtDay(endDate)} ${endMonth} ${endYear}`;
  }
  if (startMonth !== endMonth) {
    return `${fmtDay(startDate)} ${startMonth} – ${fmtDay(endDate)} ${endMonth} ${endYear}`;
  }
  return `${fmtDay(startDate)}–${fmtDay(endDate)} ${endMonth} ${endYear}`;
}

function renderResults(events, filterText = '') {
  const query = filterText.trim().toLowerCase();
  const filtered = query
    ? events.filter((e) => {
        const hay = [e.label, e.designation, e.location, e.year, e.category].join(' ').toLowerCase();
        return hay.includes(query);
      })
    : events;

  if (filtered.length === 0) {
    return '<p class="event-search-empty">No events found.</p>';
  }

  return filtered
    .map((e) => {
      const dateStr = formatEventDateRange(e.startDate, e.endDate, e.timezone);
      const metaItems = [];
      if (dateStr) {
        metaItems.push(
          `<span class="event-search-result-meta-item">${icon('calendar-day', 'text-xs')}${escapeHtml(dateStr)}</span>`
        );
      }
      if (e.location) {
        metaItems.push(
          `<span class="event-search-result-meta-item">${icon('location-dot', 'text-xs')}${escapeHtml(e.location)}</span>`
        );
      }
      if (e.category) {
        metaItems.push(
          `<span class="event-search-result-meta-item">${icon('globe', 'text-xs')}${escapeHtml(e.category)}</span>`
        );
      }
      return `<button type="button" class="event-search-result" data-file="${escapeHtml(e.file)}" data-category="${escapeHtml(e.category)}">
        <span class="event-search-result-label">${escapeHtml(e.label)}</span>
        ${metaItems.length ? `<span class="event-search-result-meta">${metaItems.join('')}</span>` : ''}
      </button>`;
    })
    .join('');
}

function closeEventSearchModal() {
  const modal = document.getElementById(SEARCH_MODAL_ID);
  if (!modal) return;
  modal.classList.add('hidden');
  document.body.classList.remove('session-modal-open');
}

function ensureEventSearchModal() {
  let modal = document.getElementById(SEARCH_MODAL_ID);
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = SEARCH_MODAL_ID;
  modal.className = 'session-modal-overlay hidden';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'eventSearchTitle');
  modal.innerHTML = `
    <div class="session-modal-card event-search-card">
      <div class="session-modal-header">
        <h2 id="eventSearchTitle" class="event-search-title">Find Event</h2>
        <button id="eventSearchClose" type="button" class="session-modal-close" aria-label="Close event search">
          ${icon('times')}
        </button>
      </div>
      <div class="event-search-input-wrap">
        <span class="event-search-input-icon">${icon('magnifying-glass')}</span>
        <input
          id="eventSearchInput"
          type="search"
          placeholder="Search events by name, location, year..."
          autocomplete="off"
          class="event-search-input"
        >
      </div>
      <div id="eventSearchResults" class="event-search-results"></div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeEventSearchModal();
  });

  document.getElementById('eventSearchClose').addEventListener('click', closeEventSearchModal);

  document.getElementById('eventSearchInput').addEventListener('input', (e) => {
    document.getElementById('eventSearchResults').innerHTML = renderResults(_getEvents(), e.target.value);
  });

  modal.addEventListener('click', async (e) => {
    const btn = e.target.closest('.event-search-result');
    if (!btn) return;
    closeEventSearchModal();
    await _onSelect({ file: btn.dataset.file, category: btn.dataset.category });
  });

  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeEventSearchModal();
  });

  return modal;
}

export function openEventSearchModal() {
  const modal = ensureEventSearchModal();
  modal.classList.remove('hidden');
  document.body.classList.add('session-modal-open');

  const input = document.getElementById('eventSearchInput');
  if (input) {
    input.value = '';
    requestAnimationFrame(() => input.focus());
  }

  document.getElementById('eventSearchResults').innerHTML = renderResults(_getEvents(), '');
}
