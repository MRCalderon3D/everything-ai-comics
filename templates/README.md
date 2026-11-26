# templates/

Starter files for a `production/` workspace. `scripts/create-project.js`
copies the project-level ones when it scaffolds a workspace, and the commands
copy the rest when they create a character, a location, a page, or a review.

Each YAML template validates against its schema in [schemas/](../schemas/).
The values are placeholders: `TODO:` strings tell you what to write, and the
IDs (`CHAR_EXAMPLE`, `LOC_EXAMPLE`, `PROP_EXAMPLE`, `PG_001_001`) are valid
and agree with each other across files, so the set reads as one small
workspace. Short `#` comments list the allowed values of each enum.

For a filled-in workspace, read [examples/the-night-ferry/](../examples/the-night-ferry/).

## Contents

| Template | Goes to | Schema |
|---|---|---|
| `project/project.yaml` | `production/project.yaml` | `project` |
| `story/story-bible.yaml` | `production/story/story-bible.yaml` | `story-bible` |
| `story/series-plan.yaml` | `production/story/series-plan.yaml` | `series-plan` |
| `style/style-bible.md` | `production/style/style-bible.md` | none (human document) |
| `style/style-block.txt` | `production/style/style-block.txt` | none (frozen prompt text) |
| `style/color-script.md` | `production/style/color-script.md` | none (human document) |
| `character/character.yaml` | `production/characters/<CHAR_ID>/character.yaml` | `character` |
| `character/wardrobe.yaml` | `production/characters/<CHAR_ID>/wardrobe.yaml` | `wardrobe` |
| `location/location.yaml` | `production/locations/<LOC_ID>/location.yaml` | `location` |
| `location/map.yaml` | `production/locations/<LOC_ID>/map.yaml` | `location-map` |
| `prop/prop.yaml` | `production/props/<PROP_ID>/prop.yaml` | `prop` |
| `issue/issue.yaml` | `production/issues/<ISS_ID>/issue.yaml` | `issue` |
| `scene/scene.yaml` | `production/issues/<ISS_ID>/scenes/<SC_ID>.yaml` | `scene` |
| `page/page.yaml` | `production/issues/<ISS_ID>/pages/<PG_ID>/page.yaml` | `page` |
| `page/lettering.yaml` | `production/issues/<ISS_ID>/pages/<PG_ID>/lettering.yaml` | `lettering` |
| `page/reference-plan.yaml` | `production/issues/<ISS_ID>/pages/<PG_ID>/reference-plan.yaml` | `reference-plan` |
| `review/visual-review.yaml` | `production/issues/<ISS_ID>/pages/<PG_ID>/reviews/<RENDER_ID>.review.yaml` | `visual-review` |
| `continuity/final-state.yaml` | `production/continuity/<ISS_ID>.final-state.yaml` | `continuity-state` |
| `edition/edition.yaml` | `production/editions/<ED_ID>/edition.yaml` | `edition` |
| `references/manifest.yaml` | `production/references/manifest.yaml` | none (read by scripts) |
| `looks/*.yaml` | copied by hand into the style bible | none (style presets) |

A template is named after its schema, with two exceptions: `map.yaml` uses
`location-map` and `final-state.yaml` uses `continuity-state`.

Prompt packages and generation records have no template. `compile-prompts.js`
and `generate-assets.js` write them.

## Tokens

`create-project.js` replaces four tokens in the files it copies. The first
three appear in `project/project.yaml` and in the `title` of the two story
templates.

| Token | Replaced with |
|---|---|
| `{{TITLE}}` | The `--title` value. |
| `{{PROJECT_ID}}` | The title in upper case with underscores. It appears in a comment only. |
| `{{DATE}}` | The creation date, `YYYY-MM-DD`. |
| `{{COMIC_FORMAT}}` | The `--format` value, or `paged`. No shipped template uses it. |

The files parse and validate before and after substitution. Keep each token
inside double quotes if you move it. `--format` rewrites the `comic_format`
line of `project.yaml`, so leave that key at the top level on a line of its
own.

## Notes

- The project-level templates (`project`, `story`, `style`, `references`) name
  no character, location, prop, or asset, because a new workspace has none.
  `look_refs`, `characters`, and `assets` start empty, and the example rows
  are commented out.
- The entity and page templates do refer to each other. The page template's
  character, wardrobe, prop, level, and landmarks all exist in the character,
  prop, and location templates. Rename them together.
- `page/page.yaml` has two panels on purpose. The second one shows a character
  moving (`moved`) and a prop changing hands (`transfers`).
- `review/visual-review.yaml` is a first review with one open blocking
  finding, so its verdict is `flagged`. A `pass` review has an empty
  `findings` list and no failed check. A `fixed` review keeps the finding,
  sets its status to `fixed`, and adds a `recheck`.
- `page/lettering.yaml` is used only when `lettering.mode` is `overlay`. Its
  text must equal the text in `page.yaml`.
- `style/style-block.txt` opens with instructions on `#` lines. Delete them
  when the block is final; the block is pasted into every request as it is.
- `looks/` has its own [README](looks/README.md).

Directory names must match the IDs inside the files: `characters/CHAR_MARA/`
holds a `character.yaml` whose `id` is `CHAR_MARA`.
