'use strict';
/**
 * The operations a job can run. Each is one module in this directory with
 * the same shape:
 *
 *   name, params                      what it is, for GET /api/ops (its title and
 *                                     summary are in the dictionary: op.<name>.title)
 *   validate(params, { project, services }) -> clean params (throws HttpError)
 *   steps(params, { project })        the steps known up front
 *   async run(ctx)                    does the work through ctx.step()
 */

const { msg } = require('../i18n');

const MODULES = [
  './project-setup',
  './story-update',
  './style-define',
  './style-look',
  './character-create',
  './character-update',
  './character-sheet',
  './entities-derive',
  './pages-plan',
  './pages-generate',
  './page-review',
  './page-correct',
  './page-manual',
  './cover-create',
  './cover-correct',
  './lettering-apply',
  './publish-build',
  './chat-turn',
];

const ops = new Map();
for (const file of MODULES) {
  const op = require(file);
  ops.set(op.name, op);
}

/** The catalog as GET /api/ops returns it. */
function catalog() {
  return [...ops.values()].map((op) => ({
    name: op.name,
    title: msg(`op.${op.name}.title`),
    summary: msg(`op.${op.name}.summary`),
    params: op.params,
  }));
}

module.exports = {
  get: (name) => ops.get(String(name)) || null,
  names: () => [...ops.keys()],
  catalog,
};
