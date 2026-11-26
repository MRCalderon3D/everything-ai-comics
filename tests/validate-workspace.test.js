'use strict';
/**
 * validate-workspace.js: schema, cross-reference, review, edition,
 * generation-record, and lettering gates, plus the merged panel ledger.
 * Each rule gets a clean workspace broken in one place and must surface its
 * own code. The tests bring their own schemas, so they do not depend on
 * schemas/ or examples/ being written yet.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateWorkspace, reviewSummary } = require('../scripts/validate-workspace');
const artifacts = require('../scripts/lib/artifacts');
const hooksLib = require('../hooks/lib');
const {
  REPO_ROOT, PAGE_1, PAGE_2, makeWorkspace, sharedWorkspace, tempDir, castRow, createRunner,
} = require('./fixtures/gates/workspace-helper');

const SCRIPT = path.join(REPO_ROOT, 'scripts', 'validate-workspace.js');
const t = createRunner('validate-workspace');

const ISSUE = 'issues/ISS_001/issue.yaml';
const SCENE = 'issues/ISS_001/scenes/SC_001_01.yaml';
const REVIEW_P1 = 'issues/ISS_001/pages/PG_001_001/reviews/PG_001_001_V01.review.yaml';
const REVIEW_P2_V1 = 'issues/ISS_001/pages/PG_001_002/reviews/PG_001_002_V01.review.yaml';
const REVIEW_P2_V2 = 'issues/ISS_001/pages/PG_001_002/reviews/PG_001_002_V02.review.yaml';
const EDITION = 'editions/ED_001_01/edition.yaml';
const GENERATION = 'generations/PG_001_001/GEN_PG_001_001_01.yaml';
const LETTERING = 'issues/ISS_001/pages/PG_001_001/lettering.yaml';
const PLAN = 'issues/ISS_001/pages/PG_001_001/reference-plan.yaml';
const PACKAGE = 'issues/ISS_001/pages/PG_001_001/prompts/harness-native.yaml';

/** An empty schemas dir: every schema is "missing", so only the other gates speak. */
const NO_SCHEMAS = tempDir('comics-no-schemas-');

const withWorkspace = sharedWorkspace();

/** Break a clean workspace with `mutate` and validate it without schemas. */
function run(mutate, opts = {}) {
  return withWorkspace(mutate, (w) => validateWorkspace(w.root, { schemasDir: NO_SCHEMAS, ...opts }));
}

const codes = (items) => items.map((i) => i.code);

function hasError(result, code, file) {
  const hit = result.errors.find((e) => e.code === code && (!file || e.file === file));
  assert.ok(hit, `expected error ${code}${file ? ` on ${file}` : ''}, got ${JSON.stringify(result.errors, null, 1)}`);
  assert.ok(typeof hit.message === 'string' && hit.message.length > 10);
  return hit;
}

function noError(result, code) {
  assert.ok(!codes(result.errors).includes(code), `unexpected error ${code}: ${JSON.stringify(result.errors, null, 1)}`);
}

function hasWarning(result, code) {
  const hit = result.warnings.find((e) => e.code === code);
  assert.ok(hit, `expected warning ${code}, got ${JSON.stringify(result.warnings, null, 1)}`);
  return hit;
}

// --- the clean workspace -------------------------------------------------------

t.test('clean workspace: zero errors; missing schemas are warnings only', () => {
  const result = run();
  assert.deepStrictEqual(result.errors, []);
  assert.ok(result.warnings.length > 0, 'every schema is missing in this run');
  assert.ok(result.warnings.every((w) => w.code === 'SCHEMA_MISSING'), JSON.stringify(result.warnings, null, 1));
  assert.deepStrictEqual(Object.keys(result).sort(), ['errors', 'warnings']);
});

t.test('clean workspace validates against the scaffold schemas that exist', () => {
  // Skipped per schema while schemas/ is still being written.
  const w = makeWorkspace();
  const result = validateWorkspace(w.root);
  const schemaErrors = result.errors.filter((e) => e.code === 'SCHEMA');
  assert.deepStrictEqual(schemaErrors, [], 'the gate fixture must satisfy the real schemas');
  assert.deepStrictEqual(result.errors, []);
});

