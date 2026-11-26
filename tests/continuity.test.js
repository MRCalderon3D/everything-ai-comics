'use strict';
/**
 * check-continuity.js: the eleven ledger rules of docs/data-model.md.
 * Each rule gets a clean workspace broken in exactly one place and must
 * surface its own code; the untouched workspace must surface nothing.
 */

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { checkContinuity, formatFindings, CODES, HINTS } = require('../scripts/check-continuity');
const {
  REPO_ROOT, PAGE_1, PAGE_2, makeWorkspace, sharedWorkspace, castRow, createRunner,
} = require('./fixtures/gates/workspace-helper');

const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-continuity.js');
const t = createRunner('continuity');

const codesOf = (findings) => findings.map((f) => f.code);
const errorsOf = (findings) => findings.filter((f) => f.severity === 'error');

const withWorkspace = sharedWorkspace();

/** Break a clean workspace with `mutate`, audit it, return the findings. */
function audit(mutate, opts) {
  return withWorkspace(mutate, (w) => checkContinuity(w.root, opts).findings);
}

/** Exactly one finding, with this code, as an error; returns it. */
function only(findings, code) {
  assert.deepStrictEqual(codesOf(findings), [code], `expected only ${code}, got ${JSON.stringify(findings, null, 1)}`);
  assert.strictEqual(findings[0].severity, 'error');
  return findings[0];
}

function clean(findings) {
  assert.deepStrictEqual(findings, [], `expected no findings, got ${JSON.stringify(findings, null, 1)}`);
}

// --- the clean workspace -------------------------------------------------------

t.test('clean workspace has no findings', () => {
  clean(audit());
});

t.test('findings carry the contract fields and a hint exists per code', () => {
  const f = audit((w) => w.edit(PAGE_2, (p) => { p.panels[0].transfers = []; }))[0];
  assert.deepStrictEqual(Object.keys(f).sort(),
    ['code', 'entity', 'issue', 'message', 'page', 'panel', 'severity']);
  for (const code of Object.values(CODES)) {
    assert.ok(typeof HINTS[code] === 'string' && HINTS[code].length > 10, `hint for ${code}`);
  }
});

// --- rule 1 --------------------------------------------------------------------

t.test('rule 1: a character twice in one cast is DUPLICATE_CAST', () => {
  const f = only(audit((w) => w.edit(PAGE_1, (p) => {
    p.panels[0].cast.push({ ...castRow(p, 0, 'CHAR_MARA') });
  })), 'DUPLICATE_CAST');
  assert.strictEqual(f.entity, 'CHAR_MARA');
  assert.strictEqual(f.panel, 'PN_001_001_01');
  assert.strictEqual(f.page, 'PG_001_001');
  assert.strictEqual(f.issue, 'ISS_001');
});

// --- rule 2 --------------------------------------------------------------------

t.test('rule 2: a prop in two hands is DOUBLE_CUSTODY', () => {
  const f = only(audit((w) => w.edit(PAGE_2, (p) => {
    castRow(p, 1, 'CHAR_OSKAR').holding = ['PROP_FLARE_GUN'];
  })), 'DOUBLE_CUSTODY');
  assert.strictEqual(f.entity, 'PROP_FLARE_GUN');
  assert.ok(f.message.includes('CHAR_MARA') && f.message.includes('CHAR_OSKAR'), f.message);
});

t.test('rule 2: a held prop also listed under props is DOUBLE_CUSTODY', () => {
  only(audit((w) => w.edit(PAGE_2, (p) => {
    p.panels[1].props = [{ prop: 'PROP_FLARE_GUN', position: { level: 'deck', side: 'left', landmark: 'crates' } }];
  })), 'DOUBLE_CUSTODY');
});

// --- rule 3 --------------------------------------------------------------------

