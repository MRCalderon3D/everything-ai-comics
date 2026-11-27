'use strict';
/**
 * Deleting what the person does not want to keep (TODO item 13), in fake
 * mode.
 *
 * 1. A sheet candidate: the image, its generation record and its request go
 *    in one commit, the checks stay clean, and History brings it back.
 * 2. Refusals, each with its reason: the try a master was approved from, an
 *    approved master and the look that pages were drawn from, a render the
 *    next page uses as its previous page, a page that is not the last, a
 *    character pages still use, a published edition.
 * 3. An approved master with nothing drawn from it asks twice and says what
 *    depends on it; with the second confirmation it goes, with the try it
 *    was approved from, and the character file no longer lists it.
 * 4. Page versions: an old version goes with its review and record; the
 *    current one goes and the page falls back; then the last page goes and
 *    the issue, the scene and the page before it are put right.
 * 5. A whole character nobody uses, an upload (which says it cannot be
 *    undone), and several items at once in one commit.
 * 6. Clean up: a screen's unused tries are listed and deleted together.
 * 7. The chat offers a delete as a card that always waits for a click, even
 *    when the setting runs text-only cards and even when the message asks
 *    for it in so many words.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { start } = require('../studio/test-support/harness');
const ws = require('../scripts/lib/workspace');
const git = require('../studio/server/git');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64');

function done(job, label) {
  assert.strictEqual(job.status, 'done', `${label}: ${job.status} ${JSON.stringify(job.error)}`);
  return job;
}

async function main() {
  const started = Date.now();
  const s = await start();
  try {
    const id = await s.seedProject('Delete Things');
    const P = `/api/projects/${id}`;
    const root = path.join(s.home, id, 'production');
    const del = (items, extra = {}) => s.api('POST', `${P}/delete`, Object.assign({ items }, extra));
    const checkOf = async (items) => (await s.api('POST', `${P}/delete/check`, { items })).body.items;

    // --- 1. a sheet candidate --------------------------------------------------------------------
    const sheet = done(await s.runOp(id, 'character.sheet', { character: 'CHAR_MARA', sheet: 'turnaround' }), 'second turnaround');
    const cand = sheet.result.sheet.candidate_id;
    assert.strictEqual(cand, 'CHAR_MARA_TURN_V02');
    const candFile = path.join(root, 'characters', 'CHAR_MARA', 'refs', `${cand}.png`);
    assert.ok(fs.existsSync(candFile));
    const records = () => fs.readdirSync(path.join(root, 'generations', 'CHAR_MARA')).join(' ');
    assert.ok(/GEN_CHAR_MARA_02\.yaml/.test(records()), records());
    let [plan] = await checkOf([{ id: cand }]);
    assert.deepStrictEqual([plan.kind, plan.deletable, plan.confirm_twice, plan.undo], ['asset', true, false, 'history']);
    assert.ok(plan.files.some((f) => /GEN_CHAR_MARA_02\.yaml$/.test(f)) && plan.files.some((f) => /GEN_CHAR_MARA_02\.request\.json$/.test(f)), JSON.stringify(plan.files));
    let r = await del([{ id: cand }]);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.commit && r.body.can_undo);
    assert.strictEqual(r.body.check.ok, true, JSON.stringify(r.body.check));
    assert.ok(!fs.existsSync(candFile), 'the image is gone');
    assert.ok(!/GEN_CHAR_MARA_02/.test(records()), 'its generation record is gone');
    const files = (await git.filesOf(path.join(s.home, id), r.body.commit)).map((f) => f.path);
    assert.ok(files.every((f) => f.startsWith('production/characters/CHAR_MARA/') || f.startsWith('production/generations/CHAR_MARA/')), JSON.stringify(files));
    // History brings it back.
    const hist = (await s.api('GET', `${P}/history?limit=5`)).body.entries;
    assert.strictEqual(hist[0].kind, 'delete');
    const restore = await s.api('POST', `${P}/history/restore`, { entry: hist[1].id });
    assert.strictEqual(restore.status, 200, JSON.stringify(restore.body));
    assert.ok(fs.existsSync(candFile), 'restored from History');
    r = await del([{ kind: 'asset', id: cand }]);
    assert.strictEqual(r.status, 200);

    // --- 2. refusals --------------------------------------------------------------------------------
    [plan] = await checkOf([{ id: 'CHAR_MARA_TURN_V01' }]);
    assert.deepStrictEqual([plan.deletable, plan.refused.code], [false, 'promoted']);
    assert.ok(/CHAR_MARA_TURN_MASTER_V01/.test(plan.refused.message), plan.refused.message);
    r = await del([{ id: 'CHAR_MARA_TURN_V01' }]);
    assert.deepStrictEqual([r.status, r.body.error.code], [409, 'delete_refused']);
    assert.ok(/approved/.test(r.body.error.message), r.body.error.message);

    // Pages drawn from Mara and the look.
    done(await s.runOp(id, 'pages.plan', { text: 'Mara opens the box. Then she closes it.', pages: 2 }), 'pages.plan');
    const pages = ws.listPageIds(root, 'ISS_001');
    done(await s.runOp(id, 'pages.generate', { pages, approve_plans: true }, 60000), 'pages.generate');
    [plan] = await checkOf([{ id: 'CHAR_MARA_TURN_MASTER_V01' }]);
    assert.deepStrictEqual([plan.deletable, plan.refused.code], [false, 'drawn_from']);
    const lookMaster = ws.loadProject(root).style.look_refs[0];
    [plan] = await checkOf([{ id: lookMaster }]);
    assert.deepStrictEqual([plan.deletable, plan.refused.code], [false, 'drawn_from']);
    const firstRender = ws.loadPage(root, pages[0]).current_render;
    [plan] = await checkOf([{ id: firstRender }]);
    assert.deepStrictEqual([plan.deletable, plan.refused.code], [false, 'render_reference'], 'the next page was drawn with it as its previous page');
    [plan] = await checkOf([{ id: pages[0] }]);
    assert.deepStrictEqual([plan.refused.code], ['page_not_last']);
    [plan] = await checkOf([{ id: 'CHAR_MARA' }]);
    assert.deepStrictEqual([plan.kind, plan.refused.code], ['entity', 'entity_in_use']);

    // --- 3. an approved master with nothing drawn from it asks twice ------------------------------
    // A second character with an approved sheet that nothing was drawn from yet.
    const teo = done(await s.runOp(id, 'character.create', { name: 'Teo', description: 'A mechanic.' }), 'character.create');
    r = await s.api('POST', `${P}/approve/asset`, { candidate: teo.result.sheet.candidate_id });
    assert.strictEqual(r.status, 200);
    // A merge of Mara away is refused: pages were drawn from her sheet.
    r = await s.api('POST', `${P}/entities/merge`, { from: 'CHAR_MARA', into: 'CHAR_TEO' });
    assert.deepStrictEqual([r.status, r.body.error.code], [409, 'merge_refused']);
    const teoMaster = 'CHAR_TEO_TURN_MASTER_V01';
    [plan] = await checkOf([{ id: teoMaster }]);
    assert.deepStrictEqual([plan.deletable, plan.confirm_twice], [true, true]);
    assert.ok(plan.dependents.length && /Teo/.test(plan.dependents.join(' ')), JSON.stringify(plan.dependents));
    r = await del([{ id: teoMaster }]);
    assert.deepStrictEqual([r.status, r.body.error.code], [409, 'delete_confirm_twice']);
    assert.ok(fs.existsSync(path.join(root, 'characters', 'CHAR_TEO', 'refs', `${teoMaster}.png`)), 'nothing was deleted');
    r = await del([{ id: teoMaster }], { confirm_master: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.check.ok, true, JSON.stringify(r.body.check));
    assert.ok(!fs.existsSync(path.join(root, 'characters', 'CHAR_TEO', 'refs', `${teoMaster}.png`)));
    assert.ok(!fs.existsSync(path.join(root, 'characters', 'CHAR_TEO', 'refs', 'CHAR_TEO_TURN_V01.png')), 'with the try it was approved from');
    assert.ok(!ws.loadCharacter(root, 'CHAR_TEO').references.includes(teoMaster), 'the character file no longer lists it');
    assert.ok(!ws.loadReferenceAssets(root).has(teoMaster), 'nor the registry');

    // --- 4. page versions, then the last page ------------------------------------------------------
    const last = pages[pages.length - 1];
    done(await s.runOp(id, 'pages.generate', { pages: [last], regenerate: true }, 60000), 'redraw');
    const renders = ws.listRenders(root, last);
    assert.strictEqual(renders.length, 2, JSON.stringify(renders));
    const [oldRender, newRender] = renders;
    assert.strictEqual(ws.loadPage(root, last).current_render, newRender);
    r = await del([{ id: oldRender }]);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.check.ok, true, JSON.stringify(r.body.check));
    assert.ok(!ws.renderFile(root, oldRender) && !ws.loadReview(root, oldRender), 'the image and its review are gone');
    [plan] = await checkOf([{ id: newRender }]);
    assert.ok(plan.deletable && /not drawn/.test(plan.dependents.join(' ')), JSON.stringify(plan));
    r = await del([{ id: newRender }]);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([ws.loadPage(root, last).current_render, r.body.check.ok], [null, true], JSON.stringify(r.body.check));
    r = await del([{ id: last }]);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.check.ok, true, JSON.stringify(r.body.check));
    assert.ok(!fs.existsSync(ws.pageDir(root, last)));
    assert.strictEqual(ws.loadIssue(root, 'ISS_001').page_count, pages.length - 1);
    assert.strictEqual(ws.loadPage(root, pages[0]).continuity.exits_to, null);
    assert.ok(!JSON.stringify(ws.listScenes(root, 'ISS_001').map((x) => x.doc)).includes(last));

    // --- 5. a character nobody uses, an upload, several at once ------------------------------------
    [plan] = await checkOf([{ id: 'CHAR_TEO' }]);
    assert.deepStrictEqual([plan.deletable, plan.confirm_twice], [true, false]);
    const up = await s.upload(id, 'photo.png', PNG, 'image/png');
    [plan] = await checkOf([{ id: up.id }]);
    assert.deepStrictEqual([plan.kind, plan.undo], ['upload', 'none']);
    r = await del([{ id: 'CHAR_TEO' }, { id: up.id }]);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.deleted.length, 2);
    assert.ok(!fs.existsSync(path.join(root, 'characters', 'CHAR_TEO')));
    assert.ok(!ws.listEntityIds(root, 'characters').includes('CHAR_TEO'));
    assert.strictEqual((await s.api('GET', `${P}/uploads`)).body.uploads.length, 0);
    assert.strictEqual(r.body.check.ok, true, JSON.stringify(r.body.check));

    // A published edition stays; a draft goes.
    const pub = done(await s.runOp(id, 'publish.build', { formats: ['cbz'], mode: 'final' }, 60000), 'publish');
    const edition = ws.listEditions(root).pop();
    [plan] = await checkOf([{ id: edition }]);
    assert.ok(pub && plan.refused && ['edition_published'].includes(plan.refused.code), JSON.stringify(plan));
    const shipped = ws.loadEdition(root, edition).pages[0].render;
    [plan] = await checkOf([{ id: shipped }]);
    assert.deepStrictEqual([plan.refused.code], ['in_edition']);

    // --- 6. clean up ------------------------------------------------------------------------------------
    const tryA = done(await s.runOp(id, 'character.sheet', { character: 'CHAR_MARA', sheet: 'turnaround' }), 'try').result.sheet.candidate_id;
    const tryB = done(await s.runOp(id, 'character.sheet', { character: 'CHAR_MARA', sheet: 'turnaround' }), 'try').result.sheet.candidate_id;
    let clean = (await s.api('GET', `${P}/cleanup?scope=character:CHAR_MARA`)).body.items;
    assert.deepStrictEqual(clean.map((c) => c.id).sort(), [tryA, tryB].sort(), 'tries of a sheet that has a master');
    assert.ok(clean.every((c) => c.reason && c.deletable));
    r = await del(clean.map((c) => ({ kind: c.kind, id: c.id })));
    assert.strictEqual(r.status, 200);
    clean = (await s.api('GET', `${P}/cleanup?scope=characters`)).body.items;
    assert.deepStrictEqual(clean, []);
    r = await s.api('GET', `${P}/cleanup?scope=nowhere`);
    assert.strictEqual(r.status, 400);

    // --- 7. the chat: a delete always waits ------------------------------------------------------------
    await s.api('PUT', `${P}/settings`, { chat_auto_run: true });
    const tryC = done(await s.runOp(id, 'character.sheet', { character: 'CHAR_MARA', sheet: 'turnaround' }), 'try').result.sheet.candidate_id;
    const msg = await s.api('POST', `${P}/conversation`, {
      screen: 'character:CHAR_MARA', text: `DO:delete {"items": [{"id": "${tryC}"}]}`,
    });
    assert.strictEqual(msg.status, 202, JSON.stringify(msg.body));
    const turn = await s.waitJob(id, msg.body.job.id);
    done(turn, 'chat turn');
    const card = turn.result.message.actions[0];
    assert.deepStrictEqual([card.action, card.status, card.decision, card.requested, card.always_confirm], ['delete', 'pending', true, false, true]);
    assert.ok(fs.existsSync(path.join(root, 'characters', 'CHAR_MARA', 'refs', `${tryC}.png`)), 'nothing deleted until the click');
    r = await s.api('POST', `${P}/conversation/${turn.result.conversation}/actions/${card.id}/run`, {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.card.status, 'done', JSON.stringify(r.body.card));
    assert.ok(!fs.existsSync(path.join(root, 'characters', 'CHAR_MARA', 'refs', `${tryC}.png`)));
  } finally {
    await s.close();
  }
  console.log(`studio-delete: ok (${Date.now() - started} ms)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
