'use strict';
/**
 * The fake driver (STUDIO_FAKE_AI=1). It has the interface of the real
 * drivers and takes their place, so every operation runs its real code path
 * with no CLI: prompt building, the headless contract, validation, review
 * writing, commits. Each call finishes in a few milliseconds.
 *
 * It writes small, valid workspace files shaped like the templates and the
 * example workspace (examples/the-night-ferry). They are placeholders, not
 * writing: the point is that validate-workspace.js and check-continuity.js
 * accept them.
 *
 * Words in the person's text change what it does, for tests and for trying
 * the interface:
 *   DECIDE      the step stops with a question, until an answer is given
 *   FAILAI      the step reports a failure
 *   SLOW        the step takes STUDIO_FAKE_SLOW_MS (default 3000 ms)
 *   FLAG        the first review of a page or cover whose text has the word
 *               is flagged with one blocking finding; the repair passes
 *   FLAGALWAYS  every review of it is flagged, repairs included
 *   UPSTREAM    the flagged review says a repair cannot fix it
 *   NOTE        the first review of it lists one minor finding: the page
 *               passes with a note and no repair is tried
 *   EDIT        (chat) the reply also changes the screen's first file
 */

const fs = require('fs');
const path = require('path');
const { SCAFFOLD_ROOT, sleep, today, idToken } = require('../util');

const ws = require(path.join(SCAFFOLD_ROOT, 'scripts', 'lib', 'workspace.js'));
const yaml = require(path.join(SCAFFOLD_ROOT, 'scripts', 'lib', 'yaml.js'));

const CHECKS = ['identity', 'cast_count', 'position', 'movement', 'role_causality', 'object_identity',
  'object_custody', 'physical_state', 'wardrobe', 'spatial_logic', 'drawing_clarity', 'lettering',
  'page_structure', 'style_fidelity'];

let sessions = 0;

function has(text, word) {
  return new RegExp(`\\b${word}\\b`).test(String(text || ''));
}

