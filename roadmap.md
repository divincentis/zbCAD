# 2D Drafting Tool Roadmap

**Working roadmap — September 2026**

## 1. Product Strategy

The path to a useful product is not to build a smaller AutoCAD. It is to build one unusually good end-to-end workflow for 2d drafting purposes, supported by a disciplined but deliberately narrow 2D CAD core.

The generic geometry foundation should remain reusable, but every major release should be judged against this workflow:

> Starting with a blank drawing or a calibrated PDF/image underlay, a competent CAD user can create, annotate, quantify, save, reopen, and issue a commercial roof plan as an accurately scaled PDF and a useful DXF—without opening another CAD program.

That is the definition of a useful first product. A collection of drawing commands that cannot complete that workflow is still a prototype.

## 2. Product Boundaries

### In scope

- Desktop-first browser application
- Precise 2D geometry
- AutoCAD/QCAD-style mouse and keyboard behavior
- Lines, polylines, arcs, circles, text, dimensions, blocks, and hatches
- Layers and entity properties
- PDF/image underlays and calibration
- Accurate scaled PDF output
- Controlled DXF import/export
- Client-side operation, saving, and recovery initially

### Explicitly out of scope

- 3D of any kind
- BIM or Revit workflows
- DWG as a native format
- Real-time collaboration
- Mobile drafting
- Parametric solid modeling
- Mechanical, electrical, civil, CAM, or GIS specialization
- Cloud accounts or a backend until a demonstrated feature requires one

## 3. Current Position

**Updated September 2026 — this section was last accurate at the single-file-prototype stage and has been rewritten to match the current build (v0.24.3).**

The architectural refactor (Phase 1) and most of Phase 2 have already happened:

- 59-module ES architecture, zero dependency cycles, mutation-tested
- Versioned native JSON document format, with a validate-before-commit gate that rejects a bad edit before it can reach history
- Autosave with crash recovery, in IndexedDB, with a synchronous localStorage snapshot written only as the tab closes
- Deterministic entity IDs, command-level undo/redo
- Draw: line, polyline, rectangle, circle, arc, single-line and multiline text
- Modify: erase, move, copy, rotate, scale, mirror, stretch, grips, join, explode, offset, trim, extend, fillet, chamfer
- Annotate: linear, aligned, radius and diameter dimensions — **all associative** — plus dimension styles
- Inquiry: distance, area, id, list
- Full snap set: endpoint, midpoint, intersection, center, quadrant, perpendicular, tangent, nearest
- Polar tracking, ORTHO, individual/window/crossing selection
- Layers, with name, visibility, lock, colour, linetype, lineweight and printability

**Correction, September 2026:** this section previously claimed a "full command set" while ERASE, MIRROR, FILLET, CHAMFER, DIMRADIUS and DIMDIAMETER did not exist — there was no way to erase except the Delete key, and no way to type it at all. All six have since been added. Phase 2's exit gate ("benchmark roof geometry can be built without manual workarounds") was not honestly met before that, because a symmetric plan with filleted corners could not be drawn without them.

**Known gaps in what is listed above:** there is no properties panel for multi-selection editing. FILLET and CHAMFER handle polyline segments (including the shared vertex of two adjacent segments, the everyday "round/chamfer this corner" case) as well as plain lines, arcs and circles; polylines now hold a curved segment, so rounding a polyline corner leaves one polyline rather than a polyline plus a loose arc. OFFSET, TRIM and EXTEND do not reshape a polyline that has a curved segment and refuse it by name (EXPLODE first).

**Update September 2026: layer record completed (linetype, lineweight, printability).** Each layer now carries a `linetype` (continuous/dashed/dotted/dashdot/center), a `lineweight` (the standard CAD mm table, e.g. 0.25, 0.50, 1.00) and a `printable` flag, editable from the layer panel. Rendering applies a layer's linetype and lineweight to its entities' strokes (dimension and text entities are exempt, matching standard CAD convention that dimension lines/text carry their own style rather than the layer's); on-screen line width is a fixed pixel-per-mm multiple rather than something that scales with zoom, so lineweight stays legible at any view scale, and the multiplier was chosen so the previous default (0.25mm) reproduces the exact pre-feature line width — existing drawings render unchanged. `printable` had no effect when it shipped, since PDF output did not exist yet; it was stored so PDF output (the next item) would have something to read instead of adding it retroactively, and it now excludes a layer from the plotted sheet. Legacy files (pre-version-5, no linetype/lineweight/printable on their layers) open with all three defaulted exactly as a v4 file would have looked if it could have held them; garbage/out-of-table values in a hand-edited file are cleaned to those same defaults rather than rejected. `model/layers.js`, `model/document.js`, `core/constants.js`, `core/defaults.js`, `view/render.js`, `ui/layerPanel.js`. 36 new headless checks in `test-layers.mjs` (covering defaults, setter validation, save/reload round-trip, and legacy/garbage-file migration), full suite still green. Verified live in a real (headless) Chromium session: layer panel renders correctly with multiple layers, and lines drawn on layers with different linetypes/lineweights/printability render visibly distinctly.

**Update September 2026: exact-scale PDF output shipped.** `PLOT` (`PLT`/`PRINT`, Ctrl/Cmd+P) writes the drawing as vector PDF at an exact drawing scale or fitted to the sheet — see the Phase 4 status note for what is and is not covered. Two new modules do the work: `output/plot.js` reduces the drawing to a plot plan (primitives in millimetres on the sheet, Y up) and `output/pdf.js` serialises that plan into PDF operators, using only the base-14 fonts so nothing has to be embedded. Keeping the plan separate from the writer is what makes the roadmap's scale acceptance test assertable directly rather than by rendering a page and measuring pixels. The drawing-scale preset list moved to a new `core/paper.js` and is now shared with the dimension style dialog, which needs the same number for its DIMSCALE — and gained the engineering scales (1" = 20' and friends) a roof plan is actually drawn at.

