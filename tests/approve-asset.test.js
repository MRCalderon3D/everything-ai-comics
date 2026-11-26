'use strict';
/**
 * approve-asset.js: promoting an approved candidate to a master. Runs on a
 * throwaway copy of the example workspace. Covered: the master name and
 * copy, the registry entry with its provenance, the entity file and outfit
 * references, the look freeze in project.yaml, supersession, every refusal,
 * comments that survive the edits, and the CLI.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('../scripts/lib/yaml');
const ws = require('../scripts/lib/workspace');
const { approveAsset, describeCandidate } = require('../scripts/approve-asset');
const { validateWorkspace } = require('../scripts/validate-workspace');

const ROOT = path.resolve(__dirname, '..');
const EXAMPLE = path.join(ROOT, 'examples', 'the-night-ferry');
const SCRIPT = path.join(ROOT, 'scripts', 'approve-asset.js');
const NOW = new Date('2026-11-26T09:00:00Z');
const temps = [];

/** A valid 1x1 PNG. */
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eac-approve-'));
  temps.push(dir);
  const root = path.join(dir, 'production');
  copyTree(EXAMPLE, root);
  return root;
}

const abs = (root, rel) => path.join(root, ...rel.split('/'));
const read = (root, rel) => fs.readFileSync(abs(root, rel), 'utf8');
const readYaml = (root, rel) => yaml.parse(read(root, rel));

function writeCandidate(root, rel, bytes = PNG) {
  fs.mkdirSync(path.dirname(abs(root, rel)), { recursive: true });
  fs.writeFileSync(abs(root, rel), bytes);
}

/** A schema-valid generation record for a sheet of an entity. */
function generationRecord(entity, tag, status, media) {
  return {
    id: `GEN_${entity}_01`,
    page: null,
    asset: entity,
    provider: 'codex-cli',
    model: 'unreported',
    kind: 'image',
    prompt_package: `PP_${entity}_CODEX-CLI-${tag}`,
    output_render: null,
    request: { summary: 'codex exec (generate, 1 input image(s))', endpoint: null, payload_hash: '0f3a9c1b2d4e5f60' },
    response: { summary: status === 'succeeded' ? 'Codex saved one image.' : 'No request sent (dry run).', provider_job_id: null, error: null },
    media_files: media,
    cost: { currency: 'USD', amount: null, estimated: false, reported: false },
    seed: null,
    metadata_unavailable: ['model', 'cost', 'seed'],
    status,
    created_at: '2026-11-26T08:00:00Z',
  };
}