function write(root, rel, text, written) {
  const file = ws.abs(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (written && !written.includes(rel)) written.push(rel);
}

function writeYaml(root, rel, doc, written, header) {
  write(root, rel, `${header ? `# ${header}\n\n` : ''}${yaml.stringify(doc)}`, written);
}

function firstSentence(text, max = 160) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(clean);
  const sentence = (m ? m[1] : clean) || 'A comic.';
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}.` : sentence;
}

/** Split a text into `count` parts on sentence ends, never leaving a part empty. */
function splitText(text, count) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim() || 'Something happens.';
  const sentences = clean.match(/[^.!?]+[.!?]*/g).map((s) => s.trim()).filter(Boolean);
  const parts = [];
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * sentences.length) / count);
    const to = Math.floor(((i + 1) * sentences.length) / count);
    parts.push(sentences.slice(from, Math.max(to, from + 1)).join(' ') || sentences[sentences.length - 1]);
  }
  return parts;
}

function words(text, max) {
  const list = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  return list.slice(0, max).join(' ') || 'Here.';
}

function setProjectLine(root, key, rendered) {
  const file = path.join(root, 'project.yaml');
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const re = new RegExp(`^(${key}:[^\\n#]*)(#.*)?$`, 'm');
  if (!re.test(text)) return false;
  fs.writeFileSync(file, text.replace(re, (m, head, comment) => {
    const line = `${key}: ${rendered}`;
    return comment ? line.padEnd(Math.max(head.length, line.length + 1)) + comment : line;
  }));
  return true;
}

function characterIds(root) {
  return ws.listEntityIds(root, 'characters').filter((id) => ws.loadCharacter(root, id));
}

// --- handlers: one per prompt template ----------------------------------------

const handlers = {
  // A proposal, never a file: the run is read-only.
  'story.propose'(task, out) {
    const { root, vars } = task;
    const sources = (vars.source_list || []).map((rel) => {
      try {
        return { rel, text: fs.readFileSync(ws.abs(root, rel), 'utf8').replace(/^#.*\n+/, '') };
      } catch (err) {
        return { rel, text: '' };
      }
    });
    const first = sources[0] || { rel: null, text: '' };
    const sentences = String(first.text).replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]*/g) || [];
    const bible = ws.loadYaml(ws.abs(root, 'story/story-bible.yaml')) || {};
    const chars = characterIds(root);
    const proposal = {};
    if (vars.mode === 'draft') {
      proposal.premise = firstSentence(first.text || 'A comic.', 300);
      proposal.tone = 'Plain and direct.';
      proposal.world_rules = ['Placeholder rule from the fake assistant: nothing happens that the text does not say.'];
      proposal.facts = sentences.slice(0, 3).map((s) => ({ statement: s.trim(), provenance: 'source', source_ref: `${first.rel}#p1`, affects: [] }));
      proposal.facts.push({ statement: 'Placeholder addition: the story is told in one issue.', provenance: 'addition', affects: [] });
      if (chars[0]) proposal.arcs = [{ character: chars[0], role: 'protagonist', arc: 'Placeholder arc: from keeping out of it to taking a side.' }];
      proposal.timeline = sentences.slice(0, 2).map((s, i) => ({ order: i + 1, event: s.trim(), issue: 'ISS_001' }));
      proposal.questions = [{ question: 'The text does not say how it ends. How should it end?', blocking: false, options: [] }];
    } else if (vars.mode === 'complete') {
      if (!bible.tone) proposal.tone = 'Plain and direct.';
      if (!Array.isArray(bible.world_rules) || !bible.world_rules.length) proposal.world_rules = ['Placeholder rule from the fake assistant.'];
      if (!Array.isArray(bible.timeline) || !bible.timeline.length) proposal.timeline = [{ order: 1, event: firstSentence(first.text || bible.premise || 'Something happens.', 200), issue: 'ISS_001' }];
      proposal.questions = [{ question: 'Placeholder question: what does the main character want?', blocking: false, options: [] }];
    } else {
      proposal.facts = [{ statement: `Placeholder addition for the request: ${words(vars.instruction, 20)}`, provenance: 'addition', affects: [] }];
      proposal.timeline = [{ order: 1, event: `Placeholder event for the request: ${words(vars.instruction, 20)}`, issue: 'ISS_001' }];
      proposal.questions = [{ question: 'Placeholder question: is this the direction you want?', blocking: false, options: ['Yes', 'No'] }];
    }
    out.data.proposal = proposal;
    out.summary = `This is the fake assistant. It proposes ${Object.keys(proposal).length} kind(s) of story text for you to accept or reject.`;
  },

  'story.update'(task, out) {
    const { root, vars } = task;
    const rel = 'story/story-bible.yaml';
    const bible = ws.loadYaml(ws.abs(root, rel)) || { title: 'Untitled', premise: 'A comic.', facts: [], characters: [] };
    const facts = Array.isArray(bible.facts) ? bible.facts : (bible.facts = []);
    const next = () => `FACT_${String(facts.reduce((max, f) => Math.max(max, parseInt(String(f.id || '').slice(5), 10) || 0), 0) + 1).padStart(3, '0')}`;
    if (vars.instruction) {
      facts.push({ id: next(), statement: firstSentence(vars.instruction, 300), provenance: 'user_change', replaces: null, affects: [] });
    }
    if (vars.source_file) {
      facts.push({
        id: next(), statement: `The source text ${path.basename(vars.source_file)} was added to the canon.`,
        provenance: 'source', source_ref: vars.source_file, replaces: null, affects: [],
      });
    }
    writeYaml(root, rel, bible, out.files, 'Schema: schemas/story-bible.schema.json');
    out.summary = 'Updated the story bible with the change.';
  },

  'style.define'(task, out) {
    const { root, vars } = task;
    const lookId = vars.look_id || 'LOOK_CUSTOM';
    const blockFile = path.join(root, 'style', 'style-block.txt');
    let block = '';
    try {
      block = fs.readFileSync(blockFile, 'utf8').replace(/\r\n/g, '\n')
        .split('\n').filter((l) => !l.startsWith('#')).join('\n').trim();
    } catch (err) {
      block = '';
    }
    if (!block || /<[^>]+>/.test(block)) {
      block = [
        'Comic book page, ink line and flat colour, paged layout.',
        'Line: even contour of medium weight, closed shapes.',
        'Blacks and shadow: small areas of solid black, hard shadow edges, no hatching.',
        'Tone: none.',
        'Color: flat colour, a limited palette.',
        'Rendering: simple faces, readable silhouettes at thumbnail size.',
        'Panels: thin black borders, white gutters.',
        'Lettering: upper-case text in white balloons with a thin black outline.',
      ].join('\n');
    }
    if (vars.description) block += `\nDirection: ${words(vars.description, 40)}`;
    write(root, 'style/style-block.txt', `${block}\n`, out.files);
    write(root, 'style/style-bible.md', [
      '# Style bible', '',
      'Status: draft',
      `Look: ${lookId}`,
      'Look master: (none yet)', '',
      '## The look in one paragraph', '',
      vars.description ? words(vars.description, 80) : `The look ${lookId}, as its style block describes it.`, '',
      '## Frozen style block', '', '```text', block, '```', '',
    ].join('\n'), out.files);
    write(root, 'style/color-script.md', [
      '# Color script', '', `One palette for the whole issue, set by ${lookId}.`, '',
    ].join('\n'), out.files);
    out.data.look_id = lookId;
    out.summary = `Wrote the style bible and the style block for ${lookId}.`;
  },

  'character.write'(task, out) {
    const { root, vars } = task;
    const id = vars.character_id;
    const rel = `characters/${id}/character.yaml`;
    const existing = ws.loadCharacter(root, id);
    const token = id.replace(/^CHAR_/, '');
    const wardrobeId = (existing && existing.default_wardrobe) || `WARD_${token}_DEFAULT`;
    const name = vars.name || (existing && existing.name) || token;
    const summary = vars.description
      ? words(vars.description, 60)
      : (existing && existing.description && existing.description.summary) || `${name}, a character of this comic.`;
    const first = !existing && characterIds(root).length === 0;
    const doc = Object.assign({
      id,
      name,
      aliases: [],
      role: first ? 'protagonist' : 'supporting',
      description: {},
      prompt_summary: '',
      visually_adjacent_to: [],
      personality: 'Says what is needed.',
      voice: 'Short sentences.',
      default_wardrobe: wardrobeId,
      wardrobe_file: 'wardrobe.yaml',
      references: [],
      status: 'draft',
    }, existing || {});
    doc.name = name;
    doc.description = Object.assign({}, doc.description, {
      summary,
      distinguishing_features: (existing && existing.description && existing.description.distinguishing_features) || [
        `the face of ${name} as described`,
        `the plain jacket ${name} always wears`,
        `the way ${name} stands, weight on one leg`,
      ],
    });
    doc.prompt_summary = summary;
    writeYaml(root, rel, doc, out.files, 'Schema: schemas/character.schema.json');
    if (!ws.loadWardrobe(root, id)) {
      writeYaml(root, `characters/${id}/wardrobe.yaml`, {
        character: id,
        outfits: [{
          id: wardrobeId,
          description: `Plain jacket, shirt, trousers and boots, the everyday clothes of ${name}.`,
          layers: ['jacket', 'shirt', 'trousers', 'boots'],
          accessories: [],
          hands: 'bare',
          references: [],
          used_in: [],
        }],
      }, out.files, 'Schema: schemas/wardrobe.schema.json');
    }
    const bibleRel = 'story/story-bible.yaml';
    const bible = ws.loadYaml(ws.abs(root, bibleRel));
    if (bible && Array.isArray(bible.characters) && !bible.characters.some((c) => c && c.id === id)) {
      bible.characters.push({ id, role: doc.role });
      writeYaml(root, bibleRel, bible, out.files, 'Schema: schemas/story-bible.schema.json');
    }
    out.data.character_id = id;
    out.summary = `${existing ? 'Updated' : 'Wrote'} the character file of ${name}.`;
  },

  'entities.derive'(task, out) {
    const made = ensureLocation(task.root, out);
    out.data.locations = made ? [made] : [];
    out.data.props = [];
    out.summary = made ? `Wrote the location ${made} with its map.` : 'Every place the pages use already has a file.';
  },

  'pages.breakdown'(task, out) {
    const { root, vars } = task;
    const issue = vars.issue;
    const pageIds = vars.page_list || [];
    const made = ensureLocation(root, out);
    const location = ws.listEntityIds(root, 'locations')[0];
    const scenes = ws.listScenes(root, issue);
    const sceneNumber = scenes.reduce((max, s) => Math.max(max, parseInt(s.id.slice(-2), 10) || 0), 0) + 1;
    const sceneId = `SC_${issue.slice(4)}_${String(sceneNumber).padStart(2, '0')}`;
    const parts = splitText(vars.text, pageIds.length);
    writeYaml(root, `issues/${issue}/scenes/${sceneId}.yaml`, {
      id: sceneId,
      issue,
      location,
      time_of_day: 'day',
      cast: characterIds(root).slice(0, 2),
      summary: firstSentence(vars.text, 200),
      geography: { travel_direction: 'left_to_right', threat_direction: 'none', notes: 'Nobody changes level in this scene.' },
      beats: pageIds.map((pg, i) => ({
        id: `BT_${issue.slice(4)}_${String(sceneNumber).padStart(2, '0')}_${String(i + 1).padStart(2, '0')}`,
        summary: firstSentence(parts[i], 200),
        pages: [pg],
      })),
      pages: pageIds,
    }, out.files, 'Schema: schemas/scene.schema.json');
    const issueRel = `issues/${issue}/issue.yaml`;
    const existing = ws.loadIssue(root, issue);
    const plan = ws.loadYaml(ws.abs(root, 'story/series-plan.yaml'));
    const planned = plan && Array.isArray(plan.issues) ? plan.issues.find((i) => i && i.id === issue) : null;
    const before = ws.listPageIds(root, issue).filter((id) => !pageIds.includes(id)).length;
    const doc = Object.assign({
      id: issue,
      number: parseInt(issue.slice(4), 10),
      title: (planned && planned.title) || `Issue ${parseInt(issue.slice(4), 10)}`,
      summary: (planned && planned.summary) || firstSentence(vars.text, 200),
      scenes: [],
      page_count: 0,
      opens_from: null,
      status: 'scripting',
    }, existing || {});
    doc.scenes = [...(Array.isArray(doc.scenes) ? doc.scenes : []), sceneId];
    doc.page_count = before + pageIds.length;
    writeYaml(root, issueRel, doc, out.files, 'Schema: schemas/issue.schema.json');
    if (planned && planned.page_budget !== doc.page_count) {
      planned.page_budget = doc.page_count;
      writeYaml(root, 'story/series-plan.yaml', plan, out.files, 'Schema: schemas/series-plan.schema.json');
    }
    out.data.scenes = [sceneId];
    out.data.locations = made ? [made] : [];
    out.data.props = [];
    out.data.assumptions = [{ page: pageIds[0], panel: null, text: 'Placeholder: the scene happens by day, because the text does not say when.' }];
    out.summary = `Broke the text into one scene, ${sceneId}, over ${pageIds.length} page(s).`;
  },

  'pages.plan'(task, out) {
    const { root, vars } = task;
    const issue = vars.issue;
    const pageIds = vars.page_list || [];
    const project = ws.loadProject(root) || {};
    const paged = project.comic_format !== 'webtoon';
    const cast = characterIds(root).slice(0, 2);
    const scene = ws.listScenes(root, issue).reverse().find((s) => s.doc && Array.isArray(s.doc.pages) && s.doc.pages.includes(pageIds[0]));
    const sceneId = scene ? scene.id : `SC_${issue.slice(4)}_01`;
    const location = (scene && scene.doc.location) || ws.listEntityIds(root, 'locations')[0];
    const map = ws.loadLocationMap(root, location) || { levels: [{ id: 'ground' }], landmarks: [] };
    const level = map.levels[0].id;
    const landmarks = (map.landmarks || []).filter((l) => l.level === level);
    const spots = [
      { level, side: 'left', landmark: (landmarks.find((l) => l.side === 'left') || {}).id || null },
      { level, side: 'right', landmark: (landmarks.find((l) => l.side === 'right') || {}).id || null },
    ];
    const parts = splitText(vars.text, pageIds.length);
    const existingIds = ws.listPageIds(root, issue).filter((id) => !pageIds.includes(id)).sort();
    const lastExisting = existingIds[existingIds.length - 1] || null;
    let panelTotal = 0;

    pageIds.forEach((pageId, index) => {
      const number = parseInt(pageId.slice(-3), 10);
      const text = parts[index];
      const pn = (n) => `PN_${pageId.slice(3)}_${String(n).padStart(2, '0')}`;
      const row = (charId, i, action) => {
        const character = ws.loadCharacter(root, charId) || {};
        return {
          character: charId,
          off_panel: false,
          position: spots[i],
          facing: i === 0 ? 'right' : 'left',
          action,
          acting: 'Shoulders loose, eyes on the other side of the room.',
          wardrobe: character.default_wardrobe || `WARD_${charId.slice(5)}_DEFAULT`,
          state: [],
          state_changes: { adds: [], resolves: [] },
          holding: [],
          carrying: null,
          moved: null,
          wardrobe_change: null,
        };
      };
      const speaker = cast[0] || null;
      const panel = (n, tier, size, shot, moment, lettering) => ({
        id: pn(n),
        order: n,
        tier,
        size,
        framing: { shot_size: shot, angle: 'eye_level', view: 'three_quarter', composition: 'The figures left and right, the room between them.' },
        moment,
        location,
        transition_in: index === 0 && n === 1 ? null : 'action',
        ellipsis: null,
        background: 'The room, plainly drawn.',
        cast: cast.map((id, i) => row(id, i, i === 0 ? 'Stands and looks across the room.' : 'Waits by the far side.')),
        props: [],
        transfers: [],
        lettering,
        notes: '',
      });
      const page = {
        id: pageId,
        issue,
        number,
        scene: sceneId,
        purpose: text,
        page_turn: 'none',
        layout: { grid: 'two tiers, 1 / 2', tiers: [1, 2], reading_order: [1, 2, 3], notes: '' },
        panels: [
          panel(1, 1, 'wide', 'wide', `The place where this happens: ${firstSentence(text, 120)}`,
            [{ id: 'L01', type: 'caption', speaker: null, text: words(text, 20), order: 1 }]),
          panel(2, 2, 'medium', 'medium', 'The first figure turns toward the other.',
            speaker ? [{ id: 'L02', type: 'balloon', speaker, text: 'We start here.', order: 2 }] : []),
          panel(3, 2, 'medium', 'medium_close_up', 'A closer view as the moment lands.', []),
        ],
        references: { required: [], optional: [] },
        continuity: {
          enters_from: index === 0 ? lastExisting : pageIds[index - 1],
          exits_to: pageIds[index + 1] || null,
          attach_previous_render: true,
        },
        generation: { provider: vars.provider || 'manual', mode: 'full_page' },
        status: 'scripted',
        current_render: null,
      };
      if (paged) {
        page.side = number % 2 ? 'right' : 'left';
        page.spread_with = null;
      }
      panelTotal += page.panels.length;
      writeYaml(root, `issues/${issue}/pages/${pageId}/page.yaml`, page, out.files, 'Schema: schemas/page.schema.json');
    });

    // The page before the new ones now leads into them.
    if (lastExisting) {
      const prevRel = `issues/${issue}/pages/${lastExisting}/page.yaml`;
      const prev = ws.loadPage(root, lastExisting);
      if (prev && prev.continuity && prev.continuity.exits_to !== pageIds[0]) {
        prev.continuity.exits_to = pageIds[0];
        writeYaml(root, prevRel, prev, out.files, 'Schema: schemas/page.schema.json');
      }
    }
    const issueDoc = ws.loadIssue(root, issue);
    if (issueDoc) {
      let count = 0;
      for (const p of ws.listPages(root, issue)) count += p.doc && Array.isArray(p.doc.panels) ? p.doc.panels.length : 0;
      issueDoc.panel_count = count || panelTotal;
      issueDoc.page_count = ws.listPageIds(root, issue).length;
      writeYaml(root, `issues/${issue}/issue.yaml`, issueDoc, out.files, 'Schema: schemas/issue.schema.json');
    }
    out.data.assumptions = pageIds.map((pageId) => ({
      page: pageId,
      panel: `PN_${pageId.slice(3)}_01`,
      text: 'Placeholder: the figures stand left and right of the room and hold nothing, because the text does not say.',
    }));
    out.summary = `Planned ${pageIds.length} page(s) with three panels each.`;
  },

  'page.revise'(task, out) {
    const { root, vars } = task;
    const page = ws.loadPage(root, vars.page);
    if (!page) return;
    const request = words(vars.request, 40);
    page.notes = `Revised after the repair limit: ${request}`;
    if (Array.isArray(page.panels) && page.panels[0] && page.panels[0].framing) {
      page.panels[0].framing.composition = `${String(page.panels[0].framing.composition || '').replace(/ Revised: .*$/, '')} Revised: ${request}`;
    }
    writeYaml(root, `issues/${ws.issueOfPage(vars.page)}/pages/${vars.page}/page.yaml`, page, out.files, 'Schema: schemas/page.schema.json');
    out.summary = `Put the change into the plan of ${vars.page}.`;
  },

  'pages.fix'(task, out) {
    out.summary = 'Looked at the reported errors. The fake planner has nothing to change.';
  },

  review(task, out) {
    const { vars } = task;
    let plan = '';
    try {
      plan = fs.readFileSync(vars.plan_file, 'utf8');
    } catch (err) {
      plan = '';
    }
    const marker = `${plan}\n${task.text || ''}`;
    const always = has(marker, 'FLAGALWAYS');
    const flag = always || has(marker, 'FLAG');
    const upstream = has(marker, 'UPSTREAM');
    const note = has(marker, 'NOTE');
    // The findings to recheck, and whether the repair was asked to fix each
    // (a carried note that was not part of the repair is still there).
    const rechecked = `${vars.previous || ''}\n${vars.requests || ''}`.split('\n')
      .map((line) => {
        const id = (/^- (F\d{2}|REQ\d+)/.exec(line) || [])[1];
        return id ? { id, carried: /not part of the repair/.test(line) } : null;
      }).filter(Boolean);
    const recheckIds = rechecked.map((x) => x.id);
    const isRecheck = recheckIds.length > 0;
    const failing = flag && (always || !isRecheck);
    const cover = vars.kind === 'cover';
    const skip = String(vars.not_applicable || '').split(',').map((s) => s.trim()).filter(Boolean);
    const checks = {};
    for (const key of CHECKS) {
      checks[key] = skip.includes(key)
        ? { result: 'not_applicable', evidence: 'A cover has no panels for this check to judge.' }
        : { result: 'pass', evidence: `Placeholder evidence for ${key.replace(/_/g, ' ')}: the fake reviewer does not look at pixels.` };
    }
    const findings = [];
    if (failing && !isRecheck) {
      const panel = cover ? null : (/^\s*- id: (PN_\d{3}_\d{3}_\d{2})/m.exec(plan) || [])[1] || null;
      checks.identity = { result: 'fail', evidence: 'Placeholder: the figure in the first panel is drawn as someone else.' };
      findings.push({
        panel,
        check: 'identity',
        expected: 'The character matches the approved sheet.',
        visible: 'Placeholder finding forced by the word FLAG in the text.',
        severity: 'blocking',
        repair: 'Redraw the figure from the approved sheet and keep everything else as it is.',
      });
    }
    if (note && !isRecheck) {
      // A minor finding: the check stays at pass and no gate fails.
      checks.wardrobe = { result: 'pass', evidence: 'Placeholder: the outfit matches, with one small difference noted as a finding.' };
      findings.push({
        panel: cover ? null : (/^\s*- id: (PN_\d{3}_\d{3}_\d{2})/m.exec(plan) || [])[1] || null,
        check: 'wardrobe',
        expected: 'The jacket is buttoned, as on the sheet.',
        visible: 'Placeholder note forced by the word NOTE in the text: the jacket is open.',
        severity: 'minor',
        repair: 'Button the jacket and keep everything else as it is.',
      });
    }
    out.data.review = {
      checks,
      findings,
      rechecks: rechecked.map(({ id, carried }) => ({
        id,
        fixed: !always && !carried,
        evidence: always || carried ? 'Placeholder: it is still there.' : 'Placeholder: the change is present in the new render.',
      })),
      gates: { style_fidelity: 'pass', narrative_continuity: failing && !isRecheck ? 'fail' : 'pass' },
      repairable: !upstream,
      references_compared: [],
    };
    out.summary = failing ? 'The image does not match the plan yet.' : 'The image matches the plan.';
  },

  'cover.write'(task, out) {
    const { root, vars } = task;
    const issue = vars.issue;
    const project = ws.loadProject(root) || {};
    const coverId = issue.replace(/^ISS_/, 'CV_');
    const existing = typeof ws.loadCover === 'function' ? ws.loadCover(root, issue) : null;
    const cast = characterIds(root).slice(0, 2);
    const location = ws.listEntityIds(root, 'locations')[0] || null;
    const doc = Object.assign({
      id: coverId,
      issue,
      concept: 'The cast stands together and looks at the reader.',
      composition: 'Figures in the lower two thirds, the top third left free for the title.',
      location,
      time_of_day: 'day',
      cast: cast.map((id) => {
        const character = ws.loadCharacter(root, id) || {};
        return {
          character: id,
          wardrobe: character.default_wardrobe || `WARD_${id.slice(5)}_DEFAULT`,
          action: 'Stands facing the reader.',
          acting: 'Calm, chin level.',
          state: [],
          holding: [],
        };
      }),
      props: [],
      lettering: {
        mode: project.lettering && project.lettering.mode === 'overlay' ? 'overlay' : 'in_image',
        title: String(project.title || 'Untitled'),
        issue_line: null,
        tagline: null,
        credits: null,
      },
      generation: { provider: vars.provider || 'manual' },
      status: 'draft',
      approved_render: null,
    }, existing || {});
    if (vars.description) doc.concept = words(vars.description, 60);
    doc.generation = { provider: vars.provider || 'manual' };
    doc.status = 'draft';
    doc.approved_render = null;
    writeYaml(root, `issues/${issue}/cover/cover.yaml`, doc, out.files, 'Schema: schemas/cover.schema.json');
    out.summary = `${existing ? 'Changed' : 'Wrote'} the cover of ${issue}.`;
  },

  'lettering.place'(task, out) {
    const { root, vars } = task;
    const project = ws.loadProject(root) || {};
    const canvas = {
      width_px: (project.page && project.page.width_px) || 2000,
      height_px: (project.page && project.page.height_px) || 3000,
    };
    for (const pageId of vars.page_list || []) {
      const page = ws.loadPage(root, pageId);
      if (!page || !page.current_render) continue;
      const tiers = (page.layout && page.layout.tiers) || [page.panels.length];
      const margin = Math.round(canvas.width_px * 0.05);
      const tierH = (canvas.height_px - margin * 2) / tiers.length;
      const slots = [];
      tiers.forEach((count, t) => {
        const w = (canvas.width_px - margin * 2) / count;
        for (let c = 0; c < count; c++) slots.push({ x: margin + c * w, y: margin + t * tierH, w, h: tierH });
      });
      const elements = [];
      const ordered = page.panels.slice().sort((a, b) => a.order - b.order);
      ordered.forEach((panel, i) => {
        const slot = slots[i] || slots[slots.length - 1];
        (panel.lettering || []).forEach((el, n) => {
          const spoken = !['caption', 'narration', 'sfx', 'sign'].includes(el.type);
          const box = {
            x: Math.round(slot.x + slot.w * 0.06),
            y: Math.round(slot.y + slot.h * (0.05 + n * 0.3)),
            width: Math.round(slot.w * 0.8),
            height: Math.round(Math.min(slot.h * 0.28, canvas.height_px * 0.12)),
          };
          elements.push({
            id: el.id,
            panel: panel.id,
            type: el.type,
            text: el.text,
            box,
            shape: spoken ? 'ellipse' : 'rect',
            tail: spoken ? { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height + slot.h * 0.12) } : null,
            style: { fill: '#FFFFFF', stroke: '#000000', text: '#000000' },
          });
        });
      });
      writeYaml(root, `issues/${ws.issueOfPage(pageId)}/pages/${pageId}/lettering.yaml`, {
        page: pageId,
        render: page.current_render,
        canvas,
        font: { family: (project.lettering && project.lettering.font_family) || 'Comic Neue', size_px: Math.round(canvas.width_px / 60), line_height: 1.15 },
        elements,
      }, out.files, 'Schema: schemas/lettering.schema.json');
    }
    out.summary = `Placed the lettering of ${(vars.page_list || []).length} page(s).`;
  },

  chat(task, out) {
    const { root, vars } = task;
    const message = String(vars.message || '');
    out.summary = `This is the fake assistant. You wrote: "${words(message, 30)}". With a real tool installed, the answer comes from Claude Code or Codex.`;
    if (vars.history) {
      out.summary += ` I joined with a summary of ${String(vars.history).split('\n').filter((l) => l.startsWith('- ')).length} earlier message(s).`;
    }
    if (has(message, 'PROPOSE')) {
      // Story text comes back as a proposal, never as a write to the story bible.
      out.data.proposal = {
        facts: [{ statement: `Placeholder fact asked for in the chat: ${words(message.replace(/\bPROPOSE\b/g, ''), 20)}`, provenance: 'user_change', affects: [] }],
        questions: [{ question: 'Placeholder question from the chat: should this be canon?', blocking: false, options: [] }],
      };
      out.summary += ' I wrote it as a proposal on the Story screen.';
    }
    if (has(message, 'LINK')) {
      out.data.links = [
        { screen: 'characters', label: 'Characters' },
        { screen: 'character:CHAR_NOBODY_HERE', label: 'A screen that does not exist' },
        { route: `/p/x/nowhere`, label: 'A route that does not exist' },
      ];
      out.summary += ' Add the character on the Characters screen.';
    }
    if (has(message, 'WRITEBIBLE') && task.allowWrite && fs.existsSync(ws.abs(root, 'story/story-bible.yaml'))) {
      // A reply that writes the story bible anyway: the studio undoes it.
      const file = ws.abs(root, 'story/story-bible.yaml');
      fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8').replace(/\n*$/, '\n')}notes: "Written by the fake assistant, which should not."\n`);
      out.files.push('story/story-bible.yaml');
    }
    if (!has(message, 'EDIT') || !task.allowWrite) return;
    // The story bible is never the file a chat edits.
    const target = (vars.file_list || []).find((rel) => rel !== 'story/story-bible.yaml' && /\.(ya?ml|md|txt)$/i.test(rel) && fs.existsSync(ws.abs(root, rel)));
    if (!target) return;
    const file = ws.abs(root, target);
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const note = `Edited by the fake assistant on ${today()}: ${words(message.replace(/\bEDIT\b/g, ''), 20)}`;
    if (/\.ya?ml$/i.test(target)) {
      const re = /^notes:.*$/m;
      const line = `notes: ${JSON.stringify(note)}`;
      const hasBlock = /^notes:\s*[>|]/m.test(text);
      if (hasBlock) return;
      fs.writeFileSync(file, re.test(text) ? text.replace(re, line) : `${text.replace(/\n*$/, '\n')}${line}\n`);
    } else if (/style-block\.txt$/i.test(target)) {
      return;
    } else {
      fs.writeFileSync(file, `${text.replace(/\n*$/, '\n')}\n${note}\n`);
    }
    out.files.push(target);
    out.summary += ` I also added a note to ${target}.`;
  },
};

/** A location with a map, when the workspace has none. Returns the ID it made, or null. */
function ensureLocation(root, out) {
  if (ws.listEntityIds(root, 'locations').some((id) => ws.loadLocation(root, id) && ws.loadLocationMap(root, id))) return null;
  const id = 'LOC_MAIN_ROOM';
  writeYaml(root, `locations/${id}/location.yaml`, {
    id,
    name: 'Main room',
    description: {
      summary: 'A plain room with a door on the left and a window on the right.',
      architecture: 'One level, four walls, a door and a window.',
      dressing: 'A table in the middle.',
      light: 'Daylight from the window.',
    },
    prompt_summary: 'A plain room with a door on the left, a table in the middle and a window on the right.',
    time_of_day_states: ['day'],
    map_file: 'map.yaml',
    references: [],
    status: 'draft',
  }, out.files, 'Schema: schemas/location.schema.json');
  writeYaml(root, `locations/${id}/map.yaml`, {
    location: id,
    levels: [{ id: 'ground', description: 'The floor of the room.' }],
    sides: { convention: 'The door is screen left, the window screen right.', left: 'door', right: 'window' },
    landmarks: [
      { id: 'door', level: 'ground', side: 'left', description: 'The door.' },
      { id: 'table', level: 'ground', side: 'center', description: 'The table.' },
      { id: 'window', level: 'ground', side: 'right', description: 'The window.' },
    ],
    exits: [{ id: 'door', level: 'ground', side: 'left', leads_to: null }],
    connections: [],
  }, out.files, 'Schema: schemas/location-map.schema.json');
  return id;
}

function detect() {
  return { installed: true, version: 'fake' };
}

/**
 * Same interface as the real drivers. `options.task` says what the call is:
 * { kind, vars, root, answers, text, allowWrite }.
 */
async function run(options) {
  const started = Date.now();
  const task = options.task || { kind: null, vars: {}, text: '' };
  const emit = (text) => {
    if (typeof options.onEvent === 'function') options.onEvent({ type: 'tool', tool: 'fake', text });
  };
  const sessionId = options.sessionId || `fake-session-${String(++sessions).padStart(4, '0')}`;
  const finish = (structured) => ({
    ok: true,
    structured,
    text: JSON.stringify(structured),
    sessionId,
    costUsd: null,
    durationMs: Date.now() - started,
    error: null,
  });
  try {
    emit(`reading commands for ${task.kind || 'this step'}`);
    await sleep(3, options.signal);
    // A review reacts to FLAG words only: the other words are for steps that plan.
    const text = task.kind === 'review' ? '' : String(task.text || '');
    if (has(text, 'SLOW')) {
      const ms = Number.parseInt(process.env.STUDIO_FAKE_SLOW_MS || '', 10);
      emit('working slowly, as asked');
      await sleep(Number.isFinite(ms) && ms > 0 ? ms : 3000, options.signal);
    }
    if (has(text, 'FAILAI')) {
      return finish({ status: 'failed', summary: 'The fake assistant was told to fail (FAILAI).', files_written: [] });
    }
    if (has(text, 'DECIDE') && !Object.keys(task.answers || {}).length) {
      return finish({
        status: 'needs_decision',
        summary: 'One choice is yours to make before this goes on.',
        files_written: [],
        questions: [{ id: 'q1', question: 'The text says DECIDE. Which way should this go?', options: ['The first way', 'The second way'] }],
      });
    }
    const handler = handlers[task.kind];
    const out = { summary: 'Done.', files: [], decisions: [], data: {} };
    if (handler) {
      if (task.allowWrite === false && !['review', 'chat', 'story.propose'].includes(task.kind)) {
        return finish({ status: 'failed', summary: 'This step needs to write files and was run read-only.', files_written: [] });
      }
      handler(task, out);
    }
    const answers = Object.values(task.answers || {});
    if (answers.length) out.decisions.push(`Went with the answer given: ${answers.map((a) => a.answer).join(', ')}.`);
    for (const rel of out.files) emit(`writing ${rel}`);
    return finish({
      status: 'done',
      summary: out.summary,
      files_written: [...new Set(out.files)],
      decisions: out.decisions,
      data: out.data,
    });
  } catch (err) {
    if (err && err.code === 'cancelled') {
      return {
        ok: false, structured: null, text: '', sessionId, costUsd: null, durationMs: Date.now() - started,
        error: 'cancelled', cancelled: true,
      };
    }
    return {
      ok: false, structured: null, text: '', sessionId, costUsd: null, durationMs: Date.now() - started,
      error: `the fake assistant broke: ${err.message}`,
    };
  }
}

module.exports = { name: 'fake', label: 'Fake assistant', verbs: ['plan', 'look'], detect, run, handlers, splitText, idToken };