**Update September 2026: multiline text (MTEXT) shipped.** `MTEXT`/`MT` follows single-line TEXT's staged point/distance/angle-then-free-text shape with one addition: after the insertion point, an opposite corner (or typed distance) sets a fixed wrap width, then height and rotation as before, then content — except content is multi-line, so each Enter commits one line and stays in the command, and a blank Enter is what finishes entry (the same command-line shape AutoCAD's own MTEXT uses). Word wrap is estimated the same way TEXT's single-line footprint already was (character count × height × a fixed factor, since no real glyph metrics exist outside a canvas context), with a hard break for any single word wider than the box. MTEXT is wired into every place TEXT already was — bbox, hit-testing, move/rotate/scale/mirror/stretch, grips (an insertion-point grip plus a width grip, since there is no properties panel yet to type a new width into), save/load validation, ID/LIST, and PDF output (one plotted text run per wrapped line). Also fixed, for both TEXT and MTEXT: the content being typed previously showed only in the command-line input box, not on the drawing, until Enter committed it — every keystroke now updates an on-canvas preview too. 61 new headless checks in `test-mtext.mjs`; also verified in a real (headless) Chromium session that a multi-line box wraps and renders correctly and that the live preview actually appears on canvas while typing, not just in the command line.

**Not yet started:** blocks, leaders and callouts, hatches, a multi-selection properties panel (all Phase 3 remainder).

**Update September 2026: calibrated underlays and DXF import/export shipped.** Both are described in Phase 4's status notes below. This closes Phase 4 and the product definition in section 1: a drawing can now enter the tool as a calibrated PDF/image underlay, be traced and annotated, and leave as an accurately scaled PDF or a useful DXF, without another CAD program.

**Process note:** Phase 0's benchmark validation was run retroactively — the mechanical pass headlessly (see the Phase 0 status note), and the human feel-pass by the product owner in September 2026. Phase 0 is closed.

## 4. Roadmap at a Glance

| Phase | Objective | Primary exit gate |
|---|---|---|
| 0. Validate the feel | Confirm the core CAD interaction contract | No blocking friction in navigation, commands, selection, coordinates, or snaps |
| 1. Build the product foundation | Replace prototype accretion with maintainable architecture | Current workflows behave identically and survive save/reopen/recovery |
| 2. Complete core drafting | Add the geometry and editing tools needed for architectural plans | Benchmark building geometry can be created without workarounds |
| 3. Produce drawing documents | Add layers, properties, text, dimensions, and blocks | A complete annotated roof plan can be saved and reopened faithfully |
| 4. Handle source and output files | Add underlays, calibration, scaled PDF, and DXF | A real drawing can enter and leave the tool accurately |
| 6. Pilot and harden | Use it on real internal projects | Ten parallel-use projects with no data loss and little fallback to other CAD |
| 7. Decide distribution | Choose internal tool or commercial product | Evidence supports the added cost of external distribution |

## 5. Phase 0 — Validate the Interaction Model

### Status — closed, out of sequence (September 2026)

This validation was not run in the order this section calls for: the
architectural refactor and most of Phase 2's commands were built first. It was
run retroactively against the current build instead, in two passes:

1. **Mechanical**, headlessly against the built bundle through the
   `window.__cadPrototype` test hook — commands, point-entry grammars, snaps,
   ortho/polar, window and crossing selection, undo/redo guarding, and the
   transforms. Result: 1 blocker (benchmark 3 needs underlays, which do not
   exist yet — expected), 1 low-severity friction, 0 defects. See
   `phase0-validation-report.md`.
2. **Human feel-pass**, by the product owner — pan/zoom smoothness, snap-marker
   legibility, and the timing baseline, none of which a headless run can
   assess. Completed and accepted.

Phase 0 is closed. The one thing it could not cover remains open by
construction: benchmark 3 depends on calibrated underlays, so it is a Phase 4
gate rather than a Phase 0 one.

### Purpose

The user experience is the product's highest-risk component. CAD users have strong muscle memory, and small deviations compound quickly.

### Test with three benchmark drawings

