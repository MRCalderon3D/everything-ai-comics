# schemas/

JSON Schema (draft 2020-12) for every structured artifact in a `production/`
workspace. The shapes are specified in [docs/data-model.md](../docs/data-model.md);
these files encode them. `validate-workspace.js` and the `validate-after-write`
hook check each YAML file against its schema.

## Conventions

- One schema per artifact: `schemas/<name>.schema.json`.
- `$id` is `https://everything-ai-comics.dev/schemas/<name>.schema.json`.
- `$schema` is `https://json-schema.org/draft/2020-12/schema`.
- Every schema stands alone. `$ref` points only into the same file's `$defs`.
- Objects whose keys the data model lists set `additionalProperties: false`.
  A typo in a field name fails validation.
- Closed vocabularies are enums. Every ID field carries the pattern from the
  ID scheme in [docs/conventions.md](../docs/conventions.md).
- Every top-level document accepts an optional free-text `notes`.
- Only fields marked required in the data model are required here.

## Roster (19, mirrors docs/conventions.md)

| Schema | Validates | Lives at |
|---|---|---|
| `project` | Format, page geometry, color mode, lettering mode, style anchors, default provider, repair policy | `production/project.yaml` |
| `story-bible` | Premise, world rules, facts tagged by provenance, arcs, timeline, open questions | `production/story/story-bible.yaml` |
| `series-plan` | Issues with source span, page budget, and status | `production/story/series-plan.yaml` |
| `character` | Identity, description, distinguishing features, adjacent characters, references | `production/characters/<CHAR_ID>/character.yaml` |
| `wardrobe` | Wardrobe states of one character | `production/characters/<CHAR_ID>/wardrobe.yaml` |
| `location` | Description, time-of-day states, references | `production/locations/<LOC_ID>/location.yaml` |
| `location-map` | Levels, side convention, landmarks, exits, connections | `production/locations/<LOC_ID>/map.yaml` |
| `prop` | Description, hands required, references | `production/props/<PROP_ID>/prop.yaml` |
| `issue` | Scenes, page and panel counts, status | `production/issues/<ISS_ID>/issue.yaml` |
| `scene` | Location, cast, fixed geography, beats, pages | `production/issues/<ISS_ID>/scenes/<SC_ID>.yaml` |
| `page` | Layout, panel script, panel ledger, lettering text | `production/issues/<ISS_ID>/pages/<PG_ID>/page.yaml` |
| `lettering` | Overlay geometry for balloons, captions, and sound effects | `production/issues/<ISS_ID>/pages/<PG_ID>/lettering.yaml` |
| `reference-plan` | Reference images for one page, one role each, with priority and omission risk | `production/issues/<ISS_ID>/pages/<PG_ID>/reference-plan.yaml` |
| `prompt-package` | Compiled prompt, parameters, references, repair block, source hashes | `production/issues/<ISS_ID>/pages/<PG_ID>/prompts/<provider>.yaml`, and any `prompts/*.yaml` beside reference art (`<entity dir>/refs/prompts/`, `references/style/prompts/`) |
| `generation-record` | Provenance of one attempt: provider, model, output, cost, status | `production/generations/<scope>/GEN_*.yaml` |
| `visual-review` | Fourteen checks with evidence, findings (a reviewer's, or a person's change request), two gates, verdict | `production/issues/<ISS_ID>/pages/<PG_ID>/reviews/<RENDER_ID>.review.yaml` |
| `cover` | The cover of an issue: concept, cast, props, cover lettering, approval state | `production/issues/<ISS_ID>/cover/cover.yaml` |
| `continuity-state` | Where every character and prop is at the end of an issue | `production/continuity/<ISS_ID>.final-state.yaml` |
| `edition` | The exact render of every page and of the optional cover, and the exports built from them | `production/editions/<ED_ID>/edition.yaml` |

A cover reuses three of these schemas. Its prompt package
(`cover/prompts/<provider>.yaml`), its generation records
(`generations/<COVER_ID>/GEN_*.yaml`), and its reviews
(`cover/reviews/<RENDER_ID>.review.yaml`) follow `prompt-package`,
`generation-record`, and `visual-review`, with the cover ID in the `page`
field.

`references/manifest.yaml` has no schema. Scripts read its fields directly;
the data model lists them.

## ID patterns

