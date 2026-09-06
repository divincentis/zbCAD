
export const TAU = Math.PI * 2;
export const MIN_VIEW_SCALE = 0.0001;
export const MAX_VIEW_SCALE = 100000;
export const DOCUMENT_FORMAT = 'browser-2d-draft';
// Version 4 had no per-layer linetype/lineweight/printability (see
// core/defaults.js and model/document.js's layer parsing for the migration).
export const DOCUMENT_VERSION = 6;
export const AUTOSAVE_KEY = `${DOCUMENT_FORMAT}.autosave`;
export const AUTOSAVE_BACKUP_KEY = `${AUTOSAVE_KEY}.previous`;
export const LEGACY_AUTOSAVE_KEYS = [`${DOCUMENT_FORMAT}.autosave.v1`];
// The drawing itself lives in IndexedDB (see model/autosaveStore.js); these
// name the database, its one store, and the sibling localStorage key that
// timestamps the synchronous unload copy.
export const AUTOSAVE_DB_NAME = `${DOCUMENT_FORMAT}.autosave`;
export const AUTOSAVE_DB_VERSION = 1;
export const AUTOSAVE_STORE_NAME = 'drawings';
export const AUTOSAVE_STAMP_SUFFIX = '.at';
export const AUTOSAVE_OPEN_TIMEOUT_MS = 1500;

// The increments a draughtsman actually works to. 90 is ORTHO expressed as a
// polar angle, which is why the two are mutually exclusive rather than
// combined.
export const POLAR_INCREMENTS = Object.freeze([90, 45, 30, 22.5, 15, 10, 5]);

// How close the cursor has to come to an alignment ray before it locks. This
// is a screen distance, not an angle, so a lock is equally easy to acquire
// near the base point and far from it.
export const POLAR_APERTURE_PX = 12;

export const DIM_TYPES = ['ALIGNED', 'LINEAR', 'RADIUS', 'DIAMETER'];

// What a radial dimension's text is prefixed with. Both measure a circle
// rather than a distance between two features, and the prefix is what tells
// the two apart on a drawing.
export const DIM_TEXT_PREFIX = { RADIUS: 'R ', DIAMETER: '⌀ ' };
export const DIM_REF_PARTS = ['START', 'END', 'CENTER', 'MID', 'QUAD', 'VERTEX', 'POINT', 'SEGMENT'];

// No real glyph metrics exist outside a canvas context, so a text entity's
// footprint (for bounding box, hit-testing, and zoom-extents) is approximated
// from its character count and height rather than measured. Rendering uses a
// monospace font specifically so this approximation stays close to what is
// actually drawn.
export const TEXT_WIDTH_FACTOR = 0.6;

// Standard AutoCAD-style linetypes and lineweights, kept to the subset an
// architectural roof plan actually needs. Dash patterns are screen pixels
// rather than world units (like the existing preview dash [6,4] in
// view/render.js) so a linetype stays legible at any zoom level instead of
// vanishing into a solid line when zoomed out.
export const LINETYPES = Object.freeze(['continuous', 'dashed', 'dotted', 'dashdot', 'center']);
export const LINETYPE_LABELS = Object.freeze({
  continuous: 'Continuous',
  dashed: 'Dashed',
  dotted: 'Dotted',
  dashdot: 'Dash-Dot',
  center: 'Center',
});
export const LINETYPE_DASH_PATTERNS = Object.freeze({
  continuous: [],
  dashed: [8, 4],
  dotted: [1, 3],
  dashdot: [8, 3, 1, 3],
  center: [12, 3, 2, 3],
});
export const DEFAULT_LINETYPE = 'continuous';

// The full standard CAD lineweight table, in millimeters.
export const LINEWEIGHTS = Object.freeze([
  0.00, 0.05, 0.09, 0.13, 0.15, 0.18, 0.20, 0.25, 0.30, 0.35, 0.40, 0.50,
  0.53, 0.60, 0.70, 0.80, 0.90, 1.00, 1.06, 1.20, 1.40, 1.58, 2.00, 2.11,
]);
export const DEFAULT_LINEWEIGHT = 0.25;

// On-screen line width is a fixed multiple of the millimeter lineweight
// rather than something that scales with zoom, matching how CAD programs
// keep lineweight legible regardless of view scale. The multiplier is chosen
// so the default 0.25mm weight reproduces this app's pre-lineweight line
// width (1.35px), so drawings made before this feature render unchanged.
export const LINEWEIGHT_PX_PER_MM = 1.35 / DEFAULT_LINEWEIGHT;
export const MIN_LINEWEIGHT_PX = 1;