1. **Simple roof from scratch**
   - Rectangular perimeter
   - Four RTUs
   - Two drains
   - Several dimensions

2. **Irregular roof from scratch**
   - Multiple offsets
   - Interior roof areas
   - Expansion joint
   - Numerous penetrations

3. **Roof traced from an underlay**
   - Existing PDF or image
   - Known calibration distance
   - Perimeter and several rooftop objects

Create the first two in QCAD or AutoCAD as a baseline. Record completion time and major command count approximately; precision is unnecessary.

### Feedback categories

- **Blocker:** prevents completing a normal drafting action
- **Friction:** action works but breaks muscle memory or takes too many steps
- **Defect:** result is geometrically or visually wrong
- **Enhancement:** useful but not necessary for the benchmark workflow

### Exit gate

- Pan and zoom feel natural.
- Commands reliably start, advance, finish, and cancel.
- Direct distance, Cartesian, and polar input are predictable.
- Selection behaves correctly in both directions.
- Required snaps are visible and trustworthy.
- Line, polyline, move, and copy have no blocking workflow issues.
- Every observed defect has a repeatable test case.

Do not proceed merely because the commands technically work. Proceed when the interaction contract is stable enough that later commands can follow it consistently.

## 6. Phase 1 — Build the Product Foundation

### Purpose

The current all-in-one prototype is useful for experimentation but should not become the product through endless additions. Refactor after Phase 0, while the behavior is understood and the feature count is still small.

### Foundation work

- **Status (September 2026): the TypeScript item below did not come up during
  the refactor and is still open — not a deliberate decision to skip it.**
- Move production code to TypeScript modules. *(not done — still plain ES
  modules)*
- Add local save/open, **IndexedDB** autosave, and crash recovery. *(done —
  September 2026. See the note under priority 8 below for what the move did
  and did not buy.)*
- Keep Canvas 2D unless measured performance proves it insufficient.
- Separate the application into:
  - Document/entity model
  - Command state machine
  - Geometry engine
  - Spatial index
  - Renderer
  - Selection and snapping services
  - File and export adapters
  - UI shell
- Represent every drawing change as one reversible transaction.
- Define a versioned native JSON drawing schema. *(done)*
- Store units and drawing settings explicitly. *(done)*
- Establish migration tests so later schema versions can open earlier drawings.
- Add deterministic entity IDs rather than relying on screen objects.

React or another UI framework may help organize panels and dialogs, but it is not the critical architectural choice. The document model and command/geometry separation are.

### Exit gate

- Every current prototype workflow behaves the same after the refactor.
- Refreshing or closing the browser cannot silently lose the active drawing.
- Undo and redo operate at command level.
- A saved drawing reopens with identical geometry and settings.
- Pan, zoom, selection, and snap queries remain responsive with 10,000 simple entities.

## 7. Phase 2 — Complete Core Drafting

Build in thin vertical slices. Each command must include preview behavior, keyboard entry, snapping, undo/redo, selection interaction, and automated geometry tests before it is considered complete.

### Recommended order

1. Closed polyline and Close option
2. Rectangle
3. Circle
4. Arc: three-point and center/start/end
5. Center and quadrant snaps
6. Rotate
7. Scale
8. Basic vertex and endpoint grips
9. Join and explode
10. Offset
    - Line first
    - Circle second
    - Open polyline third
    - Closed polyline only after the simpler cases are robust
11. Trim and extend
    - Line/line first
    - Line/circle and line/arc next
    - Arc combinations last
12. Nearest and tangent snaps
13. Polar tracking
14. Stretch after grip behavior is stable

### Geometry acceptance discipline

Each geometry operation needs fixtures for:

- Horizontal, vertical, and oblique geometry
- Very short and very long segments
- Parallel and nearly parallel lines
- Tangencies
- Multiple valid intersections
- Collinear and overlapping segments
- Zero-length and duplicate points
- Large and negative coordinates
- Operations near numeric tolerances

Do not hide unsupported cases. Reject them clearly and preserve the original geometry.

### Exit gate

- Benchmark roof perimeters and rooftop geometry can be built without manual workarounds.
- Every modification is previewed before commitment.
- Every modification can be undone in one step.
- Invalid geometry never corrupts or deletes the source entity.

## 8. Phase 3 — Produce Real Drawing Documents

### Status — associative dimensions shipped (2026-09-05)

Dimensions had shipped non-associative — the roadmap's original exit gate
treated "clearly marks them non-associative" as an acceptable fallback. That
was decided against: associative dimensions were made a hard prerequisite for
further Phase 3 work, and they are now implemented. Moving, rotating,
scaling, or stretching geometry that a dimension measures now updates that
dimension automatically; a reference that stops resolving (its entity was
deleted, trimmed, or otherwise structurally replaced) freezes the dimension
at its last measured value instead of erroring. Verified headlessly and
accepted in the product owner's live pass.

Radial dimensions followed in September 2026: DIMRADIUS (circles and arcs)
and DIMDIAMETER (circles only — on an arc the far end of the diameter is not
on the arc, so the reference would not resolve and the dimension would
distort the moment the arc moved). Both are associative through the same
machinery. Before them, the only way to dimension a circle was to click two
arbitrary points on its boundary, which is what made the earlier associative
-reference bug possible.

