
// A tiny notification hub, with no dependencies of its own.
//
// Replacing the whole document — opening a file, starting a new drawing,
// undoing, redoing — has to refresh chrome that the model layer should know
// nothing about: the layer panel, the unit readout in the status bar. The model
// announces the change here and the composition root decides who listens, which
// keeps model/history.js and model/persistence.js from importing the UI.

export const documentListeners = new Set();

export function onDocumentChanged(listener) {
  documentListeners.add(listener);
  return () => documentListeners.delete(listener);
}

export function documentChanged() {
  for (const listener of documentListeners) listener();
}
