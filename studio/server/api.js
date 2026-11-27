'use strict';
/**
 * The JSON API. Every route is documented in studio/docs/api.md; keep the
 * two in step.
 */

const fs = require('fs');
const path = require('path');
const S = require('./scaffold');
const git = require('./git');
const { msg } = require('./i18n');
const files = require('./files');
const chats = require('./chats');
const conversation = require('./conversation');
const screens = require('./screens');
const story = require('./story');
const looks = require('./looks');
const timings = require('./timings');
const history = require('./history');
const aggregates = require('./aggregates');
const projectOptions = require('./project-options');
const actions = require('./actions');
const deletion = require('./deletion');
const entities = require('./entities');
const { lookState } = require('./ops/shared');
const { Router, readBody, readJsonBody, sendFile, contentTypeOf } = require('./http');
const { resolveInside, safeName } = require('./security');
const { HttpError, nowIso } = require('./util');
const { LANGUAGES } = require('./registry');

const JSON_LIMIT = 1024 * 1024;
const FILE_SAVE_LIMIT = 3 * 1024 * 1024;
const IMAGE_UPLOAD_LIMIT = 25 * 1024 * 1024;
const TEXT_UPLOAD_LIMIT = 2 * 1024 * 1024;
const LETTERED_LIMIT = 60 * 1024 * 1024;

const UPLOAD_KINDS = {
  image: { ext: ['.png', '.jpg', '.jpeg', '.webp'], limit: IMAGE_UPLOAD_LIMIT },
  source: { ext: ['.txt', '.md', '.fountain'], limit: TEXT_UPLOAD_LIMIT },
};

const DIFF_MAX_FILES = 100;
const DIFF_TEXT_BYTES = 200 * 1024;
const DIFF_TEXT_EXT = ['.yaml', '.yml', '.md', '.txt', '.fountain', '.json', '.svg', '.html', '.xml', '.css'];

/** The web reader of an edition: editions/<ED_ID>/exports/<name>-web/. */
const WEB_READER_RE = /^editions\/ED_\d{3}_\d{2}\/exports\/[^/]+-web\//;

/**
 * Extra headers for a file of the workspace.
 *
 * An HTML or SVG file runs sandboxed, with an opaque origin: it can show
 * itself and never acts on the API as the app. That same opaque origin
 * makes its own images cross-origin requests, which the default
 * Cross-Origin-Resource-Policy (same-origin) would block. So the images of
 * an exported web reader, and only those, are sent as loadable from any
 * origin: they are copies of pages made to be published.
 */
function workspaceFileHeaders(rel, type) {
  const headers = {};
  if (/^(text\/html|image\/svg\+xml)/.test(type)) headers['Content-Security-Policy'] = 'sandbox allow-scripts';
  if (WEB_READER_RE.test(rel) && /^image\/(png|jpeg|webp|gif)$/.test(type)) {
    headers['Cross-Origin-Resource-Policy'] = 'cross-origin';
  }
  return headers;
}

