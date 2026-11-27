'use strict';
/**
 * page.manual: the handoff for when no drawing tool is installed, or when
 * the person prefers to make an image by hand. It works for a page, a cover
 * or a reference sheet, in two modes:
 *
 * - without "upload": compile the package for the scaffold's `manual`
 *   provider and write the handoff (the prompt, the reference images in
 *   order with the role of each, the target). The result carries everything
 *   the person needs to make the image elsewhere.
 * - with "upload": the image the person made becomes the next render or
 *   candidate version, through the same naming functions as a generated
 *   one, with a generation record that says a person supplied it. A page or
 *   a cover is then reviewed.
 *
 * A page drawn panel by panel (generation.mode per_panel) ends here: the
 * person puts the panel images together in the page's layout and uploads
 * the page. Its package then lists every reference of the page with no
 * budget, since no tool receives them, so the review compares against all.
 */

const fs = require('fs');
const path = require('path');
const S = require('../scaffold');
const pipeline = require('../pipeline');
const files = require('../files');
const { msg, t } = require('../i18n');
const { OpError } = require('../jobs');
const { HttpError, SCAFFOLD_ROOT } = require('../util');
const { bad, bool, requirePage, requireIssue, lookState, ISSUE_RE, PAGE_RE, ENTITY_RE } = require('./shared');

const SHEETS = ['turnaround', 'expressions', 'wardrobe', 'plate', 'prop', 'look'];

/**
 * The manual provider for a page the person put together from panels drawn
 * one by one (generation.mode per_panel): the image is theirs, no tool
 * receives the references, so the package carries every reference of the
 * page with no budget, for the review to compare against.
 */
function assembledProvider() {
  const manual = S.providers.loadImageProvider('manual');
  const { compileHandoff } = require(path.join(SCAFFOLD_ROOT, 'providers', 'lib', 'handoff.js'));
  const wide = Object.assign({}, manual, { capabilities: Object.assign({}, manual.capabilities, { referenceImages: Infinity }) });
  wide.compile = (pkg, options = {}) => compileHandoff(wide, pkg, options, 'The person put the panels together in the layout of page.yaml and supplied the page.');
  return wide;
}

/** The manual provider (or `base`) with a generate() that returns the uploaded image. */
function uploadProvider(buffer, format, uploadName, lang, base) {
  const manual = base || S.providers.loadImageProvider('manual');
  const common = require(path.join(SCAFFOLD_ROOT, 'providers', 'lib', 'common.js'));
  return Object.assign({}, manual, {
    async generate(requestSpec) {
      const record = common.makeRecord(requestSpec, { status: 'pending' });
      common.markSucceeded(record, t(lang, 'record.supplied.summary', { name: uploadName }), [`inline image 1 (${format})`]);
      record._media = [{ data_base64: buffer.toString('base64'), format }];
      record.notes = t(lang, 'record.supplied.notes');
      return record;
    },
  });
}

/** The label of the first step, by what the image is for. */
function prepareLabel(params, handoff) {
  const base = handoff ? 'step.manual.handoff' : 'step.manual.prepare';
  if (params.page) return msg(`${base}.page`, { n: parseInt(params.page.slice(-3), 10) });
  if (params.cover) return msg(`${base}.cover`);
  return msg(`${base}.sheet`, { sheet: msg(`sheet.${params.sheet}`), entity: params.entity });
}

