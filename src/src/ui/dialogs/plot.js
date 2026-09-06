import { defineCommand, requireIdle, setMode, startCommand } from '../../commands/registry.js';
import { PAPER_ORIENTATIONS, PAPER_SIZES, paperSizeMM, scalePresetLabel, scalePresets } from '../../core/paper.js';
import { formatLengthLabel } from '../../core/units.js';
import { canvas, ctx, plotAreaSelect, plotCenterCheck, plotColorSelect, plotDialog, plotLineweightsCheck, plotOrientationSelect, plotPaperSelect, plotPreview, plotPreviewCanvas, plotPreviewCtx, plotScaleInput, plotScaleModeSelect, plotScalePresetSelect, plotScaleRow, plotWarningsEl, plotWindowRow, plotWindowSummary } from '../../dom.js';
import { renderPlotPreview } from '../../view/plotPreview.js';
import { downloadTextFile, safeDrawingFileName } from '../../model/persistence.js';
import { buildPdfDocument } from '../../output/pdf.js';
import { PLOT_AREAS, PLOT_COLOR_MODES, buildPlotPlan, defaultPlotSettings } from '../../output/plot.js';
import { state } from '../../state.js';
import { fillSelect } from './units.js';
import { setFileStatus } from '../status.js';
import { worldToScreen } from '../../view/viewport.js';

// ---------------------------------------------------------------------------
// Plot dialog
//
// Settings live here rather than in the document. What sheet somebody printed
// on last is a property of the session, not of the drawing, and keeping it out
// of the file means the native format does not have to answer the page-size
// and scale-list questions before it can be plotted from.
// ---------------------------------------------------------------------------

export let pendingPlot = null;
// Remembered across opens so a second plot of the same drawing is one click.
export let lastPlotSettings = null;

export function refreshPlotDialog() {
  if (!pendingPlot) return;
  fillSelect(plotPaperSelect, PAPER_SIZES.map(size => size.id),
    id => PAPER_SIZES.find(size => size.id === id).name, pendingPlot.paperSizeId);
  fillSelect(plotOrientationSelect, Object.keys(PAPER_ORIENTATIONS),
    key => PAPER_ORIENTATIONS[key], pendingPlot.orientation);
  fillSelect(plotAreaSelect, Object.keys(PLOT_AREAS), key => PLOT_AREAS[key], pendingPlot.area);
  fillSelect(plotScaleModeSelect, ['fit', 'exact'],
    key => (key === 'fit' ? 'Fit to the sheet' : 'Exact scale'), pendingPlot.scaleMode);
  fillSelect(plotColorSelect, Object.keys(PLOT_COLOR_MODES),
    key => PLOT_COLOR_MODES[key], pendingPlot.color);

  const presets = scalePresets();
  const match = presets.find(([, value]) => Math.abs(value - pendingPlot.scale) < 1e-9);
  fillSelect(plotScalePresetSelect, ['custom', ...presets.map(([, value]) => value)],
    value => (value === 'custom' ? 'Custom' : presets.find(([, preset]) => preset === value)[0]),
    match ? match[1] : 'custom');
  plotScaleInput.value = String(pendingPlot.scale);
  plotCenterCheck.checked = Boolean(pendingPlot.center);
  plotLineweightsCheck.checked = Boolean(pendingPlot.lineweights);

  // A fitted plot has no scale to choose, and a window has to be picked before
  // there is anything to report about it.
  plotScaleRow.hidden = pendingPlot.scaleMode !== 'exact';
  plotWindowRow.hidden = pendingPlot.area !== 'window';
  plotWindowSummary.textContent = pendingPlot.window
    ? `${formatLengthLabel(Math.abs(pendingPlot.window.maxX - pendingPlot.window.minX))} × ` +
      `${formatLengthLabel(Math.abs(pendingPlot.window.maxY - pendingPlot.window.minY))}`
    : 'No window picked yet';

  const plan = buildPlotPlan(pendingPlot);
  if (plan.error) {
    // The sheet is still worth drawing when there is nothing on it: it says
    // which paper the unanswered question is about.
    renderPlotPreview(plotPreviewCanvas, plotPreviewCtx,
      { page: paperSizeMM(pendingPlot.paperSizeId, pendingPlot.orientation), ops: [] });
    plotPreview.textContent = '—';
    plotWarningsEl.textContent = plan.error;
    return;
  }
  renderPlotPreview(plotPreviewCanvas, plotPreviewCtx, plan);
  plotPreview.textContent =
    `${scalePresetLabel(plan.scale)} · ${plan.plotWidthMM.toFixed(1)} × ${plan.plotHeightMM.toFixed(1)} mm ` +
    `on ${plan.page.widthMM.toFixed(1)} × ${plan.page.heightMM.toFixed(1)} mm · ` +
    `${plan.entityCount} object${plan.entityCount === 1 ? '' : 's'}`;
  plotWarningsEl.textContent = plan.warnings.join(' ');
}

