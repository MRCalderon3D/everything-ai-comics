'use strict';
/**
 * Screen aggregates: what each screen of the interface shows, read from the
 * workspace in one call, with image URLs ready to use. Nothing here writes.
 *
 * Mechanical findings (schema, continuity) and review verdicts are kept in
 * separate fields everywhere: the first say the files agree with each
 * other, only the second say anything about a drawing.
 */

const fs = require('fs');
const path = require('path');
const S = require('./scaffold');
const files = require('./files');
const looks = require('./looks');
const pipeline = require('./pipeline');
const projectOptions = require('./project-options');
const publish = require('./ops/publish-build');
const lettering = require('./ops/lettering-apply');
const { lookState } = require('./ops/shared');
const { HttpError } = require('./util');

const ASSET_STEM = /^(CHAR|LOC|PROP|LOOK)_[A-Z][A-Z0-9_]*_V\d{2}$/;
const SHEET_BY_TAG = { TURN: 'turnaround', EXPR: 'expressions', WARD: 'wardrobe', PLATE: 'plate', SHEET: 'prop', DETAIL: 'detail', REF: 'reference' };

function safe(fn, fallback) {
  try {
    return fn();
  } catch (err) {
    return fallback;
  }
}

function loadYamlSafe(file) {
  return safe(() => S.ws.loadYaml(file), null);
}

// --- reference images of an entity ---------------------------------------------

/** Summary of the generation record that produced a media file, or null. */
function recordSummary(root, scope, mediaRel) {
  const dir = path.join(root, 'generations', scope);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^GEN_.+\.ya?ml$/i.test(n)).sort().reverse();
  } catch (err) {
    return null;
  }
  for (const name of names) {
    const doc = loadYamlSafe(path.join(dir, name));
    if (!doc) continue;
    const media = Array.isArray(doc.media_files) ? doc.media_files.map((m) => String(m).replace(/\\/g, '/')) : [];
    if (!media.includes(mediaRel)) continue;
    return {
      id: doc.id,
      path: `generations/${scope}/${name}`,
      provider: doc.provider,
      model: doc.model,
      status: doc.status,
      created_at: doc.created_at || null,
      prompt_package: doc.prompt_package || null,
      supplied_by_person: doc.provider === 'manual',
      summary: doc.response && doc.response.summary ? doc.response.summary : null,
      notes: doc.notes || null,
    };
  }
  return null;
}

/**
 * Every reference image of an entity, from its refs directory and the
 * registry: masters (approved or superseded), candidates (drawn, waiting
 * for a decision) and references the person supplied.
 */
function entityAssets(project, entityId) {
  const root = project.root;
  const dirRel = S.assetPaths.refsDir(entityId);
  const out = { masters: [], candidates: [], references: [] };
  if (!dirRel) return out;
  const assets = S.ws.loadReferenceAssets(root);
  const promoted = new Map();
  for (const asset of assets.values()) {
    if (asset.promoted_from) promoted.set(String(asset.promoted_from), asset.id);
  }
  let names = [];
  try {
    names = fs.readdirSync(S.ws.abs(root, dirRel));
  } catch (err) {
    names = [];
  }
  const look = entityId.startsWith('LOOK_');
  for (const name of names.sort()) {
    const ext = path.extname(name).toLowerCase();
    if (!files.IMAGE_EXT.includes(ext)) continue;
    const stem = name.slice(0, -ext.length);
    if (!ASSET_STEM.test(stem)) continue;
    if (stem !== entityId && !stem.startsWith(`${entityId}_`)) continue;
    const rest = stem.slice(entityId.length + 1).replace(/_V\d{2}$/, '').replace(/^V\d{2}$/, '');
    // In references/style every look shares one directory: keep this look's files only.
    if (look && rest && !/^(MASTER|REF|DETAIL)(_|$)/.test(rest)) continue;
    const rel = `${dirRel}/${name}`;
    const registered = assets.get(stem) || null;
    const tag = rest.replace(/_?MASTER$/, '').split('_')[0];
    const sheet = look && (!tag || tag === 'MASTER') ? 'look' : (SHEET_BY_TAG[tag] || (registered && registered.kind) || 'sheet');
    const entry = {
      id: stem,
      entity: entityId,
      sheet,
      version: parseInt(stem.slice(-2), 10),
      path: rel,
      image: files.image(project, rel),
      status: registered ? registered.status : 'candidate',
      role: registered ? registered.default_role || null : null,
      approved_at: registered ? registered.approved_at || null : null,
      approved_by: registered ? registered.approved_by || null : null,
      notes: registered ? registered.notes || '' : '',
    };
    if (/_MASTER_V\d{2}$/.test(stem)) {
      out.masters.push(Object.assign(entry, {
        promoted_from: registered ? registered.promoted_from || null : null,
        superseded_by: registered ? registered.superseded_by || null : null,
      }));
    } else if (/_REF_V\d{2}$/.test(stem)) {
      out.references.push(entry);
    } else {
      out.candidates.push(Object.assign(entry, {
        promoted_to: promoted.get(stem) || null,
        generation: recordSummary(root, entityId, rel),
      }));
    }
  }
  return out;
}

/** The image that stands for an entity in a list: its approved master, else its newest candidate, else a reference. */
function entityThumb(assets) {
  const approved = assets.masters.filter((m) => m.status === 'approved');
  const pick = approved[approved.length - 1] || assets.candidates[assets.candidates.length - 1] || assets.references[0] || null;
  return pick ? pick.image : null;
}

