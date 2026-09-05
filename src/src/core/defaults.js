
// New drawings get the architectural default. Migrated v2 files do NOT — see
// parseUnitSettings, which reproduces what v2 actually displayed.
export const DEFAULT_UNIT_SETTINGS = Object.freeze({
  drawingUnit: 'inches',
  format: 'architectural',
  precision: 16,
  angleFormat: 'degrees',
  anglePrecision: 1,
});

export function defaultUnitSettings() {
  return { ...DEFAULT_UNIT_SETTINGS };
}
export const DEFAULT_DIM_STYLE_ID = 'standard';
// Paper sizes, in the drawing's own unit, so a metric drawing does not get a
// 3/16 inch text height expressed as 0.1875 millimetres.
export const DIM_PAPER_DEFAULTS = {
  inches:      { textHeight: 0.1875, arrowSize: 0.125,  extensionOffset: 0.0625, extensionBeyond: 0.125, textGap: 0.0625 },
  feet:        { textHeight: 0.015625, arrowSize: 0.0104, extensionOffset: 0.0052, extensionBeyond: 0.0104, textGap: 0.0052 },
  millimeters: { textHeight: 2.5, arrowSize: 2.5, extensionOffset: 1.5, extensionBeyond: 2.5, textGap: 1 },
  centimeters: { textHeight: 0.25, arrowSize: 0.25, extensionOffset: 0.15, extensionBeyond: 0.25, textGap: 0.1 },
  meters:      { textHeight: 0.0025, arrowSize: 0.0025, extensionOffset: 0.0015, extensionBeyond: 0.0025, textGap: 0.001 },
};

export function defaultDimStyle(drawingUnit = 'inches') {
  const paper = DIM_PAPER_DEFAULTS[drawingUnit] || DIM_PAPER_DEFAULTS.inches;
  return {
    id: DEFAULT_DIM_STYLE_ID,
    name: 'Standard',
    arrowType: drawingUnit === 'millimeters' || drawingUnit === 'meters' || drawingUnit === 'centimeters'
      ? 'arrow' : 'tick',
    scale: 1,
    precision: null,        // null = follow the document's length precision
    ...paper,
  };
}
export function createDefaultLayers() {
  return [{ id: '0', name: '0', color: '#d6d6d6', visible: true, locked: false }];
}

// Object snaps in priority order, which is also the order they are listed in
// the settings dialog. All default on: nearest ranks last of all candidates
// (see closestCandidate in snap.js), so a running NEAREST only ever fills in
// when nothing more specific is under the aperture, rather than pre-empting it.
export const SNAP_TYPES = Object.freeze([
  { type: 'END', label: 'Endpoint', on: true },
  { type: 'INT', label: 'Intersection', on: true },
  { type: 'MID', label: 'Midpoint', on: true },
  { type: 'CENTER', label: 'Center', on: true },
  { type: 'QUAD', label: 'Quadrant', on: true },
  { type: 'PERP', label: 'Perpendicular', on: true },
  { type: 'TAN', label: 'Tangent', on: true },
  { type: 'NEAR', label: 'Nearest', on: true },
]);

export const SNAP_RANK = Object.fromEntries(SNAP_TYPES.map((entry, index) => [entry.type, index]));

export function defaultSnapTypes() {
  return Object.fromEntries(SNAP_TYPES.map(entry => [entry.type, entry.on]));
}
export function derivedNextLayerId(layers) {
  const ids = new Set(layers.map(layer => layer.id));
  let next = 1;
  while (ids.has(`layer-${next}`)) next += 1;
  return next;
}
