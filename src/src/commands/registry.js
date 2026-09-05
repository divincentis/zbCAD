import { commandInput, inquiryPanel } from '../dom.js';
import { cleanPoint } from '../model/document.js';
import { redo, undo } from '../model/history.js';
import { currentLayerIsEditable } from '../model/layerQuery.js';
import { state } from '../state.js';
import { hideInquiryReport } from '../ui/inquiry.js';
import { setPromptProvider, updatePrompt } from '../ui/prompt.js';
import { draw } from '../view/frame.js';

// ---------------------------------------------------------------------------
// Command registry
//
// A command's behaviour used to be spread across nine functions, each with its
// own branch on state.mode: entry, point handling, prompt text, preview, base
// point, ORTHO, distance entry, the Close/Undo keys, and Enter. Adding one
// meant editing all nine and hoping none was missed.
//
// A registered command puts that behaviour in a single object instead. The
// dispatchers below consulted the registry first and fell through to the
// original branches while the migration was under way; every command has now
// moved across, so the fall-through is gone and the dispatchers do nothing
// but ask the active command. Adding a command means adding one object here.
//
// A command may define:
//   stateMode        optional shared runtime mode used while this command runs
//   creates          clears the selection and requires an editable layer
//   canBegin()       validates activation; returning false refuses the command
//   usesOrtho        boolean or predicate controlling ORTHO for this stage
//   takesDistance    boolean or predicate: a typed number is a direct distance
//   additiveSelection  clicks during a selection stage add rather than replace
//   selectsObjects() whether this stage is gathering a selection
//   noteSelection()  how each object entered the selection: the window that
//                    caught it, or the fact that it was picked outright
//   commitsOnPick    a single pick completes the selection stage outright
//   usesSnap         boolean or predicate: false takes the raw cursor and
//                    reports no snap, for picks that name a place on the
//                    screen rather than a point in the drawing
//   snapExcludes()   an entity id that OSNAP must ignore
//   begin()          initialises command-specific transient state; may return
//                    COMMAND_COMPLETE when the command finishes on activation
//   prompt()         the command line text for the current stage
//   acceptsPoint()   whether typed point input is valid in the current stage
//   point(p)         a committed point
//   distance(value)  consumes a typed distance with command-specific meaning
//   keyword(text)    consumes a command-local keyword, ahead of alias lookup
//   value(text)      consumes typed input that is neither a point nor a
//                    distance: an angle in degrees, a scale factor
//   basePoint()      the anchor for ORTHO, relative entry, and direct
//                    distance, for commands that do not track currentPoints
//   previewReady()   whether preview() has enough state to draw; defaults to
//                    "at least one point has been picked"
//   preview(p)       the rubber band, drawn only once a point exists
//   snapSegments()   in-progress geometry that OSNAP should see
//   close()          the C keyword
//   undoPoint()      the U keyword
//   finish()         Enter, Space, or right-click
// ---------------------------------------------------------------------------

export const COMMANDS = new Map();
export const COMMAND_COMPLETE = Symbol('command-complete');

export function defineCommand(name, spec) {
  COMMANDS.set(name, spec);
}

export function activeCommand() {
  return COMMANDS.get(state.activeCommandName || state.mode) || null;
}

// Several hooks are either a fixed value or a predicate evaluated against the
// current stage. These readers are the only interpretation of that contract;
// every dispatcher and the test diagnostic go through them, so a hook cannot
// mean one thing to the program and another to a check.
export function staged(value, command) {
  return typeof value === 'function' ? Boolean(value.call(command)) : Boolean(value);
}

export function commandUsesOrtho(command = activeCommand()) {
  return command ? staged(command.usesOrtho, command) : false;
}

// Snapping is the default; a command opts out for the stages where the cursor
// position is the answer rather than an approximation of one.
export function commandUsesSnap(command = activeCommand()) {
  if (!command || command.usesSnap === undefined) return true;
  return staged(command.usesSnap, command);
}

export function commandTakesDistance(command = activeCommand()) {
  return command ? staged(command.takesDistance, command) : false;
}

export function commandAcceptsPoint(command = activeCommand()) {
  if (!command?.point) return false;
  return !command.acceptsPoint || Boolean(command.acceptsPoint());
}

export function commandPreviewReady(command = activeCommand()) {
  if (!command?.preview) return false;
  // Most commands are ready to preview once a point exists; those that track
  // their progress elsewhere say so themselves.
  return command.previewReady
    ? Boolean(command.previewReady())
    : state.currentPoints.length > 0;
}

export function commandSelectsObjects(command = activeCommand()) {
  return Boolean(command?.selectsObjects?.());
}


// Anything that would rewrite the document out from under a running command
// has to ask this first. A unit rescale during MOVE moves the entities but not
// the base point already staged in state.transform; creating a layer during
// LINE pushes an undo step, so the next local U undoes the layer instead of the
// last segment. Both are the same fault: two things editing at once.
export function commandInProgress() {
  return state.mode !== 'SELECT' ||
    state.currentPoints.length > 0 ||
    Boolean(state.transform || state.offset || state.edit || state.grip || state.dimension);
}

// Refuse an out-of-band document change and say why. Returns true when the
// caller is clear to proceed.
export function requireIdle(what) {
  if (!commandInProgress()) return true;
  updatePrompt(`Finish or cancel ${state.activeCommandName || state.mode} with Esc before ${what}.`);
  return false;
}