export function openPlotDialog() {
  if (!requireIdle('plotting')) return;
  pendingPlot = { ...(lastPlotSettings || defaultPlotSettings()) };
  plotDialog.hidden = false;
  refreshPlotDialog();
  plotPaperSelect.focus();
}

export function closePlotDialog() {
  pendingPlot = null;
  plotDialog.hidden = true;
  canvas.focus();
}

export function setPendingPlot(patch) {
  if (!pendingPlot) return;
  Object.assign(pendingPlot, patch);
  refreshPlotDialog();
}

export function plotDownloadName() {
  return `${safeDrawingFileName()}.pdf`;
}

export function runPlot() {
  if (!pendingPlot) return false;
  const plan = buildPlotPlan(pendingPlot);
  if (plan.error) {
    plotWarningsEl.textContent = plan.error;
    return false;
  }
  lastPlotSettings = { ...pendingPlot };
  try {
    downloadTextFile(buildPdfDocument(plan, state.drawingName), plotDownloadName(), 'application/pdf');
  } catch (error) {
    plotWarningsEl.textContent = `Could not write the PDF: ${error.message || 'unknown error'}`;
    return false;
  }
  closePlotDialog();
  setFileStatus(`${state.drawingName} · Plotted at ${scalePresetLabel(plan.scale)}`);
  return true;
}

// ---------------------------------------------------------------------------
// Picking the plot window
//
// The window is a rectangle on the drawing, so it has to be picked with the
// same two-corner gesture as everything else — which means a real command,
// registered the same way as any other. It lives here rather than in
// commands/ because it exists only to answer a question this dialog asked:
// the dialog steps out of the way, the corners are picked, and it comes back
// with the answer already filled in.
// ---------------------------------------------------------------------------

export function startPlotWindowPick() {
  if (!pendingPlot) return;
  lastPlotSettings = { ...pendingPlot };
  closePlotDialog();
  startCommand('PLOTWINDOW');
}

defineCommand('PLOTWINDOW', {
  // The corners name a region of the drawing to put on paper, not a feature of
  // the geometry, so snapping to a nearby endpoint would only move the edge of
  // the sheet somewhere the user did not point.
  usesSnap: false,
  prompt() {
    return state.currentPoints.length
      ? 'Plot window — opposite corner:'
      : 'Plot window — first corner:';
  },
  point(p) {
    state.currentPoints.push(p);
    if (state.currentPoints.length < 2) return;
    const [first, second] = state.currentPoints;
    const picked = {
      minX: Math.min(first.x, second.x), maxX: Math.max(first.x, second.x),
      minY: Math.min(first.y, second.y), maxY: Math.max(first.y, second.y),
    };
    setMode('SELECT');
    openPlotDialog();
    setPendingPlot({ area: 'window', window: picked });
  },
  preview(p) {
    const start = worldToScreen(state.currentPoints[0]);
    const end = worldToScreen(p);
    ctx.strokeStyle = '#56d6ff';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
    ctx.setLineDash([]);
  },
  // Leaving the pick without a second corner returns to the dialog rather than
  // to a bare command line, since the dialog is where the user came from.
  finish() {
    setMode('SELECT');
    openPlotDialog();
    return true;
  },
});
