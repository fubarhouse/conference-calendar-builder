export const STORAGE_PREFIX = 'drupalconPlanner_';
export const GLOBAL_KEY     = 'drupalconPlanner_global';
export const PLANNER_VERSION = 2;

export function getPlannerKey(eventFile) {
  return `${STORAGE_PREFIX}${eventFile}`;
}

export function makeItemId(prefix = 'item') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── Global (cross-event) store ────────────────────────────────────────────────

export function makeEmptyGlobal() {
  return { teamMembers: [] };
}

export function loadGlobal() {
  try {
    const raw = localStorage.getItem(GLOBAL_KEY);
    if (!raw) return makeEmptyGlobal();
    return { ...makeEmptyGlobal(), ...JSON.parse(raw) };
  } catch {
    return makeEmptyGlobal();
  }
}

export function saveGlobal(data) {
  localStorage.setItem(GLOBAL_KEY, JSON.stringify(data));
}

// ── Per-event planner store ───────────────────────────────────────────────────

export function makeEmptyPlanner(eventFile) {
  return {
    _version: PLANNER_VERSION,
    _eventFile: eventFile,
    _lastModified: new Date().toISOString(),
    mode: 'personal',
    sessionNotes: {},
    contacts: [],
    tasks: [],
    trip: {
      outbound:      { date: '', mode: '', confirmation: '', notes: '' },
      return:        { date: '', mode: '', confirmation: '', notes: '' },
      accommodation: { name: '', address: '', checkIn: '', checkOut: '', confirmation: '', notes: '' },
      generalNotes: '',
    },
    org: {
      boothInfo: '',
      boothNotes: '',
      // teamAssignments: per-event references to global team members + their event-specific travel data
      // [{ memberId, flightOut:{date,flightNo,from,to,confirmation}, flightReturn:{…}, budget, notes }]
      teamAssignments: [],
      // accommodations: per-event properties, each with member assignments + dates
      // [{ id, name, address, confirmation, notes, assignments:[{memberId, checkIn, checkOut}] }]
      accommodations: [],
      timeline: { startDate: '', endDate: '' },
      swag: [],
      deliverables: [],
      sponsorBudget: '',
      sponsorActual: '',
      sponsorCurrency: 'AUD',
      sponsorId: '',
      trackedSessions: [],
      autoAddedSponsoredSessions: [],
    },
    itinerary: [],
    receipts: [],
    personal: {
      outboundLegs:   [],
      returnLegs:     [],
      accommodations: [],
      budget:         '',
      budgetActual:   '',
      currency:       'AUD',
      notes:          '',
      trackedSessions: [],
      itinerary:      [],
    },
  };
}

export function loadPlanner(eventFile) {
  try {
    const raw = localStorage.getItem(getPlannerKey(eventFile));
    if (!raw) return makeEmptyPlanner(eventFile);
    const parsed = JSON.parse(raw);
    const empty  = makeEmptyPlanner(eventFile);
    // Deep-merge org so new sub-fields are always present
    return {
      ...empty,
      ...parsed,
      mode: parsed.mode === 'individual' ? 'personal' : parsed.mode, // migrate old mode value
      org: (() => {
        const po = parsed.org || {};
        // Migrate old swag items {label, done} → {name, quantity, budget, actual, currency, done, notes}
        const swag = (po.swag || []).map((item) =>
          item.name !== undefined ? item
            : { ...item, name: item.label || '', quantity: 1, budget: '', actual: '', currency: 'AUD', notes: '' }
        );
        return { ...empty.org, ...po, swag };
      })(),
      itinerary: parsed.itinerary || [],
      receipts: parsed.receipts || [],
      personal: (() => {
        const pi = parsed.personal || parsed.individual || {}; // fallback: old key was 'individual'
        // Migrate old single-object accommodation to array
        let accommodations = Array.isArray(pi.accommodations) ? pi.accommodations : [];
        if (!accommodations.length && pi.accommodation && Object.values(pi.accommodation).some(Boolean)) {
          const o = pi.accommodation;
          accommodations = [{ id: makeItemId('ia'), name: o.name || '', address: o.address || '', checkIn: o.checkIn || '', checkOut: o.checkOut || '', confirmation: o.confirmation || '', budget: o.budget || '', budgetActual: o.budgetActual || '', currency: o.currency || 'AUD', notes: o.notes || '' }];
        }
        return { ...empty.personal, ...pi, accommodations };
      })(),
    };
  } catch {
    return makeEmptyPlanner(eventFile);
  }
}

export function savePlanner(eventFile, data) {
  const toSave = { ...data, _lastModified: new Date().toISOString() };
  localStorage.setItem(getPlannerKey(eventFile), JSON.stringify(toSave));
}

// Derives the same session ID used by events.js line 982
export function makeSessionId(session) {
  return `${session.startTime}-${session.location}-${session.title}`.replace(/[^a-zA-Z0-9-]/g, '-');
}

export function exportPlannerJson(eventFile, data) {
  const json = JSON.stringify({ ...data, _lastModified: new Date().toISOString() }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `planner-${eventFile}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function parsePlannerImport(jsonText) {
  const parsed = JSON.parse(jsonText); // throws on invalid JSON
  if (!parsed || typeof parsed !== 'object') throw new Error('Not a valid planner file');
  if (!parsed._eventFile) throw new Error('Missing _eventFile — this does not look like a planner export');
  return parsed;
}

export async function savePlannerViaApi(apiEndpoint, eventFile, data) {
  const url = `${apiEndpoint.replace(/\/$/, '')}/api/planner/${eventFile}`;
  const body = JSON.stringify({ ...data, _lastModified: new Date().toISOString() }, null, 2);
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return true;
}
