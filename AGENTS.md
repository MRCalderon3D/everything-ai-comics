# AGENTS.md

Guidance for AI coding assistants (Codex, Cursor, OpenCode, and others) working
in this repository. Claude Code additionally reads `CLAUDE.md` (same content,
harness-specific framing).

## What this is

A layered workflow scaffold for AI-assisted comic creation. The deliverables are
Markdown (rules, agents, commands, skills, contexts), JSON (schemas, manifests),
YAML templates, an example workspace, and a zero-dependency Node.js tooling
layer. There is no app, no build, no UI.

## Working here

- Read `docs/conventions.md` and `docs/data-model.md` first. Together they are
  the authoring contract: rosters, formats, IDs, the command → agent → skill
  map, the provider interface, and the shape of every workspace file.
  Validation enforces it.
- `npm test` and `npm run validate` must pass before any change is done.
- Generated harness wrappers (`.claude/`, `.codex/`, `.cursor/`, `.opencode/`,
  `.agents/`) are never hand-edited. Run `npm run sync:harnesses` after editing
  their sources (`commands/`, `agents/`, `skills/`, `rules/`, `hooks/hooks.json`).
- A roster change (add, rename, or remove an agent, command, skill, rule, or
  provider) touches the file, its manifest entry, and `docs/conventions.md`
  together.
- A data-model change touches the schema, the template, the example workspace
  under `examples/the-night-ferry/`, and `docs/data-model.md` together.
- Documentation ships with the feature: the same change that adds a capability
  updates the README, the affected layer READMEs, and `docs/getting-started.md`
  where user-facing behavior changed.
- Scripts and providers: Node >= 18, CommonJS, zero runtime dependencies,
  dry-run by default, no secrets in logs or commits.
- Style: English, imperative, concise. Match the structure of neighboring files
  exactly. The layers are deliberately uniform.

## Using the scaffold (inside a comic project)

When this scaffold is installed into a user's project, slash commands map to
`commands/*.md`. Follow the command file literally: load its Required Skills,
act as its Invoked Agents, respect `rules/`, write outputs only under the
workspace root (`production/` by default), validate against `schemas/`, and
keep the panel ledger, reviews, and generation records up to date as the rules
require. Bibles and approved masters outrank prompts and prior generations.

Three habits matter more than the rest:

- Plan before pixels. Pages, panels, geography, and the ledger are written and
  pass `node scripts/check-continuity.js` before a prompt is compiled.
- Judge the image, not the request. A returned file is opened and reviewed
  against the plan and the references. Passing tests or a schema check says
  nothing about what was drawn; report the two separately.
- Never overwrite. Renders, approved references, and exports are versioned. A
  repair is a sibling file, and a corrected edition is a new edition.
