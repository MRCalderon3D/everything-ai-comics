'use strict';
/**
 * Prompt building. One text template per operation lives in studio/prompts/;
 * this file fills it in and wraps it with the shared header (workspace root,
 * language) and the headless contract.
 *
 * Template syntax: {{name}} is replaced by a value, and
 * {{#if name}}...{{/if}} keeps its content only when the value is non-empty.
 * The prompts stay short on purpose: the commands, agents, skills and rules
 * of the scaffold carry the method.
 */

const fs = require('fs');
const path = require('path');
const { STUDIO_ROOT } = require('./util');

const PROMPTS_DIR = path.join(STUDIO_ROOT, 'prompts');
const cache = new Map();

/** The fourteen checks of a visual review, in the order the schema lists them. */
const REVIEW_CHECKS = ['identity', 'cast_count', 'position', 'movement', 'role_causality', 'object_identity',
  'object_custody', 'physical_state', 'wardrobe', 'spatial_logic', 'drawing_clarity', 'lettering',
  'page_structure', 'style_fidelity'];

/** Template name -> file. One per operation that calls the AI. */
const TEMPLATES = {
  'project.setup': 'project-setup.txt',
  'story.update': 'story-update.txt',
  'style.define': 'style-define.txt',
  'character.write': 'character.txt',
  'entities.derive': 'entities-derive.txt',
  'pages.breakdown': 'pages-breakdown.txt',
  'pages.plan': 'pages-plan.txt',
  'pages.fix': 'pages-fix.txt',
  'page.revise': 'page-revise.txt',
  review: 'review.txt',
  'cover.write': 'cover.txt',
  'lettering.place': 'lettering.txt',
  chat: 'chat.txt',
};

function template(file) {
  if (!cache.has(file)) cache.set(file, fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf8').replace(/\r\n/g, '\n'));
  return cache.get(file);
}

function isEmpty(value) {
  return value === undefined || value === null || value === false || value === '' ||
    (Array.isArray(value) && value.length === 0);
}

const LANGUAGE_NAMES = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', ca: 'Catalan',
  gl: 'Galician', eu: 'Basque', nl: 'Dutch', ja: 'Japanese', ko: 'Korean', zh: 'Chinese',
};

/** "es" -> "es (Spanish)": a code alone is easy for a model to skip. */
function languageLabel(code) {
  const text = String(code || 'en');
  const name = LANGUAGE_NAMES[text.slice(0, 2).toLowerCase()];
  return name ? `${text} (${name})` : text;
}

/** Fill a template. Unknown names become empty strings. */
function render(text, vars) {
  let out = text;
  // Innermost blocks first, so nested conditions work.
  const block = /\{\{#if ([a-z_]+)\}\}((?:(?!\{\{#if )[\s\S])*?)\{\{\/if\}\}/;
  for (let guard = 0; guard < 200 && block.test(out); guard++) {
    out = out.replace(block, (m, name, body) => (isEmpty(vars[name]) ? '' : body));
  }
  return out
    .replace(/\{\{([a-z_]+)\}\}/g, (m, name) => (isEmpty(vars[name]) ? '' : String(vars[name])))
    // A block that was left out must not leave a hole of blank lines behind.
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * The output schema every AI call ends with (the headless contract).
 * `dataSchema` replaces the free-form "data" object for operations that
 * need a known shape back.
 */
function contractSchema(dataSchema) {
  return {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['done', 'needs_decision', 'failed'] },
      summary: { type: 'string' },
      files_written: { type: 'array', items: { type: 'string' } },
      decisions: { type: 'array', items: { type: 'string' } },
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            question: { type: 'string' },
            options: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'question'],
        },
      },
      data: dataSchema || { type: 'object' },
    },
    required: ['status', 'summary', 'files_written'],
  };
}

/** The shape of data.review a look run returns. */
function reviewDataSchema() {
  const check = {
    type: 'object',
    properties: {
      result: { type: 'string', enum: ['pass', 'fail', 'not_applicable'] },
      evidence: { type: 'string' },
    },
    required: ['result', 'evidence'],
  };
  const checks = {};
  for (const name of REVIEW_CHECKS) checks[name] = check;
  return {
    type: 'object',
    properties: {
      review: {
        type: 'object',
        properties: {
          checks: { type: 'object', properties: checks, required: REVIEW_CHECKS },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                panel: { type: ['string', 'null'] },
                check: { type: 'string', enum: REVIEW_CHECKS },
                expected: { type: 'string' },
                visible: { type: 'string' },
                severity: { type: 'string', enum: ['blocking', 'minor'] },
                repair: { type: 'string' },
              },
              required: ['check', 'expected', 'visible', 'severity', 'repair'],
            },
          },
          rechecks: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, fixed: { type: 'boolean' }, evidence: { type: 'string' } },
              required: ['id', 'fixed', 'evidence'],
            },
          },
          gates: {
            type: 'object',
            properties: {
              style_fidelity: { type: 'string', enum: ['pass', 'fail'] },
              narrative_continuity: { type: 'string', enum: ['pass', 'fail'] },
            },
            required: ['style_fidelity', 'narrative_continuity'],
          },
          repairable: { type: 'boolean' },
          references_compared: { type: 'array', items: { type: 'string' } },
        },
        required: ['checks', 'findings', 'gates'],
      },
    },
    required: ['review'],
  };
}

/**
 * Build the full prompt of one AI call.
 * @param {string} kind a key of TEMPLATES
 * @param {object} vars values for the template
 * @param {{workspace: string, language?: string, comicFormat?: string,
 *          answers?: object}} context
 *   answers: { <question id>: { question, answer } } from a job that paused
 */
function build(kind, vars, context) {
  const file = TEMPLATES[kind];
  if (!file) throw new Error(`no prompt template for "${kind}"`);
  const shared = {
    workspace: context.workspace,
    language: languageLabel(context.language || 'en'),
    interface_language: languageLabel(context.interfaceLanguage || context.language || 'en'),
    comic_format: context.comicFormat || 'paged',
    // The contract has two wordings: one for runs that write, one for read-only runs.
    writes: !context.readOnly,
    read_only: !!context.readOnly,
  };
  const all = Object.assign({}, vars, shared);
  const parts = [render(template('header.txt'), all).trim(), render(template(file), all).trim()];
  const answers = context.answers && typeof context.answers === 'object' ? Object.values(context.answers) : [];
  if (answers.length) {
    parts.push(['ANSWERS FROM THE PERSON',
      'An earlier run of this step stopped to ask. These are the answers. Use them and do not ask again.',
      ...answers.map((a) => `Q: ${String(a.question).replace(/\s+/g, ' ')}\nA: ${String(a.answer)}`)].join('\n'));
  }
  parts.push(render(template('contract.txt'), all).trim());
  return `${parts.join('\n\n')}\n`;
}

/** A bulleted list of files for a prompt: "- <path> (what it is)". */
function fileList(items) {
  return items.filter(Boolean).map((item) => (typeof item === 'string'
    ? `- ${item}`
    : `- ${item.path}${item.note ? ` (${item.note})` : ''}`)).join('\n');
}

module.exports = { TEMPLATES, REVIEW_CHECKS, languageLabel, render, build, contractSchema, reviewDataSchema, fileList, PROMPTS_DIR };