// --- a. schemas ----------------------------------------------------------------

function schemasWith(name, schema) {
  const dir = tempDir('comics-schemas-');
  fs.writeFileSync(path.join(dir, `${name}.schema.json`), JSON.stringify(schema));
  return dir;
}

const ISSUE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['id', 'number', 'title', 'summary', 'scenes', 'page_count', 'status'],
  properties: {
    id: { type: 'string', pattern: '^ISS_\\d{3}$' },
    status: { enum: ['planning', 'scripting', 'production', 'review', 'published'] },
  },
};

t.test('a. a file that violates its schema is SCHEMA', () => {
  const schemasDir = schemasWith('issue', ISSUE_SCHEMA);
  assert.deepStrictEqual(run(null, { schemasDir }).errors, [], 'the clean issue.yaml satisfies the test schema');
  const result = run((w) => w.edit(ISSUE, (issue) => {
    delete issue.title;
    issue.status = 'drawing';
  }), { schemasDir });
  const schemaErrors = result.errors.filter((e) => e.code === 'SCHEMA');
  assert.strictEqual(schemaErrors.length, 2, JSON.stringify(result.errors, null, 1));
  assert.ok(schemaErrors.every((e) => e.file === ISSUE));
});

t.test('a. a missing schema file is a SCHEMA_MISSING warning and the run continues', () => {
  const result = run();
  const w = hasWarning(result, 'SCHEMA_MISSING');
  assert.ok(/^schemas\/[a-z-]+\.schema\.json$/.test(w.file), w.file);
  const names = result.warnings.map((x) => x.file.replace(/^schemas\/|\.schema\.json$/g, '')).sort();
  for (const expected of ['project', 'character', 'wardrobe', 'location', 'location-map', 'prop', 'issue', 'scene',
    'page', 'lettering', 'reference-plan', 'prompt-package', 'visual-review', 'generation-record',
    'continuity-state', 'edition']) {
    assert.ok(names.includes(expected), `fixture should exercise the ${expected} mapping (got ${names})`);
  }
});

t.test('a. unparseable YAML is YAML_PARSE, never a throw', () => {
  const result = run((w) => w.writeText(SCENE, 'id: SC_001_01\n  cast: [broken\n'));
  hasError(result, 'YAML_PARSE', SCENE);
});

t.test('the path -> schema mapping covers the workspace layout, and the hooks share it', () => {
  const expected = {
    'project.yaml': 'project',
    'story/story-bible.yaml': 'story-bible',
    'story/series-plan.yaml': 'series-plan',
    'characters/CHAR_MARA/character.yaml': 'character',
    'characters/CHAR_MARA/wardrobe.yaml': 'wardrobe',
    'locations/LOC_FERRY_DECK/location.yaml': 'location',
    'locations/LOC_FERRY_DECK/map.yaml': 'location-map',
    'props/PROP_FLARE_GUN/prop.yaml': 'prop',
    'issues/ISS_001/issue.yaml': 'issue',
    'issues/ISS_001/scenes/SC_001_01.yaml': 'scene',
    'issues/ISS_001/pages/PG_001_004/page.yaml': 'page',
    'issues/ISS_001/pages/PG_001_004/lettering.yaml': 'lettering',
    'issues/ISS_001/pages/PG_001_004/reference-plan.yaml': 'reference-plan',
    'issues/ISS_001/pages/PG_001_004/prompts/harness-native.yaml': 'prompt-package',
    'issues/ISS_001/pages/PG_001_004/reviews/PG_001_004_V02.review.yaml': 'visual-review',
    'generations/PG_001_004/GEN_PG_001_004_01.yaml': 'generation-record',
    'continuity/ISS_001.final-state.yaml': 'continuity-state',
    'editions/ED_001_01/edition.yaml': 'edition',
    'references/manifest.yaml': null,
    'style/style-bible.md': null,
    'issues/ISS_001/pages/PG_001_004/renders/PG_001_004_V01.png': null,
  };
  for (const [rel, name] of Object.entries(expected)) {
    assert.strictEqual(artifacts.schemaNameFor(rel), name, rel);
    assert.strictEqual(hooksLib.schemaNameFor(rel), name, `hooks: ${rel}`);
  }
  // Every schema name the mapping knows is reachable from a path above.
  assert.deepStrictEqual([...artifacts.SCHEMA_NAMES].sort(),
    [...new Set(Object.values(expected).filter(Boolean))].sort());
});

