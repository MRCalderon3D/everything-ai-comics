# Source of truth

## Purpose

Define which files are canonical when documents disagree, so every agent
resolves a conflict the same way and no generation quietly rewrites canon.

## Scope

All layers, all tasks, all phases. Applies to every file in a workspace and to
the generated harness wrappers (`.claude/`, `.codex/`, `.cursor/`,
`.opencode/`, `.agents/`).

## Core Principles

- Bibles and approved masters are canon. Prompts, thumbnails, and renders are
  derived artifacts and MUST be regenerated when canon changes.
- Derived artifacts NEVER feed back into canon implicitly. Promoting a
  generation to canon is an explicit approval act (see `approval-policy.md`).
- A page has one source file. Layout, panel script, panel ledger, and lettering
  text all live in `page.yaml`, and every other page artifact copies from it.
- Generated directories are regenerated, never hand-edited.

## Authority order

When two files disagree, the higher entry wins. Fix the lower one.

1. `project.yaml`: project-level facts (title, comic format, reading
   direction, page size, color mode, lettering mode, providers).
2. Bibles: `story/story-bible.yaml` and `story/series-plan.yaml`,
   `characters/*/character.yaml` with `wardrobe.yaml`,
   `locations/*/location.yaml` with `map.yaml`, `props/*/prop.yaml`,
   `style/style-bible.md` with `style/style-block.txt`.
3. Approved masters (`_MASTER` assets) and their registry,
   `references/manifest.yaml`.
4. Issue and scene files: `issues/<ISS_ID>/issue.yaml` and
   `scenes/<SC_ID>.yaml`.
5. Page files: `pages/<PG_ID>/page.yaml`.
6. Continuity state: `continuity/<ISS_ID>.final-state.yaml`. It is
   authoritative for the state observed at the end of an issue. Intent lives
   in the bibles, the scene files, and the page files.
7. Derived page artifacts: `reference-plan.yaml`, `lettering.yaml`, and the
   prompt packages under `prompts/`.
8. Renders and generation records.

Inside the story bible, a fact tagged `user_change` outranks the `source`
fact it replaces (see `writing/adaptation-fidelity.md`).

## The page file

- Lettering text is written once, in the `lettering` list of each panel in
  `page.yaml`. The `text` fields of `lettering.yaml` (overlay mode) and the
  `lettering_text` list of a prompt package are copies and MUST equal it
  character for character.
- A correction to a line of dialogue, a panel order, or a ledger row is made
  in `page.yaml` first. The reference plan, the prompt package, and the
  lettering overlay are rebuilt from it afterwards.
- A render that disagrees with `page.yaml` is a defect in the render. If the
  render shows a better idea, change the plan deliberately, re-run the ledger
  audit, and say so in the review. NEVER edit the plan after the fact to make
  a failed render look correct.

## Conflict resolution

- On conflict, the agent MUST update the lower-authority file to match the
  higher one, then regenerate anything derived from it. It MUST NOT split the
  difference or silently pick the newer file.
- If two files at the same tier disagree (two bibles, for example), the agent
  MUST stop and escalate to human review. It NEVER guesses.
- A bible and an approved master that disagree mean an approval skipped its
  bible sync (see `approval-policy.md`). Surface the difference and resolve
  it before generating anything that would inherit it.
- A prompt that contradicts a bible is a defect in the prompt, even when its
  output looks better. Change the bible first if the new direction is wanted.

## Generated artifacts

- `.claude/`, `.codex/`, `.cursor/`, `.opencode/`, and `.agents/` are produced
  by `npm run sync:harnesses`. NEVER hand-edit them. Edit the source layer and
  re-run the sync.
- Prompt packages are outputs of `scripts/compile-prompts.js`. Edit the page
  file, the reference plan, or the style block, then recompile. Each package
  records what it was compiled from in `source_hashes` (`page`,
  `reference_plan`, `style_block`); a package whose hashes no longer match
  those files is stale and MUST NOT be submitted.
- Lettered overlays (`renders/<RENDER_ID>.lettered.svg`) come from
  `scripts/letter-pages.js`, edition exports from `scripts/build-edition.js`,
  and the issue board from `scripts/build-board.js`. Rebuild them; do not
  touch them by hand.

## Validation

- `scripts/validate-workspace.js` schema-checks every structured file in the
  workspace and resolves the cross-references between them.
- `prompt-package.schema.json` requires `source_hashes` on every package.
  `scripts/generate-assets.js` compares the page, reference-plan, and
  style-block hashes with the current files: a dry run warns about a stale
  package and a live run refuses it.
- `hooks/validate-after-write.js` re-validates a schema-known file on write.
- `hooks/protect-approved-assets.js` blocks writes to approved reference
  assets.
- `npm run validate` fails when the harness wrappers have drifted from the
  source layers.
- `scripts/letter-pages.js` stops when overlay text differs from
  `page.yaml`, `scripts/validate-workspace.js` reports the same mismatch,
  and the `lettering` check of the visual review compares the rendered
  words with the page file again.
- Same-tier conflicts and canon changes go to human review before work
  continues.