t.test('rule 3: a holder change with no transfer is CUSTODY_JUMP', () => {
  const f = only(audit((w) => w.edit(PAGE_2, (p) => { p.panels[0].transfers = []; })), 'CUSTODY_JUMP');
  assert.strictEqual(f.entity, 'PROP_FLARE_GUN');
  assert.strictEqual(f.panel, 'PN_001_002_01');
  // The message names what was expected and what the ledger shows, with IDs.
  for (const part of ['PROP_FLARE_GUN', 'PN_001_001_02', 'PN_001_002_01', 'CHAR_MARA', 'expected']) {
    assert.ok(f.message.includes(part), `message should mention ${part}: ${f.message}`);
  }
});

t.test('rule 3: a transfer to someone else does not account for the change', () => {
  const f = only(audit((w) => w.edit(PAGE_2, (p) => {
    p.panels[0].transfers[0].to = 'CHAR_OSKAR';
  })), 'CUSTODY_JUMP');
  assert.ok(f.message.includes('CHAR_OSKAR'), f.message);
});

t.test('rule 3: a transfer in a panel in between accounts for the change', () => {
  clean(audit((w) => {
    // The pickup happens in the last panel of page 1, where the gun has no ledger row.
    w.edit(PAGE_1, (p) => {
      p.panels[1].props = [];
      p.panels[1].transfers = [{ prop: 'PROP_FLARE_GUN', from: null, to: 'CHAR_MARA', how: 'pickup' }];
    });
    w.edit(PAGE_2, (p) => { p.panels[0].transfers = []; });
  }));
});

t.test('rule 3: a declared transfer the ledger never shows is CUSTODY_JUMP', () => {
  const f = only(audit((w) => w.edit(PAGE_1, (p) => {
    // Panel 1 says Oskar takes the gun; panel 2 still has it on the shelf.
    p.panels[0].transfers = [{ prop: 'PROP_FLARE_GUN', from: null, to: 'CHAR_OSKAR', how: 'take' }];
  })), 'CUSTODY_JUMP');
  assert.strictEqual(f.panel, 'PN_001_001_02');
});

// --- rule 4 --------------------------------------------------------------------

t.test('rule 4: a level change with no moved and no ellipsis is POSITION_JUMP', () => {
  const f = only(audit((w) => w.edit(PAGE_2, (p) => {
    castRow(p, 0, 'CHAR_MARA').moved = null;
  })), 'POSITION_JUMP');
  assert.strictEqual(f.entity, 'CHAR_MARA');
  assert.ok(f.message.includes('wheelhouse') && f.message.includes('deck'), f.message);
});

t.test('rule 4: the panel ellipsis accounts for a level change', () => {
  clean(audit((w) => w.edit(PAGE_2, (p) => {
    castRow(p, 0, 'CHAR_MARA').moved = null;
    p.panels[0].ellipsis = 'Mara climbs down the ladder.';
  })));
});

t.test('rule 4: a level change across scenes is not a jump', () => {
  clean(audit((w) => {
    w.edit(PAGE_2, (p) => {
      p.scene = 'SC_001_02';
      castRow(p, 0, 'CHAR_MARA').moved = null;
    });
  }));
});

// --- rule 5 --------------------------------------------------------------------

t.test('rule 5: a state tag that vanishes is STATE_DROPPED', () => {
  const f = only(audit((w) => w.edit(PAGE_2, (p) => {
    castRow(p, 1, 'CHAR_OSKAR').state = [];
  })), 'STATE_DROPPED');
  assert.strictEqual(f.entity, 'CHAR_OSKAR');
  assert.strictEqual(f.panel, 'PN_001_002_02');
  assert.ok(f.message.includes('cut_left_hand'), f.message);
});

t.test('rule 5: state_changes.resolves accounts for a dropped tag', () => {
  clean(audit((w) => w.edit(PAGE_2, (p) => {
    const row = castRow(p, 1, 'CHAR_OSKAR');
    row.state = [];
    row.state_changes = { adds: [], resolves: ['cut_left_hand'] };
  })));
});

