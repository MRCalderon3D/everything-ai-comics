'use strict';
/**
 * Studio: a page whose cast needs more reference images than the drawing
 * tool takes (TODO item 15), in fake mode.
 *
 * - The plan's checks run against the provider that will draw, so the
 *   REFERENCE_BUDGET warning appears before anything is drawn, in plain
 *   words, with the characters' names, and with the two things the person
 *   can do: draw the page panel by panel, or propose a staging change.
 * - "Panel by panel" (page.mode) sets generation.mode per_panel and rebuilds
 *   the reference plan in the same step; the warning goes away.
 * - Drawing such a page draws one image per panel, each with only its own
 *   cast, and leaves the page waiting for the panels to be put together and
 *   uploaded; the upload is then checked as any page.
 * - Who is in a panel never changes on its own.
 */

const assert = require('assert');
const path = require('path');
const { start } = require('../studio/test-support/harness');
const png = require('../scripts/lib/png');
const ws = require('../scripts/lib/workspace');
const yaml = require('../scripts/lib/yaml');
const { validateWorkspace } = require('../scripts/validate-workspace');

async function main() {
  const started = Date.now();
  const s = await start();
  try {
    const id = await s.seedProject('Budget Crowd', { pages: 1 });
    const root = path.join(s.home, id, 'production');
    const P = `/api/projects/${id}`;
    for (const name of ['Iker', 'Lola', 'Nadia', 'Olga']) {
      const made = await s.runOp(id, 'character.create', { name, description: `${name}, a deckhand.` });
      assert.strictEqual(made.status, 'done', JSON.stringify(made.error));
      const r = await s.api('POST', `${P}/approve/asset`, { candidate: made.result.sheet.candidate_id });
      assert.strictEqual(r.status, 200);
    }
    const plan = await s.runOp(id, 'pages.plan', { text: 'CROWD The whole crew meets on deck at dawn.', pages: 1 });
    assert.strictEqual(plan.status, 'done', JSON.stringify(plan.error));
    const pageId = plan.result.pages[0].id;
    const castBefore = ws.loadPage(root, pageId).panels.map((p) => p.cast.map((c) => c.character));

    // The warning, in plain words, with what can be done.
    let r = await s.api('GET', `${P}/pages/${pageId}`);
    assert.strictEqual(r.status, 200);
    const budget = r.body.findings.budget;
    assert.strictEqual(budget.length, 1, JSON.stringify(budget));
    assert.strictEqual(budget[0].scope, 'page');
    assert.deepStrictEqual([budget[0].count, budget[0].capacity, budget[0].fits_per_panel], [6, 5, true]);
    assert.ok(/needs 6 reference images \(the look page, Iker, Lola, Mara, Nadia, Olga\) and the drawing tool takes 5 at a time\. Drawn panel by panel, every panel fits\./.test(budget[0].message), budget[0].message);
    assert.ok(!/CHAR_|codex-cli|build-reference-plan/.test(budget[0].message), 'no developer text');
    assert.deepStrictEqual(budget[0].actions, ['per_panel', 'staging']);
    assert.ok(r.body.findings.continuity.some((f) => f.code === 'REFERENCE_BUDGET' && f.entity === 'codex-cli'), 'checked against the provider that will draw');
    r = await s.api('GET', `${P}/issues/ISS_001`);
    assert.strictEqual(r.body.pages.find((p) => p.id === pageId).budget.length, 1, 'the Pages screen lists it too');
    r = await s.api('GET', `${P}/pages/${pageId}?lang=es`);
    assert.ok(/Esta página necesita 6 imágenes de referencia/.test(r.body.findings.budget[0].message));

    // Panel by panel: the mode changes and the reference plan is rebuilt in the same step.
    r = await s.api('POST', `${P}/pages/${pageId}/mode`, { mode: 'per_panel' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.reference_plan.mode, 'per_panel');
    assert.ok(r.body.commit, 'one commit');
    const page = ws.loadPage(root, pageId);
    assert.strictEqual(page.generation.mode, 'per_panel');
    assert.strictEqual(yaml.parse(require('fs').readFileSync(path.join(ws.pageDir(root, pageId), 'reference-plan.yaml'), 'utf8')).mode, 'per_panel');
    r = await s.api('GET', `${P}/pages/${pageId}`);
    assert.deepStrictEqual(r.body.findings.budget, [], 'the warning is gone');
    assert.strictEqual(r.body.generation_mode, 'per_panel');
    assert.deepStrictEqual(ws.loadPage(root, pageId).panels.map((p) => p.cast.map((c) => c.character)), castBefore, 'nobody moved off panel');

    // Drawing it: one image per panel, each with its own cast; then the page waits to be assembled.
    r = await s.api('POST', `${P}/approve/plan`, { pages: [pageId] });
    const drawn = await s.runOp(id, 'pages.generate', { pages: [pageId] });
    assert.strictEqual(drawn.status, 'done', JSON.stringify(drawn.error));
    assert.deepStrictEqual(drawn.result.to_assemble, [pageId]);
    const panelSteps = drawn.steps.filter((x) => /:panel-PN_/.test(x.id));
    assert.strictEqual(panelSteps.length, 3);
    assert.ok(panelSteps.every((x) => x.status === 'done'));
    assert.strictEqual(drawn.steps.find((x) => x.id === `${pageId}:review`).status, 'skipped');
    r = await s.api('GET', `${P}/pages/${pageId}`);
    assert.strictEqual(r.body.panel_images.length, 3, 'the panel images are shown for assembly');
    assert.ok(r.body.panel_images.every((p) => p.image && p.image.url));
    assert.strictEqual(r.body.renders.length, 0, 'no page render until the person uploads one');
    const pkgs = require('fs').readdirSync(path.join(ws.pageDir(root, pageId), 'prompts')).filter((n) => /\.PN_/.test(n));
    assert.strictEqual(pkgs.length, 3);
    for (const name of pkgs) {
      const pkg = yaml.parse(require('fs').readFileSync(path.join(ws.pageDir(root, pageId), 'prompts', name), 'utf8'));
      assert.ok(pkg.references.length <= 5, `${name}: ${pkg.references.length} references`);
    }

    // The assembled page, uploaded by the person, is checked like any page.
    const tiny = png.encode({ width: 20, height: 30, data: Buffer.alloc(20 * 30 * 3, 200) });
    const up = await s.upload(id, 'assembled.png', tiny, 'image/png');
    const manual = await s.runOp(id, 'page.manual', { page: pageId, upload: up.id });
    assert.strictEqual(manual.status, 'done', JSON.stringify(manual.error));
    assert.ok(ws.loadPage(root, pageId).current_render, 'the page has its render');
    assert.deepStrictEqual(validateWorkspace(root).errors, []);

    // The chat's prompt carries the rule: who is in a panel is never changed to fit a tool.
    const chat = require('fs').readFileSync(path.join(__dirname, '..', 'studio', 'prompts', 'chat.txt'), 'utf8');
    assert.ok(/Never change it to fit a tool limit/.test(chat) && /page\.mode/.test(chat));
  } finally {
    await s.close();
  }
  console.log(`studio-budget: ok (${Date.now() - started} ms)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
