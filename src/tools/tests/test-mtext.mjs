import { boot, DEFAULT_BUNDLE } from './harness.mjs';

const BUNDLE = process.argv[2] || DEFAULT_BUNDLE;

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) { passed++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
function near(a, b, tol = 1e-6) { return Math.abs(a - b) <= tol; }
function pointNear(p, x, y, tol = 1e-6) { return p && near(p.x, x, tol) && near(p.y, y, tol); }

const { api } = boot(BUNDLE);
const P = (x, y) => ({ x, y });

function reset() {
  api.newDrawing();
  api.setOrtho(false);
  api.setAllSnapTypes(false);
}

// Places an MTEXT through the real command path: first corner, opposite
// corner (width), height, rotation, then one Enter per line, finished with a
// blank Enter — exactly what a user's clicks and keystrokes produce.
function placeMText(position, width, height, rotationDeg, lines) {
  api.startCommand('MTEXT');
  api.commitPoint(position);
  api.commitPoint(P(position.x + width, position.y));
  api.commitDistance(height);
  api.submitCommandText(String(rotationDeg));
  for (const line of lines) api.submitCommandText(line);
  api.submitCommandText(''); // blank line finishes multi-line entry
  return api.entities[api.entityCount - 1];
}

function entityById(id) { return api.entities.find(e => e.id === id); }
function selectOnly(...ids) { api.state.selected.clear(); ids.forEach(id => api.state.selected.add(id)); }

// ---------------------------------------------------------------------------
// Placement and staging
// ---------------------------------------------------------------------------
reset();
{
  const mtext = placeMText(P(0, 0), 40, 2, 0, ['FIRST LINE', 'SECOND LINE']);
  check('MTEXT setup placed an mtext entity', mtext?.type === 'MTEXT', mtext?.type);
  check('MTEXT position is the first corner', pointNear(mtext.position, 0, 0));
  check('MTEXT width is the opposite-corner distance', near(mtext.width, 40));
  check('MTEXT height is the typed distance', near(mtext.height, 2));
  check('MTEXT rotation is 0', near(mtext.rotation, 0));
  check('MTEXT content joins lines with newlines',
    mtext.content === 'FIRST LINE\nSECOND LINE', JSON.stringify(mtext.content));
}

// Typed distances (rather than a second click) for width and height, and MT
// resolves as the short alias.
reset();
{
  check('MT resolves to MTEXT', api.resolveCommandName('MT') === 'MTEXT');
  api.startCommand('MTEXT');
  api.commitPoint(P(5, 5));
  api.commitDistance(30);
  api.commitDistance(3);
  api.submitCommandText('90');
  api.submitCommandText('SPEC NOTE');
  api.submitCommandText('');
  const mtext = api.entities[api.entityCount - 1];
  check('typed WIDTH distance is honoured', near(mtext.width, 30));
  check('typed HEIGHT distance is honoured', near(mtext.height, 3));
  check('typed rotation converts degrees to radians', near(mtext.rotation, Math.PI / 2));
}

// Enter-for-default at every staged prompt, mirroring TEXT's <default>
// convention, and an empty CONTENT submission with no lines yet refuses
// rather than placing an empty entity.
reset();
{
  api.startCommand('MTEXT');
  api.commitPoint(P(0, 0));
  api.finishCurrent(); // default width -> HEIGHT
  api.finishCurrent(); // default height -> ROTATION
  api.finishCurrent(); // default rotation (0) -> CONTENT
  check('MTEXT refuses to finish with no lines typed yet',
    api.finishCurrent() === false);
  api.submitCommandText('ONLY LINE');
  api.finishCurrent(); // blank line finishes
  const mtext = api.entities[api.entityCount - 1];
  check('MTEXT accepted a positive default width', mtext && mtext.width > 0);
  check('MTEXT accepted a positive default height', mtext && mtext.height > 0);
  check('MTEXT accepted the default rotation', near(mtext.rotation, 0));
  check('MTEXT content is the one typed line', mtext.content === 'ONLY LINE');
}

// ---------------------------------------------------------------------------
// Word wrap
// ---------------------------------------------------------------------------
reset();
{
  // height 1, TEXT_WIDTH_FACTOR 0.6 -> char width 0.6, so a width of 3.6
  // fits exactly 6 characters per line.
  const mtext = { type: 'MTEXT', position: P(0, 0), width: 3.6, height: 1, rotation: 0, content: 'ONE TWO THREE' };
  const lines = api.mtextLines(mtext);
  check('word wrap breaks between words rather than mid-word',
    lines.every(line => !line.includes('THREETHREE')), JSON.stringify(lines));
  check('word wrap keeps every word', lines.join(' ').replace(/\s+/g, ' ') === 'ONE TWO THREE', JSON.stringify(lines));
  check('no wrapped line exceeds the estimated character budget',
    lines.every(line => line.length <= 6), JSON.stringify(lines));

  const hardBreak = { ...mtext, content: 'SUPERCALIFRAGILISTIC' };
  const brokenLines = api.mtextLines(hardBreak);
  check('a word wider than the box is hard-broken rather than left overflowing',
    brokenLines.every(line => line.length <= 6), JSON.stringify(brokenLines));
  check('hard-breaking preserves every character',
    brokenLines.join('') === 'SUPERCALIFRAGILISTIC', JSON.stringify(brokenLines));

  const explicit = { ...mtext, content: 'A\n\nB' };
  check('an explicit blank line is preserved as an empty line',
    JSON.stringify(api.mtextLines(explicit)) === JSON.stringify(['A', '', 'B']));
}

// ---------------------------------------------------------------------------
// Footprint: bbox and pick geometry grow with the wrapped line count, and
// hit-testing lands inside the box, matching how TEXT's footprint already
// behaves (see entityBBox/pickSegments in model/entity.js).
// ---------------------------------------------------------------------------
reset();
{
  const one = placeMText(P(0, 0), 40, 2, 0, ['ONE LINE']);
  const three = placeMText(P(0, -20), 40, 2, 0, ['LINE ONE', 'LINE TWO', 'LINE THREE']);
  const bboxOne = api.entityBBox(one);
  const bboxThree = api.entityBBox(three);
  const heightOne = bboxOne.maxY - bboxOne.minY;
  const heightThree = bboxThree.maxY - bboxThree.minY;
  check('a three-line MTEXT footprint is taller than a one-line MTEXT footprint',
    heightThree > heightOne, `${heightThree} vs ${heightOne}`);
  check('pickSegments returns a closed 4-edge box for MTEXT',
    api.pickSegments(one).length === 4);

  selectOnly();
  const hit = api.selectAt(P(one.position.x + 1, one.position.y + 0.5), false);
  check('a click inside an MTEXT footprint selects it', api.state.selected.has(one.id));
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------
reset();
{
  const mtext = placeMText(P(2, 3), 20, 1, 0, ['MOVE ME']);
  selectOnly(mtext.id);
  api.startCommand('MOVE');
  api.commitPoint(P(2, 3));
  api.commitPoint(P(12, 3));
  const moved = entityById(mtext.id);
  check('MOVE translates the MTEXT insertion point', pointNear(moved.position, 12, 3));
  check('MOVE leaves width and content alone', near(moved.width, 20) && moved.content === 'MOVE ME');
}

reset();
{
  const mtext = placeMText(P(0, 0), 20, 1, 0, ['SPIN']);
  selectOnly(mtext.id);
  api.startCommand('ROTATE');
  api.commitPoint(P(0, 0));
  api.submitCommandText('90');
  const rotated = entityById(mtext.id);
  check('ROTATE turns the MTEXT rotation angle', near(rotated.rotation, Math.PI / 2));
  check('ROTATE keeps the insertion point fixed at the base point', pointNear(rotated.position, 0, 0));
}

reset();
{
  const mtext = placeMText(P(0, 0), 20, 1, 0, ['GROW']);
  selectOnly(mtext.id);
  api.startCommand('SCALE');
  api.commitPoint(P(0, 0));
  api.submitCommandText('2');
  const scaled = entityById(mtext.id);
  check('SCALE doubles the MTEXT height', near(scaled.height, 2));
  check('SCALE doubles the MTEXT width, keeping wrap proportions', near(scaled.width, 40));
}

reset();
{
  const mtext = placeMText(P(4, 1), 20, 1, 0, ['NORTH']);
  selectOnly(mtext.id);
  api.startCommand('MIRROR');
  api.commitPoint(P(0, 0));
  api.commitPoint(P(0, 1));
  api.submitCommandText('Y');
  const mirrored = entityById(mtext.id);
  check('MIRROR reflects the MTEXT insertion point', pointNear(mirrored.position, -4, 1));
  check('MIRROR keeps MTEXT readable rather than flipping it (MIRRTEXT=0)',
    near(mirrored.rotation, mtext.rotation));
  check('MIRROR keeps width and content', near(mirrored.width, 20) && mirrored.content === 'NORTH');
}

// STRETCH itself has no headless test coverage anywhere in this repo (it is
// driven by a real mouse-drag crossing window, which the harness cannot
// simulate) — stretchedEntity()'s new MTEXT branch is a direct mirror of the
// already-shipped TEXT branch (geometry/stretch.js), so it is not tested here
// either rather than inventing drag-simulation infrastructure for this alone.

// ---------------------------------------------------------------------------
// Grips
// ---------------------------------------------------------------------------
reset();
{
  const mtext = placeMText(P(0, 0), 10, 1, 90, ['G']);
  const grips = api.gripsFor(mtext);
  const position = grips.find(g => g.kind === 'MTEXT_POSITION');
  const width = grips.find(g => g.kind === 'MTEXT_WIDTH');
  check('MTEXT exposes a position grip at the insertion point', pointNear(position?.point, 0, 0));
  // Rotated 90 degrees, the width grip should sit straight up the y axis.
  check('MTEXT exposes a width grip along the text\'s own rotated x-axis',
    pointNear(width?.point, 0, 10, 1e-6), JSON.stringify(width?.point));
}

// ---------------------------------------------------------------------------
// Document round-trip and validation
// ---------------------------------------------------------------------------
reset();
{
  placeMText(P(1, 2), 15, 0.5, 0, ['ROUND', 'TRIP']);
  const text = api.exportDocumentText();
  api.newDrawing();
  api.importDocumentText(text);
  const restored = api.entities.find(e => e.type === 'MTEXT');
  check('MTEXT survives a save/reload round trip',
    restored && restored.content === 'ROUND\nTRIP' && near(restored.width, 15));
}

reset();
{
  const base = { id: 1, type: 'MTEXT', layerId: '0', position: { x: 0, y: 0 }, width: 10, height: 1, rotation: 0, content: 'OK' };
  const bad = (patch, label) => {
    const doc = { format: 'browser-2d-draft', version: api.DOCUMENT_VERSION, name: 'x', units: api.defaultUnitSettings(),
      layers: [{ id: '0', name: '0', visible: true, locked: false, color: '#ffffff', linetype: 'continuous', lineweight: 0.25, printable: true }],
      currentLayerId: '0', nextId: 2, nextLayerId: 2, entities: [{ ...base, ...patch }] };
    const result = api.parseDocumentText(JSON.stringify(doc));
    check(`MTEXT validation rejects ${label}`, Boolean(result.error), JSON.stringify(result));
  };
  bad({ width: 0 }, 'zero width');
  bad({ width: -5 }, 'negative width');
  bad({ height: 0 }, 'zero height');
  bad({ content: '' }, 'empty content');
  bad({ content: '   ' }, 'whitespace-only content');
  bad({ content: 'x'.repeat(4001) }, 'content over the length cap');
  bad({ rotation: NaN }, 'a non-finite rotation');

  const ok = { format: 'browser-2d-draft', version: api.DOCUMENT_VERSION, name: 'x', units: api.defaultUnitSettings(),
    layers: [{ id: '0', name: '0', visible: true, locked: false, color: '#ffffff', linetype: 'continuous', lineweight: 0.25, printable: true }],
    currentLayerId: '0', nextId: 2, nextLayerId: 2, entities: [base] };
  const okResult = api.parseDocumentText(JSON.stringify(ok));
  check('a valid MTEXT document parses cleanly', !okResult.error, JSON.stringify(okResult));
}

// ---------------------------------------------------------------------------
// ID/LIST inquiry report
// ---------------------------------------------------------------------------
reset();
{
  const mtext = placeMText(P(0, 0), 40, 2, 0, ['ONE', 'TWO', 'THREE']);
  selectOnly(mtext.id);
  api.startCommand('LIST');
  check('LIST reports the MTEXT line count', api.inquiryText?.includes('3'), api.inquiryText);
  check('LIST reports the MTEXT content', api.inquiryText?.includes('ONE'), api.inquiryText);
}

// ---------------------------------------------------------------------------
// Plot output: one text op per wrapped line, correctly positioned.
// ---------------------------------------------------------------------------
reset();
{
  placeMText(P(0, 0), 100, 1, 0, ['FIRST', 'SECOND']);
  const plan = api.buildPlotPlan({ ...api.defaultPlotSettings(), scaleMode: 'exact', scale: 1 });
  const textOps = plan.ops.filter(op => op.kind === 'text');
  check('MTEXT plots one text op per line', textOps.length === 2, JSON.stringify(textOps));
  check('MTEXT plots lines in top-to-bottom order',
    textOps[0]?.text === 'FIRST' && textOps[1]?.text === 'SECOND');
  check('MTEXT\'s second line plots below the first (paper Y runs up from the sheet bottom)',
    textOps[1].y < textOps[0].y, JSON.stringify(textOps.map(op => op.y)));
}

// ---------------------------------------------------------------------------
// Live on-canvas preview while typing content — the fix this suite exists to
// cover, for both MTEXT and (as a regression guard) TEXT.
// ---------------------------------------------------------------------------
reset();
{
  api.startCommand('TEXT');
  api.commitPoint(P(0, 0));
  api.commitDistance(1);
  api.submitCommandText('0'); // rotation -> now in CONTENT stage
  check('TEXT has nothing to preview before any keystroke reaches CONTENT',
    api.commandCapabilities.previewReady === false);
  api.commandLiveValue('HELLO');
  check('TEXT becomes preview-ready the moment a keystroke is live',
    api.commandCapabilities.previewReady === true);
  check('TEXT stores the live, uncommitted keystrokes for the preview to draw',
    api.state.text.liveContent === 'HELLO');
  check('TEXT has not yet committed an entity for unsent keystrokes',
    !api.entities.some(e => e.type === 'TEXT'));
  api.submitCommandText('HELLO');
  const text = api.entities.find(e => e.type === 'TEXT');
  check('TEXT still commits normally once Enter is pressed', text?.content === 'HELLO');
}

reset();
{
  api.startCommand('MTEXT');
  api.commitPoint(P(0, 0));
  api.commitDistance(20);
  api.commitDistance(1);
  api.submitCommandText('0'); // rotation -> now in CONTENT stage
  check('MTEXT has nothing to preview before any keystroke reaches CONTENT',
    api.commandCapabilities.previewReady === false);
  api.commandLiveValue('IN PROGRESS');
  check('MTEXT becomes preview-ready as soon as a line is being typed',
    api.commandCapabilities.previewReady === true);
  check('MTEXT stores the live, uncommitted line for the preview to draw',
    api.state.mtext.liveContent === 'IN PROGRESS');

  // Committing a line clears the live buffer but stays preview-ready, since
  // the committed line itself is still there to draw.
  api.submitCommandText('IN PROGRESS');
  check('MTEXT clears the live buffer once a line is committed',
    api.state.mtext.liveContent === '');
  check('MTEXT stays preview-ready on its committed lines alone',
    api.commandCapabilities.previewReady === true);
  check('a committed line is not yet a placed entity',
    !api.entities.some(e => e.type === 'MTEXT'));

  api.commandLiveValue('SECOND');
  api.submitCommandText('');
  const mtext = api.entities.find(e => e.type === 'MTEXT');
  check('MTEXT commits the accumulated lines once a blank line finishes entry',
    mtext?.content === 'IN PROGRESS');
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
