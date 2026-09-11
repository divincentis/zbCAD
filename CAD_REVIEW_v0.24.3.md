# zbCAD v0.24.3 — Code Review and Remediation Plan

- **Review date:** 2026-09-10
- **Reviewed artifact:** `index(1).html`, displaying version `v0.24.3`
- **Status:** Findings and recommendations; no application fixes applied
- **Recommended sequence:** Dimension correctness → plot clipping → recovery and pointer handling → performance → new features

## Scope and evidence

The review covered the supplied HTML bundle and targeted execution of its command, geometry, persistence, and plot-plan functions. Tests ran in Node using a VM harness with stubbed DOM/canvas APIs. Basic MOVE, undo/redo, and document serialization/parsing checks passed.

A full browser interaction and visual pass was not completed because a browser executable was unavailable. Pointer findings are based on event-handler inspection and simulated dispatch. The recovery reproduction exercised the localStorage fallback with an in-memory store; actual IndexedDB concurrency still needs browser testing. Plot findings were verified against generated plot operations and the PDF clipping code, without rendering an exported PDF.

Performance figures are synthetic Node measurements, not browser frame timings or production capacity guarantees. Temporary review scripts were not added to the repository; the acceptance checks below describe regression coverage to implement in the project's test suite.

The bundle identifies itself as generated from 51 source modules. Function names below are the primary navigation references. Source module names are taken from bundle comments and should be checked against the repository. There is no recommendation to split the distributed HTML solely because it is large.

## Priority summary

| ID | Priority | Finding | Evidence |
| --- | --- | --- | --- |
| CAD-001 | High | Mirror/rotation fail to transform dimension references consistently | Reproduced in geometry commit tests |
| CAD-002 | High | Radial dimensions can reference an unrelated coincident object | Reproduced in dimension creation/edit tests |
| CAD-003 | High | Plot Window does not clip to the selected drawing window | Verified in plot operations and PDF clipping code |
| CAD-004 | Medium | JOIN/EXPLODE leave dangling dimension associations | JOIN reproduced; EXPLODE confirmed by source inspection |
| CAD-005 | Medium | Recovery backup can omit recent outgoing edits | Reproduced with localStorage fallback |
| CAD-006 | Medium | Mouse release outside the canvas can leave interactions active | Event-handler inspection and simulated dispatch |

High priority means the issue can silently produce incorrect drawing measurements or output. Medium priority means it compromises recovery, associations, or normal interaction and should be fixed before expanding the affected feature.

## CAD-001 — Transform dimension references with their geometry

**Locations:** `rotateEntity()`, `mirrorEntity()`, `pointForReference()`, `updateAssociativeDimensions()`; geometry transform and dimension model code.

### Problem

Transforms change the dimension's stored points but copy its reference descriptors without transforming their meaning. At commit, association resolution overwrites the transformed points using those stale descriptors.

- Mirroring an ARC reverses its stored direction: its new START corresponds to the reflected original END. Dimension START/END references are not swapped.
- Circular POINT/QUAD reference angles remain at their old world angles after rotation or reflection.

### Reproductions

**Mirrored arc endpoint:**

1. Create an arc centered at `(0, 0)`, radius `10`, from `0°` to `90°`.
2. Add an aligned dimension from `(10, 0)` to `(20, 0)`, referencing the arc's START at the first point. Place its dimension line at `(15, -5)`.
3. Mirror both the arc and dimension across the Y axis, replacing the originals.
4. Expected: first measured point `(-10, 0)` and measurement `10`.
5. Actual: first measured point approximately `(0, 10)` and measurement approximately `22.36068`.

**Rotated circular reference:**

1. Create a circle centered at `(0, 0)`, radius `10`, and a radius dimension pointing right.
2. Rotate the circle and dimension `90°` about the origin.
3. Expected: the dimension edge point moves from `(10, 0)` to `(0, 10)`.
4. Actual: association resolution moves it back to `(10, 0)`, while the text offset has rotated.

### Recommended implementation

Update reference descriptors using the same transform context as the referenced geometry. Rotate/reflect angular references and swap START/END when reflecting arcs. Handle copied references after source-to-copy ID remapping. Explicitly distinguish transforming both objects from transforming only the dimension or only its source; those cases should not blindly share one rule.

### Acceptance checks

- [ ] Mirrored arc-associated dimensions preserve the expected measurement and endpoint identity.
- [ ] Circular POINT and QUAD associations follow rotation/reflection correctly.
- [ ] Mirror with source retained and source erased both work.
- [ ] Dimension-only and geometry-only transforms have explicit, tested behavior.
- [ ] Undo/redo and save/reopen preserve the corrected associations.

