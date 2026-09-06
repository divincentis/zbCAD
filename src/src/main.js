import { registerDirectAction, setMode } from './commands/registry.js';
import { engineStatus, help } from './dom.js';
import { onDocumentChanged } from './events.js';
import { restoreAutosave } from './model/persistence.js';
import { openDimStyleDialog } from './ui/dialogs/dimstyle.js';
import { refreshTrackingButtons } from './ui/dialogs/drafting.js';
import { openPlotDialog } from './ui/dialogs/plot.js';
import { openUnitsDialog, renderUnitStatus } from './ui/dialogs/units.js';
import { renderLayerManager } from './ui/layerPanel.js';
import { setFrameRenderer } from './view/frame.js';
import { render } from './view/render.js';
import { resize, zoomExtents } from './view/viewport.js';

// Composition root.
//
// Every module below is imported for its side effects as well as its exports:
// the command modules register themselves with the command registry, the shell
// and pointer modules attach DOM listeners, and the test hook publishes
// window.__cadPrototype. Nothing else in the program imports them, so removing
// an import here removes the feature.




// Close the one deliberate indirection in the module graph: view/frame.js is a
// leaf so that anything may ask for a repaint, and this is where it learns what
// a repaint actually is.
setFrameRenderer(render);

// The commands that are finished the moment they are typed. The registry holds
// the names; the layers that can actually perform them hold the work.
registerDirectAction('ZOOMEXTENTS', zoomExtents);
registerDirectAction('UNITS', openUnitsDialog);
registerDirectAction('DIMSTYLE', openDimStyleDialog);
registerDirectAction('PLOT', openPlotDialog);

// Chrome that has to be rebuilt whenever the whole document is replaced.
onDocumentChanged(renderLayerManager);
onDocumentChanged(renderUnitStatus);

setTimeout(() => help.style.opacity = '0', 12000);
renderLayerManager();
renderUnitStatus();
resize();
refreshTrackingButtons();
if (!restoreAutosave()) setMode('SELECT');
engineStatus.textContent = 'ENGINE: READY';
engineStatus.classList.remove('loading', 'error');
engineStatus.classList.add('ready');
