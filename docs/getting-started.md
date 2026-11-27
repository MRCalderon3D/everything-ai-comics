# Getting started

A walkthrough of a first issue, from an empty folder to an exported edition.
Each step gives the slash command you run inside your assistant (Claude Code,
Codex, Cursor, or OpenCode), the script behind it where there is one, the
file it writes, and what to look at before moving on.

The examples come from the scaffold's sample workspace,
[The Night Ferry](../examples/the-night-ferry/README.md): two pages, eight
panels, a ferry pilot called Mara, and a stowaway boy called Oskar. To run
the script calls yourself, copy the example into a scratch workspace. A
directory named `production-*` inside the clone is ignored by git.

```bash
cp -r examples/the-night-ferry production-ferry
```

Paths in this guide use `production/` as the workspace root. Any directory
that holds a `project.yaml` is a workspace, and the scripts take it through
`--root`, `--page`, `--issue`, or `--edition`. Every script prints its
options with `--help`.

One distinction runs through the whole guide. Scripts validate files:
shapes, references between files, the ledger, the review and edition rules.
A visual review judges a rendered page by looking at it. A clean script run
says nothing about a drawing, and reports keep the two results apart.

The craft behind each step is in [workflow.md](workflow.md). The list of
commands in pipeline order is in [commands/README.md](../commands/README.md).

This guide is for working from an editor. The same pipeline can be run from
the browser with the web studio: `npm run studio` starts it, and
[studio/README.md](../studio/README.md) explains it. A project made in one
opens in the other. In the studio every step can also be asked for in its
conversation, which proposes the step as a card you run, and a finished
issue can be continued with the next one (`opens_from` and the end state of
section 12 are written for you). The studio also lists the characters,
places and props a page plan created (the breakdown of section 6 can write
them), flags one that looks like an ID the story already uses so the two can
be merged, and deletes tries you do not keep without leaving the registry or
the generation records behind. Its plan review edits the lettering of each
panel (the `lettering` list of the panel script in section 6: kind,
speaker, words and reading order, with the budgets of
`rules/lettering/balloons-and-captions.md` counted while you type), and
its corrections ask you to choose once an image reaches
`repair_policy.touch_up_warning` (section 10).

## 1. Get set up

Clone and open the folder in your assistant. There is no install step.

```bash
git clone https://github.com/MRCalderon3D/everything-ai-comics my-comic
cd my-comic
```

The clone contains the generated wiring for every harness (`.claude/`,
`.codex/`, `.cursor/`, `.opencode/`, `.agents/`). You need Node.js 18 or
later for the scripts, and nothing else: they use Node built-ins only.

To work in a repository of your own, install the scaffold into it:

```bash
node scripts/install.js --target ../my-comic --harness codex --profile full
```

- `--harness`: `claude`, `codex`, `cursor`, `opencode`, `agents`, or `all`.
  The default is `claude`, and a comma-separated list works.
- `--profile`: `full`, `writing-room`, `layout`, `generation`, or
  `publishing`. The default is `full`. See
  [Customizing the scaffold](#customizing-the-scaffold).
- `--force`: overwrite files that already exist in the target.

The installer copies the chosen wrapper directories plus `rules/`,
`contexts/`, `schemas/`, `manifests/`, `templates/`, `hooks/`, `scripts/`,
and `providers/`, and writes an `install-manifest.json`.

Check the setup at any time:

```bash
node scripts/doctor.js                      # the scaffold itself
node scripts/doctor.js --target ../my-comic # an installed project
```

Doctor checks the Node version, that every file the manifests list exists,
and that the generated wrappers are up to date. It then lists the provider
variables (`FAL_KEY`, `REPLICATE_API_TOKEN`, `COMFYUI_HOST`,
`GOOGLE_API_KEY`) by name and says whether each is set. It never prints a
value. A provider whose variable is missing is limited to dry-run.

No variable is needed to start. Generation stays in dry-run until you ask
for a live run, and the `harness-native` and `manual` providers never need
one. The `codex-cli` provider needs the Codex command-line tool instead of
a variable, and doctor says whether the `codex` binary is found and which
version it is. A missing binary is reported and is not counted as a
failure.

## 2. Start the workspace

```
/project-init
```

The command asks for everything it needs in one batch, each question with a
recommended default, and writes the answers to `production/project.yaml`.
Later commands read that file instead of asking again. The choices that
shape the rest of the project:

- `comic_format`: `paged` or `webtoon`. It selects the format rule layer,
  `rules/paged/` or `rules/webtoon/`. In a webtoon a page is one scroll
  segment. Changing the format after pages are planned means replanning
  them.
- `reading_direction`: `ltr` or `rtl`. It goes into every page prompt, the
  lettering placement, and the web reader.
- `page`: `aspect_ratio`, `width_px`, and `height_px`, shared by every page.
  The ratio has to be one the provider supports. Every provider in the
  roster accepts `2:3`, `3:4`, `9:16`, and `1:1`. For print, also set
  `trim_mm`, `bleed_mm`, and `safe_margin_mm`.
- `color_mode`: `monochrome`, `limited`, or `full_color`. A limited palette
  lists its `spot_colors`, each with a single stated use.
- `lettering.mode`: `in_image` or `overlay`. With `in_image` the image
  model draws the text, every string is checked in review, and a wrong word
  costs a repair. With `overlay` the art is generated without text and
  `letter-pages.js` sets the lettering on top as an SVG, which is free to
  redo and has to be flattened by hand for an edition. No provider declares
  reliable text rendering, so decide this before the first page is rendered.
- `default_providers.image`: one of `fal`, `replicate`, `comfyui`,
  `gemini`, `harness-native`, `codex-cli`, or `manual`. The default is
  `harness-native`, which hands each request to your assistant's own image
  tool. `codex-cli` has the scripts start the Codex CLI and save the image
  themselves.
- `repair_policy.max_cycles`: how many automatic repairs a page gets before
  its plan or its references are fixed instead. The default is 2.
- `repair_policy.touch_up_warning`: how many edits an image takes before a
  touch-up you ask for comes with a warning and the offer of a redraw. The
  default is 2. You decide each time.

Behind the command:

```bash
node scripts/create-project.js --title "My Comic" --target .
```

```
create-project: production/ scaffolded at /path/to/my-comic/production
  project.yaml written for "My Comic" (from templates/project/project.yaml)
  starter files: story/story-bible.yaml, story/series-plan.yaml, style/style-bible.md, style/style-block.txt, style/color-script.md, references/manifest.yaml
```

Without `--target` the script creates `./my-comic/production/`, named after
the title. `--format webtoon` sets `comic_format` and leaves everything else
at the template's values, so review `publication` and the page size
afterwards. `--force` overwrites an existing `project.yaml` and keeps the
starter files that are already there.

The workspace it creates:

```
production/
  project.yaml
  story/        source/  story-bible.yaml  series-plan.yaml
  style/        style-bible.md  style-block.txt  color-script.md
  characters/   locations/   props/
  references/   manifest.yaml  inbox/  style/  docs/
  issues/   generations/   continuity/   editions/
```

Before moving on, open `project.yaml` and read it top to bottom. The script
writes the template's defaults (paged, `2:3` at 2000 x 3000, full color,
lettering in the image, `harness-native`), and `/project-init` replaces them
with your answers. Then run the workspace gate, which should already pass:

