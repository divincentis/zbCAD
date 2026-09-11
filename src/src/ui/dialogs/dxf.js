import { requireIdle } from '../../commands/registry.js';
import { dxfInput } from '../../dom.js';
import { buildDxfDocument } from '../../output/dxf.js';
import { buildDxfPlan } from '../../output/dxfPlan.js';
import { importDxfText } from '../../model/dxfImport.js';
import { applyDocument, downloadTextFile, safeDrawingFileName } from '../../model/persistence.js';
import { state } from '../../state.js';
import { showInquiryReport } from '../inquiry.js';
import { setFileStatus } from '../status.js';
import { updatePrompt } from '../prompt.js';

// ---------------------------------------------------------------------------
// DXF in and out
//
// Neither direction gets a dialog. Export has no decisions left to make — the
// version is fixed, the units come from the drawing, and everything plots — and
// import replaces the document exactly as Open does. What both DO need is to
// say what happened, because both are lossy in ways the user cannot see by
// looking at the result: that goes to the inquiry panel, which already exists
// for reporting things about a drawing.
// ---------------------------------------------------------------------------

export function dxfDownloadName() {
  return `${safeDrawingFileName()}.dxf`;
}

export function exportDxf() {
  if (!requireIdle('exporting DXF')) return false;
  if (!state.entities.length) {
    updatePrompt('There is nothing to export.');
    return false;
  }
  let text;
  let plan;
  try {
    plan = buildDxfPlan();
    text = buildDxfDocument(plan);
  } catch (error) {
    setFileStatus(`Could not write the DXF: ${error.message || 'unknown error'}`, true);
    return false;
  }
  downloadTextFile(text, dxfDownloadName(), 'application/dxf');
  showInquiryReport('DXF Export', exportReportGroups(plan));
  setFileStatus(`${state.drawingName} · Exported DXF`);
  return true;
}

export function exportReportGroups(plan) {
  const groups = [{
    title: dxfDownloadName(),
    rows: [
      ['Format', 'AutoCAD R2000 (AC1015) ASCII'],
      ['Objects', String(plan.entities.length)],
      ['Layers', String(plan.layers.length)],
      ['Dimension styles', String(plan.dimStyles.length)],
    ],
  }];
  if (plan.warnings.length) {
    groups.push({
      title: 'Not included',
      rows: plan.warnings.map((warning, index) => [`${index + 1}`, warning]),
    });
  }
  return groups;
}

export function chooseDxfFile() {
  if (!requireIdle('importing DXF')) return;
  dxfInput.value = '';
  dxfInput.click();
}

export async function loadDxfText(text, sourceName = '') {
  const result = importDxfText(text, sourceName);
  if (result.error) {
    setFileStatus(result.error, true);
    return false;
  }
  await applyDocument(result.document, true);
  showInquiryReport('DXF Import', importReportGroups(result.report, sourceName));
  setFileStatus(`${result.document.name} · Imported from DXF`);
  return true;
}

function countRows(counts) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([what, count]) => [what, String(count)]);
}

export function importReportGroups(report, sourceName) {
  const groups = [{
    title: sourceName || 'DXF',
    rows: [
      ['Objects imported', String(report.entityCount)],
      ['Layers', String(report.layerCount)],
    ],
  }];
  // Every lossy conversion is named. An import that quietly drops a third of a
  // consultant's drawing is the failure this panel exists to prevent.
  if (Object.keys(report.approximated).length) {
    groups.push({
      title: 'Approximated as polylines',
      rows: countRows(report.approximated),
      note: 'These have no exact equivalent here and were traced to within a fraction of a drawing unit.',
    });
  }
  if (Object.keys(report.exploded).length) {
    groups.push({
      title: 'Exploded into plain geometry',
      rows: countRows(report.exploded),
      note: 'The drawn result is intact, but these are no longer live dimensions.',
    });
  }
  if (Object.keys(report.skipped).length) {
    groups.push({
      title: 'Not imported',
      rows: countRows(report.skipped),
      note: 'This program has no equivalent for these.',
    });
  }
  if (groups.length === 1) {
    groups[0].note = 'Everything in the file was imported.';
  }
  return groups;
}