t.test('rule 5: off-panel rows carry state too', () => {
  const f = only(audit((w) => w.edit(PAGE_2, (p) => {
    const row = castRow(p, 0, 'CHAR_OSKAR');
    assert.strictEqual(row.off_panel, true, 'fixture: Oskar is off-panel in PN_001_002_01');
    row.state = [];
  })), 'STATE_DROPPED');
  assert.strictEqual(f.panel, 'PN_001_002_01');
});

// --- rule 6 --------------------------------------------------------------------

t.test('rule 6: a wardrobe change with no reason is WARDROBE_JUMP', () => {
  const f = only(audit((w) => w.edit(PAGE_2, (p) => {
    castRow(p, 1, 'CHAR_MARA').wardrobe = 'WARD_MARA_JUMPER';
  })), 'WARDROBE_JUMP');
  assert.strictEqual(f.entity, 'CHAR_MARA');
  assert.ok(f.message.includes('WARD_MARA_OILSKIN') && f.message.includes('WARD_MARA_JUMPER'), f.message);
});

t.test('rule 6: wardrobe_change accounts for it', () => {
  clean(audit((w) => w.edit(PAGE_2, (p) => {
    const row = castRow(p, 1, 'CHAR_MARA');
    row.wardrobe = 'WARD_MARA_JUMPER';
    row.wardrobe_change = 'Shrugs the wet coat off before lifting the tarpaulin.';
  })));
});

// --- rule 7 --------------------------------------------------------------------

t.test('rule 7: carrying someone while holding a prop is HANDS_OVERLOAD', () => {
  const f = only(audit((w) => w.edit(PAGE_2, (p) => {
    castRow(p, 1, 'CHAR_MARA').carrying = 'CHAR_OSKAR';
  })), 'HANDS_OVERLOAD');
  assert.strictEqual(f.entity, 'CHAR_MARA');
  assert.ok(f.message.includes('3 hands'), f.message);
});

t.test('rule 7: a two-handed prop plus a one-handed prop is HANDS_OVERLOAD', () => {
  const findings = audit((w) => {
    w.write('props/PROP_BOAT_HOOK/prop.yaml', {
      id: 'PROP_BOAT_HOOK',
      name: 'Boat hook',
      description: { summary: 'Two-metre boat hook.' },
      hands_required: 2,
      references: [],
    });
    w.edit(PAGE_1, (p) => {
      castRow(p, 0, 'CHAR_MARA').holding = ['PROP_BOAT_HOOK'];
      castRow(p, 1, 'CHAR_MARA').holding = ['PROP_BOAT_HOOK'];
    });
    w.edit(PAGE_2, (p) => {
      castRow(p, 0, 'CHAR_MARA').holding = ['PROP_FLARE_GUN', 'PROP_BOAT_HOOK'];
      castRow(p, 1, 'CHAR_MARA').holding = ['PROP_FLARE_GUN', 'PROP_BOAT_HOOK'];
    });
  });
  assert.deepStrictEqual(codesOf(findings), ['HANDS_OVERLOAD', 'HANDS_OVERLOAD'], JSON.stringify(findings, null, 1));
});

// --- rule 8 --------------------------------------------------------------------

t.test('rule 8: a speaker with no cast row is SPEAKER_ABSENT', () => {
  const f = only(audit((w) => w.edit(PAGE_2, (p) => {
    p.panels[1].cast = p.panels[1].cast.filter((row) => row.character !== 'CHAR_OSKAR');
  })), 'SPEAKER_ABSENT');
  assert.strictEqual(f.entity, 'CHAR_OSKAR');
  assert.ok(f.message.includes('L02'), f.message);
});

t.test('rule 8: an off-panel row is enough for a speaker', () => {
  clean(audit((w) => w.edit(PAGE_2, (p) => {
    castRow(p, 1, 'CHAR_OSKAR').off_panel = true;
  })));
});

// --- rule 9 --------------------------------------------------------------------

