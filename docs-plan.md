# Tool pages and documentation plan

**Started 2026-10-17**

The home page (`index.html`) was cut down to one line per tool on 2026-10-17. The longer descriptions it used to carry are kept word for word at the bottom of this file. Each one is moving to its own tool's page, and that move is the starting point for improving that tool's documentation.

Work through the tools one at a time, in the order below. When a tool is finished, tick it off and note where its text ended up. Delete this file once every box is ticked and the preserved text has all been placed.

## Decided (2026-10-17)

- [x] **One help pattern for every tool.** A **Help** button in the tool's toolbar opens a `<dialog>` that is already in the page, so nothing loads. Esc or "Got it" closes it. Every tool's help has the same sections, in this order:
  1. **About**: the long description (preserved below), rewritten for the tool's own page.
  2. **How to use it**: how to start, what each input means, what each output contains.
  3. **Shortcuts**, if the tool has any.
  4. **Files and storage**: what Save, Open and Export write and read, and what stays in the browser.
  5. A last line saying what to check against the governing code and manufacturer data, where that applies.
- [x] **F1 does nothing.** The user hates hitting F1 by accident. Every tool blocks it (`preventDefault` on keydown), which also stops Chrome opening its own help tab, and help opens **only** from the button. The CPM Scheduler loses its F1 shortcut, and its "Help (F1)" tooltip becomes "Help".
- [x] **The long description goes at the top of the Help panel**, not on an empty start screen.
- [x] **Head tags.** Every tool page gets `<meta name="description">`, `og:title`, `og:description`, `og:type` and `og:url`, the way `index.html` has them.

## For each tool

1. Read the tool's existing help, empty state and head tags.
2. Add a Help button and dialog with the sections above, or bring an existing one into that shape, with the preserved description from below as its About section. Block F1.
3. Fill in the documentation gaps: how to start, what each input means, what each output contains, and its limits ("check against …").
4. Add or fix the head tags.
5. If the tool has a suite and the change touches its script, run it (commands are in `CLAUDE.md`).
6. If the tool's one-liner on `index.html` no longer fits, update it too.
7. Tick the box below and say where the text went.

## Things learned along the way

- **Make the dialog open at the top.** Without it, `showModal()` focuses the first button, here "Got it" at the very bottom, and a long help opens scrolled to the end. Put `tabindex="-1" autofocus` on the dialog's heading (Taper Studio does this). Check whether the Panels and Scheduler help dialogs have the same problem.
- **Size dialogs with `dvh`, not just `vh`.** On a phone, Chrome measures `100vh` as if the address bar were hidden, so a dialog capped at `calc(100vh - 20px)` is taller than what's visible and gets cut off at the top and bottom (the user caught this on Roof Overlay on 2026-10-17). Write `max-height: calc(100vh - 20px); max-height: calc(100dvh - 20px)`, with the `vh` line as a fallback. This is fixed in every tool so far, including Sheet Metal's print dialog and the `.app` heights. Check the CPM Scheduler's dialogs when it comes up.
- **Guard the keyboard handler.** It must return early while the help is open. Otherwise Delete or a tool key acts on the drawing behind it.
- Taper Studio still has dead claude.ai artifact code (`window.claude.use('downloads')`, a JSZip path for DXF). It is harmless, but worth removing in a cleanup pass.

## Tools

Ordered roughly by how little documentation the tool has now:

- [x] **Taper Studio** (`taper.html`), 2026-10-17. Added a Help button and dialog with every section; the old description is rewritten as its About paragraph. F1 is blocked, and keys pressed while help is open no longer reach the plan. Head tags added, and `<title>` moved from `<body>` into `<head>`. There is no suite; it was checked in headless Chromium.
- [x] **Sheet Metal Layout** (`pattern.html`), 2026-10-17. Added a Help button beside the units switch, and a dialog styled like the print dialog (its header and footer stay put while the text scrolls), with the old description as its About paragraph. It also covers the outside-face-up rule and the fact that there are no seam allowances, both of which were previously only in per-fitting notes. F1 is blocked on `window`, because the suite's DOM stub has no `document.addEventListener`. og tags added. The suite passes (54 + 49).
- [x] **Roof Overlay** (`overlay.html`), 2026-10-17. The sidebar's six steps already explain the workflow, so the help does not repeat them. Its About paragraph is the old description, and it covers what the steps leave out: where dropped and pasted files go, that PDF and TIFF need internet the first time, that two-point line-up keeps the plan's proportions, the shortcuts, and what each of the four file buttons writes. F1 is blocked, and while help is open the key and paste handlers do nothing, so Esc closes the help without also leaving line-up mode. og tags added. The suite passes (65), and a browser check covered Esc during line-up.
- [x] **360 Photo Viewer** (`pano.html`), 2026-10-17. Added a Help button in the header, with the old description as its About paragraph, then sections on opening a photo (.insp files, partial panoramas, nothing kept), framing the shot, snapshots (how size, frame and file names work, and that the list lasts only until the page is closed) and shortcuts. F1 is blocked, and while help is open the key and paste handlers do nothing (S and the arrow keys no longer act behind it). og tags added. The suite passes (68), and a browser check ran with a generated 360 JPEG.
- [x] **Wind Zone Visualizer** (`zones/`, source in `~/projects/zones`), 2026-10-17. Added `HelpModal.tsx`, a native `<dialog>` opened from a Help button beside Export PDF, with the old description as its About paragraph, then the building, looking at it, PDF and files, and the disclaimer in brief. F1 is blocked through a `window` listener in `App.tsx`. The Export/Help group now wraps, because at phone width Help ran off the screen. The head tags were already complete. Typecheck is clean and the tests pass (180 + 209). Deployed as 2026-10-17.2 and checked over HTTP at 390 and 1400 px.
- [x] **Metal Panel Layout** (`panels.html`), 2026-10-17. The existing help text is kept word for word, regrouped under Getting started, Entering facets, Panels and waste, Output, Shortcuts and Files, with the old description as its About paragraph. It now opens at the top instead of at its Close button. F1 is blocked. While help is open, Ctrl+S/O/P/Z/Y do nothing, rather than acting on the project or falling through to the browser's own Save page and Print. og:description and og:type added. The suites pass (471 + 856), and a browser check ran with the sample loaded.
- [x] **CPM Scheduler** (`schedule.html`), 2026-10-17. All 13 existing help paragraphs and the shortcut table are kept word for word, regrouped under Getting started, Links and dates, Progress, Reading the schedule, Shortcuts and Files, with the old description as its About paragraph. F1 no longer opens help; it is blocked, and the tooltip now reads "Help". While any dialog is open, Ctrl+S/O/P no longer fall through to the browser. All its dialogs follow `dvh`, and the help opens at the top. og tags added (it had none). The suites pass (273 + 148), and a browser check ran at desktop and phone widths.
- [x] **Deadline Planner** (`plan.html`), 2026-10-17. Added a ? button styled like the bell, and a static `<dialog>` outside the Preact root, sized with `dvh` and written for a phone: building the plan, running it, alerts (including that phones only fire them while the app is open), templates and saving, and adding it to the home screen. The old description is its About paragraph. F1 is blocked, and og tags added. No change to `plan-sw.js` was needed: it serves the cached page and refreshes the cache in the background, so the update reaches a phone on its second open. There is no suite; it was checked in headless Chromium at 390 × 640 and on desktop.
- [x] **zbCAD** (`cad.html`, `docs.html`), 2026-10-17. The proposal was approved before any change. The header link was renamed from Docs to **Help** and still opens `docs.html` in a new tab; the docs are too long for a dialog. F1 is blocked at the top of the key handler in `interaction/pointer.js`, ahead of the dialogs' early returns. Head tags were added to `src/shell.html`, and `.dialog-card` follows `dvh`. In the docs, the lede is now the old home page description; the privacy paragraph is corrected (it claimed no network requests, but GoatCounter counts visits); and a six-step **Quick start** was added (rectangle, Zoom Extents, Dim Style at 1/4" = 1'-0", DLI, save, plot), with every step run in the real app. Docs head tags added too. The docs were otherwise current: every typed command was covered. `run-checks.sh` and the full suite pass, and the build was copied to the root `cad.html`.
- [ ] **Estimating from First Principles** (`estimating.html`): a guide, not a tool. Only the head tags need checking.

## Preserved text: the old home page descriptions, verbatim

**zbCAD:** 2D drafting with a typed command line, object snaps, layers and associative dimensions. Opens and saves DXF and plots to scaled vector PDF.

**Sheet Metal Layout:** Flat patterns for rectangle-to-round transitions, cones, offset reducers, elbows and branches. Exports DXF and SVG, or prints full size across multiple sheets.

**Wind Zone Visualizer:** Roof and wall wind zone geometry from the FM Global Data Sheet 1-28 zone figures, drawn to the building's actual dimensions. Low-slope, gable and monoslope roofs, stepped buildings and tall buildings, in 3D and plan, with zone areas and a PDF.

**Taper Studio:** Tapered roof insulation layout: drains, crickets and saddles, panel layout and takeoff, and average R-value. Exports a plan along with DXF, Excel and CSV.

**Metal Panel Layout:** Metal roof and wall panel layout from field dimensions: every panel numbered on a layout drawing, a rollformer-ready cut list by location and by length, long runs split with laps and splices flagged, and area and waste broken down by cause. Exports a vector PDF package and CSV.

**Roof Overlay:** Lay a building's floor plan over an aerial photo of its roof, to show where a leak, a ceiling stain or a room inside is on the roof. Opens PDF, JPEG, PNG and TIFF plans, clears the white background and recolors the lines, and lines the plan up by two matching corners or by dragging grips, stretching it one way when the drawing isn't to scale. Saves a marked-up image with notes.

**CPM Scheduler:** Critical path scheduling with a Gantt chart: finish-to-start, start-to-start, finish-to-finish and start-to-finish links with lag, work calendars and holidays, float, baselines and progress. Imports and exports MS Project XML.

**Deadline Planner:** Plan a day's work backwards from a deadline: the latest start and finish for every step, a safety buffer that shows how much of it is left, and alerts before each step is due. Works offline and installs to a phone's home screen.

**360 Photo Viewer:** Look around a 360° photo from an Insta360 or any other 360 camera, and save ordinary photos of any part of it: any direction, any zoom, a straightened horizon, landscape, square or portrait, at as many pixels as the photo holds. A wide lens and a little-planet view for the overview shot.

**Estimating from First Principles:** How to build a construction estimate from the ground up: scope, logistics, quantity takeoff, materials, labor by crew and production rate, and general conditions, with what usually gets missed at each step.

**Old footer note:** These tools are built for a desktop with a mouse and keyboard, except the Deadline Planner, which is made for a phone. (This is now the "Phone" tag on the home page.)
