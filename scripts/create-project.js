#!/usr/bin/env node
'use strict';
/**
 * create-project.js — scaffold a production/ workspace in a target project.
 *
 * Creates the canonical directory layout (docs/conventions.md), writes
 * production/project.yaml from templates/project/project.yaml, and copies the
 * starter files (story bible, series plan, style documents, reference
 * registry) from templates/.
 *
 * Tokens substituted in every template: {{TITLE}}, {{PROJECT_ID}}, {{DATE}},
 * {{COMIC_FORMAT}}. A template without tokens gets its top-level title,
 * created_at, and comic_format lines rewritten in place, so its comments
 * survive. With no project template at all, a minimal schema-valid
 * project.yaml is written. A starter whose template is missing is skipped.
 */

const path = require('path');
const fs = require('fs');
const { ROOT, exists, readText, writeFileEnsuring } = require('./lib/fsx');
const { parseArgs, helpIfRequested, fatal } = require('./lib/cli');
const yaml = require('./lib/yaml');

const HELP = `
create-project.js — scaffold production/ in a target comic project.

Usage:
  node scripts/create-project.js --title "<comic title>" [--target <dir>]
                                 [--format paged|webtoon] [--force]

Options:
  --title <text>    Comic title (required). Names the workspace folder too.
  --target <dir>    Project directory (default: ./<title-slug>;
                    production/ is created inside it).
  --format <name>   paged | webtoon. Sets comic_format in project.yaml
                    (default: what the template says, normally paged).
  --force           Overwrite an existing production/project.yaml. Starter
                    files that already exist are always kept.
  --help            Show this help.
`;

const COMIC_FORMATS = ['paged', 'webtoon'];

const PRODUCTION_DIRS = [
  'story', 'story/source', 'style', 'characters', 'locations', 'props',
  'references', 'references/inbox', 'references/style', 'references/docs',
  'issues', 'generations', 'continuity', 'editions',
];

/** Starter files: [template path under templates/, path under production/]. */
const STARTER_FILES = [
  ['story/story-bible.yaml', 'story/story-bible.yaml'],
  ['story/series-plan.yaml', 'story/series-plan.yaml'],
  ['style/style-bible.md', 'style/style-bible.md'],
  ['style/style-block.txt', 'style/style-block.txt'],
  ['style/color-script.md', 'style/color-script.md'],
  ['references/manifest.yaml', 'references/manifest.yaml'],
];

const TOKEN_RE = /\{\{(TITLE|PROJECT_ID|DATE|COMIC_FORMAT)\}\}/;

function slugifyId(title) {
  return String(title).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'UNTITLED';
}

/** Folder-friendly slug: the project workspace directory is named after the
 * project title (production/ inside it is the default workspace name). */
