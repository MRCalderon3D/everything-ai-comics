'use strict';
/**
 * The server's own text in the person's language.
 *
 * 1. The dictionaries: the same keys in English and in Spanish, the same
 *    {placeholders} in each pair, and every key the code asks for exists.
 * 2. A Spanish project, part of the fake pipeline: nothing the server says in
 *    the job, history and overview payloads is English, every sentence comes
 *    with its code and params, and a stored job reads in the language of
 *    whoever asks for it.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const i18n = require('../studio/server/i18n');
const DICT = require('../studio/server/i18n-text');
const { start } = require('../studio/test-support/harness');

const SERVER = path.join(__dirname, '..', 'studio', 'server');

function placeholders(text) {
  return (text.match(/\{[a-z_]+\}/g) || []).sort().join(' ');
}

function serverFiles() {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.js') && entry.name !== 'i18n-text.js') out.push(file);
    }
  })(SERVER);
  return out;
}

function dictionaries() {
  assert.deepStrictEqual(Object.keys(DICT).sort(), ['en', 'es'], 'one dictionary per interface language');
  const en = Object.keys(DICT.en);
  const es = Object.keys(DICT.es);
  assert.deepStrictEqual(en.filter((k) => !(k in DICT.es)), [], 'keys missing in Spanish');
  assert.deepStrictEqual(es.filter((k) => !(k in DICT.en)), [], 'keys missing in English');
  assert.ok(en.length > 300, `only ${en.length} keys`);
  for (const key of en) {
    for (const lang of ['en', 'es']) {
      assert.strictEqual(typeof DICT[lang][key], 'string', `${lang} ${key} is not text`);
      assert.ok(DICT[lang][key].trim().length > 0, `${lang} ${key} is empty`);
    }
    assert.strictEqual(placeholders(DICT.es[key]), placeholders(DICT.en[key]), `${key}: the two languages use different placeholders`);
    assert.ok(/^[a-z][a-z0-9_]*(\.[a-z0-9][a-z0-9_-]*)+$/.test(key), `${key}: not a dotted key`);
  }
  // A key that counts has both forms, in both languages.
  for (const key of en) {
    const m = /^(.*)\.(one|many)$/.exec(key);
    if (!m) continue;
    const twin = `${m[1]}.${m[2] === 'one' ? 'many' : 'one'}`;
    assert.ok(twin in DICT.en, `${key} has no ${twin}`);
    assert.ok(!(m[1] in DICT.en), `${m[1]} exists both plain and counted`);
  }
  // No Spanish entry was left as a copy of the English one, apart from names and formats that are the same in both.
  const same = en.filter((k) => DICT.en[k] === DICT.es[k] && /[a-z]{4,} [a-z]{3,}/.test(DICT.en[k]));
  assert.deepStrictEqual(same, [], 'Spanish entries that are still English');

  // Every key the code names exists. Keys built from a variable are checked by family below.
  const used = new Set();
  const dynamic = new Set();
  for (const file of serverFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    const re = /(?:\bmsg|\bt|\bsay|errorMsg)\(\s*(?:[A-Za-z_.]+\s*,\s*)?(['`])([a-z][a-z0-9_]*\.[^'`\n]*?)\1/g;
    let m;
    while ((m = re.exec(text))) {
      if (m[2].includes('${')) dynamic.add(m[2].split('${')[0]);
      else used.add(m[2]);
    }
    // Error codes: each one has its own sentence, or falls back to the catch-all on purpose.
    const codes = /(?:new HttpError\(\s*\d+\s*,|new OpError\()\s*'([a-z_]+)'/g;
    while ((m = codes.exec(text))) {
      assert.ok(i18n.has(`error.${m[1]}`), `${path.basename(file)}: error code ${m[1]} has no sentence in the dictionary`);
    }
  }
  assert.ok(used.size > 120, `only ${used.size} keys found in the code`);
  for (const key of used) assert.ok(i18n.has(key), `the code uses ${key}, which the dictionary does not have`);
  for (const prefix of dynamic) {
    assert.ok(en.some((k) => k.startsWith(prefix)), `the code builds keys from ${prefix}, and the dictionary has none`);
  }
  // Families built from a list: every member is there.
  const ops = require('../studio/server/ops');
  for (const name of ops.names()) {
    for (const part of ['title', 'summary']) assert.ok(i18n.has(`op.${name}.${part}`), `op.${name}.${part}`);
  }
  const { KINDS } = require('../studio/server/ops/sheets');
  for (const kind of KINDS) {
    for (const verb of ['compile', 'draw']) {
      for (const of of ['', '.of']) assert.ok(i18n.has(`step.sheet.${verb}.${kind}${of}`), `step.sheet.${verb}.${kind}${of}`);
    }
    assert.ok(i18n.has(`sheet.${kind}`), `sheet.${kind}`);
  }
  for (const preset of fs.readdirSync(path.join(__dirname, '..', 'templates', 'looks')).filter((n) => n.endsWith('.yaml'))) {
    const id = preset.replace(/\.yaml$/, '');
    for (const part of ['name', 'intent']) assert.ok(i18n.has(`preset.${id}.${part}`), `preset.${id}.${part}`);
  }

  // --- the functions around the dictionaries -------------------------------------------------
  assert.strictEqual(i18n.t('es', 'note.errors', { n: 1 }), 'Un error');
  assert.strictEqual(i18n.t('es', 'note.errors', { n: 3 }), '3 errores');
  assert.strictEqual(i18n.t('en', 'note.errors', { n: 0 }), '0 errors');
  assert.strictEqual(i18n.t('fr', 'note.no_errors'), 'No errors', 'a language without text falls back to English');
  assert.strictEqual(i18n.t('es', 'no.such.key', { detail: 'x' }), 'x');
  assert.strictEqual(i18n.normalize('es-ES'), 'es');
  assert.strictEqual(i18n.normalize('fr'), null);
  assert.strictEqual(i18n.fromAcceptLanguage('fr-FR,fr;q=0.9,es;q=0.8,en;q=0.7'), 'es');
  assert.strictEqual(i18n.fromAcceptLanguage('en;q=0.5, es;q=0.9'), 'es');
  assert.strictEqual(i18n.fromAcceptLanguage(''), null);
  assert.strictEqual(i18n.pickLang({ query: 'en', projectLanguage: 'es', acceptLanguage: 'es' }), 'en');
  assert.strictEqual(i18n.pickLang({ query: null, projectLanguage: 'es', acceptLanguage: 'en' }), 'es');
  assert.strictEqual(i18n.pickLang({ query: 'xx', projectLanguage: null, acceptLanguage: 'de' }), 'en');
  // A descriptor inside a descriptor, and the three properties a descriptor becomes.
  const nested = i18n.msg('activity.step', { title: i18n.msg('op.pages.plan.title'), label: i18n.msg('step.page.draw', { n: 2 }) });
  assert.deepStrictEqual(i18n.localize('es', { title: nested, list: [i18n.msg('path.edit')], plain: 'x', n: 1 }), {
    title: 'Planificar páginas: Página 2: dibujar',
    title_code: 'activity.step',
    title_params: { title: 'Planificar páginas', label: 'Página 2: dibujar' },
    list: ['Se editó la imagen que ya existía.'],
    plain: 'x',
    n: 1,
  });
  assert.strictEqual(i18n.localize('en', { title: nested }).title, 'Plan pages: Page 2: draw');
  // An error: its own sentence when the values are there, the quoted detail when they are not or the code is new.
  assert.strictEqual(i18n.errorMsg('plan_not_approved', 'x', { pages: ['PG_001_001'] }).$t, 'error.plan_not_approved');
  assert.strictEqual(i18n.errorMsg('plan_not_approved', 'The plan of PG_001_001 is not approved.').$t, 'error.other', 'a sentence with a hole gives way to the detail');
  assert.strictEqual(i18n.t('es', 'error.other', { detail: 'Technical text.' }), 'No se ha podido completar. Detalle: Technical text.');
  assert.deepStrictEqual(i18n.errorMsg('some_new_code', 'Technical text.'), { $t: 'error.other', params: { detail: 'Technical text.' } });
  return en.length;
}

/** English function words that Spanish does not have. A sentence with one of them was not translated. */
const ENGLISH = /\b(the|is|are|was|were|not|of|to|with|from|for|this|that|yet|it|its|have|and|an|by|can|be)\b/i;