// --- b. cross-references -------------------------------------------------------

t.test('b. an id that disagrees with its path is ID_PATH_MISMATCH', () => {
  hasError(run((w) => w.edit(PAGE_2, (p) => { p.id = 'PG_001_009'; })), 'ID_PATH_MISMATCH', PAGE_2);
  hasError(run((w) => w.edit(PAGE_2, (p) => { p.issue = 'ISS_002'; })), 'ID_PATH_MISMATCH', PAGE_2);
  hasError(run((w) => w.edit(SCENE, (s) => { s.id = 'SC_001_07'; })), 'ID_PATH_MISMATCH', SCENE);
  hasError(run((w) => w.edit('characters/CHAR_MARA/character.yaml', (c) => { c.id = 'CHAR_MARTA'; })),
    'ID_PATH_MISMATCH', 'characters/CHAR_MARA/character.yaml');
  hasError(run((w) => w.edit(PAGE_1, (p) => { p.panels[0].id = 'PN_001_002_01'; })), 'ID_PATH_MISMATCH', PAGE_1);
});

t.test('b. issue.scenes that disagree with the scene files is ISSUE_SCENES_MISMATCH', () => {
  hasError(run((w) => w.edit(ISSUE, (i) => { i.scenes = ['SC_001_01', 'SC_001_02']; })), 'ISSUE_SCENES_MISMATCH', ISSUE);
  hasError(run((w) => w.edit(ISSUE, (i) => { i.scenes = []; })), 'ISSUE_SCENES_MISMATCH', ISSUE);
});

t.test('b. scene.pages that disagree with page.scene is SCENE_PAGES_MISMATCH', () => {
  hasError(run((w) => w.edit(SCENE, (s) => { s.pages = ['PG_001_001']; })), 'SCENE_PAGES_MISMATCH', PAGE_2);
  hasError(run((w) => w.edit(SCENE, (s) => { s.pages.push('PG_001_003'); })), 'SCENE_PAGES_MISMATCH', SCENE);
  hasError(run((w) => w.edit(PAGE_2, (p) => { p.scene = 'SC_001_02'; })), 'SCENE_PAGES_MISMATCH', PAGE_2);
});

t.test('b. counts that disagree with the files are PAGE_COUNT_MISMATCH / PANEL_COUNT_MISMATCH', () => {
  const pageCount = hasError(run((w) => w.edit(ISSUE, (i) => { i.page_count = 3; })), 'PAGE_COUNT_MISMATCH', ISSUE);
  assert.ok(pageCount.message.includes('3') && pageCount.message.includes('2'), pageCount.message);
  hasError(run((w) => w.edit(ISSUE, (i) => { i.panel_count = 8; })), 'PANEL_COUNT_MISMATCH', ISSUE);
});

t.test('b. an asset that is not in references/manifest.yaml is UNKNOWN_ASSET', () => {
  hasError(run((w) => w.edit(PLAN, (p) => { p.required[0].asset_id = 'LOOK_SEPIA_MASTER_V01'; })), 'UNKNOWN_ASSET', PLAN);
  hasError(run((w) => w.edit(PACKAGE, (p) => { p.references[1].asset_id = 'CHAR_MARA_TURN_MASTER_V07'; })),
    'UNKNOWN_ASSET', PACKAGE);
  hasError(run((w) => w.edit(PAGE_1, (p) => { p.references.required.push('PROP_FLARE_GUN_MASTER_V01'); })),
    'UNKNOWN_ASSET', PAGE_1);
});

t.test('b. a previous render used as a reference must exist on disk', () => {
  const ok = run((w) => w.edit(PLAN, (p) => {
    p.optional.push({ asset_id: 'PG_001_002_V02', entity: null, role: 'spatial_continuity', priority: 'low', reason: 'Neighbour.' });
  }));
  assert.deepStrictEqual(ok.errors, []);
  hasError(run((w) => w.edit(PLAN, (p) => {
    p.optional.push({ asset_id: 'PG_001_002_V05', entity: null, role: 'spatial_continuity', priority: 'low', reason: 'Neighbour.' });
  })), 'MISSING_RENDER', PLAN);
});

