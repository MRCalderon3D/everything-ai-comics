# manifests/

Machine-readable index of the scaffold. Validation (`npm run validate`), the
installer (`scripts/install.js`), and harness generation
(`scripts/sync-harnesses.js`) read these files. `docs/conventions.md` states
the contract in prose; the manifests are what the tooling checks against it.

## Files

| File | Contents |
|---|---|
| `agents.json` | One entry per agent: `name`, `file`, `description`. |
| `commands.json` | One entry per command: `name`, `file`, `description`, plus `agents[]` and `skills[]` copied from the command → agents → skills map in `docs/conventions.md`. |
| `skills.json` | One entry per skill: `name`, `file`, `description`, `category` (story, visual, production, generation, or post). |
| `rules.json` | The rule layers: `name`, `kind` (`common`, `domain`, or `format`), and the `rules` each layer holds. `paged` and `webtoon` are the two format layers. |
| `image-providers.json` | Image backends: `id`, `file`, `label`, `env`, `capabilities`. |
| `profiles.json` | Install profiles (`full`, `writing-room`, `layout`, `generation`, `publishing`), each listing the commands, agents, and skills it ships. Read by `scripts/install.js`. |
| `harnesses.json` | Wrapper strategy per harness: target directory, how commands, agents, skills, and rules map, and what happens to frontmatter. Read by `scripts/sync-harnesses.js`. |

## Install profiles

| Profile | Covers |
|---|---|
| `full` | Every command, agent, and skill. |
| `writing-room` | Source analysis, the story bible, and the series plan. |
| `layout` | Story and bibles through page plans, panel scripts, thumbnails, and the panel ledger. No image generation. |
| `generation` | Master references, reference plans, page generation, visual review, and repair. |
| `publishing` | Lettering, continuity review, and edition assembly. |

`/humanize` and `/self-review` ship with every profile. A profile always
includes each agent and skill that its commands list in `commands.json`;
validation fails when one is missing.

## Invariants (enforced by `npm run validate`)

- Every `name` and `id` matches the rosters in `docs/conventions.md` exactly.
- Every `file` path exists on disk.
- `description` fields repeat the one-line descriptions in
  `docs/conventions.md` word for word, and the frontmatter of each agent,
  command, and skill file repeats them again.
- `commands.json` `agents[]` and `skills[]` appear in each command's
  `## Invokes Agents` and `## Required Skills` sections.
- `rules.json` lists the same layers, kinds, and rule names as the roster, and
  `rules/` holds exactly those files.
- Provider `id`, `env`, and `capabilities` deep-equal what the provider module
  exports.
- Profile members are roster names.

## Editing

A roster change touches three places: the Markdown or JS file, the matching
manifest here, and `docs/conventions.md`. Change all three in one commit, then
run `npm run sync:harnesses` and `npm run validate`.

Provider `capabilities` are hard limits. `compile()` and validation check
prompt packages against them, so record what the backend really accepts.