// --- renders and reviews -----------------------------------------------------------

function reviewView(project, renderId) {
  const root = project.root;
  const file = S.ws.reviewFile(root, renderId);
  const doc = file ? loadYamlSafe(file) : null;
  if (!doc) return null;
  const findings = Array.isArray(doc.findings) ? doc.findings : [];
  return {
    path: S.ws.rel(root, file),
    verdict: doc.verdict || null,
    passes: S.ws.reviewPasses(doc),
    independent: doc.independent !== false,
    reviewer: doc.reviewer || null,
    repair_cycle: Number.isInteger(doc.repair_cycle) ? doc.repair_cycle : 0,
    reviewed_at: doc.reviewed_at || null,
    supersedes: doc.supersedes || null,
    human_approval: doc.human_approval || { status: 'pending', by: null, at: null },
    gates: doc.gates || {},
    checks: doc.checks || {},
    findings,
    open_findings: findings.filter((f) => f && f.status === 'open').length,
    change_requests: findings.filter((f) => f && f.source === 'user_request').length,
    compared_against: doc.compared_against || { references: [], neighbors: [] },
    notes: doc.notes || '',
  };
}

/** Every render of a page or a cover, oldest first, each with its review and its provenance. */
function renderList(project, owner, currentRender) {
  const root = project.root;
  return pipeline.listRendersOf(root, owner).map((id) => {
    const file = S.ws.renderFile(root, id);
    const rel = file ? S.ws.rel(root, file) : null;
    const dir = file ? path.dirname(file) : null;
    let lettered = null;
    let overlay = null;
    if (dir) {
      for (const ext of ['.png', '.jpg', '.jpeg']) {
        if (fs.existsSync(path.join(dir, `${id}.lettered${ext}`))) lettered = files.image(project, S.ws.rel(root, path.join(dir, `${id}.lettered${ext}`)));
      }
      const svg = path.join(dir, `${id}.lettered.svg`);
      if (fs.existsSync(svg)) overlay = { path: S.ws.rel(root, svg), url: files.rawUrl(project, S.ws.rel(root, svg)) };
    }
    return {
      id,
      version: parseInt(id.slice(-2), 10),
      current: id === currentRender,
      image: rel ? files.image(project, rel) : null,
      lettered,
      overlay,
      review: reviewView(project, id),
      generation: rel ? recordSummary(root, owner.id, rel) : null,
    };
  });
}

function packagesIn(project, dirRel) {
  const root = project.root;
  const dir = S.ws.abs(root, dirRel);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.ya?ml$/i.test(n)).sort();
  } catch (err) {
    return [];
  }
  return names.map((name) => {
    const pkg = loadYamlSafe(path.join(dir, name));
    if (!pkg) return null;
    return {
      path: `${dirRel}/${name}`,
      id: pkg.id || null,
      provider: pkg.provider || null,
      model: pkg.model || null,
      mode: pkg.mode || 'generate',
      prompt: pkg.prompt || '',
      negative_prompt: pkg.negative_prompt || '',
      parameters: pkg.parameters || {},
      references: (Array.isArray(pkg.references) ? pkg.references : []).map((r) => ({
        asset_id: r.asset_id, role: r.role, path: r.image_path, image: files.image(project, r.image_path),
      })),
      edit_target: pkg.edit_target ? { path: pkg.edit_target, image: files.image(project, pkg.edit_target) } : null,
      repair: pkg.repair || null,
      lettering_text: pkg.lettering_text || [],
      stale: safe(() => require(path.join(S.ROOT, 'scripts', 'generate-assets.js')).staleness(root, pkg), []),
    };
  }).filter(Boolean);
}

// --- pages ----------------------------------------------------------------------------

function nameOf(project, cache, charId) {
  if (!cache.has(charId)) {
    const doc = safe(() => S.ws.loadCharacter(project.root, charId), null);
    cache.set(charId, doc && doc.name ? doc.name : charId);
  }
  return cache.get(charId);
}

/** The short readable plan of a page: what a person approves or edits. */
function readablePlan(project, page) {
  const names = new Map();
  const panels = (Array.isArray(page.panels) ? page.panels.slice() : []).sort((a, b) => (a.order || 0) - (b.order || 0));
  const out = panels.map((panel, index) => ({
    id: panel.id,
    number: index + 1,
    size: panel.size || null,
    shot: panel.framing && panel.framing.shot_size ? panel.framing.shot_size : null,
    moment: panel.moment || '',
    location: panel.location || null,
    cast: (Array.isArray(panel.cast) ? panel.cast : []).filter((row) => row && row.character).map((row) => ({
      character: row.character,
      name: nameOf(project, names, row.character),
      off_panel: row.off_panel === true,
      action: row.action || '',
      where: row.position ? [row.position.level, row.position.landmark || row.position.side].filter(Boolean).join(', ') : '',
      holding: Array.isArray(row.holding) ? row.holding : [],
      state: Array.isArray(row.state) ? row.state : [],
    })),
    lettering: (Array.isArray(panel.lettering) ? panel.lettering : []).filter(Boolean).map((el) => ({
      id: el.id,
      type: el.type,
      speaker: el.speaker || null,
      speaker_name: el.speaker ? nameOf(project, names, el.speaker) : null,
      text: el.text,
    })),
  }));
  const lines = [`Page ${page.number}: ${page.purpose || ''}`.trim()];
  for (const p of out) {
    const who = p.cast.filter((c) => !c.off_panel).map((c) => c.name).join(', ');
    lines.push(`${p.number}. ${p.moment}${who ? ` (${who})` : ''}`);
    for (const el of p.lettering) {
      lines.push(`   ${el.speaker_name ? `${el.speaker_name}: ` : `[${el.type}] `}${el.text}`);
    }
  }
  return {
    purpose: page.purpose || '',
    grid: page.layout && page.layout.grid ? page.layout.grid : '',
    tiers: page.layout && Array.isArray(page.layout.tiers) ? page.layout.tiers : [],
    panels: out,
    text: lines.join('\n'),
  };
}

