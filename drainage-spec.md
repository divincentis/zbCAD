# Roof Drainage — spec (draft)

**Status: built as `drainage.html`, November 2026. This spec now records what was built; the code basis below was checked against the 2021 text.**

## Why build it

SMACNA's calculator gives the right numbers but stops short of the job an
estimator is actually doing. Three things to fix:

1. **One run at a time.** A real roof has several areas, each with gutters,
   scuppers or drains. Each one is a separate trip through the calculator, and
   nothing adds them up.
2. **Downspouts are left to you.** It gives a required cross-sectional area and
   leaves choosing a size, a count and where they go to the user.
3. **Weak output.** There is nothing to print for a bid file, a submittal or the
   shop.

The tool's job: **enter a whole roof once, get every gutter, downspout, scupper,
conductor head and drain sized and counted to the IBC and IPC, and print it.**

## Who and where

An estimator in the office, at bid time. Desktop first; it must work at phone
width but is not designed around it. The output feeds pricing and fabrication,
and the calculation package goes in submittals.

## Scope

In:

- Steep slope: eave gutters, downspouts (leaders), outlets, elbows.
- Low slope: through-wall scuppers, conductor heads, roof drains with their
  leaders, and secondary (overflow) drainage for each.
- A whole job: several drainage areas, each with its own outlets.
- A printable calculation package and a material list.

Out (v1):

- Gutters inside a parapet, and valley gutters.
- Drawing the roof. Areas are typed in; tracing a plan comes later, possibly
  from Roof Overlay or a DXF.
- Storm piping below grade, and horizontal storm drains inside the building
  (IPC 1106.3).
- Structural judgement on rain load. The tool *reports* the static and hydraulic
  heads the engineer needs for IBC 1611, but does not check the roof structure.
- Pricing. It gives quantities; the estimator prices them.
- Metric. Inches, feet, square feet, in/hr and gpm only, until someone asks.
- Placing each downspout by hand. The tool proposes count and spacing; the user
  can mark spots to avoid.

## Code basis

Every pass or fail in this tool is a code check, and the printout cites the
section it came from. Anything beyond the code is labelled as advice and never
fails an item on its own.

IBC 1502 sends roof drainage design to the IPC, so the IPC does most of the
work. v1 offers the 2021 IBC and IPC only, and the section numbers below are
from those. The edition is still stored on the project and printed on the
package, so a later edition can be added without breaking old files (later
editions moved some roof drainage sections, so each one gets its own tables and
section numbers).

| Question | Source (2021 text, as checked) |
| --- | --- |
| Design storm | IPC 1106.1: the 100-year hourly rate (IPC Figure 1106.1, or approved local data) |
| Flow | IPC Equation 11-1: GPM = R × A × 0.0104 |
| Design area | Horizontal projected area; IPC 1106.4: plus half of any wall that sheds onto it |
| Roof drains and their leaders | IPC 1106.2, Table 1106.2 (vertical drain column); the drain's own published rate per IPC 1105.2 |
| Downspouts and conductor-head leaders | IPC 1106.3, Table 1106.3 (round and rectangular in one table) |
| Gutters | IPC 1106.6, Table 1106.6 (semicircular and rectangular sections, by slope) |
| Scuppers | IPC 1106.5 and 1108.3: at least 4" high, at least as wide as the circumference of a roof drain sized for the same flow, and not ponding past the roof's design depth; IBC 1502.3 |
| Secondary drainage | IPC 1108.1–1108.3, IBC 1502.2: required where the edge traps water; full flow with the primary blocked; separate discharge where it will be seen |
| Rain load | IBC 1611.1: R = 5.2 (ds + dh), with the rainfall at the **100-year, 15-minute** rate, or twice the hourly rate |