```bash
node scripts/validate-workspace.js --root production
```

## 3. Bring in the source and fix the canon

Put the source text, prose or script, in `production/story/source/`. The
files stay as you wrote them.

```
/source-analyze
```

This writes the fact registry into `production/story/story-bible.yaml`:
the events in order, the entities with permanent IDs (`CHAR_*`, `LOC_*`,
`PROP_*`), and one fact per thing the comic depends on. Every fact carries
a provenance:

- `source`: the text says it, and `source_ref` points at the paragraph.
- `user_change`: you decided it against the source. `replaces` names the
  fact it supersedes.
- `addition`: the adaptation invented it because the source is silent.

Each fact also lists the entities it `affects`. In The Night Ferry the
source hides the boy in a chain locker (`FACT_007`). `FACT_010` is a user
change that moves him under a tarpaulin on the open deck, replaces
`FACT_007`, and affects `CHAR_OSKAR`, `LOC_FERRY_DECK`, and a new prop,
`PROP_TARPAULIN`. One line of dialogue changes with it.

What the source leaves open goes to `open_questions`. A question is marked
`blocking: true` when the answer decides who acts, where they stand, who
holds an object, or how two characters are told apart.

```
/story-bible
```

This rules on the open questions, writes the premise, tone, world rules,
and arcs, and propagates every user change to the files that depend on it.
Look at two things before approving the canon: the additions, which are
provisional until you accept them, and the list of blocking questions. While
one has no `resolution`, no prompt is compiled and no page is generated.

```
/series-plan
```

This writes `production/story/series-plan.yaml`: the issues, the span of
source each one covers, and a page budget for each. A strip or a one-shot is
a single issue, `ISS_001`. Check that the spans cover the source with no gap
and that the budget leaves room for every handoff and arrival to be drawn.

None of the three commands generates an image. Run the gate again when they
finish:

```bash
node scripts/validate-workspace.js --root production
```

## 4. Build the bibles and the look

```
/character-bible
/location-bible
/prop-bible
/style-bible
```

| Command | Writes | Look at |
|---|---|---|
| `/character-bible` | `characters/<CHAR_ID>/character.yaml` and `wardrobe.yaml` | `distinguishing_features`, and `visually_adjacent_to` for any two characters a model could confuse |
| `/location-bible` | `locations/<LOC_ID>/location.yaml` and `map.yaml` | The map: named levels, the side convention, landmarks |
| `/prop-bible` | `props/<PROP_ID>/prop.yaml` | `hands_required` and `plot_relevant` |
| `/style-bible` | `style/style-bible.md`, `style/color-script.md`, `style/style-block.txt` | The style block |

The fields in the middle column are what the later checks run on. The
ledger places every character on a level and a side of the map, so a level
the map does not name cannot be used in a panel. The prompt compiler states
the difference between two characters who list each other under
`visually_adjacent_to`. In the example, Mara and Oskar list each other, and
every prompt for a panel they share says how the round-faced boy in the
hood differs from the woman with the broken nose.

The style block is one paragraph of literal drawing instructions in
`production/style/style-block.txt`. Once it is approved it is frozen: every
request reuses it word for word, and each prompt package records its hash.
Editing it after pages exist makes every compiled package stale, so treat a
change as a new look. Starter presets are in
[templates/looks/](../templates/looks/README.md).