t.test('b. a current_render with no file on disk is MISSING_RENDER', () => {
  hasError(run((w) => w.remove('issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.png')), 'MISSING_RENDER', PAGE_1);
});

// --- c. review rules -----------------------------------------------------------

t.test('c. verdict pass with a finding or a failed check is REVIEW_PASS_NOT_CLEAN', () => {
  hasError(run((w) => w.edit(REVIEW_P1, (r) => {
    r.findings = [{
      id: 'F01', panel: null, check: 'wardrobe', expected: 'Torn left cuff.', visible: 'Cuff intact in panel 1.',
      severity: 'minor', repair: 'None.', status: 'accepted',
    }];
  })), 'REVIEW_PASS_NOT_CLEAN', REVIEW_P1);
  hasError(run((w) => w.edit(REVIEW_P1, (r) => {
    r.checks.wardrobe = { result: 'fail', evidence: 'Cuff intact in panel 1.' };
  })), 'REVIEW_PASS_NOT_CLEAN', REVIEW_P1);
});

t.test('c. verdict fixed with no findings is REVIEW_FIXED_WITHOUT_FINDINGS', () => {
  hasError(run((w) => w.edit(REVIEW_P2_V2, (r) => { r.findings = []; })), 'REVIEW_FIXED_WITHOUT_FINDINGS', REVIEW_P2_V2);
});

t.test('c. a fixed finding without a recheck is REVIEW_RECHECK_MISSING', () => {
  hasError(run((w) => w.edit(REVIEW_P2_V2, (r) => { delete r.findings[0].recheck; })), 'REVIEW_RECHECK_MISSING', REVIEW_P2_V2);
  hasError(run((w) => w.edit(REVIEW_P2_V2, (r) => { r.findings[0].recheck.evidence = ''; })),
    'REVIEW_RECHECK_MISSING', REVIEW_P2_V2);
  // A recheck against a render nobody can open is no recheck.
  hasError(run((w) => w.edit(REVIEW_P2_V2, (r) => { r.findings[0].recheck.render = 'PG_001_002_V09'; })),
    'REVIEW_RECHECK_MISSING', REVIEW_P2_V2);
});

t.test('c. an open blocking finding or a failed gate needs verdict flagged: REVIEW_MUST_BE_FLAGGED', () => {
  hasError(run((w) => w.edit(REVIEW_P2_V2, (r) => {
    r.findings[0].status = 'open';
    delete r.findings[0].recheck;
  })), 'REVIEW_MUST_BE_FLAGGED', REVIEW_P2_V2);
  hasError(run((w) => w.edit(REVIEW_P1, (r) => { r.gates.style_fidelity = 'fail'; })), 'REVIEW_MUST_BE_FLAGGED', REVIEW_P1);
  // The flagged review in the fixture is consistent.
  noError(run(), 'REVIEW_MUST_BE_FLAGGED');
});

t.test('c. a blocking finding marked accepted is REVIEW_BLOCKING_ACCEPTED', () => {
  hasError(run((w) => w.edit(REVIEW_P2_V2, (r) => {
    r.findings[0].status = 'accepted';
    delete r.findings[0].recheck;
  })), 'REVIEW_BLOCKING_ACCEPTED', REVIEW_P2_V2);
});

t.test('c. repair_cycle above project.repair_policy.max_cycles is REVIEW_REPAIR_LIMIT', () => {
  hasError(run((w) => w.edit(REVIEW_P2_V2, (r) => { r.repair_cycle = 3; })), 'REVIEW_REPAIR_LIMIT', REVIEW_P2_V2);
  hasError(run((w) => w.edit('project.yaml', (p) => { p.repair_policy.max_cycles = 0; })), 'REVIEW_REPAIR_LIMIT', REVIEW_P2_V2);
  // Default is 2 when the project does not say.
  noError(run((w) => w.edit('project.yaml', (p) => { delete p.repair_policy; })), 'REVIEW_REPAIR_LIMIT');
});

