import { loadEventCatalog } from './modules/eventCatalog.js';
import { formatTextBlock } from './modules/markdown.js';
import { isLocalhost, slugify } from './modules/utils.js';
import { configureEventSearch, openEventSearchModal } from './modules/eventSearch.js';
import { renderTimeline } from './modules/timeline.js';

const state = {
  dataset: null,
  file: '',
  outputPath: '',
  fileHandle: null,
  projectDirHandle: null,
  folderConnectedInSession: false,
  lastDatasetSelectValue: '',
  selectedIndex: -1,
  selectedSponsorIndex: -1,
  draggingIndex: -1,
  draggingSponsorIndex: -1,
  sessionSearchQuery: '',
  sessionListExpanded: false,
  sessionQuickEditEnabled: false,
  sponsorListExpanded: false,
  sponsorQuickEditEnabled: false,
  activeEditorTab: 'sessions',
  dirty: false,
  sessionDirty: false,
  sponsorDirty: false,
  persistedSnapshot: null,
  quickEditSessionChanges: new Set(),
  quickEditSponsorChanges: new Set(),
  sessionStructureDirty: false,
  sponsorStructureDirty: false,
  timezones: [],
  sponsorSessionPickerOpen: false,
  sessionSponsorPickerOpen: false
};

const UNDO_STACK = [];
const UNDO_LIMIT = 50;
const RECOVERY_KEY = '__editor_recovery__';
const RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const FILE_LINK_DB = 'dataset-editor-file-links';
const FILE_LINK_STORE = 'links';
const DIR_HANDLE_KEY = '__project_dir_handle__';
const EVENT_META_FIELDS = [
  'id',
  'name',
  'designation',
  'year',
  'location',
  'region',
  'venue',
  'website',
  'scheduleURL',
  'startDate',
  'endDate',
  'logo',
  'flickr',
  'timezone',
  'columns',
  'enabled'
];
const EVENT_META_FIELD_CONFIG = {
  designation: {
    label: 'Event series',
    description: 'The public event family name, such as DrupalSouth, DrupalCon, or DrupalGov.'
  },
  year: {
    label: 'Event year',
    description: 'The calendar year used for sorting, grouping, and display.'
  },
  location: {
    label: 'Host city',
    description: 'The city or primary location shown in the event picker.'
  },
  region: {
    label: 'Country or region',
    description: 'The broader region used for context and filtering, such as Australia or New Zealand.'
  },
  venue: {
    label: 'Venue',
    description: 'The main venue name shown in the event details.'
  },
  website: {
    label: 'Event website',
    description: 'The official event website URL.'
  },
  scheduleURL: {
    label: 'Original schedule URL',
    description: 'The source schedule URL used when this dataset was created or checked.'
  },
  logo: {
    label: 'Event logo',
    description: 'Upload and store the exact logo used in the public schedule header for this event.'
  },
  timezone: {
    label: 'Event time zone',
    description: 'The local time zone for session editing. Session times are saved as UTC.'
  },
  columns: {
    label: 'Schedule columns',
    description: 'The preferred number of columns for the public schedule layout.'
  },
  startDate: {
    label: 'Conference start date',
    description: 'First day of the event. Populates the timeline day tabs even when no sessions are scheduled yet.'
  },
  endDate: {
    label: 'Conference end date',
    description: 'Last day of the event. All dates between start and end appear as timeline days.'
  },
  enabled: {
    label: 'Show this event',
    description: 'Controls whether this dataset is available in the public planner.'
  }
};
const FLICKR_FIELD_CONFIG = {
  enabled: {
    label: 'Show Flickr block',
    description: 'Displays the Flickr callout on the public event page when a group URL is provided.'
  },
  groupUrl: {
    label: 'Flickr group URL',
    description: 'The public Flickr group or album link used by the call-to-action button.'
  },
  image: {
    label: 'Promo image path',
    description: 'A relative path to the square promo image shown beside the Flickr text.'
  },
  imageAlt: {
    label: 'Image alternative text',
    description: 'A short description of the promo image for screen readers.'
  }
};
const LOGO_FIELD_CONFIG = {
  image: {
    label: 'Logo image path',
    description: 'A relative path to the logo shown in the public schedule header.'
  },
  imageAlt: {
    label: 'Logo alternative text',
    description: 'A short description of the logo for screen readers.'
  },
  usePlate: {
    label: 'Use background plate',
    description: 'Enable a soft white plate behind the logo for images without transparency.'
  }
};
const SPONSOR_FIELDS = [
  { key: 'title', label: 'Sponsor title', description: 'Public sponsor name used in the editor and rendered placements.', type: 'text', span: 2 },
  { key: 'subtitle', label: 'Subtitle text', description: 'Optional display name shown on the schedule instead of the company name. Falls back to the sponsor title if blank.', type: 'text', span: 2 },
  { key: 'id', label: 'Sponsor ID', description: 'Stable identifier used by sessions to reference this sponsor.', type: 'text' },
  { key: 'tier', label: 'Tier', description: 'Grouping label such as Platinum, Gold, Silver, or Partner.', type: 'text' },
  { key: 'row', label: 'Display row', description: 'Which row this sponsor appears in. Lower numbers appear first.', type: 'number' },
  { key: 'priority', label: 'Display order', description: 'Position within the row. Lower numbers appear earlier.', type: 'number' },
  { key: 'link', label: 'Sponsor URL', description: 'Optional external link for the sponsor logo or card.', type: 'text', span: 2 },
  { key: 'image', label: 'Image path', description: 'Relative path to the uploaded sponsor image asset.', type: 'text', span: 2 },
  { key: 'imageAlt', label: 'Image alternative text', description: 'Short accessible description for the sponsor image.', type: 'text', span: 2 },
  { key: 'bgStyle', label: 'Logo background', description: 'How the logo image background is treated. Use "light-plate" or "dark-plate" if the logo has no transparent background.', type: 'select', options: ['auto', 'transparent', 'light-plate', 'dark-plate', 'brand-fill'] },
  { key: 'aspect', label: 'Image shape', description: 'The aspect ratio of the logo. Helps ensure it displays at the right size and proportions.', type: 'select', options: ['auto', 'square', 'landscape', 'banner'] },
  { key: 'enabled', label: 'Show sponsor', description: 'Controls whether this sponsor is available for rendering and session association.', type: 'checkbox' }
];
const SESSION_FIELDS = [
  { key: 'title', label: 'Session title', description: 'The public title shown on schedule cards and detail views.', type: 'text', span: 2 },
  { key: 'startTime', label: 'Start time', description: 'Enter the session start time in the event\'s local timezone.', type: 'datetime-local' },
  { key: 'endTime', label: 'End time', description: 'Enter the session end time in the event\'s local timezone.', type: 'datetime-local' },
  { key: 'location', label: 'Room or location', description: 'The room, stage, or location for this session.', type: 'text' },
  { key: 'duration', label: 'Session duration', description: 'Calculated automatically from the start and end time.', type: 'text' },
  { key: 'track', label: 'Track or topic', description: 'Use commas to separate multiple tracks or topics.', type: 'text' },
  { key: 'speakers', label: 'Speaker names', description: 'Use commas or new lines to separate multiple speakers.', type: 'textarea', span: 2 },
  {
    key: 'speaker_usernames',
    label: 'Speaker Drupal.org usernames',
    description: 'Optional profile usernames. Use commas or new lines to match multiple speakers.',
    type: 'textarea',
    span: 2
  },
  { key: 'full_description', label: 'Session description', description: 'The full public description. Markdown formatting is supported.', type: 'textarea', span: 2 },
  { key: 'sponsorIds', label: 'Sponsors', description: 'Sponsors associated with this session.', type: 'sponsors', span: 2 },
  { key: 'link', label: 'Session page URL', description: 'The original or canonical web page for this session.', type: 'text', span: 2 },
  { key: 'video_url', label: 'Video URL', description: 'Optional recording URL shown with the session details.', type: 'text', span: 2 }
];

const dtfCache = new Map();
let fileLinkDbPromise = null;
let eventCatalog = [];

const els = {
  blocked: document.getElementById('editorBlocked'),
  app: document.getElementById('editorApp'),
  welcome: document.getElementById('editorWelcome'),
  saveToast: document.getElementById('saveToast'),
  datasetSelect: document.getElementById('datasetSelect'),
  editorSearchEvents: document.getElementById('editorSearchEvents'),
  folderConnectionToggle: document.getElementById('folderConnectionToggle'),
  newDataset: document.getElementById('newDataset'),
  saveDataset: document.getElementById('saveDataset'),
  saveAsDataset: document.getElementById('saveAsDataset'),
  previewDataset: document.getElementById('previewDataset'),
  undoAction: document.getElementById('undoAction'),
  revertDataset: document.getElementById('revertDataset'),
  exportDataset: document.getElementById('exportDataset'),
  currentFilenameInput: document.getElementById('currentFilenameInput'),
  dirtyState: document.getElementById('dirtyState'),
  toggleEventMeta: document.getElementById('toggleEventMeta'),
  toggleEventMetaIcon: document.getElementById('toggleEventMetaIcon'),
  eventMetaBody: document.getElementById('eventMetaBody'),
  eventMetaForm: document.getElementById('eventMetaForm'),
  eventWorkspacePanel: document.getElementById('eventWorkspacePanel'),
  logoForm: document.getElementById('logoForm'),
  flickrForm: document.getElementById('flickrForm'),
  sessionSearchInput: document.getElementById('sessionSearchInput'),
  sessionList: document.getElementById('sessionList'),
  sessionWorkspace: document.getElementById('sessionWorkspace'),
  sessionWorkspacePanel: document.getElementById('sessionWorkspacePanel'),
  sessionSidebarPanel: document.getElementById('sessionSidebarPanel'),
  sessionEditorPanel: document.getElementById('sessionEditorPanel'),
  toggleSessionWorkspace: document.getElementById('toggleSessionWorkspace'),
  toggleSessionWorkspaceIcon: document.getElementById('toggleSessionWorkspaceIcon'),
  toggleSessionWorkspaceLabel: document.getElementById('toggleSessionWorkspaceLabel'),
  toggleQuickSessionEdit: document.getElementById('toggleQuickSessionEdit'),
  toggleQuickSessionEditIcon: document.getElementById('toggleQuickSessionEditIcon'),
  toggleQuickSessionEditLabel: document.getElementById('toggleQuickSessionEditLabel'),
  sessionForm: document.getElementById('sessionForm'),
  sessionIndexBadge: document.getElementById('sessionIndexBadge'),
  sessionDirtyState: document.getElementById('sessionDirtyState'),
  saveSession: document.getElementById('saveSession'),
  saveSessionLabel: document.getElementById('saveSessionLabel'),
  addSession: document.getElementById('addSession'),
  deleteSession: document.getElementById('deleteSession'),
  sponsorList: document.getElementById('sponsorList'),
  sponsorWorkspace: document.getElementById('sponsorWorkspace'),
  sponsorWorkspacePanel: document.getElementById('sponsorWorkspacePanel'),
  sponsorSidebarPanel: document.getElementById('sponsorSidebarPanel'),
  sponsorEditorPanel: document.getElementById('sponsorEditorPanel'),
  toggleSponsorWorkspace: document.getElementById('toggleSponsorWorkspace'),
  toggleSponsorWorkspaceIcon: document.getElementById('toggleSponsorWorkspaceIcon'),
  toggleSponsorWorkspaceLabel: document.getElementById('toggleSponsorWorkspaceLabel'),
  toggleQuickSponsorEdit: document.getElementById('toggleQuickSponsorEdit'),
  toggleQuickSponsorEditIcon: document.getElementById('toggleQuickSponsorEditIcon'),
  toggleQuickSponsorEditLabel: document.getElementById('toggleQuickSponsorEditLabel'),
  sponsorForm: document.getElementById('sponsorForm'),
  sponsorIndexBadge: document.getElementById('sponsorIndexBadge'),
  sponsorDirtyState: document.getElementById('sponsorDirtyState'),
  saveSponsor: document.getElementById('saveSponsor'),
  saveSponsorLabel: document.getElementById('saveSponsorLabel'),
  addSponsor: document.getElementById('addSponsor'),
  deleteSponsor: document.getElementById('deleteSponsor'),
  logoWorkspacePanel: document.getElementById('logoWorkspacePanel'),
  flickrWorkspacePanel: document.getElementById('flickrWorkspacePanel'),
  showEventTab: document.getElementById('showEventTab'),
  showLogoTab: document.getElementById('showLogoTab'),
  showFlickrTab: document.getElementById('showFlickrTab'),
  showSessionsTab: document.getElementById('showSessionsTab'),
  showSponsorsTab: document.getElementById('showSponsorsTab'),
  showSitemapTab: document.getElementById('showSitemapTab'),
  sitemapWorkspacePanel: document.getElementById('sitemapWorkspacePanel'),
  showTimelineTab: document.getElementById('showTimelineTab'),
  timelineWorkspacePanel: document.getElementById('timelineWorkspacePanel'),
  timelineCanvas: document.getElementById('timelineCanvas'),
  timelineSaveBtn: document.getElementById('timelineSaveBtn'),
  sponsorSessionPickerModal: document.getElementById('sponsorSessionPickerModal'),
  sponsorSessionPickerList: document.getElementById('sponsorSessionPickerList'),
  sponsorSessionPickerCount: document.getElementById('sponsorSessionPickerCount'),
  closeSponsorSessionPicker: document.getElementById('closeSponsorSessionPicker'),
  closeSponsorSessionPickerBack: document.getElementById('closeSponsorSessionPickerBack'),
  sessionSponsorPickerModal: document.getElementById('sessionSponsorPickerModal'),
  sessionSponsorPickerList: document.getElementById('sessionSponsorPickerList'),
  sessionSponsorPickerCount: document.getElementById('sessionSponsorPickerCount'),
  closeSessionSponsorPicker: document.getElementById('closeSessionSponsorPicker'),
  closeSessionSponsorPickerBack: document.getElementById('closeSessionSponsorPickerBack')
};


function outputBasename(pathValue) {
  const normalized = String(pathValue || '').replace(/\\/g, '/').trim();
  if (!normalized) return '';
  const segments = normalized.split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : '';
}

function normalizeOutputPath(value, fallback = 'data/new-event.json') {
  const raw = String(value || '').replace(/\\/g, '/').trim();
  if (!raw) return fallback;
  const withExt = raw.toLowerCase().endsWith('.json') ? raw : `${raw}.json`;
  if (withExt.includes('/')) return withExt;
  return `data/${withExt}`;
}

function getFileLinkKey(pathValue) {
  return normalizeOutputPath(pathValue || state.outputPath || `data/${state.file || 'new-event.json'}`);
}

function replaceOutputBasename(pathValue, filename) {
  const normalized = normalizeOutputPath(pathValue);
  const base = String(filename || '').trim();
  if (!base) return normalized;
  const dir = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : 'data';
  return `${dir}/${base}`;
}

