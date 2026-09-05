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

- 51-module ES architecture, zero dependency cycles, mutation-tested
- Versioned native JSON document format, with a validate-before-commit gate that rejects a bad edit before it can reach history
- Autosave with crash recovery (localStorage, not the IndexedDB originally planned — see Phase 1 below)
- Deterministic entity IDs, command-level undo/redo
- Full command set: line, polyline, rectangle, circle, arc, move, copy, rotate, scale, stretch, grips, join, explode, offset, trim, extend, plus inquiry commands (distance, area, id, list)
- Full snap set: endpoint, midpoint, intersection, center, quadrant, perpendicular, tangent, nearest
- Polar tracking, ORTHO, individual/window/crossing selection
- Layers and dimension styles
- Linear and aligned dimensions — **shipped but explicitly non-associative**, flagged in the UI ("Static dimensions: editing source geometry does not update its dimensions")

**Not yet started:** text, blocks, associative dimensions, a multi-selection properties panel, underlays, PDF/DXF output (Phase 3 remainder and all of Phase 4).

**Process note — read before planning further work:** Phase 0's benchmark validation (three drawings against a QCAD/AutoCAD baseline) was never run. The architectural refactor and Phase 2 build-out happened first, out of the order this roadmap specifies. See the status note in Phase 0 below before treating Phase 1/2 as validated.

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

### Status — did not happen in sequence (September 2026)

This validation was never run. The architectural refactor and most of Phase 2's
commands were built first — the opposite order this section calls for. Two
things now need checking at once, not one:

1. Is the core interaction model actually right? (the original question)
2. Did anything drift from it across the module split and feature build-out
   that followed? (a new question this gap creates)

Run the three benchmark drawings below against the **current** build before
starting text/blocks or any further geometry expansion. A defect found now is
more expensive than one found before the refactor, because more code now
depends on the behavior being tested.

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

- **Status (September 2026): the two items below did not come up during the
  refactor and are still open — not a deliberate decision to skip them.**
- Move production code to TypeScript modules. *(not done — still plain ES
  modules)*
- Add local save/open, **IndexedDB** autosave, and crash recovery.
  *(not done — currently `localStorage`. Worth prioritizing: per-edit cost
  already scales with document size — ~1.5ms at 100 entities, ~20ms at
  4,000 — and synchronous `localStorage` writes on every autosave are part
  of that cost. This gets worse once text/blocks push entity counts up.)*
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

### Status — associativity decided (September 2026)

Dimensions already shipped, but non-associative — the roadmap's original exit
gate treated "clearly marks them non-associative" as an acceptable fallback.
That's been decided against: **associative dimensions are required before
further Phase 3 work continues.** Text and blocks are on hold until this
ships.

### Features

- Layers
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
- Moving geometry updates associative dimensions. *(Decided September 2026 — non-associative is no longer an acceptable fallback here; see Status note above.)*
- Locked and hidden layers cannot be accidentally modified.

## 9. Phase 4 — Handle Inputs and Deliverables

### Underlays

- Import PDF pages, PNG, and JPEG.
- Move, rotate, scale, fade, and lock an underlay.
- Calibrate by selecting two points and entering a known distance.
- Preserve calibration and placement in the native drawing.
- Keep underlays visually separate from CAD geometry.

### PDF output

- Vector output rather than screenshots
- Standard construction page sizes plus custom sizes
- Window, extents, center, fit, and exact-scale modes
- Configurable monochrome/color and lineweights
- Print preview with explicit paper units and drawing scale

**Scale acceptance test:** a 100-foot model-space line exported at `1" = 20'` must measure 5.00 inches in the PDF coordinate system, within 0.01 inch. Physical printer error is separate from PDF correctness.

### DXF

- Start with an explicit whitelist: LINE, LWPOLYLINE, ARC, CIRCLE, TEXT/MTEXT, INSERT/BLOCK, DIMENSION where practical, and layers.
- Export before attempting broad import support.
- Provide a visible unsupported-entity report.
- Never silently discard unsupported geometry.
- Maintain round-trip fixtures using known files from QCAD and AutoCAD.

### Exit gate

- A real underlay can be calibrated and traced accurately.
- The resulting PDF is dimensionally correct at the selected scale.
- Supported DXF content round-trips without meaningful geometry changes.
- Unsupported content produces an actionable report rather than a broken or deceptively incomplete drawing.

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

1. **Run the Phase 0 benchmark validation retroactively**, against the
   current build — this was skipped, not completed out of order, and the
   roadmap's own sequencing assumed it would gate everything after it.
2. **Ship associative dimensions** — decided as a hard prerequisite for the
   rest of Phase 3, not an optional fallback.
3. Add text and blocks.
4. TypeScript migration and IndexedDB autosave — still open, not deliberately
   deferred; see Phase 1 status note.
5. Add calibrated underlays and exact-scale PDF output.
6. Add controlled DXF export/import.

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