function entryOf(root, id) {
  return readYaml(root, 'references/manifest.yaml').assets.find((a) => a.id === id);
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

async function testFirstMaster() {
  const root = makeWorkspace();
  const candidate = 'characters/CHAR_OSKAR/refs/CHAR_OSKAR_EXPR_V01.png';
  writeCandidate(root, candidate);
  // The generation record that produced the candidate.
  fs.mkdirSync(abs(root, 'generations/CHAR_OSKAR'), { recursive: true });
  fs.writeFileSync(abs(root, 'generations/CHAR_OSKAR/GEN_CHAR_OSKAR_01.yaml'),
    yaml.stringify(generationRecord('CHAR_OSKAR', 'EXPR', 'succeeded', [candidate])));
  const manifestBefore = read(root, 'references/manifest.yaml');
  const characterBefore = read(root, 'characters/CHAR_OSKAR/character.yaml');

  const result = approveAsset({ root, candidate: 'CHAR_OSKAR_EXPR_V01', note: 'Six expressions, all on model.', now: NOW });
  assert.strictEqual(result.asset_id, 'CHAR_OSKAR_EXPR_MASTER_V01');
  assert.strictEqual(result.file, 'characters/CHAR_OSKAR/refs/CHAR_OSKAR_EXPR_MASTER_V01.png');
  assert.strictEqual(result.entity, 'CHAR_OSKAR');
  assert.strictEqual(result.role, 'identity');
  assert.strictEqual(result.superseded, null);
  assert.strictEqual(result.kind, 'expressions');
  assert.strictEqual(result.candidate, candidate);
  assert.strictEqual(result.generation_record, 'GEN_CHAR_OSKAR_01');
  assert.strictEqual(result.style_block, null);
  assert.deepStrictEqual(result.stale, []);
  assert.deepStrictEqual(result.warnings, []);
  assert.deepStrictEqual(result.updated,
    [result.file, 'references/manifest.yaml', 'characters/CHAR_OSKAR/character.yaml']);

  // The copy: same bytes, the candidate kept.
  assert.ok(fs.existsSync(abs(root, candidate)), 'the candidate stays on disk');
  assert.ok(fs.readFileSync(abs(root, result.file)).equals(PNG));
  assert.strictEqual(result.sha256, crypto.createHash('sha256').update(PNG).digest('hex'));

  // The registry entry.
  assert.deepStrictEqual(entryOf(root, result.asset_id), {
    id: 'CHAR_OSKAR_EXPR_MASTER_V01',
    entity: 'CHAR_OSKAR',
    kind: 'expressions',
    path: result.file,
    status: 'approved',
    default_role: 'identity',
    sha256: result.sha256,
    approved_by: 'human',
    approved_at: '2026-11-26',
    promoted_from: 'CHAR_OSKAR_EXPR_V01',
    generation_record: 'GEN_CHAR_OSKAR_01',
    notes: 'Six expressions, all on model.',
  });
  const manifestAfter = read(root, 'references/manifest.yaml');
  assert.ok(manifestAfter.startsWith(manifestBefore.replace(/\n+$/, '\n')),
    'the registry keeps its text and comments; the entry is appended');
  assert.ok(manifestAfter.includes('# The four images are flat placeholders'));

  // The entity file lists the master and keeps everything else.
  const character = readYaml(root, 'characters/CHAR_OSKAR/character.yaml');
  assert.deepStrictEqual(character.references, ['CHAR_OSKAR_TURN_MASTER_V01', 'CHAR_OSKAR_EXPR_MASTER_V01']);
  const characterAfter = read(root, 'characters/CHAR_OSKAR/character.yaml');
  assert.strictEqual(characterAfter.split('\n').length, characterBefore.split('\n').length + 1,
    'one line is added to character.yaml and nothing else moves');
  for (const line of characterBefore.split('\n').filter((l) => l.trim().startsWith('#'))) {
    assert.ok(characterAfter.includes(line), `comment lost: ${line}`);
  }

  const check = await validateWorkspace(root, {});
  assert.deepStrictEqual(check.errors.map((e) => `${e.file}: ${e.code}`), [], 'the workspace still passes its gates');

  // The same candidate twice, a master name, a file that is not a candidate.
  refuses(() => approveAsset({ root, candidate: 'CHAR_OSKAR_EXPR_V01' }), 'already_master', /already registered \(status approved\)/);
  refuses(() => approveAsset({ root, candidate: 'CHAR_OSKAR_TURN_MASTER_V01' }), 'candidate_invalid', /already carries _MASTER/);
  refuses(() => approveAsset({ root, candidate: 'CHAR_OSKAR_EXPR_V07' }), 'candidate_missing', /no image named CHAR_OSKAR_EXPR_V07/);
  refuses(() => approveAsset({ root, candidate: 'issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.png' }),
    'candidate_invalid', /not a candidate name/);
  refuses(() => approveAsset({ root, candidate: '' }), 'bad_arguments');
  refuses(() => approveAsset({ root: path.dirname(root), candidate: 'CHAR_OSKAR_EXPR_V01' }), 'workspace_missing');
  refuses(() => approveAsset({ candidate: 'CHAR_OSKAR_EXPR_V01' }), 'bad_arguments');
  writeCandidate(root, 'characters/CHAR_OSKAR/refs/CHAR_OSKAR_POSTER_V01.png');
  refuses(() => approveAsset({ root, candidate: 'CHAR_OSKAR_POSTER_V01' }), 'candidate_invalid', /names no sheet of a CHAR entity/);
  writeCandidate(root, 'characters/CHAR_OSKAR/refs/CHAR_MARA_EXPR_V01.png');
  refuses(() => approveAsset({ root, candidate: 'characters/CHAR_OSKAR/refs/CHAR_MARA_EXPR_V01.png' }),
    'candidate_invalid', /does not belong to CHAR_OSKAR/);
  // A master file on disk that the registry does not know is never overwritten.
  writeCandidate(root, 'characters/CHAR_OSKAR/refs/CHAR_OSKAR_DETAIL_CUT_HAND_V01.png');
  writeCandidate(root, 'characters/CHAR_OSKAR/refs/CHAR_OSKAR_DETAIL_CUT_HAND_MASTER_V01.jpg');
  refuses(() => approveAsset({ root, candidate: 'CHAR_OSKAR_DETAIL_CUT_HAND_V01' }), 'master_file_exists', /never overwritten/);
}

async function testSupersede() {
  const root = makeWorkspace();
  const candidate = 'characters/CHAR_MARA/refs/CHAR_MARA_TURN_V02.png';
  const other = Buffer.concat([PNG, Buffer.from('v2')]);
  writeCandidate(root, candidate, other);
  const before = {
    manifest: read(root, 'references/manifest.yaml'),
    character: read(root, 'characters/CHAR_MARA/character.yaml'),
  };

  // The sheet already has an approved master: refused, and nothing is written.
  refuses(() => approveAsset({ root, candidate }), 'master_exists',
    /CHAR_MARA_TURN_MASTER_V01 is the approved master of this sheet.*--supersede/);
  assert.strictEqual(read(root, 'references/manifest.yaml'), before.manifest);
  assert.strictEqual(read(root, 'characters/CHAR_MARA/character.yaml'), before.character);
  assert.ok(!fs.existsSync(abs(root, 'characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V02.png')));

  const result = approveAsset({ root, candidate, supersede: true, by: 'the editor', now: NOW });
  assert.strictEqual(result.asset_id, 'CHAR_MARA_TURN_MASTER_V02', 'the master keeps the candidate\'s version');
  assert.strictEqual(result.superseded, 'CHAR_MARA_TURN_MASTER_V01');
  assert.strictEqual(result.role, 'identity');
  assert.strictEqual(result.generation_record, null);
  assert.ok(result.warnings.some((w) => /no generation record/.test(w)));
  assert.strictEqual(result.approved_by, 'the editor');

  // The old master: file kept under its own name, entry superseded.
  assert.ok(fs.readFileSync(abs(root, 'characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png')).length > 0);
  assert.ok(fs.readFileSync(abs(root, result.file)).equals(other));
  const old = entryOf(root, 'CHAR_MARA_TURN_MASTER_V01');
  assert.strictEqual(old.status, 'superseded');
  assert.strictEqual(old.superseded_by, 'CHAR_MARA_TURN_MASTER_V02');
  assert.strictEqual(old.approved_by, 'example', 'the old approval record stays');
  assert.strictEqual(entryOf(root, result.asset_id).status, 'approved');
  assert.strictEqual(entryOf(root, result.asset_id).approved_by, 'the editor');
  assert.ok(read(root, 'references/manifest.yaml').includes('# The four images are flat placeholders'),
    'registry comments survive a supersession');

  // Entity file and outfit move to the new master.
  assert.deepStrictEqual(readYaml(root, 'characters/CHAR_MARA/character.yaml').references, ['CHAR_MARA_TURN_MASTER_V02']);
  assert.deepStrictEqual(readYaml(root, 'characters/CHAR_MARA/wardrobe.yaml').outfits[0].references, ['CHAR_MARA_TURN_MASTER_V02']);
  assert.ok(read(root, 'characters/CHAR_MARA/wardrobe.yaml').startsWith('# Schema: schemas/wardrobe.schema.json'));
  assert.ok(result.updated.includes('characters/CHAR_MARA/wardrobe.yaml'));

  // Pages and plans that still cite the old master are reported as stale.
  assert.ok(result.stale.includes('issues/ISS_001/pages/PG_001_001/page.yaml'), result.stale.join(', '));
  assert.ok(result.stale.includes('issues/ISS_001/pages/PG_001_001/reference-plan.yaml'));
  assert.ok(result.stale.every((rel) => /^issues\//.test(rel)));
}

async function testLook() {
  const root = makeWorkspace();
  const projectBefore = read(root, 'project.yaml');

  // A new version of the existing look, given as a path.
  writeCandidate(root, 'references/style/LOOK_NOIR_INK_V02.png');
  refuses(() => approveAsset({ root, candidate: 'references/style/LOOK_NOIR_INK_V02.png' }), 'master_exists');
  const result = approveAsset({ root, candidate: abs(root, 'references/style/LOOK_NOIR_INK_V02.png'), supersede: true, now: NOW });
  assert.strictEqual(result.asset_id, 'LOOK_NOIR_INK_MASTER_V02');
  assert.strictEqual(result.entity, 'LOOK_NOIR_INK');
  assert.strictEqual(result.kind, 'look');
  assert.strictEqual(result.role, 'style');
  assert.strictEqual(result.superseded, 'LOOK_NOIR_INK_MASTER_V01');
  assert.strictEqual(result.style_block, 'style/style-block.txt', 'approving a look freezes the style block');
  const project = readYaml(root, 'project.yaml');
  assert.deepStrictEqual(project.style.look_refs, ['LOOK_NOIR_INK_MASTER_V02']);
  assert.strictEqual(project.style.style_block, 'style/style-block.txt');
  const projectAfter = read(root, 'project.yaml');
  assert.strictEqual(projectAfter, projectBefore.replace('LOOK_NOIR_INK_MASTER_V01', 'LOOK_NOIR_INK_MASTER_V02'),
    'only the look reference changes in project.yaml');
  assert.ok(result.updated.includes('project.yaml'));

  // A second look with no master yet: added next to the first. A detail of a look keeps its entity.
  writeCandidate(root, 'references/style/LOOK_DAWN_WASH_V01.png');
  const second = approveAsset({ root, candidate: 'LOOK_DAWN_WASH_V01', now: NOW });
  assert.strictEqual(second.entity, 'LOOK_DAWN_WASH');
  assert.strictEqual(second.superseded, null);
  assert.deepStrictEqual(readYaml(root, 'project.yaml').style.look_refs,
    ['LOOK_NOIR_INK_MASTER_V02', 'LOOK_DAWN_WASH_MASTER_V01']);
  writeCandidate(root, 'references/style/LOOK_NOIR_INK_DETAIL_HATCHING_V03.png');
  const detail = describeCandidate(root, 'LOOK_NOIR_INK_DETAIL_HATCHING_V03', ws.loadReferenceAssets(root));
  assert.deepStrictEqual([detail.entity, detail.kind, detail.variant], ['LOOK_NOIR_INK', 'detail', 'HATCHING']);

  // No style block, nothing to freeze: refused before anything is written.
  const bare = makeWorkspace();
  fs.rmSync(abs(bare, 'style/style-block.txt'));
  writeCandidate(bare, 'references/style/LOOK_NOIR_INK_V02.png');
  refuses(() => approveAsset({ root: bare, candidate: 'LOOK_NOIR_INK_V02', supersede: true }), 'style_block_missing', /freezes the style block/);
  assert.ok(!fs.existsSync(abs(bare, 'references/style/LOOK_NOIR_INK_MASTER_V02.png')));

  // A project whose look_refs is still the empty template list.
  const fresh = makeWorkspace();
  fs.writeFileSync(abs(fresh, 'project.yaml'),
    read(fresh, 'project.yaml').replace('look_refs: [LOOK_NOIR_INK_MASTER_V01]', 'look_refs: []                        # approved LOOK_* masters'));
  fs.writeFileSync(abs(fresh, 'references/manifest.yaml'),
    fs.readFileSync(path.join(ROOT, 'templates', 'references', 'manifest.yaml'), 'utf8'));
  fs.rmSync(abs(fresh, 'references/style/LOOK_NOIR_INK_MASTER_V01.png'));
  writeCandidate(fresh, 'references/style/LOOK_NOIR_INK_V01.png');
  const first = approveAsset({ root: fresh, candidate: 'LOOK_NOIR_INK_V01', now: NOW });
  assert.strictEqual(first.asset_id, 'LOOK_NOIR_INK_MASTER_V01');
  assert.ok(/look_refs: \[LOOK_NOIR_INK_MASTER_V01\]\s+# approved LOOK_\* masters/.test(read(fresh, 'project.yaml')),
    'the flow list is filled in place and its comment stays');
  const registry = read(fresh, 'references/manifest.yaml');
  assert.ok(/^assets:\n  - id: LOOK_NOIR_INK_MASTER_V01\n    entity: LOOK_NOIR_INK\n/m.test(registry), registry);
  assert.ok(registry.includes('# No schema. Scripts read the fields below.') && registry.includes('#  - id: CHAR_EXAMPLE_TURN_MASTER_V01'),
    'the template comments of an empty registry survive the first entry');
  assert.strictEqual(yaml.parse(registry).assets.length, 1);
}

async function testOtherSheets() {
  const root = makeWorkspace();

  // A wardrobe sheet goes to the character and to the outfit it draws.
  writeCandidate(root, 'characters/CHAR_MARA/refs/CHAR_MARA_WARD_OILSKIN_V01.png');
  const wardrobe = approveAsset({ root, candidate: 'CHAR_MARA_WARD_OILSKIN_V01', now: NOW });
  assert.strictEqual(wardrobe.asset_id, 'CHAR_MARA_WARD_OILSKIN_MASTER_V01');
  assert.strictEqual(wardrobe.kind, 'wardrobe');
  assert.strictEqual(wardrobe.role, 'wardrobe');
  assert.deepStrictEqual(readYaml(root, 'characters/CHAR_MARA/character.yaml').references,
    ['CHAR_MARA_TURN_MASTER_V01', 'CHAR_MARA_WARD_OILSKIN_MASTER_V01']);
  assert.deepStrictEqual(readYaml(root, 'characters/CHAR_MARA/wardrobe.yaml').outfits[0].references,
    ['CHAR_MARA_TURN_MASTER_V01', 'CHAR_MARA_WARD_OILSKIN_MASTER_V01']);
  assert.ok(/references: \[CHAR_MARA_TURN_MASTER_V01, CHAR_MARA_WARD_OILSKIN_MASTER_V01\]/.test(read(root, 'characters/CHAR_MARA/wardrobe.yaml')));

  // A plate for another time of day is its own sheet: no clash with the default plate.
  writeCandidate(root, 'locations/LOC_FERRY_DECK/refs/LOC_FERRY_DECK_PLATE_DUSK_V01.png');
  const plate = approveAsset({ root, candidate: 'LOC_FERRY_DECK_PLATE_DUSK_V01', now: NOW });
  assert.strictEqual(plate.asset_id, 'LOC_FERRY_DECK_PLATE_DUSK_MASTER_V01');
  assert.strictEqual(plate.role, 'spatial_continuity');
  assert.strictEqual(plate.superseded, null);
  assert.strictEqual(entryOf(root, 'LOC_FERRY_DECK_PLATE_MASTER_V01').status, 'approved');

  // A prop sheet, recorded by a handoff: the request file names the candidate as its target.
  const sheet = 'props/PROP_FLARE_GUN/refs/PROP_FLARE_GUN_SHEET_V01.png';
  writeCandidate(root, sheet);
  fs.mkdirSync(abs(root, 'generations/PROP_FLARE_GUN'), { recursive: true });
  fs.writeFileSync(abs(root, 'generations/PROP_FLARE_GUN/GEN_PROP_FLARE_GUN_01.yaml'),
    yaml.stringify(generationRecord('PROP_FLARE_GUN', 'SHEET', 'dry_run', [])));
  fs.writeFileSync(abs(root, 'generations/PROP_FLARE_GUN/GEN_PROP_FLARE_GUN_01.request.json'),
    JSON.stringify({ meta: { output_path: sheet } }));
  const prop = approveAsset({ root, candidate: sheet, now: NOW });
  assert.strictEqual(prop.asset_id, 'PROP_FLARE_GUN_SHEET_MASTER_V01');
  assert.strictEqual(prop.kind, 'prop');
  assert.strictEqual(prop.role, 'prop_consistency');
  assert.strictEqual(prop.generation_record, 'GEN_PROP_FLARE_GUN_01');
  assert.deepStrictEqual(readYaml(root, 'props/PROP_FLARE_GUN/prop.yaml').references, ['PROP_FLARE_GUN_SHEET_MASTER_V01']);

  const check = await validateWorkspace(root, {});
  assert.deepStrictEqual(check.errors.map((e) => `${e.file}: ${e.code}`), []);
}

function testCli() {
  const root = makeWorkspace();
  writeCandidate(root, 'characters/CHAR_OSKAR/refs/CHAR_OSKAR_EXPR_V01.png');
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  const help = run('--help');
  assert.strictEqual(help.status, 0);
  assert.ok(/--candidate <x>/.test(help.stdout) && /--supersede/.test(help.stdout));

  const missing = run('--root', root, '--json');
  assert.strictEqual(missing.status, 1);
  assert.strictEqual(JSON.parse(missing.stdout).code, 'bad_arguments');

  const ok = run('--candidate', 'CHAR_OSKAR_EXPR_V01', '--root', root, '--note', 'Approved in review.', '--json');
  assert.strictEqual(ok.status, 0, ok.stderr || ok.stdout);
  const result = JSON.parse(ok.stdout);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.asset_id, 'CHAR_OSKAR_EXPR_MASTER_V01');
  assert.strictEqual(entryOf(root, result.asset_id).notes, 'Approved in review.');

  const again = run('--candidate', 'CHAR_OSKAR_EXPR_V01', '--root', root);
  assert.strictEqual(again.status, 1);
  assert.ok(/^error: CHAR_OSKAR_EXPR_MASTER_V01 is already registered/.test(again.stderr), again.stderr);

  // Human output; the workspace is found from an absolute candidate path.
  writeCandidate(root, 'characters/CHAR_MARA/refs/CHAR_MARA_TURN_V02.png');
  const text = run('--candidate', abs(root, 'characters/CHAR_MARA/refs/CHAR_MARA_TURN_V02.png'), '--supersede');
  assert.strictEqual(text.status, 0, text.stderr);
  assert.ok(/^approved: CHAR_MARA_TURN_MASTER_V02 \(turnaround, role identity\) for CHAR_MARA$/m.test(text.stdout), text.stdout);
  assert.ok(/supersedes: CHAR_MARA_TURN_MASTER_V01/.test(text.stdout));
  assert.ok(/Nothing here checked the drawing\./.test(text.stdout));
}

async function main() {
  try {
    await testFirstMaster();
    await testSupersede();
    await testLook();
    await testOtherSheets();
    testCli();
  } finally {
    for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('approve-asset: OK');
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
