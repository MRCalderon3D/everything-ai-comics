# Contributing

This repository is a scaffold: Markdown, JSON, YAML, and a small Node.js
tooling layer that keeps them in agreement. Most contributions are a new or
better rule, agent, command, or skill, a schema change, or a fix to a
script. Read [docs/conventions.md](docs/conventions.md) and
[docs/data-model.md](docs/data-model.md) before changing anything. Together
they are the contract, and the validation gate enforces the parts a machine
can check.

## Run the gates

You need Node.js 18 or later. There is nothing to install.

```bash
npm test             # every test file under tests/
npm run validate     # manifests, rosters, file formats, schemas, the example, wrapper and badge drift
```

Both must pass before a change is done. CI runs the same two commands on
Node 18, 20, and 22.

Narrower runs while you work:

```bash
node tests/continuity.test.js                 # one test file
node scripts/validate.js --section commands   # one section of the gate
node scripts/sync-harnesses.js --check        # report wrapper drift without writing
```

If you touched the example workspace, a schema, or a script that reads a
workspace, run the workspace gates too:

```bash
node scripts/validate-workspace.js --root examples/the-night-ferry
node scripts/check-continuity.js --root examples/the-night-ferry
```

These gates check structured data and tooling. They do not look at
artwork, and a change description should not claim that they do.

## Source of truth and generated files

| Edit this | It generates this, which you never edit by hand | Sync |
|---|---|---|
| `commands/*.md`, `agents/*.md`, `skills/*/SKILL.md`, `rules/**`, `hooks/hooks.json`, `manifests/harnesses.json` | `.claude/`, `.codex/`, `.cursor/`, `.opencode/`, `.agents/` | `npm run sync:harnesses` |
| `manifests/*.json`, `schemas/*.schema.json`, `package.json` (license) | `docs/images/badges/*.svg`, the README header badges | `npm run badges` |

Edit the source, run the sync, and commit both. `npm run validate` fails
when the generated directories or the badges differ from what the scripts
would write. A roster change moves a count, so it needs `npm run badges`
too.

## A roster change touches three places

Adding, renaming, or removing an agent, a command, a skill, a rule, or a
provider means changing, in the same commit:

1. The file itself: `agents/<name>.md`, `commands/<name>.md`,
   `skills/<name>/SKILL.md`, `rules/<layer>/<name>.md`, or
   `providers/image/<id>.js`.
2. Its manifest entry in `manifests/`. A command's entry also mirrors its
   agents and skills, and `manifests/profiles.json` lists what each install
   profile carries.
3. The roster in `docs/conventions.md`, including the description sentence,
   which the frontmatter and the manifest repeat verbatim.

Then run `npm run sync:harnesses` and `npm run validate`. Each layer's
README has the details for its own format.

## A data-model change touches four places

Changing the shape of a workspace file means changing together:

1. The schema in `schemas/`.
2. The template in `templates/`.
3. The example workspace in `examples/the-night-ferry/`, which has to keep
   passing every gate.
4. `docs/data-model.md`.

If the change adds a new kind of file, register its path in
`scripts/lib/artifacts.js`, which the workspace validator and the write
hook share. Schemas use only the keywords listed in
[schemas/README.md](schemas/README.md), because the validator is written
in-house and supports a subset.

## Code

- Node.js 18 or later, CommonJS, and zero runtime dependencies in
  `scripts/`, `providers/`, and `hooks/`. Node built-ins only.
- Go through `scripts/lib/workspace.js` for anything that depends on the
  workspace layout. It is the one place that knows it.
- Every script takes `--help` and documents each flag there.
- Generation is dry-run by default. A provider refuses a live run when its
  environment variable is missing, and a live run needs `--live` and
  `--yes`.
- Never log, print, or commit an API key. Request specs written to disk
  carry no credentials.
- Nothing overwrites a render, an approved reference, or an export. New
  output takes the next version.
- A script that reports on a workspace keeps mechanical validation and
  visual review apart in its output.
- Match the style of the neighboring files, and add a test for new
  behavior.

## Documentation

Documentation ships with the feature. The change that adds a capability
also updates the root README, the README of the affected layer, and
[docs/getting-started.md](docs/getting-started.md) where a user would
notice the difference. Outside the roster files, prefer wording that does
not hardcode counts.

## Prose

Everything a person reads is written in English and should read as if a
person wrote it. In short:

- Concrete nouns and facts before adjectives. Imperative mood for
  instructions.
- None of the stock words and phrases the skill lists as tells.
- No negative parallelism (denying one thing to assert another), and no
  participle tail that comments on the fact it follows.
- No rhetorical lists of three, no vague attributions, and no closing
  summary that repeats the section.
- Commas, periods, colons, or parentheses where an em dash would go.
- Sentence case in headings, no bold scattered through body text, no emoji.
- Vary sentence and paragraph length.

The full list is in
[skills/text-humanization/SKILL.md](skills/text-humanization/SKILL.md), and
the policy is [rules/writing/prose-style.md](rules/writing/prose-style.md).
Model-facing prompt text is exempt and answers to the `prompt-compilation`
skill. The section headings that the contract mandates for agents,
commands, skills, and rules keep their exact names.

Never use the character or story names of a real unpublished work in
examples. Use The Night Ferry (`CHAR_MARA`, `CHAR_OSKAR`, `LOC_FERRY_DECK`)
or generic wording.

## Commits

Conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, with an optional
scope, as in `feat(publishing): add edition builder`. Commit the generated
wrappers together with their source. Do not add AI co-author or "generated
with" trailers.

The project is released under the [MIT license](LICENSE).
