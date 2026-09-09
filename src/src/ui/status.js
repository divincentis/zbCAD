import { autosaveStatus, fileStatus } from '../dom.js';

export function setFileStatus(message, error = false) {
  fileStatus.textContent = message;
  fileStatus.classList.toggle('error', error);
}

const AUTOSAVE_STATUS_LABELS = { saved: 'SAVED', pending: 'UNSAVED', error: 'SAVE FAILED' };
const AUTOSAVE_STATUS_TITLES = {
  saved: 'Autosave is up to date',
  pending: 'Changes since the last autosave — will save automatically',
  error: 'Autosave failed — recovery copies are retained, use Save to be sure',
};

// A dedicated, always-current readout, separate from fileStatus's one-shot
// messages (which the next unrelated action overwrites within seconds) —
// this is the answer to "is autosave current right now" at any moment.
export function setAutosaveStatus(status) {
  autosaveStatus.textContent = AUTOSAVE_STATUS_LABELS[status] || AUTOSAVE_STATUS_LABELS.saved;
  autosaveStatus.title = AUTOSAVE_STATUS_TITLES[status] || AUTOSAVE_STATUS_TITLES.saved;
  autosaveStatus.classList.remove('saved', 'pending', 'error');
  autosaveStatus.classList.add(status in AUTOSAVE_STATUS_LABELS ? status : 'saved');
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}