## 5. Ingest references and develop the masters

If you have material of your own, drop it into
`production/references/inbox/` and run:

```
/ingest-references
```

The assistant examines each file, decides with you what it controls (an
identity, a style, a wardrobe, a place, an object), writes what it finds
into the bibles as drafts, moves the file to its home, and registers it in
`production/references/manifest.yaml` with one `default_role`. A photograph
of a face is an identity reference and says nothing about how the comic is
drawn. It is shown to the drawing tool once, for the character's first
turnaround or full character sheet. After you approve that sheet, the
sheet is the face, and expressions, outfits, pages and the cover are drawn
from it. A page by another artist is a style reference, and its faces belong
to nobody in your cast.

```
/visual-development
```

This is the first command that can spend money. It produces the reference
images that every page conditions on, in a fixed order: the look page first,
then each character's turnaround or full character sheet, then expression
and wardrobe sheets, then location plates and props. A sheet whose parent is
not approved is blocked: `compile-prompts.js` refuses an expression or
wardrobe sheet until the character has an approved turnaround or full
sheet.

The script calls behind it compile one prompt package per sheet and run it:

```bash
node scripts/compile-prompts.js --asset CHAR_OSKAR --sheet expressions --root production
node scripts/generate-assets.js --asset CHAR_OSKAR --root production
```

```
prompt package: PP_CHAR_OSKAR_HARNESS-NATIVE-EXPR (asset CHAR_OSKAR, harness-native, model harness-native) -> /path/to/production/characters/CHAR_OSKAR/refs/prompts/harness-native.expressions.yaml
  prompt: 3342 characters, 2 reference image(s), aspect 1:1
  request endpoint: (none: handoff to a person or the harness tool)
```

```
generate-assets: 1 package(s), mode: DRY RUN
  DRY_RUN GEN_CHAR_OSKAR_01 [harness-native, model unreported] no estimate
    record:  /path/to/production/generations/CHAR_OSKAR/GEN_CHAR_OSKAR_01.yaml
    request: /path/to/production/generations/CHAR_OSKAR/GEN_CHAR_OSKAR_01.request.json
    target:  characters/CHAR_OSKAR/refs/CHAR_OSKAR_EXPR_V01.png
```

`--sheet` takes `turnaround`, `model`, `expressions`, or `wardrobe` for a
character, `plate` for a location, `prop` for a prop, `look` for a look, and
`detail` with `--subject` for a close study of any entity. `model` is the
full character sheet: the name, the turnaround, labelled close-ups of what
identifies the character and a labelled row of expressions and poses, from
the `sheet` block of `character.yaml` or from `--closeups` and `--poses`.
Change it round by round with `--revise <CHAR_ID>_MODEL_V## --changes
"shorter hair; the scar on the other arm"`: the version you name is edited
into the next one and everything you did not name stays. `--outfit` picks the
wardrobe state for a wardrobe sheet, `--expressions` the list for an
expression sheet, and `--time` the time of day of a plate. Wardrobe and
detail packages carry the outfit ID or a slug of the subject in their file
name (`harness-native.wardrobe.WARD_OSKAR_HOODED_JACKET.yaml`,
`harness-native.detail.cut-on-his-left-hand.yaml`), and their candidates
the same variant (`CHAR_OSKAR_WARD_HOODED_JACKET_V01.png`). A prop sheet is
`<PROP_ID>_SHEET_V##`. A sheet needs the style block, the entity's bible file,
and an approved look master. The first look page is the only request made
without one. `generate-assets.js --package <file>` runs a single package.

The file that comes back is a candidate with the next free version, such as
`CHAR_OSKAR_EXPR_V01.png`. It never takes the `_MASTER` name. Promotion is
an approval step:

1. Open the candidate and compare it with the bible, feature by feature.
2. When you approve it, record the approval:

   ```bash
   node scripts/approve-asset.js --candidate CHAR_OSKAR_EXPR_V01 --root production
   ```

   `--candidate` takes the file's path or its name without the extension.
3. The script copies the pick to its master name with the same version
   number, here `CHAR_OSKAR_EXPR_MASTER_V01` (a look page becomes
   `<LOOK_ID>_MASTER_V##`). It registers the master in
   `references/manifest.yaml` with `status: approved`, `approved_by`,
   `approved_at`, a checksum, and the generation record the candidate came
   from. The ID goes into the entity file's `references`. A look master
   also goes into `style.look_refs` in `project.yaml`, and that freezes the
   style block.

```
approved: CHAR_OSKAR_EXPR_MASTER_V01 (expressions, role identity) for CHAR_OSKAR
  master:    characters/CHAR_OSKAR/refs/CHAR_OSKAR_EXPR_MASTER_V01.png
  candidate: characters/CHAR_OSKAR/refs/CHAR_OSKAR_EXPR_V01.png (kept)
  record:    GEN_CHAR_OSKAR_01
  wrote: characters/CHAR_OSKAR/refs/CHAR_OSKAR_EXPR_MASTER_V01.png
  wrote: references/manifest.yaml
  wrote: characters/CHAR_OSKAR/character.yaml
The approval is recorded. Nothing here checked the drawing.
```

