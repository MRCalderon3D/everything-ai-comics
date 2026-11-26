# Data Model

The shape of every structured artifact in a `production/` workspace. Schemas in
`schemas/` encode these shapes, scripts read and write them, and the example
workspace in `examples/the-night-ferry/` instantiates all of them. Field names
and enum values here are binding. Fields marked `# required` are required by
the schema; everything else is optional. Schemas set
`additionalProperties: false` on objects whose keys are listed here and allow a
free `notes` string on every top-level document.

Shared patterns:

| Thing | Pattern |
|---|---|
| Issue | `^ISS_\d{3}$` |
| Scene | `^SC_\d{3}_\d{2}$` |
| Beat | `^BT_\d{3}_\d{2}_\d{2}$` |
| Page | `^PG_\d{3}_\d{3}$` |
| Panel | `^PN_\d{3}_\d{3}_\d{2}$` |
| Render | `^PG_\d{3}_\d{3}_V\d{2}$` |
| Lettering element | `^L\d{2}$` |
| Finding | `^F\d{2}$` |
| Edition | `^ED_\d{3}_\d{2}$` |
| Entity | `^(CHAR\|LOC\|PROP\|LOOK)_[A-Z][A-Z0-9_]*$` |
| Asset (versioned) | `^(CHAR\|LOC\|PROP\|LOOK)_[A-Z][A-Z0-9_]*_V\d{2}$` |
| Wardrobe state | `^WARD_[A-Z][A-Z0-9_]*$` |
| Provider id | `^[a-z][a-z0-9-]*$` |
| State tag | `^[a-z][a-z0-9_]*$` |

The entity ID of an asset is the asset ID's leading entity: `CHAR_MARA` for
`CHAR_MARA_TURN_MASTER_V01`. The registry in `references/manifest.yaml` states
it explicitly per asset.

## project.yaml (`project`)

```yaml
title: The Night Ferry                 # required
comic_format: paged                    # required. paged | webtoon
publication: one-shot                  # required. strip | one-shot | miniseries | ongoing | graphic-novel | webtoon-series
logline: A ferry pilot finds a stowaway the harbour patrol is hunting.
genre: noir
language: en                           # required. language of the lettering
reading_direction: ltr                 # required. ltr | rtl
page:                                  # required
  aspect_ratio: "2:3"                  # required. ^\d+:\d+$
  width_px: 2000                       # required
  height_px: 3000                      # required
  trim_mm: { width: 168, height: 260 }
  bleed_mm: 3
  safe_margin_mm: 6
color_mode: monochrome                 # required. monochrome | limited | full_color
spot_colors:
  - name: signal red
    hex: "#C0392B"                     # ^#[0-9A-Fa-f]{6}$
    use: Flare light only.
lettering:                             # required
  mode: in_image                       # required. in_image | overlay
  font_family: Comic Neue
  case: upper                          # upper | sentence
  max_words_per_balloon: 25
  max_words_per_panel: 50
style:
  look_refs: [LOOK_NOIR_INK_MASTER_V01]
  style_block: style/style-block.txt   # path relative to the workspace root
  influences: [high-contrast ink noir]
  notes: Heavy blacks, no gradients.
default_providers:                     # required
  image: harness-native                # required. one of the image provider roster
deliverables:
  - target: pdf                        # required. pdf | cbz | web | social-carousel | print
    notes: Reading copy.
content:
  rating: mature                       # all-ages | teen | mature
  violence_treatment: Implied, never anatomical.
repair_policy:
  max_cycles: 2                        # integer >= 0, default 2
created_at: "2026-11-26"
version: "0.1.0"
```

## story/story-bible.yaml (`story-bible`)

```yaml
title: The Night Ferry                 # required
premise: One paragraph.                # required
tone: Dry, tense, quiet.
world_rules:
  - The ferry runs without lights after curfew.
facts:                                 # required. the canon registry
  - id: FACT_001                       # required. ^FACT_\d{3}$
    statement: Mara pilots the last night ferry alone.   # required
    provenance: source                 # required. source | user_change | addition
    source_ref: story/source/night-ferry.txt#p2
    replaces: null                     # FACT id superseded by a user_change, or null
    affects: [CHAR_MARA]               # entities to update when this fact changes
characters:                            # required
  - id: CHAR_MARA                      # required
    role: protagonist                  # protagonist | antagonist | supporting | background
    arc: From avoiding trouble to choosing it.
timeline:
  - order: 1                           # required
    event: Mara leaves the east dock.  # required
    issue: ISS_001
open_questions:
  - question: Does the patrol know the boy's name?       # required
    blocking: false                    # required. true = resolve before generation
    resolution: null
```