**Still not associative:** a dimension referencing an intersection,
perpendicular or tangent point. Those depend on two entities' relationship
rather than one entity's own geometry, so they need a reference type that
does not exist yet.

### Status — single-line text shipped (2026-09-05)

Single-line TEXT entities can now be placed (insertion point, height,
rotation, content), moved, rotated, scaled, stretched, and grip-edited, with
save/load validation and an ID/LIST inquiry report. Multiline text and
blocks are deliberately not started — scoped out for this pass. Verified
headlessly and accepted in the product owner's live pass.

### Status — multiline text (MTEXT) shipped (September 2026)

MTEXT entities can now be placed (insertion point, opposite corner or typed
distance for a fixed wrap width, height, rotation, multi-line content), moved,
rotated, scaled, mirrored, stretched, and grip-edited (insertion point and
wrap width), with save/load validation, an ID/LIST inquiry report, and PDF
output. Word wrap is an estimate from character count, matching how TEXT's
own footprint was already approximated in the absence of real glyph metrics.
Blocks remain deliberately not started. The command-line content-typing
preview gap flagged nowhere before this (typed text did not appear on the
drawing until Enter) was fixed for both TEXT and MTEXT in the same pass.
Verified headlessly (61 checks) and in a real Chromium session.

### Status — core command gaps closed (September 2026)

ERASE, MIRROR, FILLET, CHAMFER, DIMRADIUS and DIMDIAMETER were added; see the
correction in section 3 for why they were missing. FILLET and CHAMFER cover
line/line corners and refuse every other combination by name, so polyline
corners remain an open extension.

### Status — layer record completed (September 2026)

Linetype, lineweight and printability were added to the layer record; see the
Current Position update in section 3 for detail. The layer record is now
complete as originally scoped below.

### Features

- Layers *(complete)*
  - Name
  - Visibility
  - Lock
  - Color
  - Linetype
  - Lineweight
  - Printability
- Properties panel with multi-selection editing
- Single-line and multiline text
- Linear and aligned dimensions
- Minimal dimension styles
- Leaders and callouts
- Reusable blocks with insertion points
- Basic hatches after closed-boundary behavior is reliable
- Layer `0` and ByLayer behavior for DXF compatibility

### Exit gate

- A benchmark roof plan can be fully annotated.
- Reopening the native file preserves appearance and geometry.
- Moving geometry updates associative dimensions. *(Shipped 2026-09-05, human pass accepted — see Status note above.)*
- Locked and hidden layers cannot be accidentally modified.

## 9. Phase 4 — Handle Inputs and Deliverables

### Status — exact-scale PDF output shipped (September 2026)

The PDF half of this phase is built. `PLOT` (`PLT`/`PRINT`, Ctrl/Cmd+P) writes
the drawing as real vector geometry — no rasterisation, no library — through a
plot plan (`output/plot.js`) that reduces the drawing to primitives in
millimetres on the sheet, and a serialiser (`output/pdf.js`) that writes those
primitives as PDF operators. Splitting it that way is what lets the scale
acceptance test below be asserted directly rather than inferred from a
rendered page.

Shipped: the ANSI/ARCH/ISO sheet sizes in both orientations with a half-inch
margin; extents, display and picked-window plot areas; fit-to-sheet and exact
scale, with the drawing-scale list now shared with the dimension style dialog
(and extended with the engineering scales a roof plan is actually drawn at);
centred or corner placement; monochrome or layer colors; layer lineweights in
their real millimetres; layer linetypes as paper-length dashes. Hidden and
non-printable layers are excluded, which is the first thing the `printable`
flag added with the layer record actually does. An exact-scale plot too large
for the sheet is clipped to the printable area and warned about rather than
silently cropped or rescaled.

**The scale acceptance test below passes**, asserted two ways in
`tools/tests/test-plot.mjs`: in millimetres on the plan, and in points parsed
back out of the finished PDF's content stream. Output is deterministic (no
timestamps), so two plots of the same drawing are byte-identical and can be
diffed. Files were verified to open in poppler and Ghostscript and to render
correctly.

Deliberately not built yet: plot styles/pen tables, multi-sheet output, a
graphical print preview (the dialog reports the plotted size, scale and
warnings as text instead), and any title block — a title block wants blocks,
which are still not started.

### Status — calibrated underlays shipped (September 2026)

A PNG, JPEG, or PDF page can be imported as an underlay, then moved, rotated,
scaled, faded, and locked, and calibrated by picking two points and entering
a known real-world distance. Underlays are stored separately from drawing
entities (`state.underlays`, not `state.entities`) but share the existing
layer table, so visibility, lock, and printability need no parallel system,
and they participate in MOVE/COPY/ROTATE/SCALE/MIRROR/ERASE and selection
like any other object. They plot: the underlay's raster travels through the
PDF writer as a filtered JPEG stream rather than being dropped at print time.
Images are re-encoded to JPEG and capped at 2400px on import, since the
payload rides inline in the native document's JSON. Verified headlessly (132
checks in `tools/tests/test-underlay.mjs`) and in a real Chromium session.

