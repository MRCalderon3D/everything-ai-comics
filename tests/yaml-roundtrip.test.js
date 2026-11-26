'use strict';
/** scripts/lib/yaml.js: parse the supported subset, round-trip losslessly. */

const assert = require('assert');
const yaml = require('../scripts/lib/yaml');

// --- parsing the subset -----------------------------------------------------

const doc = yaml.parse(`
---
# a project-ish document
id: SC_001_01         # trailing comment
title: "The Long: Night"
ratio: 2:3
page_count: 6
weight: 2.5
approved: true
draft: false
empty: null
tilde: ~
quoted_single: 'it''s fine'
tags: [noir, "river ferry", 3]
inline_map: {a: 1, b: right}
nested:
  level2:
    deep: value
  list_under_key:
    - one
    - two
same_indent_list:
- alpha
- beta
panels:
  - id: PN_001_001_01
    order: 1
    framing:
      shot_size: extreme_wide
  - id: PN_001_001_02
    order: 2
block_literal: |
  line one
  line two
block_folded: >-
  folded into
  one line
`);

assert.strictEqual(doc.id, 'SC_001_01');
assert.strictEqual(doc.title, 'The Long: Night');
assert.strictEqual(doc.ratio, '2:3', '2:3 must stay a string');
assert.strictEqual(doc.page_count, 6);
assert.strictEqual(doc.weight, 2.5);
assert.strictEqual(doc.approved, true);
assert.strictEqual(doc.draft, false);
assert.strictEqual(doc.empty, null);
assert.strictEqual(doc.tilde, null);
assert.strictEqual(doc.quoted_single, "it's fine");
assert.deepStrictEqual(doc.tags, ['noir', 'river ferry', 3]);
assert.deepStrictEqual(doc.inline_map, { a: 1, b: 'right' });
assert.strictEqual(doc.nested.level2.deep, 'value');
assert.deepStrictEqual(doc.nested.list_under_key, ['one', 'two']);
assert.deepStrictEqual(doc.same_indent_list, ['alpha', 'beta']);
assert.strictEqual(doc.panels.length, 2);
assert.strictEqual(doc.panels[0].id, 'PN_001_001_01');
assert.strictEqual(doc.panels[0].framing.shot_size, 'extreme_wide');
assert.strictEqual(doc.panels[1].order, 2);
assert.strictEqual(doc.block_literal, 'line one\nline two\n');
assert.strictEqual(doc.block_folded, 'folded into one line');

// comments inside quoted strings survive
assert.strictEqual(yaml.parse('k: "a # not a comment"').k, 'a # not a comment');

// top-level list documents
assert.deepStrictEqual(yaml.parse('- 1\n- 2\n'), [1, 2]);

// empty / comment-only documents
assert.strictEqual(yaml.parse(''), null);
assert.strictEqual(yaml.parse('# only a comment\n'), null);

// errors on unsupported constructs
assert.throws(() => yaml.parse('a: &anchor 1'), /not supported/);
assert.throws(() => yaml.parse('\ta: 1'), /tab indentation/);
assert.throws(() => yaml.parse('a: 1\n---\nb: 2'), /multiple documents/);

// --- round trip --------------------------------------------------------------

const original = {
  id: 'GEN_PG_001_002_01',
  page: 'PG_001_002',
  status: 'dry_run',
  cost_estimate: 2.5,
  panel_count: 4,
  aspect_ratio: '2:3',
  ok: true,
  missing: null,
  weird_string: 'true',          // must stay a string
  numeric_string: '007',         // must stay a string
  colon_string: 'note: keep',
  multiline: 'line one\nline two',
  empty_list: [],
  empty_map: {},
  references: [
    { id: 'CHAR_MARA_TURN_MASTER_V01', role: 'identity', path: 'refs/mara.png' },
    { id: 'LOC_FERRY_DECK_PLATE_MASTER_V01', role: 'spatial_continuity', nested: { priority: 2 } },
  ],
  outputs: ['PG_001_002_V01.png', 'PG_001_002_V02.png'],
  request: {
    model: 'harness-native',
    body: { instances: [{ prompt: 'a river ferry at night — #inked' }] },
  },
};

const text = yaml.stringify(original);
assert.ok(!text.includes('\r'), 'stringify must emit LF only');
assert.ok(text.endsWith('\n'), 'stringify must end with a newline');
const reparsed = yaml.parse(text);
assert.deepStrictEqual(reparsed, original, `round trip mismatch:\n${text}`);

// double round trip is stable (idempotent formatting)
assert.strictEqual(yaml.stringify(yaml.parse(text)), text);

// scalars needing quotes
const tricky = yaml.parse(yaml.stringify({ a: '2:3', b: 'null', c: '- dash', d: '#hash', e: 'yes: no' }));
assert.deepStrictEqual(tricky, { a: '2:3', b: 'null', c: '- dash', d: '#hash', e: 'yes: no' });

console.log('yaml-roundtrip: OK');