function planApproval(project, page) {
  const entry = (project.state().plan_approvals || {})[page.id] || null;
  if (!entry) return { approved: false, at: null, stale: false };
  const current = safe(() => S.pipeline.hashPage(page), null);
  return { approved: entry.hash === current, at: entry.at || null, stale: entry.hash !== current };
}

function pageSummary(project, entry, provider) {
  const root = project.root;
  const page = entry.doc;
  if (!page) {
    return { id: entry.id, number: null, broken: true, blockers: [{ code: 'page_missing', message: 'page.yaml is missing or does not parse.' }] };
  }
  const renders = S.ws.listRenders(root, entry.id);
  const current = page.current_render || renders[renders.length - 1] || null;
  const review = current ? reviewView(project, current) : null;
  const file = current ? S.ws.renderFile(root, current) : null;
  const needsDrawing = !['reviewed', 'approved'].includes(page.status);
  return {
    id: entry.id,
    number: page.number,
    scene: page.scene || null,
    purpose: page.purpose || '',
    status: page.status || null,
    panels: Array.isArray(page.panels) ? page.panels.length : 0,
    plan_approved: planApproval(project, page).approved,
    current_render: current,
    renders: renders.length,
    image: file ? files.image(project, S.ws.rel(root, file)) : null,
    verdict: review ? review.verdict : null,
    passes: review ? review.passes : false,
    flagged: !!review && !review.passes,
    open_findings: review ? review.open_findings : 0,
    repair_cycle: review ? review.repair_cycle : 0,
    independent: review ? review.independent : null,
    human_approval: review ? review.human_approval.status : null,
    blockers: needsDrawing ? pipeline.pageBlockers(root, entry.id, provider) : [],
  };
}

// --- screens ----------------------------------------------------------------------------

function projectCard(project, jobs) {
  const root = project.root;
  const doc = safe(() => S.ws.loadProject(root), null) || {};
  let pages = 0;
  let rendered = 0;
  let passed = 0;
  let cover = null;
  let firstRender = null;
  for (const issue of safe(() => S.ws.listIssues(root), [])) {
    for (const entry of safe(() => S.ws.listPages(root, issue), [])) {
      pages += 1;
      const render = entry.doc && entry.doc.current_render;
      if (!render) continue;
      rendered += 1;
      if (S.ws.reviewPasses(safe(() => S.ws.loadReview(root, render), null))) passed += 1;
      if (!firstRender) {
        const file = S.ws.renderFile(root, render);
        if (file) firstRender = files.image(project, S.ws.rel(root, file));
      }
    }
    if (!cover) {
      const coverDoc = safe(() => S.ws.loadCover(root, issue), null);
      const renders = safe(() => S.ws.listCoverRenders(root, issue), []);
      const pick = (coverDoc && coverDoc.approved_render) || renders[renders.length - 1];
      const file = pick ? S.ws.renderFile(root, pick) : null;
      if (file) cover = files.image(project, S.ws.rel(root, file));
    }
  }
  let lookImage = null;
  const state = safe(() => lookState(project), { lookId: null, master: null });
  if (state.master && state.master.path) lookImage = files.image(project, state.master.path);
  let updated = null;
  try {
    updated = fs.statSync(path.join(root, 'project.yaml')).mtime.toISOString();
    const activity = fs.statSync(project.activityFile());
    if (activity.mtime.toISOString() > updated) updated = activity.mtime.toISOString();
  } catch (err) {
    // keep what we have
  }
  return {
    id: project.id,
    title: doc.title || project.id,
    logline: doc.logline && !/^TODO/.test(doc.logline) ? doc.logline : '',
    description: project.state().description || '',
    comic_format: doc.comic_format || 'paged',
    language: doc.language || 'en',
    created_at: doc.created_at || null,
    updated_at: updated,
    image: cover || firstRender || lookImage,
    counts: { pages, rendered, passed },
    busy: jobs ? jobs.busy(project) : false,
  };
}

function styleBlockInfo(project) {
  const doc = files.readDoc(project, 'style/style-block.txt');
  const block = safe(() => S.ws.loadStyleBlock(project.root), null);
  return Object.assign(doc, {
    template: !block || /^#/m.test(block) || /<[^<>\n]+>/.test(block),
    frozen: lookState(project).frozen,
  });
}