## story/series-plan.yaml (`series-plan`)

```yaml
title: The Night Ferry                 # required
issues:                                # required
  - id: ISS_001                        # required
    number: 1                          # required
    title: Crossing                    # required
    source_span: story/source/night-ferry.txt#p1-p9
    summary: Mara finds Oskar and decides not to hand him over.
    page_budget: 2                     # required. integer >= 1
    status: planning                   # required. planning | scripting | production | review | published
```

## characters/<CHAR_ID>/character.yaml (`character`)

```yaml
id: CHAR_MARA                          # required
name: Mara                             # required
aliases: []
role: protagonist                      # protagonist | antagonist | supporting | background
description:                           # required
  summary: Ferry pilot in her fifties, weathered, economical in movement.   # required
  age: fifties
  build: wiry, slightly stooped
  hair: grey, cropped
  face: long face, deep-set eyes, broken nose
  skin: weathered
  distinguishing_features:             # required, at least one. what separates this character from any other in the cast
    - broken nose
    - grey cropped hair
    - oilskin coat with a torn left cuff
prompt_summary: Wiry woman in her fifties with cropped grey hair, a broken nose and an oilskin coat torn at the left cuff.
visually_adjacent_to: [CHAR_OSKAR]     # characters this one could be confused with; prompts must state the difference
personality: Says little, notices everything.
voice: Short sentences. No questions unless she needs the answer.
arc: From avoiding trouble to choosing it.
first_appearance: PG_001_001
default_wardrobe: WARD_MARA_OILSKIN
wardrobe_file: wardrobe.yaml
references:                            # required. asset IDs registered in references/manifest.yaml
  - CHAR_MARA_TURN_MASTER_V01
status: approved                       # draft | review | approved
```

## characters/<CHAR_ID>/wardrobe.yaml (`wardrobe`)

```yaml
character: CHAR_MARA                   # required
outfits:                               # required
  - id: WARD_MARA_OILSKIN              # required
    description: Black oilskin coat torn at the left cuff, wool cap, rubber boots.   # required
    layers: [oilskin coat, wool jumper, wool cap, rubber boots]
    accessories: []
    hands: bare                        # bare | gloved | bandaged
    references: [CHAR_MARA_TURN_MASTER_V01]
    used_in: [ISS_001]
```

## locations/<LOC_ID>/location.yaml (`location`)

```yaml
id: LOC_FERRY_DECK                     # required
name: Ferry deck                       # required
description:                           # required
  summary: Open steel car deck of a small river ferry, wheelhouse raised aft.   # required
  architecture: Flat deck, low bulwarks, a steel ladder up to the wheelhouse.
  dressing: Coiled mooring lines, two lashed crates, a fire bucket.
  light: One shielded lamp on the wheelhouse; otherwise moonlight.
prompt_summary: Open steel deck of a small river ferry at night with a raised wheelhouse aft and two lashed crates.
time_of_day_states: [night]
map_file: map.yaml
references: [LOC_FERRY_DECK_PLATE_MASTER_V01]   # required
status: approved
```

## locations/<LOC_ID>/map.yaml (`location-map`)

```yaml
location: LOC_FERRY_DECK               # required
levels:                                # required. named vertical levels, bottom to top
  - id: deck                           # required. state-tag pattern
    description: Car deck, at water level.
  - id: wheelhouse
    description: Raised cabin, reached by the ladder.
sides:                                 # the fixed side convention for this location
  convention: Bow is screen left, stern is screen right when facing port.
  left: bow
  right: stern
landmarks:                             # required
  - id: crates                         # required. state-tag pattern
    level: deck                        # required. one of levels[].id
    side: left                         # left | right | center
    description: Two lashed crates near the bow.
  - id: ladder
    level: deck
    side: right
    description: Steel ladder to the wheelhouse.
exits:
  - id: gangway
    level: deck
    side: left
    leads_to: null                     # LOC id or null
connections:                           # how characters get between levels
  - from: deck
    to: wheelhouse
    via: ladder
```