### Status — DXF import and export shipped (September 2026)

`DXF` writes R2000/AC1015 ASCII DXF and reads it back. Import and export
share one intermediate plan, so a round trip can be asserted as
plan → text → plan without going through the document model. Covered: LINE,
LWPOLYLINE (including bulged/curved segments), ARC, CIRCLE, TEXT/MTEXT,
INSERT/BLOCK (flattened on import), DIMENSION (built from the same geometry
PLOT already uses, so there is no second dimension renderer to drift), and
layers. Import approximates ellipses and splines and reports every skip or
approximation to the inquiry panel rather than discarding anything silently.
Deliberately not done: DXF `IMAGE` entities for underlays (export warns
instead), angular/ordinate dimensions (no zbCAD model for them — their block
geometry is exploded on import), and inserting a DXF into the current
drawing rather than replacing it. Verified headlessly (154 checks in
`tools/tests/test-dxf.mjs`) and against FreeCAD as an independent DXF
reader/writer.

### Underlays *(shipped — see Status note above)*

- Import PDF pages, PNG, and JPEG.
- Move, rotate, scale, fade, and lock an underlay.
- Calibrate by selecting two points and entering a known distance.
- Preserve calibration and placement in the native drawing.
- Keep underlays visually separate from CAD geometry.

### PDF output *(shipped — see Status note above)*

- Vector output rather than screenshots
- Standard construction page sizes plus custom sizes
- Window, extents, center, fit, and exact-scale modes
- Configurable monochrome/color and lineweights
- Print preview with explicit paper units and drawing scale

**Scale acceptance test:** a 100-foot model-space line exported at `1" = 20'` must measure 5.00 inches in the PDF coordinate system, within 0.01 inch. Physical printer error is separate from PDF correctness. *(Passes — see the PDF status note above.)*

### DXF *(shipped — see Status note above)*

- Start with an explicit whitelist: LINE, LWPOLYLINE, ARC, CIRCLE, TEXT/MTEXT, INSERT/BLOCK, DIMENSION where practical, and layers.
- Export before attempting broad import support.
- Provide a visible unsupported-entity report.
- Never silently discard unsupported geometry.
- Maintain round-trip fixtures using known files from QCAD and AutoCAD.

### Exit gate

- A real underlay can be calibrated and traced accurately. *(Met.)*
- The resulting PDF is dimensionally correct at the selected scale. *(Met.)*
- Supported DXF content round-trips without meaningful geometry changes. *(Met.)*
- Unsupported content produces an actionable report rather than a broken or deceptively incomplete drawing. *(Met.)*

**Phase 4 is closed.**

## 11. Phase 6 — Internal Pilot and Hardening

### Pilot structure

- Begin with one primary user.
- Add two or three estimators/PMs only after the complete workflow works for the primary user.
- Run the tool in parallel with the current process on ten real projects.
- Do not make it the sole source of a required deliverable during the early pilot.

### Measure

- Time to complete each benchmark and real architectural plan
- Percentage of drawings completed without falling back to QCAD/AutoCAD
- Number of blocker and friction issues per drawing
- Crash and recovery behavior
- Save/reopen failures
- Quantity discrepancies
- PDF scale failures
- Unsupported DXF entities encountered in actual work

### Pilot exit targets

- Zero lost drawings.
- Zero silently corrupted drawings.
- Ten real projects completed in parallel.
- At least 90% of the target plan workflow completed without another CAD tool.
- Median completion time no worse than the existing tool; the features should subsequently make it faster.
- New users can complete the simple benchmark with a one-page command reference and no live coaching.

## 12. Phase 7 — Decide Internal Tool vs. Commercial Product

Do not make this decision based on enthusiasm for the prototype. Make it after repeated internal use.

An internal static application can remain relatively simple. A commercial product adds substantial work that does not improve drafting directly:

- Authentication and account recovery
- Cloud storage and backups
- Organization administration
- Security and privacy reviews
- Browser and device support matrix
- Analytics and support tooling
- Billing
- Documentation and onboarding
- Third-party license review
- Terms, privacy policy, and support obligations
- Migration and compatibility commitments

If the internal pilot is successful, decide deliberately among:

1. Keep it as a focused internal productivity tool.
2. Offer it narrowly to other roofing offices or contractors.
3. Develop it as a general commercial 2D drafting product.

Option 3 is a different business, not merely another development phase.

## 13. Working Method

### Product owner responsibilities

The highest-value contribution from the domain expert is not writing code. It is:

- Supplying representative drawings and workflows
- Testing short releases for 20–30 minutes
- Reporting exact command sequences, expected behavior, and actual behavior
- Ranking issues by blocker, friction, defect, or enhancement
- Rejecting features that do not improve the target workflow
- Accepting or rejecting each phase gate

### Development responsibilities