function story(project) {
  const root = project.root;
  const bible = files.readDoc(project, 'story/story-bible.yaml');
  const data = bible.data || {};
  const written = bible.exists && typeof data.premise === 'string' && !/^TODO/i.test(data.premise) &&
    Array.isArray(data.facts) && data.facts.some((f) => f && f.statement && !/^TODO/i.test(String(f.statement)));
  return {
    written,
    description: project.state().description || '',
    bible,
    series_plan: files.readDoc(project, 'story/series-plan.yaml'),
    sources: files.listDir(project, 'story/source'),
    blocking_questions: (Array.isArray(data.open_questions) ? data.open_questions : [])
      .filter((q) => q && q.blocking === true && !q.resolution).map((q) => q.question),
    characters_named: (Array.isArray(data.characters) ? data.characters : []).map((c) => c && c.id).filter(Boolean)
      .map((id) => ({ id, has_file: !!safe(() => S.ws.loadCharacter(root, id), null) })),
    chat_key: 'story',
  };
}

function style(project) {
  const state = lookState(project);
  const assets = state.lookId ? entityAssets(project, state.lookId) : { masters: [], candidates: [], references: [] };
  const master = assets.masters.filter((m) => m.status === 'approved').pop() || null;
  return {
    presets: looks.listPresets(),
    look: {
      id: state.lookId,
      frozen: state.frozen,
      master,
      masters: assets.masters,
      candidates: assets.candidates,
      references: assets.references,
      packages: state.lookId ? packagesIn(project, 'references/style/prompts').filter((p) => p.id && p.id.includes(state.lookId)) : [],
    },
    style_bible: files.readDoc(project, 'style/style-bible.md'),
    style_block: styleBlockInfo(project),
    color_script: files.readDoc(project, 'style/color-script.md'),
    options: projectOptions.readOptions(project.root),
    choices: projectOptions.CHOICES,
    chat_key: 'style',
  };
}

function characterSummary(project, id) {
  const doc = safe(() => S.ws.loadCharacter(project.root, id), null) || {};
  const assets = entityAssets(project, id);
  const approved = assets.masters.filter((m) => m.status === 'approved');
  return {
    id,
    name: doc.name || id,
    role: doc.role || null,
    summary: doc.description && doc.description.summary ? doc.description.summary : '',
    status: doc.status || 'draft',
    file: `characters/${id}/character.yaml`,
    image: entityThumb(assets),
    has_master: approved.length > 0,
    has_identity: approved.length > 0 || assets.references.some((r) => r.status === 'approved'),
    candidates: assets.candidates.filter((c) => !c.promoted_to).length,
    references: assets.references.length,
    chat_key: `character:${id}`,
  };
}

function characters(project) {
  return {
    characters: S.ws.listEntityIds(project.root, 'characters').map((id) => characterSummary(project, id)),
    look_approved: lookState(project).frozen,
    chat_key: 'characters',
  };
}

function character(project, id) {
  const root = project.root;
  if (!/^CHAR_[A-Z][A-Z0-9_]*$/.test(id) || !fs.existsSync(path.join(root, 'characters', id))) {
    throw new HttpError(404, 'character_not_found', `${id} does not exist in this project.`);
  }
  const assets = entityAssets(project, id);
  const sheets = {};
  for (const kind of ['turnaround', 'expressions', 'wardrobe', 'detail']) {
    sheets[kind] = {
      master: assets.masters.filter((m) => m.sheet === kind && m.status === 'approved').pop() || null,
      candidates: assets.candidates.filter((c) => c.sheet === kind),
    };
  }
  const usedOn = [];
  for (const issue of S.ws.listIssues(root)) {
    for (const entry of S.ws.listPages(root, issue)) {
      const panels = entry.doc && Array.isArray(entry.doc.panels) ? entry.doc.panels : [];
      if (panels.some((p) => Array.isArray(p.cast) && p.cast.some((row) => row && row.character === id))) usedOn.push(entry.id);
    }
  }
  return Object.assign(characterSummary(project, id), {
    character: files.readDoc(project, `characters/${id}/character.yaml`),
    wardrobe: files.readDoc(project, `characters/${id}/wardrobe.yaml`),
    assets,
    sheets,
    packages: packagesIn(project, `characters/${id}/refs/prompts`),
    used_on: usedOn,
    look_approved: lookState(project).frozen,
  });
}

function entitySummary(project, kind, id) {
  const root = project.root;
  const doc = kind === 'locations' ? safe(() => S.ws.loadLocation(root, id), null) : safe(() => S.ws.loadProp(root, id), null);
  const assets = entityAssets(project, id);
  return {
    id,
    name: (doc && doc.name) || id,
    summary: doc && doc.description && doc.description.summary ? doc.description.summary : '',
    status: (doc && doc.status) || 'draft',
    file: kind === 'locations' ? `locations/${id}/location.yaml` : `props/${id}/prop.yaml`,
    image: entityThumb(assets),
    has_master: assets.masters.some((m) => m.status === 'approved'),
    candidates: assets.candidates.filter((c) => !c.promoted_to).length,
    chat_key: `${kind === 'locations' ? 'location' : 'prop'}:${id}`,
  };
}

function entities(project) {
  const root = project.root;
  return {
    locations: S.ws.listEntityIds(root, 'locations').map((id) => Object.assign(entitySummary(project, 'locations', id), {
      has_map: !!safe(() => S.ws.loadLocationMap(root, id), null),
    })),
    props: S.ws.listEntityIds(root, 'props').map((id) => entitySummary(project, 'props', id)),
    chat_key: 'places',
  };
}