## props/<PROP_ID>/prop.yaml (`prop`)

```yaml
id: PROP_FLARE_GUN                     # required
name: Flare gun                        # required
description:                           # required
  summary: Orange single-shot flare pistol with a wide barrel.   # required
  distinguishing_features: [wide stubby barrel, lanyard ring]
prompt_summary: Orange single-shot flare pistol with a wide stubby barrel.
hands_required: 1                      # 1 | 2
plot_relevant: true
references: []                         # required (may be empty)
status: draft
```

## references/manifest.yaml

Not schema-validated as a whole; scripts read these fields:

```yaml
assets:
  - id: CHAR_MARA_TURN_MASTER_V01      # required
    entity: CHAR_MARA                  # required
    kind: turnaround                   # turnaround | expressions | wardrobe | plate | look | prop | detail
    path: characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png   # required. relative to workspace root
    status: approved                   # required. draft | review | approved | superseded
    default_role: identity             # the role this asset plays when attached
    sha256: null
    approved_by: null
    approved_at: null
    notes: ""
```

## issues/<ISS_ID>/issue.yaml (`issue`)

```yaml
id: ISS_001                            # required
number: 1                              # required
title: Crossing                        # required
source_span: story/source/night-ferry.txt#p1-p9
summary: Mara finds Oskar and decides not to hand him over.   # required
scenes: [SC_001_01]                    # required
page_count: 2                          # required
panel_count: 8
opens_from: null                       # continuity state file of the previous issue, or null
status: production                     # required. planning | scripting | production | review | published
```

## issues/<ISS_ID>/scenes/<SC_ID>.yaml (`scene`)

```yaml
id: SC_001_01                          # required
issue: ISS_001                         # required
location: LOC_FERRY_DECK               # required
time_of_day: night                     # dawn | day | dusk | night
cast: [CHAR_MARA, CHAR_OSKAR]          # required
summary: Mara hears the crates shift and finds the boy.   # required
geography:
  travel_direction: right_to_left      # left_to_right | right_to_left | toward_reader | away_from_reader | none
  threat_direction: right_to_left
  notes: The patrol launch always approaches from the stern (screen right).
beats:                                 # required
  - id: BT_001_01_01                   # required
    summary: Mara notices the sound.   # required
    pages: [PG_001_001]                # required
pages: [PG_001_001, PG_001_002]        # required
```

## issues/<ISS_ID>/pages/<PG_ID>/page.yaml (`page`)

The page file carries the layout, the panel script, the panel ledger, and the
lettering text. One file, so plan, script, and ledger cannot drift apart.