The 100-year, 1-hour rate sizes everything. The water depths reported for rain
load use the IBC's 15-minute rate (typed in as the 15-minute depth NOAA lists,
× 4), or twice the hourly rate when that is left blank. It is typed in per project, beside a link
to the NOAA precipitation frequency server
(https://hdsc.nws.noaa.gov/pfds/) for looking it up, and can be overridden per
area. No built-in rainfall table in v1.

### Where the code needs a method

The code gives a limit but not the arithmetic in three places. The tool uses the
standard methods below, names them on the printout, and keeps them in the engine
where a test can see them.

- **Flow:** `Q (gpm) = A (sf) × i (in/hr) / 96.23`. Used to compare every
  outlet with its capacity; the code tables are this relation tabulated.
- **Scupper flow:** weir flow, `Q (gpm) ≈ 2.9 × b × h^1.5`, opening width `b`
  and head `h` in inches, at the rain-load rate. The width is the largest of the
  circumference rule, the width that keeps the water inside the opening, and the
  width that keeps ds + dh within the design depth.
- **Sections the tables don't list:** rated as the listed section with the
  greatest capacity and no more cross-sectional area (so K-style gutters, and
  rectangles like 2×3 and 3×4, can only be under-rated). A listed section uses
  only its own rows.
- **Slopes the table doesn't list for a section:** its next steeper row reduced
  by √(slope ratio). A row printed at the gutter's slope always wins, because
  the table is only approximately √ between its columns (8" at ¹⁄₁₆ prints 172,
  where √ from ⅛ gives 174.7). The printout says so, since an AHJ may want to see
  it, and an AHJ that wants something else can see exactly what was done.
- **Sizes past the end of a table:** held to the table's largest figure and
  marked "table max". Table 1106.6 stops at about 40 sq in (4×10, 5×8), so every
  box gutter from 8×6 up rates the same, about 373 gpm at ¹⁄₁₆"/ft.

### Advice, not code

- **Gutter outlet check.** The drop from a gutter into a downspout is a weir
  while the water is shallow and an orifice once it is deep
  (`Q = Cd·A·√(2gh)`), with the gutter depth as the largest head. This is what
  usually limits a downspout in real life, but the IPC does not check it. The
  tool shows it as a warning, with the suggested fix, and does not fail the item.
- **Spacing between downspouts.** Default 50 ft, adjustable. Practice, not code.

## What it decides for you

This is the main difference from SMACNA.

**Downspouts.** For each gutter run, the user gives the length, the gutter
slope, and any spots to keep downspouts away from. The tool proposes:

- a size from the catalog;
- a count, evenly spaced around the keep-outs, so every downspout's share of the
  run's flow is within IPC Table 1106.2 and no two are farther apart than the
  spacing limit;
- the gutter size each segment needs under IPC Table 1106.6, given where the
  downspouts are.

It shows two or three alternatives side by side, for example *3 × 3×4* against
*2 × 4×5*, with downspout footage and fitting counts, so the estimator picks the
cheaper one. A run that cannot work with any catalog size says so and says why.

**Scuppers.** Given the area's flow and the largest head allowed, it sizes the
opening, the conductor head to catch it and the downspout under the head. The
secondary scupper is sized to carry the whole flow on its own, at least 4" high,
set above the primary by a given distance (default 2"), and reports its total
water depth.

**Roof drains.** The leader size and count for primary and secondary drains. The
drain body itself is a manufacturer's choice; the tool states the flow it has to
pass.

## Catalog

Editable per project, with defaults covering residential sizes and the larger
shop-fabricated sizes used on commercial buildings:

- **Gutters:** K-style 5", 6", 7", 8"; half-round 5", 6", 8"; box (width ×
  depth) 6×4, 6×6, 8×6, 8×8, 10×8, 12×8, plus any custom width × depth.
- **Downspouts, rectangular:** 2×3, 3×4, 4×5, 4×6, 5×5, 6×6, 4×8, 6×8, plus
  custom.
- **Downspouts, round:** 3", 4", 5", 6", 8", plus custom.

## Showing the answer

Every sized item shows:

- the flow it carries and its capacity, as a bar, with the margin as a number;
- which check governs (leader, gutter, head, or the outlet warning), with the
  code section;
- in plain words, what to change when it fails: "Over by 18% under IPC Table
  1106.2(2). Next size up is 4×5, or add a downspout."

The summary is one sentence per area, in the same plain style as the Labor
Forecast.

## Output

From one plan of the results, the same way Panels does it (the engine produces
sheet primitives, and the screen, print and PDF all consume them):

- **Calculation package:** a cover with the job, code edition, design storm and
  its source; one page per area with inputs, flows, each check with its code
  section and margin; a schedule of every outlet. Suitable for a submittal.
- **Material list:** gutter footage by profile and size, downspout footage by
  size, outlets, elbows, conductor heads, scupper boxes, expansion joints and end
  caps, with quantities per area and totals. CSV as well as print.
- Later: scupper boxes and conductor heads sent to Sheet Metal Layout as
  patterns.

## The job file

```
project: name, jobNo, address, code edition, storm in/hr,
         catalogs { gutters[], downspouts[] }, maxSpacingFt, overflowRiseIn
  areas[]: name, kind (steep | low), plan sf, wall sf, storm override
    runs[]   (steep): length ft, gutter slope, gutter profile, keep-outs
    edges[]  (low):   scuppers | drains, largest allowed head, secondary type
```

Results are always derived and never saved, like Panels' layouts. Everything a
file, an import or the autosave brings in goes through `checkProject`; every
field goes there as well as in its factory.

## How it's built

The same arrangement as the Labor Forecast and Roof Overlay:

- `drainage.html`, hand-edited, no build step, two classic scripts.
- The first never touches the DOM: `analyze(P)` is the engine, the code tables,
  the plan for print and PDF, the plain-language text and `checkProject`.
- The second is the UI.
- Suite at `src/tools/tests/drainage/run.sh`, booting the first script alone.
- The shared Help dialog, F1 blocked, dvh sizing.
- Listed on the home page under Field or Estimating.

## Acceptance tests (engine)

- Every catalog size's leader capacity matches 2021 IPC Table 1106.2(1)/(2),
  and every half-round gutter matches 2021 IPC Table 1106.6 at each slope.
- Design area from hand calculations, including the 50% wall addition.
- Flow from area and storm matches the code tables' own relation.
- Weir and orifice functions against hand-worked values; the outlet warning
  switches from weir to orifice at the right depth and never fails an item.
- A size past the end of a code table is rated by area and flagged.
- A 60 ft run at a given storm proposes the expected count and size, never
  exceeds the spacing limit, and honors a keep-out.
- A secondary scupper carries the full flow on its own, is at least 4" high,
  and its reported depth includes the rise above the primary.
- A file with junk fields loads with defaults rather than failing.

## Decided

- Code edition: 2021 IBC and IPC only, for now.
- K-style and box gutters: rated as the half-round of equal area, stated on the
  printout.
- Rainfall: typed in, with the NOAA lookup linked beside the field.
- Catalog: the defaults above.
- Out of v1: parapet and valley gutters, placing each downspout by hand.

## Open

- **Large box gutters.** The code tables give no credit past about 40 sq in, so
  big commercial box gutters are under-rated. Crediting them needs an engineered
  method (Manning's equation, as the table itself roughly follows), clearly
  marked as beyond the code table.
- **Print.** The package prints through the browser (Save as PDF), like the
  Labor Forecast, rather than through a plan-and-writer PDF like Panels.