function entity(project, kind, id) {
  const root = project.root;
  const prefix = kind === 'locations' ? 'LOC' : 'PROP';
  if (!new RegExp(`^${prefix}_[A-Z][A-Z0-9_]*$`).test(id) || !fs.existsSync(path.join(root, kind, id))) {
    throw new HttpError(404, 'entity_not_found', `${id} does not exist in this project.`);
  }
  const out = Object.assign(entitySummary(project, kind, id), {
    assets: entityAssets(project, id),
    packages: packagesIn(project, `${kind}/${id}/refs/prompts`),
  });
  if (kind === 'locations') {
    out.location = files.readDoc(project, `locations/${id}/location.yaml`);
    out.map = files.readDoc(project, `locations/${id}/map.yaml`);
  } else {
    out.prop = files.readDoc(project, `props/${id}/prop.yaml`);
  }
  return out;
}

function issueIds(project) {
  const root = project.root;
  const ids = new Set(safe(() => S.ws.listIssues(root), []));
  const plan = loadYamlSafe(S.ws.abs(root, 'story/series-plan.yaml'));
  for (const entry of plan && Array.isArray(plan.issues) ? plan.issues : []) {
    if (entry && S.ws.ID.issue.test(String(entry.id))) ids.add(entry.id);
  }
  return [...ids].sort();
}

function requireIssueId(project, issue) {
  if (!S.ws.ID.issue.test(String(issue)) || !issueIds(project).includes(issue)) {
    throw new HttpError(404, 'issue_not_found', `${issue} is not an issue of this project.`);
  }
}

function coverSummary(project, issue) {
  const root = project.root;
  const doc = safe(() => S.ws.loadCover(root, issue), null);
  const renders = safe(() => S.ws.listCoverRenders(root, issue), []);
  const pick = (doc && doc.approved_render) || renders[renders.length - 1] || null;
  const file = pick ? S.ws.renderFile(root, pick) : null;
  const review = pick ? reviewView(project, pick) : null;
  return {
    exists: !!doc,
    status: doc ? doc.status || 'draft' : null,
    approved_render: doc ? doc.approved_render || null : null,
    renders: renders.length,
    current_render: pick,
    image: file ? files.image(project, S.ws.rel(root, file)) : null,
    verdict: review ? review.verdict : null,
    passes: review ? review.passes : false,
  };
}

function issues(project) {
  const root = project.root;
  const plan = loadYamlSafe(S.ws.abs(root, 'story/series-plan.yaml'));
  const planned = new Map((plan && Array.isArray(plan.issues) ? plan.issues : []).filter((i) => i && i.id).map((i) => [i.id, i]));
  return {
    issues: issueIds(project).map((id) => {
      const doc = safe(() => S.ws.loadIssue(root, id), null);
      const entry = planned.get(id) || {};
      const pages = safe(() => S.ws.listPages(root, id), []);
      return {
        id,
        number: (doc && doc.number) || entry.number || parseInt(id.slice(4), 10),
        title: (doc && doc.title) || entry.title || id,
        summary: (doc && doc.summary) || entry.summary || '',
        status: (doc && doc.status) || entry.status || 'planning',
        page_budget: entry.page_budget || null,
        pages: pages.length,
        rendered: pages.filter((p) => p.doc && p.doc.current_render).length,
        passed: pages.filter((p) => p.doc && ['reviewed', 'approved'].includes(p.doc.status)).length,
        cover: coverSummary(project, id),
      };
    }),
  };
}

function issue(project, issueId, drivers) {
  requireIssueId(project, issueId);
  const root = project.root;
  const provider = pipeline.compileProvider(project, drivers);
  const draw = drivers.pick('draw', project.settings());
  const pages = S.ws.listPages(root, issueId).map((entry) => pageSummary(project, entry, provider));
  const gates = S.ws.listIssues(root).includes(issueId)
    ? pipeline.mechanical(root, issueId)
    : { continuity: [], validation: { errors: [], warnings: [] }, errors: 0 };
  const plan = loadYamlSafe(S.ws.abs(root, 'story/series-plan.yaml'));
  const planned = plan && Array.isArray(plan.issues) ? plan.issues.find((i) => i && i.id === issueId) : null;
  return {
    id: issueId,
    issue: files.readDoc(project, `issues/${issueId}/issue.yaml`),
    planned: planned || null,
    scenes: S.ws.listScenes(root, issueId).map((s) => ({
      id: s.id,
      path: S.ws.rel(root, s.file),
      summary: (s.doc && s.doc.summary) || '',
      location: (s.doc && s.doc.location) || null,
      cast: (s.doc && s.doc.cast) || [],
      pages: (s.doc && s.doc.pages) || [],
    })),
    pages,
    counts: {
      pages: pages.length,
      planned_budget: planned ? planned.page_budget : null,
      plan_approved: pages.filter((p) => p.plan_approved).length,
      rendered: pages.filter((p) => p.current_render).length,
      passed: pages.filter((p) => p.passes).length,
      flagged: pages.filter((p) => p.flagged).length,
    },
    mechanical: {
      note: 'These checks read the plan files. They say nothing about a drawing.',
      continuity: gates.continuity,
      validation: gates.validation,
      errors: gates.errors,
    },
    draw: { available: draw.available && S.providerIds().includes('codex-cli'), tool: draw.name, reason: draw.reason, look_approved: lookState(project).frozen },
    repair_limit: pipeline.repairLimit(project),
    cover: coverSummary(project, issueId),
    chat_key: `pages:${issueId}`,
  };
}