t.test('rule 9: reading_order that is not a permutation is LAYOUT_MISMATCH', () => {
  const f = only(audit((w) => w.edit(PAGE_1, (p) => { p.layout.reading_order = [1, 3]; })), 'LAYOUT_MISMATCH');
  assert.strictEqual(f.page, 'PG_001_001');
});

t.test('rule 9: tiers that do not sum to the panel count is LAYOUT_MISMATCH', () => {
  only(audit((w) => w.edit(PAGE_1, (p) => { p.layout.tiers = [1, 2]; })), 'LAYOUT_MISMATCH');
});

t.test('rule 9: duplicate lettering order on a page is LAYOUT_MISMATCH', () => {
  const f = only(audit((w) => w.edit(PAGE_2, (p) => { p.panels[1].lettering[1].order = 1; })), 'LAYOUT_MISMATCH');
  assert.strictEqual(f.entity, 'L02');
});

// --- rule 10 -------------------------------------------------------------------

t.test('rule 10: a page that does not exit to the next one is PAGE_CHAIN', () => {
  const f = only(audit((w) => w.edit(PAGE_1, (p) => { p.continuity.exits_to = null; })), 'PAGE_CHAIN');
  assert.strictEqual(f.page, 'PG_001_001');
  assert.ok(f.message.includes('PG_001_002'), f.message);
});

t.test('rule 10: a page that enters from the wrong page is PAGE_CHAIN', () => {
  only(audit((w) => w.edit(PAGE_2, (p) => { p.continuity.enters_from = 'PG_001_009'; })), 'PAGE_CHAIN');
});

// --- rule 11 -------------------------------------------------------------------

t.test('rule 11: an unknown character is UNKNOWN_REFERENCE (error)', () => {
  const f = only(audit((w) => w.edit(PAGE_1, (p) => {
    p.panels[0].cast.push({
      character: 'CHAR_GHOST',
      position: { level: 'deck', side: 'left', landmark: null },
      action: 'Stands at the bow.',
      wardrobe: 'WARD_GHOST_COAT',
      state: [],
    });
  })), 'UNKNOWN_REFERENCE');
  assert.strictEqual(f.entity, 'CHAR_GHOST');
});

t.test('rule 11: an unknown prop is UNKNOWN_REFERENCE (error)', () => {
  const findings = audit((w) => w.edit(PAGE_1, (p) => {
    p.panels[0].props.push({ prop: 'PROP_LANTERN', position: { level: 'deck', side: 'left', landmark: null } });
    p.panels[1].props.push({ prop: 'PROP_LANTERN', position: { level: 'deck', side: 'left', landmark: null } });
  }));
  assert.deepStrictEqual(codesOf(findings), ['UNKNOWN_REFERENCE', 'UNKNOWN_REFERENCE']);
  assert.ok(findings.every((f) => f.severity === 'error' && f.entity === 'PROP_LANTERN'));
});

t.test('rule 11: an unknown location is UNKNOWN_REFERENCE (error)', () => {
  const f = only(audit((w) => w.edit(PAGE_1, (p) => { p.panels[0].location = 'LOC_EAST_DOCK'; })), 'UNKNOWN_REFERENCE');
  assert.strictEqual(f.entity, 'LOC_EAST_DOCK');
});

t.test('rule 11: an unknown wardrobe is UNKNOWN_REFERENCE (error)', () => {
  const findings = audit((w) => w.edit(PAGE_2, (p) => {
    const row = castRow(p, 1, 'CHAR_OSKAR');
    row.wardrobe = 'WARD_OSKAR_RAINCOAT';
    row.wardrobe_change = 'Borrowed coat.';
  }));
  const f = only(findings, 'UNKNOWN_REFERENCE');
  assert.strictEqual(f.entity, 'WARD_OSKAR_RAINCOAT');
});

