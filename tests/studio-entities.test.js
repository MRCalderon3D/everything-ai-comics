'use strict';
/**
 * What a page plan added, possible duplicates, merge and rename (TODO
 * item 11), in fake mode.
 *
 * Found in a real run: a story proposal named an attacker
 * CHAR_GREY_HAIRED_MAN while a page plan wrote his file as CHAR_ORANGE_GREY.
 *
 * 1. The word match: the real pair is flagged, two different people who
 *    share a word of their IDs are not, a name merely mentioned in another
 *    description is not.
 * 2. The prompts of steps that may create an entity list the IDs that exist,
 *    proposals included.
 * 3. A plan whose text names someone with no file (NEWCHAR) adds his file;
 *    the job lists it, flags the proposal's ID as a possible duplicate, and
 *    the issue screen shows it with "needs a sheet".
 * 4. Merging into an ID that has no file yet renames the file to that ID:
 *    pages, wardrobe and directory follow, and the checks stay clean.
 * 5. Rename: files and references follow, the page plans stay approved.
 * 6. Merge of two characters with files: one row per panel, the outfit of
 *    the merged one becomes the default outfit of the one kept, its name an
 *    alias, its directory gone; the checks add no error.
 * 7. Refusals: unknown IDs, a rename onto an existing ID, a merge while a
 *    job runs.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { start } = require('../studio/test-support/harness');
const entities = require('../studio/server/entities');
const prompts = require('../studio/server/prompts');
const ws = require('../scripts/lib/workspace');

function done(job, label) {
  assert.strictEqual(job.status, 'done', `${label}: ${job.status} ${JSON.stringify(job.error)}`);
  return job;
}

function unitChecks() {
  const grey = {
    id: 'CHAR_ORANGE_GREY', kind: 'character', names: ['Grey-haired man in the orange jumpsuit', 'the man in orange'],
    text: 'Grey-haired man in the orange jumpsuit. An older man in an orange jumpsuit, grey hair combed back, no beard, white eyes.',
  };
  const beard = {
    id: 'CHAR_ORANGE_BEARD', kind: 'character', names: ['Bearded man in the orange jumpsuit', 'the second one'],
    text: 'Bearded man in the orange jumpsuit. A broad man in an orange jumpsuit with a short dark beard.',
  };
  const proposalGrey = { id: 'CHAR_GREY_HAIRED_MAN', kind: 'character', names: [], text: 'A man in an orange jumpsuit, no beard, grey hair and white eyes. He attacks first.' };
  const proposalBeard = { id: 'CHAR_BEARDED_MAN', kind: 'character', names: [], text: 'A man in an orange jumpsuit with a short dark beard. He joins the attack.' };
  const pilot = { id: 'CHAR_IRIS', kind: 'character', names: ['Iris'], text: 'Iris, a pilot in her forties. Younger than Teo.' };
  const teo = { id: 'CHAR_TEO', kind: 'character', names: ['Teo'], text: 'Teo, a mechanic with a grey beard.' };
  assert.strictEqual(entities.similarity(grey, proposalGrey).flagged, true, 'the real pair');
  assert.strictEqual(entities.similarity(beard, proposalBeard).flagged, true, 'the other real pair');
  assert.strictEqual(entities.similarity(grey, proposalBeard).flagged, false, 'two attackers are two people');
  assert.strictEqual(entities.similarity(grey, beard).flagged, false, 'one shared word of two IDs is not enough');
  assert.strictEqual(entities.similarity(pilot, teo).flagged, false, 'a name mentioned in another description is not a duplicate');
  assert.strictEqual(entities.similarity({ id: 'CHAR_MARTA', kind: 'character', names: ['Marta'], text: 'Marta' },
    { id: 'CHAR_MARTA_LOPEZ', kind: 'character', names: ['Marta Lopez'], text: 'Marta Lopez, a painter.' }).flagged, true, 'one ID inside the other');
  const dups = entities.duplicatesOf(grey, [proposalGrey, proposalBeard, beard, pilot]);
  assert.deepStrictEqual(dups.map((d) => d.id), ['CHAR_GREY_HAIRED_MAN']);
}

async function main() {
  const started = Date.now();
  unitChecks();
  const s = await start();
  try {
    const id = await s.seedProject('Entity Doubles');
    const P = `/api/projects/${id}`;
    const root = path.join(s.home, id, 'production');
    const project = s.app.services.registry.get(id);

    // --- 2. a proposal names the man; the prompts list every known ID -----------------------------
    const suggest = done(await s.runOp(id, 'story.suggest', { instruction: 'NEWCHAR add the man who attacks first' }), 'story.suggest');
    assert.ok(suggest.result.proposal, 'a proposal was stored');
    const known = entities.knownText(project);
    assert.ok(/CHAR_MARA \(Mara\) \[file\]/.test(known), known);
    assert.ok(/CHAR_GREY_HAIRED_MAN \[open proposal prop_[a-z0-9_]+, no file yet\]: A man in an orange jumpsuit/.test(known), known);
    const prompt = prompts.build('pages.breakdown', { issue: 'ISS_001', text: 'x', pages: 1 }, { workspace: root, knownEntities: known });
    assert.ok(prompt.includes('IDS THAT ALREADY EXIST') && prompt.includes('CHAR_GREY_HAIRED_MAN'), 'the breakdown prompt lists them');
    assert.ok(!prompts.build('review', {}, { workspace: root }).includes('IDS THAT ALREADY EXIST'), 'a prompt without the list has no empty block');
    assert.ok(require('../studio/server/ai').ENTITY_KINDS.includes('pages.breakdown'));

    // --- 3. the plan adds his file under another ID -----------------------------------------------
    const plan = done(await s.runOp(id, 'pages.plan', { text: 'NEWCHAR A grey-haired man in an orange jumpsuit attacks Mara.', pages: 2 }), 'pages.plan');
    assert.ok(Array.isArray(plan.added_entities), 'the job lists what it added');
    const added = plan.added_entities.find((e) => e.id === 'CHAR_ORANGE_GREY');
    assert.ok(added, JSON.stringify(plan.added_entities));
    assert.strictEqual(added.kind, 'character');
    assert.strictEqual(added.step, 'breakdown');
    assert.deepStrictEqual(added.duplicates.map((d) => [d.id, d.source]), [['CHAR_GREY_HAIRED_MAN', 'proposal']]);
    assert.ok(plan.added_entities.some((e) => e.id === 'LOC_MAIN_ROOM' && e.kind === 'location'), 'a place counts too');
    const log = (await s.api('GET', `${P}/jobs/${plan.id}/log`)).body.lines.join('\n');
    assert.ok(/CHAR_ORANGE_GREY may be the same as CHAR_GREY_HAIRED_MAN/.test(log), 'the log says so');
    let issue = (await s.api('GET', `${P}/issues/ISS_001`)).body;
    assert.ok(issue.added, 'the issue screen lists what the last plan added');
    const shown = issue.added.entities.find((e) => e.id === 'CHAR_ORANGE_GREY');
    assert.deepStrictEqual([shown.exists, shown.needs_sheet, shown.duplicates[0].id], [true, true, 'CHAR_GREY_HAIRED_MAN']);
    assert.ok(ws.listPages(root, 'ISS_001').some((p) => JSON.stringify(p.doc).includes('CHAR_ORANGE_GREY')), 'the pages use him');

    // --- 4. merge into the ID that has no file: a rename -------------------------------------------
    let r = await s.api('POST', `${P}/entities/merge`, { from: 'CHAR_ORANGE_GREY', into: 'CHAR_GREY_HAIRED_MAN' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.renamed, r.body.check.ok], [true, true], JSON.stringify(r.body.check));
    assert.ok(fs.existsSync(path.join(root, 'characters', 'CHAR_GREY_HAIRED_MAN', 'character.yaml')));
    assert.ok(!fs.existsSync(path.join(root, 'characters', 'CHAR_ORANGE_GREY')));
    assert.ok(ws.listPages(root, 'ISS_001').every((p) => !JSON.stringify(p.doc).includes('CHAR_ORANGE_GREY')), 'no page names the old ID');
    assert.strictEqual(ws.loadCharacter(root, 'CHAR_GREY_HAIRED_MAN').id, 'CHAR_GREY_HAIRED_MAN');
    assert.ok(r.body.commit, 'one commit');
    issue = (await s.api('GET', `${P}/issues/ISS_001`)).body;
    const gone = issue.added.entities.find((e) => e.id === 'CHAR_ORANGE_GREY');
    assert.strictEqual(gone.exists, false, 'the list says the added file is no longer there under that ID');

    // --- 5. rename, with the page plans approved -----------------------------------------------------
    const pageIds = ws.listPageIds(root, 'ISS_001');
    r = await s.api('POST', `${P}/approve/plan`, { pages: pageIds });
    assert.strictEqual(r.status, 200);
    r = await s.api('POST', `${P}/entities/rename`, { from: 'CHAR_GREY_HAIRED_MAN', to: 'CHAR_STRANGER' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.check.ok, true, JSON.stringify(r.body.check));
    assert.ok(r.body.moved.some(([from, to]) => from === 'characters/CHAR_GREY_HAIRED_MAN' && to === 'characters/CHAR_STRANGER'));
    const bible = ws.loadYaml(path.join(root, 'story', 'story-bible.yaml'));
    assert.ok(!JSON.stringify(bible).includes('CHAR_GREY_HAIRED_MAN'));
    const proposal = JSON.parse(fs.readFileSync(path.join(s.home, id, '.studio', 'proposals', `${suggest.result.proposal}.json`), 'utf8'));
    assert.ok(JSON.stringify(proposal.parts).includes('CHAR_STRANGER'), 'the open proposal follows the rename');
    issue = (await s.api('GET', `${P}/issues/ISS_001`)).body;
    assert.ok(issue.pages.every((p) => p.plan_approved), 'a rename leaves the approved plans approved');

    // --- 6. merge two characters that both have files ------------------------------------------------
    const before = ws.loadPage(root, pageIds[0]).panels[0].cast.map((row) => row.character);
    assert.ok(before.includes('CHAR_MARA') && before.includes('CHAR_STRANGER'), JSON.stringify(before));
    r = await s.api('POST', `${P}/entities/merge`, { from: 'CHAR_STRANGER', into: 'CHAR_MARA' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.renamed, false);
    assert.strictEqual(r.body.check.ok, true, JSON.stringify(r.body.check));
    assert.ok(!fs.existsSync(path.join(root, 'characters', 'CHAR_STRANGER')), 'its directory is gone');
    const mara = ws.loadCharacter(root, 'CHAR_MARA');
    assert.ok(mara.aliases.includes('Grey-haired man in the orange jumpsuit'), 'its name is an alias now');
    assert.ok(mara.references.length, 'the one kept keeps its sheets');
    for (const p of ws.listPages(root, 'ISS_001')) {
      for (const panel of p.doc.panels) {
        const ids = panel.cast.map((row) => row.character);
        assert.strictEqual(new Set(ids).size, ids.length, `one row per character in ${panel.id}`);
        for (const row of panel.cast) assert.notStrictEqual(row.wardrobe, 'WARD_ORANGE_GREY_JUMPSUIT', 'the outfit follows');
      }
    }
    const scene = ws.listScenes(root, 'ISS_001')[0].doc;
    assert.strictEqual(new Set(scene.cast).size, scene.cast.length);

    // --- 7. refusals -------------------------------------------------------------------------------------
    r = await s.api('POST', `${P}/entities/merge`, { from: 'CHAR_NOBODY', into: 'CHAR_MARA' });
    assert.deepStrictEqual([r.status, r.body.error.code], [404, 'id_not_found']);
    r = await s.api('POST', `${P}/entities/rename`, { from: 'CHAR_MARA', to: 'LOC_MARA' });
    assert.deepStrictEqual([r.status, r.body.error.code], [400, 'bad_params']);
    done(await s.runOp(id, 'character.create', { name: 'Teo', description: 'A mechanic.', draw: false }), 'character.create');
    r = await s.api('POST', `${P}/entities/rename`, { from: 'CHAR_TEO', to: 'CHAR_MARA' });
    assert.deepStrictEqual([r.status, r.body.error.code], [409, 'entity_exists']);
    process.env.STUDIO_FAKE_SLOW_MS = '800';
    const slow = await s.api('POST', `${P}/ops`, { op: 'story.suggest', params: { instruction: 'SLOW something' } });
    await new Promise((res) => setTimeout(res, 150));
    r = await s.api('POST', `${P}/entities/rename`, { from: 'CHAR_TEO', to: 'CHAR_TEODORO' });
    assert.deepStrictEqual([r.status, r.body.error.code], [409, 'project_busy']);
    await s.waitJob(id, slow.body.job.id);
    delete process.env.STUDIO_FAKE_SLOW_MS;

    // The chat offers them as actions: decisions, so never run by themselves.
    const catalog = (await s.api('GET', '/api/actions')).body.actions;
    for (const name of ['entity.merge', 'entity.rename', 'delete']) {
      const entry = catalog.find((a) => a.name === name);
      assert.ok(entry && entry.decision === true, name);
    }
  } finally {
    await s.close();
  }
  console.log(`studio-entities: ok (${Date.now() - started} ms)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
