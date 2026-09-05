import { promptEl } from '../dom.js';
import { state } from '../state.js';

// The prompt line belongs to whichever command is running, but the command
// registry sits far above this module in the graph and half the program needs
// to write a prompt. The registry registers a text source here instead, so
// updatePrompt() stays a leaf that any layer may call.
export let promptText = () => 'Command:';

export function setPromptProvider(fn) {
  promptText = fn;
}

// A one-shot note for the next prompt. A command that finishes as it starts
// has no later turn to speak in: setMode() rewrites the prompt on its way
// out, so the message is left here for that rewrite to pick up.
export function notePrompt(message) {
  if (message) state.promptNote = message;
}

export function updatePrompt(extra = '') {
  const p = promptText();
  const note = extra || state.promptNote || '';
  state.promptNote = null;
  promptEl.textContent = note ? `${p} ${note}` : p;
}
