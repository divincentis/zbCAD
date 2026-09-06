import { state } from '../state.js';
import { updatePrompt } from '../ui/prompt.js';

export function getLayer(id) {
  return state.layers.find(layer => layer.id === String(id)) || null;
}

export function isLayerVisible(id) {
  return getLayer(id)?.visible !== false;
}

export function isLayerLocked(id) {
  return getLayer(id)?.locked === true;
}

export function isLayerPrintable(id) {
  return getLayer(id)?.printable !== false;
}

export function isEntityVisible(entity) {
  return !entity?.layerId || isLayerVisible(entity.layerId);
}

export function isEntityEditable(entity) {
  return isEntityVisible(entity) && !isLayerLocked(entity?.layerId);
}


export function currentLayerIsEditable() {
  const layer = getLayer(state.currentLayerId);
  if (layer?.visible && !layer.locked) return true;
  updatePrompt('Choose a visible, unlocked current layer before drawing.');
  return false;
}