## CAD-002 — Bind radial dimensions to the selected target

**Location:** `radialDimensionEntity()` in radial dimension command code.

### Problem and reproduction

The command already knows the selected circle/arc ID, but obtains its dimension references through `resolveEntityReference()`, which searches the whole drawing. Coincident features on an earlier entity can win that search.

1. Create a line from `(0, 0)` to `(10, 0)`.
2. Create a circle centered at `(0, 0)` with radius `10`.
3. Create a radius dimension on that circle pointing right, with text near `(15, 0)`.
4. The dimension's references attach to the line's START and END.
5. Scale only the line by `2` about `(0, 0)`.
6. Actual: the displayed radius changes from `10` to `20`; the circle's radius is still `10`.

### Recommended implementation

Construct references directly from `targetId`: CENTER plus an angular edge reference for radius, or two opposite angular references for diameter. Do not use a drawing-wide coincidence search when the target is already known.

### Acceptance checks

- [ ] Coincident lines, circles, and arc endpoints cannot steal radial associations.
- [ ] Editing an unrelated coincident object does not change the radial measurement.
- [ ] Changing the selected target's radius updates the dimension.
- [ ] Radius and diameter commands both receive coverage.

## CAD-003 — Clip plots to the chosen area

**Locations:** `plotAreaBox()`, `buildPlotPlan()`, `pdfContentStream()`, and plot preview clipping.

### Problem and reproduction

The selected plot window sets scale and origin, but all plottable entities are emitted. PDF clipping uses only the printable page rectangle. Geometry outside the selected window can therefore appear in unused space around it.

1. Create geometry inside a window from `(0, 0)` to `(100, 100)`.
2. Add a separate line from `(-10, 25)` to `(-10, 75)`, entirely outside that window.
3. Plot the window centered with Fit on a landscape sheet.
4. Actual: the outside line's generated paper coordinates fall inside the printable rectangle, so the existing PDF clip permits it to print.

### Recommended implementation

Transform the requested area into paper coordinates and clip output to its intersection with the printable page rectangle. Use the same clipping definition for PDF and preview. Review Display plotting too, because it uses the same area/scale pipeline.

Filtering out entities whose bounds miss the window can reduce work, but clipping is still required for entities crossing the window boundary.

### Acceptance checks

- [ ] Geometry wholly outside Window/Display does not print.
- [ ] Crossing lines, arcs, text, and dimensions clip at the selected boundary.
- [ ] Fit and exact scale work with both centered and uncentered placement.
- [ ] Preview accurately distinguishes printable geometry from clipped geometry.
- [ ] Extents plotting retains its intended behavior.

## CAD-004 — Preserve or explicitly flag broken associations

**Locations:** `joinSelection()`, `explodeSelection()`, `pointForReference()`, `updateAssociativeDimensions()`.

### Problem and reproduction

JOIN and EXPLODE remove source entities and create new IDs without remapping dimensions. Unresolved references leave the last measured points in place, so the dimension continues to look valid while no longer following the geometry.

1. Create lines `(0, 0)`–`(10, 0)` and `(10, 0)`–`(20, 0)`.
2. Dimension the first line using its START/END references.
3. JOIN the two lines.
4. Scale only the resulting polyline by `2` about the origin.
5. Actual: the dimension remains `10` and still references a deleted source ID.

JOIN was tested directly. EXPLODE uses the same problematic source-deletion/new-ID pattern in the reviewed code.

### Recommended implementation

Remap endpoint and segment references to the replacement geometry where correspondence is unambiguous. Where it is not, preserve the last measurement but explicitly mark the dimension as disassociated and provide a reassociation path. Review TRIM, FILLET, and CHAMFER for related topology changes; those additional cases were not exhaustively tested in this review.

### Acceptance checks

- [ ] JOIN/EXPLODE preserve traceable associations.
- [ ] Unresolvable references produce a visible disassociation indicator.
- [ ] Vertex/segment indices are not silently redirected to a different feature after topology changes.
- [ ] Undo restores the previous reference state.

## CAD-005 — Back up the outgoing live document before replacement

**Locations:** `writeAutosave()`, `newDrawing()`, `applyDocument()`, and autosave scheduling.

### Problem and reproduction

Backup rotation reads the prior persisted primary autosave. It does not capture the outgoing live document before replacing it. Edits newer than that persisted snapshot can be omitted from recovery.