```yaml
id: PG_001_001                         # required
issue: ISS_001                         # required
number: 1                              # required. page number within the issue
scene: SC_001_01                       # required
side: right                            # paged only. left | right | single
spread_with: null                      # page ID of the facing page in a double-page spread, or null
purpose: Establish the ferry, Mara alone, and the sound that breaks the routine.   # required
page_turn: reveal                      # none | continuation | reveal | cliffhanger
layout:                                # required
  grid: three tiers, 1 / 2 / 1         # required. human-readable grid
  tiers: [1, 2, 1]                     # required. panels per tier, top to bottom. sum = number of panels
  reading_order: [1, 2, 3, 4]          # required. permutation of panel order values
  notes: ""
panels:                                # required, at least one
  - id: PN_001_001_01                  # required
    order: 1                           # required. reading position, 1-based
    tier: 1                            # 1-based tier index
    size: wide                         # required. splash | wide | large | medium | small | inset
    framing:                           # required
      shot_size: extreme_wide          # required. extreme_wide | wide | full | medium_wide | medium | medium_close_up | close_up | extreme_close_up | insert | over_the_shoulder
      angle: high_angle                # eye_level | high_angle | low_angle | overhead | worms_eye | dutch
      view: three_quarter              # front | three_quarter | profile | three_quarter_back | back
      composition: Ferry small in a wide black river.
    moment: The ferry crosses dark water with one shielded lamp lit.   # required. one drawable main moment
    location: LOC_FERRY_DECK           # required
    transition_in: null                # null for the first panel of a scene; else moment | action | subject | scene | aspect | non_sequitur
    ellipsis: null                     # what the gutter intentionally skips before this panel, or null
    background: River, far bank without lights.
    cast:                              # ledger rows for characters. may be empty
      - character: CHAR_MARA           # required
        off_panel: false               # true = not drawn here, but the row keeps their state
        position:                      # required
          level: wheelhouse            # required. a level of the location map
          side: right                  # left | right | center
          landmark: null               # a landmark of the location map, or null
        facing: left                   # left | right | toward_reader | away_from_reader
        action: Steers with one hand.  # required. the visible action
        acting: Shoulders loose, eyes ahead.
        wardrobe: WARD_MARA_OILSKIN    # required
        state: []                      # required. persistent physical state tags: injuries, blood, soaked, bound
        state_changes:                 # declare every tag gained or lost in this panel
          adds: []
          resolves: []
        holding: []                    # PROP ids in hand
        carrying: null                 # CHAR id carried or supported, or null
        moved: null                    # how they reached this position since their previous appearance, or null
        wardrobe_change: null          # why the wardrobe differs from the previous appearance, or null
    props:                             # ledger rows for props NOT in anyone's hands
      - prop: PROP_FLARE_GUN           # required
        position: { level: wheelhouse, side: right, landmark: null }   # required
        state: []
        visible: false                 # drawn in this panel?
    transfers: []                      # custody changes that happen in this panel
    # - prop: PROP_FLARE_GUN           # required
    #   from: null                     # CHAR id, or null when picked up from a surface
    #   to: CHAR_MARA                  # CHAR id, or null when dropped or set down
    #   how: pickup                    # required. handoff | pickup | drop | set_down | draw | holster | throw | take
    lettering:                         # exact text, in reading order
      - id: L01                        # required
        type: caption                  # required. caption | narration | balloon | thought | whisper | shout | radio | sfx | sign
        speaker: null                  # CHAR id for spoken types, else null
        text: Last crossing of the night.   # required. exact words, exact accents
        order: 1                       # required. reading order within the page
    notes: ""
references:                            # asset IDs this page needs (input to the reference plan)
  required: [LOOK_NOIR_INK_MASTER_V01, CHAR_MARA_TURN_MASTER_V01]
  optional: [LOC_FERRY_DECK_PLATE_MASTER_V01]
continuity:                            # required
  enters_from: null                    # previous page ID, or null for the first page of the issue
  exits_to: PG_001_002                 # next page ID, or null for the last page
  attach_previous_render: true         # attach the previous reviewed page as a spatial reference
generation:
  provider: harness-native
  mode: full_page                      # full_page | per_panel
status: reviewed                       # required. planned | scripted | prompted | rendered | reviewed | approved
current_render: PG_001_001_V01         # render ID, or null
```

Ledger rules (`check-continuity.js` enforces them mechanically):

1. A character appears at most once in a panel's `cast`.
2. A prop is held by at most one character per panel, and a held prop is not
   also listed under `props`.
3. When a prop's holder (or held/placed status) differs from its previous
   appearance, a `transfers` entry in the later panel, or in any panel in
   between, accounts for it.
4. When a character's `position.level` differs from their previous appearance
   in the same scene, the later row sets `moved` or the panel sets `ellipsis`.
5. A state tag present in a character's previous appearance is still present,
   or is listed in `state_changes.resolves`.
6. A wardrobe change inside a scene sets `wardrobe_change`.
7. Hands: `carrying` uses two hands; each held prop uses its `hands_required`
   (default 1). More than two is an error.
8. A spoken lettering element's `speaker` is in the panel's `cast`.
9. `layout.reading_order` is a permutation of the panels' `order` values,
   `layout.tiers` sums to the panel count, and lettering `order` values are
   unique within the page.
10. `continuity.enters_from` / `exits_to` form one unbroken chain per issue.
11. Every `character`, `prop`, `location`, wardrobe, level, and landmark
    referenced exists in the workspace.

## issues/<ISS_ID>/pages/<PG_ID>/lettering.yaml (`lettering`)