export function activateCommandMode(commandName) {
  const command = COMMANDS.get(commandName);
  if (command?.canBegin && !command.canBegin()) return false;
  if (command?.creates) {
    if (!currentLayerIsEditable()) return false;
    // Existing selection is unrelated to creation and would otherwise remain
    // highlighted throughout the command. New geometry also stays unselected.
    state.selected.clear();
  }
  setMode(command?.stateMode || commandName, commandName);
  return true;
}

export function setMode(mode, commandName = mode) {
  state.mode = mode;
  state.activeCommandName = COMMANDS.has(commandName) ? commandName : null;
  state.currentPoints = [];
  state.transform = null;
  state.offset = null;
  state.inquiry = null;
  state.dimension = null;
  state.edit = null;
  state.grip = null;
  state.gripPress = false;
  state.circle = null;
  state.snap = null;
  const command = activeCommand();
  const beginResult = command?.begin?.();
  // Some commands are complete as soon as they inspect the activation state.
  // LIST, for example, reports a preselection without entering a live mode.
  if (beginResult === COMMAND_COMPLETE) {
    state.mode = 'SELECT';
    state.activeCommandName = null;
    state.currentPoints = [];
    state.inquiry = null;
    state.edit = null;
    state.transform = null;
    state.offset = null;
    state.dimension = null;
    state.circle = null;
    state.grip = null;
  }
  // Match the command, falling back to the mode. DIMLINEAR and DIMALIGNED both
  // run as mode DIM, so comparing against the mode left neither button lit.
  document.querySelectorAll('[data-command]').forEach(b => {
    b.classList.toggle('active', b.dataset.command === (state.activeCommandName || state.mode));
  });
  updatePrompt();
  draw();
}

export function commitPoint(p) {
  if (!cleanPoint(p)) {
    updatePrompt('Invalid point: coordinates must be finite numbers.');
    return false;
  }
  activeCommand()?.point?.(p);
  draw();
}

export function finishCurrent() {
  const command = activeCommand();
  // The return value reports whether the command consumed the default action;
  // an explicit false means the key still belongs to whoever asked.
  if (command?.finish) return command.finish();
  state.currentPoints = [];
  updatePrompt();
  draw();
  return undefined;
}

// C — close the run back to its start point, then end the command.
export function closeCurrentPath() {
  const command = activeCommand();
  if (command?.close) {
    command.close();
    return true;
  }
  return false;
}

// U — step back one point without leaving the command.
export function undoLastPoint() {
  const command = activeCommand();
  if (command?.undoPoint) {
    command.undoPoint();
    return true;
  }
  return false;
}

// Accepts a decimal, a bare fraction, or a mixed number: 3.5 / 1/2 / 3 1/2 / 3-1/2
// Central cancellation policy. Keep this separate from the DOM key handler
// so the command contract can be exercised without synthesizing a browser
// event, and so future command modules have one cancellation boundary.
export function cancelCurrent() {
  if (state.mode !== 'SELECT' || state.currentPoints.length) {
    state.currentPoints = [];
    setMode('SELECT');
  } else if (!inquiryPanel.hidden) {
    hideInquiryReport();
  } else {
    state.selected.clear();
    draw();
  }
  commandInput.value = '';
}

// Global history must never restore the document underneath a live command
// while leaving that command's points or stage intact. The first Undo/Redo
// request cancels the command only; a repeated request at Command: navigates
// document history. Keyboard shortcuts and toolbar buttons share this path.
export function navigateHistory(direction) {
  const action = String(direction).toUpperCase();
  if (action !== 'UNDO' && action !== 'REDO') return false;

  if (state.mode !== 'SELECT') {
    const cancelledMode = state.mode;
    cancelCurrent();
    const label = action === 'UNDO' ? 'Undo' : 'Redo';
    updatePrompt(`${cancelledMode} canceled. ${label} again to change drawing history.`);
    return false;
  }

  if (action === 'UNDO') undo();
  else redo();
  return true;
}

// A few command names never start a mode: they open a dialog or move the view
// and are finished the moment they are typed. Their implementations live in the
// view and UI layers, which sit above the registry, so those layers register the
// action here rather than the registry reaching up to call them.
export const DIRECT_ACTIONS = new Map();

export function registerDirectAction(name, action) {
  DIRECT_ACTIONS.set(name, action);
}

export function startCommand(name) {
  const direct = DIRECT_ACTIONS.get(name);
  if (direct) { direct(); return true; }
  // Shared by typed commands and toolbar buttons. Direct view actions remain
  // available; document dialogs have their own idle gate.
  if (commandInProgress()) {
    const running = state.activeCommandName || state.mode;
    updatePrompt(name === running
      ? `${running} is already running. Finish it or cancel with Esc.`
      : `Finish ${running} or cancel with Esc before starting ${name}.`);
    return false;
  }
  const started = activateCommandMode(name);
  // SELECT is a resting state, not a command worth repeating.
  if (started && name !== 'SELECT') state.lastCommand = name;
  return started;
}

// SELECT is the resting state and has no command of its own, so the bare prompt
// is what remains when nothing is registered for the active mode.
setPromptProvider(() => {
  const command = activeCommand();
  return command?.prompt ? command.prompt() : 'Command:';
});