module.exports = {
  name: 'page.manual',
  params: [
    { name: 'page', type: 'string', required: false, description: 'Page ID. One of page, cover, entity is required.' },
    { name: 'cover', type: 'string', required: false, description: 'Issue ID whose cover this is about.' },
    { name: 'entity', type: 'string', required: false, description: 'Entity ID for a reference sheet (CHAR_*, LOC_*, PROP_*, LOOK_*).' },
    { name: 'sheet', type: 'string', required: false, description: 'With "entity": turnaround, expressions, wardrobe, plate, prop, look.' },
    { name: 'outfit', type: 'string', required: false, description: 'With a wardrobe sheet: the wardrobe ID.' },
    { name: 'repair', type: 'boolean', required: false, description: 'Page or cover only: prepare a repair of the current render from its open findings, not a fresh image.' },
    { name: 'upload', type: 'string', required: false, description: 'Id of the uploaded image to store. Absent: prepare the handoff only.' },
  ],

  validate(params, { project }) {
    const root = project.root;
    const given = ['page', 'cover', 'entity'].filter((k) => params[k]);
    if (given.length !== 1) throw bad('Give exactly one of "page", "cover" or "entity".');
    const out = { page: null, cover: null, entity: null, sheet: null, outfit: null, repair: bool(params, 'repair', false), upload: null };
    if (params.page) {
      if (!PAGE_RE.test(String(params.page))) throw bad('"page" must be a page ID.');
      requirePage(project, String(params.page));
      out.page = String(params.page);
    } else if (params.cover) {
      if (!ISSUE_RE.test(String(params.cover))) throw bad('"cover" must be an issue ID such as ISS_001.');
      requireIssue(project, String(params.cover));
      if (!S.ws.loadCover(root, String(params.cover))) throw new HttpError(409, 'no_cover', 'Write the cover first (cover.create with "draw": false).');
      out.cover = String(params.cover);
    } else {
      if (!ENTITY_RE.test(String(params.entity))) throw bad('"entity" must be an entity ID.');
      out.entity = String(params.entity);
      out.sheet = String(params.sheet || '');
      const type = out.entity.split('_')[0];
      const allowed = S.assetPaths.SHEET_KINDS[type] || [];
      if (!SHEETS.includes(out.sheet) || !allowed.includes(out.sheet)) {
        throw bad(`"sheet" for ${out.entity} must be one of ${allowed.filter((k) => SHEETS.includes(k)).join(', ')}.`);
      }
      if (params.outfit) out.outfit = String(params.outfit);
      if (out.repair) throw bad('"repair" applies to a page or a cover.');
    }
    if (out.entity && out.sheet !== 'look' && !lookState(project).master) {
      throw new HttpError(409, 'look_not_approved', 'Approve a look page first: a sheet is drawn in the approved look.');
    }
    if (params.upload) {
      const upload = project.upload(String(params.upload));
      if (!upload || upload.kind !== 'image') throw bad('"upload" must be the id of an uploaded image.');
      out.upload = upload.id;
    }
    return out;
  },

  steps(params) {
    if (!params.upload) return [{ id: 'prepare', label: prepareLabel(params, true) }];
    return [
      { id: 'prepare', label: prepareLabel(params, false) },
      { id: 'store', label: msg('step.manual.store') },
      ...(params.entity ? [] : [{ id: 'review', label: msg('step.manual.review') }]),
    ];
  },

  async run(ctx) {
    const { project, params } = ctx;
    const root = project.root;
    const provider = 'manual';
    const supersedes = () => {
      if (!params.repair) return null;
      if (params.page) {
        const page = S.ws.loadPage(root, params.page);
        return (page && page.current_render) || S.ws.listRenders(root, params.page).pop() || null;
      }
      return S.ws.listCoverRenders(root, params.cover).pop() || null;
    };

    // A page drawn panel by panel and put together by the person: no reference budget applies to the upload.
    const pageDoc = params.page ? S.ws.loadPage(root, params.page) : null;
    const assembled = !!(params.upload && pageDoc && pageDoc.generation && pageDoc.generation.mode === 'per_panel' && !params.repair);
    const prepared = await ctx.step('prepare', (h) => {
      let compiled;
      const from = supersedes();
      const review = from ? S.ws.loadReview(root, from) : null;
      if (params.repair && !review) throw new OpError('nothing_to_repair', 'There is no reviewed render to repair.');
      if (params.page) {
        pipeline.buildPlan(root, params.page, provider);
        compiled = pipeline.compilePage(root, params.page, provider, {
          repairReview: review || undefined, providerModule: assembled ? assembledProvider() : undefined,
        });
      } else if (params.cover) {
        compiled = pipeline.compileCover(root, params.cover, provider, { repair: review || undefined });
      } else {
        compiled = pipeline.compileSheet(root, params.entity, provider, { sheet: params.sheet, outfit: params.outfit || undefined });
      }
      for (const warning of compiled.warnings || []) h.log(`warning: ${warning}`);
      return { file: compiled.file, package: compiled.rel, from };
    });

    if (!params.upload) {
      // The dry run writes the handoff: a dry_run record and its request file.
      let outcome;
      try {
        outcome = await S.generateAssets({ package: prepared.file, live: false, log: (line) => ctx.log(String(line).trim()) });
      } catch (err) {
        throw new OpError(err.code || 'handoff_failed', err.message);
      }
      const result = outcome.results[0];
      if (!result) throw new OpError('handoff_failed', outcome.failures[0] || 'The handoff was not written.');
      const request = JSON.parse(fs.readFileSync(result.requestFile, 'utf8'));
      const body = request.body || {};
      return {
        handoff: {
          target: { page: params.page, cover: params.cover, entity: params.entity, sheet: params.sheet },
          mode: body.mode || 'generate',
          prompt: body.prompt || '',
          negative_prompt: body.negative_prompt || null,
          aspect_ratio: body.aspect_ratio || null,
          resolution: body.resolution || null,
          images: (body.images || []).map((img) => ({
            position: img.position, role: img.role, asset_id: img.asset_id || null, path: img.image_path,
            image: files.image(project, img.image_path),
          })),
          instructions: body.instructions || '',
          output_path: (request.meta && request.meta.output_path) || null,
          package: prepared.package,
          record: S.ws.rel(root, result.recordFile),
          request: S.ws.rel(root, result.requestFile),
        },
      };
    }

    const stored = await ctx.step('store', async (h) => {
      h.setTool('person');
      const upload = project.upload(params.upload);
      if (!upload) throw new OpError('upload_missing', 'The uploaded image is no longer there. Upload it again.');
      const buffer = fs.readFileSync(project.uploadFile(upload));
      const info = S.imageInfo(buffer);
      const result = await pipeline.draw(ctx, h, prepared.file, {
        providerModule: uploadProvider(buffer, info.format, upload.name, project.settings().language, assembled ? assembledProvider() : null),
      });
      if (params.page) pipeline.setPageState(root, params.page, { status: 'rendered', current_render: result.render });
      h.note(result.file);
      return result;
    }, { verb: 'draw' });

    if (params.entity) {
      return {
        entity: params.entity,
        candidate: stored.file,
        candidate_id: stored.file.split('/').pop().replace(/\.[^.]+$/, ''),
        record: stored.record,
        supplied_by: 'person',
      };
    }
    const look = ctx.services.drivers.pick('look', project.settings());
    if (!look.available) {
      ctx.skipStep('review', msg('skip.no_review_tool'));
      return { page: params.page, cover: params.cover, render: stored.render, record: stored.record, supplied_by: 'person', reviewed: false };
    }
    const review = await ctx.step('review', (h) => pipeline.reviewRender(ctx, h, { render: stored.render, supersedes: prepared.from }), { verb: 'look' });
    return Object.assign({ page: params.page, cover: params.cover, record: stored.record, supplied_by: 'person', reviewed: true }, review);
  },
};
