# templates/looks/

Starter looks for comics. Each file describes one drawing style in the terms
the style bible uses (line, inking, tone, color mode, rendering, lettering)
and carries a style block you can freeze as it stands or edit first. The
presets have no JSON schema and the validator skips them, but they must stay
plain YAML: maps, lists, strings, and one block scalar for the style block.

Every preset is described by technique, materials, period, and publishing
tradition. None names a living artist, a series, a character, or a
publisher's trademark, and none tries to copy one person's hand. Keep it that
way when you add or edit one.

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

The `Panels` line of a style block describes the layout the tradition is
known for: one tier for a strip, four stacked panels for a yonkoma, a scroll
for a webtoon. Your page plans decide the real layout. If the two disagree,
edit that line before you freeze the block.

## Fields

| Field | What it holds |
|---|---|
| `id`, `name`, `status` | Identity of the preset. `status` stays `draft` here. |
| `intent` | When this look suits a story. |
| `line`, `inking`, `tone`, `rendering` | The drawing, in checkable terms. |
| `color_mode` | `monochrome`, `limited`, or `full_color`, as in `project.yaml`. |
| `palette` | Named colors for limited and full-color looks. Empty for monochrome. |
| `lettering_style` | Case, balloons, captions, and sound effects. |
| `style_block` | The prompt text to freeze. |
| `prompt_vocabulary`, `negative_vocabulary` | Phrases the prompt director may draw on, and phrases to keep out. |
| `drift_risks` | What an image model tends to lose with this look over several pages, such as screentone turning into a grey gradient. Look for these first when you review pages. |
| `pairs_with` | Formats, publication types, and genres the look usually serves. |

The drift risks come from how image models are known to handle each
technique. They have not yet been measured against renders of every preset.
When you draw the same scene twice with a look and see a drift that is not
listed, add it. When one keeps showing up in your production, add a phrase
against it to the negative vocabulary of your frozen block.

## Presets

### European and American traditions

| Preset | ID | Suits a story when |
|---|---|---|
| `ligne-claire.yaml` | `LOOK_LIGNE_CLAIRE_V01` | The setting matters as much as the cast and everything should read clearly: travel, adventure, mystery. |
| `franco-belgian-realistic.yaml` | `LOOK_FRANCO_BELGIAN_REALISTIC_V01` | It is a western, a historical epic, or an expedition, and the reader has to believe every horse and uniform. |
| `painted-album.yaml` | `LOOK_PAINTED_ALBUM_V01` | Each panel can hold like a canvas, as in a saga, dark fantasy, or adult science fiction. |
| `italian-popular-bw.yaml` | `LOOK_ITALIAN_POPULAR_BW_V01` | You need many pages of a genre serial at a steady rhythm, drawn in pen alone. |
| `superhero-modern.yaml` | `LOOK_SUPERHERO_MODERN_V01` | Powered characters, big anatomy, and saturated color have to hit hard on every page. |
| `four-color-sixties.yaml` | `LOOK_FOUR_COLOR_SIXTIES_V01` | The story wants primary colors, earnest heroics, and the feel of a cheap 1960s monthly. |
| `adventure-strip.yaml` | `LOOK_ADVENTURE_STRIP_V01` | A realistic serial (adventure, mystery, romance) is told a few panels at a time. |
| `underground-comix.yaml` | `LOOK_UNDERGROUND_COMIX_V01` | It is satire or confession and the drawing should feel handmade and unruly. |

### Manga and manhwa

| Preset | ID | Suits a story when |
|---|---|---|
| `manga-screentone.yaml` | `LOOK_MANGA_SCREENTONE_V01` | A long black-and-white serial changes pace from page to page. Action, drama, and slice of life all fit. |
| `shojo-manga.yaml` | `LOOK_SHOJO_MANGA_V01` | Romance or coming of age is told through feeling, and the layout carries the emotion. |
| `gekiga.yaml` | `LOOK_GEKIGA_V01` | The drama is adult, grim, and physical, paced like a film, with faces that look lived in. |
| `yonkoma-comedy.yaml` | `LOOK_YONKOMA_COMEDY_V01` | Each strip is one complete joke in four panels with a small cast. |
| `webtoon-color.yaml` | `LOOK_WEBTOON_COLOR_V01` | The comic is read on a phone, one scroll per episode, in polished color. |

### Graphic novel and indie

| Preset | ID | Suits a story when |
|---|---|---|
| `painted-watercolor.yaml` | `LOOK_PAINTED_WATERCOLOR_V01` | It is quiet, remembered, or a fairy tale, and weather and atmosphere do part of the telling. |
| `indie-minimal-line.yaml` | `LOOK_INDIE_MINIMAL_LINE_V01` | Timing and small gestures carry an introspective or wry story. |
| `risograph-two-color.yaml` | `LOOK_RISOGRAPH_TWO_COLOR_V01` | A zine or small-press book wants two strong inks and a printed, imperfect surface. |
| `woodcut-print.yaml` | `LOOK_WOODCUT_PRINT_V01` | A fable, folk tale, or wordless story is stark and symbolic. |
| `charcoal-graphite.yaml` | `LOOK_CHARCOAL_GRAPHITE_V01` | Grief, memory, or war needs soft darkness and smudged edges. |

### Children and humor

| Preset | ID | Suits a story when |
|---|---|---|
| `newspaper-strip.yaml` | `LOOK_NEWSPAPER_STRIP_V01` | Gags and short daily episodes have to read at a small size. |
| `young-readers-cartoon.yaml` | `LOOK_YOUNG_READERS_CARTOON_V01` | The readers are about six to eleven, emotions are big, and every panel must read at a glance. |
| `franco-belgian-humor.yaml` | `LOOK_FRANCO_BELGIAN_HUMOR_V01` | A cartoony cast runs through a solid world, and the jokes live in movement and timing. |

### Genre looks

| Preset | ID | Suits a story when |
|---|---|---|
| `noir-ink.yaml` | `LOOK_NOIR_INK_V01` | Crime and night: the page should read as black shapes before it reads as detail. |
| `horror-scratch-wash.yaml` | `LOOK_HORROR_SCRATCH_WASH_V01` | Dread builds slowly and darkness should seep in. |
| `retro-pulp-scifi.yaml` | `LOOK_RETRO_PULP_SCIFI_V01` | It is rocket-age adventure that should look like a painted 1950s magazine cover come to life. |
| `cyberpunk-neon.yaml` | `LOOK_CYBERPUNK_NEON_V01` | A near-future city at night, lit by signs and screens. |
| `fantasy-illuminated.yaml` | `LOOK_FANTASY_ILLUMINATED_V01` | Myth or quest, where borders and gold make the book feel old and precious. |

## Looks left out

A few candidates were considered and not added. Shōnen action manga is
already covered by `manga-screentone.yaml`, and a muted watercolor memoir by
`painted-watercolor.yaml`. British anthology science fiction sits between
`noir-ink.yaml` and `italian-popular-bw.yaml`. Silent pantomime strips are a
way of telling, so use `newspaper-strip.yaml` without balloons. The editorial
pen-and-wash cartoon is built for single panels and caricature. Collage and
mixed media change their materials from panel to panel, and an image model has a hard
time repeating that across pages.

## Sample pages

[previews/](previews/README.md) holds one sample page per preset, all drawn
from the same test scene so the looks can be compared side by side.
