
// Frame scheduling, deliberately independent of what is being painted.
//
// Almost every edit in the program ends by asking for a repaint. If that call
// reached into the renderer directly then the model, the geometry operations,
// the command runtime, and the input layer would all import the renderer —
// which is a large part of how the single-file version ended up with no usable
// layering. The renderer registers itself here instead, so `draw()` stays a
// leaf that any layer may call without dragging the paint code along with it.

export let renderer = () => {};

export function setFrameRenderer(fn) {
  renderer = fn;
}

// Repaint at most once per animation frame. mousemove can fire several times
// between frames; without this, every one of them paid for a full redraw.
export let frameHandle = null;
export function draw() {
  if (frameHandle !== null) return;
  frameHandle = window.requestAnimationFrame(() => {
    frameHandle = null;
    renderer();
  });
}

// For code paths that must observe the canvas synchronously (tests, export).
export function drawNow() {
  if (frameHandle !== null) {
    window.cancelAnimationFrame(frameHandle);
    frameHandle = null;
  }
  renderer();
}
