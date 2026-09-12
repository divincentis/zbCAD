import { requireIdle } from '../commands/registry.js';
import { propertiesBody, propertiesEmpty, propertiesFields, propertiesLayerSelect, propertiesSummary } from '../dom.js';
import { commitGeometry } from '../model/history.js';
import { isEntityEditable } from '../model/layerQuery.js';
import { selectedUnderlays } from '../model/underlay.js';
import { state } from '../state.js';
import { updatePrompt } from './prompt.js';
import { escapeHtml, setFileStatus } from './status.js';
import { draw } from '../view/frame.js';

const ENTITY_TYPE_LABELS = {
  LINE: 'Line', PLINE: 'Polyline', CIRCLE: 'Circle', ARC: 'Arc',
  TEXT: 'Text', MTEXT: 'Mtext', DIM: 'Dimension',
};

// Only fields with a plain scalar meaning are exposed here — geometry that
// would need re-deriving a shape (line endpoints, polyline vertices) stays
// grip-only. `angle` fields are shown and typed in degrees, matching every
// other angle the user ever types at the command line, and stored back in
// the radians the entity itself holds.
const NUMERIC_FIELDS = {
  CIRCLE: [{ key: 'radius', label: 'Radius' }],
  ARC: [{ key: 'radius', label: 'Radius' }],
  TEXT: [
    { key: 'height', label: 'Height' },
    { key: 'rotation', label: 'Rotation (deg)', angle: true },
  ],
  MTEXT: [
    { key: 'height', label: 'Height' },
    { key: 'width', label: 'Width' },
    { key: 'rotation', label: 'Rotation (deg)', angle: true },
  ],
};
const CONTENT_TYPES = new Set(['TEXT', 'MTEXT']);
const POSITIVE_FIELDS = new Set(['radius', 'height', 'width']);

function selectedEntities() {
  return state.entities.filter(entity => state.selected.has(entity.id));
}

function commonValue(items, key) {
  const values = new Set(items.map(item => item[key]));
  return values.size === 1 ? [...values][0] : null;
}

// The pure read of "what does the selection currently look like," kept
// separate from renderPropertiesPanel's DOM building so a headless test can
// assert this directly (see testHook.js) instead of parsing rendered markup —
// this codebase's tests never inspect rendered HTML, only state/model reads.
export function selectionPropertiesSummary() {
  const entities = selectedEntities();
  const underlays = selectedUnderlays();
  const count = entities.length + underlays.length;
  if (!count) return null;

  const types = [...new Set(entities.map(entity => entity.type))];
  const homogeneousType = !underlays.length && types.length === 1 ? types[0] : null;
  const layerId = commonValue([...entities, ...underlays], 'layerId');

  const fields = {};
  if (homogeneousType) {
    for (const field of NUMERIC_FIELDS[homogeneousType] || []) {
      fields[field.key] = commonValue(entities, field.key);
    }
    if (CONTENT_TYPES.has(homogeneousType)) fields.content = commonValue(entities, 'content');
  }

  return {
    count,
    entityCount: entities.length,
    underlayCount: underlays.length,
    types,
    homogeneousType,
    layerId,
    fields,
  };
}

function summaryLabel(summary) {
  if (summary.underlayCount && !summary.entityCount) {
    return `${summary.underlayCount} image${summary.underlayCount === 1 ? '' : 's'} selected`;
  }
  if (summary.homogeneousType) {
    const label = ENTITY_TYPE_LABELS[summary.homogeneousType] || summary.homogeneousType;
    return `${summary.entityCount} ${label}${summary.entityCount === 1 ? '' : 's'} selected`;
  }
  return `${summary.count} objects selected`;
}

export function renderPropertiesPanel() {
  if (!propertiesBody) return;
  const summary = selectionPropertiesSummary();
  propertiesEmpty.hidden = Boolean(summary);
  propertiesBody.hidden = !summary;
  if (!summary) return;

  propertiesSummary.textContent = summaryLabel(summary);

  propertiesLayerSelect.innerHTML =
    `<option value=""${summary.layerId === null ? ' selected' : ''} disabled hidden>— Varies —</option>` +
    state.layers.map(layer =>
      `<option value="${escapeHtml(layer.id)}"${layer.id === summary.layerId ? ' selected' : ''}>${escapeHtml(layer.name)}</option>`).join('');
  if (summary.layerId !== null) propertiesLayerSelect.value = summary.layerId;

  const numericFields = summary.homogeneousType ? (NUMERIC_FIELDS[summary.homogeneousType] || []) : [];
  let html = numericFields.map(field => {
    const value = summary.fields[field.key];
    const shown = value === null || value === undefined ? '' : (field.angle ? (value * 180 / Math.PI).toFixed(2) : String(value));
    return `
      <label class="properties-field">
        <span>${field.label}</span>
        <input type="text" class="properties-input" data-prop-field="${field.key}"${field.angle ? ' data-prop-angle="1"' : ''} value="${escapeHtml(shown)}" placeholder="${value === null ? 'Varies' : ''}" />
      </label>`;
  }).join('');
  if (summary.homogeneousType && CONTENT_TYPES.has(summary.homogeneousType)) {
    const value = summary.fields.content;
    html += `
      <label class="properties-field properties-field-content">
        <span>Content</span>
        <textarea class="properties-input" data-prop-field="content" placeholder="${value === null || value === undefined ? 'Varies' : ''}">${escapeHtml(value || '')}</textarea>
      </label>`;
  }
  propertiesFields.innerHTML = html;
}

// Applies one field to every selected entity of the (necessarily homogeneous —
// see selectionPropertiesSummary) selected type at once. Mirrors the shape of
// model/layers.js's mutators: requireIdle, mutate, commit, refresh.
export function applyPropertiesField(field, rawValue, isAngle) {
  if (!requireIdle('editing properties')) { renderPropertiesPanel(); return false; }
  const entities = selectedEntities().filter(isEntityEditable);
  if (!entities.length) { renderPropertiesPanel(); return false; }
  const type = entities[0].type;
  if (!entities.every(entity => entity.type === type)) { renderPropertiesPanel(); return false; }

  let nextValue;
  if (field === 'content') {
    const content = String(rawValue);
    if (!content.trim()) {
      updatePrompt('Content cannot be empty.');
      renderPropertiesPanel();
      return false;
    }
    nextValue = content.slice(0, type === 'MTEXT' ? 4000 : 1000);
  } else {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
      updatePrompt('Enter a number.');
      renderPropertiesPanel();
      return false;
    }
    nextValue = isAngle ? parsed * Math.PI / 180 : parsed;
    if (POSITIVE_FIELDS.has(field) && nextValue <= 1e-9) {
      updatePrompt('Value must be greater than zero.');
      renderPropertiesPanel();
      return false;
    }
  }

  const ids = new Set(entities.map(entity => entity.id));
  const nextEntities = state.entities.map(entity => (ids.has(entity.id) ? { ...entity, [field]: nextValue } : entity));
  if (!commitGeometry(nextEntities)) { renderPropertiesPanel(); return false; }
  setFileStatus(`${state.drawingName} · Updated ${entities.length} object${entities.length === 1 ? '' : 's'}`);
  renderPropertiesPanel();
  draw();
  return true;
}