Only in `overlay` lettering mode. Geometry for `letter-pages.js`; the text
itself always comes from `page.yaml` and must match it.

```yaml
page: PG_001_001                       # required
render: PG_001_001_V01                 # required. the render this overlay sits on
canvas: { width_px: 2000, height_px: 3000 }   # required
font:
  family: Comic Neue
  size_px: 34
  line_height: 1.15
elements:                              # required
  - id: L01                            # required. matches a lettering id in page.yaml
    panel: PN_001_001_01               # required
    type: caption                      # required. same enum as page.yaml
    text: Last crossing of the night.  # required. must equal page.yaml
    box: { x: 120, y: 110, width: 520, height: 90 }   # required. px on the canvas
    shape: rect                        # rect | ellipse | burst | cloud | none
    tail: null                         # { x, y } tip of the balloon tail, or null
    style: { fill: "#FFFFFF", stroke: "#000000", text: "#000000" }
```

## issues/<ISS_ID>/pages/<PG_ID>/reference-plan.yaml (`reference-plan`)

```yaml
page: PG_001_001                       # required
provider: harness-native               # required
budget: 4                              # the provider's reference image limit at planning time
required:                              # required
  - asset_id: LOOK_NOIR_INK_MASTER_V01 # required. asset ID, or a render ID for a previous page
    entity: LOOK_NOIR_INK              # entity ID; null for a render
    role: style                        # required. style | identity | wardrobe | spatial_continuity | prop_consistency | composition | edit_target
    priority: critical                 # required. critical | high | medium | low
    reason: Fixed drawing style for every request.   # required
    omission_risk: Style drifts toward the model's default.
optional: []
exclude: []                            # asset IDs deliberately left out, with the reason in notes
created_at: "2026-11-26"
```

One role per entry, and an asset appears once. A `style` entry is never also
`identity`.

## issues/<ISS_ID>/pages/<PG_ID>/prompts/<provider>.yaml (`prompt-package`)

```yaml
id: PP_PG_001_001_HARNESS-NATIVE       # required. PP_<page or entity id>_<PROVIDER>[-P## | -<TAG>]
page: PG_001_001                       # required. page ID, or null for an asset-scoped package
asset: null                            # entity ID for asset-scoped packages
provider: harness-native               # required
model: harness-native                  # required. pinned by provider.compile()
mode: generate                         # required. generate | repair
prompt: "..."                          # required
negative_prompt: ""
parameters:                            # required
  aspect_ratio: "2:3"
  resolution: 2000x3000
  seed: null                           # integer or null
references:                            # in attachment order
  - asset_id: LOOK_NOIR_INK_MASTER_V01 # required
    role: style                        # required. same enum as the reference plan
    image_path: references/style/LOOK_NOIR_INK_MASTER_V01.png   # required
edit_target: null                      # image path of the render being repaired (mode: repair), else null
repair:                                # mode: repair only
  of_render: PG_001_001_V01
  findings: [F01]
  changes: [Give Oskar a round face and a hooded jacket in panel 3.]
  locked: [All lettering, panel borders, Mara in every panel.]
lettering_text:                        # the exact strings the image must contain (in_image mode), for review
  - Last crossing of the night.
status: compiled                       # required. draft | compiled | submitted
source_hashes:                         # required
  page: 0f3a9c1b2d4e5f60               # ^[a-f0-9]{8,64}$
  reference_plan: 7b1c2d3e4f5a6b70
  style_block: 9a8b7c6d5e4f3a20
```

Two variants use the same schema:

- Per-panel packages (`generation.mode: per_panel`, compiled with `--panel`)
  are written to `prompts/<provider>.<PN_ID>.yaml` with the id
  `PP_<PAGE_ID>_<PROVIDER>-P##`.
- Asset-scoped packages (`page: null`, `asset: <ENTITY_ID>`, compiled with
  `--asset <ENTITY_ID> --sheet <kind>`) are written to
  `<entity dir>/refs/prompts/<provider>.<kind>.yaml`, and for LOOK entities to
  `references/style/prompts/<provider>.<LOOK_ID>.yaml`. Their id is
  `PP_<ENTITY_ID>_<PROVIDER>-<TAG>` with TAG one of `TURN`, `EXPR`, `WARD`,
  `PLATE`, `PROP`, `LOOK`, `DETAIL`. Generation writes the next free candidate
  `<ENTITY_ID>_<TAG>_V##` in the entity's `refs/` directory (look pages in
  `references/style/`). A candidate never carries `_MASTER`: promoting it to
  a master is an approval step that registers the file in
  `references/manifest.yaml`.