t.test('rule 11: an unknown level is UNKNOWN_REFERENCE (error)', () => {
  const findings = audit((w) => w.edit(PAGE_1, (p) => {
    castRow(p, 0, 'CHAR_MARA').position.level = 'bridge';
    castRow(p, 1, 'CHAR_MARA').position.level = 'bridge';
  }));
  const unknown = findings.filter((f) => f.code === 'UNKNOWN_REFERENCE');
  assert.strictEqual(unknown.length, 2, JSON.stringify(findings, null, 1));
  assert.ok(unknown.every((f) => f.severity === 'error' && f.message.includes('bridge')));
});

t.test('rule 11: an unknown landmark is UNKNOWN_REFERENCE (error)', () => {
  const f = only(audit((w) => w.edit(PAGE_2, (p) => {
    castRow(p, 1, 'CHAR_MARA').position.landmark = 'winch';
  })), 'UNKNOWN_REFERENCE');
  assert.ok(f.message.includes('winch') && f.message.includes('crates'), f.message);
});

t.test('rule 11: levels of a location with no map are a warning, not an error', () => {
  const findings = audit((w) => w.remove('locations/LOC_FERRY_DECK/map.yaml'));
  assert.ok(findings.length >= 1, 'expected at least one warning');
  assert.deepStrictEqual(errorsOf(findings), []);
  assert.ok(findings.every((f) => f.code === 'UNKNOWN_REFERENCE' && f.severity === 'warning'));
  // One warning per page, not one per row.
  assert.deepStrictEqual(findings.map((f) => f.page), ['PG_001_001', 'PG_001_002']);
});

// --- opens_from seeding --------------------------------------------------------

function seedState(w, state) {
  w.write('continuity/ISS_000.final-state.yaml', {
    issue: 'ISS_000',
    after_page: 'PG_000_012',
    last_validated: '2026-11-26',
    ...state,
  });
  w.edit('issues/ISS_001/issue.yaml', (issue) => { issue.opens_from = 'continuity/ISS_000.final-state.yaml'; });
}

t.test('opens_from: the first page is checked against the previous issue\'s end state', () => {
  const findings = audit((w) => seedState(w, {
    characters: {
      CHAR_OSKAR: {
        location: 'LOC_FERRY_DECK',
        position: { level: 'deck', side: 'left', landmark: 'crates' },
        wardrobe: 'WARD_OSKAR_HOODED',
        state: ['cut_left_hand', 'soaked'],
        holding: ['PROP_FLARE_GUN'],
      },
    },
    props: { PROP_FLARE_GUN: { custody: 'CHAR_OSKAR', location: 'LOC_FERRY_DECK', state: [] } },
  }));
  assert.deepStrictEqual(codesOf(findings).sort(), ['CUSTODY_JUMP', 'STATE_DROPPED'], JSON.stringify(findings, null, 1));
  const custody = findings.find((f) => f.code === 'CUSTODY_JUMP');
  assert.strictEqual(custody.panel, 'PN_001_001_01');
  assert.ok(custody.message.includes('ISS_000'), custody.message);
  const state = findings.find((f) => f.code === 'STATE_DROPPED');
  assert.strictEqual(state.entity, 'CHAR_OSKAR');
  assert.ok(state.message.includes('soaked') && state.message.includes('ISS_000'), state.message);
});

t.test('opens_from: a matching end state adds no findings', () => {
  clean(audit((w) => seedState(w, {
    characters: {
      CHAR_OSKAR: {
        location: 'LOC_FERRY_DECK',
        position: { level: 'deck', side: 'left', landmark: 'crates' },
        wardrobe: 'WARD_OSKAR_HOODED',
        state: ['cut_left_hand'],
        holding: [],
      },
      // Another level and another outfit: an issue boundary is not "the same scene".
      CHAR_MARA: {
        location: 'LOC_FERRY_DECK',
        position: { level: 'deck', side: 'left', landmark: null },
        wardrobe: 'WARD_MARA_JUMPER',
        state: [],
        holding: [],
      },
    },
    props: { PROP_FLARE_GUN: { custody: null, location: 'LOC_FERRY_DECK', state: [] } },
  })));
});

