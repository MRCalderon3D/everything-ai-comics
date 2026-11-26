'use strict';
/**
 * lettering.apply: for projects with overlay lettering. Places the
 * lettering of each page (lettering.yaml, written by the lettering command)
 * and builds the SVG overlay with letter-pages.js. The browser then turns
 * each overlay into a flat PNG and sends it to
 * POST /pages/<PAGE_ID>/lettered, which stores it with registerLetteredFile.
 */

const fs = require('fs');
const path = require('path');
const S = require('../scaffold');
const { msg } = require('../i18n');
const prompts = require('../prompts');
const { runAi } = require('../ai');
const { OpError } = require('../jobs');
const { HttpError } = require('../util');
const { bad, matching, requireIssue, ISSUE_RE, PAGE_RE } = require('./shared');

/** Does the page need its geometry written (again)? */
function needsPlacement(root, pageId) {
  const page = S.ws.loadPage(root, pageId);
  if (!page || !page.current_render) return false;
  const file = path.join(S.ws.pageDir(root, pageId), 'lettering.yaml');
  let doc = null;
  try {
    doc = S.ws.loadYaml(file);
  } catch (err) {
    doc = null;
  }
  if (!doc) return true;
  if (doc.render !== page.current_render) return true;
  const check = S.letterPage(path.join(S.ws.pageDir(root, pageId), 'page.yaml'), { write: false });
  return !check.ok;
}

module.exports = {
  name: 'lettering.apply',
  needsPlacement,
  params: [
    { name: 'issue', type: 'string', required: false, description: 'Issue ID. Default ISS_001.' },
    { name: 'pages', type: 'string[]', required: false, description: 'Page IDs. Default: every page of the issue that has a render.' },
  ],

  validate(params, { project }) {
    const root = project.root;
    const doc = S.ws.loadProject(root) || {};
    if (!doc.lettering || doc.lettering.mode !== 'overlay') {
      throw new HttpError(409, 'not_overlay', 'This project letters its pages in the image. Overlay lettering is a project option.');
    }
    const issue = matching(params, 'issue', ISSUE_RE, { required: false, what: 'an issue ID such as ISS_001' }) || 'ISS_001';
    requireIssue(project, issue);
    let pages;
    if (params.pages !== undefined && params.pages !== null) {
      if (!Array.isArray(params.pages) || !params.pages.length) throw bad('"pages" must be a list of page IDs.');
      pages = [...new Set(params.pages.map(String))];
      for (const id of pages) {
        if (!PAGE_RE.test(id) || !S.ws.loadPage(root, id)) throw bad(`"${id}" is not a page of this project.`);
      }
    } else {
      pages = S.ws.listPages(root, issue).filter((p) => p.doc && p.doc.current_render).map((p) => p.id);
    }
    pages = pages.filter((id) => {
      const page = S.ws.loadPage(root, id);
      return page && page.current_render;
    });
    if (!pages.length) throw new HttpError(409, 'no_render', 'No page has a render to letter yet.');
    return { issue, pages };
  },

  steps() {
    return [
      { id: 'place', label: msg('step.lettering.place') },
      { id: 'overlay', label: msg('step.lettering.overlay') },
    ];
  },

  async run(ctx) {
    const { project, params } = ctx;
    const root = project.root;
    const pending = params.pages.filter((id) => needsPlacement(root, id));
    if (pending.length) {
      await ctx.step('place', (h) => runAi(ctx, h, {
        verb: 'plan',
        kind: 'lettering.place',
        vars: {
          issue: params.issue,
          pages: pending.join(', '),
          page_list: pending,
          renders: prompts.fileList(pending.map((id) => {
            const page = S.ws.loadPage(root, id);
            return { path: S.ws.renderFile(root, page.current_render), note: `${id}, render ${page.current_render}` };
          })),
        },
        images: pending.map((id) => S.ws.renderFile(root, S.ws.loadPage(root, id).current_render)).filter(Boolean).slice(0, 8),
      }), { verb: 'plan' });
    } else {
      ctx.skipStep('place', msg('skip.lettering_placed'));
    }

    const built = await ctx.step('overlay', (h) => params.pages.map((id) => {
      const result = S.letterPage(path.join(S.ws.pageDir(root, id), 'page.yaml'), {});
      for (const e of result.errors) h.log(`${id}: ${e.message}`);
      for (const w of result.warnings) h.log(`${id} warning: ${w.message}`);
      return {
        page: id,
        ok: result.ok,
        render: result.render,
        svg: result.file && fs.existsSync(result.file) ? S.ws.rel(root, result.file) : null,
        elements: result.elements,
        errors: result.errors,
        warnings: result.warnings,
      };
    }));
    const failed = built.filter((p) => !p.ok);
    if (failed.length === built.length) {
      throw new OpError('lettering_failed', `No overlay could be built. ${failed[0].errors[0] ? failed[0].errors[0].message : ''}`.trim(), { pages: failed });
    }
    return { issue: params.issue, pages: built, failed: failed.length };
  },
};