function openFileLinkDb() {
  if (fileLinkDbPromise) return fileLinkDbPromise;
  fileLinkDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(FILE_LINK_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FILE_LINK_STORE)) {
        db.createObjectStore(FILE_LINK_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return fileLinkDbPromise;
}

async function getLinkedHandle(pathKey) {
  const db = await openFileLinkDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_LINK_STORE, 'readonly');
    const store = tx.objectStore(FILE_LINK_STORE);
    const req = store.get(pathKey);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function getStoredProjectDirHandle() {
  return getLinkedHandle(DIR_HANDLE_KEY);
}

async function setStoredProjectDirHandle(handle) {
  await setLinkedHandle(DIR_HANDLE_KEY, handle);
}

async function setLinkedHandle(pathKey, handle) {
  const db = await openFileLinkDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_LINK_STORE, 'readwrite');
    const store = tx.objectStore(FILE_LINK_STORE);
    const req = store.put(handle, pathKey);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function clearLinkedHandle(pathKey) {
  const db = await openFileLinkDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_LINK_STORE, 'readwrite');
    const store = tx.objectStore(FILE_LINK_STORE);
    const req = store.delete(pathKey);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function restoreLinkedHandleForCurrentPath() {
  if (!state.dataset) return;
  const pathKey = getFileLinkKey();
  try {
    const handle = await getLinkedHandle(pathKey);
    if (!handle) {
      state.fileHandle = null;
      return;
    }
    if (typeof handle.queryPermission === 'function') {
      const permission = await handle.queryPermission({ mode: 'readwrite' });
      if (permission !== 'granted') {
        state.fileHandle = null;
        return;
      }
    }
    state.fileHandle = handle;
  } catch {
    state.fileHandle = null;
  }
}

async function resolveFileHandleFromProjectDir(pathValue) {
  const dir = state.projectDirHandle;
  if (!dir) return null;
  const normalized = normalizeOutputPath(pathValue);
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  let current = dir;
  for (let i = 0; i < segments.length - 1; i += 1) {
    current = await current.getDirectoryHandle(segments[i]);
  }
  return current.getFileHandle(segments[segments.length - 1]);
}

async function connectProjectFolder() {
  if (typeof window.showDirectoryPicker !== 'function') {
    window.alert('Directory linking is not supported in this browser. Use Save As once per dataset.');
    return;
  }
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  state.projectDirHandle = handle;
  state.folderConnectedInSession = true;
  await setStoredProjectDirHandle(handle);
  await renderDatasetOptionsFromConnectedFolder();
  setDatasetLoadingEnabled(true);
  setFolderConnectionButtonState();
  showWelcomeScreen2();
  void refreshEditorSearch();

  const selectedFile = String(els.datasetSelect.value || '').trim();
  if (selectedFile) {
    if (!state.dataset || (await confirmDiscardPendingChanges(`dataset ${selectedFile}`))) {
      try {
        await loadDataset(selectedFile);
      } catch (error) {
        els.datasetSelect.value = '';
        state.lastDatasetSelectValue = '';
        window.alert(`Could not load dataset: ${error.message}`);
      }
    } else {
      els.datasetSelect.value = '';
      state.lastDatasetSelectValue = '';
    }
  }

  if (state.dataset && !state.fileHandle) {
    try {
      const fromDir = await resolveFileHandleFromProjectDir(state.outputPath);
      if (fromDir) {
        state.fileHandle = fromDir;
        await setLinkedHandle(getFileLinkKey(), fromDir);
      }
    } catch {
      // Ignore if file does not exist at selected folder path.
    }
  }
}

function disconnectProjectFolder() {
  state.projectDirHandle = null;
  state.folderConnectedInSession = false;
  state.fileHandle = null;
  state.dataset = null;
  state.file = '';
  state.outputPath = '';
  state.lastDatasetSelectValue = '';
  state.selectedIndex = -1;
  state.selectedSponsorIndex = -1;
  state.sessionSearchQuery = '';
  setCurrentFilenameLabel();
  setDatasetLoadingEnabled(false);
  setEditorButtonsEnabled(false);
  els.eventMetaForm.innerHTML = '';
  if (els.logoForm) {
    els.logoForm.innerHTML = '<p class="text-sm text-gray-400">Open a project folder to get started.</p>';
  }
  if (els.flickrForm) {
    els.flickrForm.innerHTML = '<p class="text-sm text-gray-400">Open a project folder to get started.</p>';
  }
  els.sessionList.innerHTML = '<li class="text-sm text-gray-400 px-3 py-2 border border-dashed border-gray-700 rounded-md">Open a project folder to get started.</li>';
  els.sessionForm.innerHTML = '<p class="text-sm text-gray-400">Select a session on the left to edit it.</p>';
  els.sponsorList.innerHTML = '<li class="text-sm text-gray-400 px-3 py-2 border border-dashed border-gray-700 rounded-md">Open a project folder to get started.</li>';
  els.sponsorForm.innerHTML = '<p class="text-sm text-gray-400">Select a sponsor row to edit it.</p>';
  if (els.sessionSearchInput) {
    els.sessionSearchInput.value = '';
  }
  renderDatasetOptionsFromConnectedFolder();
  markDirty(false);
  resetSessionQuickEditState();
  resetSponsorQuickEditState();
  markSessionDirty(false);
  markSponsorDirty(false);
  setFolderConnectionButtonState();
  syncWelcomePanel();
  void refreshEditorSearch();
}

function setCurrentFilenameLabel() {
  const pathValue = state.outputPath || (state.file ? `data/${state.file}` : '');
  els.currentFilenameInput.value = pathValue;
  els.currentFilenameInput.disabled = !state.dataset;
}

function setEditorButtonsEnabled(enabled) {
  if (els.exportDataset) {
    els.exportDataset.disabled = !enabled;
  }
  els.saveDataset.disabled = !enabled;
  els.saveAsDataset.disabled = !enabled;
  if (els.previewDataset) els.previewDataset.disabled = !enabled;
  if (els.revertDataset) els.revertDataset.disabled = true;
  if (els.timelineSaveBtn) els.timelineSaveBtn.disabled = !enabled;
  els.saveSession.disabled = !enabled || state.selectedIndex < 0;
  els.addSession.disabled = !enabled;
  els.deleteSession.disabled = !enabled || state.selectedIndex < 0;
  els.saveSponsor.disabled = !enabled || state.selectedSponsorIndex < 0;
  els.addSponsor.disabled = !enabled;
  els.deleteSponsor.disabled = !enabled || state.selectedSponsorIndex < 0;
  syncQuickSessionEditToggle();
  syncQuickSponsorEditToggle();
  syncSessionSaveButton();
  syncSponsorSaveButton();
}

function isSessionEditorEnabled() {
  return Boolean(state.dataset) && !els.addSession.disabled;
}

function isQuickSessionEditEnabled() {
  return state.sessionListExpanded && state.sessionQuickEditEnabled && isSessionEditorEnabled();
}

function syncQuickSessionEditToggle() {
  if (!els.toggleQuickSessionEdit) return;
  const visible = state.sessionListExpanded;
  const enabled = visible && isSessionEditorEnabled();
  const active = state.sessionQuickEditEnabled && enabled;
  els.toggleQuickSessionEdit.classList.toggle('hidden', !visible);
  els.toggleQuickSessionEdit.disabled = !enabled;
  els.toggleQuickSessionEdit.classList.toggle('opacity-60', visible && !enabled);
  els.toggleQuickSessionEdit.classList.toggle('cursor-not-allowed', visible && !enabled);
  els.toggleQuickSessionEdit.classList.toggle('editor-quick-edit-toggle-active', active);
  if (els.toggleQuickSessionEditLabel) {
    els.toggleQuickSessionEditLabel.textContent = 'Quick edit';
  }
  if (els.toggleQuickSessionEditIcon) {
    els.toggleQuickSessionEditIcon.classList.toggle('fa-pen-to-square', !active);
    els.toggleQuickSessionEditIcon.classList.toggle('fa-pen', active);
  }
}

function setQuickSessionEditEnabled(enabled) {
  const nextEnabled = Boolean(enabled) && state.sessionListExpanded && isSessionEditorEnabled();
  state.sessionQuickEditEnabled = nextEnabled;
  syncQuickSessionEditToggle();
  markSessionDirty(state.sessionDirty);
  renderSessionForm();
}

function isSponsorEditorEnabled() {
  return Boolean(state.dataset) && !els.addSponsor.disabled;
}

function isQuickSponsorEditEnabled() {
  return state.sponsorListExpanded && state.sponsorQuickEditEnabled && isSponsorEditorEnabled();
}

function syncQuickSponsorEditToggle() {
  if (!els.toggleQuickSponsorEdit) return;
  const visible = state.sponsorListExpanded;
  const enabled = visible && isSponsorEditorEnabled();
  const active = state.sponsorQuickEditEnabled && enabled;
  els.toggleQuickSponsorEdit.classList.toggle('hidden', !visible);
  els.toggleQuickSponsorEdit.disabled = !enabled;
  els.toggleQuickSponsorEdit.classList.toggle('opacity-60', visible && !enabled);
  els.toggleQuickSponsorEdit.classList.toggle('cursor-not-allowed', visible && !enabled);
  els.toggleQuickSponsorEdit.classList.toggle('editor-quick-edit-toggle-active', active);
  if (els.toggleQuickSponsorEditLabel) {
    els.toggleQuickSponsorEditLabel.textContent = 'Quick edit';
  }
  if (els.toggleQuickSponsorEditIcon) {
    els.toggleQuickSponsorEditIcon.classList.toggle('fa-pen-to-square', !active);
    els.toggleQuickSponsorEditIcon.classList.toggle('fa-pen', active);
  }
}

function setQuickSponsorEditEnabled(enabled) {
  const nextEnabled = Boolean(enabled) && state.sponsorListExpanded && isSponsorEditorEnabled();
  state.sponsorQuickEditEnabled = nextEnabled;
  syncQuickSponsorEditToggle();
  markSponsorDirty(state.sponsorDirty);
  renderSponsorForm();
}

function setFolderConnectionButtonState() {
  if (!els.folderConnectionToggle) return;
  if (state.folderConnectedInSession && state.projectDirHandle) {
    els.folderConnectionToggle.innerHTML = '<i class="fas fa-unlink mr-2"></i>Disconnect folder';
  } else {
    els.folderConnectionToggle.innerHTML = '<i class="fas fa-folder-open mr-2"></i>Open project folder';
  }
}

function setDatasetLoadingEnabled(enabled) {
  els.datasetSelect.disabled = !enabled;
}

function cloneJsonValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function capturePersistedSnapshot() {
  state.persistedSnapshot = {
    dataset: cloneJsonValue(state.dataset),
    file: state.file,
    outputPath: state.outputPath
  };
}

async function restorePersistedSnapshot() {
  if (!state.persistedSnapshot) return;
  state.dataset = cloneJsonValue(state.persistedSnapshot.dataset);
  state.file = state.persistedSnapshot.file || '';
  state.outputPath = state.persistedSnapshot.outputPath || '';
  normalizeDatasetShape();
  state.fileHandle = null;
  await restoreLinkedHandleForCurrentPath();
  setCurrentFilenameLabel();
  resetSessionQuickEditState();
  resetSponsorQuickEditState();
  markDirty(false);
  markSessionDirty(false);
  markSponsorDirty(false);
  renderEventMetaForm();
  renderLogoForm();
  renderFlickrForm();
  renderSessionList();
  renderSessionForm();
  renderSponsorList();
  renderSponsorForm();
  syncSessionSaveButton();
  syncSponsorSaveButton();
}

function saveRecoverySnapshot() {
  if (!state.dataset) return;
  try {
    localStorage.setItem(RECOVERY_KEY, JSON.stringify({
      dataset: state.dataset,
      file: state.file,
      outputPath: state.outputPath,
      savedAt: Date.now(),
    }));
  } catch {
    // localStorage full or unavailable
  }
}

function clearRecoverySnapshot() {
  try { localStorage.removeItem(RECOVERY_KEY); } catch {}
}

function loadRecoverySnapshot() {
  try {
    const raw = localStorage.getItem(RECOVERY_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data?.dataset || !data?.file) return null;
    if (data.savedAt && Date.now() - data.savedAt > RECOVERY_MAX_AGE_MS) {
      clearRecoverySnapshot();
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function applyRecovery(recovery) {
  state.dataset = recovery.dataset;
  state.file = recovery.file || '';
  state.outputPath = recovery.outputPath || '';
  state.selectedIndex = -1;
  state.selectedSponsorIndex = -1;
  state.sessionSearchQuery = '';
  normalizeDatasetShape();
  clearRecoverySnapshot();
  undoClear();
  markDirty(true);
  markSessionDirty(false);
  markSponsorDirty(false);
  setEditorButtonsEnabled(true);
  setCurrentFilenameLabel();
  renderEventMetaForm();
  renderSessionList();
  renderSessionForm();
  renderSponsorList();
  renderSponsorForm();
  syncSessionSaveButton();
  syncSponsorSaveButton();
  closeWelcomeModal();
}

function showRecoveryBar(recovery) {
  const bar = document.getElementById('recoveryBar');
  const textEl = document.getElementById('recoveryBarText');
  if (!bar || !textEl) return;
  const ageMs = Date.now() - (recovery.savedAt || 0);
  const ageMin = Math.round(ageMs / 60_000);
  const ageText = ageMin < 1 ? 'just now' : ageMin === 1 ? '1 minute ago' : `${ageMin} minutes ago`;
  textEl.textContent = `Unsaved work from ${ageText} found for "${recovery.file}".`;
  bar.classList.remove('hidden');
  document.getElementById('recoveryRestore')?.addEventListener('click', () => {
    applyRecovery(recovery);
    bar.classList.add('hidden');
  });
  document.getElementById('recoveryDismiss')?.addEventListener('click', () => {
    if (!window.confirm('Discard the recovered work? This cannot be undone.')) return;
    clearRecoverySnapshot();
    bar.classList.add('hidden');
  });
}

function undoPush() {
  if (!state.dataset) return;
  UNDO_STACK.push({
    dataset: cloneJsonValue(state.dataset),
    selectedIndex: state.selectedIndex,
    selectedSponsorIndex: state.selectedSponsorIndex,
  });
  if (UNDO_STACK.length > UNDO_LIMIT) UNDO_STACK.shift();
  updateUndoButton();
}

function undoClear() {
  UNDO_STACK.length = 0;
  updateUndoButton();
}

function updateUndoButton() {
  if (els.undoAction) {
    els.undoAction.disabled = UNDO_STACK.length === 0;
    els.undoAction.title = UNDO_STACK.length > 0
      ? `Undo (${UNDO_STACK.length} step${UNDO_STACK.length === 1 ? '' : 's'}) — Ctrl+Z`
      : 'Nothing to undo';
  }
}

async function performUndo() {
  if (UNDO_STACK.length === 0) return;
  const entry = UNDO_STACK.pop();
  state.dataset = entry.dataset;
  state.selectedIndex = entry.selectedIndex;
  state.selectedSponsorIndex = entry.selectedSponsorIndex;
  state.quickEditSessionChanges = new Set();
  state.quickEditSponsorChanges = new Set();
  normalizeDatasetShape();
  markDirty(true);
  markSessionDirty(false);
  markSponsorDirty(false);
  updateUndoButton();
  renderEventMetaForm();
  renderSessionList();
  renderSessionForm();
  renderSponsorList();
  renderSponsorForm();
  syncSessionSaveButton();
  syncSponsorSaveButton();
  if (els.deleteSession) els.deleteSession.disabled = state.selectedIndex < 0;
  if (els.deleteSponsor) els.deleteSponsor.disabled = state.selectedSponsorIndex < 0;
}

async function confirmDiscardPendingChanges(targetLabel = 'another form') {
  if (!state.dirty) return true;
  const proceed = window.confirm(
    `You have pending changes in this form. They will not be saved if you move to ${targetLabel}. Continue and discard them?`
  );
  if (!proceed) return false;
  await restorePersistedSnapshot();
  return true;
}

function markDirty(nextDirty = true) {
  state.dirty = nextDirty;
  const color = nextDirty ? 'text-amber-300' : 'text-emerald-300';
  const label = nextDirty ? 'Unsaved changes' : 'No changes';
  els.dirtyState.innerHTML = `<i class="fas fa-circle mr-2 text-xs ${color}"></i><span>${label}</span>`;
  els.dirtyState.dataset.dirty = String(nextDirty);
  els.saveDataset.classList.toggle('is-dirty', nextDirty);
  if (els.timelineSaveBtn) els.timelineSaveBtn.classList.toggle('is-dirty', nextDirty);
  if (els.revertDataset) {
    els.revertDataset.disabled = !nextDirty || !state.persistedSnapshot;
  }
}

let _saveToastTimer = null;
function showSaveToast() {
  if (!els.saveToast) return;
  clearTimeout(_saveToastTimer);
  els.saveToast.classList.add('is-visible');
  _saveToastTimer = setTimeout(() => els.saveToast.classList.remove('is-visible'), 2500);
}

function syncWelcomePanel() {
  if (!els.welcome) return;
  const show = (!state.folderConnectedInSession || !state.projectDirHandle) && !state.dataset;
  if (show) {
    document.getElementById('welcomeScreen1')?.classList.remove('hidden');
    document.getElementById('welcomeScreen2')?.classList.add('hidden');
  }
  els.welcome.classList.toggle('hidden', !show);
  els.welcome.setAttribute('aria-hidden', String(!show));
  document.body.classList.toggle('session-modal-open', show);
}

function closeWelcomeModal() {
  if (!els.welcome) return;
  els.welcome.classList.add('hidden');
  els.welcome.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('session-modal-open');
}

function showWelcomeScreen2() {
  if (!els.welcome) return;
  document.getElementById('welcomeScreen1')?.classList.add('hidden');
  const screen2 = document.getElementById('welcomeScreen2');
  if (screen2) screen2.classList.remove('hidden');

  const eventList = document.getElementById('welcomeEventList');
  if (eventList) {
    const extractYear = (text) => { const m = text.match(/\b(20\d{2}|19\d{2})\b/); return m ? parseInt(m[1], 10) : 0; };
    const options = Array.from(els.datasetSelect.options)
      .filter((o) => o.value.trim())
      .sort((a, b) => extractYear(b.text) - extractYear(a.text));
    eventList.innerHTML = options.length
      ? options.map((o) => `
          <button type="button" class="editor-welcome-event-btn" data-welcome-load="${escapeAttr(o.value)}">
            <i class="fas fa-file-code welcome-btn-icon"></i>
            <span class="welcome-btn-label">${escapeHtml(o.text)}</span>
            <i class="fas fa-chevron-right welcome-btn-arrow"></i>
          </button>
        `).join('')
      : '<p class="editor-welcome-empty">No event files found in this folder yet.</p>';

    eventList.querySelectorAll('[data-welcome-load]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const file = btn.dataset.welcomeLoad;
        closeWelcomeModal();
        try {
          els.datasetSelect.value = file;
          state.lastDatasetSelectValue = file;
          await loadDataset(file);
        } catch (e) {
          window.alert(`Could not load event: ${e.message}`);
        }
      });
    });
  }

  const newEventBtn = document.getElementById('welcomeNewEvent');
  if (newEventBtn) {
    newEventBtn.onclick = () => {
      const pathValue = promptForNewFilename();
      if (!pathValue) return;
      closeWelcomeModal();
      createDatasetScaffold(pathValue);
    };
  }
}

function markSessionDirty(nextDirty = true) {
  state.sessionDirty = nextDirty;
  if (!els.sessionDirtyState) return;
  const quickCount = state.quickEditSessionChanges.size;
  const hasQuickChanges = quickCount > 0 || state.sessionStructureDirty;
  const color = (state.sessionDirty || hasQuickChanges) ? 'text-amber-300' : 'text-emerald-300';
  let label = 'No changes';
  if (isQuickSessionEditEnabled()) {
    if (hasQuickChanges) {
      label = quickCount > 0 ? `${quickCount} item${quickCount === 1 ? '' : 's'} modified` : 'Unsaved quick edits';
    }
  } else if (state.sessionDirty || hasQuickChanges) {
    label = 'Unsaved changes';
  }
  els.sessionDirtyState.innerHTML = `<i class="fas fa-circle mr-2 text-[0.55rem] ${color}"></i><span>${label}</span>`;
  syncSessionSaveButton();
}

function markSponsorDirty(nextDirty = true) {
  state.sponsorDirty = nextDirty;
  if (!els.sponsorDirtyState) return;
  const quickCount = state.quickEditSponsorChanges.size;
  const hasQuickChanges = quickCount > 0 || state.sponsorStructureDirty;
  const color = (state.sponsorDirty || hasQuickChanges) ? 'text-amber-300' : 'text-emerald-300';
  let label = 'No changes';
  if (isQuickSponsorEditEnabled()) {
    if (hasQuickChanges) {
      label = quickCount > 0 ? `${quickCount} item${quickCount === 1 ? '' : 's'} modified` : 'Unsaved quick edits';
    }
  } else if (state.sponsorDirty || hasQuickChanges) {
    label = 'Unsaved changes';
  }
  els.sponsorDirtyState.innerHTML = `<i class="fas fa-circle mr-2 text-[0.55rem] ${color}"></i><span>${label}</span>`;
  syncSponsorSaveButton();
}

function trackQuickSessionChange(index = state.selectedIndex, structural = false) {
  if (index >= 0) {
    state.quickEditSessionChanges.add(index);
  }
  if (structural) {
    state.sessionStructureDirty = true;
  }
  markSessionDirty(Boolean(state.sessionDirty || state.quickEditSessionChanges.size > 0 || state.sessionStructureDirty));
}

function trackQuickSponsorChange(index = state.selectedSponsorIndex, structural = false) {
  if (index >= 0) {
    state.quickEditSponsorChanges.add(index);
  }
  if (structural) {
    state.sponsorStructureDirty = true;
  }
  markSponsorDirty(Boolean(state.sponsorDirty || state.quickEditSponsorChanges.size > 0 || state.sponsorStructureDirty));
}

function resetSessionQuickEditState() {
  state.quickEditSessionChanges = new Set();
  state.sessionStructureDirty = false;
}

function resetSponsorQuickEditState() {
  state.quickEditSponsorChanges = new Set();
  state.sponsorStructureDirty = false;
}

function moveTrackedIndex(set, from, to) {
  if (!(set instanceof Set) || from < 0 || to < 0 || from === to || set.size === 0) return;
  const next = new Set();
  set.forEach((index) => {
    if (index === from) {
      next.add(to);
    } else if (from < to && index > from && index <= to) {
      next.add(index - 1);
    } else if (to < from && index >= to && index < from) {
      next.add(index + 1);
    } else {
      next.add(index);
    }
  });
  set.clear();
  next.forEach((index) => set.add(index));
}

function removeTrackedIndex(set, removedIndex) {
  if (!(set instanceof Set) || removedIndex < 0 || set.size === 0) return;
  const next = new Set();
  set.forEach((index) => {
    if (index === removedIndex) return;
    next.add(index > removedIndex ? index - 1 : index);
  });
  set.clear();
  next.forEach((index) => set.add(index));
}

function syncSessionSaveButton() {
  if (!els.saveSession) return;
  const canSaveSelection = Boolean(state.dataset) && state.selectedIndex >= 0;
  const hasQuickChanges = state.quickEditSessionChanges.size > 0 || state.sessionStructureDirty;
  const saveAll = isQuickSessionEditEnabled();
  if (els.saveSessionLabel) {
    els.saveSessionLabel.textContent = saveAll ? 'Save all' : 'Save';
  }
  els.saveSession.disabled = saveAll ? !Boolean(state.dataset) || !hasQuickChanges : !canSaveSelection;
}

function syncSponsorSaveButton() {
  if (!els.saveSponsor) return;
  const canSaveSelection = Boolean(state.dataset) && state.selectedSponsorIndex >= 0;
  const hasQuickChanges = state.quickEditSponsorChanges.size > 0 || state.sponsorStructureDirty;
  const saveAll = isQuickSponsorEditEnabled();
  if (els.saveSponsorLabel) {
    els.saveSponsorLabel.textContent = saveAll ? 'Save all' : 'Save';
  }
  els.saveSponsor.disabled = saveAll ? !Boolean(state.dataset) || !hasQuickChanges : !canSaveSelection;
}

function toStringValue(value) {
  if (Array.isArray(value)) return value.join(', ');
  return value == null ? '' : String(value);
}

function parseMultiValue(value) {
  return String(value || '')
    .split(/\n|,/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function stripSummaryFields(dataset) {
  if (!dataset || !Array.isArray(dataset.items)) return;
  dataset.items.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(item, 'summary')) delete item.summary;
    if (Object.prototype.hasOwnProperty.call(item, 'description')) delete item.description;
  });
}


