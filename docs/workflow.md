# Workflow

How a comic moves through this scaffold, stage by stage. For each stage this
document says what has to be true before you move on, which file holds it,
and what checks it. The rules in `rules/` are the policy. This is the long
explanation of why the policy has the shape it has, and it links to the rule
files instead of repeating them.

The procedure started as a manual pilot: one prose chapter adapted into
twelve pages, by hand, on top of the filmmaking scaffold. The pilot worked,
and it failed in instructive ways. A character was drawn with another
character's face while the caption named the right person. A man fired from
a platform he had never reached. Each stage below exists because of a
failure like those. The examples use the sample workspace,
[The Night Ferry](../examples/the-night-ferry/README.md).

For the hands-on version with commands and output, read
[getting-started.md](getting-started.md).

## Two kinds of check

Everything in this workflow is checked one of two ways, and they answer
different questions.

| | Mechanical validation | Visual review |
|---|---|---|
| Looks at | YAML files | The rendered image |
| Done by | `validate-workspace.js`, `check-continuity.js`, the schemas, the hooks | A reviewer, agent or person, with the file open |
| Can establish | The plan is complete and does not contradict itself | The page shows what was planned |
| Cannot establish | Anything about a drawing | Whether the plan was coherent to begin with |

A clean script run on a workspace means the structured data is consistent.
It does not mean a page is right. Every report in the scaffold states the
two results on separate lines. The rule is
[common/visual-evidence.md](../rules/common/visual-evidence.md).

## 1. Fix the brief and the canon

| | |
|---|---|
| Before moving on | The project's format, page size, reading direction, language, color mode, lettering mode, and provider are decided. Every fact the comic depends on is recorded with its provenance. No blocking question is open. |
| Held in | `project.yaml`, `story/story-bible.yaml`, `story/series-plan.yaml` |
| Checked by | The `project`, `story-bible`, and `series-plan` schemas through `validate-workspace.js`. Propagation of a change is checked by the script editor and by you. |
| Rules | [writing/adaptation-fidelity.md](../rules/writing/adaptation-fidelity.md), [common/ask-dont-assume.md](../rules/common/ask-dont-assume.md), [common/source-of-truth.md](../rules/common/source-of-truth.md) |

An adaptation mixes three kinds of statement, and they need to stay
distinguishable. Some things the source says. Some things you changed. Some
things the adaptation had to invent because the source is silent, such as
the color of a coat. The story bible tags every fact as `source`,
`user_change`, or `addition`, and a `user_change` names the fact it
replaces.

The tag matters most when something changes. In The Night Ferry the source
hides the boy in a chain locker under a hatch. The user change `FACT_010`
moves him under a tarpaulin on the open deck. That one decision touches the
location's dressing, adds a prop, and rewrites a line of dialogue from "in
there" to "under there". Each fact lists the entities it `affects` so the
change can be walked to every file that depends on it. A change is applied
everywhere or it is not applied. No script can confirm that it reached every
line of dialogue, which is why the propagation report is part of
`/story-bible`.

Record what the source leaves open, and separate the questions that can
wait from the ones that cannot. A question blocks when its answer decides
who acts, where they stand, who holds an object, or how one character is
told apart from another. Those are resolved before generation. A minor
invented detail may stay provisional as long as it is visibly marked as an
addition.

## 2. Establish the visual references

| | |
|---|---|
| Before moving on | Every character who recurs has an approved identity sheet. Characters who could be confused are designed apart. Every location has a map. The style block is frozen and a look master is approved. |
| Held in | `characters/`, `locations/`, `props/`, `style/style-block.txt`, `references/manifest.yaml` |
| Checked by | The entity schemas. The `status` of each asset in the manifest. The `protect-approved-assets` hook for immutability. Whether two designs are far enough apart is a judgment made at approval. |
| Rules | [visual/character-consistency.md](../rules/visual/character-consistency.md), [visual/location-consistency.md](../rules/visual/location-consistency.md), [visual/visual-language.md](../rules/visual/visual-language.md), [common/approval-policy.md](../rules/common/approval-policy.md) |