/**
 * Text the server did not write: what the person typed, what the (fake) AI
 * answered, technical detail quoted from a script, and the params that carry
 * those into a sentence.
 */
const NOT_SERVER_TEXT = new Set(['params', 'decisions', 'details', 'detail', 'description', 'logline', 'log', 'text', 'answers', 'questions']);

function walk(value, trail, visit) {
  if (Array.isArray(value)) {
    value.forEach((v) => walk(v, `${trail}[]`, visit));
    return;
  }
  if (!value || typeof value !== 'object') return;
  visit(value, trail);
  for (const [key, v] of Object.entries(value)) {
    if (NOT_SERVER_TEXT.has(key) || key.endsWith('_params')) continue;
    // The summary of a result is the tool's own sentence; the summary of a screen is the server's.
    if (key === 'summary' && value.summary_code === undefined) continue;
    if (typeof v === 'string') {
      // A sentence may quote technical text ({detail}) or the project's own words ({question}); those are not judged.
      const params = value[`${key}_params`] || {};
      let own = v;
      for (const quoted of ['detail', 'question']) {
        if (typeof params[quoted] === 'string' && params[quoted]) own = own.split(params[quoted]).join('');
      }
      if (own.includes(' ') && ENGLISH.test(own)) visit({ leak: v }, `${trail}.${key}`);
    } else {
      walk(v, `${trail}.${key}`, visit);
    }
  }
}

