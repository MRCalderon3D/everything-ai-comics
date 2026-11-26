# templates/looks/

Starter looks for comics. Each file describes one drawing style in the terms
the style bible uses (line, inking, tone, color mode, rendering, lettering)
and carries a style block you can freeze as it stands or edit first. The
presets have no JSON schema and the validator skips them, but they must stay
plain YAML: maps, lists, strings, and one block scalar for the style block.

## Use a preset

1. Pick the file closest to the comic you want and copy its `style_block`
   text into `production/style/style-block.txt`. Edit it now if you need to.
   After approval it does not change.
2. Run `/style-bible`. It fills `style/style-bible.md` from the preset's
   `line`, `inking`, `tone`, `rendering`, and `lettering_style` fields and
   checks that `color_mode` agrees with `project.yaml`.
3. Run `/visual-development` to generate a look page from the block. When
   you approve a candidate, run
   `node scripts/approve-asset.js --candidate <LOOK_ID>_V## --root production`.
   It registers the file in `references/manifest.yaml` as your look master
   (for example `LOOK_NOIR_INK_MASTER_V01`) and lists it under
   `style.look_refs` in `project.yaml`. From then on it is attached to every
   request with the role `style`.

A preset is a draft. The approved look of a production is the frozen block
plus the approved look master image, and both live in the workspace.

## Fields

| Field | What it holds |
|---|---|
| `id`, `name`, `status` | Identity of the preset. `status` stays `draft` here. |
| `intent` | When this look suits a story. |
| `line`, `inking`, `tone`, `rendering` | The drawing, in checkable terms. |
| `color_mode` | `monochrome`, `limited`, or `full_color`, as in `project.yaml`. |
| `palette` | Named colors for limited and full-color looks. |
| `lettering_style` | Case, balloons, captions, and sound effects. |
| `style_block` | The prompt text to freeze. |
| `prompt_vocabulary`, `negative_vocabulary` | Phrases the prompt director may draw on, and phrases to keep out. |
| `pairs_with` | Formats, publication types, and genres the look usually serves. |

## Presets

| Preset | ID | In one line |
|---|---|---|
| `noir-ink.yaml` | `LOOK_NOIR_INK_V01` | Brush ink, heavy spotted blacks, no grey. |
| `ligne-claire.yaml` | `LOOK_LIGNE_CLAIRE_V01` | Even line, flat color, detailed settings. |
| `manga-screentone.yaml` | `LOOK_MANGA_SCREENTONE_V01` | Pen line with screentone greys and speed lines. |
| `painted-watercolor.yaml` | `LOOK_PAINTED_WATERCOLOR_V01` | Pencil under transparent washes on rough paper. |
| `superhero-modern.yaml` | `LOOK_SUPERHERO_MODERN_V01` | Thick-to-thin ink with modelled digital color. |
| `newspaper-strip.yaml` | `LOOK_NEWSPAPER_STRIP_V01` | Bold cartoon line, one tier, large lettering. |