function page(project, pageId, drivers) {
  const root = project.root;
  if (!S.ws.ID.page.test(String(pageId)) || !fs.existsSync(path.join(S.ws.pageDir(root, pageId), 'page.yaml'))) {
    throw new HttpError(404, 'page_not_found', `${pageId} does not exist in this project.`);
  }
  const issueId = S.ws.issueOfPage(pageId);
  const base = `issues/${issueId}/pages/${pageId}`;
  const doc = files.readDoc(project, `${base}/page.yaml`);
  const data = doc.data && typeof doc.data === 'object' ? doc.data : null;
  const provider = pipeline.compileProvider(project, drivers);
  const gates = pipeline.mechanical(root, issueId);
  const planDoc = files.readDoc(project, `${base}/reference-plan.yaml`);
  const assets = S.ws.loadReferenceAssets(root);
  const planEntries = [];
  if (planDoc.data) {
    for (const [list, required] of [[planDoc.data.required, true], [planDoc.data.optional, false]]) {
      for (const entry of Array.isArray(list) ? list : []) {
        if (!entry || !entry.asset_id) continue;
        let rel = null;
        if (S.ws.ID.render.test(entry.asset_id)) {
          const file = S.ws.renderFile(root, entry.asset_id);
          rel = file ? S.ws.rel(root, file) : null;
        } else if (assets.get(entry.asset_id)) {
          rel = assets.get(entry.asset_id).path || null;
        }
        planEntries.push(Object.assign({}, entry, { required, image: rel ? files.image(project, rel) : null }));
      }
    }
  }
  const pagesInOrder = S.ws.listPages(root, issueId).map((p) => p.id);
  const at = pagesInOrder.indexOf(pageId);
  const project_doc = safe(() => S.ws.loadProject(root), null) || {};
  const overlayMode = project_doc.lettering && project_doc.lettering.mode === 'overlay';
  const draw = drivers.pick('draw', project.settings());
  return {
    id: pageId,
    issue: issueId,
    number: data ? data.number : null,
    status: data ? data.status : null,
    current_render: data ? data.current_render || null : null,
    page: doc,
    plan: data ? readablePlan(project, data) : null,
    plan_approval: data ? planApproval(project, data) : { approved: false, at: null, stale: false },
    renders: renderList(project, { kind: 'page', id: pageId, issue: issueId }, data ? data.current_render : null),
    prompts: packagesIn(project, `${base}/prompts`),
    reference_plan: Object.assign(planDoc, { entries: planEntries }),
    findings: {
      note: 'Mechanical checks of the plan files. A review verdict is a separate thing, under each render.',
      continuity: gates.continuity.filter((f) => f.page === pageId),
      validation: {
        errors: gates.validation.errors.filter((e) => String(e.file || '').startsWith(base)),
        warnings: gates.validation.warnings.filter((e) => String(e.file || '').startsWith(base)),
      },
      schema: doc.findings,
      blockers: data && !['reviewed', 'approved'].includes(data.status) ? pipeline.pageBlockers(root, pageId, provider) : [],
    },
    lettering: {
      mode: overlayMode ? 'overlay' : 'in_image',
      geometry: files.readDoc(project, `${base}/lettering.yaml`),
      needs_placement: overlayMode ? safe(() => lettering.needsPlacement(root, pageId), false) : false,
    },
    draw: { available: draw.available && S.providerIds().includes('codex-cli'), tool: draw.name, reason: draw.reason },
    repair_limit: pipeline.repairLimit(project),
    neighbors: { previous: at > 0 ? pagesInOrder[at - 1] : null, next: at !== -1 && at < pagesInOrder.length - 1 ? pagesInOrder[at + 1] : null },
    chat_key: `page:${pageId}`,
  };
}

function cover(project, issueId) {
  requireIssueId(project, issueId);
  const root = project.root;
  const base = `issues/${issueId}/cover`;
  const doc = files.readDoc(project, `${base}/cover.yaml`);
  const coverId = S.ws.coverIdOfIssue(issueId);
  const summary = coverSummary(project, issueId);
  return Object.assign(summary, {
    id: coverId,
    issue: issueId,
    cover: doc,
    renders: renderList(project, { kind: 'cover', id: coverId, issue: issueId }, summary.current_render),
    render_count: summary.renders,
    prompts: packagesIn(project, `${base}/prompts`),
    look_approved: lookState(project).frozen,
    chat_key: `cover:${issueId}`,
  });
}

const FORMAT_LABELS = {
  pdf: 'PDF', cbz: 'CBZ (comic reader apps)', epub: 'EPUB (fixed layout)', web: 'Web reader', images: 'Images, one per page',
};

function exportView(project, entry) {
  const root = project.root;
  const rel = String(entry.file || '').replace(/\\/g, '/');
  const file = S.ws.abs(root, rel);
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    stat = null;
  }
  const isFile = !!stat && stat.isFile();
  const web = entry.format === 'web';
  return {
    format: entry.format,
    file: rel,
    built_at: entry.built_at || null,
    exists: !!stat,
    bytes: isFile ? stat.size : null,
    draft: /-DRAFT/.test(rel),
    url: isFile ? files.rawUrl(project, rel) : null,
    download_url: isFile && !web ? `${files.rawUrl(project, rel)}?download=1` : null,
    browsable: web && isFile,
  };
}

/** The latest edition, when it ships exactly what a new one would. */
function reusedEdition(root, draft) {
  if (!draft.supersedes) return null;
  const latest = safe(() => S.ws.loadEdition(root, draft.supersedes), null);
  return latest && publish.signature(latest) === publish.signature(draft) ? draft.supersedes : null;
}