An approved master is immutable. A change is a new candidate, approved with
`--supersede`: it gets its own manifest entry and the old one becomes
`superseded`, with its file still on disk. Without `--supersede` the script
refuses a sheet that already has a master. It lists the pages and reference
plans that still cite the old master, so you can replan them. Only approved
assets can be attached to a page request.

## 6. Plan the issue

```
/issue-breakdown
/page-plan
/panel-script
```

`/issue-breakdown` writes `issues/<ISS_ID>/issue.yaml` and one file per
scene under `scenes/`. Each scene names its location and cast, divides into
beats, and fixes its geography: `travel_direction`, `threat_direction`, and
where each group starts. In the example the patrol launch always comes from
the stern, which is screen right, and that holds on every page.

`/page-plan` writes one `pages/<PG_ID>/page.yaml` per page with
`status: planned`: the page's purpose in one sentence, the grid (`tiers`,
`reading_order`), and one drawable moment per panel. A panel whose `moment`
needs the word "while" is probably two panels. A handoff, a pickup, a drop,
or a change of level gets a panel of its own.

`/panel-script` completes each panel in the same file and sets
`status: scripted`: framing, the visible cast with positions on the map,
acting written as behavior that can be drawn, and the exact lettering text.
The text in `page.yaml` is the only copy of the words. Everything
downstream is compared against it.

The page file is one file on purpose. Layout, script, ledger, and lettering
text live together and cannot drift apart. The annotated shape is in
[data-model.md](data-model.md), and
[templates/page/page.yaml](../templates/page/page.yaml) is a commented
starter.

`/smart-page` does this section and the next two for one scene in a single
pass:

```
/smart-page SC_001_01 --pages 2 --provider harness-native
```

Use it for a first pass and the separate commands for revisions.
`/thumbnails` is an optional readability test between the script and the
ledger. Its written roughs are free.

Check the files after each command:

```bash
node scripts/validate-workspace.js --root production --issue ISS_001
```

## 7. Fill and audit the ledger

```
/panel-ledger
```

The panel script wrote a row for every visible character. This command
completes the ledger: a row for each character who is out of frame but whose
state matters (`off_panel: true`), `holding` and `carrying`, a `props` row
for each object in nobody's hands, a `transfers` entry wherever an object
changes hands, and `moved`, `state_changes`, or `wardrobe_change` wherever
something differs from the character's previous appearance.

Then it runs the audit:

```bash
node scripts/check-continuity.js --root production-ferry
```

```
check-continuity: /path/to/my-comic/production-ferry
Panel ledger audit of 1 issue(s): ISS_001

  ✓ the ledger is consistent: no findings

✓ 0 error(s), 0 warning(s)
This audit reads the written ledger. It does not review the drawn pages.
```

To see what a failure looks like, break the copy on purpose. On page 2,
panel 1, Mara has come down from the wheelhouse to the deck, and her row
says how:

```yaml
moved: Climbed down the ladder from the wheelhouse.
```

Change that line to `moved: null` in
`production-ferry/issues/ISS_001/pages/PG_001_002/page.yaml` and run the
audit again:

```
ISS_001
  PG_001_002
    ✗ PN_001_002_01 [POSITION_JUMP] CHAR_MARA was on level "wheelhouse" in PN_001_001_04 and is on "deck" in PN_001_002_01 (same scene SC_001_01); expected the row to set moved or the panel to set ellipsis, and both are empty.
        fix: Set moved on the row with how they got there, set ellipsis on the panel, or add a panel that shows the move.

✗ 1 error(s), 0 warning(s)
```

The exit code is 1. The finding names the panel, the entity, both
appearances, and the three ways out: say how she got there in `moved`,
declare the skip in the panel's `ellipsis`, or add a panel that shows the
descent. The example does the first and also draws the descent, because a
change of level left to the gutter is where a character ends up firing from
a platform they never reached.

Restore the line, then remove the `transfers` entry from page 1, panel 4,
where Mara takes the flare gun off its hook:

```
ISS_001
  PG_001_001
    ✗ PN_001_001_04 [CUSTODY_JUMP] PROP_FLARE_GUN was placed (in nobody's hands) in PN_001_001_03 and is held by CHAR_MARA in PN_001_001_04; expected a transfers entry ending with to: CHAR_MARA in PN_001_001_04 or a panel in between, and the ledger has none.
        fix: Add a transfers entry (handoff, pickup, drop, set_down, ...) in the panel where the prop changes hands, or correct the holder.
```

The fix is the entry you removed:

```yaml
transfers:
  - prop: PROP_FLARE_GUN
    from: null
    to: CHAR_MARA
    how: pickup
```