Three kinds of reference get confused, and the confusion is expensive. An
identity reference says who someone is. A style reference says how the comic
is drawn. A costume reference says what someone wears. A grayscale portrait
photograph is an identity reference, however much it may look like a noir
drawing. Record which reference controls each decision, and give every
registered image one default role.

Character sheets are drawn in the comic's own style, for reading: clear
faces on plain backgrounds, at a consistent scale between views. Dramatic lighting
belongs on the pages. The sheet keeps the identity anchors while
simplifying everything else. Each character file lists those anchors as
`distinguishing_features`: for Mara, the broken nose, the cropped grey hair,
and the oilskin coat torn at the left cuff.

Secondary characters need references too. In the pilot, a secondary
character whose look had never been pinned down came out as a copy of
another one. Any character who has to be recognized across panels gets at least an
identity strip, and two characters a model could blend list each other under
`visually_adjacent_to`. That field is used later: the prompt compiler writes
the difference between them into every panel they share.

A location is mapped before anything is staged on it. The map names the
levels and the landmarks, and fixes which side is which. The ferry deck
has two levels, `deck` and `wheelhouse`, connected by a ladder, with the bow
at screen left. A panel can only place a character somewhere the map names.

Approval is recorded per asset and per version. An approved master does not
change. If the design changes, the new sheet is a new version and the old
one is marked superseded.

## 3. Plan pages and continuity before prompts

| | |
|---|---|
| Before moving on | Every page has a purpose, a grid, and one drawable moment per panel. Every panel says who is where, in what state, holding what. Every change between appearances is accounted for. The audit reports zero errors. |
| Held in | `issues/<ISS_ID>/issue.yaml`, `scenes/<SC_ID>.yaml`, `pages/<PG_ID>/page.yaml` |
| Checked by | `check-continuity.js` for the eleven ledger rules. The `page` schema for the shape. Travel and threat directions are not stored per panel, so no script checks them. |
| Rules | [layout/page-composition.md](../rules/layout/page-composition.md), [layout/panel-transitions.md](../rules/layout/panel-transitions.md), [layout/pacing.md](../rules/layout/pacing.md), [writing/comic-script-format.md](../rules/writing/comic-script-format.md), [visual/spatial-continuity.md](../rules/visual/spatial-continuity.md), [visual/state-continuity.md](../rules/visual/state-continuity.md) |

Planning is the cheap stage. A plan costs nothing to change. A rendered
page costs a generation to change, and the change can break something else
on the page.

### Pages and panels

Give each page one sentence of purpose: what the reader knows at the bottom
that they did not know at the top. Decide the panel count, the grid, and the
relative size of each panel, and let size follow weight.

Give each panel one drawable main moment: a single actor doing a single
thing. An action that runs alongside can sit in the background only if it
stays legible there. Write the acting as behavior: "grips the rail, looks
past him" can be drawn, and "angry" cannot.

Write the exact words now. Dialogue, captions, and sound effects go into
the page file character for character, because every later check compares
the rendered text against this copy.

### Geography

Sketch the space before staging anyone in it. Fix the travel direction and
the threat direction for the scene and hold them. In The Night Ferry the
patrol launch comes from the stern, so the threat is always at screen right
and the searchlight in the last panel appears there and nowhere else.
Distinguish one level from another, and inside from outside. A character who fires from a platform and then stands below it,
with no move in between, is a level error. The ledger exists to catch it
while it is still a line of YAML.

### Gutters

Decide what each gutter skips. Readers fill in a walk across a room without
help. They do not fill in a handoff or a climb between levels without
risking a wrong guess about who has the object or where someone is.
Label an intentional skip in the panel's `ellipsis`. Show a critical
transfer in a panel of its own. Narration cannot repair an impossible
drawing.

### The ledger

Each panel carries a row for every character whose state matters and a row
for every tracked object that is in nobody's hands. A row states the
position (level, side, landmark), the action, the wardrobe, the persistent
state tags, and what is held.

Characters who are off-panel keep their rows. Being outside the frame does
not reset anyone's location or empty their hands. Oskar is hidden under the
tarpaulin for the first six panels of the example and is never drawn in
them. Every one of those panels still has his row, with his position and
the tag `cut_left_hand`, so that when he appears in panel 7 the cut is
there.