function publishScreen(project, issueId) {
  requireIssueId(project, issueId);
  const root = project.root;
  const projectDoc = safe(() => S.ws.loadProject(root), null) || {};
  const overlay = projectDoc.lettering && projectDoc.lettering.mode === 'overlay';
  const exists = S.ws.listIssues(root).includes(issueId) && !!safe(() => S.ws.loadIssue(root, issueId), null);
  const ready = exists ? publish.readiness(root, issueId) : { blockers: [{ page: null, render: null, code: 'no_pages', message: 'This issue has no pages yet.' }], edition: null, continuity_errors: 0 };
  const draft = ready.edition;
  const editions = S.ws.listEditions(root).filter((id) => id.startsWith(`ED_${issueId.slice(4)}_`)).map((id) => {
    const doc = safe(() => S.ws.loadEdition(root, id), null) || {};
    return {
      id,
      path: `editions/${id}/edition.yaml`,
      title: doc.title || id,
      label: doc.label || '',
      status: doc.status || 'draft',
      created_at: doc.created_at || null,
      supersedes: doc.supersedes || null,
      changes: doc.changes || [],
      cover: doc.cover || null,
      pages: Array.isArray(doc.pages) ? doc.pages.length : 0,
      exports: (Array.isArray(doc.exports) ? doc.exports : []).filter((e) => e && e.file).map((e) => exportView(project, e)),
    };
  }).reverse();
  return {
    issue: issueId,
    formats: S.editionFormats().map((id) => ({ id, label: FORMAT_LABELS[id] || id })),
    readiness: {
      final_possible: ready.blockers.length === 0 && !!draft && draft.pages.length > 0,
      draft_possible: !!draft && draft.pages.length > 0,
      blockers: ready.blockers,
      continuity_errors: ready.continuity_errors,
      note: 'Final means every shipped render has a passing review on file. It does not certify the drawings.',
    },
    next_edition: draft ? {
      id: draft.id,
      pages: draft.pages.map((p) => ({
        page: p.page, render: p.render, file: p.file, lettered_file: p.lettered_file || null,
        image: files.image(project, p.lettered_file || p.file),
      })),
      cover: draft.cover ? Object.assign({}, draft.cover, { image: files.image(project, draft.cover.lettered_file || draft.cover.file) }) : null,
      supersedes: draft.supersedes || null,
      changes: draft.changes || [],
      // When nothing changed since the latest edition, a build adds formats to that one.
      reuses: reusedEdition(root, draft),
    } : null,
    lettering: {
      mode: overlay ? 'overlay' : 'in_image',
      pages: overlay && draft ? draft.pages.map((p) => ({
        page: p.page,
        render: p.render,
        lettered_file: p.lettered_file || null,
        needs_placement: safe(() => lettering.needsPlacement(root, p.page), false),
      })) : [],
    },
    editions,
    chat_key: `publish:${issueId}`,
  };
}

// --- overview ---------------------------------------------------------------------------