## generations/<scope>/GEN_*.yaml (`generation-record`)

```yaml
id: GEN_PG_001_001_01                  # required. GEN_<page or entity id>_<attempt##>
page: PG_001_001                       # required. page ID or null
asset: null                            # entity ID for asset-scoped records
provider: harness-native               # required
model: unreported                      # required. the reported model, or "unreported"
kind: image                            # required. image
prompt_package: PP_PG_001_001_HARNESS-NATIVE   # required
output_render: PG_001_001_V01          # render ID produced, or null
request:
  summary: Handoff to the harness image tool.   # required
  endpoint: null
  payload_hash: 0f3a9c1b2d4e5f60
response:
  summary: One image returned.         # required
  provider_job_id: null
  error: null
media_files: [issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.png]
cost:                                  # required
  currency: USD                        # required
  amount: null                         # required. number, or null when the tool does not report it
  estimated: false                     # required
  reported: false                      # required. false = the tool gave no billing data
seed: null                             # integer or null
metadata_unavailable: [model, cost, seed]   # which of model | cost | seed the tool did not report
status: succeeded                      # required. pending | dry_run | submitted | succeeded | failed | rejected | approved
created_at: "2026-11-26T10:00:00Z"     # required
```

Never fill `model`, `cost.amount`, or `seed` with invented values.

`generate-assets.js` writes a `GEN_*.request.json` next to each record. It is
the handoff package (prompt, ordered references with their roles, target
file) and it keeps the request as sent even after the prompt package is
recompiled for a repair.

## issues/<ISS_ID>/pages/<PG_ID>/reviews/<RENDER_ID>.review.yaml (`visual-review`)

```yaml
page: PG_001_002                       # required
render: PG_001_002_V02                 # required. the render under review
supersedes: PG_001_002_V01             # the render this one replaces, or null
reviewer: visual-reviewer              # required. agent name or "human"
independent: true                      # required. true = the reviewer did not generate the image
compared_against:                      # required. what the pixels were compared to
  references: [LOOK_NOIR_INK_MASTER_V01, CHAR_MARA_TURN_MASTER_V01, CHAR_OSKAR_TURN_MASTER_V01]
  neighbors: [PG_001_001_V01]
checks:                                # required. every key below, each with result and evidence
  identity:        { result: pass, evidence: "Oskar's round face and hood match the sheet in panels 1-4." }
  cast_count:      { result: pass, evidence: "One Mara and one Oskar in each panel." }
  position:        { result: pass, evidence: "Mara on deck at the crates, as in the ledger." }
  movement:        { result: pass, evidence: "Ladder descent shown in panel 1." }
  role_causality:  { result: pass, evidence: "Mara, not Oskar, lifts the tarpaulin." }
  object_identity: { result: pass, evidence: "Flare gun keeps its wide barrel." }
  object_custody:  { result: pass, evidence: "Gun stays in Mara's right hand from panel 2." }
  physical_state:  { result: pass, evidence: "Oskar's cut left hand visible in panels 3 and 4." }
  wardrobe:        { result: pass, evidence: "Torn left cuff present." }
  spatial_logic:   { result: pass, evidence: "Bow stays screen left." }
  drawing_clarity: { result: pass, evidence: "Hands separate and readable." }
  lettering:       { result: pass, evidence: "All four strings exact; tails point to the right speaker." }
  page_structure:  { result: pass, evidence: "Four panels in the planned 2 / 2 grid." }
  style_fidelity:  { result: pass, evidence: "Line weight and black placement match the look master." }
  # result: pass | fail | not_applicable. evidence is required and describes pixels, not the prompt.
findings:                              # required (may be empty)
  - id: F01                            # required
    panel: PN_001_002_03               # panel ID, or null for a page-level finding
    check: identity                    # required. one of the check keys
    expected: Oskar has a round face and a hooded jacket.   # required. from canon or plan
    visible: In V01 the boy had Mara's long face and cropped hair.   # required. pixel-based observation
    severity: blocking                 # required. blocking | minor
    repair: Regenerate panel 3 with Oskar's sheet attached and the difference stated.   # required
    status: fixed                      # required. open | fixed | accepted
    recheck:                           # required when status is fixed
      render: PG_001_002_V02           # the corrected render that was reopened
      evidence: Round face and hood present in panel 3 of V02.
gates:                                 # required
  style_fidelity: pass                 # required. pass | fail
  narrative_continuity: pass           # required. pass | fail
verdict: fixed                         # required. pass | fixed | flagged
repair_cycle: 1                        # required. 0 for a first render; +1 per repair
reviewed_at: "2026-11-26"              # required
human_approval:
  status: pending                      # pending | approved | rejected
  by: null
  at: null
```

