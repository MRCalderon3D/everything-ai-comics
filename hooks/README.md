# hooks/

Hook handlers that apply the scaffold's policies at the moment a file is
written or a command is run. `hooks.json` is the harness-agnostic wiring
(event to script). `scripts/sync-harnesses.js` translates it into each
harness's native format.

## Contract

Every handler:

- reads one JSON event from stdin. The shape depends on the harness; handlers
  accept `{file}`, `{command}`, and Claude-style `{tool_input: {...}}`. A
  relative path is resolved against the event's `cwd` when there is one.
- writes messages for a person or an agent to stderr.
- exits 0 to allow and 2 to block. Advisory hooks always exit 0.
- exits 0 on its own internal errors, and never prints secrets.

Each handler also exports `handle(event)`, which returns the exit code, so
tests can call it without a child process.

## Workspaces

A workspace is any directory that holds `project.yaml`. `production/` is the
default name and nothing depends on it: `production-night-ferry/` next to it
is a second workspace with its own references and continuity. Handlers walk up
from the written file to the nearest `project.yaml` and work with the path
relative to that directory. Files outside a workspace are ignored. For a
fresh workspace that has no `project.yaml` yet, a path segment named
`production` is accepted as the root.

The `match` globs in `hooks.json` start with `**` for the same reason. They
tell a harness which writes are worth sending to a handler. The handler makes
the real decision.

## The four hooks

| Hook | Event | Effect |
|---|---|---|
| `protect-approved-assets.js` | before a file write | Blocks three overwrites: a reference asset whose status is `approved` in `references/manifest.yaml`, any existing file under a page's or a cover's `renders/`, and any existing file under `editions/<ED_ID>/exports/`. The message names the next version to create (`PG_001_002_V03`, `ED_001_02`, `CHAR_MARA_TURN_MASTER_V02`). |
| `validate-after-write.js` | after a file write | Blocks when a schema-known artifact (project, character, issue, scene, page, review, edition, and the rest) fails its schema in `schemas/`, or is not parseable YAML. |
| `detect-continuity-drift.js` | after a `page.yaml` write | Warns. Runs the panel ledger audit for the page's issue and prints the findings that touch the page: a level change with no `moved`, a prop that changed hands with no `transfers` entry, a dropped state tag, a broken page chain. |
| `require-cost-confirmation.js` | before a shell command | Blocks `generate-assets ... --live` without `--yes`. Dry-run first, confirm the cost estimate, then run again with both flags. |

`validate-after-write.js` and `scripts/validate-workspace.js` share one
path-to-schema table, `scripts/lib/artifacts.js`. Add a new artifact type
there and both pick it up.

Why renders and exports are protected: a repair produces a sibling version so
the flagged image stays available for comparison, and a review file names the
exact render it judged. Overwriting `PG_001_002_V01.png` would leave a review
that describes pixels nobody can open any more. An edition lists exact renders
and exact export files for the same reason.

## What the hooks do not cover

They see writes made through the harness's file tools. A shell `cp` over a
render or a script that writes with `fs` goes past them. That is why
`build-edition.js` carries its own refusal to overwrite an export, and why
`npm run validate:workspace` exists as the batch gate.

They check structured data. A page file that passes every hook says nothing
about the image generated from it. That judgment belongs to `/visual-review`.

## Wiring per harness

### Claude Code

`npm run sync:harnesses` writes `.claude/settings.json` with `PreToolUse`
entries (Write|Edit runs protect-approved-assets, Bash runs
require-cost-confirmation) and `PostToolUse` entries (Write|Edit runs
validate-after-write and detect-continuity-drift). Each entry runs
`node hooks/<name>.js`. Claude Code pipes the tool payload to stdin and treats
exit 2 as a block whose stderr goes back to the model.

### Codex CLI, Cursor, OpenCode

These harnesses have no uniform hook API. Wire the same scripts through
whatever the harness offers (shell wrappers, task runners, CI), or rely on the
batch gates: `npm run validate:workspace` and `npm run check:continuity` run
the same checks over a whole workspace. The generated `.codex/AGENTS.md` and
`.cursor/rules/` tell the agent to follow the hooks by hand: never overwrite
an approved reference, a render, or an export; validate an artifact after
writing it; never run live generation without `--yes`.

### Git (optional, any harness)

A pre-commit that runs `npm run validate:workspace` catches what the
write-time hooks catch, later.

## Testing a hook by hand

```bash
echo '{"file":"production/issues/ISS_001/pages/PG_001_002/page.yaml"}' | node hooks/validate-after-write.js
echo '{"file":"production/issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V01.png"}' | node hooks/protect-approved-assets.js
echo '{"command":"node scripts/generate-assets.js --page page.yaml --live"}' | node hooks/require-cost-confirmation.js
echo $?   # 2 = blocked
```

`node tests/hooks.test.js` runs all four against a temporary workspace.
