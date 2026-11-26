'use strict';
/**
 * scripts/lib/schema.js: validates good documents, rejects bad ones, and,
 * when the schemas/ and templates/ layers hold files, validates the repo
 * templates against their schemas. Missing layers are skipped gracefully;
 * scripts/validate.js is the hard gate for those.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const schemaLib = require('../scripts/lib/schema');
const yaml = require('../scripts/lib/yaml');

// --- a schema exercising every supported keyword -----------------------------

const panelSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['id', 'page', 'order', 'framing'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: '^PN_\\d{3}_\\d{3}_\\d{2}$' },
    page: { type: 'string', pattern: '^PG_\\d{3}_\\d{3}$' },
    order: { type: 'integer', minimum: 1, maximum: 99 },
    width_ratio: { type: 'number', minimum: 0.1, maximum: 1 },
    ellipsis: { type: ['string', 'null'] },
    facing: { enum: ['left', 'right', 'toward_reader', 'away_from_reader'] },
    status: { $ref: '#/$defs/status' },
    moment: { type: 'string', minLength: 1, format: 'free-text' },
    cast: { type: 'array', items: { $ref: '#/$defs/castRow' } },
    size: {
      oneOf: [
        { type: 'string' },
        { type: 'object', required: ['tier'], properties: { tier: { type: 'integer' } } },
      ],
    },
    framing: {
      anyOf: [
        { type: 'object', required: ['shot_size'], properties: { shot_size: { type: 'string' } }, additionalProperties: true },
        { type: 'string' },
      ],
    },
  },
  $defs: {
    status: { enum: ['draft', 'review', 'approved'] },
    castRow: {
      type: 'object',
      required: ['character'],
      properties: { character: { type: 'string' }, wardrobe: { type: ['string', 'null'] } },
      additionalProperties: false,
    },
  },
};

const goodPanel = {
  id: 'PN_001_002_03',
  page: 'PG_001_002',
  order: 3,
  width_ratio: 0.5,
  ellipsis: 'Mara climbs down the ladder.',
  facing: 'left',
  status: 'review',
  moment: 'Mara lifts the tarpaulin and finds the boy.',
  cast: [{ character: 'CHAR_MARA', wardrobe: 'WARD_MARA_OILSKIN' }],
  size: { tier: 2 },
  framing: { shot_size: 'medium', angle: 'low_angle' },
};
const good = schemaLib.validate(panelSchema, goodPanel);
assert.ok(good.valid, `good doc should validate: ${JSON.stringify(good.errors)}`);

const badPanel = {
  id: 'panel-3',                    // pattern violation
  page: 'PG_001_002',
  order: 0,                         // minimum violation
  width_ratio: 4,                   // maximum violation
  facing: 'up',                     // enum violation
  status: 'final',                  // $ref enum violation
  moment: '',                       // minLength violation
  cast: [{ wardrobe: 'W1' }],       // items: required character missing
  size: 42,                         // oneOf: no branch matches
  framing: { angle: 'dutch' },      // anyOf: no branch matches
  extra_field: true,                // additionalProperties: false
};
const bad = schemaLib.validate(panelSchema, badPanel);
assert.ok(!bad.valid, 'bad doc must fail');
const messages = bad.errors.map((e) => `${e.path} ${e.message}`).join('\n');
for (const needle of ['pattern', 'minimum', 'maximum', 'enum', 'minLength',
  'required property "character"', 'oneOf', 'anyOf', 'additional property "extra_field"']) {
  assert.ok(messages.includes(needle), `expected an error mentioning ${needle}:\n${messages}`);
}
// missing required "framing" when absent entirely
const missing = schemaLib.validate(panelSchema, { id: 'PN_001_001_01', page: 'PG_001_001', order: 1 });
assert.ok(!missing.valid && JSON.stringify(missing.errors).includes('framing'));

// type arrays + integer distinction
assert.ok(!schemaLib.validate({ type: 'integer' }, 1.5).valid);
assert.ok(schemaLib.validate({ type: 'integer' }, 2).valid);
assert.ok(schemaLib.validate({ type: ['string', 'null'] }, null).valid);

// patternProperties: matching keys are not "additional" and are validated
const patternSchema = {
  type: 'object',
  additionalProperties: false,
  patternProperties: { '^[a-z][a-z0-9_]*$': { type: 'string', minLength: 1 } },
};
assert.ok(schemaLib.validate(patternSchema, { mara: 'at_crates' }).valid);
assert.ok(!schemaLib.validate(patternSchema, { mara: '' }).valid, 'pattern value schema must apply');
assert.ok(!schemaLib.validate(patternSchema, { MARA: 'x' }).valid, 'non-matching key is additional');

// schema document sanity checker
assert.ok(schemaLib.checkSchemaDocument(panelSchema).valid);
assert.ok(!schemaLib.checkSchemaDocument({ $ref: '#/$defs/nope' }).valid, 'unresolvable ref must be flagged');
assert.ok(!schemaLib.checkSchemaDocument({ pattern: '([' }).valid, 'bad regex must be flagged');

// --- template -> schema mapping ----------------------------------------------

const { templateSchemaName, SCHEMA_ID_BASE, SCHEMA_NAMES } = require('../scripts/validate');

// template basename = schema name, with two aliases and two schema-less kinds
assert.strictEqual(SCHEMA_NAMES.length, 18);
assert.strictEqual(templateSchemaName('page/page.yaml'), 'page');
assert.strictEqual(templateSchemaName('location/map.yaml'), 'location-map');
assert.strictEqual(templateSchemaName('continuity/final-state.yaml'), 'continuity-state');
assert.strictEqual(templateSchemaName('review/visual-review.yaml'), 'visual-review');
assert.strictEqual(templateSchemaName('references/manifest.yaml'), null);
assert.strictEqual(templateSchemaName('looks/noir-ink.yaml'), null);
assert.strictEqual(templateSchemaName('looks/page.yaml'), null, 'looks/ presets never map to a schema');
assert.strictEqual(templateSchemaName('page/unknown.yaml'), null);

// --- repo schemas + templates (skipped gracefully when not written yet) -----

const ROOT = path.resolve(__dirname, '..');
const schemasDir = path.join(ROOT, 'schemas');
const templatesDir = path.join(ROOT, 'templates');
const schemaFiles = fs.existsSync(schemasDir)
  ? fs.readdirSync(schemasDir).filter((f) => f.endsWith('.schema.json')) : [];
const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name))
    : (/\.ya?ml$/i.test(e.name) ? [path.join(dir, e.name)] : []));
const templateFiles = walk(templatesDir);

if (schemaFiles.length && templateFiles.length) {
  const schemas = {};
  for (const f of schemaFiles) {
    const doc = JSON.parse(fs.readFileSync(path.join(schemasDir, f), 'utf8'));
    const check = schemaLib.checkSchemaDocument(doc);
    assert.ok(check.valid, `schemas/${f} not usable: ${check.errors.join('; ')}`);
    if (doc.$id) assert.strictEqual(doc.$id, SCHEMA_ID_BASE + f, `schemas/${f}: wrong $id`);
    schemas[f.replace('.schema.json', '')] = doc;
  }
  let checked = 0;
  for (const file of templateFiles) {
    const rel = path.relative(templatesDir, file).split(path.sep).join('/');
    const doc = yaml.parse(fs.readFileSync(file, 'utf8'));
    const name = templateSchemaName(rel);
    if (!name || !schemas[name]) continue;
    const result = schemaLib.validate(schemas[name], doc);
    assert.ok(result.valid,
      `template ${rel} violates ${name} schema: ${JSON.stringify(result.errors.slice(0, 3))}`);
    checked++;
  }
  console.log(`schema-validator: OK (${checked} template(s) validated against repo schemas)`);
} else {
  console.log('schema-validator: OK (repo schemas/templates not written yet, skipped that part)');
}