| Thing | Pattern | Example |
|---|---|---|
| Issue | `^ISS_\d{3}$` | `ISS_001` |
| Scene | `^SC_\d{3}_\d{2}$` | `SC_001_02` |
| Beat | `^BT_\d{3}_\d{2}_\d{2}$` | `BT_001_02_01` |
| Page | `^PG_\d{3}_\d{3}$` | `PG_001_004` |
| Panel | `^PN_\d{3}_\d{3}_\d{2}$` | `PN_001_004_03` |
| Render | `^PG_\d{3}_\d{3}_V\d{2}$` | `PG_001_004_V02` |
| Cover | `^CV_\d{3}$` | `CV_001` |
| Cover render | `^CV_\d{3}_V\d{2}$` | `CV_001_V02` |
| Lettering element | `^L\d{2}$` | `L03` |
| Finding | `^F\d{2}$` | `F01` |
| Edition | `^ED_\d{3}_\d{2}$` | `ED_001_03` |
| Entity | `^(CHAR\|LOC\|PROP\|LOOK)_[A-Z][A-Z0-9_]*$` | `CHAR_MARA` |
| Asset | `^(CHAR\|LOC\|PROP\|LOOK)_[A-Z][A-Z0-9_]*_V\d{2}$` | `CHAR_MARA_TURN_MASTER_V01` |
| Wardrobe state | `^WARD_[A-Z][A-Z0-9_]*$` | `WARD_MARA_OILSKIN` |
| Fact | `^FACT_\d{3}$` | `FACT_007` |
| Provider | `^[a-z][a-z0-9-]*$` | `harness-native` |
| State tag, level, landmark | `^[a-z][a-z0-9_]*$` | `cut_left_hand`, `deck`, `crates` |
| Prompt package | `^PP_(PG_\d{3}_\d{3}\|CV_\d{3}\|<entity>)_[A-Z0-9][A-Z0-9_-]*$` | `PP_PG_001_001_HARNESS-NATIVE`, `PP_PG_001_002_FAL-P03`, `PP_CV_001_FAL`, `PP_CHAR_MARA_FAL-TURN` |
| Generation record | `^GEN_(PG_\d{3}_\d{3}\|CV_\d{3}\|<entity>)_\d{2}$` | `GEN_PG_001_002_02`, `GEN_CV_001_01` |

## Design decisions

- The page is one file. `page.yaml` holds the layout, the panel script, the
  ledger rows (`cast`, `props`, `transfers`), and the exact lettering text, so
  the plan and the ledger cannot drift apart.
- A ledger row is strict. Each `cast` row requires `character`, `position`,
  `action`, `wardrobe`, and `state`. An off-panel character keeps a full row.
- Null is a value. Fields such as `spread_with`, `ellipsis`, `moved`,
  `carrying`, `speaker`, and `current_render` accept `null` so a file can say
  "none" on purpose. `transition_in` accepts `null` for the first panel of a
  scene.
- A review names all fourteen checks. `checks` requires every key, and each
  check requires a `result` and a non-empty `evidence`.
- A cover is reviewed with the same schema. The checks that judge the panel
  ledger (`position`, `movement`, `role_causality`) are recorded as
  `not_applicable` with the reason as evidence, so a cover review still
  lists fourteen checks. `validate-workspace.js` enforces that.
- A cover carries its own approval. `cover.yaml` requires `status` and
  `approved_render`, and the second is `null` while the first is `draft`.
- A fixed finding needs a recheck. The finding schema accepts `status: fixed`
  only when `recheck` is present with a render and evidence. The other review
  rules compare several fields and are enforced by `validate-workspace.js`.
- Unreported metadata is valid. A generation record accepts `model: unreported`,
  a null `cost.amount`, and a null `seed`, and lists them under
  `metadata_unavailable`.
- Maps keyed by ID use `patternProperties`. `continuity-state.characters` takes
  `CHAR_*` keys and `continuity-state.props` takes `PROP_*` keys.
- `prompt-package.parameters` is the one open object, because providers need
  their own settings.

## Validator subset

`scripts/lib/schema.js` is a zero-dependency validator and supports part of
draft 2020-12. The schemas use only what it supports: `type` (including lists
of types), `properties`, `patternProperties`, `required`,
`additionalProperties`, `items`, `enum`, `pattern`, `minimum`,
`exclusiveMinimum`, `minLength`, `minItems`, `anyOf`, and same-file `$ref`.
They avoid `if`/`then`/`else`, `not`, `uniqueItems`, `prefixItems`, and
`contains`, which the validator ignores.

## What the schemas do not check

A schema checks the shape and vocabulary of one file. Anything that needs a
second file is left to the scripts:

- `check-continuity.js` applies the ledger rules: one row per character, prop
  custody and transfers, level changes, persistent state tags, the hands
  budget, speakers in cast, and the page chain.
- `validate-workspace.js` resolves cross-references and applies the review,
  cover, and edition rules.

Neither the schemas nor the scripts look at an image. Identity, anatomy, and
continuity in the rendered page are judged in the visual review.

## Relationships

```
project
  story-bible -> series-plan -> issue -> scene -> page
  character + wardrobe ------------------------->  |
  location + location-map ---------------------->  |
  prop ----------------------------------------->  |
                                                   v
        page -> reference-plan -> prompt-package -> generation-record
          |                                              |
          +-> lettering (overlay mode)                   v
          +-> visual-review  <----------------------  render
                   |
                   v
        continuity-state, edition

issue -> cover -> prompt-package -> generation-record -> cover render
                                                             |
                    edition (cover:)  <--  visual-review  <--+
```

## Templates

Starter YAML for these schemas lives in [templates/](../templates/). Each
template validates against its schema. A complete workspace built from them
is in [examples/the-night-ferry/](../examples/the-night-ferry/).