/** Every sentence in a payload is Spanish, and every coded sentence matches its code. */
function assertSpanish(payload, name) {
  let coded = 0;
  walk(payload, name, (object, trail) => {
    assert.strictEqual(object.leak, undefined, `English text in ${trail}: ${object.leak}`);
    for (const key of Object.keys(object)) {
      if (!key.endsWith('_code') || typeof object[key] !== 'string' || !/^[a-z_]+\./.test(object[key])) continue;
      const field = key.slice(0, -'_code'.length);
      if (typeof object[field] !== 'string') continue;
      coded += 1;
      const params = object[`${field}_params`];
      assert.ok(params && typeof params === 'object', `${trail}.${field} has a code and no params`);
      assert.ok(i18n.has(object[key]), `${trail}.${key} = ${object[key]} is not in the dictionary`);
      assert.strictEqual(object[field], i18n.t('es', object[key], params), `${trail}.${field} is not the Spanish text of ${object[key]}`);
    }
  });
  return coded;
}

async function spanishProject() {
  const s = await start();
  try {
    // --- routes with no project: ?lang=, then Accept-Language, then English ----------------------
    let r = await s.api('GET', '/api/ops');
    assert.strictEqual(r.body.operations.find((o) => o.name === 'pages.plan').title, 'Plan pages');
    r = await s.api('GET', '/api/ops', undefined, { 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' });
    let planOp = r.body.operations.find((o) => o.name === 'pages.plan');
    assert.deepStrictEqual([planOp.title, planOp.title_code, planOp.title_params], ['Planificar páginas', 'op.pages.plan.title', {}]);
    assert.ok(r.body.operations.every((o) => o.title && o.title_code && o.summary && o.summary_code));
    assertSpanish(r.body.operations.map((o) => ({ title: o.title, title_code: o.title_code, title_params: o.title_params, summary: o.summary, summary_code: o.summary_code, summary_params: o.summary_params })), 'ops');
    r = await s.api('GET', '/api/ops?lang=en', undefined, { 'Accept-Language': 'es' });
    assert.strictEqual(r.body.operations.find((o) => o.name === 'pages.plan').title, 'Plan pages', '?lang= wins over the header');
    r = await s.api('GET', '/api/ops?lang=es');
    assert.strictEqual(r.body.operations.find((o) => o.name === 'publish.build').title, 'Publicar');
    r = await s.api('GET', '/api/projects/nobody', undefined, { 'Accept-Language': 'es' });
    assert.strictEqual(r.status, 404);
    assert.deepStrictEqual(r.body.error, { code: 'project_not_found', message: 'No hay ningún proyecto con ese identificador.', params: { detail: r.body.error.params.detail } });
    r = await s.api('GET', '/api/projects/nobody');
    assert.strictEqual(r.body.error.message, 'There is no project with that id.');
    r = await s.api('POST', '/api/projects?lang=es', { description: 'sin título' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error.code, 'bad_params');
    assert.ok(r.body.error.message.startsWith('La petición no es válida. Detalle: '), r.body.error.message);
    assert.ok(r.body.error.params.detail.length > 0, 'the technical detail travels as a param');
    r = await s.api('GET', '/api/nothing', undefined, { 'Accept-Language': 'es' });
    assert.strictEqual(r.body.error.message, 'No encontrado.');

    // --- a Spanish project ---------------------------------------------------------------------------
    r = await s.api('POST', '/api/projects', {
      title: 'El último ferry',
      description: 'Una piloto de ferry encuentra a un polizón que la patrulla del puerto busca.',
      pages: 2,
      language: 'es',
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const id = r.body.project.id;
    const P = `/api/projects/${id}`;
    const events = s.openEvents(id);
    let job = await s.waitJob(id, r.body.job.id);
    assert.strictEqual(job.status, 'done', JSON.stringify(job.error));
    assert.deepStrictEqual([job.title, job.title_code], ['Preparar el proyecto', 'op.project.setup.title']);
    assert.deepStrictEqual(job.steps.map((x) => x.label_code), ['step.project.setup.source', 'step.project.setup.story', 'step.check.files']);
    assert.strictEqual(job.steps[0].label, 'Guardar la descripción');
    r = await s.api('GET', `${P}/settings`);
    assert.strictEqual(r.body.settings.language, 'es', 'the interface language follows the language the project was made in');

    const snapshots = [];
    const overview = async () => snapshots.push((await s.api('GET', P)).body);
    await overview();

    job = await s.runOp(id, 'style.define', { preset: 'ligne-claire' });
    assert.strictEqual(job.status, 'done', JSON.stringify(job.error));
    // Before the look is approved: a sheet is skipped with a reason, and the overview lists what blocks.
    job = await s.runOp(id, 'character.create', { name: 'Mara', description: 'Piloto de ferry.' });
    assert.strictEqual(job.status, 'done', JSON.stringify(job.error));
    assert.deepStrictEqual([job.result.sheet.skipped, job.result.sheet.reason_code], [true, 'skip.look_not_approved.sheet']);
    assert.ok(job.result.sheet.reason.startsWith('El estilo todavía no está aprobado.'));
    assert.ok(job.steps.some((x) => x.status === 'skipped' && x.note_code === 'skip.look_not_approved.sheet'), JSON.stringify(job.steps));
    await overview();
    const blocked = snapshots[snapshots.length - 1].screens.find((x) => x.key === 'characters');
    assert.deepStrictEqual(blocked.blockers.map((b) => [b.code, b.message_code]), [['look_not_approved', 'blocker.look_not_approved.sheets']]);

    job = await s.runOp(id, 'style.look', {});
    assert.strictEqual(job.status, 'done', JSON.stringify(job.error));
    r = await s.api('POST', `${P}/approve/asset`, { candidate: job.result.candidate_id });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    job = await s.runOp(id, 'character.sheet', { character: 'CHAR_MARA', sheet: 'turnaround' });
    assert.strictEqual(job.status, 'done', JSON.stringify(job.error));
    assert.deepStrictEqual(job.steps.map((x) => x.label), ['Preparar la hoja de giro', 'Dibujar la hoja de giro']);
    r = await s.api('POST', `${P}/approve/asset`, { candidate: job.result.sheet.candidate_id });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    // Two pages: one that no repair fixes, one that cannot be drawn.
    job = await s.runOp(id, 'pages.plan', { text: 'FLAGALWAYS Mara cruza el río de noche. FAILDRAW Oye un ruido en la bodega.', pages: 2 });
    assert.strictEqual(job.status, 'done', JSON.stringify(job.error));
    await overview();
    job = await s.runOp(id, 'pages.generate', { approve_plans: true }, 60000);
    assert.strictEqual(job.status, 'done', JSON.stringify(job.error));
    const [stuck, broken] = job.result.pages;
    assert.deepStrictEqual([stuck.flagged, stuck.stopped_code, stuck.stopped], [true, 'stopped.limit', `Se alcanzó el límite de ${stuck.stopped_params.limit} arreglos.`]);
    assert.strictEqual(broken.error.code, 'draw_failed');
    assert.deepStrictEqual([broken.error.message_code, broken.error.message.startsWith('La imagen no se ha dibujado. Detalle: ')], ['error.draw_failed', true]);
    assert.ok(job.steps.some((x) => x.label === 'Página 1: arreglo 1' && x.label_code === 'step.repair.page'), job.steps.map((x) => x.label).join(' | '));
    assert.ok(job.steps.some((x) => x.label === 'Página 1: comprobar el arreglo 1'));
    await overview();

    // A refusal, a failed job and a finished one.
    r = await s.api('POST', `${P}/approve/page`, { page: 'PG_001_001' });
    assert.strictEqual(r.status, 409);
    assert.deepStrictEqual([r.body.error.code, r.body.error.params.n], ['review_flagged', 1]);
    assert.ok(/está marcada, con un hallazgo abierto/.test(r.body.error.message), r.body.error.message);
    job = await s.runOp(id, 'publish.build', { formats: ['cbz'], mode: 'final' });
    assert.strictEqual(job.status, 'failed');
    assert.deepStrictEqual([job.error.code, job.error.message_code], ['not_ready', 'error.not_ready']);
    assert.ok(job.error.message.startsWith('Todavía no se puede hacer una edición definitiva'), job.error.message);
    assert.ok(job.error.details.blockers.every((b) => b.code && b.message_code && !ENGLISH.test(b.message)), JSON.stringify(job.error.details.blockers));
    job = await s.runOp(id, 'page.correct', { page: 'PG_001_001', text: 'La lámpara tiene que verse encendida.' });
    assert.strictEqual(job.status, 'done', JSON.stringify(job.error));
    assert.deepStrictEqual([job.result.path, job.result.path_label_code], ['redraw', 'path.redraw']);
    job = await s.runOp(id, 'publish.build', { formats: ['cbz'] });
    assert.strictEqual(job.status, 'done', JSON.stringify(job.error));
    r = await s.api('PUT', `${P}/file`, { path: 'style/color-script.md', text: '# Color\n\nUna sola paleta.\n' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    await overview();

    // --- nothing the server says in the job, history and overview payloads is English ---------------
    r = await s.api('GET', `${P}/jobs?limit=100`);
    const jobs = r.body.jobs;
    assert.ok(jobs.length >= 9, `${jobs.length} jobs`);
    let coded = assertSpanish(jobs, 'jobs');
    for (const listed of jobs) {
      const full = (await s.api('GET', `${P}/jobs/${listed.id}`)).body.job;
      assert.ok(full.title_code, `${full.op} has no title code`);
      assert.ok(full.steps.every((x) => x.label_code && typeof x.label === 'string'), `${full.op}: a step label without a code`);
      coded += assertSpanish(full, `job ${full.op}`);
    }
    r = await s.api('GET', `${P}/history?limit=500`);
    assert.ok(r.body.entries.length > 25, `${r.body.entries.length} history entries`);
    assert.ok(r.body.entries.every((e) => e.title && e.title_code), 'a history title without a code');
    assert.ok(r.body.entries.some((e) => e.title === 'Editado style/color-script.md'));
    assert.ok(r.body.entries.some((e) => e.title === 'Dibujar páginas: Página 1: dibujar'));
    assert.ok(r.body.entries.some((e) => e.title_code === 'activity.project_created' && e.title === 'Proyecto «El último ferry» creado'));
    coded += assertSpanish(r.body, 'history');
    for (const snapshot of snapshots) {
      assert.ok(snapshot.screens.every((x) => x.summary && x.summary_code), 'a screen summary without a code');
      coded += assertSpanish(snapshot, 'overview');
    }
    assert.ok(snapshots.some((o) => o.screens.some((x) => x.blockers.length)), 'the run never showed a blocker');
    r = await s.api('GET', `${P}/issues/ISS_001/publish`);
    coded += assertSpanish({ readiness: r.body.readiness, formats: r.body.formats }, 'publish');
    assert.ok(r.body.readiness.blockers.length > 0);
    assert.ok(coded > 200, `only ${coded} coded sentences were checked`);
    // The scan is able to fail: the same payloads read in English do not pass it.
    r = await s.api('GET', `${P}/history?limit=20&lang=en`);
    assert.throws(() => assertSpanish(r.body, 'history'), /English text|is not the Spanish text/);

    // --- the event stream speaks the project's language ---------------------------------------------
    const jobEvent = await events.waitFor((e) => e.type === 'job' && e.data.job && e.data.job.op === 'publish.build');
    assert.strictEqual(jobEvent.data.job.title, 'Publicar');
    const activity = await events.waitFor((e) => e.type === 'activity' && e.data.entry && e.data.entry.title_code === 'activity.edited');
    assert.strictEqual(activity.data.entry.title, 'Editado style/color-script.md');
    events.close();

    // --- what is stored is the code: the same job and the same history read in English on request,
    //     and after the interface language of the project changes ------------------------------------
    const first = jobs[jobs.length - 1];
    r = await s.api('GET', `${P}/jobs/${first.id}?lang=en`);
    assert.deepStrictEqual([r.body.job.title, r.body.job.steps[0].label], ['Set up the project', 'Save the description']);
    const stored = JSON.parse(fs.readFileSync(path.join(s.home, id, '.studio', 'jobs', `${first.id}.json`), 'utf8'));
    assert.deepStrictEqual(stored.title, { $t: 'op.project.setup.title', params: {} }, 'a job file keeps the code, not a sentence');
    r = await s.api('PUT', `${P}/settings`, { language: 'en' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    r = await s.api('GET', `${P}/jobs/${first.id}`);
    assert.strictEqual(r.body.job.title, 'Set up the project');
    r = await s.api('GET', `${P}/history?limit=500`);
    assert.ok(r.body.entries.some((e) => e.title === 'Draw pages: Page 1: draw'));
    r = await s.api('GET', P);
    assert.strictEqual(r.body.screens.find((x) => x.key === 'story').summary, 'The story bible is written.');
    r = await s.api('GET', `${P}?lang=es`);
    assert.strictEqual(r.body.screens.find((x) => x.key === 'story').summary, 'La historia está escrita.');
  } finally {
    await s.close();
  }
}

async function main() {
  const started = Date.now();
  const keys = dictionaries();
  await spanishProject();
  console.log(`studio-i18n: ok (${keys} keys, ${Date.now() - started} ms)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
