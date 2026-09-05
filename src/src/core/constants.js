
export const TAU = Math.PI * 2;
export const MIN_VIEW_SCALE = 0.0001;
export const MAX_VIEW_SCALE = 100000;
export const DOCUMENT_FORMAT = 'browser-2d-draft';
export const DOCUMENT_VERSION = 4;
export const AUTOSAVE_KEY = `${DOCUMENT_FORMAT}.autosave`;
export const AUTOSAVE_BACKUP_KEY = `${AUTOSAVE_KEY}.previous`;
export const LEGACY_AUTOSAVE_KEYS = [`${DOCUMENT_FORMAT}.autosave.v1`];

// The increments a draughtsman actually works to. 90 is ORTHO expressed as a
// polar angle, which is why the two are mutually exclusive rather than
// combined.
export const POLAR_INCREMENTS = Object.freeze([90, 45, 30, 22.5, 15, 10, 5]);

// How close the cursor has to come to an alignment ray before it locks. This
// is a screen distance, not an angle, so a lock is equally easy to acquire
// near the base point and far from it.
export const POLAR_APERTURE_PX = 12;

export const DIM_TYPES = ['ALIGNED', 'LINEAR'];
export const DIM_REF_PARTS = ['START', 'END', 'CENTER', 'MID', 'QUAD', 'VERTEX', 'POINT', 'SEGMENT'];

// No real glyph metrics exist outside a canvas context, so a text entity's
// footprint (for bounding box, hit-testing, and zoom-extents) is approximated
// from its character count and height rather than measured. Rendering uses a
// monospace font specifically so this approximation stays close to what is
// actually drawn.
export const TEXT_WIDTH_FACTOR = 0.6;
