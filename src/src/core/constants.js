
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
export const DIM_REF_PARTS = ['START', 'END', 'CENTER', 'MID', 'QUAD', 'VERTEX', 'POINT'];
