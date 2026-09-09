import { requireIdle } from '../commands/registry.js';
import { DEFAULT_LINETYPE, DEFAULT_LINEWEIGHT, LINETYPES, LINEWEIGHTS } from '../core/constants.js';
import { pushHistory } from './history.js';
import { getLayer, isEntityEditable } from './layerQuery.js';
import { state } from '../state.js';
import { renderLayerManager } from '../ui/layerPanel.js';
import { updatePrompt } from '../ui/prompt.js';
import { setFileStatus } from '../ui/status.js';
import { draw } from '../view/frame.js';

export function nextDefaultLayerName(seed) {
  const names = new Set(state.layers.map(layer => layer.name.toLocaleLowerCase()));
  let number = Math.max(1, seed);
  while (names.has(`layer ${number}`)) number += 1;
  return `Layer ${number}`;
}

export function createLayer(name = '', color = '#56d6ff') {
  if (!requireIdle('creating a layer')) return null;
  let number = Math.max(1, state.nextLayerId);
  while (state.layers.some(layer => layer.id === `layer-${number}`)) number += 1;
  const layerName = (String(name || '').trim() || nextDefaultLayerName(number)).slice(0, 80);
  if (!layerName) {
    updatePrompt('Layer name cannot be empty.');
    return null;
  }
  if (state.layers.some(layer => layer.name.toLocaleLowerCase() === layerName.toLocaleLowerCase())) {
    updatePrompt(`A layer named ${layerName} already exists.`);
    return null;
  }
  const layerColor = /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : '#56d6ff';
  const id = `layer-${number}`;
  pushHistory();
  state.layers.push({
    id, name: layerName, color: layerColor, visible: true, locked: false,
    linetype: DEFAULT_LINETYPE, lineweight: DEFAULT_LINEWEIGHT, printable: true,
  });
  state.currentLayerId = id;
  state.nextLayerId = number + 1;
  renderLayerManager(id);
  setFileStatus(`${state.drawingName} · Created ${layerName}`);
  draw();
  return id;
}

export function renameLayer(id, name) {
  if (!requireIdle('renaming a layer')) return false;
  const layer = getLayer(id);
  const nextName = String(name || '').trim().slice(0, 80);
  if (!layer) return false;
  if (layer.id === '0') {
    updatePrompt('Layer 0 cannot be renamed.');
    renderLayerManager();
    return false;
  }
  if (!nextName) {
    updatePrompt('Layer name cannot be empty.');
    renderLayerManager();
    return false;
  }
  if (state.layers.some(candidate => candidate.id !== layer.id && candidate.name.toLocaleLowerCase() === nextName.toLocaleLowerCase())) {
    updatePrompt(`A layer named ${nextName} already exists.`);
    renderLayerManager();
    return false;
  }
  if (nextName === layer.name) return true;
  pushHistory();
  layer.name = nextName;
  renderLayerManager();
  setFileStatus(`${state.drawingName} · Renamed layer`);
  draw();
  return true;
}

