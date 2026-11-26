'use strict';
/** scripts/build-board.js: one HTML board per issue, from the workspace files. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildBoard, panelsByTier, tierSchematic } = require('../scripts/build-board');
const { makeWorkspace, cleanup, editYaml } = require('./fixtures/publishing/helpers');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'build-board.js');
const roots = [];

function workspace() {
  const root = makeWorkspace();
  roots.push(root);
  const issue = path.join(root, 'issues', 'ISS_001');
  return { root, issue, page: (id) => path.join(issue, 'pages', id, 'page.yaml') };
}

try {
  // --- the board of the fixture issue, without a ledger checker -----------------------------
  {
    const w = workspace();
    const result = buildBoard(w.issue, { checkContinuity: null });
    assert.strictEqual(result.issue, 'ISS_001');
    assert.deepStrictEqual(result.pages, ['PG_001_001', 'PG_001_002', 'PG_001_003']);
    assert.strictEqual(path.relative(result.file, path.join(w.issue, 'board.html')), '', 'default output is <issue dir>/board.html');
    const html = fs.readFileSync(result.file, 'utf8');
    assert.strictEqual(html, result.html);
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /<title>The Night Ferry: ISS_001 Crossing board<\/title>/);
    assert.match(html, /3 pages · 9 panels · 3 reviewed/);

    // Every page: ID, number, side, purpose, grid, status.
    for (const id of result.pages) {
      assert.ok(html.includes(`<section class="page" id="${id}">`), `${id} has a section`);
      assert.ok(html.includes(`<a href="#${id}">`), `${id} is in the index`);
    }
    assert.match(html, /page 1 · right side · SC_001_01 · page turn: reveal · 4 panels · 5 lettering elements/);
    assert.match(html, /page 2 · left side · SC_001_01 · page turn: continuation · 4 panels · 1 lettering element</);
    assert.match(html, /Establish the ferry, Mara alone, and the sound that breaks the routine\./);
    assert.match(html, /three tiers, 1 \/ 2 \/ 1/);
    assert.match(html, /two tiers, 2 \/ 2/);
    assert.strictEqual((html.match(/<span class="badge status">reviewed<\/span>/g) || []).length, 3);

    // Panels: size, framing, moment, cast, lettering count.
    for (const panel of ['PN_001_001_01', 'PN_001_001_04', 'PN_001_002_03', 'PN_001_003_01']) {
      assert.ok(html.includes(`<td>${panel}</td>`), `${panel} is listed`);
    }
    assert.match(html, /<td>1<\/td><td>PN_001_001_01<\/td><td>wide<\/td><td>extreme wide, high angle, three quarter<\/td><td>The ferry crosses dark water with one shielded lamp lit\.<\/td><td><\/td><td class="n">1<\/td>/);
    assert.match(html, /<td>PN_001_001_02<\/td><td>medium<\/td><td>medium, eye level, profile<\/td><td>[^<]*<\/td><td>MARA<\/td><td class="n">2<\/td>/);
    assert.match(html, /<td>MARA, OSKAR \(off panel\)<\/td>/);

    // Tier schematic: one rectangle per panel plus the page outline.
    const schematics = [...html.matchAll(/<svg class="schematic"[\s\S]*?<\/svg>/g)].map((m) => m[0]);
    assert.strictEqual(schematics.length, 3);
    assert.deepStrictEqual(schematics.map((s) => (s.match(/<rect /g) || []).length), [5, 5, 2]);
    assert.match(schematics[0], /viewBox="0 0 132 198"/, '2:3 page');

    // Render thumbnails, relative to the board.
    assert.match(html, /<img src="pages\/PG_001_001\/renders\/PG_001_001_V01\.png" alt="PG_001_001_V01"/);
    assert.match(html, /<img src="pages\/PG_001_002\/renders\/PG_001_002_V02\.png"/);
    assert.match(html, /<img src="pages\/PG_001_003\/renders\/PG_001_003_V01\.jpg"/);
    assert.ok(!/<img src="[a-zA-Z]:|<img src="\//.test(html), 'no absolute image paths');

    // Review verdicts.
    assert.match(html, /<span class="badge good">pass<\/span> PG_001_001_V01, repair cycle 0, style pass, continuity pass, human approval pending/);
    assert.match(html, /<span class="badge good">fixed<\/span> PG_001_002_V02, repair cycle 1/);
    assert.match(html, /Other renders: PG_001_002_V01 <span class="badge bad">flagged<\/span>/);
    assert.match(html, /No open findings\./);

    assert.strictEqual(result.ledger, false);
    assert.ok(!/Panel ledger/.test(html), 'no ledger section without a checker');
    assert.match(html, /does not inspect artwork/);
  }

  // --- open findings, missing renders, missing reviews -------------------------------------------
  {
    const w = workspace();
    editYaml(w.page('PG_001_002'), (doc) => { doc.current_render = 'PG_001_002_V01'; doc.status = 'rendered'; });
    editYaml(w.page('PG_001_003'), (doc) => { doc.current_render = null; doc.status = 'scripted'; });
    editYaml(w.page('PG_001_001'), (doc) => { doc.purpose = 'Purpose with <script>alert(1)</script> & "quotes".'; });
    fs.rmSync(path.join(w.issue, 'pages', 'PG_001_001', 'reviews', 'PG_001_001_V01.review.yaml'));
    const out = path.join(w.root, 'boards', 'iss-001.html');
    const result = buildBoard(w.issue, { out, checkContinuity: null });
    assert.ok(fs.existsSync(out), '--out is honoured and its directory created');
    const html = result.html;

    assert.match(html, /<span class="badge bad">flagged<\/span> PG_001_002_V01, repair cycle 0, style pass, continuity fail/);
    assert.match(html, /<li><span class="badge bad">blocking<\/span> <b>F01<\/b> identity in PN_001_002_03: The boy has Mara&#39;s long face and cropped grey hair\. <span class="dim">Expected: Oskar has a round face and a hooded jacket\.<\/span><\/li>/);
    assert.match(html, /Other renders: PG_001_002_V02 <span class="badge good">fixed<\/span>/);
    assert.match(html, /<span class="badge none">no review<\/span> PG_001_001_V01 has no review file\./);
    assert.match(html, /no render yet/);
    assert.match(html, /Nothing to review yet\./);
    assert.match(html, /1 rendered · 1 reviewed · 1 scripted/);

    assert.match(html, /Purpose with &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;quotes&quot;\./, 'workspace text is escaped');
    assert.ok(!/<script>alert/.test(html));
    // Thumbnails are relative to the output file, wherever it is.
    assert.match(html, /<img src="\.\.\/issues\/ISS_001\/pages\/PG_001_001\/renders\/PG_001_001_V01\.png"/);

    // A current render whose file is gone.
    fs.rmSync(path.join(w.issue, 'pages', 'PG_001_001', 'renders', 'PG_001_001_V01.png'));
    assert.match(buildBoard(w.issue, { write: false, checkContinuity: null }).html, /PG_001_001_V01<br><span>file not found<\/span>/);
  }

  // --- ledger section when a checker exists ------------------------------------------------------
  {
    const w = workspace();
    const calls = [];
    const checker = (root, opts) => {
      calls.push([root, opts]);
      return {
        findings: [
          { code: 'custody', severity: 'error', issue: 'ISS_001', page: 'PG_001_002', panel: 'PN_001_002_02', entity: 'PROP_FLARE_GUN', message: 'PROP_FLARE_GUN changes hands without a <transfer>.' },
          { code: 'level', severity: 'warning', issue: 'ISS_001', page: 'PG_001_002', panel: 'PN_001_002_01', entity: 'CHAR_MARA', message: 'CHAR_MARA changes level.' },
          { code: 'chain', severity: 'error', issue: 'ISS_001', page: null, panel: null, entity: null, message: 'The page chain is broken.' },
          { code: 'other', severity: 'error', issue: 'ISS_002', page: 'PG_002_001', panel: null, entity: null, message: 'Belongs to another issue.' },
        ],
      };
    };
    const result = buildBoard(w.issue, { write: false, checkContinuity: checker });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(path.relative(calls[0][0], w.root), '');
    assert.deepStrictEqual(calls[0][1], { issue: 'ISS_001' });
    assert.strictEqual(result.ledger, true);
    const html = result.html;
    assert.match(html, /<h2 class="band">Panel ledger<\/h2>/);
    assert.match(html, /<span class="badge bad">3 findings<\/span> 2 errors, 1 warning\./);
    assert.match(html, /<li><span class="badge bad">error<\/span> The page chain is broken\.<\/li>/, 'findings without a page are listed at the top');
    const page2 = /<section class="page" id="PG_001_002">[\s\S]*?<\/section>/.exec(html)[0];
    assert.match(page2, /<li><span class="badge bad">error<\/span> <b>PN_001_002_02<\/b> PROP_FLARE_GUN changes hands without a &lt;transfer&gt;\.<\/li>/);
    assert.match(page2, /<li><span class="badge warn">warning<\/span> <b>PN_001_002_01<\/b> CHAR_MARA changes level\.<\/li>/);
    const page1 = /<section class="page" id="PG_001_001">[\s\S]*?<\/section>/.exec(html)[0];
    assert.match(page1, /No ledger findings on this page\./);
    assert.ok(!/Belongs to another issue/.test(html));

    const clean = buildBoard(w.issue, { write: false, checkContinuity: () => ({ findings: [] }) });
    assert.match(clean.html, /<span class="badge good">clean<\/span> The ledger check found nothing in ISS_001\./);

    // A checker that throws never breaks the board.
    const broken = buildBoard(w.issue, { write: false, checkContinuity: () => { throw new Error('boom'); } });
    assert.strictEqual(broken.ledger, false);
    assert.ok(broken.warnings.some((x) => /ledger check failed: boom/.test(x)));
    assert.ok(!/Panel ledger/.test(broken.html));
    assert.ok(broken.html.includes('PG_001_003'));

    // Default: uses scripts/check-continuity.js when it exports checkContinuity, and survives either way.
    const auto = buildBoard(w.issue, { write: false });
    for (const id of ['PG_001_001', 'PG_001_002', 'PG_001_003']) assert.ok(auto.html.includes(id));
  }

  // --- schematic helpers -----------------------------------------------------------------------------
  {
    const page = {
      id: 'PG_001_009',
      layout: { tiers: [2, 1] },
      panels: [
        { id: 'c', order: 3, size: 'wide' },
        { id: 'a', order: 1, size: 'small' },
        { id: 'b', order: 2, size: 'large' },
      ],
    };
    assert.deepStrictEqual(panelsByTier(page).map((tier) => tier.map((p) => p.id)), [['a', 'b'], ['c']], 'tiers filled in reading order');
    const explicit = { panels: [{ id: 'x', order: 1, tier: 2 }, { id: 'y', order: 2, tier: 1 }] };
    assert.deepStrictEqual(panelsByTier(explicit).map((tier) => tier.map((p) => p.id)), [['y'], ['x']], 'explicit tier numbers win');
    assert.deepStrictEqual(panelsByTier({ panels: [] }), []);

    const ltr = tierSchematic(page, { reading_direction: 'ltr' });
    const rtl = tierSchematic(page, { reading_direction: 'rtl' });
    const firstLabel = (svg) => /<text [^>]*>(\d)<\/text>/.exec(svg)[1];
    const xOf = (svg, n) => Number(new RegExp(`<text x="([\\d.]+)"[^>]*>${n}</text>`).exec(svg)[1]);
    assert.strictEqual(firstLabel(ltr), '1');
    assert.ok(xOf(ltr, 1) < xOf(ltr, 2), 'ltr: panel 1 on the left');
    assert.ok(xOf(rtl, 1) > xOf(rtl, 2), 'rtl: panel 1 on the right');
    assert.match(tierSchematic({ panels: [] }, {}), /No panels planned/);
  }

  // --- CLI and bad input -----------------------------------------------------------------------------
  {
    const w = workspace();
    const out = path.join(w.root, 'board.html');
    const cli = spawnSync(process.execPath, [SCRIPT, '--issue', w.issue, '--out', out], { encoding: 'utf8' });
    assert.strictEqual(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /build-board: wrote /);
    assert.match(cli.stdout, /ISS_001: 3 pages/);
    const html = fs.readFileSync(out, 'utf8');
    for (const id of ['PG_001_001', 'PG_001_002', 'PG_001_003']) assert.ok(html.includes(id), `${id} on the board`);

    assert.strictEqual(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 1);
    assert.strictEqual(spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' }).status, 0);
    assert.throws(() => buildBoard(path.join(w.root, 'issues', 'ISS_009')), /issue directory not found/);
    assert.throws(() => buildBoard(path.join(w.root, 'editions')), /not an issue directory/);

    // A page directory without page.yaml still gets a section.
    fs.mkdirSync(path.join(w.issue, 'pages', 'PG_001_004'));
    const partial = buildBoard(w.issue, { write: false, checkContinuity: null });
    assert.match(partial.html, /<section class="page" id="PG_001_004"><h2>PG_001_004 <span class="badge bad">no page\.yaml<\/span>/);
  }

  console.log('build-board: OK');
} finally {
  roots.forEach(cleanup);
}
