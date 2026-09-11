import { createDefaultLayers, defaultDimStyle, defaultSnapTypes, defaultUnitSettings } from './core/defaults.js';

export const state = {
  entities: [],
  // Raster reference images, kept out of `entities` so no geometry dispatch
  // has to grow a branch for them. See model/underlay.js.
  underlays: [],
  layers: createDefaultLayers(),
  currentLayerId: '0',
  drawingName: 'Untitled',
  unitSettings: defaultUnitSettings(),
  documentDirty: false,
  selected: new Set(),
  mode: 'SELECT',
  activeCommandName: null,
  lastCommand: null,
  currentPoints: [],
  // A note the next prompt will append once, then discard.
  promptNote: null,
  transform: null,
  offset: null,
  inquiry: null,
  dimension: null,
  edit: null,
  grip: null,
  circle: null,
  text: null,
  underlay: null,
  mouseScreen: { x: 0, y: 0 },
  mouseWorld: { x: 0, y: 0 },
  activePoint: { x: 0, y: 0 },
  snap: null,
  snapEnabled: true,
  snapTypes: defaultSnapTypes(),
  ortho: false,
  polar: false,
  polarIncrement: 45,
  // The alignment the cursor is currently locked to, for the guide and the
  // status readout. Recomputed every frame by getActivePoint.
  polarLock: null,
  view: { scale: 1.5, offsetX: 0, offsetY: 0 },
  panning: false,
  panStart: null,
  dragSelect: null,
  mouseDownScreen: null,
  gripPress: false,
  history: [],
  future: [],
  nextId: 1,
  nextLayerId: 1,
  nextUnderlayId: 1,
  dimStyles: [defaultDimStyle()],
};

export function allocateEntityId() {
  return state.nextId++;
}