export function setLayerColor(id, color) {
  if (!requireIdle('changing a layer colour')) return false;
  const layer = getLayer(id);
  if (!layer || !/^#[0-9a-f]{6}$/i.test(String(color))) return false;
  const nextColor = String(color).toLowerCase();
  if (layer.color === nextColor) return true;
  pushHistory();
  layer.color = nextColor;
  renderLayerManager();
  draw();
  return true;
}

export function setLayerLinetype(id, linetype) {
  if (!requireIdle('changing a layer linetype')) return false;
  const layer = getLayer(id);
  if (!layer || !LINETYPES.includes(linetype)) return false;
  if (layer.linetype === linetype) return true;
  pushHistory();
  layer.linetype = linetype;
  renderLayerManager();
  draw();
  return true;
}

export function setLayerLineweight(id, lineweight) {
  if (!requireIdle('changing a layer lineweight')) return false;
  const layer = getLayer(id);
  const weight = Number(lineweight);
  if (!layer || !LINEWEIGHTS.includes(weight)) return false;
  if (layer.lineweight === weight) return true;
  pushHistory();
  layer.lineweight = weight;
  renderLayerManager();
  draw();
  return true;
}

export function toggleLayerPrintable(id) {
  if (!requireIdle('changing layer printability')) return false;
  const layer = getLayer(id);
  if (!layer) return false;
  pushHistory();
  layer.printable = !layer.printable;
  renderLayerManager();
  draw();
  return true;
}

export function setCurrentLayer(id) {
  if (!requireIdle('changing the current layer')) return false;
  const layer = getLayer(id);
  if (!layer) return false;
  if (!layer.visible || layer.locked) {
    updatePrompt(`Make ${layer.name} visible and unlocked before setting it current.`);
    renderLayerManager();
    return false;
  }
  if (layer.id === state.currentLayerId) return true;
  pushHistory();
  state.currentLayerId = layer.id;
  renderLayerManager();
  setFileStatus(`${state.drawingName} · Current: ${layer.name}`);
  draw();
  return true;
}

export function toggleLayerVisibility(id) {
  if (!requireIdle('changing layer visibility')) return false;
  const layer = getLayer(id);
  if (!layer) return false;
  if (layer.id === state.currentLayerId) {
    updatePrompt('The current layer cannot be hidden. Make another layer current first.');
    return false;
  }
  pushHistory();
  layer.visible = !layer.visible;
  if (!layer.visible) {
    for (const entity of state.entities) {
      if (entity.layerId === layer.id) state.selected.delete(entity.id);
    }
  }
  renderLayerManager();
  draw();
  return true;
}

export function toggleLayerLock(id) {
  if (!requireIdle('changing layer locking')) return false;
  const layer = getLayer(id);
  if (!layer) return false;
  if (layer.id === state.currentLayerId) {
    updatePrompt('The current layer cannot be locked. Make another layer current first.');
    return false;
  }
  pushHistory();
  layer.locked = !layer.locked;
  if (layer.locked) {
    for (const entity of state.entities) {
      if (entity.layerId === layer.id) state.selected.delete(entity.id);
    }
  }
  renderLayerManager();
  draw();
  return true;
}

export function deleteLayer(id, skipConfirmation = false) {
  if (!requireIdle('deleting a layer')) return false;
  const layer = getLayer(id);
  if (!layer) return false;
  if (layer.id === '0') {
    updatePrompt('Layer 0 cannot be deleted.');
    return false;
  }
  if (layer.id === state.currentLayerId) {
    updatePrompt('The current layer cannot be deleted. Make another layer current first.');
    return false;
  }

  const destination = getLayer(state.currentLayerId);
  if (!destination?.visible || destination.locked) {
    updatePrompt('Choose a visible, unlocked current layer before deleting another layer.');
    return false;
  }
  const affected = state.entities.filter(entity => entity.layerId === layer.id);
  if (affected.length && !skipConfirmation) {
    const noun = affected.length === 1 ? 'object' : 'objects';
    const confirmed = window.confirm(
      `Delete layer "${layer.name}"?\n\n${affected.length} ${noun} will be moved to current layer "${destination.name}". No drawing geometry will be deleted.`,
    );
    if (!confirmed) return false;
  }

  pushHistory();
  for (const entity of affected) entity.layerId = destination.id;
  state.layers = state.layers.filter(candidate => candidate.id !== layer.id);
  renderLayerManager();
  const moved = affected.length ? `; moved ${affected.length} to ${destination.name}` : '';
  setFileStatus(`${state.drawingName} · Deleted ${layer.name}${moved}`);
  draw();
  return true;
}

export function assignSelectionToLayer(id = state.currentLayerId) {
  if (!requireIdle('reassigning layers')) return false;
  const layer = getLayer(id);
  if (!layer || !layer.visible || layer.locked) {
    updatePrompt('The destination layer must be visible and unlocked.');
    return false;
  }
  const selectedEntities = state.entities.filter(entity => state.selected.has(entity.id) && isEntityEditable(entity));
  if (!selectedEntities.length) {
    updatePrompt('Select at least one editable object to assign.');
    return false;
  }
  const changing = selectedEntities.filter(entity => entity.layerId !== layer.id);
  if (!changing.length) {
    updatePrompt(`Selection is already on ${layer.name}.`);
    return true;
  }
  pushHistory();
  for (const entity of changing) entity.layerId = layer.id;
  renderLayerManager();
  setFileStatus(`${state.drawingName} · Assigned ${changing.length} to ${layer.name}`);
  draw();
  return true;
}
