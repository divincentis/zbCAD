# Tool pages and documentation plan

**Started 2026-10-17**

The home page (`index.html`) was cut down to one line per tool on 2026-10-17. The longer descriptions it used to carry are kept word for word at the bottom of this file. Each one is moving to its own tool's page, and that move is the starting point for improving that tool's documentation.

Work through the tools one at a time, in the order below. When a tool is finished, tick it off and note where its text ended up. Delete this file once every box is ticked and the preserved text has all been placed.

## Decide once, before the first tool

- [ ] **One help pattern for every tool.** Today it differs by tool: zbCAD links out to `docs.html`, Metal Panel Layout and the CPM Scheduler have a Help button (the scheduler's also opens on F1), and the rest have nothing. Choose one entry point (a Help button, or `?` / F1) and one shape for what it opens, such as an About paragraph, then how to use it, then shortcuts, then file formats. Every tool then follows the same pattern.
- [ ] **Where the long description lives.** It could be the About section of that help panel, a first-run empty state, or both.
- [ ] **Head tags.** Every tool page should have `<meta name="description">`, plus `og:title` / `og:description` / `og:url` the way `index.html` does it. Only `zones/` has `og:description` today, and `cad.html` and `taper.html` have no meta description at all.

## For each tool

1. Read the tool's existing help, empty state and head tags.
2. Place the preserved description from below, rewritten as needed now that it sits on the tool's own page.
3. Fill in the documentation gaps: how to start, what each input means, what each output contains, and its limits ("check against …").
4. Add or fix the head tags.
5. If the tool has a suite and the change touches its script, run it (commands are in `CLAUDE.md`).
6. If the tool's one-liner on `index.html` no longer fits, update it too.
7. Tick the box below and say where the text went.

## Tools

Ordered roughly by how little documentation the tool has now:

- [ ] **Taper Studio** (`taper.html`): no help, no meta description.
- [ ] **Sheet Metal Layout** (`pattern.html`): has a meta description, no help.
- [ ] **Roof Overlay** (`overlay.html`): has a meta description, no help.
- [ ] **360 Photo Viewer** (`pano.html`): has a meta description, no help.
- [ ] **Wind Zone Visualizer** (`zones/`): this is **build output**. Edit the source in `~/projects/zones` and deploy from there, never in this repo.
- [ ] **Metal Panel Layout** (`panels.html`): has a Help button. Review it and add the About text.
- [ ] **CPM Scheduler** (`schedule.html`): has Help (F1). Review it and add the About text.
- [ ] **Deadline Planner** (`plan.html`): built for a phone, so its help has to work on a phone. Its service worker caches the page, so check that an updated page still reaches users.
- [ ] **zbCAD** (`cad.html`, `docs.html`): has its own documentation page. Review `docs.html` and add a meta description through `src/shell.html` (never edit `cad.html` directly; rebuild instead).
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
