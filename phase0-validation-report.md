# Phase 0 Benchmark Validation — Retroactive Pass Against v0.24.3

Run 2026-09-05, against the current build (`cad.html`, v0.24.3), per the backlog item in `roadmap.md` §14.1: *"Run the Phase 0 benchmark validation retroactively, against the current build."*

## What this pass could and could not validate

This was run **headlessly, by an AI agent, with no human at the keyboard and no access to QCAD or AutoCAD** in this environment. That materially changes what "Phase 0 validation" means here versus what `roadmap.md` §5 originally specified:

- **Could validate, and did:** the *mechanics* underneath the interaction contract — command lifecycle (start/advance/finish/cancel), typed coordinate grammar (absolute, relative `@`, polar `<`, direct-distance), object snap correctness, ORTHO/polar constraint math, window-vs-crossing selection logic, undo/redo semantics (including the guard against corrupting an in-progress command), and viewport coordinate transform correctness. All of this was driven through real code paths — either the `window.__cadPrototype` test hook's `submitCommandText`/`commitPoint`-equivalent calls (typing exactly what a user would type), or genuine simulated mouse events dispatched via the Chrome DevTools Protocol at real screen coordinates (so the actual DOM listeners in `interaction/pointer.js` ran, not a bypass).
- **Could not validate:** whether any of this *feels* right to a human doing real architectural drafting — cursor responsiveness, pan/zoom smoothness under continuous mouse movement, whether the snap aperture and visual snap markers are legible and trustworthy at a glance, whether the command flow matches AutoCAD/QCAD muscle memory well enough to be fast. There was also **no QCAD/AutoCAD baseline drawn** and **no completion-time data** — both required a human tester in the original method, and neither happened here.
- **Benchmark 3 (roof traced from an underlay) could not be run at all.** `grep -ril underlay src/src` returns nothing — underlay import/calibration does not exist in this build (confirmed against `roadmap.md`'s own "Not yet started" list). This is documented below as the Phase 0 finding for that benchmark, not worked around.

**Bottom line: treat this as "the mechanics are de-risked," not as "Phase 0 is closed."** A short human session against the exit-gate checklist in the final section — particularly the "feel" items — is still required before the process gap `roadmap.md` flagged is actually closed.

### A methodology note worth keeping for whoever builds the "external headless test suite" `testHook.js` already anticipates

Three things bit this test harness during the run, all self-inflicted, all worth flagging so the next person doesn't repeat them:

1. **The app's window has a real canvas with real bounds, and headless mouse coordinates must stay inside them.** At the default view (1400×1000 window, scale 1.5, no pan), the interactive canvas only spans world x ≈ [-375, 375], y ≈ [-243, 243] before the side panel and top toolbar start eating into it. Two early test steps picked world coordinates outside that box; the simulated clicks silently landed on the layer panel instead of the canvas, and the intended geometry was never drawn — with no error, just a quietly-missing entity. Anyone driving this app headlessly should assert the target point is within the canvas's own `getBoundingClientRect()` before trusting a click result.
2. **`getSnap(point, base, exclude)` reads its aperture cursor from `state.mouseScreen`, not from the `point` argument.** A real click always has `mouseScreen` set correctly by the preceding native mousemove/mousedown; a headless caller invoking `getSnap` directly must set `state.mouseScreen` (or dispatch a real mousemove) first, or every candidate gets filtered out and the call returns `null` regardless of nearby geometry. Not a bug — `state.mouseScreen` is exactly the real-cursor position this function is documented to use — but easy to trip over.
3. **`DIMLINEAR`'s dimension-line-location pick decides horizontal vs. vertical the same way AutoCAD does** (`linearDimensionRotation` in `model/dimension.js`): whichever axis the location point is displaced along *more*, relative to the midpoint of the two measured points, is the one measured. A location picked diagonally, dominant in the wrong axis, gets rejected with "That dimension line direction measures nothing. Try the other side." This is working as designed and matches the documented AutoCAD convention — flagged below as a minor **Friction** item only because the error message doesn't explain *why*, not because the behavior is wrong.

## Benchmark 1 — Simple roof from scratch

Rectangular perimeter, four RTUs, two drains, several dimensions, driven via `submitCommandText` (typed command-line entry, the common case) with one deliberate mid-command cancel and one direct-distance-entry check mixed in.

**Sequence actually run** (abbreviated; full step-by-step log at `/home/matt/.claude/jobs/4afe77f4/tmp/phase0-log.json`):

```
NEW
RECTANGLE  0,0            480,360        → perimeter (40'×30')
LINE       50,50          [Esc/cancelCurrent]     → mid-command cancel test
RECTANGLE  60,60          108,96                  → RTU 1
RECTANGLE  300,60         @48,36                  → RTU 2 (relative entry)
RECTANGLE  60,264         108,300                 → RTU 3
RECTANGLE  300,264        @48,36                  → RTU 4 (relative entry)
CIRCLE     180,180        4 (typed radius)         → drain 1
CIRCLE     340,200        344,200 (picked radius)  → drain 2
LINE       0,400          [cursor set east] 60     → direct-distance entry test
DIMLINEAR  0,0  480,0     -40,-40 (bad pick)       → see corrected re-run below
undo() / redo()                                    → see corrected re-run below
```

Results:

- Rectangle, all 4 RTU rectangles (two via absolute corners, two via `@dx,dy` relative), and both drains all created with exactly the expected geometry (verified against the returned entity list, not just entity counts).
- **Cancel mid-command**: `LINE` → one point committed → `cancelCurrent()` → entity count unchanged, mode returned to `SELECT` cleanly. No orphaned state.
- **Direct-distance entry**: base point `(0,400)`, simulated cursor due east, typed bare `60` → committed line endpoint at exactly `(60, 400)`. Matches AutoCAD-style "type a distance, cursor sets the direction" behavior.
- **DIMLINEAR, first attempt**: failed with "That dimension line direction measures nothing." — this was **my bad location pick** (diagonal, x-dominant against a horizontal line), not an app defect. See the corrected version below, which succeeded.
- **Undo/redo, first attempt**: invalid — it ran while the DIMLINEAR command was still open waiting for a valid location, using the hook's raw `undo()`/`redo()`, which bypass the real keyboard-shortcut guard. Re-run correctly below.

### Corrected DIMLINEAR + undo/redo re-run

```
RECTANGLE 0,0 480,360
DIMLINEAR 0,0  480,0  240,-40      → location straight below the midpoint
```
→ created a `DIM`/`LINEAR` entity, `dimensionText` = `40'-0"` (480" line, correct). No defect.

Undo/redo re-run using `navigateHistory('UNDO'/'REDO')` — the actual function the real Ctrl+Z/Ctrl+Y keyboard shortcut calls (`interaction/pointer.js` → `navigateHistory`, not the bare `undo()`/`redo()` the test hook also happens to expose):

```
LINE 10,10           ← one point committed, command still open
navigateHistory('UNDO')   → returns false; LINE is CANCELED (not undone); entity count unchanged
navigateHistory('UNDO')   → now actually undoes the last committed entity (DIMLINEAR)
navigateHistory('REDO')   → restores it
```

This confirms `registry.js`'s own documented intent (*"Anything that would rewrite the document out from under a running command has to ask this first"*) is correctly implemented on the real user-facing path: **pressing Ctrl+Z while a command is mid-flight cancels the command instead of silently corrupting its half-entered state, and requires a second press to actually touch history.** This is a real, positive, verified finding — exactly the kind of interaction-contract robustness Phase 0 exists to check for.

Screenshot: `/home/matt/.claude/jobs/4afe77f4/tmp/phase0-screenshots/benchmark1-simple-roof.png`. Note: the always-on-load help legend (bottom-left, `#help` in `shell.html`) is still visible in this screenshot because it fades out via a 12-second `setTimeout` from page load (`main.js`) and the headless script finished well inside that window — it is **not** a permanently obscuring panel in real use (`pointer-events: none`, and it disappears for good after 12 seconds). Not a finding.

## Benchmark 2 — Irregular roof from scratch

L-shaped perimeter (closed polyline, mixed absolute/relative entry), an inward OFFSET for an interior roof area, an expansion joint under ORTHO, five penetrations, and window/crossing selection in both directions.

**Sequence:**

```
PLINE  0,0  600,0  600,240  360,240  @0,120  @-360,0  C   → closed L-shaped perimeter
  entityArea = 187200 (verified correct by hand via the shoelace formula — my first
  back-of-envelope expectation of 172800 was simply my own arithmetic error, not a
  defect; polylineIsClosed() correctly reports true)
click(300,0) → select perimeter edge → OFFSET → distance 24 → click(300,20) side pick
  → interior offset polyline created, entity count +1, using real click-based
  source selection and side pick (not typed input) throughout
ORTHO on → LINE 100,120 → click(350,135) [off-axis] → endpoint forced to (350,120)
  → correct (this needed a corrected on-canvas re-run; the original in-sequence
  attempt used an off-canvas target point and silently produced no line at all —
  see the methodology note above)
CIRCLE ×5 → penetrations at (150,60) r3, (450,60) r4, (150,180) r3, (450,180) r3,
  (300,180) r5, all typed, all correct
```

**Window vs. crossing selection**, corrected to use a box whose edge genuinely clips the target entity's bounding box (so the two drag directions could actually disagree — the original in-sequence attempt used a box that either fully enclosed or fully missed the target in both directions, which doesn't test the distinction, and separately also drifted off-canvas):

```
Circle at (300,60) r4  → bbox x[296,304] y[56,64]
Drag left→right (300,40)→(350,80)  [[WINDOW]]  → NOT selected (correct: not fully enclosed)
Drag right→left (350,40)→(300,80)  [[CROSSING]] → selected     (correct: touching is enough)
```

Both `boxesOverlap`/`entityCrossesBox` (the pure geometry functions) and the full click-drag→`finishBoxSelection` path were checked independently and agree. **No defect** — window requires full containment, crossing requires only a touch, exactly as intended, in both directions.

Screenshot: `/home/matt/.claude/jobs/4afe77f4/tmp/phase0-screenshots/benchmark2-irregular-roof.png` (drawn before the ORTHO/window-crossing corrections above, so it doesn't show the expansion joint — the corrected checks were re-verified separately via entity/state inspection rather than a second full screenshot).

## Benchmark 3 — Roof traced from an underlay

**Not run. Blocker: underlay support does not exist in this build.** `grep -ril underlay src/src` returns no results; `roadmap.md` itself lists underlays under "Not yet started." There is nothing to test here until Phase 4 work begins — this is expected, not a surprise, but it is the Phase 0 finding for this benchmark: the third benchmark drawing cannot be attempted at all in the current build.

## Mechanism checks (exit-gate items not already covered above)

| Check | Method | Result |
|---|---|---|
| ENDPOINT/MIDPOINT/CENTER/QUADRANT snap correctness | `getSnap()` with `state.mouseScreen` set to match, near known geometry | All four returned the correct type **and** the correct point; a far-away point correctly returned `null`. Default snap types on load: END/MID/INT/CENTER/QUAD/PERP on, TAN/NEAR off — a sensible default set. |
| ORTHO point constraint | Real click at an off-axis point with ORTHO on | Endpoint correctly forced onto the horizontal axis from the base point. |
| POLAR tracking (45° increment) | Real click near, not on, a 45° ray from the base | Endpoint correctly locked onto the ray (`(0,0)`→`(100,100)`, x==y as expected). |
| Viewport transform round-trip | `screenToWorld(worldToScreen(p))` for four points incl. negative coordinates | Exact match, zero error, for every point tested. |
| Undo/redo guard during an in-progress command | `navigateHistory('UNDO')` mid-`LINE` | Canceled the command first, as designed; second call then undid correctly (see Benchmark 1 write-up). |
| PLINE `U` (undo last point) keyword | Typed `U` after 3 points | Removed exactly one point, left the run open to continue. |
| PLINE duplicate-point rejection | (Not separately re-tested this pass; the `dist(last, p) <= 1e-9` guard in `draw.js` was read but not exercised — noted as a small gap below.) | — |
| MOVE / COPY / ROTATE / SCALE | Preselect via `state.selected` (a real "select, then invoke" workflow), then typed base point + typed relative/absolute destination (MOVE/COPY) or typed angle/factor (ROTATE/SCALE) | **Validated.** All four hand-checked against the returned coordinates: MOVE shifted by exactly the typed relative offset; COPY left the original untouched and placed the duplicate at exactly the typed destination; ROTATE's 90° turn about a typed base point matched the expected CCW rotation for all four corners (to floating-point rounding); SCALE's 2× factor about a typed base point matched exactly. Full data: `/home/matt/.claude/jobs/4afe77f4/tmp/phase0-transform-log.json`. |

Full raw step-by-step logs: `/home/matt/.claude/jobs/4afe77f4/tmp/phase0-log.json`, `phase0-log2.json`, plus the ad-hoc correction scripts (`drive3.py`–`drive5_ortho.py`) in the same directory, kept for anyone who wants to re-run or extend these checks.

## Findings

| # | Category | Summary | Severity |
|---|---|---|---|
| 1 | **Blocker** | Benchmark 3 cannot be attempted: underlay import/calibration is unimplemented. | High — this is a known, tracked gap (`roadmap.md` Phase 4), not new information, but it is the formal Phase 0 result for this benchmark. |
| 2 | **Friction** | `DIMLINEAR`'s "That dimension line direction measures nothing. Try the other side." message doesn't explain that the dimension's location pick is being read as choosing horizontal-vs-vertical relative to the measured points' midpoint. A first-time user who picks a diagonal offset (as this test initially did) gets a correct rejection for an unexplained reason. | Low — the underlying behavior matches AutoCAD convention and is correct; only the message clarity is a nit. |

No Defects and no other Blockers or Friction were found in anything actually exercised this pass — every other anomaly encountered while driving the app (an off-canvas test coordinate landing on the layer panel instead of the canvas twice, a `getSnap()` call missing its cursor-state setup, and a hand-computed expected-area check that was simply arithmetic error) traced back to the test harness, not the application, and is documented above rather than reported as a finding.

## Phase 0 exit gate (roadmap.md §5) — status

| Exit gate item | Status |
|---|---|
| Pan and zoom feel natural | **Needs human** — mechanically the viewport transform round-trips exactly; "feel" under continuous real mouse/wheel input was not and could not be assessed headlessly. |
| Commands reliably start, advance, finish, and cancel | **Validated** — LINE, PLINE, RECTANGLE, CIRCLE, OFFSET, DIMLINEAR all exercised through full lifecycles including a mid-command cancel; all behaved correctly. |
| Direct distance, Cartesian, and polar input are predictable | **Validated** — absolute, `@`relative, `<`polar, and direct-distance (typed number + cursor direction) entry all produced exactly the expected geometry. |
| Selection behaves correctly in both directions | **Validated** — window (full containment) vs. crossing (touch suffices) confirmed correct in both drag directions against a box that genuinely straddles the target's boundary. |
| Required snaps are visible and trustworthy | **Partially validated** — ENDPOINT/MIDPOINT/CENTER/QUADRANT snap resolution is mechanically correct (right type, right point). Whether the on-screen snap marker is visually legible/trustworthy to a human at drafting speed is a **needs-human** item. |
| Line, polyline, move, and copy have no blocking workflow issues | **Validated** — LINE and PLINE fully exercised (including Close and Undo-point keywords); MOVE, COPY, and (bonus) ROTATE/SCALE all driven and hand-verified against exact expected coordinates. No issues found. |
| Every observed defect has a repeatable test case | N/A this pass — no defects were found to require one. |

## Suggested next steps

1. **This still needs a short live human session** against the same benchmark drawings (or real ones) to close the "feel" and QCAD/AutoCAD-baseline parts of Phase 0 that this pass structurally cannot answer — that's the process gap `roadmap.md` flagged, and headless validation de-risks it but doesn't replace it.
2. Consider a one-line addition to the `DIMLINEAR` rejection message (finding #2) — low cost, removes a point of confusion for anyone who hasn't internalized the AutoCAD convention.
3. If an automated regression suite is ever built against `window.__cadPrototype` (as `testHook.js`'s own comment anticipates), reuse the driver scripts left in `/home/matt/.claude/jobs/4afe77f4/tmp/` as a starting point — they already solve the off-canvas-coordinate and snap-cursor-state gotchas documented above.