function slugifyDir(title) {
  return String(title).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Replace the {{...}} tokens. Returns { text, hadTokens }. */
function substituteTokens(text, title, format) {
  const src = String(text).replace(/\r\n/g, '\n');
  const hadTokens = TOKEN_RE.test(src);
  // A title is usually placed inside double quotes in YAML templates.
  const safeTitle = String(title).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  // Function replacers: a "$" in the title must not act as a pattern.
  return {
    hadTokens,
    text: src
      .replace(/"\{\{TITLE\}\}"/g, () => `"${safeTitle}"`)
      .replace(/\{\{TITLE\}\}/g, () => String(title))
      .replace(/\{\{PROJECT_ID\}\}/g, () => slugifyId(title))
      .replace(/\{\{DATE\}\}/g, () => today())
      .replace(/\{\{COMIC_FORMAT\}\}/g, () => format || 'paged'),
  };
}

/** Rewrite a top-level "key: value" line, keeping a trailing comment. */
function setTopLevelLine(text, key, rendered) {
  const re = new RegExp(`^(${key}:[^\\n#]*)(#.*)?$`, 'm');
  if (!re.test(text)) return null;
  return text.replace(re, (m, head, comment) => {
    const line = `${key}: ${rendered}`;
    // Keep the comment in its column when the new value still fits.
    return comment ? line.padEnd(Math.max(head.length, line.length + 1)) + comment : line;
  });
}

/** Rewrite a "key: value" line nested under the top-level `page:` map. */
function setPageLine(text, key, rendered) {
  const re = new RegExp(`^(  ${key}:[^\\n#]*)(#.*)?$`, 'm');
  if (!re.test(text)) return text;
  return text.replace(re, (m, head, comment) => {
    const line = `  ${key}: ${rendered}`;
    return comment ? line.padEnd(Math.max(head.length, line.length + 1)) + comment : line;
  });
}

/**
 * Webtoon defaults: a vertical 9:16 scroll segment (a ratio every image
 * provider accepts), a series publication, and no print geometry.
 */
function applyWebtoonDefaults(text) {
  let out = setTopLevelLine(text, 'publication', 'webtoon-series') || text;
  out = setPageLine(out, 'aspect_ratio', '"9:16"');
  out = setPageLine(out, 'width_px', '1080');
  out = setPageLine(out, 'height_px', '1920');
  return out.replace(/^  (trim_mm|bleed_mm|safe_margin_mm):.*\n/gm, '');
}

/**
 * project.yaml text for a new workspace.
 * @param {string} title
 * @param {string|null} templateText  templates/project/project.yaml, or null
 * @param {string|null} [format]      paged | webtoon; null keeps the template's value
 */
function buildProjectYaml(title, templateText, format = null) {
  if (templateText) {
    const { text: substituted, hadTokens } = substituteTokens(templateText, title, format);
    let text = substituted;
    if (!hadTokens) {
      const quoted = JSON.stringify(title);
      text = setTopLevelLine(text, 'title', quoted) || `title: ${quoted}\n${text}`;
      text = setTopLevelLine(text, 'created_at', `"${today()}"`) || text;
    }
    if (format) {
      text = setTopLevelLine(text, 'comic_format', format) || `${text.replace(/\n*$/, '\n')}comic_format: ${format}\n`;
    }
    if (format === 'webtoon') text = applyWebtoonDefaults(text);
    return text;
  }
  // Minimal but schema-valid project.yaml (schemas/project.schema.json).
  const webtoon = format === 'webtoon';
  return yaml.stringify({
    title,
    comic_format: webtoon ? 'webtoon' : 'paged',
    publication: webtoon ? 'webtoon-series' : 'one-shot',
    logline: 'TODO: one-sentence logline.',
    language: 'en',
    reading_direction: 'ltr',
    page: webtoon
      ? { aspect_ratio: '9:16', width_px: 1080, height_px: 1920 }
      : { aspect_ratio: '2:3', width_px: 2000, height_px: 3000 },
    color_mode: 'full_color',
    lettering: { mode: 'in_image' },
    style: { style_block: 'style/style-block.txt' },
    default_providers: { image: 'harness-native' },
    repair_policy: { max_cycles: 2, touch_up_warning: 2 },
    created_at: today(),
    version: '0.1.0',
  });
}

/** Starter file text: tokens, or the top-level YAML title line when it has one. */
function buildStarter(templateText, title, format, isYaml) {
  const { text, hadTokens } = substituteTokens(templateText, title, format);
  if (hadTokens || !isYaml) return text;
  return setTopLevelLine(text, 'title', JSON.stringify(title)) || text;
}

/**
 * Create the workspace. Returns { prodDir, projectFromTemplate, copied,
 * kept, missing } with starter paths relative to production/.
 */
function createProject({ target, title, format = null, force = false, templatesDir = path.join(ROOT, 'templates') }) {
  const prodDir = path.join(target, 'production');
  const projectFile = path.join(prodDir, 'project.yaml');
  if (exists(projectFile) && !force) {
    throw new Error(`${projectFile} already exists (use --force to overwrite)`);
  }

  for (const dir of PRODUCTION_DIRS) {
    fs.mkdirSync(path.join(prodDir, ...dir.split('/')), { recursive: true });
  }

  const templateFile = path.join(templatesDir, 'project', 'project.yaml');
  const templateText = exists(templateFile) ? readText(templateFile) : null;
  writeFileEnsuring(projectFile, buildProjectYaml(title, templateText, format));

  const copied = [];
  const kept = [];
  const missing = [];
  for (const [from, to] of STARTER_FILES) {
    const src = path.join(templatesDir, ...from.split('/'));
    const dest = path.join(prodDir, ...to.split('/'));
    if (!exists(src)) {
      missing.push(to);
      continue;
    }
    if (exists(dest)) {
      kept.push(to);
      continue;
    }
    writeFileEnsuring(dest, buildStarter(readText(src), title, format, /\.ya?ml$/i.test(to)));
    copied.push(to);
  }
  return { prodDir, projectFromTemplate: !!templateText, copied, kept, missing };
}

function main() {
  helpIfRequested(process.argv.slice(2), HELP);
  const { flags } = parseArgs();
  if (!flags.title || flags.title === true) fatal('--title "<comic title>" is required (see --help)');
  const title = String(flags.title);
  if (!flags.target || flags.target === true) {
    // No --target: the workspace folder takes the project's name.
    flags.target = path.join('.', slugifyDir(title));
    console.log(`no --target given: creating workspace at ${flags.target}`);
  }
  let format = null;
  if (flags.format !== undefined) {
    format = String(flags.format);
    if (!COMIC_FORMATS.includes(format)) fatal(`--format must be one of ${COMIC_FORMATS.join(', ')}`);
  }
  const target = path.resolve(String(flags.target));

  let result;
  try {
    result = createProject({ target, title, format, force: !!flags.force });
  } catch (err) {
    fatal(err.message);
  }

  console.log(`create-project: production/ scaffolded at ${result.prodDir}`);
  console.log(`  project.yaml written for "${title}"` +
    (result.projectFromTemplate ? ' (from templates/project/project.yaml)' : ' (minimal, no template found)'));
  if (format) console.log(`  comic_format: ${format}`);
  if (result.copied.length) console.log(`  starter files: ${result.copied.join(', ')}`);
  if (result.kept.length) console.log(`  kept existing: ${result.kept.join(', ')}`);
  if (format === 'webtoon') {
    console.log('  webtoon: review publication and the page size in project.yaml (a page is one scroll segment).');
  }
  console.log('Next steps:');
  console.log('  1. Put your source text (prose or script) in production/story/source/.');
  console.log('  2. Run /source-analyze, then /story-bible and /series-plan in your harness.');
  console.log('  3. node scripts/doctor.js --target "' + target + '" to verify the setup.');
}

module.exports = {
  buildProjectYaml,
  buildStarter,
  createProject,
  PRODUCTION_DIRS,
  STARTER_FILES,
  COMIC_FORMATS,
  slugifyId,
  slugifyDir,
};

if (require.main === module) main();
