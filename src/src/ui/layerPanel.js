import { LINETYPE_LABELS, LINETYPES, LINEWEIGHTS } from '../core/constants.js';
import { assignLayerBtn, currentLayerSelect, layerList } from '../dom.js';
import { state } from '../state.js';
import { escapeHtml } from './status.js';

export function renderLayerManager() {
  if (!currentLayerSelect || !layerList) return;
  currentLayerSelect.innerHTML = state.layers.map(layer => {
    const unavailable = !layer.visible || layer.locked;
    const suffix = !layer.visible ? ' (hidden)' : layer.locked ? ' (locked)' : '';
    return `<option value="${escapeHtml(layer.id)}"${layer.id === state.currentLayerId ? ' selected' : ''}${unavailable && layer.id !== state.currentLayerId ? ' disabled' : ''}>${escapeHtml(layer.name + suffix)}</option>`;
  }).join('');
  currentLayerSelect.value = state.currentLayerId;

  layerList.innerHTML = state.layers.map(layer => {
    const current = layer.id === state.currentLayerId;
    const protectedLayer = layer.id === '0' || current;
    const lockTitle = layer.locked ? 'Layer locked — click to unlock' : 'Layer unlocked — click to lock';
    const printTitle = layer.printable ? 'Printable — click to exclude from output' : 'Excluded from output — click to make printable';
    return `
      <div class="layer-row${current ? ' current' : ''}${layer.visible ? '' : ' hidden'}" data-layer-id="${escapeHtml(layer.id)}">
        <div class="layer-row-main">
          <button class="layer-current${current ? ' on' : ''}" data-layer-action="current" data-layer-id="${escapeHtml(layer.id)}" title="Make current" aria-label="Make ${escapeHtml(layer.name)} current">${current ? '●' : '○'}</button>
          <input class="layer-name" data-layer-action="name" data-layer-id="${escapeHtml(layer.id)}" value="${escapeHtml(layer.name)}" aria-label="Layer name"${layer.id === '0' ? ' disabled title="Layer 0 cannot be renamed"' : ''} />
          <input class="layer-color" type="color" data-layer-action="color" data-layer-id="${escapeHtml(layer.id)}" value="${escapeHtml(layer.color)}" title="Layer color" aria-label="${escapeHtml(layer.name)} color" />
          <button data-layer-action="visibility" data-layer-id="${escapeHtml(layer.id)}" title="Toggle visibility">${layer.visible ? 'On' : 'Off'}</button>
          <button class="layer-lock" data-layer-action="lock" data-layer-id="${escapeHtml(layer.id)}" title="${lockTitle}" aria-label="${lockTitle}">${layer.locked ? '🔒' : '🔓'}</button>
          <button class="layer-delete" data-layer-action="delete" data-layer-id="${escapeHtml(layer.id)}" title="${protectedLayer ? (layer.id === '0' ? 'Layer 0 cannot be deleted' : 'The current layer cannot be deleted') : 'Delete layer'}" aria-label="Delete ${escapeHtml(layer.name)}"${protectedLayer ? ' disabled' : ''}>Del</button>
        </div>
        <div class="layer-row-props">
          <select class="layer-linetype" data-layer-action="linetype" data-layer-id="${escapeHtml(layer.id)}" title="Linetype" aria-label="${escapeHtml(layer.name)} linetype">
            ${LINETYPES.map(type => `<option value="${type}"${type === layer.linetype ? ' selected' : ''}>${LINETYPE_LABELS[type]}</option>`).join('')}
          </select>
          <select class="layer-lineweight" data-layer-action="lineweight" data-layer-id="${escapeHtml(layer.id)}" title="Lineweight (mm)" aria-label="${escapeHtml(layer.name)} lineweight">
            ${LINEWEIGHTS.map(weight => `<option value="${weight}"${weight === layer.lineweight ? ' selected' : ''}>${weight.toFixed(2)}</option>`).join('')}
          </select>
          <button class="layer-printable${layer.printable ? '' : ' off'}" data-layer-action="printable" data-layer-id="${escapeHtml(layer.id)}" title="${printTitle}" aria-label="${escapeHtml(layer.name)} ${printTitle}">${layer.printable ? '🖨️' : '🚫'}</button>
        </div>
      </div>`;
  }).join('');
  if (assignLayerBtn) assignLayerBtn.disabled = !state.selected.size;
}