Review rules (`validate-workspace.js` enforces them mechanically):

- `verdict: pass` requires zero findings and every check `pass` or `not_applicable`.
- `verdict: fixed` requires at least one finding, no `open` blocking finding,
  and a `recheck` with evidence on every `fixed` finding.
- `verdict: flagged` is required when any blocking finding is `open` or any
  gate is `fail`.
- A `blocking` finding cannot be `accepted`.
- `repair_cycle` never exceeds `project.repair_policy.max_cycles`.
- `page.yaml` with `status: reviewed` or `approved` has a review file for its
  `current_render` whose verdict is `pass` or `fixed`.

## continuity/<ISS_ID>.final-state.yaml (`continuity-state`)

```yaml
issue: ISS_001                         # required
after_page: PG_001_002                 # required. the last page this state reflects
characters:                            # required. keyed by CHAR id
  CHAR_MARA:
    location: LOC_FERRY_DECK           # required
    position: { level: deck, side: left, landmark: crates }
    wardrobe: WARD_MARA_OILSKIN        # required
    state: []                          # required
    holding: [PROP_FLARE_GUN]          # required
    notes: ""
props:                                 # keyed by PROP id
  PROP_FLARE_GUN:
    custody: CHAR_MARA                 # CHAR id or null
    location: LOC_FERRY_DECK
    state: []
open_threads:
  - The patrol launch has not reached the ferry yet.
open_issues:
  - severity: minor                    # required. blocking | minor
    page: null
    description: Wheelhouse lamp is unstated after page 1.   # required
last_validated: "2026-11-26"           # required
```

## editions/<ED_ID>/edition.yaml (`edition`)

```yaml
id: ED_001_01                          # required
issue: ISS_001                         # required
title: The Night Ferry - Crossing      # required
label: first edition                   # required
status: draft                          # required. draft | reviewed | published
supersedes: null                       # previous edition ID, or null
changes: []                            # what changed since the superseded edition
pages:                                 # required, in reading order
  - page: PG_001_001                   # required
    render: PG_001_001_V01             # required. the exact render that ships
    file: issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.png   # required. relative to workspace root
    lettered_file: null                # overlay mode: the lettered output, else null
exports:                               # required (may be empty before the first build)
  - format: cbz                        # required. pdf | cbz | web
    file: editions/ED_001_01/exports/the-night-ferry-001-ed01.cbz   # required
    built_at: null
created_at: "2026-11-26"
```

Edition rules (`build-edition.js` and `validate-workspace.js`):

- Every listed render has a review with verdict `pass` or `fixed`. Otherwise
  the build refuses, unless `--draft`, which marks every export as a draft
  (`-DRAFT` in the file name, a stamp on every PDF page).
- Pages are listed once each, in page-number order, starting at page 1, with
  no gaps.
- Export names are `<title-slug>-<issue number>-ed<edition number>[-DRAFT].<ext>`;
  the web reader is a directory with the same base name and a `-web` suffix.
- An export file that already exists is never overwritten. `--force` replaces
  it only while the edition has status `draft`; a reviewed or published
  edition is corrected with a new edition ID that sets `supersedes` and
  `changes`.
- `lettered_file`, when set, is a PNG or JPEG. The SVG overlay written by
  `letter-pages.js` is exported to an image with a browser or a vector tool
  first.