t.test('c. a reviewed page without a passing review of its current render is PAGE_STATUS_UNREVIEWED', () => {
  hasError(run((w) => w.edit(PAGE_2, (p) => { p.current_render = 'PG_001_002_V01'; })), 'PAGE_STATUS_UNREVIEWED', PAGE_2);
  hasError(run((w) => w.remove(REVIEW_P1)), 'PAGE_STATUS_UNREVIEWED', PAGE_1);
  hasError(run((w) => w.edit(PAGE_1, (p) => { p.current_render = null; })), 'PAGE_STATUS_UNREVIEWED', PAGE_1);
  // A page still in "rendered" status may point at a flagged render.
  noError(run((w) => w.edit(PAGE_2, (p) => {
    p.current_render = 'PG_001_002_V01';
    p.status = 'rendered';
  })), 'PAGE_STATUS_UNREVIEWED');
});

t.test('c. a review of a render that is not on disk is MISSING_RENDER', () => {
  hasError(run((w) => w.remove('issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V01.png')), 'MISSING_RENDER', REVIEW_P2_V1);
});

// --- d. edition rules ----------------------------------------------------------

t.test('d. a listed file that is not on disk is EDITION_RENDER_MISSING', () => {
  hasError(run((w) => w.edit(EDITION, (e) => {
    e.pages[0].file = 'issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.jpg';
  })), 'EDITION_RENDER_MISSING', EDITION);
});

t.test('d. an unreviewed render is an error in a non-draft edition and a warning in a draft', () => {
  const listFlagged = (status) => (w) => w.edit(EDITION, (e) => {
    e.status = status;
    e.pages[1].render = 'PG_001_002_V01';
    e.pages[1].file = 'issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V01.png';
  });
  hasError(run(listFlagged('reviewed')), 'EDITION_RENDER_UNREVIEWED', EDITION);
  hasError(run(listFlagged('published')), 'EDITION_RENDER_UNREVIEWED', EDITION);
  const draft = run(listFlagged('draft'));
  noError(draft, 'EDITION_RENDER_UNREVIEWED');
  hasWarning(draft, 'EDITION_RENDER_UNREVIEWED');
  assert.deepStrictEqual(draft.errors, []);
});

t.test('d. a render of another page, or a file of another render, is EDITION_RENDER_MISMATCH', () => {
  hasError(run((w) => w.edit(EDITION, (e) => { e.pages[1].render = 'PG_001_001_V01'; })), 'EDITION_RENDER_MISMATCH', EDITION);
  hasError(run((w) => w.edit(EDITION, (e) => {
    e.pages[1].file = 'issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V01.png';
  })), 'EDITION_RENDER_MISMATCH', EDITION);
});

t.test('d. a page listed twice is EDITION_PAGE_DUPLICATE', () => {
  hasError(run((w) => w.edit(EDITION, (e) => { e.pages.push({ ...e.pages[0] }); })), 'EDITION_PAGE_DUPLICATE', EDITION);
});

t.test('d. pages out of page-number order is EDITION_PAGE_ORDER', () => {
  hasError(run((w) => w.edit(EDITION, (e) => { e.pages.reverse(); })), 'EDITION_PAGE_ORDER', EDITION);
});

t.test('d. a missing page is EDITION_PAGE_GAP; a draft may stop short of the end', () => {
  hasError(run((w) => w.edit(EDITION, (e) => { e.pages.shift(); })), 'EDITION_PAGE_GAP', EDITION);
  hasError(run((w) => w.edit(EDITION, (e) => { e.pages.pop(); })), 'EDITION_PAGE_GAP', EDITION);
  const draft = run((w) => w.edit(EDITION, (e) => {
    e.status = 'draft';
    e.pages.pop();
  }));
  noError(draft, 'EDITION_PAGE_GAP');
  hasWarning(draft, 'EDITION_PAGE_GAP');
  // A hole at the start is an error even in a draft.
  hasError(run((w) => w.edit(EDITION, (e) => {
    e.status = 'draft';
    e.pages.shift();
  })), 'EDITION_PAGE_GAP', EDITION);
});

