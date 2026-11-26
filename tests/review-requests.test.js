'use strict';
/**
 * Change requests from a person (scripts/lib/review-requests.js): the
 * finding they become, the review a request opens when a render has none,
 * the repair that picks them up, and the review rules validate-workspace.js
 * holds them to. Runs on a throwaway copy of the example workspace.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('../scripts/lib/yaml');
const ws = require('../scripts/lib/workspace');
const requests = require('../scripts/lib/review-requests');
const { validateDoc } = require('../scripts/lib/page-pipeline');
const { compilePage, selectFindings } = require('../scripts/compile-prompts');
const { validateWorkspace } = require('../scripts/validate-workspace');

const ROOT = path.resolve(__dirname, '..');
const EXAMPLE = path.join(ROOT, 'examples', 'the-night-ferry');
const NOW = new Date('2026-11-27T09:00:00Z');
const temps = [];

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64');

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eac-requests-'));
  temps.push(dir);
  const root = path.join(dir, 'production');
  copyTree(EXAMPLE, root);
  return root;
}

const abs = (root, rel) => path.join(root, ...rel.split('/'));
const read = (root, rel) => fs.readFileSync(abs(root, rel), 'utf8');
const readYaml = (root, rel) => yaml.parse(read(root, rel));

async function errorCodes(root) {
  const check = await validateWorkspace(root, {});
  return check.errors.map((e) => `${e.file}: ${e.code}`);
}

function refuses(fn, code, pattern) {
  let caught = null;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, `expected a refusal with code ${code}`);
  assert.strictEqual(caught.code, code, `expected ${code}, got ${caught.code}: ${caught.message}`);
  if (pattern) assert.ok(pattern.test(caught.message), caught.message);
}

const REVIEW_2 = 'issues/ISS_001/pages/PG_001_002/reviews/PG_001_002_V02.review.yaml';
const PAGE_2 = 'issues/ISS_001/pages/PG_001_002/page.yaml';

async function testRequestOnReviewedRender() {
  const root = makeWorkspace();
  const before = readYaml(root, REVIEW_2);
  assert.strictEqual(before.verdict, 'fixed');
  assert.strictEqual(readYaml(root, PAGE_2).status, 'reviewed');
  const pageText = read(root, PAGE_2);

  const out = requests.addUserRequest({
    root,
    page: 'PG_001_002',
    render: 'PG_001_002_V02',
    text: '  Make the searchlight beam wider,\n so it reaches the crates. ',
    panel: 'PN_001_002_04',
    region: { x: 0.5, y: 0.52, w: 0.45, h: 0.4 },
    now: NOW,
  });
  assert.strictEqual(out.reviewFile, abs(root, REVIEW_2));
  assert.strictEqual(out.created, false);
  assert.strictEqual(out.verdict, 'flagged');
  assert.deepStrictEqual(out.finding, {
    id: 'F02',
    panel: 'PN_001_002_04',
    source: 'user_request',
    region: { x: 0.5, y: 0.52, w: 0.45, h: 0.4 },
    expected: 'The requested change shows in the panel, and nothing else differs.',
    visible: 'The panel as drawn in PG_001_002_V02, before the requested change.',
    severity: 'minor',
    repair: 'Make the searchlight beam wider, so it reaches the crates.',
    status: 'open',
  });

  // The review: one more finding, flagged, everything the reviewer wrote kept.
  const review = readYaml(root, REVIEW_2);
  assert.ok(validateDoc('visual-review', review).valid);
  assert.strictEqual(review.verdict, 'flagged');
  assert.strictEqual(review.findings.length, before.findings.length + 1);
  assert.deepStrictEqual(review.findings.slice(0, -1), before.findings);
  assert.deepStrictEqual(review.findings[review.findings.length - 1], out.finding);
  assert.deepStrictEqual(review.checks, before.checks);
  assert.deepStrictEqual(review.gates, before.gates);
  assert.strictEqual(review.repair_cycle, before.repair_cycle);
  assert.ok(read(root, REVIEW_2).startsWith('# Schema: schemas/visual-review.schema.json\n# Repair of V01.'),
    'the header comments of the review survive');

  // The page no longer has a passing review of its current render, so it falls back to rendered.
  assert.deepStrictEqual(out.statusChange, { file: PAGE_2, from: 'reviewed', to: 'rendered' });
  assert.strictEqual(read(root, PAGE_2), pageText.replace(/^status: reviewed$/m, 'status: rendered'),
    'only the status line of page.yaml changes');
  assert.deepStrictEqual(await errorCodes(root), [], 'the workspace still passes its gates');

  // A second request, on the whole page, with what the person sees and a named check.
  const second = requests.addUserRequest({
    root, render: 'PG_001_002_V02', text: 'The caption should read "Too late."', check: 'lettering',
    severity: 'blocking', visible: 'The caption reads "To late."', now: NOW,
  });
  assert.strictEqual(second.finding.id, 'F03');
  assert.strictEqual(second.finding.panel, null);
  assert.strictEqual(second.finding.check, 'lettering');
  assert.strictEqual(second.finding.severity, 'blocking');
  assert.strictEqual(second.finding.visible, 'The caption reads "To late."');
  assert.strictEqual(second.finding.expected, 'The requested change shows in the page, and nothing else differs.');
  assert.strictEqual(second.statusChange, null, 'the page already fell back');
  assert.deepStrictEqual(await errorCodes(root), []);

  // The repair picks both requests up.
  const flagged = readYaml(root, REVIEW_2);
  const selected = selectFindings(flagged);
  assert.deepStrictEqual(selected.map((f) => f.id), ['F02', 'F03'], 'the fixed finding F01 is not repaired again');
  assert.strictEqual(selected[0].check, 'user_request', 'a request with no check is labelled for the prompt');
  assert.strictEqual(flagged.findings[1].check, undefined, 'the review itself is not changed by the selection');
  const { pkg } = compilePage(root, ws.loadPage(root, 'PG_001_002'), { repairReview: flagged });
  assert.strictEqual(pkg.mode, 'repair');
  assert.deepStrictEqual(pkg.repair.findings, ['F02', 'F03']);
  assert.strictEqual(pkg.repair.of_render, 'PG_001_002_V02');
  assert.ok(validateDoc('prompt-package', pkg).valid);
  assert.ok(pkg.repair.changes[0].startsWith(
    'Panel 4, in the area from 50% to 95% of the width (left to right) and from 52% to 92% of the height (top to bottom) of the page: ' +
    'Make the searchlight beam wider, so it reaches the crates.'), pkg.repair.changes[0]);
  assert.ok(pkg.repair.changes[1].startsWith('Whole page: The caption should read "Too late."'), pkg.repair.changes[1]);
  assert.ok(/Failed check: user request\./.test(pkg.prompt), 'the prompt names the request');
  assert.ok(/Failed check: lettering\./.test(pkg.prompt));
  assert.ok(pkg.prompt.includes('Make the searchlight beam wider, so it reaches the crates.'));
  assert.ok(pkg.repair.locked.some((l) => /All lettering that CHANGES does not name/.test(l)),
    'a request filed under the lettering check unlocks the lettering it names');
}

function testSelection() {
  const f = (id, severity, status, source) => Object.assign({ id, severity, status, check: 'identity' }, source ? { source } : {});
  // Blocking findings first, as before; a minor request rides along; a minor reviewer finding waits.
  const mixed = { findings: [
    f('F01', 'minor', 'open'), f('F02', 'blocking', 'open'), f('F03', 'minor', 'open', 'user_request'),
    f('F04', 'minor', 'accepted', 'user_request'), f('F05', 'blocking', 'fixed'),
  ] };
  assert.deepStrictEqual(selectFindings(mixed).map((x) => x.id), ['F02', 'F03']);
  assert.deepStrictEqual(requests.selectRepairFindings(mixed).map((x) => x.id), ['F02', 'F03']);
  // No blocking finding: every open one, requests included, in file order.
  const minor = { findings: [f('F01', 'minor', 'open', 'user_request'), f('F02', 'minor', 'open')] };
  assert.deepStrictEqual(selectFindings(minor).map((x) => x.id), ['F01', 'F02']);
  // A review without requests selects exactly what it always did.
  const plain = { findings: [f('F01', 'minor', 'open'), f('F02', 'blocking', 'open')] };
  assert.deepStrictEqual(selectFindings(plain), [plain.findings[1]]);
  assert.deepStrictEqual(selectFindings({ findings: [] }), []);
  assert.deepStrictEqual(selectFindings({}), []);
  assert.strictEqual(requests.isUserRequest({ source: 'reviewer' }), false);
  assert.strictEqual(requests.isUserRequest({}), false, 'a finding with no source is the reviewer\'s');
}

async function testRequestOpensReview() {
  const root = makeWorkspace();
  const pageDir = ws.pageDir(root, 'PG_001_001');
  const render = 'PG_001_001_V02';
  const reviewRel = `issues/ISS_001/pages/PG_001_001/reviews/${render}.review.yaml`;

  // The render must exist: a request is about pixels.
  refuses(() => requests.addUserRequest({ root, render, text: 'x' }), 'render_missing', /needs the image it is about/);
  fs.writeFileSync(path.join(pageDir, 'renders', `${render}.png`), PNG);

  const out = requests.addUserRequest({ root, render, text: 'Lower the horizon a little.', now: NOW });
  assert.strictEqual(out.created, true);
  assert.strictEqual(out.reviewFile, abs(root, reviewRel));
  assert.strictEqual(out.finding.id, 'F01');
  assert.strictEqual(out.statusChange, null, 'the page still stands on V01 and its passing review');

  const review = readYaml(root, reviewRel);
  assert.ok(validateDoc('visual-review', review).valid, JSON.stringify(validateDoc('visual-review', review).errors));
  assert.strictEqual(review.page, 'PG_001_001');
  assert.strictEqual(review.render, render);
  assert.strictEqual(review.reviewer, 'human');
  assert.strictEqual(review.verdict, 'flagged');
  assert.strictEqual(review.supersedes, null);
  assert.strictEqual(review.repair_cycle, 0);
  assert.strictEqual(review.reviewed_at, '2026-11-27');
  assert.strictEqual(Object.keys(review.checks).length, 14);
  for (const key of requests.CHECK_KEYS) {
    assert.strictEqual(review.checks[key].result, 'not_performed', key);
    assert.ok(/^Not judged\./.test(review.checks[key].evidence));
  }
  assert.deepStrictEqual(review.gates, { style_fidelity: 'not_performed', narrative_continuity: 'not_performed' });
  assert.deepStrictEqual(review.human_approval, { status: 'pending', by: null, at: null });
  assert.ok(read(root, reviewRel).startsWith('# Schema: schemas/visual-review.schema.json\n# Opened by a change request.'));
  assert.deepStrictEqual(await errorCodes(root), [], 'a review opened by a request passes the gates as flagged');

  // A review opened by a request cannot be declared clean while nothing was judged.
  const cheat = Object.assign({}, review, { verdict: 'fixed' });
  cheat.findings = [Object.assign({}, review.findings[0], { status: 'fixed', recheck: { render, evidence: 'Looks lower.' } })];
  fs.writeFileSync(abs(root, reviewRel), yaml.stringify(cheat));
  const codes = await errorCodes(root);
  assert.ok(codes.includes(`${reviewRel}: REVIEW_MUST_BE_FLAGGED`), codes.join(' | '));
  const messages = (await validateWorkspace(root, {})).errors.map((e) => e.message).join('\n');
  assert.ok(/checks\.identity/.test(messages) && /gates\.style_fidelity/.test(messages) && /not performed/.test(messages), messages);

  // An open request keeps a judged review flagged too, even a minor one.
  const judged = JSON.parse(JSON.stringify(review));
  for (const key of requests.CHECK_KEYS) judged.checks[key] = { result: 'pass', evidence: 'Seen in the render.' };
  judged.gates = { style_fidelity: 'pass', narrative_continuity: 'pass' };
  judged.verdict = 'fixed';
  judged.findings.push({
    id: 'F02', panel: null, check: 'identity', expected: 'a', visible: 'b', severity: 'minor', repair: 'c',
    status: 'fixed', recheck: { render, evidence: 'Seen.' },
  });
  fs.writeFileSync(abs(root, reviewRel), yaml.stringify(judged));
  const open = (await validateWorkspace(root, {})).errors.filter((e) => e.file === reviewRel);
  assert.deepStrictEqual(open.map((e) => e.code), ['REVIEW_MUST_BE_FLAGGED']);
  assert.ok(/verdict is fixed with open change request\(s\) \[F01\]; expected flagged\./.test(open[0].message), open[0].message);
  // Withdrawn (accepted) or fixed, the request no longer holds the verdict.
  judged.findings[0].status = 'accepted';
  fs.writeFileSync(abs(root, reviewRel), yaml.stringify(judged));
  assert.deepStrictEqual(await errorCodes(root), []);

  // A region that reaches past the page is refused by the validator; a finding with neither check nor source by the schema.
  judged.findings[0].region = { x: 0.8, y: 0.1, w: 0.5, h: 0.2 };
  fs.writeFileSync(abs(root, reviewRel), yaml.stringify(judged));
  assert.ok((await errorCodes(root)).includes(`${reviewRel}: REVIEW_REGION_OUTSIDE_PAGE`));
  delete judged.findings[0].region;
  delete judged.findings[0].source;
  assert.strictEqual(validateDoc('visual-review', judged).valid, false, 'a reviewer finding still needs its check');
  judged.findings[0].source = 'reviewer';
  assert.strictEqual(validateDoc('visual-review', judged).valid, false);
  judged.findings[0].check = 'spatial_logic';
  assert.strictEqual(validateDoc('visual-review', judged).valid, true);
}

function testLineage() {
  // A render that came from a repair opens its review one cycle further on.
  const root = makeWorkspace();
  const pageDir = ws.pageDir(root, 'PG_001_002');
  fs.writeFileSync(path.join(pageDir, 'renders', 'PG_001_002_V03.png'), PNG);
  const dir = abs(root, 'generations/PG_001_002');
  fs.writeFileSync(path.join(dir, 'GEN_PG_001_002_03.yaml'),
    yaml.stringify({ id: 'GEN_PG_001_002_03', output_render: 'PG_001_002_V03', status: 'succeeded' }));
  fs.writeFileSync(path.join(dir, 'GEN_PG_001_002_03.request.json'), JSON.stringify({
    meta: { mode: 'repair', edit_target: 'issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V02.png' },
  }));
  const out = requests.addUserRequest({ root, render: 'PG_001_002_V03', text: 'Darker water.', now: NOW });
  const review = yaml.parse(fs.readFileSync(out.reviewFile, 'utf8'));
  assert.strictEqual(review.supersedes, 'PG_001_002_V02');
  assert.strictEqual(review.repair_cycle, readYaml(root, REVIEW_2).repair_cycle + 1);
}

function testArguments() {
  const root = makeWorkspace();
  const base = { root, render: 'PG_001_002_V02', text: 'Change it.' };
  const untouched = read(root, REVIEW_2);
  refuses(() => requests.addUserRequest(Object.assign({}, base, { root: undefined })), 'bad_arguments');
  refuses(() => requests.addUserRequest(Object.assign({}, base, { root: path.dirname(root) })), 'workspace_missing');
  refuses(() => requests.addUserRequest(Object.assign({}, base, { render: 'PG_001_002' })), 'bad_arguments', /page render .* or a cover render/);
  refuses(() => requests.addUserRequest(Object.assign({}, base, { page: 'PG_001_001' })), 'bad_arguments', /is a render of PG_001_002/);
  refuses(() => requests.addUserRequest(Object.assign({}, base, { text: '   ' })), 'bad_arguments', /text is required/);
  refuses(() => requests.addUserRequest(Object.assign({}, base, { panel: 'PN_001_001_01' })), 'bad_arguments', /not a panel of PG_001_002/);
  refuses(() => requests.addUserRequest(Object.assign({}, base, { check: 'mood' })), 'bad_arguments', /check must be one of/);
  refuses(() => requests.addUserRequest(Object.assign({}, base, { severity: 'fatal' })), 'bad_arguments');
  for (const region of [{ x: 0.1, y: 0.1, w: 0, h: 0.2 }, { x: 0.9, y: 0.1, w: 0.2, h: 0.2 }, { x: -0.1, y: 0, w: 0.5, h: 0.5 },
    { x: 0.1, y: 0.1, w: 0.2 }, { x: 10, y: 10, w: 50, h: 50 }, 'top left']) {
    refuses(() => requests.addUserRequest(Object.assign({}, base, { region })), 'bad_arguments', /region/);
  }
  assert.strictEqual(read(root, REVIEW_2), untouched, 'a refused request writes nothing');
  assert.deepStrictEqual(requests.normalizeRegion({ x: '0.25', y: 0, w: 0.33333333, h: 1 }), { x: 0.25, y: 0, w: 0.3333, h: 1 });
  assert.strictEqual(requests.normalizeRegion(undefined), null);

  // A person who approved the render and now asks for a change has withdrawn that approval.
  const review = readYaml(root, REVIEW_2);
  review.human_approval = { status: 'approved', by: 'the editor', at: '2026-11-26' };
  fs.writeFileSync(abs(root, REVIEW_2), `# kept\n${yaml.stringify(review)}`);
  requests.addUserRequest(base);
  const after = readYaml(root, REVIEW_2);
  assert.deepStrictEqual(after.human_approval, { status: 'pending', by: null, at: null });
  assert.ok(read(root, REVIEW_2).startsWith('# kept\n'));
}

async function testCover() {
  // The cover helpers come from another part of the scaffold. When they are
  // in place the same call serves a cover render.
  const coverRender = path.join(EXAMPLE, 'issues', 'ISS_001', 'cover', 'renders', 'CV_001_V01.png');
  if (typeof ws.coverOfRender !== 'function' || !fs.existsSync(coverRender)) return;
  const root = makeWorkspace();
  assert.deepStrictEqual(requests.ownerOfRender('CV_001_V01'), { kind: 'cover', id: 'CV_001' });
  refuses(() => requests.addUserRequest({ root, render: 'CV_001_V01', text: 'x', panel: 'PN_001_001_01' }),
    'bad_arguments', /a cover has no panels/);

  const out = requests.addUserRequest({
    root, page: 'CV_001', render: 'CV_001_V01', text: 'Make the title larger.', region: { x: 0.1, y: 0.05, w: 0.8, h: 0.2 }, now: NOW,
  });
  assert.strictEqual(out.reviewFile, ws.reviewFile(root, 'CV_001_V01'));
  const review = yaml.parse(fs.readFileSync(out.reviewFile, 'utf8'));
  assert.strictEqual(review.page, 'CV_001');
  assert.strictEqual(review.verdict, 'flagged');
  assert.strictEqual(out.finding.source, 'user_request');
  assert.strictEqual(out.finding.panel, null);
  assert.ok(validateDoc('visual-review', review).valid);
  assert.deepStrictEqual(selectFindings(review).map((f) => f.id), [out.finding.id]);
  const cover = ws.loadCover(root, 'CV_001');
  if (out.statusChange) {
    assert.deepStrictEqual([cover.status, cover.approved_render], ['draft', null], 'a flagged cover render is no longer the approved one');
  }

  // A cover render with no review yet: the checks a cover never has are not applicable, the rest not performed.
  fs.writeFileSync(path.join(path.dirname(coverRender).replace(EXAMPLE, root), 'CV_001_V02.png'), PNG);
  const opened = requests.addUserRequest({ root, render: 'CV_001_V02', text: 'Warmer light on the pilot.', now: NOW });
  assert.strictEqual(opened.created, true);
  const fresh = yaml.parse(fs.readFileSync(opened.reviewFile, 'utf8'));
  assert.ok(validateDoc('visual-review', fresh).valid);
  assert.strictEqual(fresh.checks.identity.result, 'not_performed');
  let coverLib = null;
  try {
    coverLib = require('../scripts/lib/cover');
  } catch (err) { /* cover helpers not installed */ }
  for (const key of (coverLib && coverLib.NOT_APPLICABLE_CHECKS) || []) {
    assert.strictEqual(fresh.checks[key].result, 'not_applicable', key);
  }
}

async function main() {
  try {
    await testRequestOnReviewedRender();
    testSelection();
    await testRequestOpensReview();
    testLineage();
    testArguments();
    await testCover();
  } finally {
    for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('review-requests: OK');
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