/** Per-screen status of a project: what is done, what is next, what blocks it. */
function overview(project, services) {
  const root = project.root;
  const doc = safe(() => S.ws.loadProject(root), null) || {};
  const drivers = services.drivers;
  const storyState = story(project);
  const look = lookState(project);
  const lookAssets = look.lookId ? entityAssets(project, look.lookId) : { candidates: [] };
  const block = styleBlockInfo(project);
  const chars = characters(project).characters;
  const draw = drivers.pick('draw', project.settings());
  const provider = pipeline.compileProvider(project, drivers);
  const issueList = issues(project).issues;
  const firstIssue = issueList[0] ? issueList[0].id : 'ISS_001';
  const allPages = [];
  for (const entry of issueList) {
    for (const p of safe(() => S.ws.listPages(root, entry.id), [])) allPages.push(pageSummary(project, p, provider));
  }
  const rendered = allPages.filter((p) => p.current_render);
  const passed = allPages.filter((p) => p.passes);
  const flagged = allPages.filter((p) => p.flagged);
  const budget = issueList.reduce((sum, i) => sum + (i.page_budget || 0), 0);
  const coverState = coverSummary(project, firstIssue);
  const editions = safe(() => S.ws.listEditions(root), []);

  const screens = [];
  const add = (key, status, summary, extra = {}) => screens.push(Object.assign({ key, status, summary, blockers: [], counts: {} }, extra));

  add('story', storyState.written ? 'done' : 'todo',
    storyState.written ? 'The story bible is written.' : 'The story is not written yet.',
    {
      blockers: storyState.blocking_questions.map((q) => ({ code: 'blocking_question', message: q })),
      counts: { facts: storyState.bible.data && Array.isArray(storyState.bible.data.facts) ? storyState.bible.data.facts.length : 0 },
    });

  let styleStatus = 'todo';
  let styleSummary = 'The style is not defined yet.';
  if (look.frozen) {
    styleStatus = 'done';
    styleSummary = 'The look is approved and the style is frozen.';
  } else if (lookAssets.candidates.length) {
    styleStatus = 'in_progress';
    styleSummary = 'A look page is drawn. Approve one to freeze the style.';
  } else if (!block.template && block.exists) {
    styleStatus = 'in_progress';
    styleSummary = 'The style is written. Draw a look page next.';
  }
  add('style', styleStatus, styleSummary, { counts: { candidates: lookAssets.candidates.length } });

  const withIdentity = chars.filter((c) => c.has_identity).length;
  add('characters', !chars.length ? 'todo' : withIdentity === chars.length ? 'done' : 'in_progress',
    !chars.length ? 'No characters yet.'
      : withIdentity === chars.length ? `${chars.length} character(s), each with an approved reference.`
        : `${chars.length - withIdentity} of ${chars.length} character(s) still need an approved sheet.`,
    {
      counts: { characters: chars.length, approved: withIdentity },
      blockers: look.frozen || !chars.length ? [] : [{ code: 'look_not_approved', message: 'Character sheets are drawn in the approved look. Approve a look page first.' }],
    });

  const ent = entities(project);
  add('places', 'optional', `${ent.locations.length} place(s) and ${ent.props.length} object(s). They are written when pages are planned.`,
    { counts: { locations: ent.locations.length, props: ent.props.length } });

  const pageBlockers = [];
  if (!look.frozen) pageBlockers.push({ code: 'look_not_approved', message: 'Pages are drawn from the approved look. Approve a look page first.' });
  if (!draw.available) pageBlockers.push({ code: 'no_draw_tool', message: `${draw.reason} Pages can still be made by hand and uploaded.` });
  for (const p of allPages) {
    for (const b of p.blockers) {
      if (b.code !== 'look_missing' && b.code !== 'look_unapproved') pageBlockers.push({ code: b.code, message: b.message, page: p.id });
    }
  }
  let pagesStatus = 'todo';
  let pagesSummary = 'No pages are planned yet.';
  if (allPages.length && rendered.length === allPages.length) {
    pagesStatus = 'done';
    pagesSummary = `All ${allPages.length} page(s) are drawn.`;
  } else if (allPages.length) {
    pagesStatus = pageBlockers.length ? 'blocked' : 'in_progress';
    pagesSummary = `${allPages.length} page(s) planned, ${rendered.length} drawn.`;
  }
  add('pages', pagesStatus, pagesSummary, {
    blockers: pageBlockers.slice(0, 20),
    counts: { planned: allPages.length, budget, plan_approved: allPages.filter((p) => p.plan_approved).length, rendered: rendered.length },
  });

  add('check', !rendered.length ? 'todo' : flagged.length ? 'in_progress' : 'done',
    !rendered.length ? 'Nothing to check yet.'
      : flagged.length ? `${flagged.length} page(s) are flagged and need a look.`
        : `All ${rendered.length} drawn page(s) passed the automatic check.`,
    { counts: { passed: passed.length, flagged: flagged.length, not_independent: rendered.filter((p) => p.independent === false).length } });

  add('corrections', 'optional',
    flagged.length ? `${flagged.length} page(s) wait for a correction or a decision.` : 'Ask for a change on any drawn page.',
    { counts: { flagged: flagged.length } });

  add('cover', 'optional',
    coverState.status === 'approved' ? 'The cover is approved.'
      : coverState.renders ? 'A cover is drawn. Approve it to put it in the edition.'
        : coverState.exists ? 'The cover is written and not drawn yet.' : 'No cover yet. It is optional.',
    { counts: { renders: coverState.renders }, done: coverState.status === 'approved' });

  const publishBlockers = [];
  if (!rendered.length) publishBlockers.push({ code: 'no_renders', message: 'No page is drawn yet.' });
  add('publish', editions.length ? 'done' : publishBlockers.length ? 'blocked' : (flagged.length || rendered.length < allPages.length ? 'in_progress' : 'next'),
    editions.length ? `${editions.length} edition(s) built.`
      : publishBlockers.length ? 'Nothing to publish yet.'
        : flagged.length || rendered.length < allPages.length ? 'A draft can be built now. A final edition needs every page to pass.'
          : 'Everything is ready for a final edition.',
    { blockers: publishBlockers, counts: { editions: editions.length } });

  // The one obvious next action: the first required screen that is not done.
  const order = ['story', 'style', 'characters', 'pages', 'check', 'publish'];
  let next = null;
  for (const key of order) {
    const screen = screens.find((s) => s.key === key);
    if (screen.status === 'done') continue;
    if (key === 'characters' && screen.status === 'todo' && allPages.length) continue;
    next = { screen: key, summary: screen.summary };
    break;
  }
  for (const screen of screens) {
    if (next && screen.key === next.screen && ['todo', 'in_progress'].includes(screen.status)) screen.next = true;
  }

  return {
    project: Object.assign(projectCard(project, services.jobs), {
      publication: doc.publication || null,
      genre: doc.genre || null,
      reading_direction: doc.reading_direction || 'ltr',
      color_mode: doc.color_mode || null,
      lettering_mode: (doc.lettering && doc.lettering.mode) || 'in_image',
      page: doc.page || null,
      path: project.dir,
      workspace: project.root,
    }),
    settings: project.settings(),
    tools: drivers.assignment(project.settings()),
    screens,
    next,
    issues: issueList,
    first_issue: firstIssue,
    look: { id: look.lookId, approved: look.frozen },
    repair_limit: pipeline.repairLimit(project),
    history: { git: require('./git').isRepo(project.dir) && require('./git').detect().installed },
  };
}

module.exports = {
  entityAssets, reviewView, renderList, readablePlan, planApproval,
  projectCard, overview, story, style, characters, character, entities, entity,
  issues, issue, page, cover, publishScreen, issueIds, requireIssueId,
};