- Ship no more than two or three new interaction behaviors per test release.
- Turn every reported defect into a permanent regression test.
- Keep geometry independent of the renderer.
- Keep releases reversible and drawings backward-compatible.
- Maintain a short decision log and explicit unsupported-case list.
- Measure performance before changing rendering technology.

### Feedback format

For each issue, record:

1. Command or action
2. Starting state
3. Exact input sequence
4. Expected result
5. Actual result
6. Severity
7. Screenshot or short screen recording when visual behavior matters

This is much more actionable than “it feels weird,” while still preserving feel as a legitimate product criterion.

## 14. Immediate Backlog from the Current Prototype

**Reordered September 2026 to match what's actually built.** Items 4–10 below
shipped during the refactor, out of the original sequence (see Phase 0 status
note). What's left:

1. ~~**Run the Phase 0 benchmark validation retroactively**~~ — done. The
   mechanical pass ran headlessly against the built bundle; the human
   feel-pass was completed by the product owner in September 2026. Closed.
2. ~~**Ship associative dimensions**~~ — shipped 2026-09-05. Was the hard
   prerequisite for the rest of Phase 3.
3. ~~Single-line text~~ — shipped 2026-09-05.
4. ~~**Fill the gaps in the core command set**~~ — shipped September 2026:
   ERASE, MIRROR, FILLET, CHAMFER, DIMRADIUS, DIMDIAMETER. These were assumed
   present by the "full command set" line above and were not; see the
   correction in section 3.
5. ~~**Complete the layer record: linetype, lineweight, printability.**~~ —
   shipped September 2026. Was a prerequisite for PDF/DXF's lineweight and
   ByLayer semantics, done before rather than after Phase 4 for that reason.
6. ~~**Exact-scale PDF output, and calibrated underlays.**~~ — both shipped
   September 2026. See the Phase 4 status notes. A drawing can now be traced
   from an existing PDF or image, as well as created from a blank sheet,
   annotated, and issued.
7. ~~Add controlled DXF export/import.~~ — shipped September 2026. See the
   Phase 4 status note. Phase 4 is closed; item 6 and item 7 together were
   the last of the roadmap's product definition in section 1.
8. ~~IndexedDB autosave~~ — shipped September 2026. `model/autosaveStore.js`
   holds the drawing in IndexedDB; localStorage now carries only the snapshot
   written synchronously from `beforeunload` (an IndexedDB transaction opened
   there is routinely aborted before it commits), plus autosaves left by
   earlier versions. Recovery reads both slots and takes whichever is newer,
   which is why the localStorage copy is timestamped in a sibling `.at` key.
   Recovery is asynchronous now, so it lands just after boot rather than
   during it and stands down if the user drew something first.

   **What this did not fix, measured after the move:** the synchronous cost of
   an autosave is no longer the write, it is `exportDocumentText` — ~32 ms at
   4,000 entities on the development machine, of which only ~3 ms is
   `JSON.stringify`. The rest is `documentSnapshot`'s deep clone plus
   `validateDocumentData` re-walking every entity, on the debounce timer, on
   the main thread. That validation is deliberate (an invalid live document
   must never reach a saved copy), so the fix is to make it cheaper or
   incremental rather than to drop it. This is the next thing to do about
   autosave cost, and it matters more than the write ever did.

   **Verified in a real browser**, since the doubt worth having was whether a
   page opened straight off disk gets a database at all: driven over the
   DevTools protocol in Chromium 152 at a `file://` URL, an edit autosaved to
   IndexedDB (`source: "db"`, localStorage left empty), an edit made inside
   the debounce window and then unloaded left the newer copy in localStorage,
   and a *second browser session* on the same profile offered "Recover the
   unsaved drawing (2 objects)?" at boot and restored it. The headless suite
   additionally covers the two fallbacks — no database at all, and a database
   that opens and then refuses every transaction — against a stub.
9. TypeScript migration — **deliberately deferred**, on the strength of
   section 18. It is a large mechanical change that does not help anyone
   create, annotate, quantify or issue a plan. Reconsider only if type errors
   start causing real defects.
10. Light/dark mode toggle — **deliberately deferred**, same rule as above:
    UI polish, not a drafting capability, and fails the section 18 test as
    stated. Logged because the user asked about scope (2026-09-05), not
    because it's scheduled. Scoped so a future session doesn't have to
    re-derive this: the app is dark-themed only today, with no color
    variables anywhere. `src/shell.html`'s CSS has ~30+ hardcoded hex colors
    for chrome (toolbar, panels, dialogs, command line), and canvas drawing
    code (`view/render.js`, `view/grid.js`, `view/plotPreview.js`) has
    another ~30+ hardcoded `strokeStyle`/`fillStyle` literals for grid,
    entities, selection highlight, snap markers, dimension previews, and the
    plot preview — none of it routed through variables. A real
    implementation needs: CSS custom properties for chrome plus a light
    palette, a parallel canvas color palette the render code reads instead
    of literals, a toggle control with `localStorage` persistence, and a
    manual pass over every drawing mode in both themes to make sure nothing
    goes invisible (e.g. a white selection highlight over a white
    background). Rough estimate: a half-day-ish focused pass, not a
    one-liner. Revisit if it's ever bundled with other UI-polish work, or if
    the product moves toward external/commercial distribution (Phase 7)
    where a dark-only UI becomes a harder sell.

