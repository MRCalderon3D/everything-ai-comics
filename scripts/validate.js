#!/usr/bin/env node
'use strict';
/**
 * validate.js — the validation gate (what CI runs).
 *
 * Sections:
 *   1. manifests   parse and match the rosters in docs/conventions.md
 *   2. files       every manifest file entry exists on disk
 *   3. agents      agents/*.md: frontmatter + required sections + skill refs
 *   4. commands    commands/*.md: frontmatter + sections; Invokes Agents /
 *                  Required Skills match commands.json and the rosters
 *   5. skills      skills/<name>/SKILL.md: frontmatter + sections + category
 *   6. rules       rules.json vs the conventions roster vs rules/ on disk
 *   7. contexts    the context files exist and are not empty
 *   8. schemas     parse as usable JSON Schema (draft 2020-12 subset)
 *   9. templates   the fixed template tree exists and validates
 *  10. providers   export the required interface, match the manifest
 *  11. hooks       hooks/hooks.json references existing hook files
 *  12. example     examples/the-night-ferry passes validate-workspace.js
 *  13. harnesses   wrappers match what sync-harnesses.js would emit (drift)
 *
 * Sections degrade gracefully (report, not crash) when a directory is
 * missing. Non-zero exit on any failure.
 *
 * This gate checks structured data and tooling. It never certifies what a
 * rendered page looks like; that is the visual review's job.
 */

const path = require('path');
const { ROOT, exists, readJson, readText, walk, toPosix, listDirs } = require('./lib/fsx');
const {
  loadManifests, entries, ruleLayers, parseConventionsRosters, PROVIDER_KINDS,
} = require('./lib/manifest');
const { createReport } = require('./lib/report');
const { parseFrontmatter, sectionHeadings, sectionBullets } = require('./lib/md');
const schemaLib = require('./lib/schema');
const yaml = require('./lib/yaml');
const { helpIfRequested, parseArgs } = require('./lib/cli');

const HELP = `
validate.js — full validation gate for the scaffold.

Usage:
  node scripts/validate.js [--root <dir>] [--section <name>]

Options:
  --root <dir>      Scaffold root (default: this repository).
  --section <name>  Run a single section (manifests, files, agents, commands,
                    skills, rules, contexts, schemas, templates, providers,
                    hooks, example, harnesses).
  --help            Show this help.

Exit code 0 when everything passes, 1 otherwise.
`;

const SCHEMA_NAMES = [
  'project', 'story-bible', 'series-plan', 'character', 'wardrobe',
  'location', 'location-map', 'prop', 'issue', 'scene', 'page', 'lettering',
  'reference-plan', 'prompt-package', 'continuity-state', 'generation-record',
  'visual-review', 'edition',
];
const SCHEMA_ID_BASE = 'https://everything-ai-comics.dev/schemas/';
const SKILL_ORIGIN = 'everything-ai-comics';

const PROFILE_NAMES = ['full', 'writing-room', 'layout', 'generation', 'publishing'];
const HARNESS_IDS = ['claude', 'codex', 'cursor', 'opencode', 'agents'];
const CONTEXT_NAMES = ['development', 'preproduction', 'production', 'publishing', 'review'];
const HOOK_IDS = ['validate-after-write', 'protect-approved-assets',
  'detect-continuity-drift', 'require-cost-confirmation'];

const AGENT_SECTIONS = ['Role', 'Responsibilities', 'Uses These Skills',
  'Collaborates With', 'Deliverables', 'Activation Guidance'];
const COMMAND_SECTIONS = ['Purpose', 'Use When', 'Inputs', 'Invokes Agents',
  'Required Skills', 'Process', 'Outputs', 'Notes'];
const SKILL_SECTIONS = ['Purpose', 'Use When', 'Inputs', 'Process', 'Outputs',
  'Quality Bar', 'Common Failure Modes', 'Related Agents', 'Related Commands', 'Notes'];
const RULE_SECTIONS = ['Purpose', 'Scope', 'Core Principles', 'Validation'];
const SKILL_CATEGORIES = ['story', 'visual', 'production', 'generation', 'post'];
const RULE_KINDS = ['common', 'domain', 'format'];