t.test('d. a page of another issue is EDITION_PAGE_UNKNOWN', () => {
  hasError(run((w) => w.edit(EDITION, (e) => {
    e.pages.push({ page: 'PG_002_001', render: 'PG_002_001_V01', file: 'issues/ISS_002/pages/PG_002_001/renders/PG_002_001_V01.png' });
  })), 'EDITION_PAGE_UNKNOWN', EDITION);
});

// --- e. generation records -----------------------------------------------------

t.test('e. metadata_unavailable that contradicts the fields is GENERATION_METADATA_INCONSISTENT', () => {
  hasError(run((w) => w.edit(GENERATION, (g) => { g.model = 'flux-pro-1.1'; })), 'GENERATION_METADATA_INCONSISTENT', GENERATION);
  hasError(run((w) => w.edit(GENERATION, (g) => { g.seed = 42; })), 'GENERATION_METADATA_INCONSISTENT', GENERATION);
  hasError(run((w) => w.edit(GENERATION, (g) => { g.cost.reported = true; })), 'GENERATION_METADATA_INCONSISTENT', GENERATION);
  // A number the tool did not report and nobody estimated.
  hasError(run((w) => w.edit(GENERATION, (g) => { g.cost.amount = 0.04; })), 'GENERATION_METADATA_INCONSISTENT', GENERATION);
});

t.test('e. reported metadata is fine; unavailable fields left off the list are a warning', () => {
  const reported = run((w) => w.edit(GENERATION, (g) => {
    g.model = 'flux-pro-1.1';
    g.seed = 42;
    g.cost = { currency: 'USD', amount: 0.04, estimated: false, reported: true };
    g.metadata_unavailable = [];
  }));
  assert.deepStrictEqual(reported.errors, []);
  assert.ok(!codes(reported.warnings).includes('GENERATION_METADATA_INCONSISTENT'));

  const unlisted = run((w) => w.edit(GENERATION, (g) => { g.metadata_unavailable = []; }));
  noError(unlisted, 'GENERATION_METADATA_INCONSISTENT');
  assert.strictEqual(unlisted.warnings.filter((x) => x.code === 'GENERATION_METADATA_INCONSISTENT').length, 3);

  // A dry run has reported nothing yet, so nothing is "unavailable".
  const dryRun = run((w) => w.edit(GENERATION, (g) => {
    g.status = 'dry_run';
    g.output_render = null;
    g.metadata_unavailable = [];
  }));
  assert.deepStrictEqual(dryRun.errors, []);
  assert.ok(!codes(dryRun.warnings).includes('GENERATION_METADATA_INCONSISTENT'));
});

// --- f. lettering ----------------------------------------------------------------

t.test('f. overlay text that differs from page.yaml is LETTERING_TEXT_MISMATCH', () => {
  const e = hasError(run((w) => w.edit(LETTERING, (l) => { l.elements[0].text = 'Last crossing of the nigth.'; })),
    'LETTERING_TEXT_MISMATCH', LETTERING);
  assert.ok(e.message.includes('L01') && e.message.includes('nigth') && e.message.includes('night'), e.message);
  // Case and accents count: the text must be exact.
  hasError(run((w) => w.edit(LETTERING, (l) => { l.elements[1].text = 'Thump'; })), 'LETTERING_TEXT_MISMATCH', LETTERING);
});

t.test('f. an overlay element with no lettering id in page.yaml is LETTERING_UNKNOWN_ELEMENT', () => {
  hasError(run((w) => w.edit(LETTERING, (l) => { l.elements[1].id = 'L09'; })), 'LETTERING_UNKNOWN_ELEMENT', LETTERING);
});

// --- g. merged ledger ------------------------------------------------------------

t.test('g. ledger findings are merged with the page file as their file', () => {
  const result = run((w) => w.edit(PAGE_2, (p) => { p.panels[0].transfers = []; }));
  hasError(result, 'CUSTODY_JUMP', PAGE_2);
  const warned = run((w) => w.remove('locations/LOC_FERRY_DECK/map.yaml'));
  hasWarning(warned, 'UNKNOWN_REFERENCE');
  noError(warned, 'UNKNOWN_REFERENCE');
});

// --- robustness, scope, CLI ------------------------------------------------------