function normalizeFlickrObject(raw = null) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const enabled = !(input.enabled === false || String(input.enabled || '').toLowerCase() === 'false');
  return {
    enabled,
    groupUrl: String(input.groupUrl || '').trim(),
    image: String(input.image || '').trim(),
    imageAlt: String(input.imageAlt || '').trim()
  };
}

function normalizeLogoObject(raw = null) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    image: String(input.image || '').trim(),
    imageAlt: String(input.imageAlt || '').trim(),
    usePlate: input.usePlate === true || String(input.usePlate || '').toLowerCase() === 'true'
  };
}

function normalizeSponsorId(value, fallback = '') {
  const normalized = slugify(value || fallback || '');
  return normalized || '';
}

function normalizeSponsorObject(raw = null, fallbackTitle = '') {
  const input = raw && typeof raw === 'object' ? raw : {};
  const title = String(input.title || fallbackTitle || '').trim();
  const row = Number.parseInt(String(input.row ?? '').trim(), 10);
  return {
    id: normalizeSponsorId(input.id, title),
    title,
    tier: String(input.tier || '').trim(),
    row: Number.isFinite(row) ? row : 1,
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 100,
    image: String(input.image || '').trim(),
    imageAlt: String(input.imageAlt || '').trim(),
    link: String(input.link || '').trim(),
    bgStyle: ['auto', 'transparent', 'light-plate', 'dark-plate', 'brand-fill'].includes(String(input.bgStyle || '').trim())
      ? String(input.bgStyle || '').trim()
      : 'auto',
    aspect: ['auto', 'square', 'landscape', 'banner'].includes(String(input.aspect || '').trim())
      ? String(input.aspect || '').trim()
      : 'auto',
    enabled: !(input.enabled === false || String(input.enabled || '').toLowerCase() === 'false')
  };
}

function normalizeSponsorCollection(raw = null) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => normalizeSponsorObject(item, `Sponsor ${index + 1}`));
}

function extractDurationMinutes(value) {
  const input = String(value || '').trim();
  if (!input) return null;

  const directPm = input.match(/^p\s*(\d+)\s*m$/i);
  if (directPm) return Number.parseInt(directPm[1], 10);

  const isoLike = input.match(/^p?t?\s*(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?$/i);
  if (isoLike && (isoLike[1] || isoLike[2])) {
    const hours = isoLike[1] ? Number.parseFloat(isoLike[1]) : 0;
    const minutes = isoLike[2] ? Number.parseFloat(isoLike[2]) : 0;
    return Math.round(hours * 60 + minutes);
  }

  const compact = input.match(/^(\d+(?:\.\d+)?)h(\d+(?:\.\d+)?)m$/i);
  if (compact) {
    const hours = Number.parseFloat(compact[1]);
    const minutes = Number.parseFloat(compact[2]);
    return Math.round(hours * 60 + minutes);
  }

  const units = [...input.matchAll(/(\d+(?:\.\d+)?)\s*([hm])/gi)];
  if (units.length > 0) {
    let total = 0;
    units.forEach((match) => {
      const valueNum = Number.parseFloat(match[1]);
      if (match[2].toLowerCase() === 'h') {
        total += valueNum * 60;
      } else {
        total += valueNum;
      }
    });
    return Math.round(total);
  }

  if (/^\d+(?:\.\d+)?$/.test(input)) {
    return Math.round(Number.parseFloat(input));
  }

  return null;
}

function durationMinutesToHuman(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours > 0 && rem > 0) return `${hours}h${rem}m`;
  if (hours > 0) return `${hours}h`;
  return `${rem}m`;
}

function durationToEditorValue(value) {
  const minutes = extractDurationMinutes(value);
  if (minutes == null) return String(value || '');
  return durationMinutesToHuman(minutes);
}

function durationToCanonical(value) {
  const minutes = extractDurationMinutes(value);
  if (minutes == null) return String(value || '').trim();
  return `P${minutes}M`;
}

function deriveSessionDurationValue(startTime, endTime) {
  if (!startTime || !endTime) return '';
  const startMs = new Date(startTime).getTime();
  const endMs = new Date(endTime).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return '';
  const minutes = Math.round((endMs - startMs) / 60000);
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  return durationToCanonical(minutes);
}

function syncSessionDuration(item) {
  if (!item || typeof item !== 'object') return '';
  const duration = deriveSessionDurationValue(item.startTime, item.endTime);
  item.duration = duration;
  return duration;
}

function syncAllSessionDurations() {
  if (!Array.isArray(state.dataset?.items)) return;
  state.dataset.items.forEach((item) => {
    syncSessionDuration(item);
  });
}

function markdownToHtml(text) {
  return formatTextBlock(text) || '<p class="text-gray-500"><em>No description yet.</em></p>';
}

function isValidTimezone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function safeTimezone(value) {
  const tz = String(value || '').trim();
  if (tz && state.timezones.includes(tz)) return tz;
  if (tz && isValidTimezone(tz)) return tz;
  return 'UTC';
}