/** The fixed template tree (paths relative to templates/). */
const TEMPLATE_FILES = [
  'README.md',
  'project/project.yaml',
  'story/story-bible.yaml', 'story/series-plan.yaml',
  'style/style-bible.md', 'style/style-block.txt', 'style/color-script.md',
  'character/character.yaml', 'character/wardrobe.yaml',
  'location/location.yaml', 'location/map.yaml',
  'prop/prop.yaml',
  'issue/issue.yaml',
  'scene/scene.yaml',
  'page/page.yaml', 'page/lettering.yaml', 'page/reference-plan.yaml',
  'review/visual-review.yaml',
  'continuity/final-state.yaml',
  'edition/edition.yaml',
  'references/manifest.yaml',
  'looks/README.md',
];
/** Template basenames whose schema carries a different name. */
const TEMPLATE_SCHEMA_ALIASES = { map: 'location-map', 'final-state': 'continuity-state' };

const EXAMPLE_DIR = 'examples/the-night-ferry';

function sameSet(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

function setDiff(a, b) {
  const sb = new Set(b);
  return [...new Set(a)].filter((x) => !sb.has(x));
}

/**
 * Schema name for a template file, or null when it has none.
 * rel is relative to templates/ with forward slashes.
 */
function templateSchemaName(rel) {
  const parts = String(rel).split('/');
  if (parts[0] === 'looks') return null;                 // style presets
  const base = parts[parts.length - 1].replace(/\.ya?ml$/i, '');
  if (base === 'manifest') return null;                  // reference registry
  if (TEMPLATE_SCHEMA_ALIASES[base]) return TEMPLATE_SCHEMA_ALIASES[base];
  return SCHEMA_NAMES.includes(base) ? base : null;
}

// ---------------------------------------------------------------------------

function sectionManifests(report, ctx) {
  report.section('Manifests vs rosters (docs/conventions.md)');
  for (const err of ctx.manifestErrors) {
    report.fail(`manifests/${err.file}: ${err.message}`);
  }
  if (!ctx.rosters) {
    report.fail('docs/conventions.md rosters could not be parsed');
    return;
  }
  const pairs = [
    ['agents.json', 'agents', ctx.rosters.agents],
    ['commands.json', 'commands', ctx.rosters.commands],
    ['skills.json', 'skills', ctx.rosters.skills],
  ];
  for (const [file, key, roster] of pairs) {
    const names = entries(ctx.manifests, file, key).map((e) => e.name);
    if (!ctx.manifests[file]) continue; // already reported
    if (report.check(sameSet(names, roster) && names.length === roster.length,
      `manifests/${file}: ${names.length} entries match the ${key} roster (${roster.length})`)) {
      // also verify no duplicates
      if (new Set(names).size !== names.length) report.fail(`manifests/${file}: duplicate names`);
    } else {
      const missing = setDiff(roster, names);
      const extra = setDiff(names, roster);
      if (missing.length) report.info(`missing: ${missing.join(', ')}`);
      if (extra.length) report.info(`extra: ${extra.join(', ')}`);
    }
    const declared = ctx.rosters.counts[key];
    if (declared !== roster.length) {
      report.fail(`docs/conventions.md: ${key} roster declares ${declared} but lists ${roster.length}`);
    }
  }
  if (ctx.manifests['commands.json']) {
    const bad = [];
    for (const c of entries(ctx.manifests, 'commands.json', 'commands')) {
      for (const a of c.agents || []) if (!ctx.rosters.agents.includes(a)) bad.push(`${c.name}: agent ${a}`);
      for (const s of c.skills || []) if (!ctx.rosters.skills.includes(s)) bad.push(`${c.name}: skill ${s}`);
      if (!Array.isArray(c.agents) || !Array.isArray(c.skills)) bad.push(`${c.name}: agents[] and skills[] required`);
    }
    report.check(bad.length === 0,
      bad.length === 0 ? 'manifests/commands.json: agents[] and skills[] use roster names only'
        : `manifests/commands.json: ${bad.join('; ')}`);
  }
  if (ctx.manifests['skills.json']) {
    const bad = entries(ctx.manifests, 'skills.json', 'skills')
      .filter((s) => !SKILL_CATEGORIES.includes(s.category)).map((s) => s.name);
    report.check(bad.length === 0,
      bad.length === 0 ? `manifests/skills.json: categories are ${SKILL_CATEGORIES.join(' | ')}`
        : `manifests/skills.json: bad category on ${bad.join(', ')}`);
  }
  if (ctx.manifests['rules.json']) {
    const layers = ruleLayers(ctx.manifests);
    const names = layers.map((l) => l.name);
    const roster = ctx.rosters.rules.map((l) => l.name);
    report.check(sameSet(names, roster) && names.length === roster.length,
      `manifests/rules.json: layers match the rules roster (${roster.join(', ')})`);
    const total = layers.reduce((n, l) => n + l.rules.length, 0);
    report.check(total === ctx.rosters.counts.rules,
      `manifests/rules.json: ${total} rules (roster declares ${ctx.rosters.counts.rules})`);
  }
  for (const kind of PROVIDER_KINDS) {
    const file = `${kind}-providers.json`;
    if (!ctx.manifests[file]) continue;
    const ids = entries(ctx.manifests, file, 'providers').map((p) => p.id);
    const roster = ctx.rosters.providers[kind] || [];
    if (!report.check(sameSet(ids, roster) && ids.length === roster.length,
      `manifests/${file}: providers match roster (${roster.join(', ')})`)) {
      report.info(`manifest has: ${ids.join(', ')}`);
    }
  }
  if (ctx.manifests['profiles.json']) {
    const profiles = ctx.manifests['profiles.json'].profiles || {};
    report.check(sameSet(Object.keys(profiles), PROFILE_NAMES),
      `manifests/profiles.json: profiles are ${PROFILE_NAMES.join(', ')}`);
    const commandMap = new Map(entries(ctx.manifests, 'commands.json', 'commands').map((c) => [c.name, c]));
    for (const [name, prof] of Object.entries(profiles)) {
      const bad = [];
      for (const c of prof.commands || []) if (!ctx.rosters.commands.includes(c)) bad.push(`command ${c}`);
      for (const a of prof.agents || []) if (!ctx.rosters.agents.includes(a)) bad.push(`agent ${a}`);
      for (const s of prof.skills || []) if (!ctx.rosters.skills.includes(s)) bad.push(`skill ${s}`);
      report.check(bad.length === 0,
        bad.length === 0 ? `profile "${name}" references roster names only`
          : `profile "${name}" references unknown names: ${bad.join(', ')}`);
      // A profile must ship every agent and skill its commands need.
      const lacking = [];
      for (const c of prof.commands || []) {
        const entry = commandMap.get(c);
        if (!entry) continue;
        for (const a of entry.agents || []) if (!(prof.agents || []).includes(a)) lacking.push(`${c} needs agent ${a}`);
        for (const s of entry.skills || []) if (!(prof.skills || []).includes(s)) lacking.push(`${c} needs skill ${s}`);
      }
      report.check(lacking.length === 0,
        lacking.length === 0 ? `profile "${name}" includes what its commands need`
          : `profile "${name}" is incomplete: ${lacking.join('; ')}`);
    }
  }
  if (ctx.manifests['harnesses.json']) {
    const ids = (ctx.manifests['harnesses.json'].harnesses || []).map((h) => h.id);
    report.check(sameSet(ids, HARNESS_IDS),
      `manifests/harnesses.json: harnesses are ${HARNESS_IDS.join(', ')}`);
  }
  // The constants this gate hardcodes must agree with the contract.
  const constants = [
    ['Schemas', SCHEMA_NAMES, ctx.rosters.schemas],
    ['Contexts', CONTEXT_NAMES, ctx.rosters.contexts],
    ['Profiles', PROFILE_NAMES, ctx.rosters.profiles],
    ['Hooks', HOOK_IDS.map((id) => `${id}.js`), ctx.rosters.hooks],
  ];
  for (const [label, mine, roster] of constants) {
    report.check(sameSet(mine, roster),
      sameSet(mine, roster) ? `docs/conventions.md: ${label} roster matches the validation gate`
        : `docs/conventions.md: ${label} roster differs from validate.js ` +
          `(only in conventions: ${setDiff(roster, mine).join(', ') || 'none'}; ` +
          `only in validate.js: ${setDiff(mine, roster).join(', ') || 'none'})`);
  }
}

function sectionFiles(report, ctx) {
  report.section('Manifest file entries exist on disk');
  const lists = [
    ['agents.json', 'agents'], ['commands.json', 'commands'], ['skills.json', 'skills'],
    ...PROVIDER_KINDS.map((kind) => [`${kind}-providers.json`, 'providers']),
  ];
  let missing = 0;
  let total = 0;
  for (const [file, key] of lists) {
    for (const entry of entries(ctx.manifests, file, key)) {
      total++;
      const p = path.join(ctx.root, ...String(entry.file).split('/'));
      if (!exists(p)) {
        missing++;
        report.fail(`${file}: ${entry.name || entry.id} -> ${entry.file} does not exist`);
      }
    }
  }
  if (total === 0) report.fail('no manifest file entries to check (manifests missing?)');
  else if (missing === 0) report.pass(`all ${total} manifest file entries exist`);
}

function checkDocSections(report, label, body, required) {
  const headings = sectionHeadings(body).map((h) => h.toLowerCase());
  const missing = required.filter((s) => !headings.includes(s.toLowerCase()));
  return report.check(missing.length === 0,
    missing.length === 0 ? `${label}: all required sections present`
      : `${label}: missing sections: ${missing.join(', ')}`);
}

function sectionAgents(report, ctx) {
  report.section('agents/*.md');
  if (!exists(path.join(ctx.root, 'agents')) || walk(path.join(ctx.root, 'agents')).length === 0) {
    report.fail('agents/ is missing or empty (not written yet?)');
    return;
  }
  for (const entry of entries(ctx.manifests, 'agents.json', 'agents')) {
    const file = path.join(ctx.root, ...String(entry.file).split('/'));
    if (!exists(file)) continue; // reported in files section
    let parsed;
    try {
      parsed = parseFrontmatter(readText(file));
    } catch (err) {
      report.fail(`${entry.file}: frontmatter error: ${err.message}`);
      continue;
    }
    const fm = parsed.frontmatter;
    if (!fm) { report.fail(`${entry.file}: missing frontmatter`); continue; }
    const fmOk = fm.name === entry.name && typeof fm.description === 'string' &&
      Array.isArray(fm.tools) && typeof fm.model === 'string';
    report.check(fmOk, `${entry.file}: frontmatter valid (name/description/tools/model)` +
      (fmOk ? '' : ` — got name=${fm.name}, tools=${JSON.stringify(fm.tools)}, model=${fm.model}`));
    if (typeof fm.description === 'string' && fm.description !== entry.description) {
      report.fail(`${entry.file}: description differs from agents.json (must be verbatim)`);
    }
    checkDocSections(report, entry.file, parsed.body, AGENT_SECTIONS);
    if (ctx.rosters) {
      const used = sectionBullets(parsed.body, 'Uses These Skills');
      const unknown = used.filter((s) => !ctx.rosters.skills.includes(s));
      report.check(unknown.length === 0,
        unknown.length === 0 ? `${entry.file}: referenced skills exist`
          : `${entry.file}: references unknown skills: ${unknown.join(', ')}`);
      const peers = sectionBullets(parsed.body, 'Collaborates With');
      const strangers = peers.filter((a) => !ctx.rosters.agents.includes(a));
      report.check(strangers.length === 0,
        strangers.length === 0 ? `${entry.file}: referenced agents exist`
          : `${entry.file}: references unknown agents: ${strangers.join(', ')}`);
    }
  }
}

function sectionCommands(report, ctx) {
  report.section('commands/*.md');
  if (!exists(path.join(ctx.root, 'commands')) || walk(path.join(ctx.root, 'commands')).length === 0) {
    report.fail('commands/ is missing or empty (not written yet?)');
    return;
  }
  for (const entry of entries(ctx.manifests, 'commands.json', 'commands')) {
    const file = path.join(ctx.root, ...String(entry.file).split('/'));
    if (!exists(file)) continue;
    let parsed;
    try {
      parsed = parseFrontmatter(readText(file));
    } catch (err) {
      report.fail(`${entry.file}: frontmatter error: ${err.message}`);
      continue;
    }
    if (!parsed.frontmatter || typeof parsed.frontmatter.description !== 'string') {
      report.fail(`${entry.file}: frontmatter must carry a description string`);
    } else if (parsed.frontmatter.description !== entry.description) {
      report.fail(`${entry.file}: description differs from commands.json (must be verbatim)`);
    } else {
      report.pass(`${entry.file}: frontmatter valid`);
    }
    checkDocSections(report, entry.file, parsed.body, COMMAND_SECTIONS);

    const listedAgents = sectionBullets(parsed.body, 'Invokes Agents');
    const listedSkills = sectionBullets(parsed.body, 'Required Skills');
    if (ctx.rosters) {
      const badA = listedAgents.filter((a) => !ctx.rosters.agents.includes(a));
      const badS = listedSkills.filter((s) => !ctx.rosters.skills.includes(s));
      report.check(badA.length === 0 && badS.length === 0,
        badA.length === 0 && badS.length === 0
          ? `${entry.file}: Invokes Agents / Required Skills use roster names only`
          : `${entry.file}: non-roster names: ${[...badA, ...badS].join(', ')}`);
    }
    const missingA = setDiff(entry.agents || [], listedAgents);
    const missingS = setDiff(entry.skills || [], listedSkills);
    report.check(missingA.length === 0 && missingS.length === 0,
      missingA.length === 0 && missingS.length === 0
        ? `${entry.file}: sections cover commands.json agents/skills`
        : `${entry.file}: missing from sections — agents: [${missingA.join(', ')}] skills: [${missingS.join(', ')}]`);
  }
}

function sectionSkills(report, ctx) {
  report.section('skills/*/SKILL.md');
  if (!exists(path.join(ctx.root, 'skills')) || walk(path.join(ctx.root, 'skills')).length === 0) {
    report.fail('skills/ is missing or empty (not written yet?)');
    return;
  }
  for (const entry of entries(ctx.manifests, 'skills.json', 'skills')) {
    const file = path.join(ctx.root, ...String(entry.file).split('/'));
    if (!exists(file)) continue;
    let parsed;
    try {
      parsed = parseFrontmatter(readText(file));
    } catch (err) {
      report.fail(`${entry.file}: frontmatter error: ${err.message}`);
      continue;
    }
    const fm = parsed.frontmatter || {};
    const fmOk = fm.name === entry.name && typeof fm.description === 'string' &&
      fm.origin === SKILL_ORIGIN && SKILL_CATEGORIES.includes(fm.category);
    report.check(fmOk, `${entry.file}: frontmatter valid (name/description/origin/category)` +
      (fmOk ? '' : ` — got name=${fm.name}, origin=${fm.origin}, category=${fm.category}`));
    if (typeof fm.description === 'string' && fm.description !== entry.description) {
      report.fail(`${entry.file}: description differs from skills.json (must be verbatim)`);
    }
    if (fm.category && entry.category && fm.category !== entry.category) {
      report.fail(`${entry.file}: category ${fm.category} != manifest category ${entry.category}`);
    }
    checkDocSections(report, entry.file, parsed.body, SKILL_SECTIONS);
  }
  const extra = setDiff(listDirs(path.join(ctx.root, 'skills')),
    entries(ctx.manifests, 'skills.json', 'skills').map((s) => s.name));
  if (extra.length) report.fail(`skills/ has directories outside the roster: ${extra.join(', ')}`);
}

function sectionRules(report, ctx) {
  report.section('rules/ vs rules.json vs the conventions roster');
  const layers = ruleLayers(ctx.manifests);
  if (!ctx.manifests['rules.json']) {
    report.fail('manifests/rules.json is missing or invalid');
  } else if (!ctx.rosters) {
    report.fail('docs/conventions.md rosters could not be parsed');
  } else {
    const roster = ctx.rosters.rules;
    const names = layers.map((l) => l.name);
    report.check(sameSet(names, roster.map((l) => l.name)) && names.length === roster.length,
      `rules.json: ${names.length} layers match the roster (${roster.map((l) => l.name).join(', ')})`);
    for (const layer of layers) {
      const want = roster.find((l) => l.name === layer.name);
      if (!want) continue; // reported above
      const kindOk = RULE_KINDS.includes(layer.kind) && layer.kind === want.kind;
      const rulesOk = sameSet(layer.rules, want.rules) && layer.rules.length === want.rules.length;
      report.check(kindOk && rulesOk,
        kindOk && rulesOk ? `rules.json: ${layer.name}/ (${layer.kind}) lists its ${layer.rules.length} roster rules`
          : `rules.json: ${layer.name}/ differs from the roster` +
            (kindOk ? '' : ` — kind "${layer.kind}", expected "${want.kind}"`) +
            (rulesOk ? '' : ` — missing: [${setDiff(want.rules, layer.rules).join(', ')}] extra: [${setDiff(layer.rules, want.rules).join(', ')}]`));
    }
    const formats = layers.filter((l) => l.kind === 'format').map((l) => l.name);
    report.check(sameSet(formats, ['paged', 'webtoon']),
      `rules.json: format layers are paged and webtoon (got ${formats.join(', ') || 'none'})`);
  }

  const dir = path.join(ctx.root, 'rules');
  const isRuleDoc = (f) => f.endsWith('.md') && path.basename(f).toLowerCase() !== 'readme.md';
  const onDisk = walk(dir, { filter: isRuleDoc }).map((f) => toPosix(path.relative(dir, f)));
  if (!exists(dir) || onDisk.length === 0) {
    report.fail('rules/ is missing or empty (not written yet?)');
    return;
  }
  const expected = [];
  for (const layer of layers) {
    for (const name of layer.rules) {
      const rel = `${layer.name}/${name}.md`;
      expected.push(rel);
      const file = path.join(dir, layer.name, `${name}.md`);
      if (!exists(file)) {
        report.fail(`rules/${rel} does not exist`);
        continue;
      }
      const text = readText(file).replace(/\r\n/g, '\n');
      if (!/^#\s+\S/m.test(text)) report.fail(`rules/${rel}: missing "# Title" heading`);
      checkDocSections(report, `rules/${rel}`, text, RULE_SECTIONS);
    }
  }
  const strays = setDiff(onDisk, expected);
  report.check(strays.length === 0,
    strays.length === 0 ? `rules/: no rule file outside the roster (${onDisk.length} on disk)`
      : `rules/: files outside the roster: ${strays.join(', ')}`);
}

function sectionContexts(report, ctx) {
  report.section('contexts/*.md');
  const dir = path.join(ctx.root, 'contexts');
  if (!exists(dir)) {
    report.fail('contexts/ is missing (not written yet?)');
    return;
  }
  for (const name of CONTEXT_NAMES) {
    const file = path.join(dir, `${name}.md`);
    if (!exists(file)) {
      report.fail(`contexts/${name}.md missing`);
      continue;
    }
    report.check(readText(file).trim().length > 0, `contexts/${name}.md exists and is not empty`);
  }
}

function sectionSchemas(report, ctx) {
  report.section('schemas/*.schema.json');
  const dir = path.join(ctx.root, 'schemas');
  if (!exists(dir)) {
    report.fail('schemas/ is missing (not written yet?)');
    return;
  }
  for (const name of SCHEMA_NAMES) {
    const file = path.join(dir, `${name}.schema.json`);
    if (!exists(file)) {
      report.fail(`schemas/${name}.schema.json missing`);
      continue;
    }
    let doc;
    try {
      doc = readJson(file);
    } catch (err) {
      report.fail(`schemas/${name}.schema.json: invalid JSON: ${err.message}`);
      continue;
    }
    const check = schemaLib.checkSchemaDocument(doc);
    if (!check.valid) {
      report.fail(`schemas/${name}.schema.json: ${check.errors.slice(0, 3).join('; ')}`);
      continue;
    }
    const expectedId = `${SCHEMA_ID_BASE}${name}.schema.json`;
    if (doc.$id && doc.$id !== expectedId) {
      report.fail(`schemas/${name}.schema.json: $id is ${doc.$id}, expected ${expectedId}`);
    } else {
      report.pass(`schemas/${name}.schema.json parses and compiles`);
    }
    ctx.schemas[name] = doc;
  }
  const extra = walk(dir, { filter: (f) => f.endsWith('.schema.json') })
    .map((f) => path.basename(f).replace(/\.schema\.json$/, ''))
    .filter((n) => !SCHEMA_NAMES.includes(n));
  if (extra.length) report.fail(`schemas/ has schemas outside the roster: ${extra.join(', ')}`);
}

function sectionTemplates(report, ctx) {
  report.section('templates/ tree and schema validation');
  const dir = path.join(ctx.root, 'templates');
  if (!exists(dir)) {
    report.fail('templates/ is missing (not written yet?)');
    return;
  }
  const absent = TEMPLATE_FILES.filter((rel) => !exists(path.join(dir, ...rel.split('/'))));
  report.check(absent.length === 0,
    absent.length === 0 ? `all ${TEMPLATE_FILES.length} files of the template tree exist`
      : `template tree incomplete, missing: ${absent.join(', ')}`);
  const files = walk(dir, { filter: (f) => /\.ya?ml$/i.test(f) });
  if (!files.length) {
    report.fail('templates/ contains no YAML files');
    return;
  }
  let checked = 0;
  for (const file of files) {
    const rel = toPosix(path.relative(ctx.root, file));
    const schemaName = templateSchemaName(toPosix(path.relative(dir, file)));
    let doc;
    try {
      doc = yaml.parse(readText(file));
    } catch (err) {
      report.fail(`${rel}: YAML parse error: ${err.message}`);
      continue;
    }
    if (!schemaName) {
      report.info(`${rel}: no schema by design (parsed only)`);
      continue;
    }
    if (!ctx.schemas[schemaName]) {
      report.info(`${rel}: ${schemaName}.schema.json not loaded (skipped)`);
      continue;
    }
    checked++;
    const result = schemaLib.validate(ctx.schemas[schemaName], doc);
    report.check(result.valid,
      result.valid ? `${rel} validates against ${schemaName}.schema.json`
        : `${rel} violates ${schemaName}.schema.json: ${result.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  }
  if (checked === 0) report.warn('no templates were schema-checked (schemas missing?)');
}

function sectionProviders(report, ctx) {
  report.section('providers/ interface vs manifests');
  let seen = 0;
  for (const kind of PROVIDER_KINDS) {
    const manifestName = `${kind}-providers.json`;
    for (const entry of entries(ctx.manifests, manifestName, 'providers')) {
      seen++;
      const file = path.join(ctx.root, ...String(entry.file).split('/'));
      if (!exists(file)) continue; // reported in files section
      let mod;
      try {
        mod = require(file);
      } catch (err) {
        report.fail(`${entry.file}: require failed: ${err.message}`);
        continue;
      }
      const problems = [];
      if (mod.id !== entry.id) problems.push(`id "${mod.id}" != manifest "${entry.id}"`);
      if (mod.kind !== kind) problems.push(`kind "${mod.kind}" != "${kind}"`);
      if (typeof mod.label !== 'string' || !mod.label) problems.push('label missing');
      if (!Array.isArray(mod.env)) problems.push('env must be an array');
      else if (!schemaLib.deepEqual(mod.env, entry.env)) problems.push('env differs from manifest');
      if (!mod.capabilities || typeof mod.capabilities !== 'object') problems.push('capabilities missing');
      else if (!schemaLib.deepEqual(mod.capabilities, entry.capabilities)) problems.push('capabilities differ from manifest');
      if (typeof mod.compile !== 'function') problems.push('compile() missing');
      if (typeof mod.generate !== 'function') problems.push('generate() missing');
      report.check(problems.length === 0,
        problems.length === 0 ? `${entry.file}: interface + manifest match`
          : `${entry.file}: ${problems.join('; ')}`);
    }
  }
  if (seen === 0) report.fail('no providers listed (provider manifest missing?)');
}

function sectionHooks(report, ctx) {
  report.section('hooks/hooks.json');
  const file = path.join(ctx.root, 'hooks', 'hooks.json');
  if (!exists(file)) {
    report.fail('hooks/hooks.json missing');
    return;
  }
  let config;
  try {
    config = readJson(file);
  } catch (err) {
    report.fail(`hooks/hooks.json: invalid JSON: ${err.message}`);
    return;
  }
  const ids = (config.hooks || []).map((h) => h.id);
  report.check(sameSet(ids, HOOK_IDS), `hooks.json wires the ${HOOK_IDS.length} hooks (${HOOK_IDS.join(', ')})`);
  for (const hook of config.hooks || []) {
    const script = path.join(ctx.root, ...String(hook.script).split('/'));
    report.check(exists(script), `${hook.id}: ${hook.script} ${exists(script) ? 'exists' : 'MISSING'}`);
  }
}

/** Run one exported checker of a script against the example; never throws. */
async function runExampleCheck(report, ctx, script, exportName, required, summarize) {
  const file = path.join(ctx.root, 'scripts', script);
  const notYet = (message) => (required ? report.fail(message) : report.info(message));
  if (!exists(file)) {
    notYet(`scripts/${script} is not written yet`);
    return;
  }
  let mod;
  try {
    mod = require(file);
  } catch (err) {
    report.fail(`scripts/${script}: require failed: ${err.message}`);
    return;
  }
  if (!mod || typeof mod[exportName] !== 'function') {
    notYet(`scripts/${script} does not export ${exportName}() (not written yet?)`);
    return;
  }
  let result;
  try {
    result = await mod[exportName](path.join(ctx.root, ...EXAMPLE_DIR.split('/')), {});
  } catch (err) {
    report.fail(`${exportName}() crashed on ${EXAMPLE_DIR}: ${err.message}`);
    return;
  }
  summarize(result || {});
}

async function sectionExample(report, ctx) {
  report.section(`Example workspace (${EXAMPLE_DIR})`);
  const dir = path.join(ctx.root, ...EXAMPLE_DIR.split('/'));
  if (!exists(path.join(dir, 'project.yaml'))) {
    report.fail(`${EXAMPLE_DIR}/project.yaml missing: the example workspace is not written yet`);
    return;
  }
  const where = (e) => [e.file, e.issue, e.page, e.panel, e.entity].filter(Boolean).join(' ');
  await runExampleCheck(report, ctx, 'validate-workspace.js', 'validateWorkspace', true, (result) => {
    const errors = Array.isArray(result.errors) ? result.errors : [];
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    if (!Array.isArray(result.errors)) {
      report.fail('validateWorkspace() did not return { errors: [] }');
      return;
    }
    report.check(errors.length === 0,
      errors.length === 0 ? `${EXAMPLE_DIR} passes validate-workspace (${warnings.length} warning(s))`
        : `${EXAMPLE_DIR}: validate-workspace reports ${errors.length} error(s)`);
    for (const e of errors.slice(0, 15)) report.info(`${where(e)} [${e.code}] ${e.message}`);
    if (errors.length > 15) report.info(`... and ${errors.length - 15} more`);
    for (const w of warnings.slice(0, 5)) report.info(`warning: ${where(w)} [${w.code}] ${w.message}`);
  });
  await runExampleCheck(report, ctx, 'check-continuity.js', 'checkContinuity', false, (result) => {
    if (!Array.isArray(result.findings)) {
      report.fail('checkContinuity() did not return { findings: [] }');
      return;
    }
    const errors = result.findings.filter((f) => f.severity === 'error');
    report.check(errors.length === 0,
      errors.length === 0 ? `${EXAMPLE_DIR} passes the panel ledger audit (${result.findings.length - errors.length} warning(s))`
        : `${EXAMPLE_DIR}: check-continuity reports ${errors.length} error(s)`);
    for (const e of errors.slice(0, 15)) report.info(`${where(e)} [${e.code}] ${e.message}`);
    if (errors.length > 15) report.info(`... and ${errors.length - 15} more`);
  });
}

function sectionHarnesses(report, ctx) {
  report.section('Generated harness wrappers (drift vs sync-harnesses.js)');
  let sync;
  try {
    sync = require('./sync-harnesses');
  } catch (err) {
    report.fail(`could not load sync-harnesses.js: ${err.message}`);
    return;
  }
  let plan;
  try {
    plan = sync.buildPlan(ctx.root);
  } catch (err) {
    report.fail(`buildPlan failed: ${err.message}`);
    return;
  }
  if (!Object.keys(plan).length) {
    report.fail('nothing to generate (harnesses.json or source layers missing)');
    return;
  }
  const drift = sync.diffPlan(ctx.root, plan);
  if (drift.length === 0) {
    report.pass(`all ${Object.keys(plan).length} generated files match`);
  } else {
    report.fail(`${drift.length} file(s) drifted — run "npm run sync:harnesses"`);
    for (const d of drift.slice(0, 15)) report.info(d);
    if (drift.length > 15) report.info(`... and ${drift.length - 15} more`);
  }
}

// ---------------------------------------------------------------------------

const SECTIONS = {
  manifests: sectionManifests,
  files: sectionFiles,
  agents: sectionAgents,
  commands: sectionCommands,
  skills: sectionSkills,
  rules: sectionRules,
  contexts: sectionContexts,
  schemas: sectionSchemas,
  templates: sectionTemplates,
  providers: sectionProviders,
  hooks: sectionHooks,
  example: sectionExample,
  harnesses: sectionHarnesses,
};

/** Build the shared context every section reads. Never throws. */
function buildContext(root = ROOT) {
  const loaded = loadManifests(root);
  let rosters = null;
  try {
    rosters = parseConventionsRosters(root);
  } catch (err) {
    rosters = null;
  }
  return {
    root,
    manifests: loaded.manifests,
    manifestErrors: loaded.errors,
    rosters,
    schemas: {},
  };
}

/**
 * Run the named sections (all when omitted) against a scaffold root.
 * A section that throws is reported as a failure; the run continues.
 */
async function runSections(root, names, report) {
  const ctx = buildContext(root);
  const list = names && names.length ? names.slice() : Object.keys(SECTIONS);
  // schemas must run before templates so ctx.schemas is populated
  if (list.includes('templates') && !list.includes('schemas')) list.unshift('schemas');
  for (const name of list) {
    const fn = SECTIONS[name];
    if (!fn) throw new Error(`unknown section "${name}" (valid: ${Object.keys(SECTIONS).join(', ')})`);
    try {
      await fn(report, ctx);
    } catch (err) {
      report.fail(`section "${name}" crashed: ${err.message}`);
    }
  }
  return report;
}

async function main() {
  helpIfRequested(process.argv.slice(2), HELP);
  const { flags } = parseArgs();
  const root = flags.root && flags.root !== true ? path.resolve(String(flags.root)) : ROOT;
  const names = flags.section && flags.section !== true ? [String(flags.section)] : null;
  const report = createReport();
  try {
    await runSections(root, names, report);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  process.exit(report.finish());
}

module.exports = {
  SECTIONS,
  SCHEMA_NAMES,
  SCHEMA_ID_BASE,
  PROFILE_NAMES,
  CONTEXT_NAMES,
  HOOK_IDS,
  RULE_SECTIONS,
  TEMPLATE_FILES,
  templateSchemaName,
  buildContext,
  runSections,
};

if (require.main === module) main();
