# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

This is **not a comic project**. It is a layered workflow *scaffold* for
AI-assisted comic creation: a coordinated system of rules, agents, commands,
skills, and contexts that a coding assistant loads to do source analysis, canon
and series planning, character and location bibles, page and panel planning,
continuity ledgers, reference-driven prompt compilation, page generation,
visual review, repair, lettering, and edition assembly inside a user's
`production/` workspace.

The repository's own "code" is a Node.js (>= 18, zero runtime deps, CommonJS)
tooling layer under `scripts/` that **validates and generates** the scaffold's
content so it cannot drift out of sync, plus the mechanical gates and
publishing tools that run against a workspace.

## Commands

```bash
npm test                  # node tests/run-all.js: scaffold self-tests
npm run validate          # full validation gate (what CI runs)
npm run doctor            # diagnose an install: env, providers, harness wiring
npm run sync:harnesses    # regenerate .claude/ .codex/ .cursor/ .opencode/ .agents/
```

Run a single test file directly: `node tests/<file>.test.js`.

Workspace tools (all take `--help`):

```bash
node scripts/validate-workspace.js --root examples/the-night-ferry
node scripts/check-continuity.js --root examples/the-night-ferry
node scripts/build-reference-plan.js --page <page.yaml>
node scripts/compile-prompts.js --page <page.yaml>
node scripts/generate-assets.js --page <page.yaml>        # dry-run by default
node scripts/letter-pages.js --page <page.yaml>
node scripts/build-edition.js --edition <edition.yaml>
node scripts/build-board.js --issue <issue dir>
```

## Source of truth vs. generated artifacts

| Edit this (source of truth) | Generates this (do NOT hand-edit) | Sync |
|---|---|---|
| `commands/*.md`, `agents/*.md`, `skills/*/SKILL.md`, `rules/`, `hooks/hooks.json`, `manifests/harnesses.json` | `.claude/`, `.codex/`, `.cursor/`, `.opencode/`, `.agents/` | `npm run sync:harnesses` |

Workflow: edit the source → run the sync → commit both. `npm run validate`
fails on wrapper drift, roster mismatches, schema violations, broken
cross-references, and an example workspace that no longer passes its gates.

## Architecture

- `rules/`: policy. `common/` applies always; `writing/`, `visual/`, `layout/`,
  `lettering/`, `image/`, `publishing/` are domain layers; `paged/` and
  `webtoon/` are mutually exclusive format layers selected by `comic_format`
  in `production/project.yaml`.
- `agents/`: specialized roles (who owns the work).
- `commands/`: workflow entry points; `/smart-page` is the orchestrator that
  turns a scene into page layouts, panel script, ledger, reference plan, and
  prompts.
- `skills/`: reusable procedures that commands and agents invoke.
- `schemas/`: JSON Schema (draft 2020-12) for every workspace artifact.
- `manifests/`: machine-readable index; validation and installers read these,
  so rosters live here, not in prose.
- `providers/`: image adapters sharing one interface (`compile()` pure,
  `generate()` dry-run by default, env-gated live mode).
- `hooks/`: harness hooks: validate-after-write, protect-approved-assets,
  detect-continuity-drift, require-cost-confirmation.
- `examples/the-night-ferry/`: a complete two-page workspace that passes every
  mechanical gate. Tests and `npm run validate` run against it.
- `scripts/lib/workspace.js`: the one place that knows the workspace layout.
  Scripts and hooks go through it.

The full authoring contract is `docs/conventions.md` (rosters, frontmatter
formats, ID scheme, command → agent → skill map, provider interface, manifest
shapes) plus `docs/data-model.md` (the shape of every workspace file and the
ledger, review, and edition rules). Read both before adding or renaming
anything.

## Hard rules

- English everywhere. Zero runtime dependencies in `scripts/` and `providers/`.
- Never hand-edit generated harness directories.
- Never log or commit API keys; providers must refuse live runs without their
  env vars and default to dry-run.
- Roster changes (agents, commands, skills, rules, providers) touch three
  places: the Markdown/JS file, the matching manifest, and `docs/conventions.md`.
- Data-model changes touch four places: the schema, the template, the example
  workspace, and `docs/data-model.md`.
- Tooling never certifies artwork. Scripts and tests check structured data;
  only a visual review of the rendered pages says whether a page is right.
  Keep the two apart in every report, message, and doc.
- Every feature ships with its documentation: update the README, the layer
  READMEs (`commands/`, `skills/`, `rules/`, `schemas/`, `templates/`), and
  `docs/getting-started.md` in the same change that adds the capability.
  Prefer wording that doesn't hardcode counts outside the roster files.