**Update 2026-09-05: FILLET and CHAMFER extended to polyline corners.** Both
now accept a polyline segment wherever they previously required a plain LINE,
including the common case of two adjacent segments of the same polyline
sharing a corner vertex (e.g. rounding or chamfering a rectangle's corner).
CHAMFER on a shared vertex splits it into the two cut points in place — still
one PLINE, no separate bridging LINE needed, since the cut is already the
polyline's own new edge. FILLET on a shared vertex is refused by name: this
app's polylines have no curved (bulge) segment, so there is nowhere to put
the arc without breaking the polyline apart, which was judged out of scope
here. FILLET/CHAMFER between a line and a polyline segment, or between two
non-adjacent segments (same or different polylines), work like today's
line/line case — each edge trims independently, with an ARC or cut LINE
bridging them. `geometry/fillet.js`, 19 new headless checks in
`test-corners.mjs`.

**Extensions the current work leaves open:** a dimension referencing an
intersection, perpendicular or tangent point, which has no reference type and
so does not associate. (FILLET on a polyline's own shared vertex, listed here
until September 2026, is done — see the curved-segment update below.)

**Update 2026-09-05: FILLET extended to arcs and circles, in any combination.**
Previously FILLET (like CHAMFER) refused any ARC or CIRCLE by name. It now
fillets a line/polyline segment against an arc or circle, or two arcs/circles
against each other. A line/line corner has one intersection point to build
the arc from; two general curves generally don't (a line and a circle can
cross twice, once, or not at all), so the new path instead constructs, for
each edge, the loci a fillet centre of the given radius could sit at (an
offset line, or a concentric circle at radius±R), intersects every pairing of
the two edges' loci, and keeps whichever resulting tangent circle's contact
points land nearest the two points actually clicked — the same
closest-to-your-picks rule a person uses when disambiguating this by hand. A
CIRCLE is never trimmed (it has no endpoint to move); an ARC's nearer
endpoint moves to the tangent point, same as a LINE's. CHAMFER is unchanged
and still refuses arcs/circles by name — a straight cut at an arc-length
distance from a curve is a murkier idea than a radius, and was judged out of
scope here. `geometry/fillet.js`, `commands/modify.js` (FILLET's prompt now
says "edge" rather than "line," since it's no longer only lines). 26 new
headless checks in `test-corners.mjs`, covering line/circle, line/arc
(including that the arc's *far* endpoint is the one that moves), and
circle/circle, plus the zero-radius and no-valid-solution refusals; asserted
by tangency and distance-from-centre rather than only precomputed
coordinates, per this file's own geometry-testing discipline.

**Update September 2026: polylines hold curved segments, and FILLET rounds a
polyline's own corner.** The one case FILLET refused — two adjacent segments of
the same polyline meeting at one of its vertices, the everyday "round this
rectangle's corner" — now works, and leaves a single polyline rather than a
polyline plus a loose arc. Round all four corners of a rectangle and you still
have one object; its reported perimeter and area follow the arcs.

A polyline segment is curved by a **bulge**: DXF's number, the tangent of a
quarter of the arc's included angle, signed positive counter-clockwise, stored
in an optional `bulges` array parallel to `points` (entry *i* curves the
segment leaving vertex *i*). Storing the curve that way rather than as a centre
and radius is what makes the change survive the rest of the app: a bulge is
invariant under translation, rotation and uniform scale, so MOVE/ROTATE/SCALE
never had to learn about it, and only MIRROR — which reverses the sense of
rotation — touches it, by changing its sign. The array is omitted entirely
while every segment is straight, so an all-straight polyline is byte-identical
to one saved before the feature existed.

`entitySegments()` in `model/entity.js` is the choke point: every segment it
returns is now `[a, b, arc]`, with `arc` null for a straight one. Callers that
predate curved segments destructure `[a, b]` and read the chord, so each was
visited deliberately rather than left to be discovered — rendering, picking,
object snap (a curved segment now snaps as an arc: endpoint, midpoint, centre,
quadrant, perpendicular, tangent, nearest, intersection), window/crossing
selection, bounding box and zoom-extents, length and area, associative
dimension references along a segment, PDF plotting (bezier pieces spliced into
the polyline's own path), EXPLODE (a curve leaves as a real ARC) and JOIN
(which now accepts an arc, since there is somewhere to put it — the comment
saying it could not has been there since JOIN shipped).

**What deliberately does not handle a curve, and says so:** OFFSET, TRIM and
EXTEND. Each is built on straight segments in a way that would have to be
re-derived rather than extended — offsetting means offset arcs joined by
arc/line intersections, trimming means rebuilding a path that can hold curves —
and each refuses by name and points at EXPLODE, per this file's rule that an
unsupported case is reported and the original geometry preserved. FILLET and
CHAMFER likewise refuse a segment that is *already* curved: a rounded corner
has no straight direction to build the next one from.

`DOCUMENT_VERSION` 5 → 6. A bulge list whose length disagrees with the points
is rejected rather than resized, deliberately: every internal path that
reshapes a polyline has to reshape its bulges with it, and a stale array
quietly truncated back into range would draw a plausible curve on the wrong
segment. 71 new headless checks in `test-bulges.mjs`.

**Update September 2026: CIRCLE gained Tangent-Tangent-Radius (Ttr).** Pick a
point on each of two objects — line, polyline segment, arc or circle — and give
a radius; the circle of that radius touching both is drawn. The construction is
the one FILLET already used for curved edges, so it moved into a new
`geometry/tangentCircle.js` that both commands consume rather than being
written twice: for each edge, the loci a candidate centre could sit at (an
offset line either side, or a concentric circle at radius ± R), intersected in
every pairing, giving up to eight valid answers. Which one the user meant is
decided the same way a person decides it — the solution whose contact points
land nearest the two points actually clicked — with a preference, ahead of
that, for solutions touching the drawn objects rather than their extensions.
Tangency to an extension is still offered when nothing else fits, since a
circle tangent to where two walls *would* have met is a real construction.
42 new headless checks in `test-ttr.mjs`.

Moving that construction out also let `graph.py` gain a check it was missing:
that an imported name is actually exported by the module named. The bundle is
one flat scope, so a stale import still resolves there and only shows up as a
module graph that no longer describes the program — which is exactly what had
happened to `commitGeometry`, imported from `model/document.js` by twelve
modules when it lives in `model/history.js`. All twelve are corrected.

**Update September 2026: TRIM gained a Fence option.** Typing `F` (or
`FENCE`) mid-TRIM switches from clicking one piece at a time to drawing a
polyline; Enter then trims everything it crossed in one pass, at the point it
crossed each object, instead of requiring a boundary to be picked before each
click. This was the last item on the 2026-09-08 live-testing punch list
(`fence trim` in AutoCAD terms), deliberately deferred until now. The new
`geometry/fence.js` adds no trimming logic of its own: a fence crossing is
just a click point computed instead of clicked, so it is handed to the same
`calculateTrimOperation`/`replaceEditedEntity` pair a literal click already
uses, which is what makes it inherit every existing rule (preselected
boundaries, self-intersection, the curved-polyline refusal) for free. EXTEND
deliberately does not gain Fence — TRIM's `F` keyword and its Undo are only
attached to TRIM's command object, not shared with EXTEND's. 37 new headless
checks in `test-fence-trim.mjs`.

<details>
<summary>Already shipped (original items 4–10)</summary>

- Refactored into a 51-module production architecture
- Native save/open, autosave, and crash recovery
- Closed polyline, rectangle, circle, arc
- Rotate and grips
- Layers, via a dedicated layer panel — **no multi-selection properties panel yet** (checked: no properties module in `ui/`)
- Offset, trim, extend

</details>

## 15. Decisions to Make Before the Native File Format Freezes

- Canonical internal unit representation
- Precision and displayed rounding rules
- Supported browsers and minimum screen size
- Native drawing file extension and schema policy
- Whether underlays are embedded or linked
- Initial supported PDF page sizes and scale list
- Initial DXF version and entity whitelist
- Third-party geometry/DXF library licenses
- Whether eventual external distribution is plausible enough to avoid restrictive dependencies now

## 16. Risk Controls

| Risk | Control |
|---|---|
| Feature creep | Require every feature to advance the benchmark architectural plan workflow |
| Fragile geometry | Narrow the supported matrix, use fixtures, and reject unsupported cases visibly |
| Prototype becomes unmaintainable | Refactor immediately after the interaction contract is validated |
| Data loss | Versioned native files, autosave, recovery, migrations, and corruption tests |
| Incorrect printed scale | Test PDF coordinates independently of printers from the first output release |
| DXF becomes endless | Whitelist entities, export first, report unsupported content, test real files |
| User testing becomes a bottleneck | Use short releases and fixed 20–30 minute benchmark sessions |
| Open-source licensing limits future options | Review dependency licenses before adoption, especially browser-distributed code |
| Premature backend complexity | Remain client-side until an approved feature demonstrably requires a server |

## 17. Realistic Time Horizon

With one focused developer and weekly access to a decisive domain tester:

- **Useful internal alpha:** approximately 8–12 focused weeks
- **Dependable internal production tool:** approximately 3–6 months
- **Polished product for outside users:** substantially longer and dependent on compatibility, support, and business scope

AI-assisted coding can compress implementation time, but it does not eliminate geometry edge cases, interaction testing, file compatibility work, or production hardening. The phase gates are more reliable than calendar promises.

## 18. The Rule That Protects the Project

Before adding any feature, ask:

> Does this measurably help a user create, annotate, quantify, or issue a commercial architectural plan faster and more reliably?

If not, defer it.