function buildTimezoneList() {
  let values = [];
  if (typeof Intl.supportedValuesOf === 'function') {
    try {
      values = Intl.supportedValuesOf('timeZone');
    } catch {
      values = [];
    }
  }
  if (!values.length) {
    values = [
      'UTC',
      'Australia/Sydney',
      'Australia/Melbourne',
      'Australia/Brisbane',
      'Australia/Adelaide',
      'Australia/Perth',
      'Australia/Canberra',
      'Pacific/Auckland',
      'Asia/Singapore',
      'Asia/Tokyo',
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles',
      'Europe/London',
      'Europe/Paris',
      'Asia/Kolkata'
    ];
  }
  if (!values.includes('UTC')) values.unshift('UTC');
  state.timezones = [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function getFormatter(timeZone) {
  const tz = safeTimezone(timeZone);
  if (dtfCache.has(tz)) return dtfCache.get(tz);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  dtfCache.set(tz, formatter);
  return formatter;
}

function getLocalPartsFromUtcMs(utcMs, timeZone) {
  const parts = getFormatter(timeZone).formatToParts(new Date(utcMs));
  const mapped = {};
  for (const part of parts) {
    if (part.type !== 'literal') mapped[part.type] = part.value;
  }
  return {
    year: Number(mapped.year || 0),
    month: Number(mapped.month || 0),
    day: Number(mapped.day || 0),
    hour: Number(mapped.hour || 0),
    minute: Number(mapped.minute || 0),
    second: Number(mapped.second || 0)
  };
}

function localPartsToWallMs(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
}

function utcIsoToLocalInput(iso, timeZone) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const p = getLocalPartsFromUtcMs(date.getTime(), timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  return `${String(p.year).padStart(4, '0')}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

function parseLocalInput(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: 0
  };
}

function localInputToUtcIso(localValue, timeZone) {
  const desired = parseLocalInput(localValue);
  if (!desired) return '';
  const desiredWallMs = localPartsToWallMs(desired);
  let utcMs = desiredWallMs;

  for (let i = 0; i < 4; i += 1) {
    const actualLocal = getLocalPartsFromUtcMs(utcMs, timeZone);
    const actualWallMs = localPartsToWallMs(actualLocal);
    const diff = actualWallMs - desiredWallMs;
    if (diff === 0) break;
    utcMs -= diff;
  }

  return new Date(utcMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function getEventTimezone() {
  return safeTimezone(state.dataset?.event?.timezone || 'UTC');
}

function formatSessionTimeForList(iso) {
  const local = utcIsoToLocalInput(iso, getEventTimezone());
  if (!local) return '';
  return local.replace('T', ' ');
}

function getManifestLabelByFile(file) {
  const found = eventCatalog.find((item) => item.file === file);
  return found?.label || file;
}

function buildDatasetOptionLabel(file, eventMeta = null) {
  const designation = String(eventMeta?.designation || '').trim();
  const year = String(eventMeta?.year || '').trim();
  const location = String(eventMeta?.location || '').trim();
  const fromMeta = [designation, year, location].filter(Boolean).join(' ').trim();
  return fromMeta || getManifestLabelByFile(file);
}

function getDatasetGroupName(eventMeta = null) {
  const designation = String(eventMeta?.designation || '').trim();
  return designation || 'Other';
}

function isEditorDatasetFile(name) {
  const normalized = String(name || '').trim().toLowerCase();
  return normalized.endsWith('.json') && normalized !== 'index.json';
}

function validateDatasetSchema(dataset, file = 'dataset') {
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) {
    throw new Error(`${file} is not a dataset object.`);
  }
  if (!dataset.event || typeof dataset.event !== 'object' || Array.isArray(dataset.event)) {
    throw new Error(`${file} is missing a valid "event" object.`);
  }
  if (!Array.isArray(dataset.items)) {
    throw new Error(`${file} is missing a valid "items" array.`);
  }
}

async function getDataDirectoryHandle(create = false) {
  if (!state.projectDirHandle) return null;
  return state.projectDirHandle.getDirectoryHandle('data', { create });
}

async function listDatasetFilesFromConnectedFolder() {
  const dataDir = await getDataDirectoryHandle(false);
  if (!dataDir) return [];
  const files = [];
  // eslint-disable-next-line no-restricted-syntax
  for await (const [name, handle] of dataDir.entries()) {
    if (handle.kind !== 'file') continue;
    if (!isEditorDatasetFile(name)) continue;
    files.push(name);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

async function loadDatasetMetaForGrouping(files) {
  const dataDir = await getDataDirectoryHandle(false);
  if (!dataDir) return [];

  const records = await Promise.all(
    files.map(async (file) => {
      try {
        const handle = await dataDir.getFileHandle(file);
        const blob = await handle.getFile();
        const text = await blob.text();
        const parsed = JSON.parse(text);
        validateDatasetSchema(parsed, file);
        const eventMeta = parsed && typeof parsed === 'object' ? parsed.event || {} : {};
        return {
          file,
          group: getDatasetGroupName(eventMeta),
          label: buildDatasetOptionLabel(file, eventMeta)
        };
      } catch {
        return {
          file,
          group: 'Other',
          label: getManifestLabelByFile(file)
        };
      }
    })
  );

  records.sort((a, b) => {
    const groupCmp = a.group.localeCompare(b.group);
    if (groupCmp !== 0) return groupCmp;
    return a.label.localeCompare(b.label);
  });
  return records;
}

async function renderDatasetOptionsFromConnectedFolder(preferred = '') {
  if (!state.projectDirHandle || !state.folderConnectedInSession) {
    els.datasetSelect.innerHTML = '<option value="">Connect folder to load datasets</option>';
    els.datasetSelect.value = '';
    return;
  }

  const files = await listDatasetFilesFromConnectedFolder();
  if (files.length === 0) {
    els.datasetSelect.innerHTML = '<option value="">No JSON files found in data/</option>';
    els.datasetSelect.value = '';
    return;
  }

  const groupedRecords = await loadDatasetMetaForGrouping(files);
  const groups = new Map();
  groupedRecords.forEach((record) => {
    if (!groups.has(record.group)) groups.set(record.group, []);
    groups.get(record.group).push(record);
  });

  els.datasetSelect.innerHTML = [...groups.entries()]
    .map(([groupName, records]) => {
      const options = records
        .map((record) => `<option value="${escapeAttr(record.file)}">${escapeHtml(record.label)}</option>`)
        .join('');
      return `<optgroup label="${escapeAttr(groupName)}">${options}</optgroup>`;
    })
    .join('');

  if (preferred && files.includes(preferred)) {
    els.datasetSelect.value = preferred;
    return;
  }

  const defaultItem = eventCatalog.find((i) => i.default);
  if (defaultItem && files.includes(defaultItem.file)) {
    els.datasetSelect.value = defaultItem.file;
    return;
  }

  els.datasetSelect.value = files[0];
}

function normalizeDatasetShape() {
  if (!state.dataset || typeof state.dataset !== 'object') state.dataset = {};
  if (!state.dataset.event || typeof state.dataset.event !== 'object') state.dataset.event = {};
  if (!Array.isArray(state.dataset.items)) state.dataset.items = [];
  stripSummaryFields(state.dataset);
  const mediaPromo = state.dataset.event.mediaPromo;
  const flickrFromMediaPromo =
    mediaPromo && typeof mediaPromo === 'object'
      ? {
          enabled: true,
          groupUrl: mediaPromo.groupUrl,
          image: mediaPromo.image,
          imageAlt: mediaPromo.imageAlt,
          title: mediaPromo.title,
          text: mediaPromo.text,
          buttonLabel: mediaPromo.buttonLabel,
          mode: mediaPromo.mode
        }
      : null;
  state.dataset.event.flickr = normalizeFlickrObject(state.dataset.event.flickr || flickrFromMediaPromo);
  state.dataset.event.logo = normalizeLogoObject(state.dataset.event.logo);
  state.dataset.event.sponsors = normalizeSponsorCollection(state.dataset.event.sponsors);
  if (Object.prototype.hasOwnProperty.call(state.dataset.event, 'mediaPromo')) {
    delete state.dataset.event.mediaPromo;
  }
  if (!state.dataset.event.timezone) state.dataset.event.timezone = 'UTC';
  if (state.dataset.event.columns == null || state.dataset.event.columns === '') state.dataset.event.columns = 3;
  syncAllSessionDurations();
  state.dataset.items.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const sponsorIds = parseMultiValue(item.sponsorIds || '');
    item.sponsorIds = sponsorIds.length <= 1 ? (sponsorIds[0] || '') : sponsorIds;
  });
}

async function loadDataset(file) {
  if (!state.projectDirHandle || !state.folderConnectedInSession) {
    throw new Error('Connect folder first.');
  }
  if (!isEditorDatasetFile(file)) {
    throw new Error(`${file} is not an editable dataset.`);
  }
  const targetPath = normalizeOutputPath(`data/${file}`);
  const handle = await resolveFileHandleFromProjectDir(targetPath);
  const fileBlob = await handle.getFile();
  const content = await fileBlob.text();
  const parsed = JSON.parse(content);
  validateDatasetSchema(parsed, file);
  state.dataset = parsed;
  state.file = file;
  state.outputPath = targetPath;
  state.lastDatasetSelectValue = file;
  state.fileHandle = handle;
  state.selectedIndex = -1;
  state.selectedSponsorIndex = -1;
  state.sessionSearchQuery = '';
  normalizeDatasetShape();
  await restoreLinkedHandleForCurrentPath();
  if (!state.fileHandle && state.projectDirHandle) {
    try {
      const fromDir = await resolveFileHandleFromProjectDir(state.outputPath);
      if (fromDir) {
        state.fileHandle = fromDir;
        await setLinkedHandle(getFileLinkKey(), fromDir);
      }
    } catch {
      // Keep fallback behavior.
    }
  }
  markDirty(false);
  markSessionDirty(false);
  markSponsorDirty(false);
  capturePersistedSnapshot();
  undoClear();
  clearRecoverySnapshot();
  setCurrentFilenameLabel();
  renderEventMetaForm();
  renderLogoForm();
  renderFlickrForm();
  renderSessionList();
  renderSessionForm();
  renderSponsorList();
  renderSponsorForm();
  if (state.activeEditorTab === 'sitemap') renderSitemap();
  if (state.activeEditorTab === 'timeline' && els.timelineCanvas) {
    renderTimeline(els.timelineCanvas, state.dataset, {
      markDirty: () => markDirty(true),
      trackQuickSessionChange,
      utcIsoToLocalInput,
      localInputToUtcIso,
      getEventTimezone,
    });
  }
  setEditorButtonsEnabled(true);
  if (els.datasetSelect.value !== file) {
    els.datasetSelect.value = file;
  }
  if (els.sessionSearchInput) {
    els.sessionSearchInput.value = '';
  }
}

function createDatasetScaffold(pathValue) {
  const year = new Date().getUTCFullYear();
  state.dataset = {
    event: {
      id: '',
      name: '',
      designation: 'DrupalSouth',
      year: String(year),
      location: '',
      region: '',
      venue: '',
      website: '',
      scheduleURL: '',
      logo: normalizeLogoObject(),
      flickr: normalizeFlickrObject(),
      sponsors: [],
      timezone: 'UTC',
      columns: 3,
      enabled: true
    },
    items: []
  };
  state.outputPath = normalizeOutputPath(pathValue, 'data/new-event.json');
  state.file = outputBasename(state.outputPath) || 'new-event.json';
  state.fileHandle = null;
  state.selectedIndex = -1;
  state.selectedSponsorIndex = -1;
  markDirty(true);
  resetSessionQuickEditState();
  resetSponsorQuickEditState();
  markSessionDirty(false);
  markSponsorDirty(false);
  capturePersistedSnapshot();
  setCurrentFilenameLabel();
  renderEventMetaForm();
  renderLogoForm();
  renderFlickrForm();
  renderSessionList();
  renderSessionForm();
  renderSponsorList();
  renderSponsorForm();
  if (state.activeEditorTab === 'sitemap') renderSitemap();
  setEditorButtonsEnabled(true);
}

function getFlickrImageTargetPath() {
  const designation = slugify(state.dataset?.event?.designation || 'event');
  const year = slugify(state.dataset?.event?.year || '');
  const location = slugify(state.dataset?.event?.location || '');
  const fallback = slugify(outputBasename(state.outputPath || state.file || 'event').replace(/\.json$/i, '')) || 'event';
  const baseName = [year, location].filter(Boolean).join('-') || fallback;
  return `img/flickr/${designation || 'event'}/${baseName}.jpg`;
}

function getLogoImageTargetPath(file) {
  const designation = slugify(state.dataset?.event?.designation || 'event');
  const year = slugify(state.dataset?.event?.year || '');
  const location = slugify(state.dataset?.event?.location || '');
  const fallback = slugify(outputBasename(state.outputPath || state.file || 'event').replace(/\.json$/i, '')) || 'event';
  const baseName = [year, location].filter(Boolean).join('-') || fallback;
  const originalName = String(file?.name || '').trim().toLowerCase();
  const extMatch = originalName.match(/\.(svg|png|jpe?g|webp|gif)$/i);
  const ext = extMatch ? extMatch[1].toLowerCase().replace('jpeg', 'jpg') : 'png';
  return `img/logos/${designation || 'event'}/${baseName}.${ext}`;
}

function getSponsorImageTargetPath(file, sponsor = null) {
  const designation = slugify(state.dataset?.event?.designation || 'event');
  const year = slugify(state.dataset?.event?.year || '');
  const location = slugify(state.dataset?.event?.location || '');
  const sponsorSlug = slugify(sponsor?.id || sponsor?.title || file?.name || 'sponsor') || 'sponsor';
  const originalName = String(file?.name || '').trim().toLowerCase();
  const extMatch = originalName.match(/\.(svg|png|jpe?g|webp|gif)$/i);
  const ext = extMatch ? extMatch[1].toLowerCase().replace('jpeg', 'jpg') : 'png';
  const eventSlug = [year, location].filter(Boolean).join('-') || 'event';
  return `img/sponsors/${designation || 'event'}/${eventSlug}/${sponsorSlug}.${ext}`;
}

async function ensureDirectoryPath(baseDirHandle, segments) {
  let current = baseDirHandle;
  for (const segment of segments) {
    if (!segment) continue;
    current = await current.getDirectoryHandle(segment, { create: true });
  }
  return current;
}

async function uploadFlickrImageFromPicker() {
  if (!state.projectDirHandle || !state.folderConnectedInSession) {
    window.alert('Connect folder first to upload Flickr images.');
    return;
  }
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/*';
  picker.click();

  await new Promise((resolve) => {
    picker.addEventListener('change', resolve, { once: true });
  });

  const file = picker.files && picker.files[0] ? picker.files[0] : null;
  if (!file) return;

  const relativePath = getFlickrImageTargetPath();
  const segments = relativePath.split('/').filter(Boolean);
  const fileName = segments.pop();
  const dir = await ensureDirectoryPath(state.projectDirHandle, segments);
  const handle = await dir.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(file);
  await writable.close();

  if (!state.dataset.event.flickr || typeof state.dataset.event.flickr !== 'object') {
    state.dataset.event.flickr = normalizeFlickrObject();
  }
  state.dataset.event.flickr.image = `./${relativePath}`;
  if (!state.dataset.event.flickr.imageAlt) {
    state.dataset.event.flickr.imageAlt = `${state.dataset.event.designation || 'Event'} Flickr image`;
  }
  markDirty(true);
  renderEventMetaForm();
}

async function uploadLogoImageFromPicker() {
  if (!state.projectDirHandle || !state.folderConnectedInSession) {
    window.alert('Connect folder first to upload event logos.');
    return;
  }
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.svg,image/*';
  picker.click();

  await new Promise((resolve) => {
    picker.addEventListener('change', resolve, { once: true });
  });

  const file = picker.files && picker.files[0] ? picker.files[0] : null;
  if (!file) return;

  const relativePath = getLogoImageTargetPath(file);
  const segments = relativePath.split('/').filter(Boolean);
  const fileName = segments.pop();
  const dir = await ensureDirectoryPath(state.projectDirHandle, segments);
  const handle = await dir.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(file);
  await writable.close();

  state.dataset.event.logo = normalizeLogoObject(state.dataset.event.logo);
  state.dataset.event.logo.image = `./${relativePath}`;
  if (!state.dataset.event.logo.imageAlt) {
    state.dataset.event.logo.imageAlt = `${state.dataset.event.designation || 'Event'} logo`;
  }
  markDirty(true);
  renderEventMetaForm();
}

async function uploadSponsorImageFromPicker(index) {
  if (!state.projectDirHandle || !state.folderConnectedInSession) {
    window.alert('Connect folder first to upload sponsor images.');
    return;
  }
  const sponsor = state.dataset?.event?.sponsors?.[index];
  if (!sponsor) return;

  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.svg,image/*';
  picker.click();

  await new Promise((resolve) => {
    picker.addEventListener('change', resolve, { once: true });
  });

  const file = picker.files && picker.files[0] ? picker.files[0] : null;
  if (!file) return;

  const relativePath = getSponsorImageTargetPath(file, sponsor);
  const segments = relativePath.split('/').filter(Boolean);
  const fileName = segments.pop();
  const dir = await ensureDirectoryPath(state.projectDirHandle, segments);
  const handle = await dir.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(file);
  await writable.close();

  sponsor.image = `./${relativePath}`;
  if (!sponsor.imageAlt) {
    sponsor.imageAlt = `${sponsor.title || 'Sponsor'} logo`;
  }
  markDirty(true);
  markSponsorDirty(true);
  renderSponsorList();
  renderSponsorForm();
  renderSessionForm();
}

function fieldDescriptionId(scope, key) {
  return `${scope}-${String(key).replace(/[^a-z0-9_-]+/gi, '-')}-description`;
}

function renderFieldIntro(scope, key, config) {
  const description = String(config.description || '').trim();
  return `
    <span class="editor-field-label">${escapeHtml(config.label || key)}</span>
    ${
      description
        ? `<span id="${escapeAttr(fieldDescriptionId(scope, key))}" class="editor-field-description">${escapeHtml(description)}</span>`
        : ''
    }
  `;
}

function fieldDescriptionAttr(scope, key, config) {
  return config.description ? ` aria-describedby="${escapeAttr(fieldDescriptionId(scope, key))}"` : '';
}

function inferFlickrMode(eventMeta = null, items = []) {
  const now = new Date();
  const endDate = String(eventMeta?.endDate || '').trim();
  if (endDate) {
    const parsed = new Date(endDate);
    if (!Number.isNaN(parsed.getTime())) return parsed <= now ? 'archive' : 'cta';
  }

  const lastSession = (Array.isArray(items) ? items : [])
    .map((item) => new Date(item?.endTime || item?.startTime || ''))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => b.getTime() - a.getTime())[0];
  if (lastSession) return lastSession <= now ? 'archive' : 'cta';

  return 'cta';
}

function getFlickrEventLabel(eventMeta = null) {
  return [eventMeta?.designation, eventMeta?.year, eventMeta?.location].filter(Boolean).join(' ').trim() || 'Event';
}

function getAutomatedFlickrCopy(eventMeta = null, items = []) {
  const mode = inferFlickrMode(eventMeta, items);
  const eventLabel = getFlickrEventLabel(eventMeta);
  return {
    mode,
    heading: mode === 'archive' ? `${eventLabel} Photo Archive` : `Share Your ${eventLabel} Photos`,
    description:
      mode === 'archive'
        ? `Browse the official Flickr group for photos from ${eventLabel}.`
        : 'Join the official Flickr group and share your photos before, during, and after the event.',
    buttonText: mode === 'archive' ? 'View Photo Archive' : 'Open Flickr Group'
  };
}

function renderFlickrBlock(flickr) {
  const automated = getAutomatedFlickrCopy(state.dataset?.event, state.dataset?.items);
  return `
    <fieldset class="editor-flickr-block md:col-span-2 xl:col-span-3">
      <legend>
        <span class="editor-flickr-title"><i class="fab fa-flickr" aria-hidden="true"></i> Flickr block</span>
        <span class="editor-flickr-summary">Optional photo-sharing callout shown at the bottom of the event page.</span>
      </legend>
      <label class="editor-toggle-row">
        <input data-flickr-field="enabled" type="checkbox" class="h-4 w-4" ${flickr.enabled ? 'checked' : ''}${fieldDescriptionAttr(
          'flickr',
          'enabled',
          FLICKR_FIELD_CONFIG.enabled
        )}>
        <span>
          ${renderFieldIntro('flickr', 'enabled', FLICKR_FIELD_CONFIG.enabled)}
        </span>
      </label>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
        <label class="editor-form-field md:col-span-2">
          ${renderFieldIntro('flickr', 'groupUrl', FLICKR_FIELD_CONFIG.groupUrl)}
          <input data-flickr-field="groupUrl" type="text" value="${escapeAttr(flickr.groupUrl)}" class="w-full h-11 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-base font-medium bg-white px-3" placeholder="https://flic.kr/g/..."${fieldDescriptionAttr(
            'flickr',
            'groupUrl',
            FLICKR_FIELD_CONFIG.groupUrl
          )}>
        </label>
        <label class="editor-form-field md:col-span-2">
          ${renderFieldIntro('flickr', 'image', FLICKR_FIELD_CONFIG.image)}
          <input data-flickr-field="image" type="text" value="${escapeAttr(flickr.image)}" class="w-full h-11 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3" placeholder="./img/flickr/.../image.jpg"${fieldDescriptionAttr(
            'flickr',
            'image',
            FLICKR_FIELD_CONFIG.image
          )}>
        </label>
        <label class="editor-form-field md:col-span-2">
          ${renderFieldIntro('flickr', 'imageAlt', FLICKR_FIELD_CONFIG.imageAlt)}
          <input data-flickr-field="imageAlt" type="text" value="${escapeAttr(flickr.imageAlt)}" class="w-full h-11 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"${fieldDescriptionAttr(
            'flickr',
            'imageAlt',
            FLICKR_FIELD_CONFIG.imageAlt
          )}>
        </label>
        <div class="editor-form-field md:col-span-2 editor-flickr-defaults">
          <span class="editor-field-label">Automated Flickr copy</span>
          <span class="editor-field-description">The heading, description, button text, and mode are generated automatically from the event timing.</span>
          <div class="editor-flickr-defaults-grid">
            <div><span class="editor-flickr-defaults-label">Mode</span><span class="editor-flickr-defaults-value">${escapeHtml(automated.mode === 'archive' ? 'Photo archive' : 'Share photos')}</span></div>
            <div><span class="editor-flickr-defaults-label">Heading</span><span class="editor-flickr-defaults-value">${escapeHtml(automated.heading)}</span></div>
            <div><span class="editor-flickr-defaults-label">Description</span><span class="editor-flickr-defaults-value">${escapeHtml(automated.description)}</span></div>
            <div><span class="editor-flickr-defaults-label">Button text</span><span class="editor-flickr-defaults-value">${escapeHtml(automated.buttonText)}</span></div>
          </div>
        </div>
        <div class="editor-form-field">
          <span class="editor-field-label">Promo image upload</span>
          <span class="editor-field-description">Uploads to <code>img/flickr/${escapeHtml(
            slugify(state.dataset?.event?.designation || 'event') || 'event'
          )}</code> and stores a relative path.</span>
          <button id="flickrImageUpload" type="button" class="h-11 inline-flex items-center justify-center pl-5 pr-4 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors whitespace-nowrap">
            <i class="fas fa-image mr-2"></i>Upload 250x250 Image
          </button>
        </div>
      </div>
    </fieldset>
  `;
}

function renderLogoBlock(logo) {
  return `
    <fieldset class="editor-flickr-block md:col-span-2 xl:col-span-3">
      <legend>
        <span class="editor-flickr-title"><i class="fas fa-image" aria-hidden="true"></i> Event logo</span>
        <span class="editor-flickr-summary">Controls the header logo shown on the public event page.</span>
      </legend>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
        <label class="editor-form-field md:col-span-2">
          ${renderFieldIntro('logo', 'image', LOGO_FIELD_CONFIG.image)}
          <input data-logo-field="image" type="text" value="${escapeAttr(logo.image)}" class="w-full h-11 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3" placeholder="./img/logos/.../logo.png"${fieldDescriptionAttr(
            'logo',
            'image',
            LOGO_FIELD_CONFIG.image
          )}>
        </label>
        <label class="editor-form-field md:col-span-2">
          ${renderFieldIntro('logo', 'imageAlt', LOGO_FIELD_CONFIG.imageAlt)}
          <input data-logo-field="imageAlt" type="text" value="${escapeAttr(logo.imageAlt)}" class="w-full h-11 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"${fieldDescriptionAttr(
            'logo',
            'imageAlt',
            LOGO_FIELD_CONFIG.imageAlt
          )}>
        </label>
        <label class="editor-toggle-row md:col-span-2">
          <input data-logo-field="usePlate" type="checkbox" class="h-4 w-4" ${logo.usePlate ? 'checked' : ''}${fieldDescriptionAttr(
            'logo',
            'usePlate',
            LOGO_FIELD_CONFIG.usePlate
          )}>
          <span>
            ${renderFieldIntro('logo', 'usePlate', LOGO_FIELD_CONFIG.usePlate)}
          </span>
        </label>
        <div class="editor-form-field">
          <span class="editor-field-label">Logo upload</span>
          <span class="editor-field-description">Uploads to <code>img/logos/${escapeHtml(
            slugify(state.dataset?.event?.designation || 'event') || 'event'
          )}</code> and stores a relative path.</span>
          <button id="logoImageUpload" type="button" class="h-11 inline-flex items-center justify-center pl-5 pr-4 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors whitespace-nowrap">
            <i class="fas fa-upload mr-2"></i>Upload Logo
          </button>
        </div>
      </div>
    </fieldset>
  `;
}

function bindFlickrFormEvents(container) {
  if (!container) return;
  container.querySelectorAll('[data-flickr-field]').forEach((input) => {
    const key = input.dataset.flickrField;
    const updateFlickrField = () => {
      const eventFlickr = normalizeFlickrObject(state.dataset.event.flickr);
      if (key === 'enabled') {
        eventFlickr.enabled = Boolean(input.checked);
      } else {
        eventFlickr[key] = input.value;
      }
      state.dataset.event.flickr = normalizeFlickrObject(eventFlickr);
      markDirty(true);
    };
    input.addEventListener('input', updateFlickrField);
    input.addEventListener('change', updateFlickrField);
  });

  const uploadButton = container.querySelector('#flickrImageUpload');
  if (uploadButton) {
    uploadButton.addEventListener('click', async () => {
      try {
        await uploadFlickrImageFromPicker();
      } catch (error) {
        window.alert(`Flickr image upload failed: ${error.message}`);
      }
    });
  }
}

function bindLogoFormEvents(container) {
  if (!container) return;
  container.querySelectorAll('[data-logo-field]').forEach((input) => {
    const key = input.dataset.logoField;
    const updateLogoField = () => {
      const eventLogo = normalizeLogoObject(state.dataset.event.logo);
      eventLogo[key] = key === 'usePlate' ? Boolean(input.checked) : input.value;
      state.dataset.event.logo = normalizeLogoObject(eventLogo);
      markDirty(true);
    };
    input.addEventListener('input', updateLogoField);
    input.addEventListener('change', updateLogoField);
  });

  const logoUploadButton = container.querySelector('#logoImageUpload');
  if (logoUploadButton) {
    logoUploadButton.addEventListener('click', async () => {
      try {
        await uploadLogoImageFromPicker();
      } catch (error) {
        window.alert(`Logo upload failed: ${error.message}`);
      }
    });
  }
}

function renderLogoForm() {
  if (!els.logoForm) return;
  if (!state.dataset) {
    els.logoForm.innerHTML = '<p class="text-sm text-gray-400">Load a dataset to edit the event logo.</p>';
    return;
  }
  const logo = normalizeLogoObject(state.dataset?.event?.logo);
  els.logoForm.innerHTML = renderLogoBlock(logo);
  bindLogoFormEvents(els.logoForm);
}

function renderFlickrForm() {
  if (!els.flickrForm) return;
  if (!state.dataset) {
    els.flickrForm.innerHTML = '<p class="text-sm text-gray-400">Load a dataset to edit the Flickr block.</p>';
    return;
  }
  const flickr = normalizeFlickrObject(state.dataset?.event?.flickr);
  els.flickrForm.innerHTML = renderFlickrBlock(flickr);
  bindFlickrFormEvents(els.flickrForm);
}

function renderEventMetaForm() {
  const event = state.dataset?.event || {};
  const visibleFields = EVENT_META_FIELDS.filter((field) => !['id', 'name', 'logo', 'flickr'].includes(field));

  const html = visibleFields.map((field) => {
    const config = EVENT_META_FIELD_CONFIG[field] || { label: field, description: '' };
    const isWide = field === 'website' || field === 'scheduleURL';
    const spanClass = isWide ? 'md:col-span-2 xl:col-span-3' : '';

    if (field === 'timezone') {
      const current = safeTimezone(event[field] || 'UTC');
      const timezoneValues = state.timezones.includes(current) ? state.timezones : [current, ...state.timezones];
      const options = timezoneValues
        .map((tz) => `<option value="${escapeAttr(tz)}" ${tz === current ? 'selected' : ''}>${escapeHtml(tz)}</option>`)
        .join('');
      return `
        <label class="editor-form-field ${spanClass}">
          ${renderFieldIntro('event', field, config)}
          <select data-event-field="timezone" class="w-full h-11 pr-10 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-base font-medium bg-white px-3"${fieldDescriptionAttr(
            'event',
            field,
            config
          )}>${options}</select>
        </label>
      `;
    }

    if (field === 'enabled') {
      const checked = event.enabled === true || String(event.enabled).toLowerCase() === 'true';
      return `
        <label class="editor-form-field ${spanClass}">
          ${renderFieldIntro('event', field, config)}
          <span class="h-11 inline-flex items-center gap-3 rounded-md border border-gray-300 px-3 bg-white">
            <input data-event-field="${field}" type="checkbox" class="h-4 w-4" ${checked ? 'checked' : ''}${fieldDescriptionAttr(
              'event',
              field,
              config
            )}>
            <span class="text-sm text-gray-200">Show this event in planner</span>
          </span>
        </label>
      `;
    }

    if (field === 'startDate' || field === 'endDate') {
      const raw = toStringValue(event[field]);
      const dateValue = raw ? raw.split('T')[0] : '';
      return `
        <label class="editor-form-field ${spanClass}">
          ${renderFieldIntro('event', field, config)}
          <input data-event-field="${field}" type="date" value="${escapeAttr(dateValue)}" class="w-full h-11 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-base font-medium bg-white px-3"${fieldDescriptionAttr(
            'event',
            field,
            config
          )}>
        </label>
      `;
    }

    if (field === 'columns') {
      const value = Number.isFinite(Number(event[field])) ? Number(event[field]) : 3;
      return `
        <label class="editor-form-field ${spanClass}">
          ${renderFieldIntro('event', field, config)}
          <input data-event-field="columns" type="number" min="1" max="8" step="1" value="${value}" class="w-full h-11 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-base font-medium bg-white px-3"${fieldDescriptionAttr(
            'event',
            field,
            config
          )}>
        </label>
      `;
    }

    const value = toStringValue(event[field]);
    return `
      <label class="editor-form-field ${spanClass}">
        ${renderFieldIntro('event', field, config)}
        <input data-event-field="${field}" type="text" value="${escapeAttr(value)}" class="w-full h-11 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-base font-medium bg-white px-3"${fieldDescriptionAttr(
          'event',
          field,
          config
        )}>
      </label>
    `;
  }).join('');

  els.eventMetaForm.innerHTML = html;

  els.eventMetaForm.querySelectorAll('[data-event-field]').forEach((input) => {
    input.addEventListener('focus', undoPush);
    input.addEventListener('input', () => {
      const field = input.dataset.eventField;
      if (field === 'columns') {
        const parsed = Number.parseInt(input.value || '3', 10);
        state.dataset.event.columns = Number.isFinite(parsed) ? parsed : 3;
      } else if (field === 'timezone') {
        state.dataset.event.timezone = safeTimezone(input.value);
        renderSessionList();
        renderSessionForm();
        renderFlickrForm();
      } else if (field === 'enabled') {
        state.dataset.event[field] = Boolean(input.checked);
      } else {
        state.dataset.event[field] = input.value;
      }
      markDirty(true);
      if (field === 'designation' || field === 'year' || field === 'location') {
        renderLogoForm();
        renderFlickrForm();
      }
      if ((field === 'startDate' || field === 'endDate') && state.activeEditorTab === 'timeline' && els.timelineCanvas) {
        renderTimeline(els.timelineCanvas, state.dataset, {
          markDirty: () => markDirty(true),
          trackQuickSessionChange,
          utcIsoToLocalInput,
          localInputToUtcIso,
          getEventTimezone,
        });
      }
    });
  });
  renderLogoForm();
  renderFlickrForm();
}

function setEventMetaCollapsed(collapsed) {
  if (!els.eventMetaBody || !els.toggleEventMetaIcon) return;
  els.eventMetaBody.classList.toggle('hidden', collapsed);
  els.toggleEventMetaIcon.classList.toggle('fa-chevron-up', !collapsed);
  els.toggleEventMetaIcon.classList.toggle('fa-chevron-down', collapsed);
}

function syncSessionEditorPanelVisibility() {
  if (!els.sessionEditorPanel) return;
  const shouldHide = state.sessionListExpanded && state.selectedIndex < 0;
  els.sessionEditorPanel.classList.toggle('hidden', shouldHide);
}

function syncSponsorEditorPanelVisibility() {
  if (!els.sponsorEditorPanel) return;
  const shouldHide = state.sponsorListExpanded && state.selectedSponsorIndex < 0;
  els.sponsorEditorPanel.classList.toggle('hidden', shouldHide);
}

function setSessionWorkspaceExpanded(expanded) {
  const nextExpanded = Boolean(expanded);
  const wasExpanded = state.sessionListExpanded;
  if (nextExpanded && !wasExpanded) {
    state.selectedIndex = -1;
    if (!state.sessionQuickEditEnabled) {
      markSessionDirty(false);
    }
  }
  state.sessionListExpanded = nextExpanded;
  if (!state.sessionListExpanded) {
    state.sessionQuickEditEnabled = false;
  }
  if (!els.sessionWorkspace || !els.sessionSidebarPanel || !els.sessionEditorPanel) return;

  els.sessionWorkspace.classList.toggle('editor-session-workspace-expanded', state.sessionListExpanded);
  els.sessionSidebarPanel.classList.toggle('xl:col-span-2', state.sessionListExpanded);
  els.sessionEditorPanel.classList.toggle('xl:col-span-2', state.sessionListExpanded);

  if (els.toggleSessionWorkspaceIcon) {
    els.toggleSessionWorkspaceIcon.classList.toggle('fa-expand-alt', !state.sessionListExpanded);
    els.toggleSessionWorkspaceIcon.classList.toggle('fa-compress-alt', state.sessionListExpanded);
  }
  if (els.toggleSessionWorkspaceLabel) {
    els.toggleSessionWorkspaceLabel.textContent = state.sessionListExpanded ? 'Collapse list' : 'Expand list';
  }
  syncSessionEditorPanelVisibility();
  syncQuickSessionEditToggle();
  markSessionDirty(state.sessionDirty);
}

function setSponsorWorkspaceExpanded(expanded) {
  const nextExpanded = Boolean(expanded);
  const wasExpanded = state.sponsorListExpanded;
  if (nextExpanded && !wasExpanded) {
    state.selectedSponsorIndex = -1;
    if (!state.sponsorQuickEditEnabled) {
      markSponsorDirty(false);
    }
  }
  state.sponsorListExpanded = nextExpanded;
  if (!state.sponsorListExpanded) {
    state.sponsorQuickEditEnabled = false;
  }
  if (!els.sponsorWorkspace || !els.sponsorSidebarPanel || !els.sponsorEditorPanel) return;

  els.sponsorWorkspace.classList.toggle('editor-session-workspace-expanded', state.sponsorListExpanded);
  els.sponsorSidebarPanel.classList.toggle('xl:col-span-2', state.sponsorListExpanded);
  els.sponsorEditorPanel.classList.toggle('xl:col-span-2', state.sponsorListExpanded);

  if (els.toggleSponsorWorkspaceIcon) {
    els.toggleSponsorWorkspaceIcon.classList.toggle('fa-expand-alt', !state.sponsorListExpanded);
    els.toggleSponsorWorkspaceIcon.classList.toggle('fa-compress-alt', state.sponsorListExpanded);
  }
  if (els.toggleSponsorWorkspaceLabel) {
    els.toggleSponsorWorkspaceLabel.textContent = state.sponsorListExpanded ? 'Collapse list' : 'Expand list';
  }
  syncSponsorEditorPanelVisibility();
  syncQuickSponsorEditToggle();
  markSponsorDirty(state.sponsorDirty);
}

function setActiveEditorTab(tab) {
  const nextTab = ['event', 'logo', 'flickr', 'sessions', 'sponsors', 'sitemap', 'timeline'].includes(tab) ? tab : 'event';
  state.activeEditorTab = nextTab;

  if (els.eventWorkspacePanel) {
    els.eventWorkspacePanel.classList.toggle('hidden', nextTab !== 'event');
  }
  if (els.logoWorkspacePanel) {
    els.logoWorkspacePanel.classList.toggle('hidden', nextTab !== 'logo');
  }
  if (els.flickrWorkspacePanel) {
    els.flickrWorkspacePanel.classList.toggle('hidden', nextTab !== 'flickr');
  }
  if (els.sessionWorkspacePanel) {
    els.sessionWorkspacePanel.classList.toggle('hidden', nextTab !== 'sessions');
  }
  if (els.sponsorWorkspacePanel) {
    els.sponsorWorkspacePanel.classList.toggle('hidden', nextTab !== 'sponsors');
  }
  if (els.sitemapWorkspacePanel) {
    els.sitemapWorkspacePanel.classList.toggle('hidden', nextTab !== 'sitemap');
  }
  if (els.showEventTab) {
    const active = nextTab === 'event';
    els.showEventTab.classList.toggle('is-active', active);
    els.showEventTab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  if (els.showLogoTab) {
    const active = nextTab === 'logo';
    els.showLogoTab.classList.toggle('is-active', active);
    els.showLogoTab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  if (els.showFlickrTab) {
    const active = nextTab === 'flickr';
    els.showFlickrTab.classList.toggle('is-active', active);
    els.showFlickrTab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  if (els.showSessionsTab) {
    const active = nextTab === 'sessions';
    els.showSessionsTab.classList.toggle('is-active', active);
    els.showSessionsTab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  if (els.showSponsorsTab) {
    const active = nextTab === 'sponsors';
    els.showSponsorsTab.classList.toggle('is-active', active);
    els.showSponsorsTab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  if (els.showSitemapTab) {
    const active = nextTab === 'sitemap';
    els.showSitemapTab.classList.toggle('is-active', active);
    els.showSitemapTab.setAttribute('aria-selected', active ? 'true' : 'false');
    if (active) renderSitemap();
  }
  if (els.sitemapWorkspacePanel) {
    els.sitemapWorkspacePanel.classList.toggle('hidden', nextTab !== 'sitemap');
  }
  if (els.timelineWorkspacePanel) {
    els.timelineWorkspacePanel.classList.toggle('hidden', nextTab !== 'timeline');
  }
  if (els.showTimelineTab) {
    const active = nextTab === 'timeline';
    els.showTimelineTab.classList.toggle('is-active', active);
    els.showTimelineTab.setAttribute('aria-selected', active ? 'true' : 'false');
    if (active && state.dataset && els.timelineCanvas) {
      renderTimeline(els.timelineCanvas, state.dataset, {
        markDirty: () => markDirty(true),
        trackQuickSessionChange,
        utcIsoToLocalInput,
        localInputToUtcIso,
        getEventTimezone,
      });
    }
  }
}

async function switchEditorTab(tab) {
  const nextTab = ['event', 'logo', 'flickr', 'sessions', 'sponsors', 'sitemap', 'timeline'].includes(tab) ? tab : 'event';
  if (nextTab === state.activeEditorTab) return true;
  const allowed = await confirmDiscardPendingChanges(`${nextTab} form`);
  if (!allowed) return false;
  setActiveEditorTab(nextTab);
  return true;
}

async function selectSessionForm(index, options = {}) {
  const { collapseWorkspace = false, promptLabel = 'another session form' } = options;
  if (index === state.selectedIndex && !collapseWorkspace) return true;
  const allowed = await confirmDiscardPendingChanges(promptLabel);
  if (!allowed) return false;
  state.selectedIndex = index;
  if (!isQuickSessionEditEnabled()) {
    markSessionDirty(false);
  } else {
    markSessionDirty(state.sessionDirty);
  }
  if (collapseWorkspace && state.sessionListExpanded) {
    setSessionWorkspaceExpanded(false);
  }
  renderSessionList();
  renderSessionForm();
  syncSessionSaveButton();
  els.deleteSession.disabled = index < 0;
  return true;
}

async function selectSponsorForm(index, options = {}) {
  const { collapseWorkspace = false, promptLabel = 'another sponsor form' } = options;
  if (index === state.selectedSponsorIndex && !collapseWorkspace) return true;
  const allowed = await confirmDiscardPendingChanges(promptLabel);
  if (!allowed) return false;
  state.selectedSponsorIndex = index;
  if (!isQuickSponsorEditEnabled()) {
    markSponsorDirty(false);
  } else {
    markSponsorDirty(state.sponsorDirty);
  }
  if (collapseWorkspace && state.sponsorListExpanded) {
    setSponsorWorkspaceExpanded(false);
  }
  renderSponsorList();
  renderSponsorForm();
  syncSponsorSaveButton();
  els.deleteSponsor.disabled = index < 0;
  return true;
}

function getSessionLabel(item, index) {
  const title = item?.title ? String(item.title) : '(Untitled session)';
  const when = item?.startTime ? formatSessionTimeForList(item.startTime) : '';
  return `${index + 1}. ${title}${when ? ` - ${when}` : ''}`;
}

function getSessionTimingSummary(item) {
  const start = item?.startTime ? formatSessionTimeForList(item.startTime) : '';
  const end = item?.endTime ? formatSessionTimeForList(item.endTime) : '';
  if (start && end) return `${start} to ${end}`;
  return start || end || '';
}

function formatDateHeading(dateKey) {
  const utcNoon = localInputToUtcIso(dateKey + 'T12:00', getEventTimezone());
  if (!utcNoon) return dateKey;
  return new Intl.DateTimeFormat('en', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    timeZone: getEventTimezone()
  }).format(new Date(utcNoon));
}

function scrollToSessionRow(index) {
  els.sessionList.querySelector(`[data-session-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
}

function scrollToSponsorRow(index) {
  els.sponsorList.querySelector(`[data-sponsor-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
}

function renderSessionList() {
  const items = state.dataset?.items || [];
  if (items.length === 0) {
    els.sessionList.innerHTML = '<li class="text-sm text-gray-400 px-3 py-2 border border-dashed border-gray-700 rounded-md">No sessions yet.</li>';
    return;
  }

  const query = String(state.sessionSearchQuery || '').trim().toLowerCase();
  const visibleItems = query
    ? items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => String(item?.title || '').toLowerCase().includes(query))
    : items.map((item, index) => ({ item, index }));

  if (visibleItems.length === 0) {
    els.sessionList.innerHTML = '<li class="text-sm text-gray-400 px-3 py-2 border border-dashed border-gray-700 rounded-md">No sessions match this search.</li>';
    return;
  }

  const groups = new Map();
  for (const entry of visibleItems) {
    const local = utcIsoToLocalInput(entry.item?.startTime, getEventTimezone());
    const dateKey = local ? local.slice(0, 10) : '';
    if (!groups.has(dateKey)) groups.set(dateKey, []);
    groups.get(dateKey).push(entry);
  }

  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b);
  });

  els.sessionList.innerHTML = sortedKeys.map((dateKey) => {
    const label = dateKey ? formatDateHeading(dateKey) : 'Unscheduled';
    const header = `<li class="session-date-header px-2 py-1 text-xs font-semibold text-gray-400 uppercase tracking-wide border-b border-white mt-2 first:mt-0">${escapeHtml(label)}</li>`;
    const rows = groups.get(dateKey).map(({ item: rowItem, index: rowIndex }) => {
      const active = rowIndex === state.selectedIndex ? 'border-blue-400 bg-blue-500/20' : 'border-gray-700 bg-gray-900/30';
      if (isQuickSessionEditEnabled()) {
        const startValue = utcIsoToLocalInput(rowItem?.startTime, getEventTimezone());
        const endValue = utcIsoToLocalInput(rowItem?.endTime, getEventTimezone());
        return `
          <li draggable="true" data-session-index="${rowIndex}" class="session-row session-row-expanded cursor-move px-3 py-3 border rounded-md ${active}">
            <div class="session-row-expanded-grid">
              <div class="session-row-handle text-gray-500">
                <i class="fas fa-grip-vertical"></i>
              </div>
              <div class="min-w-0">
                <label class="session-inline-field">
                  <span class="session-inline-label">Title</span>
                  <input
                    data-inline-session-field="title"
                    data-session-index="${rowIndex}"
                    type="text"
                    value="${escapeAttr(toStringValue(rowItem?.title))}"
                    class="w-full h-10 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"
                  >
                </label>
              </div>
              <div>
                <label class="session-inline-field">
                  <span class="session-inline-label">Start time</span>
                  <input
                    data-inline-session-field="startTime"
                    data-session-index="${rowIndex}"
                    type="datetime-local"
                    value="${escapeAttr(startValue)}"
                    class="w-full h-10 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"
                  >
                </label>
              </div>
              <div>
                <label class="session-inline-field">
                  <span class="session-inline-label">End time</span>
                  <input
                    data-inline-session-field="endTime"
                    data-session-index="${rowIndex}"
                    type="datetime-local"
                    value="${escapeAttr(endValue)}"
                    class="w-full h-10 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"
                  >
                </label>
              </div>
              <div class="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  data-open-session-form="${rowIndex}"
                  class="editor-inline-open h-10 inline-flex items-center justify-center px-3 border border-gray-300 rounded-md text-xs font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors whitespace-nowrap"
                >
                  <i class="fas fa-up-right-from-square mr-1.5 text-[0.72rem]"></i><span>Open</span>
                </button>
                <button type="button" data-duplicate-session="${rowIndex}" title="Duplicate session"
                  class="h-10 inline-flex items-center justify-center px-3 border border-gray-300 rounded-md text-xs font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors whitespace-nowrap">
                  <i class="fas fa-copy mr-1.5 text-[0.72rem]"></i><span>Duplicate</span>
                </button>
                ${state.sessionListExpanded ? `
                <button type="button" data-move-top="${rowIndex}" title="Send to top"
                  class="h-10 inline-flex items-center justify-center px-2 border border-gray-300 rounded-md text-xs font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors">↑↑</button>
                <button type="button" data-move-bottom="${rowIndex}" title="Send to bottom"
                  class="h-10 inline-flex items-center justify-center px-2 border border-gray-300 rounded-md text-xs font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors">↓↓</button>
                <button type="button" data-move-to="${rowIndex}" title="Send to position…"
                  class="h-10 inline-flex items-center justify-center px-2 border border-gray-300 rounded-md text-xs font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors">#</button>
                ` : ''}
              </div>
            </div>
          </li>
        `;
      }
      return `
        <li draggable="true" data-session-index="${rowIndex}" class="session-row cursor-move select-none px-3 py-2 border rounded-md ${active}">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="text-sm font-medium text-gray-100 truncate">${escapeHtml(`${rowIndex + 1}. ${rowItem?.title ? String(rowItem.title) : '(Untitled session)'}`)}</div>
              <div class="text-xs text-gray-400 truncate">${escapeHtml([getSessionTimingSummary(rowItem), rowItem?.location || ''].filter(Boolean).join(' | '))}</div>
            </div>
            <div class="flex items-center gap-0.5 shrink-0">
              <button type="button" data-duplicate-session="${rowIndex}" title="Duplicate session"
                class="text-xs px-1 py-0.5 rounded text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 bg-gray-900/50">
                <i class="fas fa-copy"></i>
              </button>
              ${state.sessionListExpanded ? `
              <button type="button" data-move-top="${rowIndex}" title="Send to top"
                class="text-xs px-1 py-0.5 rounded text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 bg-gray-900/50">↑↑</button>
              <button type="button" data-move-bottom="${rowIndex}" title="Send to bottom"
                class="text-xs px-1 py-0.5 rounded text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 bg-gray-900/50">↓↓</button>
              <button type="button" data-move-to="${rowIndex}" title="Send to position…"
                class="text-xs px-1 py-0.5 rounded text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 bg-gray-900/50">#</button>
              ` : ''}
              <i class="fas fa-grip-vertical text-gray-500 ml-1"></i>
            </div>
          </div>
        </li>
      `;
    }).join('');
    return header + rows;
  }).join('');

  function moveSessionTo(from, to) {
    const items = state.dataset.items;
    const clampedTo = Math.max(0, Math.min(to, items.length - 1));
    if (from === clampedTo) return;
    undoPush();
    const moved = items.splice(from, 1)[0];
    items.splice(clampedTo, 0, moved);
    moveTrackedIndex(state.quickEditSessionChanges, from, clampedTo);
    state.selectedIndex = clampedTo;
    markDirty(true);
    trackQuickSessionChange(clampedTo, true);
    renderSessionList();
    renderSessionForm();
  }

  els.sessionList.querySelectorAll('.session-row').forEach((row) => {
    const index = Number.parseInt(row.dataset.sessionIndex || '-1', 10);

    row.addEventListener('click', async () => {
      if (index === state.selectedIndex) return;
      await selectSessionForm(index, { collapseWorkspace: state.sessionListExpanded, promptLabel: 'another session form' });
    });

    row.addEventListener('dragstart', (event) => {
      state.draggingIndex = index;
      row.classList.add('opacity-50');
      event.dataTransfer.effectAllowed = 'move';
    });

    row.addEventListener('dragend', () => {
      state.draggingIndex = -1;
      row.classList.remove('opacity-50');
      els.sessionList.querySelectorAll('.session-row').forEach((r) => r.classList.remove('ring-2', 'ring-blue-400'));
    });

    row.addEventListener('dragover', (event) => {
      event.preventDefault();
      row.classList.add('ring-2', 'ring-blue-400');
    });

    row.addEventListener('dragleave', () => {
      row.classList.remove('ring-2', 'ring-blue-400');
    });

    row.addEventListener('drop', (event) => {
      event.preventDefault();
      row.classList.remove('ring-2', 'ring-blue-400');
      const from = state.draggingIndex;
      const to = index;
      if (from < 0 || to < 0 || from === to) return;
      undoPush();
      const moved = state.dataset.items.splice(from, 1)[0];
      state.dataset.items.splice(to, 0, moved);
      moveTrackedIndex(state.quickEditSessionChanges, from, to);
      state.selectedIndex = to;
      markDirty(true);
      trackQuickSessionChange(to, true);
      renderSessionList();
      renderSessionForm();
    });

    row.querySelector('[data-move-top]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      moveSessionTo(index, 0);
    });

    row.querySelector('[data-move-bottom]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      moveSessionTo(index, state.dataset.items.length - 1);
    });

    row.querySelector('[data-move-to]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const total = state.dataset.items.length;
      const input = prompt(`Move to position (1–${total}):`, String(index + 1));
      if (input === null) return;
      const n = parseInt(input, 10);
      if (!isNaN(n)) moveSessionTo(index, n - 1);
    });

    row.querySelector('[data-duplicate-session]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      duplicateSession(index);
    });
  });

  const syncExpandedSelectionState = () => {
    els.sessionList.querySelectorAll('.session-row').forEach((row) => {
      const rowIndex = Number.parseInt(row.dataset.sessionIndex || '-1', 10);
      const isActive = rowIndex === state.selectedIndex;
      row.classList.toggle('border-blue-400', isActive);
      row.classList.toggle('bg-blue-500/20', isActive);
      row.classList.toggle('border-gray-700', !isActive);
      row.classList.toggle('bg-gray-900/30', !isActive);
    });
  };

  els.sessionList.querySelectorAll('[data-inline-session-field]').forEach((input) => {
    const rowIndex = Number.parseInt(input.dataset.sessionIndex || '-1', 10);
    const key = input.dataset.inlineSessionField;

    const selectRow = async () => {
      if (rowIndex === state.selectedIndex) return;
      const allowed = await selectSessionForm(rowIndex, { promptLabel: 'another session form' });
      if (!allowed) return false;
      syncExpandedSelectionState();
      return true;
    };

    input.addEventListener('click', (event) => {
      event.stopPropagation();
    });

    input.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    });

    input.addEventListener('focus', async (event) => {
      event.stopPropagation();
      if (isQuickSessionEditEnabled()) {
        undoPush();
        return;
      }
      await selectRow();
    });

    input.addEventListener('input', (event) => {
      event.stopPropagation();
      const item = state.dataset?.items?.[rowIndex];
      if (!item) return;
      const raw = input.value;

      if (key === 'startTime' || key === 'endTime') {
        item[key] = localInputToUtcIso(raw, getEventTimezone());
      } else {
        item[key] = raw;
      }

      markDirty(true);
      trackQuickSessionChange(rowIndex);

      if (rowIndex === state.selectedIndex) {
        renderSessionForm();
      }
    });

    input.addEventListener('change', (event) => {
      event.stopPropagation();
      if (key === 'startTime' || key === 'endTime') {
        renderSessionList();
      }
    });
  });

  els.sessionList.querySelectorAll('[data-open-session-form]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const rowIndex = Number.parseInt(button.dataset.openSessionForm || '-1', 10);
      if (rowIndex < 0) return;
      await selectSessionForm(rowIndex, { collapseWorkspace: true, promptLabel: 'the full session form' });
    });
  });
}

function renderSessionField(field, item) {
  const spanClass = field.span === 2 ? 'md:col-span-2' : '';
  const describedBy = fieldDescriptionAttr('session', field.key, field);

  if (field.key === 'sponsorIds') {
    const linkedIds = parseMultiValue(item[field.key] || '');
    const sponsors = state.dataset?.event?.sponsors || [];
    const linkedSponsors = linkedIds.map((id) => sponsors.find((s) => s.id === id)).filter(Boolean);
    const linkedHtml = linkedSponsors.length
      ? `<div class="space-y-2">${linkedSponsors.map((sponsor) => `
          <div class="editor-linked-item">
            <div class="editor-linked-item-copy">
              <div class="editor-linked-item-title">${escapeHtml(sponsor.title || sponsor.id)}</div>
              <div class="editor-linked-item-meta">${escapeHtml(sponsor.id)}</div>
            </div>
            <button type="button" class="editor-linked-item-action" data-remove-session-sponsor="${escapeAttr(sponsor.id)}" aria-label="Remove ${escapeAttr(sponsor.title || sponsor.id)}">
              <i class="fas fa-trash"></i><span>Remove</span>
            </button>
          </div>
        `).join('')}</div>`
      : '<p class="speaker-session-summary">No sponsors linked to this session yet.</p>';
    return `
      <div class="${spanClass}">
        <div class="rounded-md border border-gray-700 bg-gray-900/30 px-3 py-3 text-sm text-gray-200 space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs text-gray-400">${linkedSponsors.length ? `${linkedSponsors.length} linked sponsor${linkedSponsors.length === 1 ? '' : 's'}` : 'No sponsors linked yet.'}</span>
            <button id="addLinkedSessionSponsor" type="button" class="h-9 inline-flex items-center justify-center px-3 border border-gray-300 rounded-md text-xs font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors whitespace-nowrap">
              <i class="fas fa-plus mr-1.5 text-[0.72rem]"></i>Add sponsor
            </button>
          </div>
          ${linkedHtml}
        </div>
        ${field.description ? `<span id="${escapeAttr(fieldDescriptionId('session', field.key))}" class="editor-field-description">${escapeHtml(field.description)}</span>` : ''}
      </div>
    `;
  }

  if (field.type === 'textarea') {
    const value = toStringValue(item[field.key]);
    const markdownPreview =
      field.key === 'full_description'
        ? `<div class="mt-2 p-3 rounded-md border border-gray-700 bg-gray-900/30">
            <div class="text-xs font-semibold text-gray-400 mb-2">Markdown Preview</div>
            <div data-md-preview="full_description" class="session-description-preview text-sm text-gray-200">${markdownToHtml(value)}</div>
          </div>`
        : '';
    return `
      <label class="editor-form-field ${spanClass}">
        ${renderFieldIntro('session', field.key, field)}
          <textarea data-session-field="${field.key}" rows="${field.key.includes('description') ? 7 : 3}" class="w-full rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3 py-2"${describedBy}>${escapeHtml(
          value
        )}</textarea>
        ${markdownPreview}
      </label>
    `;
  }

  if (field.type === 'datetime-local') {
    const localValue = utcIsoToLocalInput(item[field.key], getEventTimezone());
    const tzHint = field.key === 'startTime'
      ? `<span class="editor-tz-note"><i class="fas fa-clock mr-1"></i>Times are shown in <strong>${escapeHtml(getEventTimezone())}</strong></span>`
      : '';
    return `
      <label class="editor-form-field ${spanClass}">
        ${renderFieldIntro('session', field.key, field)}
        <input data-session-field="${field.key}" type="datetime-local" value="${escapeAttr(localValue)}" class="w-full h-11 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"${describedBy}>
        ${tzHint}
      </label>
    `;
  }

  const value = field.key === 'duration' ? durationToEditorValue(syncSessionDuration(item)) : toStringValue(item[field.key]);
  if (field.key === 'duration') {
    return `
      <label class="editor-form-field ${spanClass}">
        ${renderFieldIntro('session', field.key, field)}
        <input data-session-derived-field="${field.key}" type="text" value="${escapeAttr(value)}" class="w-full h-11 rounded-md border-gray-300 shadow-sm text-sm bg-gray-100 text-gray-600 px-3 cursor-not-allowed" readonly tabindex="-1"${describedBy}>
      </label>
    `;
  }
  if (field.key === 'location') {
    const rooms = [...new Set(
      (state.dataset?.items || [])
        .map((s) => String(s.location || '').trim())
        .filter(Boolean)
    )].sort();
    const datalistHtml = rooms.length
      ? `<datalist id="roomSuggestions">${rooms.map((r) => `<option value="${escapeAttr(r)}">`).join('')}</datalist>`
      : '';
    return `
      <label class="editor-form-field ${spanClass}">
        ${renderFieldIntro('session', field.key, field)}
        <input data-session-field="${field.key}" type="text" value="${escapeAttr(value)}"${rooms.length ? ' list="roomSuggestions"' : ''} class="w-full h-11 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"${describedBy}>
        ${datalistHtml}
      </label>
    `;
  }

  return `
    <label class="editor-form-field ${spanClass}">
      ${renderFieldIntro('session', field.key, field)}
      <input data-session-field="${field.key}" type="text" value="${escapeAttr(value)}" class="w-full h-11 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"${describedBy}>
    </label>
  `;
}

function renderSessionForm() {
  const item = state.dataset?.items?.[state.selectedIndex] || null;
  syncSessionEditorPanelVisibility();
  if (!item) {
    els.sessionIndexBadge.textContent = 'No session selected';
    els.sessionForm.innerHTML = '<p class="text-sm text-gray-400">Select a session on the left to edit it.</p>';
    markSessionDirty(false);
    syncSessionSaveButton();
    return;
  }

  if (isQuickSessionEditEnabled()) {
    els.sessionIndexBadge.textContent = `Session ${state.selectedIndex + 1} of ${state.dataset.items.length}`;
    els.sessionForm.innerHTML = `
      <div class="editor-quick-open-state md:col-span-2">
        <div class="editor-quick-open-card">
          <div class="text-sm font-semibold text-gray-100 mb-2">${escapeHtml(item?.title || '(Untitled session)')}</div>
          <p class="text-sm text-gray-400 mb-4">This row is selected in quick edit. Open it to switch back to the full form.</p>
          <button type="button" id="openSelectedSessionForm" class="h-10 inline-flex items-center justify-center px-4 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors whitespace-nowrap">
            <i class="fas fa-up-right-from-square mr-2 text-[0.72rem]"></i>Open session
          </button>
        </div>
      </div>
    `;
    const openButton = document.getElementById('openSelectedSessionForm');
    if (openButton) {
      openButton.addEventListener('click', async () => {
        await selectSessionForm(state.selectedIndex, { collapseWorkspace: true, promptLabel: 'the full session form' });
      });
    }
    markSessionDirty(state.sessionDirty);
    syncSessionSaveButton();
    return;
  }

  els.sessionIndexBadge.textContent = `Session ${state.selectedIndex + 1} of ${state.dataset.items.length}`;
  syncSessionSaveButton();
  els.sessionForm.innerHTML = SESSION_FIELDS.map((field) => renderSessionField(field, item)).join('');

  els.sessionForm.querySelectorAll('[data-session-field]').forEach((input) => {
    input.addEventListener('focus', undoPush);
    input.addEventListener('input', () => {
      const key = input.dataset.sessionField;
      const raw = input.value;

      if (key === 'track' || key === 'speaker_usernames' || key === 'speakers') {
        const values = parseMultiValue(raw);
        item[key] = values.length <= 1 ? (values[0] || '') : values;
      } else if (key === 'startTime' || key === 'endTime') {
        const utcIso = localInputToUtcIso(raw, getEventTimezone());
        item[key] = utcIso;
        syncSessionDuration(item);
        const durationField = els.sessionForm.querySelector('[data-session-derived-field="duration"]');
        if (durationField) durationField.value = durationToEditorValue(item.duration);
      } else {
        item[key] = raw;
        if (key === 'full_description') {
          const markdownPreview = els.sessionForm.querySelector('[data-md-preview="full_description"]');
          if (markdownPreview) markdownPreview.innerHTML = markdownToHtml(raw);
        }
      }

      markDirty(true);
      markSessionDirty(true);
      trackQuickSessionChange(state.selectedIndex);
      renderSessionList();
    });
  });

  const addLinkedSponsorButton = els.sessionForm.querySelector('#addLinkedSessionSponsor');
  if (addLinkedSponsorButton) {
    addLinkedSponsorButton.addEventListener('click', () => openSessionSponsorPicker());
  }

  els.sessionForm.querySelectorAll('[data-remove-session-sponsor]').forEach((button) => {
    button.addEventListener('click', () => {
      removeSponsorFromSession(button.dataset.removeSessionSponsor);
    });
  });
}

async function addSession() {
  if (!state.dataset) return;
  undoPush();
  const seed = state.dataset.items[state.selectedIndex] || {};
  const newItem = {
    title: 'New session',
    startTime: seed.startTime || '',
    endTime: seed.endTime || '',
    location: seed.location || '',
    duration: '',
    track: seed.track || '',
    speakers: '',
    speaker_usernames: '',
    full_description: '',
    sponsorIds: '',
    link: '',
    video_url: ''
  };
  syncSessionDuration(newItem);

  const insertAt = state.selectedIndex >= 0 ? state.selectedIndex + 1 : state.dataset.items.length;
  state.dataset.items.splice(insertAt, 0, newItem);
  state.selectedIndex = insertAt;
  markDirty(true);
  trackQuickSessionChange(state.selectedIndex, true);
  renderSessionList();
  scrollToSessionRow(state.selectedIndex);
  renderSessionForm();
  renderSponsorForm();
  syncSessionSaveButton();
  els.deleteSession.disabled = false;
  await saveDataset();
}

function getSponsorListLabel(sponsor, index) {
  const title = String(sponsor?.title || '').trim() || '(Untitled sponsor)';
  const row = Number.isFinite(Number(sponsor?.row)) ? `Row ${Number(sponsor.row)}` : '';
  const tier = String(sponsor?.tier || '').trim();
  return `${index + 1}. ${title}${tier || row ? ` - ${[tier, row].filter(Boolean).join(' / ')}` : ''}`;
}

function renderSponsorList() {
  const sponsors = state.dataset?.event?.sponsors || [];
  if (!sponsors.length) {
    els.sponsorList.innerHTML = '<li class="text-sm text-gray-400 px-3 py-2 border border-dashed border-gray-700 rounded-md">No sponsors yet.</li>';
    return;
  }

  els.sponsorList.innerHTML = sponsors
    .map((sponsor, index) => {
      const active = index === state.selectedSponsorIndex ? 'border-blue-400 bg-blue-500/20' : 'border-gray-700 bg-gray-900/30';
      if (isQuickSponsorEditEnabled()) {
        return `
          <li draggable="true" data-sponsor-index="${index}" class="sponsor-row session-row-expanded cursor-move px-3 py-3 border rounded-md ${active}">
            <div class="sponsor-row-grid">
              <div class="session-row-handle text-gray-500">
                <i class="fas fa-grip-vertical"></i>
              </div>
              <div class="min-w-0">
                <label class="session-inline-field">
                  <span class="session-inline-label">Title</span>
                  <input
                    data-inline-sponsor-field="title"
                    data-sponsor-index="${index}"
                    type="text"
                    value="${escapeAttr(toStringValue(sponsor?.title))}"
                    class="w-full h-10 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"
                  >
                </label>
              </div>
              <div>
                <label class="session-inline-field">
                  <span class="session-inline-label">Tier</span>
                  <input
                    data-inline-sponsor-field="tier"
                    data-sponsor-index="${index}"
                    type="text"
                    value="${escapeAttr(toStringValue(sponsor?.tier))}"
                    class="w-full h-10 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"
                  >
                </label>
              </div>
              <div>
                <label class="session-inline-field">
                  <span class="session-inline-label">Row</span>
                  <input
                    data-inline-sponsor-field="row"
                    data-sponsor-index="${index}"
                    type="number"
                    min="1"
                    step="1"
                    value="${escapeAttr(toStringValue(sponsor?.row))}"
                    class="w-full h-10 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"
                  >
                </label>
              </div>
              <div>
                <label class="session-inline-field">
                  <span class="session-inline-label">Priority</span>
                  <input
                    data-inline-sponsor-field="priority"
                    data-sponsor-index="${index}"
                    type="number"
                    value="${escapeAttr(toStringValue(sponsor?.priority))}"
                    class="w-full h-10 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"
                  >
                </label>
              </div>
              <button
                type="button"
                data-open-sponsor-form="${index}"
                class="editor-inline-open h-10 inline-flex items-center justify-center px-3 border border-gray-300 rounded-md text-xs font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors whitespace-nowrap"
              >
                <i class="fas fa-up-right-from-square mr-1.5 text-[0.72rem]"></i><span>Open</span>
              </button>
            </div>
          </li>
        `;
      }
      return `
        <li draggable="true" data-sponsor-index="${index}" class="sponsor-row cursor-move select-none px-3 py-2 border rounded-md ${active}">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="text-sm font-medium text-gray-100 truncate">${escapeHtml(getSponsorListLabel(sponsor, index))}</div>
              <div class="text-xs text-gray-400 truncate">${escapeHtml([sponsor?.id || '', sponsor?.link || ''].filter(Boolean).join(' | '))}</div>
            </div>
            <i class="fas fa-grip-vertical text-gray-500 mt-1"></i>
          </div>
        </li>
      `;
    })
    .join('');

  els.sponsorList.querySelectorAll('.sponsor-row').forEach((row) => {
    const index = Number.parseInt(row.dataset.sponsorIndex || '-1', 10);

    row.addEventListener('click', async () => {
      if (index === state.selectedSponsorIndex) return;
      await selectSponsorForm(index, { collapseWorkspace: state.sponsorListExpanded, promptLabel: 'another sponsor form' });
    });

    row.addEventListener('dragstart', (event) => {
      state.draggingSponsorIndex = index;
      row.classList.add('opacity-50');
      event.dataTransfer.effectAllowed = 'move';
    });

    row.addEventListener('dragend', () => {
      state.draggingSponsorIndex = -1;
      row.classList.remove('opacity-50');
      els.sponsorList.querySelectorAll('.sponsor-row').forEach((r) => r.classList.remove('ring-2', 'ring-blue-400'));
    });

    row.addEventListener('dragover', (event) => {
      event.preventDefault();
      row.classList.add('ring-2', 'ring-blue-400');
    });

    row.addEventListener('dragleave', () => {
      row.classList.remove('ring-2', 'ring-blue-400');
    });

    row.addEventListener('drop', (event) => {
      event.preventDefault();
      row.classList.remove('ring-2', 'ring-blue-400');
      const from = state.draggingSponsorIndex;
      const to = index;
      if (from < 0 || to < 0 || from === to) return;

      const moved = state.dataset.event.sponsors.splice(from, 1)[0];
      state.dataset.event.sponsors.splice(to, 0, moved);
      moveTrackedIndex(state.quickEditSponsorChanges, from, to);
      state.selectedSponsorIndex = to;
      markDirty(true);
      trackQuickSponsorChange(to, true);
      renderSponsorList();
      renderSponsorForm();
    });
  });

  const syncSponsorSelectionState = () => {
    els.sponsorList.querySelectorAll('.sponsor-row').forEach((row) => {
      const rowIndex = Number.parseInt(row.dataset.sponsorIndex || '-1', 10);
      const isActive = rowIndex === state.selectedSponsorIndex;
      row.classList.toggle('border-blue-400', isActive);
      row.classList.toggle('bg-blue-500/20', isActive);
      row.classList.toggle('border-gray-700', !isActive);
      row.classList.toggle('bg-gray-900/30', !isActive);
    });
  };

  els.sponsorList.querySelectorAll('[data-inline-sponsor-field]').forEach((input) => {
    const rowIndex = Number.parseInt(input.dataset.sponsorIndex || '-1', 10);
    const key = input.dataset.inlineSponsorField;

    const selectRow = async () => {
      if (rowIndex === state.selectedSponsorIndex) return;
      const allowed = await selectSponsorForm(rowIndex, { promptLabel: 'another sponsor form' });
      if (!allowed) return false;
      syncSponsorSelectionState();
      return true;
    };

    input.addEventListener('click', (event) => {
      event.stopPropagation();
    });

    input.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    });

    input.addEventListener('focus', async (event) => {
      event.stopPropagation();
      if (isQuickSponsorEditEnabled()) return;
      await selectRow();
    });

    input.addEventListener('input', (event) => {
      event.stopPropagation();
      const sponsor = state.dataset?.event?.sponsors?.[rowIndex];
      if (!sponsor) return;
      if (key === 'priority') {
        sponsor[key] = Number.parseInt(input.value || '100', 10) || 100;
      } else if (key === 'row') {
        sponsor[key] = Number.parseInt(input.value || '1', 10) || 1;
      } else {
        sponsor[key] = input.value;
      }
      if (key === 'title' && !String(sponsor.id || '').trim()) {
        sponsor.id = normalizeSponsorId(input.value);
      }
      markDirty(true);
      trackQuickSponsorChange(rowIndex);
      if (rowIndex === state.selectedSponsorIndex) {
        renderSponsorForm();
      }
    });
  });

  els.sponsorList.querySelectorAll('[data-open-sponsor-form]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const rowIndex = Number.parseInt(button.dataset.openSponsorForm || '-1', 10);
      if (rowIndex < 0) return;
      await selectSponsorForm(rowIndex, { collapseWorkspace: true, promptLabel: 'the full sponsor form' });
    });
  });
}

function renderSponsorField(field, sponsor) {
  const spanClass = field.span === 2 ? 'md:col-span-2' : field.span === 3 ? 'md:col-span-2 xl:col-span-3' : '';
  const describedBy = fieldDescriptionAttr('sponsor', field.key, field);

  if (field.type === 'checkbox') {
    return `
      <label class="editor-form-field ${spanClass}">
        ${renderFieldIntro('sponsor', field.key, field)}
        <span class="h-11 inline-flex items-center gap-3 rounded-md border border-gray-300 px-3 bg-white">
          <input data-sponsor-field="${field.key}" type="checkbox" class="h-4 w-4" ${sponsor[field.key] ? 'checked' : ''}${describedBy}>
          <span class="text-sm text-gray-200">Enabled</span>
        </span>
      </label>
    `;
  }

  if (field.type === 'select') {
    const options = field.options
      .map((option) => `<option value="${escapeAttr(option)}" ${sponsor[field.key] === option ? 'selected' : ''}>${escapeHtml(option)}</option>`)
      .join('');
    return `
      <label class="editor-form-field ${spanClass}">
        ${renderFieldIntro('sponsor', field.key, field)}
        <select data-sponsor-field="${field.key}" class="w-full h-11 pr-10 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"${describedBy}>${options}</select>
      </label>
    `;
  }

  const type = field.type === 'number' ? 'number' : 'text';
  const numericAttrs = field.type === 'number'
    ? `${field.key === 'row' ? ' min="1" step="1"' : ''}`
    : '';
  return `
    <label class="editor-form-field ${spanClass}">
      ${renderFieldIntro('sponsor', field.key, field)}
      <input data-sponsor-field="${field.key}" type="${type}"${numericAttrs} value="${escapeAttr(toStringValue(sponsor[field.key]))}" class="w-full h-11 rounded-md border-gray-300 shadow-sm drupal-blue-focus text-sm bg-white px-3"${describedBy}>
    </label>
  `;
}

function renderSponsorForm() {
  const sponsor = state.dataset?.event?.sponsors?.[state.selectedSponsorIndex] || null;
  syncSponsorEditorPanelVisibility();
  if (!sponsor) {
    els.sponsorIndexBadge.textContent = 'No sponsor selected';
    els.sponsorForm.innerHTML = '<p class="text-sm text-gray-400">Select a sponsor row to edit it.</p>';
    markSponsorDirty(false);
    syncSponsorSaveButton();
    els.deleteSponsor.disabled = true;
    return;
  }

  if (isQuickSponsorEditEnabled()) {
    els.sponsorIndexBadge.textContent = `Sponsor ${state.selectedSponsorIndex + 1} of ${state.dataset.event.sponsors.length}`;
    els.sponsorForm.innerHTML = `
      <div class="editor-quick-open-state md:col-span-2 xl:col-span-3">
        <div class="editor-quick-open-card">
          <div class="text-sm font-semibold text-gray-100 mb-2">${escapeHtml(getSponsorListLabel(sponsor, state.selectedSponsorIndex))}</div>
          <p class="text-sm text-gray-400 mb-4">This row is selected in quick edit. Open it to switch back to the full sponsor form.</p>
          <button type="button" id="openSelectedSponsorForm" class="h-10 inline-flex items-center justify-center px-4 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors whitespace-nowrap">
            <i class="fas fa-up-right-from-square mr-2 text-[0.72rem]"></i>Open sponsor
          </button>
        </div>
      </div>
    `;
    const openButton = document.getElementById('openSelectedSponsorForm');
    if (openButton) {
      openButton.addEventListener('click', async () => {
        await selectSponsorForm(state.selectedSponsorIndex, { collapseWorkspace: true, promptLabel: 'the full sponsor form' });
      });
    }
    markSponsorDirty(state.sponsorDirty);
    syncSponsorSaveButton();
    return;
  }

  const linkedSessions = (state.dataset?.items || [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => parseMultiValue(item?.sponsorIds || '').includes(sponsor.id));

  els.sponsorIndexBadge.textContent = `Sponsor ${state.selectedSponsorIndex + 1} of ${state.dataset.event.sponsors.length}`;
  syncSponsorSaveButton();
  els.deleteSponsor.disabled = false;
  els.sponsorForm.innerHTML = `
    ${SPONSOR_FIELDS.map((field) => renderSponsorField(field, sponsor)).join('')}
    <div class="editor-form-field md:col-span-2 xl:col-span-3">
      <span class="editor-field-label">Sponsor image upload</span>
      <span class="editor-field-description">Uploads to <code>img/sponsors/${escapeHtml(
        slugify(state.dataset?.event?.designation || 'event') || 'event'
      )}</code> and stores a relative path.</span>
      <div class="flex flex-wrap items-center gap-2">
        <button id="sponsorImageUpload" type="button" class="h-11 inline-flex items-center justify-center pl-5 pr-4 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors whitespace-nowrap">
          <i class="fas fa-upload mr-2"></i>Upload Sponsor Image
        </button>
        <span class="text-xs text-gray-400">${escapeHtml(getSponsorListLabel(sponsor, state.selectedSponsorIndex))}</span>
      </div>
    </div>
    <div class="editor-form-field md:col-span-2 xl:col-span-3">
      <span class="editor-field-label">Linked sessions</span>
      <span class="editor-field-description">Manage sessions currently referencing <code>${escapeHtml(sponsor.id || '(missing id)')}</code>.</span>
      <div class="rounded-md border border-gray-700 bg-gray-900/30 px-3 py-3 text-sm text-gray-200 space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs text-gray-400">${linkedSessions.length ? `${linkedSessions.length} linked session${linkedSessions.length === 1 ? '' : 's'}` : 'No sessions linked yet.'}</span>
          <button id="addLinkedSponsorSession" type="button" class="h-9 inline-flex items-center justify-center px-3 border border-gray-300 rounded-md text-xs font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors whitespace-nowrap">
            <i class="fas fa-plus mr-1.5 text-[0.72rem]"></i>Add session
          </button>
        </div>
        <div class="space-y-2">
          ${
            linkedSessions.length
              ? linkedSessions
                .map(({ item, index }) => `
                  <div class="editor-linked-item">
                    <div class="editor-linked-item-copy">
                      <div class="editor-linked-item-title">${escapeHtml(item?.title || '(Untitled session)')}</div>
                      <div class="editor-linked-item-meta">${escapeHtml(formatSponsorLinkedSessionMeta(item, index))}</div>
                    </div>
                    <button type="button" class="editor-linked-item-action" data-remove-linked-session="${index}" aria-label="Remove linked session ${escapeAttr(item?.title || '(Untitled session)')}">
                      <i class="fas fa-trash"></i><span>Remove</span>
                    </button>
                  </div>
                `)
                .join('')
              : '<div class="text-sm text-gray-400">No sessions linked yet.</div>'
          }
        </div>
      </div>
    </div>
  `;

  els.sponsorForm.querySelectorAll('[data-sponsor-field]').forEach((input) => {
    input.addEventListener('input', () => {
      const key = input.dataset.sponsorField;
      if (key === 'enabled') {
        sponsor[key] = Boolean(input.checked);
      } else if (key === 'priority') {
        sponsor[key] = Number.parseInt(input.value || '100', 10) || 100;
      } else if (key === 'row') {
        sponsor[key] = Number.parseInt(input.value || '1', 10) || 1;
      } else if (key === 'id') {
        const previousId = sponsor.id;
        sponsor.id = normalizeSponsorId(input.value, sponsor.title);
        if (previousId && previousId !== sponsor.id) {
          (state.dataset?.items || []).forEach((item) => {
            const ids = parseMultiValue(item?.sponsorIds || '');
            if (!ids.includes(previousId)) return;
            const nextIds = ids.map((id) => (id === previousId ? sponsor.id : id)).filter(Boolean);
            item.sponsorIds = nextIds.length <= 1 ? (nextIds[0] || '') : nextIds;
          });
          renderSessionForm();
        }
      } else if (key === 'title') {
        sponsor[key] = input.value;
      } else {
        sponsor[key] = input.value;
      }
      markDirty(true);
      markSponsorDirty(true);
      trackQuickSponsorChange(state.selectedSponsorIndex);
      renderSponsorList();
    });
    input.addEventListener('change', () => {
      const key = input.dataset.sponsorField;
      if (key === 'enabled') {
        sponsor[key] = Boolean(input.checked);
        markDirty(true);
        markSponsorDirty(true);
        trackQuickSponsorChange(state.selectedSponsorIndex);
        renderSponsorList();
      }
    });
  });

  const uploadButton = els.sponsorForm.querySelector('#sponsorImageUpload');
  if (uploadButton) {
    uploadButton.addEventListener('click', async () => {
      try {
        await uploadSponsorImageFromPicker(state.selectedSponsorIndex);
      } catch (error) {
        window.alert(`Sponsor image upload failed: ${error.message}`);
      }
    });
  }

  const addLinkedSessionButton = els.sponsorForm.querySelector('#addLinkedSponsorSession');
  if (addLinkedSessionButton) {
    addLinkedSessionButton.addEventListener('click', () => {
      openSponsorSessionPicker();
    });
  }

  els.sponsorForm.querySelectorAll('[data-remove-linked-session]').forEach((button) => {
    button.addEventListener('click', () => {
      const itemIndex = Number.parseInt(button.dataset.removeLinkedSession || '-1', 10);
      removeLinkedSessionFromSponsor(itemIndex);
    });
  });
}

function formatSponsorLinkedSessionMeta(item, index) {
  const bits = [];
  if (item?.startTime) {
    bits.push(utcIsoToLocalInput(item.startTime, getEventTimezone()));
  }
  if (item?.location) {
    bits.push(String(item.location));
  }
  bits.push(`Session ${index + 1}`);
  return bits.filter(Boolean).join(' | ');
}

function getSelectedSponsor() {
  return state.dataset?.event?.sponsors?.[state.selectedSponsorIndex] || null;
}

function getAvailableSessionsForSponsor(sponsor) {
  if (!sponsor) return [];
  return (state.dataset?.items || [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !parseMultiValue(item?.sponsorIds || '').includes(sponsor.id));
}

function closeSponsorSessionPicker() {
  if (!els.sponsorSessionPickerModal) return;
  state.sponsorSessionPickerOpen = false;
  els.sponsorSessionPickerModal.classList.add('hidden');
  els.sponsorSessionPickerModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('session-modal-open');
}

function openSponsorSessionPicker() {
  const sponsor = getSelectedSponsor();
  if (!sponsor || !els.sponsorSessionPickerModal || !els.sponsorSessionPickerList) return;

  const availableSessions = getAvailableSessionsForSponsor(sponsor);
  state.sponsorSessionPickerOpen = true;
  els.sponsorSessionPickerModal.classList.remove('hidden');
  els.sponsorSessionPickerModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('session-modal-open');
  const titleEl = document.getElementById('sponsorSessionPickerTitle');
  if (titleEl) {
    titleEl.textContent = `Add session to ${sponsor.title || 'sponsor'}`;
  }
  if (els.sponsorSessionPickerCount) {
    els.sponsorSessionPickerCount.textContent = `${availableSessions.length} available`;
  }
  els.sponsorSessionPickerList.innerHTML = availableSessions.length
    ? availableSessions
      .map(({ item, index }) => `
        <article class="speaker-session-card">
          <div>
            <h3 class="speaker-session-title">${escapeHtml(item?.title || '(Untitled session)')}</h3>
            <p class="speaker-session-meta">${escapeHtml(formatSponsorLinkedSessionMeta(item, index))}</p>
          </div>
          <div class="session-modal-links">
            <button type="button" class="session-modal-link" data-add-linked-session="${index}">
              <i class="fas fa-plus"></i><span>Add session</span>
            </button>
          </div>
        </article>
      `)
      .join('')
    : '<p class="speaker-session-summary">All sessions in this event are already linked to this sponsor.</p>';

  els.sponsorSessionPickerList.querySelectorAll('[data-add-linked-session]').forEach((button) => {
    button.addEventListener('click', () => {
      const itemIndex = Number.parseInt(button.dataset.addLinkedSession || '-1', 10);
      addLinkedSessionToSponsor(itemIndex);
    });
  });
}

function addLinkedSessionToSponsor(itemIndex) {
  const sponsor = getSelectedSponsor();
  const item = state.dataset?.items?.[itemIndex];
  if (!sponsor || !item) return;
  const ids = parseMultiValue(item?.sponsorIds || '');
  if (!ids.includes(sponsor.id)) {
    const nextIds = [...ids, sponsor.id].filter(Boolean);
    item.sponsorIds = nextIds.length <= 1 ? (nextIds[0] || '') : nextIds;
    markDirty(true);
    markSessionDirty(true);
    markSponsorDirty(true);
    trackQuickSessionChange(itemIndex);
    trackQuickSponsorChange(state.selectedSponsorIndex);
  }
  closeSponsorSessionPicker();
  renderSponsorForm();
  renderSessionForm();
}

function removeLinkedSessionFromSponsor(itemIndex) {
  const sponsor = getSelectedSponsor();
  const item = state.dataset?.items?.[itemIndex];
  if (!sponsor || !item) return;
  const ids = parseMultiValue(item?.sponsorIds || '').filter((id) => id !== sponsor.id);
  item.sponsorIds = ids.length <= 1 ? (ids[0] || '') : ids;
  markDirty(true);
  markSessionDirty(true);
  markSponsorDirty(true);
  trackQuickSessionChange(itemIndex);
  trackQuickSponsorChange(state.selectedSponsorIndex);
  renderSponsorForm();
  renderSessionForm();
}

function getAvailableSponsorsForSession(item) {
  const linkedIds = parseMultiValue(item?.sponsorIds || '');
  return (state.dataset?.event?.sponsors || [])
    .map((sponsor, index) => ({ sponsor, index }))
    .filter(({ sponsor }) => sponsor.id && !linkedIds.includes(sponsor.id));
}

function openSessionSponsorPicker() {
  const item = state.dataset?.items?.[state.selectedIndex];
  if (!item || !els.sessionSponsorPickerModal || !els.sessionSponsorPickerList) return;
  const availableSponsors = getAvailableSponsorsForSession(item);
  state.sessionSponsorPickerOpen = true;
  els.sessionSponsorPickerModal.classList.remove('hidden');
  els.sessionSponsorPickerModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('session-modal-open');
  if (els.sessionSponsorPickerCount) {
    els.sessionSponsorPickerCount.textContent = `${availableSponsors.length} available`;
  }
  els.sessionSponsorPickerList.innerHTML = availableSponsors.length
    ? availableSponsors.map(({ sponsor, index }) => `
        <article class="speaker-session-card">
          <div>
            <h3 class="speaker-session-title">${escapeHtml(sponsor.title || sponsor.id || '(Untitled sponsor)')}</h3>
            <p class="speaker-session-meta">${escapeHtml(sponsor.id || '')}</p>
          </div>
          <div class="session-modal-links">
            <button type="button" class="session-modal-link" data-add-session-sponsor="${index}">
              <i class="fas fa-plus"></i><span>Add sponsor</span>
            </button>
          </div>
        </article>
      `).join('')
    : '<p class="speaker-session-summary">All sponsors are already linked to this session.</p>';
  els.sessionSponsorPickerList.querySelectorAll('[data-add-session-sponsor]').forEach((button) => {
    button.addEventListener('click', () => {
      addSponsorToSession(Number.parseInt(button.dataset.addSessionSponsor || '-1', 10));
    });
  });
}

function closeSessionSponsorPicker() {
  if (!els.sessionSponsorPickerModal) return;
  state.sessionSponsorPickerOpen = false;
  els.sessionSponsorPickerModal.classList.add('hidden');
  els.sessionSponsorPickerModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('session-modal-open');
}

function addSponsorToSession(sponsorIndex) {
  const item = state.dataset?.items?.[state.selectedIndex];
  const sponsor = state.dataset?.event?.sponsors?.[sponsorIndex];
  if (!item || !sponsor?.id) return;
  const ids = parseMultiValue(item?.sponsorIds || '');
  if (!ids.includes(sponsor.id)) {
    undoPush();
    const nextIds = [...ids, sponsor.id].filter(Boolean);
    item.sponsorIds = nextIds.length <= 1 ? (nextIds[0] || '') : nextIds;
    markDirty(true);
    markSessionDirty(true);
    markSponsorDirty(true);
    trackQuickSessionChange(state.selectedIndex);
    trackQuickSponsorChange(state.selectedSponsorIndex);
  }
  closeSessionSponsorPicker();
  renderSessionForm();
  renderSponsorForm();
}

function removeSponsorFromSession(sponsorId) {
  const item = state.dataset?.items?.[state.selectedIndex];
  if (!item || !sponsorId) return;
  undoPush();
  const ids = parseMultiValue(item?.sponsorIds || '');
  const nextIds = ids.filter((id) => id !== sponsorId);
  item.sponsorIds = nextIds.length <= 1 ? (nextIds[0] || '') : nextIds;
  markDirty(true);
  markSessionDirty(true);
  markSponsorDirty(true);
  trackQuickSessionChange(state.selectedIndex);
  renderSessionForm();
  renderSponsorForm();
}

async function addSponsor() {
  if (!state.dataset) return;
  undoPush();
  const sponsors = state.dataset.event.sponsors || (state.dataset.event.sponsors = []);
  const seed = sponsors[state.selectedSponsorIndex] || {};
  const nextNumber = sponsors.length + 1;
  const sponsor = normalizeSponsorObject({
    title: `Sponsor ${nextNumber}`,
    tier: seed.tier || '',
    row: seed.row ?? 1,
    priority: nextNumber * 10,
    bgStyle: 'auto',
    aspect: 'auto',
    enabled: true
  });
  if (!sponsor.id) sponsor.id = `sponsor-${nextNumber}`;
  const insertAt = state.selectedSponsorIndex >= 0 ? state.selectedSponsorIndex + 1 : sponsors.length;
  sponsors.splice(insertAt, 0, sponsor);
  state.selectedSponsorIndex = insertAt;
  markDirty(true);
  trackQuickSponsorChange(state.selectedSponsorIndex, true);
  renderSponsorList();
  scrollToSponsorRow(state.selectedSponsorIndex);
  renderSponsorForm();
  renderSessionForm();
  syncSponsorSaveButton();
  els.deleteSponsor.disabled = false;
  await saveDataset();
}

async function deleteSponsor() {
  const sponsors = state.dataset?.event?.sponsors || [];
  if (state.selectedSponsorIndex < 0 || state.selectedSponsorIndex >= sponsors.length) return;
  const sponsor = sponsors[state.selectedSponsorIndex];
  const okay = window.confirm(`Delete sponsor "${sponsor?.title || 'Untitled'}"?`);
  if (!okay) return;
  undoPush();
  const [removed] = sponsors.splice(state.selectedSponsorIndex, 1);
  removeTrackedIndex(state.quickEditSponsorChanges, state.selectedSponsorIndex);
  if (removed?.id) {
    (state.dataset?.items || []).forEach((item) => {
      const ids = parseMultiValue(item?.sponsorIds || '').filter((id) => id !== removed.id);
      item.sponsorIds = ids.length <= 1 ? (ids[0] || '') : ids;
    });
  }
  if (sponsors.length === 0) {
    state.selectedSponsorIndex = -1;
  } else if (state.selectedSponsorIndex >= sponsors.length) {
    state.selectedSponsorIndex = sponsors.length - 1;
  }
  markDirty(true);
  trackQuickSponsorChange(state.selectedSponsorIndex, true);
  trackQuickSessionChange(-1, true);
  renderSponsorList();
  scrollToSponsorRow(state.selectedSponsorIndex);
  renderSponsorForm();
  renderSessionForm();
  syncSponsorSaveButton();
  els.deleteSponsor.disabled = state.selectedSponsorIndex < 0;
  await saveDataset();
}

async function saveCurrentSponsor() {
  if (!state.dataset) {
    window.alert('No dataset loaded.');
    return;
  }
  if (!isQuickSponsorEditEnabled() && state.selectedSponsorIndex < 0) {
    window.alert('No sponsor selected.');
    return;
  }
  await saveDataset();
}

async function deleteSession() {
  if (!state.dataset || state.selectedIndex < 0) return;
  const item = state.dataset.items[state.selectedIndex];
  const okay = window.confirm(`Delete session "${item?.title || 'Untitled'}"?`);
  if (!okay) return;
  undoPush();
  state.dataset.items.splice(state.selectedIndex, 1);
  removeTrackedIndex(state.quickEditSessionChanges, state.selectedIndex);
  if (state.dataset.items.length === 0) {
    state.selectedIndex = -1;
  } else if (state.selectedIndex >= state.dataset.items.length) {
    state.selectedIndex = state.dataset.items.length - 1;
  }

  markDirty(true);
  trackQuickSessionChange(state.selectedIndex, true);
  trackQuickSponsorChange(-1, true);
  renderSessionList();
  scrollToSessionRow(state.selectedIndex);
  renderSessionForm();
  renderSponsorForm();
  syncSessionSaveButton();
  els.deleteSession.disabled = state.selectedIndex < 0;
  await saveDataset();
}

function duplicateSession(index) {
  if (!state.dataset || index < 0 || index >= state.dataset.items.length) return;
  undoPush();
  const copy = cloneJsonValue(state.dataset.items[index]);
  copy.title = `${copy.title || 'Untitled'} (copy)`;
  state.dataset.items.splice(index + 1, 0, copy);
  state.selectedIndex = index + 1;
  markDirty(true);
  trackQuickSessionChange(index + 1, true);
  renderSessionList();
  scrollToSessionRow(state.selectedIndex);
  renderSessionForm();
  renderSponsorForm();
  syncSessionSaveButton();
  els.deleteSession.disabled = false;
}

function datasetJsonText() {
  stripSummaryFields(state.dataset);
  syncAllSessionDurations();
  return `${JSON.stringify(state.dataset, null, 2)}\n`;
}

function exportDataset() {
  if (!state.dataset) return;
  const fileName = outputBasename(state.outputPath) || state.file || 'dataset.json';
  const blob = new Blob([datasetJsonText()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function writeFileHandle(handle) {
  const writable = await handle.createWritable();
  await writable.write(datasetJsonText());
  await writable.close();
}

async function saveAsDataset() {
  if (!state.dataset) return;

  if (typeof window.showSaveFilePicker !== 'function') {
    exportDataset();
    markDirty(false);
    markSessionDirty(false);
    markSponsorDirty(false);
    capturePersistedSnapshot();
    clearRecoverySnapshot();
    window.alert('File System Access API is unavailable in this browser. Exported JSON instead.');
    return;
  }

  const handle = await window.showSaveFilePicker({
    suggestedName: outputBasename(state.outputPath) || state.file || 'new-event.json',
    types: [
      {
        description: 'JSON files',
        accept: { 'application/json': ['.json'] }
      }
    ]
  });

  await writeFileHandle(handle);
  state.fileHandle = handle;
  state.file = handle.name || state.file;
  state.outputPath = replaceOutputBasename(state.outputPath || `data/${state.file}`, state.file);
  await setLinkedHandle(getFileLinkKey(), handle);
  setCurrentFilenameLabel();
  markDirty(false);
  resetSessionQuickEditState();
  resetSponsorQuickEditState();
  markSessionDirty(false);
  markSponsorDirty(false);
  capturePersistedSnapshot();
  clearRecoverySnapshot();
  showSaveToast();
}

async function saveDataset() {
  if (!state.dataset) return;
  if (!state.fileHandle) {
    if (state.projectDirHandle) {
      try {
        const fromDir = await resolveFileHandleFromProjectDir(state.outputPath);
        if (fromDir) {
          state.fileHandle = fromDir;
          await setLinkedHandle(getFileLinkKey(), fromDir);
        }
      } catch {
        // no-op
      }
    }
  }
  if (!state.fileHandle) {
    window.alert('No save file linked yet. Use "Open project folder" to connect your folder, or use Save As to choose a file.');
    return;
  }
  if (typeof state.fileHandle.queryPermission === 'function') {
    const permission = await state.fileHandle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') {
      window.alert('Write permission is not available for the linked file. Use Save As to relink.');
      return;
    }
  }
  await writeFileHandle(state.fileHandle);
  markDirty(false);
  resetSessionQuickEditState();
  resetSponsorQuickEditState();
  markSessionDirty(false);
  markSponsorDirty(false);
  capturePersistedSnapshot();
  clearRecoverySnapshot();
  showSaveToast();
}

async function saveCurrentSession() {
  if (!state.dataset) {
    window.alert('No dataset loaded.');
    return;
  }
  if (!isQuickSessionEditEnabled() && state.selectedIndex < 0) {
    window.alert('No session selected.');
    return;
  }
  await saveDataset();
}

function promptForNewFilename() {
  const value = window.prompt('New dataset path (.json):', 'data/new-event.json');
  if (value == null) return '';
  return normalizeOutputPath(value, 'data/new-event.json');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/\n/g, '&#10;');
}

function renderSitemap() {
  const container = document.getElementById('sitemapContent');
  if (!container) return;

  const meta = state.dataset?.event || {};
  const items = state.dataset?.items || [];

  const rawUrl = String(meta.website || meta.scheduleURL || '').trim();
  if (!rawUrl) {
    container.innerHTML = '<p class="text-sm text-gray-400 py-4">No event website URL is configured. Set the <strong>Website</strong> field in the Event tab.</p>';
    return;
  }

  let parsedBase;
  try { parsedBase = new URL(rawUrl); } catch {
    container.innerHTML = `<p class="text-sm text-gray-400 py-4">Could not parse event URL: ${escapeHtml(rawUrl)}</p>`;
    return;
  }
  const domain = parsedBase.hostname;

  const eventUrls = [];
  if (meta.website) eventUrls.push(meta.website);
  if (meta.scheduleURL && meta.scheduleURL !== meta.website) eventUrls.push(meta.scheduleURL);

  const sessionEntries = [];
  const seen = new Set(eventUrls);
  items.forEach((item) => {
    const link = String(item?.link || '').trim();
    if (!link || seen.has(link)) return;
    try {
      if (new URL(link).hostname === domain) {
        seen.add(link);
        sessionEntries.push({ title: String(item?.title || '').trim() || '(Untitled)', url: link });
      }
    } catch {}
  });

  const sponsorEntries = [];
  (meta.sponsors || []).forEach((sponsor) => {
    const link = String(sponsor?.link || '').trim();
    if (!link || seen.has(link)) return;
    try {
      if (new URL(link).hostname === domain) {
        seen.add(link);
        sponsorEntries.push({ title: String(sponsor?.title || '').trim() || '(Untitled sponsor)', url: link });
      }
    } catch {}
  });

  const total = eventUrls.length + sessionEntries.length + sponsorEntries.length;
  const allUrls = [...eventUrls, ...sessionEntries.map(e => e.url), ...sponsorEntries.map(e => e.url)].join('\n');

  function urlRow(url, label = '') {
    const display = url.replace(/^https?:\/\//, '');
    return `<li class="sitemap-url-item">
      ${label ? `<span class="sitemap-item-label">${escapeHtml(label)}</span>` : ''}
      <a class="sitemap-item-url" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(display)}</a>
    </li>`;
  }

  container.innerHTML = `
    <div class="sitemap-toolbar">
      <span class="sitemap-domain"><i class="fas fa-globe mr-1.5"></i>${escapeHtml(domain)}</span>
      <span class="sitemap-total">${total} URL${total !== 1 ? 's' : ''}</span>
      <button id="sitemapCopyAll" type="button" class="sitemap-copy-btn">
        <i class="fas fa-copy mr-1.5 text-[0.72rem]"></i>Copy all
      </button>
    </div>
    ${eventUrls.length ? `
      <section class="sitemap-section">
        <h3 class="sitemap-section-heading">Event pages <span class="sitemap-count-badge">${eventUrls.length}</span></h3>
        <ul class="sitemap-url-list">${eventUrls.map(u => urlRow(u)).join('')}</ul>
      </section>` : ''}
    ${sessionEntries.length ? `
      <section class="sitemap-section">
        <h3 class="sitemap-section-heading">Sessions <span class="sitemap-count-badge">${sessionEntries.length}</span></h3>
        <ul class="sitemap-url-list">${sessionEntries.map(e => urlRow(e.url, e.title)).join('')}</ul>
      </section>` : ''}
    ${sponsorEntries.length ? `
      <section class="sitemap-section">
        <h3 class="sitemap-section-heading">Sponsors <span class="sitemap-count-badge">${sponsorEntries.length}</span></h3>
        <ul class="sitemap-url-list">${sponsorEntries.map(e => urlRow(e.url, e.title)).join('')}</ul>
      </section>` : ''}
    ${total === 0 ? '<p class="text-sm text-gray-400 py-4">No URLs found for this domain in the dataset.</p>' : ''}
  `;

  document.getElementById('sitemapCopyAll')?.addEventListener('click', () => {
    navigator.clipboard.writeText(allUrls).then(() => {
      const btn = document.getElementById('sitemapCopyAll');
      if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.innerHTML = '<i class="fas fa-copy mr-1.5 text-[0.72rem]"></i>Copy all'; }, 1800); }
    });
  });
}

function bindEvents() {
  els.datasetSelect.addEventListener('change', async () => {
    const nextFile = String(els.datasetSelect.value || '').trim();
    const previousValue = state.lastDatasetSelectValue || '';

    if (!nextFile) {
      els.datasetSelect.value = previousValue;
      return;
    }
    if (nextFile === previousValue) {
      return;
    }

    if (!(await confirmDiscardPendingChanges(`dataset ${nextFile}`))) {
      els.datasetSelect.value = previousValue;
      return;
    }

    try {
      await loadDataset(nextFile);
    } catch (error) {
      els.datasetSelect.value = previousValue;
      window.alert(`Could not load dataset: ${error.message}`);
    }
  });

  els.newDataset.addEventListener('click', async () => {
    if (!(await confirmDiscardPendingChanges('a new dataset'))) return;
    const pathValue = promptForNewFilename();
    if (!pathValue) return;
    createDatasetScaffold(pathValue);
  });

  async function handleConnectFolder() {
    try {
      await connectProjectFolder();
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      window.alert(`Could not open folder: ${error.message}`);
    }
  }

  els.folderConnectionToggle.addEventListener('click', async () => {
    if (state.folderConnectedInSession && state.projectDirHandle) {
      disconnectProjectFolder();
      return;
    }
    await handleConnectFolder();
  });

  const welcomeConnectBtn = document.getElementById('welcomeConnectFolder');
  if (welcomeConnectBtn) {
    welcomeConnectBtn.addEventListener('click', () => handleConnectFolder());
  }

  if (els.previewDataset) {
    els.previewDataset.addEventListener('click', () => {
      if (!state.dataset) return;
      try {
        localStorage.setItem('__preview__', JSON.stringify(state.dataset));
        window.open('./index.html?preview=1', '_blank');
      } catch (e) {
        window.alert('Could not open preview: ' + e.message);
      }
    });
  }

  els.saveDataset.addEventListener('click', async () => {
    try {
      await saveDataset();
    } catch (error) {
      window.alert(`Save failed: ${error.message}`);
    }
  });

  els.saveAsDataset.addEventListener('click', async () => {
    try {
      await saveAsDataset();
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      window.alert(`Save As failed: ${error.message}`);
    }
  });

  if (els.exportDataset) {
    els.exportDataset.addEventListener('click', exportDataset);
  }
  els.saveSession.addEventListener('click', async () => {
    try {
      await saveCurrentSession();
    } catch (error) {
      window.alert(`Save session failed: ${error.message}`);
    }
  });
  els.saveSponsor.addEventListener('click', async () => {
    try {
      await saveCurrentSponsor();
    } catch (error) {
      window.alert(`Save sponsor failed: ${error.message}`);
    }
  });
  els.addSession.addEventListener('click', async () => {
    try {
      await addSession();
    } catch (error) {
      window.alert(`Add session failed: ${error.message}`);
    }
  });
  els.deleteSession.addEventListener('click', async () => {
    try {
      await deleteSession();
    } catch (error) {
      window.alert(`Delete session failed: ${error.message}`);
    }
  });
  els.addSponsor.addEventListener('click', async () => {
    try {
      await addSponsor();
    } catch (error) {
      window.alert(`Add sponsor failed: ${error.message}`);
    }
  });
  els.deleteSponsor.addEventListener('click', async () => {
    try {
      await deleteSponsor();
    } catch (error) {
      window.alert(`Delete sponsor failed: ${error.message}`);
    }
  });
  if (els.sessionSearchInput) {
    els.sessionSearchInput.addEventListener('input', () => {
      state.sessionSearchQuery = String(els.sessionSearchInput.value || '');
      renderSessionList();
    });
  }

  els.currentFilenameInput.addEventListener('input', () => {
    if (!state.dataset) return;
    const previousKey = getFileLinkKey();
    state.outputPath = normalizeOutputPath(els.currentFilenameInput.value, state.outputPath || 'data/new-event.json');
    els.currentFilenameInput.value = state.outputPath;
    const basename = outputBasename(state.outputPath);
    state.file = basename || state.file;
    state.fileHandle = null;
    void clearLinkedHandle(previousKey).catch(() => {});
    void restoreLinkedHandleForCurrentPath();
    markDirty(true);
  });

  if (els.toggleEventMeta && els.eventMetaBody) {
    els.toggleEventMeta.addEventListener('click', () => {
      const isCollapsed = els.eventMetaBody.classList.contains('hidden');
      setEventMetaCollapsed(!isCollapsed);
    });
  }

  if (els.toggleSessionWorkspace) {
    els.toggleSessionWorkspace.addEventListener('click', async () => {
      if (!(await confirmDiscardPendingChanges('the session list view'))) return;
      setSessionWorkspaceExpanded(!state.sessionListExpanded);
      renderSessionList();
      renderSessionForm();
      syncSessionSaveButton();
      els.deleteSession.disabled = state.selectedIndex < 0;
    });
  }

  if (els.toggleQuickSessionEdit) {
    els.toggleQuickSessionEdit.addEventListener('click', async () => {
      if (!state.sessionListExpanded || !isSessionEditorEnabled()) return;
      if (!(await confirmDiscardPendingChanges('session quick edit'))) return;
      setQuickSessionEditEnabled(!state.sessionQuickEditEnabled);
      renderSessionList();
    });
  }

  if (els.toggleSponsorWorkspace) {
    els.toggleSponsorWorkspace.addEventListener('click', async () => {
      if (!(await confirmDiscardPendingChanges('the sponsor list view'))) return;
      setSponsorWorkspaceExpanded(!state.sponsorListExpanded);
      renderSponsorList();
      renderSponsorForm();
      syncSponsorSaveButton();
      els.deleteSponsor.disabled = state.selectedSponsorIndex < 0;
    });
  }

  if (els.toggleQuickSponsorEdit) {
    els.toggleQuickSponsorEdit.addEventListener('click', async () => {
      if (!state.sponsorListExpanded || !isSponsorEditorEnabled()) return;
      if (!(await confirmDiscardPendingChanges('sponsor quick edit'))) return;
      setQuickSponsorEditEnabled(!state.sponsorQuickEditEnabled);
      renderSponsorList();
    });
  }

  if (els.showEventTab) {
    els.showEventTab.addEventListener('click', async () => {
      await switchEditorTab('event');
    });
  }

  if (els.showSessionsTab) {
    els.showSessionsTab.addEventListener('click', async () => {
      await switchEditorTab('sessions');
    });
  }

  if (els.showLogoTab) {
    els.showLogoTab.addEventListener('click', async () => {
      await switchEditorTab('logo');
    });
  }

  if (els.showFlickrTab) {
    els.showFlickrTab.addEventListener('click', async () => {
      await switchEditorTab('flickr');
    });
  }

  if (els.showSponsorsTab) {
    els.showSponsorsTab.addEventListener('click', async () => {
      await switchEditorTab('sponsors');
    });
  }

  if (els.showSitemapTab) {
    els.showSitemapTab.addEventListener('click', async () => {
      await switchEditorTab('sitemap');
    });
  }

  if (els.showTimelineTab) {
    els.showTimelineTab.addEventListener('click', async () => {
      await switchEditorTab('timeline');
    });
  }

  if (els.timelineSaveBtn) {
    els.timelineSaveBtn.addEventListener('click', async () => {
      try { await saveDataset(); } catch (e) { window.alert(e?.message || String(e)); }
    });
  }

  if (els.closeSponsorSessionPicker) {
    els.closeSponsorSessionPicker.addEventListener('click', closeSponsorSessionPicker);
  }

  if (els.closeSponsorSessionPickerBack) {
    els.closeSponsorSessionPickerBack.addEventListener('click', closeSponsorSessionPicker);
  }

  if (els.sponsorSessionPickerModal) {
    els.sponsorSessionPickerModal.addEventListener('click', (event) => {
      if (event.target === els.sponsorSessionPickerModal) {
        closeSponsorSessionPicker();
      }
    });
    els.sponsorSessionPickerModal.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeSponsorSessionPicker();
      }
    });
  }

  if (els.closeSessionSponsorPicker) {
    els.closeSessionSponsorPicker.addEventListener('click', closeSessionSponsorPicker);
  }

  if (els.closeSessionSponsorPickerBack) {
    els.closeSessionSponsorPickerBack.addEventListener('click', closeSessionSponsorPicker);
  }

  if (els.sessionSponsorPickerModal) {
    els.sessionSponsorPickerModal.addEventListener('click', (event) => {
      if (event.target === els.sessionSponsorPickerModal) {
        closeSessionSponsorPicker();
      }
    });
    els.sessionSponsorPickerModal.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeSessionSponsorPicker();
      }
    });
  }

  if (els.undoAction) {
    els.undoAction.addEventListener('click', async () => {
      await performUndo();
    });
  }

  if (els.revertDataset) {
    els.revertDataset.addEventListener('click', async () => {
      if (!state.persistedSnapshot) return;
      const okay = window.confirm('Revert all unsaved changes and restore the last saved version?');
      if (!okay) return;
      await restorePersistedSnapshot();
    });
  }

  document.addEventListener('keydown', async (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 's') {
      event.preventDefault();
      try { await saveDataset(); } catch (e) { window.alert(e?.message || String(e)); }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'z' && !event.shiftKey) {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      event.preventDefault();
      await performUndo();
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (!state.dirty || !state.dataset) return;
    saveRecoverySnapshot();
    event.preventDefault();
    event.returnValue = '';
  });
}

async function buildConnectedFolderSearchCatalog() {
  const files = await listDatasetFilesFromConnectedFolder();
  const dataDir = await getDataDirectoryHandle(false);
  if (!dataDir || files.length === 0) return [];

  const entries = await Promise.all(
    files.map(async (file) => {
      try {
        const handle = await dataDir.getFileHandle(file);
        const blob = await handle.getFile();
        const text = await blob.text();
        const parsed = JSON.parse(text);
        const meta = parsed?.event || {};
        const designation = String(meta.designation || '').trim();
        const year = String(meta.year || '').trim();
        const location = String(meta.location || '').trim();
        const label =
          designation && year && location
            ? `${designation} ${year}: ${location}`
            : [designation, year, location].filter(Boolean).join(' ') ||
              file.replace(/\.json$/i, '');
        return {
          file,
          category: designation || 'Other',
          designation,
          location,
          year,
          region: String(meta.region || '').trim(),
          venue: String(meta.venue || '').trim(),
          label,
        };
      } catch {
        return null;
      }
    })
  );

  return entries
    .filter(Boolean)
    .sort((a, b) => {
      const ya = Number.parseInt(a.year, 10);
      const yb = Number.parseInt(b.year, 10);
      if (Number.isFinite(ya) && Number.isFinite(yb) && ya !== yb) return yb - ya;
      return a.label.localeCompare(b.label);
    });
}

async function refreshEditorSearch() {
  if (!state.projectDirHandle || !state.folderConnectedInSession) {
    configureEventSearch({ getEvents: () => [], onSelect: async () => {} });
    if (els.editorSearchEvents) els.editorSearchEvents.disabled = true;
    return;
  }

  const searchableEvents = await buildConnectedFolderSearchCatalog();

  configureEventSearch({
    getEvents: () => searchableEvents,
    onSelect: async (_category, file) => {
      if (!state.dataset || (await confirmDiscardPendingChanges(`dataset ${file}`))) {
        try {
          els.datasetSelect.value = file;
          await loadDataset(file);
        } catch (error) {
          els.datasetSelect.value = state.lastDatasetSelectValue || '';
          window.alert(`Could not load dataset: ${error.message}`);
        }
      }
    },
  });

  if (els.editorSearchEvents) els.editorSearchEvents.disabled = false;
}

async function init() {
  if (!isLocalhost()) {
    els.blocked.classList.remove('hidden');
    els.app.classList.add('hidden');
    return;
  }

  eventCatalog = await loadEventCatalog().catch(() => []);
  buildTimezoneList();
  if (els.editorSearchEvents) {
    els.editorSearchEvents.addEventListener('click', openEventSearchModal);
  }
  // Require explicit "Connect Folder" each session before loading datasets.
  // We keep stored handles for save-linking, but do not auto-activate folder loading.
  await renderDatasetOptionsFromConnectedFolder();
  setDatasetLoadingEnabled(false);
  bindEvents();
  markDirty(false);
  resetSessionQuickEditState();
  resetSponsorQuickEditState();
  markSessionDirty(false);
  markSponsorDirty(false);
  setCurrentFilenameLabel();
  setEditorButtonsEnabled(false);
  setEventMetaCollapsed(false);
  setSessionWorkspaceExpanded(false);
  setSponsorWorkspaceExpanded(false);
  setActiveEditorTab('event');
  setFolderConnectionButtonState();
  if (els.logoForm) {
    els.logoForm.innerHTML = '<p class="text-sm text-gray-400">Open a project folder to get started.</p>';
  }
  if (els.flickrForm) {
    els.flickrForm.innerHTML = '<p class="text-sm text-gray-400">Open a project folder to get started.</p>';
  }
  els.sponsorList.innerHTML = '<li class="text-sm text-gray-400 px-3 py-2 border border-dashed border-gray-700 rounded-md">Open a project folder to get started.</li>';
  els.sponsorForm.innerHTML = '<p class="text-sm text-gray-400">Select a sponsor row to edit it.</p>';

  const pendingRecovery = loadRecoverySnapshot();
  if (pendingRecovery) showRecoveryBar(pendingRecovery);

  setInterval(() => {
    if (state.dirty && state.dataset) saveRecoverySnapshot();
  }, 30_000);

  syncWelcomePanel();
}

void init();