An error is fixed in the plan. It is never waived, and a caption is never
the fix for a handoff nobody drew. `--issue ISS_001` limits the audit to one
issue and `--json` prints the findings as an array. The codes are listed in
the [README](../README.md#the-panel-ledger).

Generation does not start while the audit reports an error. Keep in mind
what it proves: the written plan is coherent. It has not seen a page.

## 8. Plan the references and compile the prompts

```
/reference-plan
```

For each page this decides which approved images are attached to the
request, each with one role, inside the provider's image budget.

```bash
node scripts/build-reference-plan.js --page production-ferry/issues/ISS_001/pages/PG_001_002/page.yaml
```

```
reference plan: 3 required + 1 optional for PG_001_002 via harness-native (budget 4)
  + LOOK_NOIR_INK_MASTER_V01 [style/critical] Fixed drawing style, attached to every request.
  + CHAR_MARA_TURN_MASTER_V01 [identity/critical] Identity master of Mara, drawn in 4 panel(s).
  + CHAR_OSKAR_TURN_MASTER_V01 [identity/critical] Identity master of Oskar, drawn in 2 panel(s).
  ~ PG_001_001_V01 [spatial_continuity/high] Previous page PG_001_001, reviewed (pass), for environment and staging continuity.
  x LOC_FERRY_DECK_PLATE_MASTER_V01
  notes: PROP_FLARE_GUN is plot-relevant and on this page but has no registered reference: the prompt describes it in words only. [...] LOC_FERRY_DECK_PLATE_MASTER_V01 left out: spatial_continuity reference of medium priority does not fit, harness-native takes 4 image(s).
```

The script writes `reference-plan.yaml` next to the page. Lines marked `+`
are required, `~` optional, and `x` excluded. Read three things in it:

- The look master is there with the role `style`, and nobody's identity
  depends on it.
- Each character drawn on the page has an identity sheet.
- The previous page appears only because its render has a review with
  verdict `pass`. An unreviewed or flagged page is never attached.

The notes say what was left out and what the prompt therefore has to carry
in words. `--provider <id>` plans against another provider's budget. The
script exits 1 when a required reference is missing, unapproved, or does
not fit.

Then compile:

```bash
node scripts/compile-prompts.js --page production-ferry/issues/ISS_001/pages/PG_001_002/page.yaml
```

```
prompt package: PP_PG_001_002_HARNESS-NATIVE (generate, harness-native, model harness-native) -> /path/to/production-ferry/issues/ISS_001/pages/PG_001_002/prompts/harness-native.yaml
  prompt: 10923 characters, 4 reference image(s), aspect 2:3
  lettering strings in the image: 4
  request endpoint: (none: handoff to a person or the harness tool)
  warning: harness-native renders text unreliably: the review must check all 4 lettering string(s) against lettering_text
```

The package lands in `prompts/<provider>.yaml`. Open it and read the prompt
before anything is sent. It starts with the style block, word for word.
Then come the grid, the reference images by position and role, each panel's
moment and positions, the stated difference between Mara and Oskar, the
state each character carries, and the exact lettering strings. Nobody
writes a prompt by hand. If something in it is wrong, fix the bible or the
page file and compile again.

Other options: `--provider <id>`, `--model <id>` to pin a model, and
`--panel <PN_ID>` to compile one panel as its own image for pages set to
`generation.mode: per_panel`.

## 9. Generate the pages

```
/generate-pages
```

Pages are generated in reading order, one at a time. Page 2 is not
requested until page 1 has been opened and reviewed, because a reviewed page
becomes a spatial reference for the next and a defect that slips through is
copied forward.

Start with the dry run, which is what the script does unless told
otherwise:

```bash
node scripts/generate-assets.js --page production-ferry/issues/ISS_001/pages/PG_001_002/page.yaml
```

```
generate-assets: 1 package(s), mode: DRY RUN
estimated total cost: $0.000 (approximate list prices; check your provider), plus 1 package(s) with no estimate (handoff provider or pinned model)
(dry run: request specs and dry_run records only; add --live --yes to submit)
  DRY_RUN GEN_PG_001_002_03 [harness-native, model unreported] no estimate
    record:  /path/to/production-ferry/generations/PG_001_002/GEN_PG_001_002_03.yaml
    request: /path/to/production-ferry/generations/PG_001_002/GEN_PG_001_002_03.request.json
    target:  issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V03.png (render PG_001_002_V03)
```

A dry run calls no network. It writes a generation record with
`status: dry_run` and the request as it would be sent. The target is the
next free version. The example already has `V01` and `V02`, so this attempt
would be `V03`. `--issue <issue dir>` does the same for every page of an
issue that is not yet reviewed, which gives you the estimate for a batch.
Use it for dry runs. Live requests go page by page.

What happens next depends on the provider.

With `harness-native` or `manual` there is no API to call. The
`.request.json` file is the handoff: the prompt, the input images in order
with the single role of each, and the target file. The assistant's image
tool, or you in any image UI, produces the image from it. Save the result at
the target path, never over an existing file, then complete the record:
`status`, `media_files`, `response.summary`, and whatever the tool reported.
What it did not report stays `unreported` or `null` and is listed under
`metadata_unavailable`.

With an API provider, a live run needs three things: the provider's
variable in the environment (`npm run doctor` shows which are set), the
`--live` flag, and `--yes` to confirm the printed estimate.

```bash
node scripts/generate-assets.js --page <page.yaml> --provider gemini --live --yes
```

Without `--yes` the script prints the estimate and stops:

```
error: --live spends provider credits: re-run with --yes to confirm the estimate above
```

In Claude Code the `require-cost-confirmation` hook blocks the same command
before it runs. A live run also refuses a package whose page or style block
changed after it was compiled, and a request whose input image is missing
from disk. When the provider returns an image, the script saves it at the
target path and fills in the record.

With `codex-cli` there is no variable to set. Compile the page for it and
run it live:

```bash
node scripts/compile-prompts.js --page <page.yaml> --provider codex-cli
node scripts/generate-assets.js --page <page.yaml> --provider codex-cli --live --yes
```

The script starts `codex exec` with the reference images attached in order,
waits for Codex to draw, and saves the result as the next render. One page
can take several minutes. The limit is 15 minutes unless
`CODEX_IMAGE_TIMEOUT_MS` says otherwise, and `CODEX_BIN` points at the
executable when it is not on `PATH`. The record says `model: unreported`
unless Codex names its image model, and the cost stays `null`. If the binary
is missing, the run times out, or Codex saves nothing, the record is
`failed` and says why. Codex's image tool draws 1:1, 2:3 and 3:2; a page in
another ratio comes back in the nearest of those and has to be cropped.

When a file comes back, open it. A successful call means an image exists.
Check that it is the right page with the planned number of panels, then set
the page's `status` to `rendered`. The image is a candidate until it has
been reviewed.

## 10. Review, and repair what fails

```
/visual-review
```

The reviewer opens the render beside the page plan, the reference sheets,
and the neighboring pages, and writes
`reviews/<RENDER_ID>.review.yaml`. The file has fourteen checks, each with a
result and evidence that describes what is drawn, a finding for every
difference, two gates, and a verdict. The reviewer should not be the agent
that generated the image. The review records that in `independent`.

The example's first render of page 2 was flagged. Its one finding:

```yaml
findings:
  - id: F01
    panel: PN_001_002_03
    check: identity
    expected: Oskar has a round face, wide-set eyes, a small build, and a hooded jacket with the hood up.
    visible: The boy in panel 3 has Mara's long face and cropped grey hair and no hood. Panel 4 repeats it.
    severity: blocking
    repair: Regenerate panels 3 and 4 as a sibling version with Oskar's sheet attached and his difference from Mara stated. Lock the lettering, the borders, and Mara.
    status: open
```

The balloon in that panel was correct and pointed at the right figure. That
does not make the drawing coherent: the `identity` check compares the face
with the character sheet.

The verdict is one of three. `pass` means no findings. `flagged` means a
blocking finding is open, a gate fails, or the evidence is ambiguous.
`fixed` is only for a repaired render whose findings have each been
rechecked on the new file. On `pass` or `fixed` the page moves to
`status: reviewed` and `current_render` points at that render. Approval is
your decision, recorded separately under `human_approval`.

After any review, run the workspace gate. It checks that the review file is
consistent, and its output keeps the two kinds of result apart:

```bash
node scripts/validate-workspace.js --root production-ferry --issue ISS_001
```

```
## Mechanical validation
  Schemas, cross-references, review and edition rules, generation records, lettering text, panel ledger.
  ✓ 0 error(s), 0 warning(s)

## Visual review
  Not performed by this script. Verdicts recorded in the review files for each page's current render:
  - 2 page(s): 1 pass, 1 fixed, 0 flagged, 0 rendered without a review, 0 with no render yet
```

For a flagged page:

```
/repair-page
```

A repair starts by asking where the cause is. The example's `F01` came from
upstream: Oskar's sheet had not been attached, and neither character listed
the other under `visually_adjacent_to`. Both were corrected first. Sending
the same ambiguous description again repeats the failure.

Then the repair is compiled from the review:

```bash
node scripts/compile-prompts.js --page production-ferry/issues/ISS_001/pages/PG_001_002/page.yaml \
  --repair production-ferry/issues/ISS_001/pages/PG_001_002/reviews/PG_001_002_V01.review.yaml
```

```
prompt package: PP_PG_001_002_HARNESS-NATIVE (repair, harness-native, model harness-native) -> /path/to/production-ferry/issues/ISS_001/pages/PG_001_002/prompts/harness-native.yaml
  prompt: 5230 characters, 3 reference image(s) + edit target, aspect 2:3
  repair of PG_001_002_V01: findings F01
  warning: PG_001_001_V01 (spatial_continuity) not attached: harness-native takes 4 image(s), one of them the edit target
```

The package has `mode: repair`. It names the edit target, the failing
panels, the exact changes, and everything that is locked: the other panels,
all lettering, the borders, and the characters who were right. Generate it
like any page. The result is a sibling version, `PG_001_002_V02`, and `V01`
stays on disk with its review.

Reopen the new file and verify each requested change in it. Then recheck
the whole page and its neighbors, because a local edit moves things nobody
asked it to move. The new review sets `supersedes`, raises `repair_cycle`
by one, and marks each repaired finding `fixed` with a `recheck` that names
the new render and what is visible there.

A repair also carries changes a person asked for. Such a request is a
finding with `source: user_request` in the render's review, optionally with
a `region` that marks the area in fractions of the page. It is recorded by
`addUserRequest()` in `scripts/lib/review-requests.js`, which a front end
calls; the review becomes `flagged` and `compile-prompts.js --repair` picks
the request up with the reviewer's findings. The shape is in
[data-model.md](data-model.md).

Repairs are counted. When `repair_cycle` reaches
`repair_policy.max_cycles`, `compile-prompts.js --repair` refuses and
`validate-workspace.js` rejects a review above the limit. At that point the
page goes back to its plan or its references. Your own touch-ups count too,
and they follow `repair_policy.touch_up_warning`: past it you are told that
more edits may degrade the image and offered a redraw, and you choose. The
web studio carries that choice through; a touch-up past `max_cycles` is
valid because the render it edited holds your request. The policy is
[rules/common/repair-limits.md](../rules/common/repair-limits.md).

## 11. Letter the pages

```
/lettering
```

The words are already in `page.yaml`. This command plans where each
balloon, caption, and sound effect sits, and checks the result string by
string. What it does next depends on `lettering.mode`.

In `in_image` mode the image model draws the lettering. The placement goes
into the panel notes so the prompt can state it, and the compiled package
lists every string under `lettering_text`. After generation the review's
`lettering` check compares each drawn string with `page.yaml`, accents
included, and checks every tail. A wrong letter is a finding, and the fix
is `/repair-page` with the art locked. The Night Ferry works this way, so
it has no `lettering.yaml`.

In `overlay` mode the art is generated with no text. The command writes
`lettering.yaml` beside the page file: the canvas size, the font, and one
element per lettering ID with its box, shape, and tail. Then:

```bash
node scripts/letter-pages.js --page <page.yaml> --render <RENDER_ID>
```

This writes `renders/<RENDER_ID>.lettered.svg` and leaves the render
untouched. Without `--render` it uses the render named in `lettering.yaml`,
then the page's `current_render`. `--embed` inlines the image as base64
instead of linking it. The run fails when an element's text differs from
`page.yaml`, when a lettering ID has no element, or when an element has an
ID the page does not know. On a page without the geometry file it says so:

```
error: issues/ISS_001/pages/PG_001_002/lettering.yaml not found; overlay lettering needs the geometry file next to page.yaml
```

Two limits apply to overlay mode. Line breaks and fit warnings come from a
character-width model and not from the real font, so check the SVG by eye.
And the scripts do not rasterize: to put a lettered page in an edition,
open the SVG in a browser or a vector tool and export it at the canvas size
as PNG or JPEG. Then file the export:

```bash
node scripts/letter-pages.js --register-lettered <image> --render <RENDER_ID> --page <page.yaml>
```

It is stored as `renders/<RENDER_ID>.lettered.png` and set as
`lettered_file` on that render's entry in every draft edition. A reviewed
or published edition is left as it is.

A lettering fix in overlay mode costs nothing: edit `lettering.yaml` and
run the script again. To change a word, change `page.yaml` first.

## 12. Close the issue and build the edition

```
/continuity-review
```

This audits the issue as a whole. It runs the ledger audit again, compares
each page with the next at the boundary on the reviewed renders, looks for
slow drift between the first and last appearance of each character and
prop, and writes `production/continuity/<ISS_ID>.final-state.yaml`: where
everyone is, what they wear and hold, and which threads are open. The next
issue opens from that file. A visual defect found here becomes a finding in
the review of the page that shows it, and a blocking one sends the page
back to `/repair-page`.

```
/cover
```

This step is optional. It plans the issue's cover in
`production/issues/<ISS_ID>/cover/cover.yaml`: one image with no panels,
the characters and props on it, and the exact title and issue text. The
cover then goes through the page loop with its own flags:

```bash
node scripts/compile-prompts.js --cover ISS_001 --root production-ferry
node scripts/generate-assets.js --cover ISS_001 --root production-ferry
```

The package attaches the look master and the master of each character on
the cover. Renders are `cover/renders/CV_001_V##.png`, and the review of
each sits in `cover/reviews/`. A cover has no ledger, so its review records
`position`, `movement`, and `role_causality` as `not_applicable`. When a
render has passed and you approve it, `cover.yaml` gets `status: approved`
and `approved_render`.

```
/build-edition
```

This writes `production/editions/<ED_ID>/edition.yaml`, which lists the
exact render of every page, taken from each page's `current_render`, and
the approved cover under `cover:` when the issue has one. Then it builds:

```bash
node scripts/build-edition.js --edition production-ferry/editions/ED_001_01/edition.yaml
```

```
wrote editions/ED_001_01/exports/the-night-ferry-001-ed01.pdf
wrote editions/ED_001_01/exports/the-night-ferry-001-ed01.cbz
build-edition: ED_001_01, pdf, cbz built. Renders shipped and their review verdicts: PG_001_001_V01 (pass), PG_001_002_V02 (fixed)
```

Without `--formats` the script builds the `pdf`, `cbz`, `web`, `images`,
and `epub` targets listed under `deliverables` in `project.yaml`, or
`pdf,cbz` when there are none. The web reader is a directory with an
`index.html`. `images` is a folder of numbered page images with a zip of
the same files beside it. `epub` is an EPUB 3 with a fixed layout, one
image per page. With a cover in the edition, the cover is the first page of
every format and its file is `000-cover`. After a build the `exports` list
in `edition.yaml` records each file.

Run it a second time and nothing is replaced:

```
skipped editions/ED_001_01/exports/the-night-ferry-001-ed01.cbz: it already exists and exports are never overwritten (pass --force, or create a new edition)
```

`--force` replaces an export only while the edition has status `draft`.
Once an export has gone to anyone, a correction is a new edition ID with
`supersedes` and `changes` filled in.

An edition that lists a render without a passing review does not build:

```
error: 1 render cannot enter a non-draft edition (a review with verdict pass or fixed is required):
    PG_001_002  PG_001_002_V01  flagged
    Review or repair these pages, list a render that passed, or build a marked draft with --draft.
```

`--draft` builds it anyway and marks the result: `-DRAFT` in every file
name, a stamp on every PDF page, a banner in the web reader.

Open every export before calling the edition done. Count the pages and
read them in order. The `social-carousel` and `print` deliverables are
prepared by hand from the edition: the scripts do not crop, resize, or
composite images.

At any point, a one-page board shows the state of an issue: each page with
its plan, status, a thumbnail of the current render, the recorded verdict,
and the ledger check.

```bash
node scripts/build-board.js --issue production-ferry/issues/ISS_001
```

It writes `board.html` in the issue directory, or the file given with
`--out`. Images are linked with relative paths, so keep the board inside
the workspace. The board shows what the files say. It does not look at the
artwork.

## 13. Or run the whole thing

```
/full-production
```

This runs the same commands in the same order, in seven phases: source and
canon, series, bibles and references, plan, pages, lettering and continuity,
edition. Each phase ends at a gate you approve, and each generation batch
shows its estimate and waits. It resumes from the `status` fields on disk,
so an interrupted run does not pay again for finished work. `--dry-run`
walks the phases with every generation step as a dry run.

For a first project, run the commands by hand once. You learn what each
file looks like, and the gates in `/full-production` mean more afterwards.

## Customizing the scaffold

### Looks

`templates/looks/` holds starter looks, among them a noir ink and a manga
screentone preset. Each one is a YAML file with the
drawing described in checkable terms and a `style_block` ready to freeze.
Copy the block into `production/style/style-block.txt`, edit it if you
need to, and run `/style-bible` with that preset. A preset is a draft. The
approved look of a production is the frozen block plus the approved look
master image, and both live in the workspace. Details are in
[templates/looks/README.md](../templates/looks/README.md).

### Rules in an installed project

`install.js` copies `rules/` into the target project. Those copies are
yours: tighten a word budget or add a project rule there. Many numbers in the rules are defaults that
`project.yaml` overrides, so check for a field before editing a rule. Both
format layers are installed, and `comic_format` picks one per task.

When you work in a clone of the scaffold instead, `rules/` is a source of
truth for the generated wrappers. After editing a rule, run
`npm run sync:harnesses` and `npm run validate`.

### Providers

A provider is one file in `providers/image/` that exports an ID, its
required environment variables, its capabilities, a pure `compile()`, and a
`generate()` that defaults to dry-run. To add one, start from `gemini.js`
for an API or `manual.js` for a handoff, add the matching entry to
`manifests/image-providers.json`, and add the ID to the roster in
`docs/conventions.md`. Keep the capabilities honest: the reference planner
and the compiler treat them as hard limits. The steps are in
[providers/README.md](../providers/README.md).

To pin a different model on an existing provider for one package, pass
`--model <id>` to `compile-prompts.js`.

### Profiles

A profile is a named subset of commands, agents, and skills in
`manifests/profiles.json`. `install.js --profile <name>` filters the harness
wrappers by it. The rules, schemas, scripts, and providers are always
installed in full.

| Profile | What it carries |
|---|---|
| `full` | Everything, from source analysis to edition export. |
| `writing-room` | Story development only: source analysis, story bible, series plan. |
| `layout` | Story through bibles, page plans, panel scripts, thumbnails, and the ledger. No generation. |
| `generation` | Master references and reference plans through page generation, review, and repair. |
| `publishing` | Lettering, continuity review, and edition assembly and export. |

To make your own, add an entry to `manifests/profiles.json` listing roster
names, then run `npm run validate`.

### The scaffold itself

Adding or renaming an agent, a command, a skill, a rule, or a provider
touches the file, its manifest, and `docs/conventions.md` together. See
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Troubleshooting

| Symptom | What to do |
|---|---|
| Slash commands are missing in the assistant | Run `install.js` again with the right `--harness`, then restart the assistant. |
| `check-continuity.js` reports `POSITION_JUMP` or `CUSTODY_JUMP` | The plan skips a move or a handoff. Set `moved`, declare an `ellipsis`, add a `transfers` entry, or add the panel that shows it. |
| `build-reference-plan.js` exits 1 | A required master is missing or not approved, or the critical references exceed the provider's budget. Approve the master through `/visual-development`, or see the budget options in [rules/image/reference-roles.md](../rules/image/reference-roles.md). |
| `compile-prompts.js` rejects the package | The provider cannot honor it: an unsupported aspect ratio, too many references, a repair on a provider that cannot edit, or lettering on a provider with no text rendering. The message lists every limit violated. |
| A live run stops asking for `--yes` | Read the estimate and run again with `--live --yes`. |
| A provider refuses a live run | Its environment variable is missing. `node scripts/doctor.js` shows which are set. |
| A live run says the package is stale | The page, its reference plan, or the style block changed after compiling. Run `compile-prompts.js` again. |
| `compile-prompts.js --repair` refuses | The page reached `repair_policy.max_cycles`. Fix the plan or the references and start the page again as a first render. |
| `build-edition.js` refuses a render | Its review is missing or `flagged`. Review or repair the page, or build a marked draft with `--draft`. |
| A written file fails schema validation | In Claude Code the write hook blocks it and names the fields. Fix them. Elsewhere, `validate-workspace.js` reports the same errors. |
| Wrapper drift in `npm run validate` | A generated directory was edited by hand. Edit the source and run `npm run sync:harnesses`. |
