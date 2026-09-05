import { inquiryBody, inquiryPanel, inquiryTitle } from '../dom.js';

export function showInquiryReport(title, groups) {
  inquiryTitle.textContent = title;
  inquiryBody.textContent = '';
  for (const group of groups) {
    const section = document.createElement('div');
    section.className = 'inquiry-group';
    if (group.title) {
      const heading = document.createElement('div');
      heading.className = 'inquiry-group-title';
      heading.textContent = group.title;
      section.appendChild(heading);
    }
    const list = document.createElement('dl');
    list.style.margin = '0';
    for (const [label, value] of group.rows || []) {
      const row = document.createElement('div');
      row.className = 'inquiry-row';
      const term = document.createElement('dt');
      term.textContent = label;
      const detail = document.createElement('dd');
      detail.textContent = value;
      row.append(term, detail);
      list.appendChild(row);
    }
    section.appendChild(list);
    if (group.note) {
      const note = document.createElement('div');
      note.className = 'inquiry-note';
      note.textContent = group.note;
      section.appendChild(note);
    }
    inquiryBody.appendChild(section);
  }
  inquiryPanel.hidden = false;
  inquiryPanel.scrollTop = 0;
}

export function hideInquiryReport() {
  inquiryPanel.hidden = true;
}