t.test('a malformed workspace is reported, never thrown', () => {
  const notWorkspace = validateWorkspace(tempDir());
  assert.deepStrictEqual(codes(notWorkspace.errors), ['NOT_A_WORKSPACE']);

  const w = makeWorkspace();
  w.writeText('project.yaml', 'title: [unterminated\n');
  w.writeText(ISSUE, '- just\n- a\n- list\n');
  w.writeText(PAGE_1, '');
  w.writeText(REVIEW_P2_V2, 'verdict: fixed\nfindings: nope\nchecks: 3\n');
  w.writeText(EDITION, 'id: ED_001_01\nissue: ISS_001\nstatus: reviewed\npages: [1, two, {page: PG_001_001}]\n');
  w.writeText('references/manifest.yaml', 'assets: 12\n');
  w.writeText('issues/ISS_001/pages/PG_001_002/reviews/garbage.review.yaml', ': : :\n');
  fs.mkdirSync(w.abs('issues/ISS_001/pages/PG_001_003'), { recursive: true });
  let result;
  assert.doesNotThrow(() => { result = validateWorkspace(w.root, { schemasDir: NO_SCHEMAS }); });
  assert.ok(result.errors.length > 0);
  assert.ok(!codes(result.errors).includes('INTERNAL_ERROR'), JSON.stringify(result.errors, null, 1));
  hasError(result, 'YAML_PARSE', 'project.yaml');
  hasError(result, 'MISSING_FILE', 'issues/ISS_001/pages/PG_001_003/page.yaml');
});

t.test('--issue limits issue-scoped checks; an unknown issue is MISSING_FILE', () => {
  assert.deepStrictEqual(run(null, { issue: 'ISS_001' }).errors, []);
  hasError(run(null, { issue: 'ISS_009' }), 'MISSING_FILE');
});

t.test('reviewSummary counts the recorded verdicts of the current renders', () => {
  const w = makeWorkspace();
  assert.deepStrictEqual(reviewSummary(w.root),
    { pages: 2, no_render: 0, pass: 1, fixed: 1, flagged: 0, unreviewed: 0 });
});

t.test('CLI: mechanical validation and visual review stay under separate headings', () => {
  const w = makeWorkspace('production-night-ferry');
  let res = spawnSync(process.execPath, [SCRIPT, '--root', w.root], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  const lines = res.stdout.trim().split('\n').map((l) => l.trim());
  const mechanical = lines.indexOf('## Mechanical validation');
  const visual = lines.indexOf('## Visual review');
  assert.ok(mechanical !== -1 && visual > mechanical, res.stdout);
  assert.strictEqual(lines[lines.length - 1],
    'Mechanical validation does not certify the drawn pages. Only a visual review of the rendered pixels does.');

  // --root may point inside the workspace; the root is found by project.yaml.
  res = spawnSync(process.execPath, [SCRIPT, '--root', w.abs('issues/ISS_001'), '--json'], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  const clean = JSON.parse(res.stdout);
  assert.deepStrictEqual(clean.errors, []);
  assert.ok(Array.isArray(clean.warnings));

  w.edit(REVIEW_P2_V2, (r) => { delete r.findings[0].recheck; });
  res = spawnSync(process.execPath, [SCRIPT, '--root', w.root, '--json'], { encoding: 'utf8' });
  assert.strictEqual(res.status, 1);
  assert.ok(JSON.parse(res.stdout).errors.some((e) => e.code === 'REVIEW_RECHECK_MISSING'));

  res = spawnSync(process.execPath, [SCRIPT, '--root', w.root], { encoding: 'utf8' });
  assert.strictEqual(res.status, 1);
  assert.ok(res.stdout.includes('[REVIEW_RECHECK_MISSING]') && res.stdout.includes('does not certify the drawn pages'), res.stdout);
});

// castRow is part of the shared helper; keep one ledger-through-validate case that uses it.
t.test('g. a dropped state tag reaches validate-workspace as STATE_DROPPED', () => {
  hasError(run((w) => w.edit(PAGE_2, (p) => { castRow(p, 1, 'CHAR_OSKAR').state = []; })), 'STATE_DROPPED', PAGE_2);
});

t.finish();
