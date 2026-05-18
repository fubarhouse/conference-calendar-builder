// Drag-and-drop timeline editor for event session JSON.
// Renders a calendar grid per day; sessions are draggable/resizable blocks.

const ROW_H = 48;      // px per 30-minute slot
const SNAP_MINS = 30;

let _el = null;
let _dataset = null;
let _cbs = null;
let _activeDay = null;
let _drag = null;

// ── Public API ─────────────────────────────────────────────────────────────

export function renderTimeline(container, dataset, callbacks) {
  _el = container;
  _dataset = dataset;
  _cbs = callbacks;
  _redraw();
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _tz() { return _cbs.getEventTimezone(); }
function _localStr(isoUtc) { return _cbs.utcIsoToLocalInput(isoUtc, _tz()) || ''; }
function _toUtc(localStr) { return _cbs.localInputToUtcIso(localStr, _tz()) || ''; }

function _localDate(isoUtc) {
  const s = _localStr(isoUtc);
  return s ? s.split('T')[0] : null;
}

function _localMins(isoUtc) {
  const s = _localStr(isoUtc);
  if (!s) return 0;
  const [, t] = s.split('T');
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function _minsToUtc(datePart, totalMins) {
  const h = String(Math.floor(totalMins / 60)).padStart(2, '0');
  const m = String(totalMins % 60).padStart(2, '0');
  return _toUtc(`${datePart}T${h}:${m}`);
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function extractDays(items) {
  const days = new Set();
  for (const item of items) {
    if (item.startTime) {
      const d = _localDate(item.startTime);
      if (d) days.add(d);
    }
  }
  return Array.from(days).sort();
}

function fmtDayLabel(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  return d.toLocaleDateString('en', { weekday: 'short', day: 'numeric', month: 'short' });
}

function fmtMins(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  const ampm = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, '0')}${ampm}` : `${h12}${ampm}`;
}

function extractRooms(dayItems) {
  const seen = new Set();
  const rooms = [];
  for (const { item } of dayItems) {
    const r = item.location || '';
    if (!seen.has(r)) { seen.add(r); rooms.push(r); }
  }
  return rooms;
}

function getTimeRange(dayItems) {
  let minMins = 8 * 60;
  let maxMins = 18 * 60;
  for (const { item } of dayItems) {
    if (item.startTime) {
      const m = _localMins(item.startTime);
      if (m < minMins) minMins = m;
    }
    if (item.endTime) {
      const m = _localMins(item.endTime);
      if (m > maxMins) maxMins = m;
    }
  }
  minMins = Math.floor(minMins / SNAP_MINS) * SNAP_MINS;
  maxMins = Math.ceil(maxMins / SNAP_MINS) * SNAP_MINS;
  return { minMins, maxMins };
}

function getPrimaryTrack(item) {
  if (Array.isArray(item.track)) return item.track[0] || '';
  return String(item.track || '').split(',')[0].trim();
}

// ── HTML builders ──────────────────────────────────────────────────────────

function buildDayTabs(days) {
  return `<div class="tl-day-tabs" role="tablist" aria-label="Conference days">
    ${days.map(d => `
      <button class="tl-day-tab${d === _activeDay ? ' is-active' : ''}"
              data-day="${d}" type="button" role="tab"
              aria-selected="${d === _activeDay ? 'true' : 'false'}">
        ${esc(fmtDayLabel(d))}
      </button>`).join('')}
  </div>`;
}

function buildTimeAxis(minMins, totalSlots) {
  let labels = '';
  for (let i = 0; i <= totalSlots; i++) {
    const mins = minMins + i * SNAP_MINS;
    if (mins % 60 === 0) {
      labels += `<div class="tl-time-label" style="top:${40 + i * ROW_H}px">${fmtMins(mins)}</div>`;
    }
  }
  return `<div class="tl-time-axis" style="height:${40 + totalSlots * ROW_H}px">
    <div class="tl-time-axis-header"></div>
    ${labels}
  </div>`;
}

function buildRoomColumn(room, dayItems, minMins, totalSlots) {
  let lines = '';
  for (let i = 0; i < totalSlots; i++) {
    const mins = minMins + i * SNAP_MINS;
    lines += `<div class="tl-slot-bg${mins % 60 === 0 ? ' is-hour' : ''}"
      style="top:${i * ROW_H}px;height:${ROW_H}px"
      data-slot-mins="${mins}"></div>`;
  }

  const roomItems = dayItems.filter(({ item }) => (item.location || '') === room);
  let blocks = '';
  for (const { item, index } of roomItems) {
    const startMins = _localMins(item.startTime);
    const endMins = item.endTime ? _localMins(item.endTime) : startMins + 60;
    const durMins = Math.max(SNAP_MINS, endMins - startMins);
    const top = Math.max(0, (startMins - minMins) / SNAP_MINS * ROW_H);
    const height = durMins / SNAP_MINS * ROW_H;
    const track = getPrimaryTrack(item);
    const spk = Array.isArray(item.speakers)
      ? item.speakers.join(', ')
      : (item.speakers || '');

    blocks += `
      <div class="tl-session" data-index="${index}" data-room="${esc(room)}"
           data-track="${esc(track)}" style="top:${top}px;height:${height}px">
        <div class="tl-session-inner">
          <div class="tl-session-title">${esc(item.title || 'Untitled')}</div>
          ${spk ? `<div class="tl-session-speakers">${esc(spk)}</div>` : ''}
          <div class="tl-session-time">${esc(fmtMins(startMins))}–${esc(fmtMins(endMins))}</div>
        </div>
        <button class="tl-session-delete" data-index="${index}" type="button" title="Delete session">
          <i class="fas fa-times" aria-hidden="true"></i>
        </button>
        <div class="tl-resize-handle" data-index="${index}"></div>
      </div>`;
  }

  return `<div class="tl-room-col" data-room="${esc(room)}">
    ${lines}${blocks}
    <div class="tl-add-indicator" aria-hidden="true"></div>
  </div>`;
}

// ── Main render ────────────────────────────────────────────────────────────

function _redraw() {
  if (!_dataset?.items?.length) {
    _el.innerHTML = '<p class="tl-empty">No sessions loaded. Open a dataset first.</p>';
    return;
  }

  const days = extractDays(_dataset.items);
  if (!days.length) {
    _el.innerHTML = '<p class="tl-empty">No sessions with valid start times found.</p>';
    return;
  }

  if (!_activeDay || !days.includes(_activeDay)) _activeDay = days[0];

  const dayItems = _dataset.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => _localDate(item.startTime) === _activeDay);

  const rooms = extractRooms(dayItems);
  if (!rooms.length) {
    _el.innerHTML = `${buildDayTabs(days)}<p class="tl-empty">No sessions on this day.</p>`;
    _el.querySelector('.tl-day-tab')?.parentElement
      ?.querySelectorAll('.tl-day-tab')
      .forEach(b => b.addEventListener('click', () => { _activeDay = b.dataset.day; _redraw(); }));
    return;
  }

  const { minMins, maxMins } = getTimeRange(dayItems);
  const totalSlots = Math.max(1, Math.ceil((maxMins - minMins) / SNAP_MINS));
  const colsTemplate = `repeat(${rooms.length}, minmax(180px, 1fr))`;

  _el.innerHTML = `
    <div class="tl-root">
      ${buildDayTabs(days)}
      <div class="tl-scroll-wrap">
        <div class="tl-layout">
          ${buildTimeAxis(minMins, totalSlots)}
          <div class="tl-rooms-wrap">
            <div class="tl-rooms-header" style="grid-template-columns:${colsTemplate}">
              ${rooms.map(r => `<div class="tl-room-header">${esc(r || '(no room)')}</div>`).join('')}
            </div>
            <div class="tl-rooms-body" style="grid-template-columns:${colsTemplate};height:${totalSlots * ROW_H}px">
              ${rooms.map(r => buildRoomColumn(r, dayItems, minMins, totalSlots)).join('')}
            </div>
          </div>
        </div>
      </div>
    </div>`;

  _el.dataset.minMins = minMins;
  _el.dataset.rooms = JSON.stringify(rooms);

  _bindAll();
}

// ── Bind handlers ──────────────────────────────────────────────────────────

function _bindAll() {
  _el.querySelectorAll('.tl-day-tab').forEach(btn =>
    btn.addEventListener('click', () => { _activeDay = btn.dataset.day; _redraw(); }));

  _el.querySelectorAll('.tl-session').forEach(block =>
    block.addEventListener('mousedown', _onMoveStart));
  _el.querySelectorAll('.tl-resize-handle').forEach(h =>
    h.addEventListener('mousedown', _onResizeStart));
  _el.querySelectorAll('.tl-session-delete').forEach(btn =>
    btn.addEventListener('click', _onDelete));

  _el.querySelectorAll('.tl-room-col').forEach(col => {
    col.addEventListener('click', _onColClick);
    col.addEventListener('mousemove', _onColHover);
    col.addEventListener('mouseleave', _onColLeave);
  });
}

// ── Move drag ──────────────────────────────────────────────────────────────

function _onMoveStart(e) {
  if (e.target.closest('.tl-session-delete') || e.target.closest('.tl-resize-handle')) return;
  e.preventDefault();

  const block = e.currentTarget;
  const index = parseInt(block.dataset.index, 10);
  const item = _dataset.items[index];

  _drag = {
    type: 'move',
    index,
    block,
    startY: e.clientY,
    origTop: parseInt(block.style.top, 10),
    origStartMins: _localMins(item.startTime),
    origEndMins: item.endTime ? _localMins(item.endTime) : _localMins(item.startTime) + 60,
    rooms: JSON.parse(_el.dataset.rooms || '[]'),
    minMins: parseInt(_el.dataset.minMins, 10),
    targetRoom: item.location || '',
  };

  block.classList.add('is-dragging');
  document.addEventListener('mousemove', _onMoveMove);
  document.addEventListener('mouseup', _onMoveUp);
}

function _onMoveMove(e) {
  if (!_drag || _drag.type !== 'move') return;

  const snappedSlotDelta = Math.round((e.clientY - _drag.startY) / ROW_H);
  const newStartMins = Math.max(_drag.minMins, _drag.origStartMins + snappedSlotDelta * SNAP_MINS);
  const dy = (newStartMins - _drag.origStartMins) / SNAP_MINS * ROW_H;
  _drag.block.style.transform = `translateY(${dy}px)`;

  const body = _el.querySelector('.tl-rooms-body');
  if (body && _drag.rooms.length) {
    const { left, width } = body.getBoundingClientRect();
    const colIdx = Math.max(0, Math.min(_drag.rooms.length - 1, Math.floor((e.clientX - left) / (width / _drag.rooms.length))));
    const newRoom = _drag.rooms[colIdx];
    if (newRoom !== _drag.targetRoom) {
      _drag.targetRoom = newRoom;
      _el.querySelectorAll('.tl-room-col').forEach(col =>
        col.classList.toggle('is-drop-target', col.dataset.room === newRoom));
    }
  }
}

function _onMoveUp(e) {
  if (!_drag || _drag.type !== 'move') { _cleanDrag(); return; }

  const snappedSlotDelta = Math.round((e.clientY - _drag.startY) / ROW_H);
  const durMins = _drag.origEndMins - _drag.origStartMins;
  const newStartMins = Math.max(_drag.minMins, _drag.origStartMins + snappedSlotDelta * SNAP_MINS);
  const newEndMins = newStartMins + durMins;

  const item = _dataset.items[_drag.index];
  item.startTime = _minsToUtc(_activeDay, newStartMins);
  item.endTime = _minsToUtc(_activeDay, newEndMins);
  item.location = _drag.targetRoom;

  _cbs.markDirty();
  _cbs.trackQuickSessionChange(_drag.index, true);
  _cleanDrag();
  _redraw();
}

// ── Resize drag ────────────────────────────────────────────────────────────

function _onResizeStart(e) {
  e.preventDefault();
  e.stopPropagation();

  const handle = e.currentTarget;
  const block = handle.closest('.tl-session');
  const index = parseInt(handle.dataset.index, 10);
  const item = _dataset.items[index];

  _drag = {
    type: 'resize',
    index,
    block,
    startY: e.clientY,
    origHeight: parseInt(block.style.height, 10),
    origStartMins: _localMins(item.startTime),
    origEndMins: item.endTime ? _localMins(item.endTime) : _localMins(item.startTime) + 60,
  };

  block.classList.add('is-dragging');
  document.addEventListener('mousemove', _onResizeMove);
  document.addEventListener('mouseup', _onResizeUp);
}

function _onResizeMove(e) {
  if (!_drag || _drag.type !== 'resize') return;
  const snappedSlotDelta = Math.round((e.clientY - _drag.startY) / ROW_H);
  _drag.block.style.height = `${Math.max(ROW_H, _drag.origHeight + snappedSlotDelta * ROW_H)}px`;
}

function _onResizeUp(e) {
  if (!_drag || _drag.type !== 'resize') { _cleanDrag(); return; }

  const snappedSlotDelta = Math.round((e.clientY - _drag.startY) / ROW_H);
  const newEndMins = Math.max(
    _drag.origStartMins + SNAP_MINS,
    _drag.origEndMins + snappedSlotDelta * SNAP_MINS
  );

  const item = _dataset.items[_drag.index];
  item.endTime = _minsToUtc(_activeDay, newEndMins);

  _cbs.markDirty();
  _cbs.trackQuickSessionChange(_drag.index, true);
  _cleanDrag();
  _redraw();
}

// ── Add / Delete ───────────────────────────────────────────────────────────

function _onColClick(e) {
  if (e.target.closest('.tl-session') || e.target.closest('.tl-session-delete')) return;
  if (_drag) return;

  const col = e.currentTarget;
  const room = col.dataset.room || '';
  const minMins = parseInt(_el.dataset.minMins, 10);
  const relY = e.clientY - col.getBoundingClientRect().top;
  const slotMins = minMins + Math.floor(relY / ROW_H) * SNAP_MINS;

  const title = window.prompt('New session title:', '');
  if (title === null || !title.trim()) return;

  const startMins = slotMins;
  const endMins = slotMins + 60;

  _dataset.items.push({
    title: title.trim(),
    startTime: _minsToUtc(_activeDay, startMins),
    endTime: _minsToUtc(_activeDay, endMins),
    location: room,
    track: '',
    speakers: [],
    full_description: '',
  });

  _cbs.markDirty();
  _redraw();
}

function _onDelete(e) {
  e.stopPropagation();
  const index = parseInt(e.currentTarget.dataset.index, 10);
  const item = _dataset.items[index];
  if (!window.confirm(`Delete "${item.title || 'Untitled'}"?`)) return;
  _dataset.items.splice(index, 1);
  _cbs.markDirty();
  _redraw();
}

// ── Add indicator hover ────────────────────────────────────────────────────

function _onColHover(e) {
  if (_drag || e.target.closest('.tl-session')) return;
  const col = e.currentTarget;
  const minMins = parseInt(_el.dataset.minMins, 10);
  const relY = e.clientY - col.getBoundingClientRect().top;
  const slotIndex = Math.floor(relY / ROW_H);
  const ind = col.querySelector('.tl-add-indicator');
  if (ind) {
    ind.style.top = `${slotIndex * ROW_H}px`;
    ind.style.display = 'flex';
  }
}

function _onColLeave() {
  _el.querySelectorAll('.tl-add-indicator').forEach(el => { el.style.display = 'none'; });
}

// ── Cleanup ────────────────────────────────────────────────────────────────

function _cleanDrag() {
  if (_drag?.block) {
    _drag.block.classList.remove('is-dragging');
    _drag.block.style.transform = '';
  }
  _el?.querySelectorAll('.tl-room-col').forEach(c => c.classList.remove('is-drop-target'));
  document.removeEventListener('mousemove', _onMoveMove);
  document.removeEventListener('mousemove', _onResizeMove);
  document.removeEventListener('mouseup', _onMoveUp);
  document.removeEventListener('mouseup', _onResizeUp);
  _drag = null;
}