Every difference from a character's previous appearance has to be declared:

| What changed | What the ledger needs |
|---|---|
| The level a character is on | `moved` on the row, or `ellipsis` on the panel |
| Who holds a prop, or whether it is held at all | A `transfers` entry: `handoff`, `pickup`, `drop`, `set_down`, `draw`, `holster`, `throw`, or `take` |
| A state tag is gained or lost | `state_changes.adds` or `state_changes.resolves` |
| The outfit, inside a scene | `wardrobe_change` |

Hands are counted. Carrying another character takes two. Each held prop
takes its `hands_required`. More than two in one row is a panel that cannot
be drawn. The pilot produced one: somebody carrying a wounded person and
shooting at the same time.

`check-continuity.js` enforces all of this on the written plan and prints
each violation with the panel, the entity, and a way to fix it. The rules
are listed in [data-model.md](data-model.md) under the page file. A worked
table is at the [end of this document](#worked-continuity-example).

Review the plan with the person who commissioned it when they ask for that.
An approved plan fixes intent. It does not approve an image that does not
exist yet.

## 4. Prepare prompts and references

| | |
|---|---|
| Before moving on | Each page has a reference plan in which every image has one role and fits the provider's budget. The prompt is compiled from the files. |
| Held in | `pages/<PG_ID>/reference-plan.yaml`, `pages/<PG_ID>/prompts/<provider>.yaml` |
| Checked by | `build-reference-plan.js` refuses a missing or unapproved master. The `reference-plan` schema restricts roles. The provider's `compile()` rejects a package beyond its capabilities. |
| Rules | [image/reference-roles.md](../rules/image/reference-roles.md), [image/image-generation.md](../rules/image/image-generation.md) |

Assign each input image one job and say what it is. The roles are `style`,
`identity`, `wardrobe`, `spatial_continuity`, `prop_consistency`,
`composition`, and `edit_target`. The prompt names every image by position
and role, and says what not to take from it. A style reference that happens
to show a face is still only a style reference. If it is allowed to act as
an identity reference, the model draws that face on everyone.

The style travels two ways on every request: the frozen style block as
text, and the approved look master as an image. Repeating the word "noir"
in a page prompt replaces neither.

Names do not carry identity. Writing "Oskar" in a prompt does not stop a
model from drawing Mara twice. For characters who could blend, the prompt
states the visible difference in both directions, using their
distinguishing features. The compiler does this from the bible. This is
what the compiled package for page 2 of the example says inside panel 3:

```
Mara is not Oskar. Mara: broken nose, grey cropped hair, oilskin coat with a torn left cuff.
Oskar: round face with wide-set eyes, hooded jacket with the hood up, child-sized build,
a head and a half shorter than Mara. Do not swap or blend their features.
```

The budget is finite. A provider takes a fixed number of images, and what
gets left out is a recorded decision with its risk written down. In the
example, page 2 needs the look master and two identity sheets, which leaves
one slot. The previous page takes it and the location plate is excluded.
The plan's notes say so, and the reviewer reads the exclusions first.

Nobody writes a prompt by hand. If the compiled prompt is wrong, the bible
or the page file is wrong, and that is where the fix goes. Keep the full
request and the versions of the references it used. The generation record
and the `.request.json` next to it hold both.

## 5. Generate and inspect sequentially

| | |
|---|---|
| Before moving on | The returned file has been opened. It is saved as a new version with a generation record. The previous page was reviewed before this one was requested. |
| Held in | `pages/<PG_ID>/renders/<PG_ID>_V##.png`, `generations/<PG_ID>/GEN_*.yaml` |
| Checked by | The `generation-record` schema. The cost confirmation in `generate-assets.js` and the `require-cost-confirmation` hook. `validate-workspace.js` resolves each record's output to a file. Whether the image is acceptable is visual review. |
| Rules | [image/page-generation.md](../rules/image/page-generation.md), [common/cost-control.md](../rules/common/cost-control.md), [common/asset-provenance.md](../rules/common/asset-provenance.md) |

Generate one page at a time, in reading order. The reason is inheritance.
Each page is attached to the next request as a spatial reference, so
whatever is wrong with it is copied forward. A batch of twelve pages
generated at once has twelve chances to drift apart and no chance to
correct.

Open the returned file before doing anything else with it. A successful
tool call means an image exists. It does not mean the page passed. Only a
page whose review ended in `pass` or `fixed` is attached to the next
request. Reviewed and approved are different words: a reviewed page can
serve as a reference while its human approval is still pending.

Save every result as a versioned candidate. Nothing is written over.

Record what the tool reported and nothing more. If it gave no model name,
the record says `unreported`. If it gave no cost or seed, they are `null`.
In the pilot, a model, a cost, and a seed were at one point invented to
fill a form. A record like that is worse than an empty one.

## 6. Review the pixels against the plan

| | |
|---|---|
| Before moving on | A review file exists for the render, with evidence for every check, a finding for every difference, both gates set, and a verdict. |
| Held in | `pages/<PG_ID>/reviews/<RENDER_ID>.review.yaml` |
| Checked by | The `visual-review` schema requires all fourteen checks with evidence. `validate-workspace.js` enforces the verdict rules. The content of the review can only be checked by another look at the image. |
| Rules | [common/visual-evidence.md](../rules/common/visual-evidence.md), [common/approval-policy.md](../rules/common/approval-policy.md) |

Read the whole page first, as a reader would, for the reading order. Then
go through each panel at a size where faces, hands, objects, and lettering
can be judged. A check made on a thumbnail was not made. Put the reference
sheets beside the panel. Compare the first panel with the last panel of the
previous page, and review pages together at their boundaries.

Do not infer a correct picture from a correct prompt, or from a correct
caption. The reviewer should not be the one who generated the image. When
that cannot be avoided, the review says so in `independent` and the page
gets a second look before approval.

| Check | Evidence to inspect | Failure examples |
|---|---|---|
| `identity` | Face, hair, facial hair, build, and costume against the assigned sheet | The boy is drawn with the pilot's long face; a caption names one character and the drawing shows another |
| `cast_count` | Each named identity counted separately in every panel | Two Maras in one panel; Oskar missing or replaced by a stranger |
| `position` | Level, side, landmark, and orientation against the ledger row | Mara acts from the wheelhouse in a panel that puts her at the crates |
| `movement` | Each character traced from appearance to appearance, with what happens between | Mara on the deck with no descent shown or declared; a carried character suddenly standing |
| `role_causality` | The visible actor matched to the planned action | Oskar lifts the tarpaulin that Mara was meant to lift; someone carries a person and uses both hands for something else |
| `object_identity` | Shape, type, and distinctive features across appearances | The wide-barrelled flare pistol becomes a revolver |
| `object_custody` | Possession traced through draws, drops, pickups, and handoffs | The flare gun appears in Oskar's hand with no transfer |
| `physical_state` | Injury, blood, damage, fatigue, and ability to move | Oskar's cut left hand is drawn whole; a badly hurt character acts healthy |
| `wardrobe` | Clothing layers, equipment, accessories, and hands | The torn left cuff is mended; gloves appear without a change |
| `spatial_logic` | Travel direction, threat direction, landmarks, eyelines, levels | The ladder switches sides; the searchlight comes from the bow |
| `drawing_clarity` | Hands, limbs, silhouettes, separation of bodies, points of contact | Merged bodies hide who is grabbed; an impossible hand changes the action |
| `lettering` | Exact words, accents, speaker, balloon tail, reading order, placement | A caption missing; a tail pointing at the wrong person; text over the action |
| `page_structure` | Panel count, grid, and narrative order | An extra inset changes the sequence; the last beat is missing |
| `style_fidelity` | Line weight, black placement, texture, and color mode against the look master | Grey gradients on a pure ink page; a spot color used outside its stated purpose |

Each check gets a result and a line of evidence that describes pixels:
which panel, what is drawn. "As specified in the prompt" is not evidence.
A check is `not_applicable` only when the page has nothing for it to
judge, and the evidence says why.

Some defects block. Identity ambiguity, a duplicated character, an
impossible position, broken causality, and a missing state transition that
later panels depend on all stop the page. If the pixels do not establish
who acts, that is a blocking finding even when a caption supplies the name.
A blocking finding cannot be accepted and waved through.

The review sets two gates. Style fidelity asks whether the page looks like
this comic. Narrative continuity asks whether it tells the planned story
without contradiction. They are recorded separately because a page can be
handsome and wrong.

## 7. Record evidence and repair failures

| | |
|---|---|
| Before moving on | Every finding has an expectation, an observation, a severity, and a repair. A repaired finding has a recheck against the new file. The page is `pass`, `fixed`, or back with its plan. |
| Held in | The review files of the old and the new render, the repair prompt package, the new render |
| Checked by | `validate-workspace.js`: a `fixed` finding needs a `recheck`, a `fixed` verdict cannot have an open blocking finding, `repair_cycle` cannot exceed the limit. `compile-prompts.js --repair` refuses at the limit. Whether a change happened is visual review. |
| Rules | [common/repair-limits.md](../rules/common/repair-limits.md) |

"Continuity was checked" records nothing a later reader can verify. A
finding does. This is the format, filled in with the finding from the
example:

| Finding | Page / panel / version | Expected from canon or plan | Actually visible | Severity | Required repair | Recheck evidence / status |
|---|---|---|---|---|---|---|
| F01, `identity` | PG_001_002, panel 3, V01 | Oskar has a round face, wide-set eyes, a small build, and a hooded jacket with the hood up | The boy has Mara's long face and cropped grey hair and no hood. Panel 4 repeats it | Blocking | Regenerate panels 3 and 4 with Oskar's sheet attached and his difference from Mara stated. Lock the lettering, the borders, and Mara | Fixed. Rechecked on V02 |

In the review file those columns are the fields `id`, `panel`, `check`,
`expected`, `visible`, `severity`, `repair`, `status`, and `recheck`.

The repair procedure:

1. Keep the failed version. Its file stays on disk, its review keeps the
   verdict `flagged`, and its generation record is marked `rejected`. It is
   no longer listed as the page's result once the replacement is reviewed.
2. Find the cause. If it is upstream, fix it there first: a character with
   no sheet, two characters the bible does not tell apart, a ledger row
   that never said who holds the object. The example's F01 came from a
   sheet that was not attached and a missing `visually_adjacent_to`.
   Sending the same ambiguous description again is a reroll.
3. State the request in four parts: the edit target, the failing panels,
   the exact changes, and the locked elements. Write each change so that
   its presence can be seen in the result.
4. Separate identity repairs from prop and state repairs when a combined
   request has left some of the changes undone.
5. Generate a sibling version. Open it and verify every requested change,
   one by one. A successful edit request is not evidence of a repair.
6. Recheck the entire page and its neighbors. A local edit moves things
   nobody asked it to move: a word in another balloon, or a cuff.
7. Count the cycle. After the project's limit, two by default, stop
   generating and return to the plan or the references. Record the
   upstream issue and the decision needed. Do not keep rerolling, and do
   not declare success.

The verdicts are `pass`, `fixed`, and `flagged`. Use `fixed` only after
opening the corrected file and confirming the listed repairs in it. Use
`flagged` when a blocking finding is open or the visible evidence is
ambiguous. State what was reviewed and which minor issues remain. Human
approval is a separate decision and is never implied by a verdict.

## 8. Letter the pages

| | |
|---|---|
| Before moving on | Every string on the page matches `page.yaml` character for character. Every tail points at its speaker. Balloons are met in their reading order and cover nothing the panel is about. |
| Held in | `page.yaml` for the text. In overlay mode, `lettering.yaml` and `renders/<RENDER_ID>.lettered.svg` |
| Checked by | `validate-workspace.js` and `letter-pages.js` fail an overlay whose text differs from the page file. `check-continuity.js` fails a speaker who is not in the panel. The drawn text is the `lettering` check of the review. |
| Rules | [lettering/balloons-and-captions.md](../rules/lettering/balloons-and-captions.md), [lettering/reading-order.md](../rules/lettering/reading-order.md), [lettering/sound-effects.md](../rules/lettering/sound-effects.md) |

The text has one home, the page file. There are two ways to get it onto
the page, and the project picks one in `lettering.mode`.

With lettering in the image, the model draws the words. No provider in the
roster declares reliable text rendering, so every string is checked in
review against the list the compiler put in the package. A wrong letter is
a finding, and correcting it costs a repair with the art locked.

With overlay lettering, the art is generated without text and the
lettering is set on top from geometry in `lettering.yaml`. A correction is
an edit to a YAML file and costs nothing. The output is an SVG. Flattening
it into the page image for an edition is done by hand in a browser or a
vector tool. `letter-pages.js --register-lettered` then files that image
next to the render and sets it as the page's `lettered_file` in the draft
editions.

Choose before the first page is rendered. A language with accents the
model is known to break, or pages that run close to their word budgets, are
reasons to choose overlay.

## 9. Close the issue and deliver

| | |
|---|---|
| Before moving on | Every page has a current render with a passing review. The end-of-issue state is written. The edition lists the exact render of each page. Every export has been opened. |
| Held in | `continuity/<ISS_ID>.final-state.yaml`, `issues/<ISS_ID>/cover/` when the issue has a cover, `editions/<ED_ID>/edition.yaml`, `editions/<ED_ID>/exports/` |
| Checked by | `validate-workspace.js` for the edition rules. `build-edition.js` refuses an unreviewed render without `--draft` and never overwrites an export. Publishing is a human decision. |
| Rules | [publishing/edition-assembly.md](../rules/publishing/edition-assembly.md), [publishing/export-formats.md](../rules/publishing/export-formats.md), and the format layer: [paged/print-specs.md](../rules/paged/print-specs.md) or [webtoon/episode-deliverables.md](../rules/webtoon/episode-deliverables.md) |

Before assembling, read the issue as a whole. Page-by-page review catches
what is wrong on a page. It does not catch slow drift, where each page is
close to its neighbor and the last page has wandered away from the first.
Compare the first and last appearance of each character and each tracked
object, and compare every page with the next at the boundary.

Write down where everything ends: each character's position, wardrobe,
state, and what they hold, and each prop's custody. The next issue opens
from that file. Where the render that ships differs from the ledger, the
next issue inherits what readers saw.

An edition names the exact render of every page. It does not take the
newest file in a folder, which may be a rejected attempt. In the example
the edition lists `PG_001_001_V01` and `PG_001_002_V02`. `PG_001_002_V01`
stays on disk, out of the edition, for comparison.

An issue can have a cover. `/cover` plans it in
`issues/<ISS_ID>/cover/cover.yaml` and takes it through the same loop as a
page: compile, generate, review the pixels, repair within the limit. It is
one image with no panels, so the review marks the ledger checks as not
applicable and judges the rest. When a render has passed and the user
approves it, the edition lists it under `cover:` and every export opens
with it. In the example that is `CV_001_V01`.

`build-edition.js` exports five formats from one edition: `pdf`, `cbz`,
`web`, `images` (a folder and a zip of numbered images), and `epub` (EPUB 3
with a fixed layout).

Deliver with an explicit account: the current file of every page, the
rejected versions kept, what was repaired, what was visually rechecked, and
what still needs a decision. Do not describe a draft or a flagged page as
approved. A corrected release is a new edition that says which edition it
supersedes and what changed.

## Worked continuity example

The scene from The Night Ferry, as the ledger records it. Mara is alone in
the wheelhouse. Oskar is hidden under a tarpaulin between the crates at the
bow, with a cut on his left hand. She hears something, takes the flare gun,
goes down, and uncovers him.

Rows are panels in reading order. "Off-panel" means the character has a row
with `off_panel: true` and is not drawn.

| Panel | Mara | Oskar | Flare gun | Tarpaulin |
|---|---|---|---|---|
| Page 1, panel 1 | Wheelhouse, right. Steers with one hand | Off-panel. Deck, left, at the crates. `cut_left_hand` | On its hook in the wheelhouse. Not visible | Over the crates. Visible |
| Page 1, panel 2 | Wheelhouse. Right hand on the wheel, left in her pocket | Off-panel, unchanged | On its hook. Visible, so the pickup is not a surprise | Over the crates |
| Page 1, panel 3 | Off-panel, steering | Off-panel. Shifts his weight | On its hook | Over the crates. A corner lifts |
| Page 1, panel 4 | Wheelhouse. Lifts the gun off its hook with her right hand | Off-panel. Holds still | `transfers`: `pickup`, to Mara. Now in her `holding` | Over the crates |
| Page 2, panel 1 | Deck, right, at the ladder. `moved`: climbed down the ladder from the wheelhouse | Off-panel | In Mara's right hand | Over the crates. Visible |
| Page 2, panel 2 | Deck, left, at the crates. `moved`: walked forward from the ladder. Levels the gun | Off-panel | In Mara's right hand | Over the crates |
| Page 2, panel 3 | At the crates. Lifts a corner of the tarpaulin with her left hand | First drawn appearance. Crouches, cut left hand against his chest. Whispers | In Mara's right hand | `transfers`: `pickup`, to Mara. In her left hand |
| Page 2, panel 4 | Stands over the crates, turned to screen right, gun lowered | Looks out from the gap. Cut left hand grips the lashing | In Mara's right hand | `transfers`: `set_down`, from Mara. Back over the crates |

Five things in this table are there because the audit would object
otherwise.

The gun is shown on its hook in panel 2 and picked up in panel 4 with a
`transfers` entry. Remove the entry and the audit reports `CUSTODY_JUMP`:
the gun was placed in panel 3 and is in a hand in panel 4 with nothing in
between.

Mara changes level between the two pages. Her row on page 2 sets `moved`,
and the panel draws the descent. Without `moved` or an `ellipsis` the audit
reports `POSITION_JUMP`. Her second `moved`, the walk to the crates, stays
on one level and is not required by the audit. It is there for the reader
of the plan.

In page 2, panel 3, Mara holds two props, one in each hand. Both take one
hand, so the row is at the limit. A third prop, or a two-handed one, would
be `HANDS_OVERLOAD`.

Oskar's `cut_left_hand` is on every one of his rows, drawn or not. Drop it
from one row without listing it under `state_changes.resolves` and the
audit reports `STATE_DROPPED`. Nothing in the issue resolves it, so the
end-of-issue state still carries it.

Oskar speaks in page 2, panel 3, and he has a drawn row in that panel. A
balloon whose speaker has no row is `SPEAKER_ABSENT`.

The audit passing meant this plan was coherent. It did not prevent the
first render of page 2 from showing the boy with Mara's face. The ledger
said who was in the panel. Only the review, with Oskar's sheet beside the
image, could say that the figure drawn there was not him. The repair
attached the sheet, stated the difference between the two, and produced
`PG_001_002_V02`. Its review checked the hood and the round face in the new
file, and also the gun's silhouette and the cut hand: a
review that looks only at the reported defect misses the ones nobody
reported.

## Stage summary

| Stage | Commands | Gate |
|---|---|---|
| Brief and canon | `/project-init`, `/source-analyze`, `/story-bible`, `/series-plan` | Canon approved, no blocking question open |
| Visual references | `/character-bible`, `/location-bible`, `/prop-bible`, `/style-bible`, `/ingest-references`, `/visual-development` | Masters approved, style block frozen |
| Plan | `/issue-breakdown`, `/page-plan`, `/panel-script`, `/thumbnails`, `/panel-ledger`, or `/smart-page` | `check-continuity.js` reports zero errors, plan approved |
| Prompts and references | `/reference-plan`, compiled by `/smart-page` or `/generate-pages` | Every reference approved, one role each, inside the budget |
| Generate | `/generate-pages` | Cost confirmed, file opened, record written |
| Review | `/visual-review` | Verdict `pass`, or `fixed` after a repair |
| Repair | `/repair-page` | Each change seen in the new file, within the cycle limit |
| Lettering | `/lettering` | Every string exact |
| Cover (optional) | `/cover` | A cover render reviewed `pass` or `fixed`, then approved by the user |
| Deliver | `/continuity-review`, `/build-edition` | Final state written, exports opened |

`/full-production` runs these stages in order and stops at each gate.