function intParam(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function uploadView(project, entry) {
  return {
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    bytes: entry.bytes,
    width: entry.width || null,
    height: entry.height || null,
    at: entry.at,
    url: `/api/projects/${project.id}/uploads/${entry.id}`,
  };
}

/**
 * Build the router.
 * @param {{registry, jobs, events, drivers, ops, fake, port: () => number}} services
 */
function createApi(services) {
  const { registry, jobs, events, drivers, ops } = services;
  const router = new Router();
  const project = (ctx) => registry.get(ctx.params.id);
  const get = (pattern, handler) => router.add('GET', pattern, handler);
  const post = (pattern, handler, options) => router.add('POST', pattern, handler, options);
  const put = (pattern, handler, options) => router.add('PUT', pattern, handler, options);
  const del = (pattern, handler) => router.add('DELETE', pattern, handler);
  const P = '/api/projects/:id';

  // --- studio -----------------------------------------------------------------

  get('/api/health', async (req, res, ctx) => {
    // ?refresh=1 is a request to look again, models included; otherwise the answer is the cached one.
    if (ctx.query.get('refresh') === '1') await drivers.refreshModels();
    const tools = drivers.detect(ctx.query.get('refresh') === '1');
    const gitInfo = git.detect(ctx.query.get('refresh') === '1');
    const providers = S.providerIds();
    return {
      ok: true,
      name: 'comics-studio',
      version: S.version(),
      node: process.version,
      platform: process.platform,
      fake: !!services.fake,
      home: registry.home,
      git: gitInfo,
      tools,
      draw: {
        available: tools.codex.installed && providers.includes('codex-cli'),
        provider: providers.includes('codex-cli') ? 'codex-cli' : null,
        manual: providers.includes('manual'),
      },
      formats: S.editionFormats(),
      languages: LANGUAGES,
    };
  });

  post('/api/tools/refresh', async (req) => {
    await readJsonBody(req, JSON_LIMIT);
    await drivers.refreshModels();
    return { tools: drivers.detect(true) };
  });

  get('/api/ops', () => ({ operations: ops.catalog() }));

  get('/api/actions', () => ({ actions: actions.catalog() }));

  get('/api/schemas', () => ({ schemas: S.schemaNames() }));

  get('/api/schemas/:name', (req, res, ctx) => {
    const schema = S.loadSchema(ctx.params.name);
    if (!schema) throw new HttpError(404, 'schema_not_found', `There is no schema named "${ctx.params.name}".`);
    return { name: ctx.params.name, schema };
  });

  get('/api/presets', () => ({ presets: looks.listPresets(), choices: projectOptions.CHOICES }));

  get('/api/presets/:key/preview', (req, res, ctx) => {
    const key = ctx.params.key;
    const known = looks.KEY_RE.test(key) && fs.existsSync(path.join(looks.LOOKS_DIR, `${key}.yaml`));
    const found = known ? looks.previewFile(key) : null;
    if (!found) throw new HttpError(404, 'preview_not_found', 'That style has no sample page yet.');
    // The URL carries a version (?v=), so the image can be cached for good.
    sendFile(req, res, found.file, {
      contentType: contentTypeOf(found.file),
      headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
    });
  });

  // --- projects -----------------------------------------------------------------

  get('/api/projects', () => ({
    home: registry.home,
    projects: registry.list().map((id) => aggregates.projectCard(registry.get(id), jobs))
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))),
  }));

  post('/api/projects', async (req, res, ctx) => {
    const body = await readJsonBody(req, JSON_LIMIT);
    const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim() : '';
    if (!title || title.length > 120) throw new HttpError(400, 'bad_params', '"title" is required, at most 120 characters.');
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (description.length > 20000) throw new HttpError(400, 'bad_params', '"description" is longer than 20000 characters.');
    const format = body.format === undefined ? 'paged' : body.format;
    if (!['paged', 'webtoon'].includes(format)) throw new HttpError(400, 'bad_params', '"format" must be paged or webtoon.');
    const pages = body.pages === undefined ? 4 : body.pages;
    if (!Number.isInteger(pages) || pages < 1 || pages > 200) throw new HttpError(400, 'bad_params', '"pages" must be a whole number from 1 to 200.');
    const optionPatch = Object.assign({}, body.options && typeof body.options === 'object' ? body.options : {});
    if (body.language !== undefined) optionPatch.language = body.language;
    delete optionPatch.title;
    delete optionPatch.comic_format;
    const partial = projectOptions.checkOptions(optionPatch);
    const interfaceLanguage = LANGUAGES.includes(body.interface_language) ? body.interface_language
      : (LANGUAGES.includes(String(optionPatch.language || '').slice(0, 2)) ? String(optionPatch.language).slice(0, 2) : 'en');

    const id = registry.freeId(title);
    const dir = path.join(registry.home, id);
    fs.mkdirSync(dir, { recursive: true });
    try {
      S.createProject({ target: dir, title, format });
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new HttpError(500, 'create_failed', `The project could not be created: ${err.message}`);
    }
    const proj = registry.get(id);
    proj.ensureStudioDirs();
    // The provider prompts are compiled for: Codex when the scaffold has its provider, else the handoff.
    const allowed = ((S.loadSchema('project') || {}).properties || {}).default_providers;
    const enumList = allowed && allowed.properties && allowed.properties.image && allowed.properties.image.enum;
    const provider = S.providerIds().includes('codex-cli') && (!enumList || enumList.includes('codex-cli')) ? 'codex-cli' : 'manual';
    projectOptions.applyToProject(proj.root, Object.assign({}, partial, { default_providers: { image: provider } }));
    proj.saveSettings({ language: interfaceLanguage });
    proj.saveState({ description });
    // The person's text, an empty story bible and a one-issue plan, written mechanically. No AI runs.
    const written = story.writeStarterStory(proj, { title, description, pages });
    await git.init(dir);
    const commit = await git.commitAll(dir, `Create the project "${title}"`);
    proj.addActivity({ kind: 'project', title: msg('activity.project_created', { title }), actor: 'person', commit });
    // Deprecated: "setup": true still asks for a first draft of the story bible, as a proposal.
    let job = null;
    if (description && body.setup === true) job = jobs.enqueue(proj, 'project.setup', { description, pages });
    res.statusCode = 201;
    return { project: aggregates.projectCard(proj, jobs), job, written };
  });

  get(P, (req, res, ctx) => {
    const proj = project(ctx);
    return Object.assign(aggregates.overview(proj, services), { active_jobs: jobs.list(proj, { active: true }) });
  });

  del(P, async (req, res, ctx) => {
    const proj = project(ctx);
    if (jobs.busy(proj)) {
      if (ctx.query.get('force') !== '1') {
        throw new HttpError(409, 'project_busy', 'A job is running in this project. Cancel it first, or delete with ?force=1 to cancel and delete.');
      }
      for (const job of jobs.list(proj, { active: true })) {
        try { jobs.cancel(proj, job.id); } catch (err) { /* already over */ }
      }
      const deadline = Date.now() + 8000;
      while (jobs.busy(proj) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    }
    const name = registry.trash(proj.id);
    jobs.forget(proj.id);
    return { deleted: proj.id, trash: `.trash/${name}`, note: msg('note.trashed') };
  });

  // --- settings and options -------------------------------------------------------

  get(`${P}/settings`, (req, res, ctx) => {
    const proj = project(ctx);
    const settings = proj.settings();
    return {
      settings,
      tools: drivers.assignment(settings),
      installed: drivers.detect(),
      model_status: drivers.modelStatus(settings),
      timings: timings.averages(proj),
      choices: require('./registry').DRIVER_CHOICES,
      languages: LANGUAGES,
    };
  });

  put(`${P}/settings`, async (req, res, ctx) => {
    const proj = project(ctx);
    const body = await readJsonBody(req, JSON_LIMIT);
    proj.ensureStudioDirs();
    const settings = proj.saveSettings(body);
    return { settings, tools: drivers.assignment(settings), model_status: drivers.modelStatus(settings) };
  });

  get(`${P}/options`, (req, res, ctx) => {
    const proj = project(ctx);
    return { options: projectOptions.readOptions(proj.root), choices: projectOptions.CHOICES, project: files.readDoc(proj, 'project.yaml') };
  });

  put(`${P}/options`, async (req, res, ctx) => {
    const proj = project(ctx);
    const body = await readJsonBody(req, JSON_LIMIT);
    return actions.DIRECT['options.update'].run(services, proj, { options: body });
  });

  // --- screens ----------------------------------------------------------------------

  // Every screen answers with `screen`: { key, label, route }, what a chat message sent from it carries.
  const screenRoute = (pattern, build) => get(pattern, (req, res, ctx) => {
    const proj = project(ctx);
    const result = build(proj, ctx);
    if (result && typeof result.chat_key === 'string') {
      try {
        result.screen = screens.screenOf(proj, result.chat_key);
      } catch (err) {
        result.screen = null;
      }
    }
    return result;
  });
  screenRoute(`${P}/story`, (proj) => Object.assign(aggregates.story(proj), {
    proposals: story.list(proj, { status: 'open' }),
  }));
  screenRoute(`${P}/style`, (proj) => aggregates.style(proj));
  screenRoute(`${P}/characters`, (proj) => aggregates.characters(proj));
  screenRoute(`${P}/characters/:char`, (proj, ctx) => aggregates.character(proj, ctx.params.char));
  screenRoute(`${P}/entities`, (proj) => aggregates.entities(proj));
  screenRoute(`${P}/locations/:loc`, (proj, ctx) => aggregates.entity(proj, 'locations', ctx.params.loc));
  screenRoute(`${P}/props/:prop`, (proj, ctx) => aggregates.entity(proj, 'props', ctx.params.prop));
  screenRoute(`${P}/issues`, (proj) => aggregates.issues(proj));

  // The next issue of the series: a series-plan entry and issue.yaml, opening from where the last one ended.
  post(`${P}/issues`, async (req, res, ctx) => {
    const proj = project(ctx);
    const body = await readJsonBody(req, JSON_LIMIT);
    const def = actions.DIRECT['issue.create'];
    const result = await def.run(services, proj, def.validate(body));
    res.statusCode = 201;
    return result;
  });
  screenRoute(`${P}/issues/:issue`, (proj, ctx) => aggregates.issue(proj, ctx.params.issue, drivers, jobs));
  screenRoute(`${P}/issues/:issue/cover`, (proj, ctx) => aggregates.cover(proj, ctx.params.issue));
  screenRoute(`${P}/issues/:issue/publish`, (proj, ctx) => aggregates.publishScreen(proj, ctx.params.issue));
  screenRoute(`${P}/pages/:page`, (proj, ctx) => aggregates.page(proj, ctx.params.page, drivers, jobs));

  // --- text artifacts ------------------------------------------------------------------

  get(`${P}/file`, (req, res, ctx) => {
    const proj = project(ctx);
    const rel = ctx.query.get('path');
    if (!rel) throw new HttpError(400, 'bad_path', 'Give the file as ?path=<workspace-relative path>.');
    files.checkWritable(proj, rel);
    return { file: files.readDoc(proj, rel) };
  });

  put(`${P}/file`, async (req, res, ctx) => {
    const proj = project(ctx);
    const body = await readJsonBody(req, FILE_SAVE_LIMIT);
    const { clean, file } = files.checkWritable(proj, body.path);
    let text;
    if (typeof body.text === 'string') text = body.text.replace(/\r\n/g, '\n');
    else if (body.data !== undefined && files.kindOf(clean) === 'yaml') {
      if (!body.data || typeof body.data !== 'object') throw new HttpError(400, 'bad_params', '"data" must be an object or a list.');
      const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const header = before && S.yamlEdit ? S.yamlEdit.leadingComments(before) : '';
      text = header + S.yaml.stringify(body.data);
    } else {
      throw new HttpError(400, 'bad_params', 'Send "text", or "data" for a YAML file.');
    }
    if (Buffer.byteLength(text) > files.MAX_TEXT_BYTES) throw new HttpError(413, 'too_large', 'The text is too large.');
    if (clean === 'style/style-block.txt' && lookState(proj).frozen) {
      throw new HttpError(409, 'style_frozen', 'The style block is frozen: a look master is approved and every page depends on these exact words.');
    }
    const existed = fs.existsSync(file);
    if (body.base_etag !== undefined && body.base_etag !== null && existed) {
      const current = files.etagOf(fs.statSync(file));
      if (current !== body.base_etag) {
        throw new HttpError(409, 'file_changed', 'The file changed since it was opened. Reload it and apply the change again.', { etag: current });
      }
    }
    const checked = files.checkText(clean, text);
    const saved = await history.record(services, proj, { kind: 'save', title: msg('activity.edited', { path: clean }), scope: [clean] }, () => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
    });
    // Continuity findings for the page or issue the file belongs to, so a
    // ledger mistake shows up on save.
    let continuity = [];
    const m = /^issues\/(ISS_\d{3})\//.exec(clean);
    if (m && S.ws.listIssues(proj.root).includes(m[1])) {
      const pageId = (/\/pages\/(PG_\d{3}_\d{3})\//.exec(clean) || [])[1] || null;
      try {
        continuity = S.checkContinuity(proj.root, { issue: m[1] }).findings.filter((f) => !pageId || f.page === pageId);
      } catch (err) {
        continuity = [];
      }
    }
    return {
      saved: saved.changes.length > 0,
      file: files.readDoc(proj, clean),
      findings: checked.findings,
      continuity,
      commit: saved.commit,
      created: !existed,
    };
  }, { bodyLimit: FILE_SAVE_LIMIT });

  // --- raw files -----------------------------------------------------------------------

  router.add('GET', `${P}/raw/*path`, (req, res, ctx) => {
    const proj = project(ctx);
    const rel = ctx.params.path;
    if (rel.split('/').some((part) => part.startsWith('.'))) throw new HttpError(404, 'not_found', 'File not found.');
    const file = resolveInside(proj.root, rel);
    const type = contentTypeOf(file);
    sendFile(req, res, file, { download: ctx.query.get('download') === '1', headers: workspaceFileHeaders(rel, type) });
  });

  // --- earlier states: what a commit changed, and a file as it was -------------------------

  const requireHistory = (proj) => {
    if (!git.detect().installed) throw new HttpError(409, 'history_unavailable', 'git is not installed on this machine.', undefined, {});
    if (!git.isRepo(proj.dir)) throw new HttpError(409, 'history_unavailable', 'This project has no history repository.');
  };

  get(`${P}/diff`, async (req, res, ctx) => {
    const proj = project(ctx);
    requireHistory(proj);
    const one = ctx.query.get('commit');
    let from;
    let to;
    if (one) {
      to = await git.resolveCommit(proj.dir, one);
      if (!to) throw new HttpError(404, 'commit_not_found', 'That commit is not in this project\'s history.');
      from = await git.parentOf(proj.dir, to);
    } else {
      if (!ctx.query.get('from') || !ctx.query.get('to')) {
        throw new HttpError(400, 'bad_params', 'Give ?commit=<id>, or ?from=<id>&to=<id>.');
      }
      from = await git.resolveCommit(proj.dir, ctx.query.get('from'));
      to = await git.resolveCommit(proj.dir, ctx.query.get('to'));
      if (!from || !to) throw new HttpError(404, 'commit_not_found', 'That commit is not in this project\'s history.');
    }
    const all = (await git.changedBetween(proj.dir, from, to))
      .filter((c) => c.path.startsWith('production/'))
      .map((c) => ({ path: c.path.slice('production/'.length), status: c.status }))
      .filter((c) => !c.path.split('/').some((part) => part.startsWith('.')));
    const limit = intParam(ctx.query.get('limit'), DIFF_MAX_FILES, 1, DIFF_MAX_FILES);
    const filesOut = [];
    for (const change of all.slice(0, limit)) {
      const ext = path.extname(change.path).toLowerCase();
      const kind = DIFF_TEXT_EXT.includes(ext) ? 'text' : files.IMAGE_EXT.includes(ext) ? 'image' : 'other';
      const entry = { path: change.path, status: change.status, kind, before: null, after: null, before_url: null, after_url: null };
      const sides = [['before', from, change.status !== 'added'], ['after', to, change.status !== 'deleted']];
      for (const [side, commit, present] of sides) {
        if (!present || commit === git.EMPTY_TREE) continue;
        entry[`${side}_url`] = `/api/projects/${proj.id}/at/${commit}/raw/${change.path.split('/').map(encodeURIComponent).join('/')}`;
        if (kind !== 'text') continue;
        const got = await git.fileAt(proj.dir, commit, `production/${change.path}`, DIFF_TEXT_BYTES * 8);
        if (!got) continue;
        if (got.tooLarge) {
          entry[side] = { text: '', bytes: got.bytes, truncated: true };
        } else {
          const whole = got.buffer.toString('utf8').replace(/\r\n/g, '\n');
          entry[side] = { text: whole.slice(0, DIFF_TEXT_BYTES), bytes: got.bytes, truncated: whole.length > DIFF_TEXT_BYTES };
        }
      }
      filesOut.push(entry);
    }
    return { from: from === git.EMPTY_TREE ? null : from, to, files: filesOut, total: all.length, more: all.length > filesOut.length };
  });

  router.add('GET', `${P}/at/:commit/raw/*path`, async (req, res, ctx) => {
    const proj = project(ctx);
    requireHistory(proj);
    const rel = ctx.params.path;
    const parts = rel.split('/');
    if (!rel || rel.includes('\0') || rel.includes('\\') || parts.some((part) => !part || part === '..' || part.startsWith('.'))) {
      throw new HttpError(404, 'not_found', 'File not found.');
    }
    const commit = await git.resolveCommit(proj.dir, ctx.params.commit);
    if (!commit) throw new HttpError(404, 'commit_not_found', 'That commit is not in this project\'s history.');
    const got = await git.fileAt(proj.dir, commit, `production/${rel}`);
    if (!got) throw new HttpError(404, 'not_found', 'File not found.');
    if (got.tooLarge) throw new HttpError(413, 'too_large', 'The file is too large to serve from the history.');
    const type = contentTypeOf(rel);
    const headers = Object.assign({
      'Content-Type': type,
      'Content-Length': got.buffer.length,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      // A file at a commit never changes.
      'Cache-Control': 'private, max-age=31536000, immutable',
    }, workspaceFileHeaders(rel, type));
    if (ctx.query.get('download') === '1') {
      headers['Content-Disposition'] = `attachment; filename="${path.basename(rel).replace(/[^A-Za-z0-9._-]+/g, '_')}"`;
    }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : got.buffer);
    return undefined;
  });

  // --- uploads ---------------------------------------------------------------------------

  get(`${P}/uploads`, (req, res, ctx) => {
    const proj = project(ctx);
    return { uploads: proj.uploads().map((u) => uploadView(proj, u)).reverse() };
  });

  post(`${P}/uploads`, async (req, res, ctx) => {
    const proj = project(ctx);
    const name = safeName(ctx.query.get('name') || '', '');
    const ext = path.extname(name).toLowerCase();
    const kind = Object.keys(UPLOAD_KINDS).find((k) => UPLOAD_KINDS[k].ext.includes(ext));
    if (!name || !kind) {
      throw new HttpError(415, 'unsupported_file', 'Uploads take images (png, jpg, jpeg, webp) and text sources (txt, md, fountain). Give the file name as ?name=.');
    }
    const body = await readBody(req, UPLOAD_KINDS[kind].limit);
    if (!body.length) throw new HttpError(400, 'empty_upload', 'The upload is empty.');
    const meta = { name, kind, bytes: body.length };
    if (kind === 'image') {
      let info;
      try {
        info = S.imageInfo(body);
      } catch (err) {
        throw new HttpError(415, 'not_an_image', 'The file is not a PNG, JPEG or WebP image.');
      }
      const matches = { png: ['.png'], jpeg: ['.jpg', '.jpeg'], webp: ['.webp'] }[info.format] || [];
      if (!matches.includes(ext)) {
        throw new HttpError(415, 'not_an_image', `The file is a ${String(info.format).toUpperCase()} image and its name ends in ${ext}.`);
      }
      meta.width = info.width;
      meta.height = info.height;
      meta.format = info.format;
    } else if (body.includes(0)) {
      throw new HttpError(415, 'not_text', 'The file does not look like text.');
    }
    const entry = proj.addUpload(meta, body);
    res.statusCode = 201;
    return { upload: uploadView(proj, entry) };
  }, { rawBody: true });

  get(`${P}/uploads/:upload`, (req, res, ctx) => {
    const proj = project(ctx);
    const entry = proj.upload(ctx.params.upload);
    if (!entry) throw new HttpError(404, 'upload_not_found', 'There is no upload with that id.');
    sendFile(req, res, proj.uploadFile(entry), { contentType: contentTypeOf(entry.name), downloadName: entry.name });
  });

  del(`${P}/uploads/:upload`, (req, res, ctx) => {
    const proj = project(ctx);
    if (!proj.upload(ctx.params.upload)) throw new HttpError(404, 'upload_not_found', 'There is no upload with that id.');
    // An upload a queued or running job still reads stays until the job is over.
    const [checked] = deletion.plan(proj, services, [{ kind: 'upload', id: ctx.params.upload }]);
    if (checked.refused) throw new HttpError(409, 'delete_refused', 'The upload is in use.', { items: [deletion.publicView(checked)] }, { reasons: [checked.refused.message] });
    proj.removeUpload(ctx.params.upload);
    return { deleted: ctx.params.upload };
  });

  // --- deleting what the person does not want to keep ------------------------------------------

  // What a delete would remove, or why it is refused. Nothing is written.
  post(`${P}/delete/check`, async (req, res, ctx) => {
    const proj = project(ctx);
    const body = await readJsonBody(req, JSON_LIMIT);
    const clean = actions.DIRECT.delete.validate(body);
    return { items: deletion.plan(proj, services, clean.items).map(deletion.publicView) };
  });

  post(`${P}/delete`, async (req, res, ctx) => {
    const proj = project(ctx);
    const body = await readJsonBody(req, JSON_LIMIT);
    return actions.DIRECT.delete.run(services, proj, body);
  });

  // The unused tries of a screen, ready to delete in one go.
  get(`${P}/cleanup`, (req, res, ctx) => {
    const proj = project(ctx);
    const scope = ctx.query.get('scope') || '';
    return { scope, items: deletion.cleanup(proj, services, scope) };
  });

  // --- characters, places and objects: merge two into one, or rename an ID ------------------------

  post(`${P}/entities/merge`, async (req, res, ctx) => {
    const proj = project(ctx);
    const body = await readJsonBody(req, JSON_LIMIT);
    const def = actions.DIRECT['entity.merge'];
    return def.run(services, proj, def.validate(body));
  });

  post(`${P}/entities/rename`, async (req, res, ctx) => {
    const proj = project(ctx);
    const body = await readJsonBody(req, JSON_LIMIT);
    const def = actions.DIRECT['entity.rename'];
    return def.run(services, proj, def.validate(body));
  });

  // --- operations and jobs -----------------------------------------------------------------

  post(`${P}/ops`, async (req, res, ctx) => {
    const proj = project(ctx);
    const body = await readJsonBody(req, JSON_LIMIT);
    if (typeof body.op !== 'string') throw new HttpError(400, 'bad_params', 'Send { "op": "<operation name>", "params": { ... } }.');
    if (body.op === 'chat.turn') throw new HttpError(400, 'bad_params', 'Send chat messages to POST /chats/<key>.');
    const job = jobs.enqueue(proj, body.op, body.params && typeof body.params === 'object' ? body.params : {});
    res.statusCode = 202;
    return { job };
  });

  get(`${P}/jobs`, (req, res, ctx) => {
    const proj = project(ctx);
    return {
      jobs: jobs.list(proj, { limit: intParam(ctx.query.get('limit'), 50, 1, 500), active: ctx.query.get('active') === '1' }),
      running: jobs.running(proj),
    };
  });

  get(`${P}/jobs/:job`, (req, res, ctx) => {
    const proj = project(ctx);
    const job = jobs.get(proj, ctx.params.job);
    const tail = intParam(ctx.query.get('log'), 0, 0, 5000);
    return tail ? { job, log: jobs.readLog(proj, ctx.params.job, tail) } : { job };
  });

  get(`${P}/jobs/:job/log`, (req, res, ctx) => {
    const proj = project(ctx);
    return { job: ctx.params.job, lines: jobs.readLog(proj, ctx.params.job, intParam(ctx.query.get('tail'), 0, 0, 20000)) };
  });

  post(`${P}/jobs/:job/cancel`, async (req, res, ctx) => {
    const proj = project(ctx);
    await readJsonBody(req, JSON_LIMIT);
    return actions.DIRECT['job.cancel'].run(services, proj, { job: ctx.params.job });
  });

  post(`${P}/jobs/:job/answer`, async (req, res, ctx) => {
    const proj = project(ctx);
    const body = await readJsonBody(req, JSON_LIMIT);
    return actions.DIRECT['job.answer'].run(services, proj, { job: ctx.params.job, answers: body.answers });
  });

  // --- events ------------------------------------------------------------------------------

  get(`${P}/events`, (req, res, ctx) => {
    const proj = project(ctx);
    events.subscribe(proj.id, req, res, { project: proj.id, at: nowIso(), jobs: jobs.list(proj, { active: true }) }, ctx.query.get('lang'));
    return undefined;
  });

  // --- chat ----------------------------------------------------------------------------------

  // The project conversation: one per project, every message tagged with its screen.
  const conversationView = (proj, entry) => {
    const pending = jobs.list(proj, { active: true }).filter((j) => j.op === 'chat.turn' && j.params && j.params.conversation === entry.id);
    const index = conversation.ensure(proj);
    return {
      id: entry.id,
      started_at: entry.started_at,
      current: index.current === entry.id,
      session: entry.session ? { tool: entry.session.tool } : null,
      folded: entry.folded || [],
      messages: conversation.messages(proj, entry.id),
      pending: pending.map((j) => j.id),
    };
  };

  /** Store the person's message and queue the reply. */
  const sendMessage = (proj, screen, text, attachments = []) => {
    proj.ensureStudioDirs();
    const entry = conversation.current(proj);
    // Checked before the message is stored, so a bad attachment id stores nothing.
    const turn = ops.get('chat.turn');
    const clean = turn.validate({ screen, text, conversation: entry.id, attachments }, { project: proj, services });
    const message = conversation.append(proj, entry.id, {
      role: 'user', text, screen, key: screen.key,
      attachments: clean.attachments.length ? turn.attachmentViews(proj, clean.attachments) : undefined,
    });
    const job = jobs.enqueue(proj, 'chat.turn', { screen, text, message: message.id, conversation: entry.id, attachments: clean.attachments });
    events.emit(proj.id, 'chat', { conversation: entry.id, key: screen.key, message });
    return { message, job };
  };

  const messageText = (body) => {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > 8000) throw new HttpError(400, 'bad_params', '"text" is required, at most 8000 characters.');
    return text;
  };

  get(`${P}/conversation`, (req, res, ctx) => {
    const proj = project(ctx);
    return { conversation: conversationView(proj, conversation.current(proj)), conversations: conversation.list(proj) };
  });

  post(`${P}/conversation`, async (req, res, ctx) => {
    const proj = project(ctx);
    const body = await readJsonBody(req, JSON_LIMIT);
    const text = messageText(body);
    const screen = screens.checkScreen(proj, body.screen);
    const sent = sendMessage(proj, screen, text, body.attachments === undefined ? [] : body.attachments);
    res.statusCode = 202;
    return Object.assign({ conversation: sent.message.conversation }, sent);
  });

  // An action card of a reply: run it (queue its job, or make its decision now), or dismiss it.
  post(`${P}/conversation/:conversation/actions/:card/run`, async (req, res, ctx) => {
    const proj = project(ctx);
    await readJsonBody(req, JSON_LIMIT);
    const entry = conversation.get(proj, ctx.params.conversation);
    return actions.runCard(services, proj, entry.id, ctx.params.card, { by: 'click' });
  });

  post(`${P}/conversation/:conversation/actions/:card/dismiss`, async (req, res, ctx) => {
    const proj = project(ctx);
    await readJsonBody(req, JSON_LIMIT);
    const entry = conversation.get(proj, ctx.params.conversation);
    return { card: actions.dismissCard(services, proj, entry.id, ctx.params.card) };
  });

  post(`${P}/conversation/new`, async (req, res, ctx) => {
    const proj = project(ctx);
    await readJsonBody(req, JSON_LIMIT);
    proj.ensureStudioDirs();
    const entry = conversation.start(proj);
    res.statusCode = 201;
    return { conversation: conversationView(proj, entry), conversations: conversation.list(proj) };
  });

  get(`${P}/conversations`, (req, res, ctx) => ({ conversations: conversation.list(project(ctx)) }));

  get(`${P}/conversations/:conversation`, (req, res, ctx) => {
    const proj = project(ctx);
    return { conversation: conversationView(proj, conversation.get(proj, ctx.params.conversation)) };
  });

  // Deprecated: the chats per screen. They read the project conversation, filtered by screen.
  get(`${P}/chats`, (req, res, ctx) => ({ chats: conversation.screensUsed(project(ctx)) }));

  get(`${P}/chats/:key`, (req, res, ctx) => {
    const proj = project(ctx);
    const context = chats.contextOf(proj, ctx.params.key);
    const pending = jobs.list(proj, { active: true }).filter((j) => j.op === 'chat.turn' && j.params && j.params.key === ctx.params.key);
    return {
      key: context.key,
      screen: context.screen,
      files: context.files,
      conversation: conversation.current(proj).id,
      messages: conversation.byScreen(proj, ctx.params.key),
      pending: pending.map((j) => j.id),
    };
  });

  post(`${P}/chats/:key`, async (req, res, ctx) => {
    const proj = project(ctx);
    const body = await readJsonBody(req, JSON_LIMIT);
    const text = messageText(body);
    const screen = screens.checkScreen(proj, ctx.params.key);
    res.statusCode = 202;
    return sendMessage(proj, screen, text);
  });

  // --- proposals: story text the AI suggests, decided part by part ----------------------------------

  get(`${P}/proposals`, (req, res, ctx) => {
    const status = ctx.query.get('status');
    if (status && !['open', 'closed', 'discarded'].includes(status)) {
      throw new HttpError(400, 'bad_params', '"status" must be open, closed or discarded.');
    }
    return { proposals: story.list(project(ctx), { status: status || undefined }) };
  });

  get(`${P}/proposals/:proposal`, (req, res, ctx) => ({ proposal: story.view(story.read(project(ctx), ctx.params.proposal)) }));

  post(`${P}/proposals/:proposal/decide`, async (req, res, ctx) => {
    const proj = project(ctx);
    const body = await readJsonBody(req, JSON_LIMIT);
    return actions.DIRECT['proposal.decide'].run(services, proj, { proposal: ctx.params.proposal, decisions: body.decisions });
  });

  del(`${P}/proposals/:proposal`, (req, res, ctx) => {
    return actions.DIRECT['proposal.discard'].run(services, project(ctx), { proposal: ctx.params.proposal });
  });

  // --- history -----------------------------------------------------------------------------------

  get(`${P}/history`, async (req, res, ctx) => {
    const proj = project(ctx);
    const all = proj.activity();
    const limit = intParam(ctx.query.get('limit'), 100, 1, 1000);
    const before = ctx.query.get('before');
    let start = 0;
    if (before) {
      const at = all.findIndex((e) => e.id === before);
      start = at === -1 ? 0 : at + 1;
    }
    const gitOk = git.detect().installed && git.isRepo(proj.dir);
    const known = gitOk ? new Set((await git.log(proj.dir, 2000)).map((c) => c.id)) : new Set();
    const entries = all.slice(start, start + limit).map((entry) => Object.assign({}, entry, {
      restorable: !!entry.commit && known.has(entry.commit),
      images: (entry.images || []).map((rel) => files.image(proj, rel) || { path: rel, url: null, missing: true }),
    }));
    return {
      entries,
      total: all.length,
      more: start + limit < all.length,
      restore: {
        available: gitOk,
        reason: gitOk ? null : msg(git.detect().installed ? 'reason.no_repository' : 'reason.no_git'),
      },
    };
  });

  post(`${P}/history/restore`, async (req, res, ctx) => {
    const proj = project(ctx);
    const body = await readJsonBody(req, JSON_LIMIT);
    let commit = typeof body.commit === 'string' ? body.commit : null;
    if (!commit && typeof body.entry === 'string') {
      const entry = proj.activity().find((e) => e.id === body.entry);
      if (!entry) throw new HttpError(404, 'entry_not_found', 'There is no history entry with that id.');
      if (!entry.commit) throw new HttpError(409, 'entry_not_restorable', 'That entry changed no files, so there is no state to go back to.');
      commit = entry.commit;
    }
    if (!commit) throw new HttpError(400, 'bad_params', 'Send { "entry": "<history entry id>" } or { "commit": "<commit id>" }.');
    return history.restore(services, proj, commit);
  });

  // --- approvals ----------------------------------------------------------------------------------

  post(`${P}/approve/asset`, async (req, res, ctx) => {
    const proj = project(ctx);
    const body = await readJsonBody(req, JSON_LIMIT);
    return actions.DIRECT['approve.asset'].run(services, proj, body);
  });

  post(`${P}/approve/plan`, async (req, res, ctx) => {
    const proj = project(ctx);
    const body = await readJsonBody(req, JSON_LIMIT);
    return actions.DIRECT['approve.plan'].run(services, proj, body);
  });

  post(`${P}/approve/page`, async (req, res, ctx) => {
    const proj = project(ctx);
    const body = await readJsonBody(req, JSON_LIMIT);
    return actions.DIRECT['approve.page'].run(services, proj, body);
  });

  post(`${P}/approve/cover`, async (req, res, ctx) => {
    const proj = project(ctx);
    const body = await readJsonBody(req, JSON_LIMIT);
    return actions.DIRECT['approve.cover'].run(services, proj, body);
  });

  // --- overlay lettering ---------------------------------------------------------------------------

  get(`${P}/pages/:page/lettering`, (req, res, ctx) => {
    const proj = project(ctx);
    const root = proj.root;
    const pageId = ctx.params.page;
    const page = S.ws.ID.page.test(pageId) ? S.ws.loadPage(root, pageId) : null;
    if (!page) throw new HttpError(404, 'page_not_found', `${pageId} does not exist in this project.`);
    const render = ctx.query.get('render') || page.current_render || null;
    const result = S.letterPage(path.join(S.ws.pageDir(root, pageId), 'page.yaml'), { render: render || undefined, embed: true, write: false });
    const size = result.svg ? (/<svg[^>]*\swidth="([\d.]+)"[^>]*\sheight="([\d.]+)"/.exec(result.svg) || []) : [];
    return {
      page: pageId,
      render: result.render,
      ok: result.ok,
      svg: result.svg,
      width: size[1] ? Number(size[1]) : null,
      height: size[2] ? Number(size[2]) : null,
      elements: result.elements,
      errors: result.errors,
      warnings: result.warnings,
      note: msg('note.lettering_svg'),
    };
  });

  post(`${P}/pages/:page/lettered`, async (req, res, ctx) => {
    const proj = project(ctx);
    const root = proj.root;
    const pageId = ctx.params.page;
    const page = S.ws.ID.page.test(pageId) ? S.ws.loadPage(root, pageId) : null;
    if (!page) throw new HttpError(404, 'page_not_found', `${pageId} does not exist in this project.`);
    const render = ctx.query.get('render') || page.current_render || null;
    if (!render || S.ws.pageOfRender(render) !== pageId) throw new HttpError(400, 'bad_params', 'Give the render the image was made from as ?render=.');
    const body = await readBody(req, LETTERED_LIMIT);
    let info;
    try {
      info = S.imageInfo(body);
    } catch (err) {
      throw new HttpError(415, 'not_an_image', 'Send the lettered page as a PNG or JPEG image.');
    }
    if (!['png', 'jpeg'].includes(info.format)) throw new HttpError(415, 'not_an_image', 'Send the lettered page as a PNG or JPEG image.');
    let result;
    const saved = await history.record(services, proj, {
      kind: 'lettering', title: msg('activity.lettered', { page: pageId }),
      scope: [S.ws.rel(root, S.ws.pageDir(root, pageId)), 'editions'],
    }, () => {
      try {
        result = S.registerLetteredFile({ root, page: pageId, render, file: body });
      } catch (err) {
        throw new HttpError(409, typeof err.code === 'string' ? err.code : 'lettering_failed', err.message);
      }
    });
    res.statusCode = 201;
    return { page: pageId, render: result.render || render, path: result.path, image: files.image(proj, result.path), editions: result.editions || [], commit: saved.commit };
  }, { rawBody: true });

  return router;
}

module.exports = { createApi, JSON_LIMIT, UPLOAD_KINDS };