t.test('opens_from: a missing state file is UNKNOWN_REFERENCE', () => {
  const f = only(audit((w) => w.edit('issues/ISS_001/issue.yaml', (issue) => {
    issue.opens_from = 'continuity/ISS_000.final-state.yaml';
  })), 'UNKNOWN_REFERENCE');
  assert.strictEqual(f.page, null);
});

// --- scope, robustness, CLI ----------------------------------------------------

t.test('--issue limits the audit; an unknown issue is reported, not thrown', () => {
  clean(audit(null, { issue: 'ISS_001' }));
  const f = only(audit(null, { issue: 'ISS_009' }), 'UNKNOWN_REFERENCE');
  assert.strictEqual(f.issue, 'ISS_009');
});

t.test('a page.yaml that does not parse is UNREADABLE_FILE, never a throw', () => {
  const findings = audit((w) => w.writeText(PAGE_2, 'id: PG_001_002\n  panels: [oops\n'));
  assert.ok(codesOf(findings).includes('UNREADABLE_FILE'), JSON.stringify(findings, null, 1));
  assert.doesNotThrow(() => checkContinuity(path.join(REPO_ROOT, 'no-such-workspace')));
  assert.deepStrictEqual(checkContinuity(path.join(REPO_ROOT, 'no-such-workspace')).findings, []);
});

t.test('malformed ledger shapes are tolerated', () => {
  const w = makeWorkspace();
  w.edit(PAGE_1, (p) => {
    p.panels[0].cast = 'nobody';
    p.panels[0].props = [null, 7, {}];
    p.panels[1].transfers = [{ how: 'pickup' }];
    p.panels[1].lettering = { id: 'L02' };
    delete p.layout;
  });
  assert.doesNotThrow(() => checkContinuity(w.root));
});

t.test('human report groups by page and prints a fix hint per finding', () => {
  const findings = audit((w) => w.edit(PAGE_2, (p) => { p.panels[0].transfers = []; }));
  const lines = formatFindings(findings);
  assert.strictEqual(lines[0], 'ISS_001');
  assert.strictEqual(lines[1].trim(), 'PG_001_002');
  assert.ok(lines[2].includes('PN_001_002_01') && lines[2].includes('[CUSTODY_JUMP]'), lines[2]);
  assert.ok(lines[3].trim().startsWith('fix: '), lines[3]);
});

t.test('CLI: exit 0 and [] when clean; exit 1 and the findings when not', () => {
  const w = makeWorkspace('production-night-ferry');
  let res = spawnSync(process.execPath, [SCRIPT, '--root', w.root, '--json'], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.deepStrictEqual(JSON.parse(res.stdout), []);

  w.edit(PAGE_2, (p) => { castRow(p, 1, 'CHAR_OSKAR').state = []; });
  res = spawnSync(process.execPath, [SCRIPT, '--root', w.root, '--json'], { encoding: 'utf8' });
  assert.strictEqual(res.status, 1);
  assert.deepStrictEqual(JSON.parse(res.stdout).map((f) => f.code), ['STATE_DROPPED']);

  res = spawnSync(process.execPath, [SCRIPT, '--root', w.root, '--issue', 'ISS_001'], { encoding: 'utf8' });
  assert.strictEqual(res.status, 1);
  assert.ok(res.stdout.includes('PN_001_002_02') && res.stdout.includes('fix: '), res.stdout);
  assert.ok(res.stdout.includes('does not review the drawn pages'), res.stdout);

  // A warning alone does not fail the run.
  const warned = makeWorkspace();
  warned.remove('locations/LOC_FERRY_DECK/map.yaml');
  res = spawnSync(process.execPath, [SCRIPT, '--root', warned.root], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stdout);

  res = spawnSync(process.execPath, [SCRIPT, '--root', w.base], { encoding: 'utf8' });
  assert.strictEqual(res.status, 1, 'a directory outside any workspace is a usage error');
});

t.finish();