1. Create one line and complete an autosave.
2. Add a second line.
3. Start a new drawing before the debounce completes.
4. Complete the new drawing's autosave.
5. Actual: the primary is blank and the previous backup contains only one line, although the outgoing drawing contained two.

The reproduction used the localStorage fallback. In-flight IndexedDB writes and replacement races need separate browser coverage.

### Recommended implementation

Capture and validate the outgoing document before New/Open replaces it. Coordinate backup writes, primary writes, and generation tracking across document changes. If preserving the outgoing document fails, make that failure visible before discarding the only live copy.

### Acceptance checks

- [ ] New/Open immediately after an edit preserve the outgoing document's latest committed geometry.
- [ ] A delayed write from an older document cannot supersede the current document's recovery state.
- [ ] Declining startup recovery still preserves the intended recovery copy.
- [ ] Browser tests cover IndexedDB and localStorage fallback behavior.

## CAD-006 — Clean up interactions when release occurs outside the canvas

**Location:** Canvas mouse handlers in `interaction/pointer.js`.

### Problem

Pan, selection, and grip release handling is attached to canvas `mouseup`. There is no document/window mouseup fallback or pointer capture. Starting a pan, moving outside the canvas, and releasing can leave `state.panning` true when the pointer returns. Related selection and grip state can also remain active.

### Recommended implementation

Use pointer events with pointer capture for active drags. Handle `pointerup`, `pointercancel`, and `lostpointercapture`, and clear transient drag/pan flags on window blur. Keep click-to-place grip editing distinct from drag completion so cleanup does not accidentally commit a command.

### Acceptance checks

- [ ] Releasing a pan outside the canvas stops panning.
- [ ] Selection/grip drags released outside terminate according to a defined rule.
- [ ] Switching windows during a drag does not leave stuck interaction flags.
- [ ] Cleanup does not commit geometry on cancellation or break click-to-place grips.

## Performance recommendations

### PERF-001 — Reduce whole-document work per edit

`commitGeometry()` validates and rebuilds the full entity collection, and `pushHistory()` stores a full document snapshot. Synthetic Node measurements averaged about **4.8 ms at 1,000 simple lines** and **62 ms at 10,000 lines** per commit over five timed iterations after warmup. A serialized 10,000-line history snapshot was approximately **862 KB**; actual heap usage differs.

Consider structural sharing or change-based undo, followed by validation of changed entities and affected dimensions. Preserve the existing atomic rejection of invalid edits. Benchmark real edits and representative drawings in the browser before selecting a design.

### PERF-002 — Reduce dense intersection-snap work

The aperture prefilter is useful, but nearby segments still enter pairwise intersection checks. Synthetic tests with lines crossing at the cursor averaged approximately **125 ms for 500 lines** and **284 ms for 1,000 lines** per snap query.

Deduplicate coincident candidates, investigate safe early exits for an exact highest-priority snap, and cache reusable geometry. A spatial index can improve broad searches, but does not by itself solve the case where hundreds of segments genuinely intersect inside the aperture. Preserve existing snap priority and coincidence semantics.

### PERF-003 — Cull offscreen geometry and cache derived data

`render()` visits every visible-layer entity, even when it lies outside the viewport. Cached bounds can support viewport culling, selection, and snapping. Cache segment geometry where useful and invalidate it when entities or relevant styles change. Include annotation extents when deciding visibility.

### PERF-004 — Use Sets for selection membership

Transform paths repeatedly evaluate `operation.ids.includes(entity.id)` while traversing the drawing. Construct a Set once per operation and reuse it in commit and preview paths to avoid repeated linear membership searches for large selections.

## Feature improvements after correctness fixes

1. **Curved-polyline TRIM/OFFSET/EXTEND:** These currently require EXPLODE. Supporting curves directly would remove a common workflow interruption and reduce exposure to broken associations.
2. **Editable Properties panel:** Prioritize precise editing of layer, coordinates, radius, text content/height, and dimension settings, with predictable mixed-selection behavior.
3. **DXF interchange:** Define a supported subset and explicit unsupported-entity handling before implementation. This would improve interoperability with established drafting tools.

## Suggested implementation batches

- [ ] **Batch 1:** CAD-001 and CAD-002, with focused association regression tests.
- [ ] **Batch 2:** CAD-003, with exported-PDF visual verification.
- [ ] **Batch 3:** CAD-004 and CAD-005, including topology and asynchronous recovery tests.
- [ ] **Batch 4:** CAD-006, verified through real browser pointer interactions.
- [ ] **Batch 5:** Profile representative browser workloads, then implement the measured performance improvements.
- [ ] **Batch 6:** Resume feature expansion after the correctness regressions pass.
