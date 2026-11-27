'use strict';
/**
 * Studio: the lettering of a planned page, and the touch-up warning.
 *
 * 1. lettering-plan.js on its own: ids kept and new ones given, reading
 *    order renumbered, no speaker on captions, a voice from off panel gets
 *    a ledger row, word budgets and the ceiling of balloons per panel as
 *    warnings, a lettering that cannot be right refused.
 * 2. The plan review saves through PUT /pages/:page/plan: the page is
 *    validated, the continuity check runs for it, the budgets come back as
 *    warnings, and a drawn page says it needs drawing again (in the image)
 *    or lettering again (overlay).
 * 3. The chat's page.lettering card shows the change before it runs, waits
 *    for a click unless the message asked for it, and saves the same way.
 * 4. The touch-up warning in the chat: a correction at the warning becomes a
 *    card with two choices; it never runs by itself, and runs with the
 *    choice the person clicks.
 *
 * Fake mode: no CLI runs.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { start } = require('../studio/test-support/harness');
const lp = require('../studio/server/lettering-plan');
const ws = require('../scripts/lib/workspace');
const yaml = require('../scripts/lib/yaml');

function done(job, label) {
  assert.strictEqual(job.status, 'done', `${label}: ${job.status} ${JSON.stringify(job.error)}`);
  return job;
}

function row(character, extra = {}) {
  return Object.assign({ character, position: { level: 'deck', side: 'left' }, action: 'Stands.', wardrobe: 'WARD_A', state: [] }, extra);
}

function units() {
  // --- normalize -------------------------------------------------------------------------------
  const page = {
    id: 'PG_001_001',
    panels: [
      { id: 'PN_001_001_01', order: 1, cast: [row('CHAR_MARA', { state: ['wet'] }), row('CHAR_OSKAR', { position: { level: 'deck', side: 'right' } })], lettering: [
        { id: 'L02', type: 'balloon', speaker: 'CHAR_MARA', text: '  Hold   on. ', order: 5 },
        { type: 'caption', speaker: 'CHAR_MARA', text: 'Night.' },
      ] },
      { id: 'PN_001_001_02', order: 2, cast: [row('CHAR_OSKAR', { position: { level: 'deck', side: 'right' } })], lettering: [
        { id: 'L02', type: 'thought', speaker: 'CHAR_OSKAR', text: 'Again?' },
        { type: 'shout', speaker: 'CHAR_MARA', text: 'Down!' },
      ] },
    ],
  };
  const { added, problems } = lp.normalize(page);
  assert.deepStrictEqual(problems, []);
  const all = page.panels.flatMap((p) => p.lettering);
  assert.deepStrictEqual(all.map((l) => l.id), ['L02', 'L01', 'L03', 'L04'], 'a kept id stays; a duplicate and the new ones get free ids');
  assert.deepStrictEqual(all.map((l) => l.order), [1, 2, 3, 4], 'reading order follows the panels');
  assert.deepStrictEqual([all[0].text, all[1].speaker], ['Hold on.', null], 'text tidied; a caption has no speaker');
  assert.deepStrictEqual(added, [{ panel: 'PN_001_001_02', character: 'CHAR_MARA' }]);
  const voice = page.panels[1].cast.find((r) => r.character === 'CHAR_MARA');
  assert.deepStrictEqual([voice.off_panel, voice.position.side, voice.state, voice.wardrobe], [true, 'left', ['wet'], 'WARD_A'], 'copied from her row in panel 1');

  // A speaker with no row anywhere on the page, an empty text, a kind that does not exist.
  const bad = JSON.parse(JSON.stringify(page));
  bad.panels[0].lettering.push({ type: 'balloon', speaker: 'CHAR_NOBODY', text: 'Hi' }, { type: 'caption', text: ' ' }, { type: 'scream', text: 'A' });
  assert.deepStrictEqual(lp.normalize(bad).problems.map((p) => p.code), ['speaker_unknown', 'empty', 'bad_type']);

  // --- budgets -------------------------------------------------------------------------------------
  assert.strictEqual(lp.wordCount('Hold on -- now!'), 3, 'punctuation alone is no word');
  const limits = lp.limitsOf({ lettering: { max_words_per_balloon: 3, max_words_per_panel: 5 } });
  assert.deepStrictEqual(limits, { words_per_balloon: 3, words_per_panel: 5, per_panel: 4 });
  assert.deepStrictEqual(lp.limitsOf({}), { words_per_balloon: 25, words_per_panel: 50, per_panel: 4 }, 'the rule defaults');
  const busy = JSON.parse(JSON.stringify(page));
  busy.panels[0].lettering = ['one two three four', 'a', 'b', 'c', 'd'].map((text) => ({ type: 'balloon', speaker: 'CHAR_MARA', text }));
  busy.panels[0].lettering.push({ type: 'sfx', text: 'BOOM BOOM BOOM BOOM' });
  const warned = lp.warnings(busy, limits).map((w) => [w.code, w.words || w.count]);
  assert.deepStrictEqual(warned, [['balloon_words', 4], ['panel_words', 12], ['panel_count', 5]], 'a sound effect counts toward the words of the panel, not as a balloon or for the balloon budget');

  // --- the chat's panels, checked ------------------------------------------------------------------------
  assert.throws(() => lp.checkPanels([{ panel: 'PN_009_009_09', lettering: [] }], page), /not a panel/);
  assert.throws(() => lp.checkPanels([{ panel: 'PN_001_001_01', lettering: [{ type: 'balloon', text: 'Hi' }] }], page), /needs "speaker"/);
  assert.throws(() => lp.checkPanels([{ panel: 'PN_001_001_01', lettering: [{ type: 'growl', text: 'Hi' }] }], page), /not a kind/);
  const clean = lp.checkPanels([{ panel: 'PN_001_001_01', lettering: [{ id: 'L02', type: 'caption', speaker: 'CHAR_MARA', text: 'Dawn.' }] }], page);
  assert.deepStrictEqual(clean[0].lettering[0], { type: 'caption', speaker: null, text: 'Dawn.', id: 'L02' });
  const after = lp.applyPanels(page, clean);
  lp.normalize(after);
  assert.deepStrictEqual(lp.changesOf(page, after).map((c) => [c.change, c.id]), [['changed', 'L02'], ['removed', 'L01']],
    'the elements pushed along by a removal have not moved');
  const swapped = JSON.parse(JSON.stringify(page));
  swapped.panels[1].lettering.reverse();
  lp.normalize(swapped);
  assert.deepStrictEqual(lp.changesOf(page, swapped).map((c) => [c.change, c.id]), [['moved', 'L04'], ['moved', 'L03']]);
}

async function main() {
  const started = Date.now();
  units();
  const s = await start();
  try {
    const id = await s.seedProject('Lettering Plan');
    const P = `/api/projects/${id}`;
    const root = path.join(s.home, id, 'production');
    done(await s.runOp(id, 'pages.plan', { text: 'Mara finds the boy in the hold. She tells him to stay quiet.', pages: 2 }), 'pages.plan');
    const pageId = 'PG_001_001';
    const pageFile = path.join(ws.pageDir(root, pageId), 'page.yaml');

    // --- the page screen carries the budgets and the kinds ------------------------------------------------
    let r = await s.api('GET', `${P}/pages/${pageId}`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.lettering.limits, { words_per_balloon: 25, words_per_panel: 50, per_panel: 4 });
    assert.deepStrictEqual(r.body.lettering.kinds, lp.KINDS);
    assert.ok(r.body.plan.panels[0].cast.every((c) => 'side' in c), 'each cast row says its side, for the tail');
    const mara = 'CHAR_MARA';
    const panels = r.body.page.data.panels;
    assert.ok(panels[0].cast.some((c) => c.character === mara), 'Mara is drawn in panel 1');

    // --- save from the plan review: add, reorder, kinds, a voice from off panel ----------------------------
    const data = JSON.parse(JSON.stringify(r.body.page.data));
    const p1 = data.panels[0];
    const before = (p1.lettering || []).slice();
    p1.lettering = [
      { type: 'caption', speaker: null, text: 'The hold, after midnight.' },
      ...before,
      { type: 'thought', speaker: mara, text: 'Not a sound, please.' },
    ];
    const last = data.panels[data.panels.length - 1];
    if (!last.cast.some((c) => c.character === mara)) last.lettering = (last.lettering || []).concat([{ type: 'whisper', speaker: mara, text: 'Stay down.' }]);
    r = await s.api('PUT', `${P}/pages/${pageId}/plan`, { data, base_etag: (await s.api('GET', `${P}/pages/${pageId}`)).body.page.etag });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.saved, true);
    assert.deepStrictEqual(r.body.findings, [], 'the page still validates');
    assert.ok(Array.isArray(r.body.continuity) && r.body.continuity.every((f) => f.page === pageId), 'continuity for this page only');
    assert.ok(!r.body.continuity.some((f) => f.severity === 'error'), JSON.stringify(r.body.continuity));
    assert.strictEqual(r.body.redraw, null, 'nothing is drawn yet');
    assert.ok(r.body.lettering.changes.some((c) => c.change === 'added' && c.type === 'thought'));
    const saved = ws.loadYaml(pageFile);
    const letters = saved.panels.flatMap((p) => p.lettering || []);
    assert.strictEqual(saved.panels[0].lettering[0].type, 'caption');
    assert.strictEqual(saved.panels[0].lettering[0].speaker, null);
    assert.deepStrictEqual(letters.map((l) => l.order), letters.map((_, i) => i + 1), 'reading order renumbered');
    assert.strictEqual(new Set(letters.map((l) => l.id)).size, letters.length, 'ids unique within the page');
    if (r.body.lettering.added_cast.length) {
      const voice = saved.panels.find((p) => p.id === r.body.lettering.added_cast[0].panel).cast.find((c) => c.character === mara);
      assert.strictEqual(voice.off_panel, true, 'a voice from outside the frame keeps a ledger row');
    }
    // The commit holds only page.yaml.
    r = await s.api('GET', `${P}/history?limit=1`);
    assert.strictEqual(r.body.entries[0].kind, 'save');

    // --- refusals and warnings ---------------------------------------------------------------------------
    const stale = JSON.parse(JSON.stringify(ws.loadYaml(pageFile)));
    r = await s.api('PUT', `${P}/pages/${pageId}/plan`, { data: stale, base_etag: 'old' });
    assert.deepStrictEqual([r.status, r.body.error.code], [409, 'file_changed']);
    stale.panels[0].lettering.push({ type: 'balloon', speaker: mara, text: '   ' });
    r = await s.api('PUT', `${P}/pages/${pageId}/plan`, { data: stale });
    assert.deepStrictEqual([r.status, r.body.error.code], [422, 'lettering_invalid']);
    stale.panels[0].lettering.pop();
    stale.panels[0].lettering.push({ type: 'balloon', speaker: mara, text: Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ') });
    r = await s.api('PUT', `${P}/pages/${pageId}/plan`, { data: stale });
    assert.strictEqual(r.status, 200, 'over budget is a warning, the person decides');
    assert.ok(r.body.lettering.warnings.some((w) => w.code === 'balloon_words' && w.words === 30 && w.limit === 25), JSON.stringify(r.body.lettering.warnings));

    // --- a drawn page needs drawing again (in the image) or lettering again (overlay) -------------------------
    done(await s.runOp(id, 'pages.generate', { pages: [pageId], approve_plans: true }, 60000), 'pages.generate');
    const drawn = ws.loadYaml(pageFile);
    drawn.panels[0].lettering[0].text = 'The hold, just before dawn.';
    r = await s.api('PUT', `${P}/pages/${pageId}/plan`, { data: drawn });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.redraw, { render: `${pageId}_V01`, mode: 'draw' });
    // A change elsewhere in the plan is not a lettering change.
    const moment = ws.loadYaml(pageFile);
    moment.panels[0].moment = `${moment.panels[0].moment} Rain on the hatch.`;
    r = await s.api('PUT', `${P}/pages/${pageId}/plan`, { data: moment });
    assert.strictEqual(r.body.redraw, null);
    r = await s.api('PUT', `${P}/options`, { lettering_mode: 'overlay' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const overlay = ws.loadYaml(pageFile);
    overlay.panels[0].lettering[0].text = 'The hold.';
    r = await s.api('PUT', `${P}/pages/${pageId}/plan`, { data: overlay });
    assert.deepStrictEqual(r.body.redraw, { render: `${pageId}_V01`, mode: 'reletter' });
    r = await s.api('PUT', `${P}/options`, { lettering_mode: 'in_image' });

    // --- the chat: a page.lettering card ---------------------------------------------------------------------
    const screen = { key: `page:${pageId}` };
    const chat = async (text) => {
      const res = await s.api('POST', `${P}/conversation`, { text, screen });
      assert.strictEqual(res.status, 202, JSON.stringify(res.body));
      const job = await s.waitJob(id, res.body.job.id);
      done(job, 'chat turn');
      const conv = (await s.api('GET', `${P}/conversation`)).body.conversation;
      return conv.messages.filter((m) => m.role === 'assistant' && m.job === job.id).pop();
    };
    const cardsOf = async (reply) => {
      const conv = (await s.api('GET', `${P}/conversation`)).body.conversation;
      const msg = conv.messages.find((m) => m.id === reply.id);
      return msg.actions;
    };
    const current = ws.loadYaml(pageFile);
    const target = current.panels[1];
    const keep = (target.lettering || []).map((l) => ({ id: l.id, type: l.type, speaker: l.speaker, text: l.text }));
    const params = { page: pageId, panels: [{ panel: target.id, lettering: [...keep, { type: 'thought', speaker: mara, text: 'He is only a boy.' }] }] };
    let reply = await chat(`Add a thought for her. ACTION:page.lettering ${JSON.stringify(params)}`);
    let [card] = await cardsOf(reply);
    assert.strictEqual(card.action, 'page.lettering');
    assert.deepStrictEqual([card.status, card.decision, card.requested], ['pending', true, false], 'a suggestion waits for a click');
    assert.ok(card.preview && card.preview.changes.some((c) => c.change === 'added' && c.kind === 'thought' && c.text === 'He is only a boy.'), JSON.stringify(card.preview));
    assert.strictEqual(card.preview.drawn, true);
    assert.ok(!card.details.some((d) => d.name === 'panels'), 'the preview stands in for the raw list');
    assert.ok(!ws.loadYaml(pageFile).panels[1].lettering.some((l) => l.text === 'He is only a boy.'), 'nothing saved before the click');
    r = await s.api('POST', `${P}/conversation/${card.conversation}/actions/${card.id}/run`, {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.card.status, 'done', JSON.stringify(r.body.card.error));
    assert.ok(ws.loadYaml(pageFile).panels[1].lettering.some((l) => l.type === 'thought' && l.text === 'He is only a boy.'));
    assert.deepStrictEqual(r.body.card.result.redraw, { render: `${pageId}_V01`, mode: 'draw' });
    // Asked for in so many words: it runs in the same turn.
    const removeAll = { page: pageId, panels: [{ panel: target.id, lettering: [] }] };
    reply = await chat(`Remove the balloons of panel 2. DO:page.lettering ${JSON.stringify(removeAll)}`);
    [card] = await cardsOf(reply);
    assert.deepStrictEqual([card.requested, card.status], [true, 'done'], JSON.stringify(card.error));
    assert.deepStrictEqual(ws.loadYaml(pageFile).panels[1].lettering, []);
    // A card that does not check out is left out with its reason.
    reply = await chat(`ACTION:page.lettering ${JSON.stringify({ page: pageId, panels: [{ panel: target.id, lettering: [{ type: 'balloon', text: 'Who?' }] }] })}`);
    assert.deepStrictEqual(await cardsOf(reply), []);
    assert.ok(reply.dropped.some((d) => d.action === 'page.lettering'), JSON.stringify(reply.dropped));

    // --- the touch-up warning in the chat ----------------------------------------------------------------------
    r = await s.api('PUT', `${P}/options`, { touch_up_warning: 0 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    r = await s.api('GET', P);
    assert.strictEqual(r.body.touch_up_warning, 0);
    reply = await chat(`Make the lamp brighter. DO:page.correct ${JSON.stringify({ page: pageId, text: 'Make the lamp brighter.' })}`);
    [card] = await cardsOf(reply);
    assert.strictEqual(card.action, 'page.correct');
    assert.deepStrictEqual([card.status, card.requested], ['pending', false], 'a choice never starts by itself, even when asked for');
    assert.deepStrictEqual(card.choice.options.map((o) => o.mode), ['touch_up', 'redraw']);
    assert.ok(/touched up (\d+ times|once)/.test(card.choice.text), card.choice.text);
    r = await s.api('POST', `${P}/conversation/${card.conversation}/actions/${card.id}/run`, {});
    assert.deepStrictEqual([r.status, r.body.error.code], [409, 'choice_needed']);
    r = await s.api('POST', `${P}/conversation/${card.conversation}/actions/${card.id}/run`, { choice: 'touch_up' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.card.chosen, r.body.card.params.mode], ['touch_up', 'touch_up']);
    const job = done(await s.waitJob(id, r.body.job.id, 60000), 'page.correct from the card');
    assert.strictEqual(job.result.path, 'edit');
    assert.strictEqual(yaml.parse(fs.readFileSync(path.join(root, 'project.yaml'), 'utf8')).repair_policy.touch_up_warning, 0);
    // A redraw chosen on a second card goes through the plan.
    reply = await chat(`ACTION:page.correct ${JSON.stringify({ page: pageId, text: 'A lighter sky.' })}`);
    [card] = await cardsOf(reply);
    r = await s.api('POST', `${P}/conversation/${card.conversation}/actions/${card.id}/run`, { choice: 'redraw' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const redraw = done(await s.waitJob(id, r.body.job.id, 60000), 'redraw from the card');
    assert.strictEqual(redraw.result.path, 'redraw');
  } finally {
    await s.close();
  }
  console.log(`studio-lettering-plan: ok (${Date.now() - started} ms)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
