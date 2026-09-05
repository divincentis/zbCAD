import { fileStatus } from '../dom.js';

export function setFileStatus(message, error = false) {
  fileStatus.textContent = message;
  fileStatus.classList.toggle('error', error);
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}
