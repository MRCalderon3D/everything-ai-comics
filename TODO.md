# TODO

Changes requested after trying the web studio. Newest at the bottom.

## Web studio

### 1. A modern interface with motion

The current interface works but looks plain. Redesign it to feel modern,
with animation, using three.js or a similar library.

Notes for whoever picks this up:

- The studio has no dependencies today and its pages run under a strict
  Content Security Policy (`default-src 'self'`, no CDN). three.js would have
  to be vendored as a file inside `studio/web/` (it is a single ES module,
  MIT license) rather than loaded from the network, and the "zero
  dependencies" line in `studio/README.md` and `CLAUDE.md` changes to say so.
- Motion has to respect `prefers-reduced-motion`, and the artwork stays the
  largest thing on screen. 3D belongs where it adds something (the project
  gallery, transitions between steps, the page viewer, waiting while a page
  is drawn), not behind every form.
- Keep the existing screens, API calls, translations and tests; this is a
  visual redesign, not a rewrite of the app's logic.

Usability and UX matter as much as the look. Run the redesign through the
web design skills available in the environment, not only through three.js:

- `frontend-design` for the visual direction (typography, layout, colour,
  motion that has a reason).
- `design-system` to set the tokens and components once, so every screen
  uses the same pieces.
- `click-path-audit` and `browser-qa` to walk the real flows (first project,
  style, a character, pages, a correction, publish) and find where a person
  gets lost, waits without knowing why, or has to guess the next step.
- Base the changes on what those passes find: fewer decisions per screen,
  one obvious next action, clear waiting states for jobs that take minutes,
  and no developer vocabulary (IDs, file names, verdict codes) in front of
  someone who only wants to make a comic. The advanced details stay one
  click away.
- Check the result with a person who has not used the studio before, and
  write down where they hesitated.

### 2. Sample images for every style

When choosing a style, each preset must show what it looks like. Today the
Style screen lists the six presets in `templates/looks/` with a name and a
text description only.

- Draw one sample page per preset (noir-ink, ligne-claire,
  manga-screentone, painted-watercolor, superhero-modern, newspaper-strip)
  with the same small scene, so the styles can be compared side by side.
- Ship them with the scaffold, next to the presets (for example
  `templates/looks/previews/<preset>.png`), with how they were made recorded.
- `GET /api/presets` returns a URL for each preview, and the Style screen
  shows them as large cards, with the selected one highlighted.
- A style described in words or taken from uploaded images has no preview
  until its look page is drawn; say so on the card.

### 3. Choose the model for each kind of work

The person wants to pick which model does each job, from a list of the
models the installed tools actually offer, instead of typing a name.

- Jobs: planning and writing (`plan`), reviewing images (`look`), drawing
  (`draw`). Drawing is Codex only for now; with only Claude Code installed
  it stays the manual upload.
- When Claude Code is detected, list its models for `plan` and `look`. When
  Codex is detected, list its models for `plan`, `look` and `draw`. Show
  only what is installed, and mark the tool's default.
- What exists today: `settings.drivers` picks the tool per job and
  `settings.models` already takes a model name per tool and job
  (`claude.plan`, `claude.look`, `codex.plan`, `codex.look`, `codex.draw`),
  passed to the CLI as `--model` / `-m`. The gap is the list. Find out how
  each CLI reports the models it can use (a command, its config, or its
  help), and fall back to the documented aliases when it reports nothing.
  Do not hardcode a list that goes stale without saying where it came from.
- `GET /api/health` (or the settings route) returns the list per tool, and
  the Settings screen shows one choice per job: tool, then model.
- Next to each choice, say what it is for in plain words (for example: a
  stronger model plans better and costs more of the subscription; a faster
  one is fine for reviews), and show the timings measured with each model
  once there are some.

### 4. One chat that follows the person across screens

Today each screen has its own conversation (keys such as `style`,
`character:CHAR_X`, `page:PG_001_002`). If the person asks on the Style
screen how to make a character and then goes to Characters, the
conversation is gone. It should travel with them.

- One conversation per project, open on every screen, that keeps its
  messages when the person moves between screens.
- The context still follows the screen: each message carries which screen
  it was sent from and the files of that screen, so "change this" means the
  thing in front of the person. Show that in the transcript (a small label
  per message: "from Style", "from Page 2").
- The AI can point the person to another screen ("go to Characters and add
  her there") as a link that opens it.
- Keep it resumable through the tool's own session (`--resume` for Claude,
  `codex exec resume` for Codex), and say what happens when the tool that
  answers changes in the middle.
- Decide what happens to the per-screen transcripts that exist today: fold
  them into the project conversation in time order, or keep them readable
  as history.

### 5. The AI does not write the story unless asked

Today creating a project with a description starts `project.setup` at
once, and the AI writes the premise, characters, facts, timeline and series
plan by itself, inventing what the description leaves open (in the test
run: the explanation of the mystery, the ending, who holds what). The
person wants to write the story. The AI helps when asked.

- Creating a project saves the title, the description and the options, and
  starts no AI job. The Story screen opens with the person's own text and
  empty fields to fill in.
- The AI writes or completes the story only on request, with explicit
  actions: "write a story bible from my description", "complete what is
  missing", "suggest an ending", or a chat request. Each action says before
  it runs what it will write.
- Whatever the AI proposes arrives as a proposal the person accepts, edits
  or rejects, part by part, before it becomes canon. Nothing it invents goes
  into the story bible silently, even when it is marked as an addition.
- The same rule applies further down the pipeline: when planning pages, the
  AI turns the person's text into panels and does not add story events the
  person did not write. When it has to fill a gap to make a page drawable
  (who stands where, what someone holds), it says so and lets the person
  change it.
- The scaffold side: `/story-bible` and `/source-analyze` already separate
  source facts from additions by provenance. The studio has to stop
  resolving open questions with additions on its own and show them to the
  person as questions instead (the `needs_decision` path exists for this).

### 7. Resizable and collapsible side columns

The studio has three vertical columns: the step navigation on the left, the
work in the middle, and the chat on the right. The person wants to resize
them and to hide the two side columns, to focus on what they are doing.

- Drag handles between the columns to change their width, with sensible
  minimum and maximum widths, and a double click on a handle to reset it.
- A control on each side column to collapse it to a thin rail and bring it
  back; a collapsed navigation keeps its step numbers as icons, and a
  collapsed chat shows an unread marker when a reply arrives.
- A focus mode (one shortcut or one button) that hides both sides at once.
- Keyboard access: the handles can be moved with the arrow keys, and every
  control has a label. Below the tablet width the sides become drawers.
- The layout is remembered per person in the browser (not per project) and
  survives a reload.

### 8. A chat that can do everything the screens do

The person wants to run the whole comic from the chat, the way they would
ask a coding assistant: "make a character from this photo in the comic's
style", "add two pages where she opens the box", "draw the cover". The chat
then does the work with the scaffold's resources, without the person
having to go to each screen.

What the chat does today: it answers in text, edits the files of the
screen the message came from, turns story text into proposals, and
suggests screens as links. It takes no attachments and cannot start a
job. Making a character from a photo already works, but only from the
Characters screen (name, description, photos, then a sheet in the
project's look).

- Attachments: images (and text files) can be dropped or pasted into the
  chat. They go through the existing upload store, and the model receives
  them as files it can look at (`--add-dir` for Claude, `-i` for Codex).
- Actions: the chat can start the same jobs the screens start
  (`character.create` with the attached photos, `pages.plan`,
  `pages.generate`, `page.correct`, `cover.create`, `publish.build`, and
  the rest of `studio/server/ops/`). The reply names the action and its
  parameters in the structured output, and the server checks and queues
  it through the normal job queue, so progress, the git commit per step,
  reviews and cancel work as they do from a screen. The model does not run
  scripts or write scaffold files on its own to get around the jobs.
- Before it runs, each action shows as a card in the transcript saying
  what it will do, which tool and model, and how long it usually takes.
  Quick actions that only write text can run at once if the person allows
  it in Settings; anything that draws asks first, because one page takes
  minutes of the subscription.
- When the job ends, the result comes back into the conversation (the
  sheet, the planned pages, the drawn page) with a link to the screen
  where it can be approved. Approval stays a person's decision, as on
  the screens.
- The story rule of item 5 still holds: story text the chat writes is a
  proposal, and a page plan does not add events the person did not ask
  for.
- Photos of real people: keep the rights notice the Characters screen
  shows today (use photos only of people who agree), and show it in the
  chat when an attached photo is used for a character.

### 9. A next issue that continues the comic

A finished comic (say 12 pages and a cover) can have a continuation that
keeps its look, its characters and its places. The data model already
allows it: a project is a series, `story/series-plan.yaml` lists issues,
each issue has its own pages, cover and editions, and `issue.yaml` has
`opens_from` for the continuity state the previous issue ended in. The
studio has no way to start one: today the person would have to add
`ISS_002` to the series plan by hand.

- A "New issue" action (on the Pages screen and on the project home)
  asks for a title and a rough page count and creates the next issue:
  the series-plan entry, `issues/ISS_00N/issue.yaml` with `opens_from`
  pointing at the previous issue's last continuity state, and nothing
  else. Look, characters, places, props and the story bible are the
  project's, so the new issue uses them without copying anything.
- The issue picker shows every issue, and the cover, publish and page
  screens follow the chosen one.
- Planning the first pages of the new issue starts from where the last
  issue ended (who has what, who is where), not from a blank state.
- The chat can create the next issue too (item 8).
- Adding pages to an issue that already has a published edition keeps
  working: the new pages go after the last one, and publishing again
  makes the next edition.

### 10. A full character sheet, refined round by round

Creating a character draws a turnaround (front, three-quarter, profile,
back), and expressions and wardrobe sheets can be drawn separately. The
person wants what a comic team uses: one character sheet image that defines
the character completely, and a way to keep changing it until it is right.

What the sheet holds, in one image, in the look of the comic:

- The character's name and a short line (series, sheet number), lettered
  in the project's language.
- The turnaround: front, three-quarter, profile and back, full figure, same
  scale, neutral pose.
- Close-ups of what identifies them: a scar, a wound, a tattoo, glasses, a
  ring. Each with a label ("left forearm").
- A row of expressions and key poses or states the story needs (tired,
  sitting, fallen, after a change in their condition), each labelled. The
  list comes from the character's description and the story bible, and
  the person can edit it before drawing.

How it is refined:

- The first sheet is a candidate (V01). The person asks for changes from
  the character screen or the chat ("shorter hair", "the wound on the
  other arm", "add a sitting pose"). Each round draws the next version from
  the previous image plus the list of changes, so what was right stays
  right, and updates the written character file to match.
- The versions sit side by side, the person can go back to an earlier
  one, and approving one makes it the identity master that pages use.
- Region marking, as page corrections have, works on the sheet too
  ("this hand").
- Scaffold side: add the full sheet as a sheet kind in
  `character-sheet-generation` and the character schemas, keep the
  separate turnaround, expressions and wardrobe sheets for those who want
  them, and check that labels on the sheet do not leak lettering into
  pages drawn from it as a reference.
- Found in a real run: a character made from a photo before the look page
  was approved got no sheet, and the only sign was a greyed-out checkbox.
  The character screen must say plainly that the sheet is missing and
  why, and once the look is approved, offer to draw the sheets of every
  character still without one.

### 11. Say what the page plan added, and keep the history clean

Found in a real run. Planning pages from the person's text created three
character files for people the text describes but who had no file yet (two
unnamed attackers and a child). That is right: they are drawn in panels and
need a file to stay the same from panel to panel. Two things are wrong.

- The person is not told. The plan's result must list what it added
  (characters, places, props), each with a link, and let the person rename
  it, edit it, or merge it into a character that already exists before
  approving the plan. Each one also shows as "needs a sheet" in the cast,
  since pages cannot be drawn until its sheet is approved.
- The git history put those files in the wrong commit: they were written
  by the running plan job while the person approved a sheet, and the
  approval's commit picked them up. A commit must hold only the files of
  its own step or approval. Undoing the approval would otherwise remove the
  three characters too.
- The same person got two IDs. A story proposal named the two attackers
  `CHAR_GREY_HAIRED_MAN` and `CHAR_BEARDED_MAN` in the story bible; the page
  plan, running at about the same time, created their files as
  `CHAR_ORANGE_GREY` and `CHAR_ORANGE_BEARD`. Before creating a character,
  place or prop, every step must match it against the IDs already in the
  story bible, the entity files and pending proposals, and reuse the
  existing ID when it is the same person.
- While a plan job is still writing pages, the plan's checks show dozens of
  errors (pages listed by scenes that do not exist yet, a broken page
  chain, a wrong page count). They are not errors yet. Do not run or show
  those checks for an issue whose plan job is running; say "planning page
  6 of 12" instead.

### 12. Show what changed while the person was elsewhere

Sheets, pages and plans run in the background for minutes while the person
keeps working on other parts of the project. When one finishes, nothing
points at it unless they happen to open that screen.

- A small marker (a dot with a count) on each entry of the side navigation
  whose screen has something new the person has not seen: Characters when
  a sheet was drawn, Pages when a plan or a page finished, Cover, Publish,
  Story when a proposal arrived, Corrections, and so on. The collapsed
  navigation rail (item 7) keeps the dots.
- Inside the screen, the same marker on each item that changed: the
  character card whose sheet is new, the page thumbnail that was drawn or
  repaired, the proposal waiting for a decision. A short line says what is
  new ("new expressions sheet", "page 4 drawn, needs review").
- Failures and questions count too, with a different colour: a job that
  failed or is waiting for an answer is the first thing to see.
- An item stops being new when the person opens it (or the screen shows it
  to them), not when the job ends. "Mark all as seen" per screen.
- Seen state is kept per project in the browser and survives a reload. It
  is built from the job results and the events the server already sends;
  the chat's own result messages (item 8) mark the same items.
- Respect reduced motion: the marker appears without animation then.

### 13. Delete what the person does not want to keep

Every try leaves files behind: sheet candidates, look pages, page renders,
cover versions, uploads. The person wants to remove the ones they do not
want, starting with character sheet images.

- A delete control on every generated image that is not in use: sheet
  candidates and superseded versions, look pages, page renders and repair
  attempts, cover versions, uploaded photos, drafts of editions. Also
  delete for a whole character, place or prop, and for a page.
- Refuse, with the reason, when the thing is in use: an approved master
  that pages were drawn from, the render an edition ships, a reference a
  planned page lists. Say what to do first (approve another version,
  remove it from the page). Deleting an approved master asks twice and
  says what depends on it.
- Delete keeps the scaffold consistent: the file, its manifest entry
  (`references/manifest.yaml`), the generation record, reviews of that
  render, and references to it in character files and plans. Run the
  workspace validation after and show nothing broken.
- It goes into the git history as its own step, so it can be undone from
  History. Say so in the confirmation ("you can bring it back from
  History").
- Select several and delete them at once (for example all rejected
  candidates of a character), and a "clean up" action per screen that
  offers every unused try.
- The chat can delete too (item 8), always as an action card the person
  confirms.

### 14. Edit the lettering of a planned page

In the plan review of a page, the person can only change the words of the
balloons the plan already has. They cannot add one, remove one, change who
says it, or change its kind. The scaffold already knows the kinds
(`letteringElement.type` in `schemas/page.schema.json`: caption, narration,
balloon, thought, whisper, shout, radio, sfx, sign); the screen does not
offer them.

- Per panel: add a lettering element, remove one, reorder them (reading
  order), and pick its kind with plain names and a small icon each: speech,
  thought, shout, whisper, radio or phone, caption, narration, sound
  effect, sign.
- Pick the speaker from the characters in that panel (or off panel, for a
  voice from outside the frame), and say where the tail points.
- Keep the scaffold's limits visible while typing (words per balloon,
  balloons per panel from the lettering rules) and warn before saving
  when a panel goes over them.
- Saving re-runs the plan checks for that page. If the page already has a
  render, say that the lettering changes need the page drawn again (or
  only re-lettered, in overlay mode) and offer that action.
- The chat can do the same from the page screen ("add a thought balloon for
  her in panel 3"), as an edit to the plan it shows before saving.

### 15. Pages with more characters than the drawing tool takes references

Found in a real run: a page with four characters needs five reference
images (the look plus four identity masters) and the `codex-cli` provider
declares a budget of four. Drawing refused, which is right. What followed
was wrong:

- The chat first switched the page to `per_panel` without rebuilding the
  reference plan, so the next draw failed with a message about running
  `build-reference-plan.js` by hand. Changing the generation mode must
  rebuild the reference plan in the same step.
- The chat then put one of the four characters off panel in two panels to
  fit four images. It changed the person's staging to get around a tool
  limit, without asking. A change to who is in a panel is a story change:
  it goes to the person as a proposal with the reason, never silently.
- The error text shown to the person is developer text (asset IDs,
  provider names, script names). Say it in plain words and offer the
  choices as buttons.

What to build:

- Done in part: asked directly, Codex says its image tool takes attached
  images as "recent conversation images", up to 5
  (`num_last_images_to_include`), and separately takes file paths in
  `referenced_image_paths` with no declared maximum. The budget is now 5.
  Next: make the provider ask Codex to pass the references as
  `referenced_image_paths` (absolute paths, in order) instead of relying on
  the attachments, have it report how many it passed, then measure 6, 8 and
  10 references with real sheets and raise the budget to what holds.
- When a page still goes over the budget, offer, in this order: draw it
  panel by panel (the reference plan rebuilt for that, each panel carrying
  only its own cast), or combine the secondary characters' approved sheets
  into one labelled cast image that takes one slot, or change the staging
  (as a proposal the person accepts).
- The page plan should know the budget: when planning, warn on panels and
  pages whose cast would go over it, before anything is drawn.

### 16. The touch-up limit is a warning, and the person decides

Today a page (and a cover) takes two touch-ups on the same image
(`repair_cycle`); the third change redraws the page from its plan. The
reason is real: the image tool regenerates the whole image on every edit,
so colours shift, line softens, faces drift and lettering degrades a little
more each round, while a redraw starts clean from the approved sheets. The
cost is also real: a redraw can lose a composition or a gesture the person
liked. The person should choose.

- The limit becomes a warning: "this image has had 2 touch-ups; more may
  start to degrade it". At the limit, the correction form offers both:
  touch up anyway, or redraw the whole page with the change.
- The number is a setting (default 2), per project, in Settings, with one
  line on what it trades.
- The scaffold side: `repair_cycle` limits in the rules and the review
  policy read the setting instead of a fixed number; automatic repairs
  after a blocking review keep their own limit so a loop cannot run on its
  own.
- The chat offers the same choice when a correction hits the limit.

### 17. The chat can guide the whole comic

Item 8 lets the chat do anything the screens do, when asked. The person
also wants the opposite: someone who does not know the steps, or does not
want to use the screens, can let the chat lead from an empty project to a
published comic, the way a person who knows the craft would.

- A "Guide me" mode, offered on a new project and available any time from
  the chat. In it, the chat knows where the project is (the same step
  state the side navigation uses) and always ends its reply with the next
  step: what it is, why it comes now, and what the person has to decide.
- One decision at a time, in plain words, with choices where they help
  (pick a style from the gallery with images, how many pages, which
  characters need a sheet). It explains a term the first time it uses it
  (look page, sheet, plan, touch-up), briefly.
- The story stays the person's (item 5): the guide asks them to tell the
  story, asks about what is missing, and offers to propose text only as a
  proposal they accept.
- Every action still goes through cards: explicit requests run at once,
  drawing says how long it takes. While a job runs, the guide says what is
  happening and what comes after, and picks up when the result arrives
  (item 8 results), showing the image and asking for approval or changes.
- Approvals are the person's: the guide shows the sheet, the plan or the
  page and asks "approve it, or what should change?".
- It handles detours: the person can ask anything or jump to a screen, and
  the guide resumes from the current state, not from a script.
- The person can leave guide mode at any point and keep going on the
  screens; the state is the same.
- Test it end to end in fake mode (a whole comic driven only by answering
  the guide), and once with the real CLIs.

### 18. When the drawing tool runs out of quota

Found in a real run: Codex's image tool hit its usage limit in the middle
of a 12-page `pages.generate`. Codex said so plainly ("Image generation
failed because the usage limit was reached"), but the job went on to the
next page, and the next, each failing the same way a minute later, with a
correction queued behind them that would fail too.

- Recognise a quota or rate-limit answer from either tool (Codex and
  Claude Code both say so in their output) as its own error kind, separate
  from a failed drawing.
- On it, stop the job's remaining pages at once, pause the queued jobs that
  need the same tool, and tell the person in plain words: which tool ran
  out, that nothing is wrong with the pages, and when it may come back if
  the tool says.
- Keep what was not drawn ready to resume with one button ("draw the
  remaining pages"), and do not count the failed attempts against the
  touch-up or repair limits.
- The chat and the guide (item 17) say the same and offer to resume later.
- Before batch work that draws many images (all pages of an issue, all
  missing sheets), say how many images it will draw, so the person can
  weigh it against their plan.

## Scaffold

### 6. More comic styles

Six presets is too few (`templates/looks/`: noir-ink, ligne-claire,
manga-screentone, painted-watercolor, superhero-modern, newspaper-strip).
Research more and add them, each as a full preset in the existing format
(`line`, `inking`, `tone`, `color_mode`, `palette`, `rendering`,
`lettering_style`, `style_block`, `prompt_vocabulary`,
`negative_vocabulary`, `pairs_with`) and each with its sample image (item 2).

Candidates to research, described by technique, never by naming a living
artist or imitating one person's work:

- European and American traditions: classic American newspaper adventure
  (feathered brush, zip-a-tone), 1960s four-colour superhero (Ben-Day dots,
  limited process colours), underground comix (dense crosshatching, rubbery
  figures), Franco-Belgian realistic adventure (fine pen, detailed
  backgrounds, flat colour), European painted album (fully painted
  gouache or oil), Italian popular black and white (fine pen, hatching
  for tone), British anthology science fiction (heavy blacks, intricate
  hatching).
- Manga and manhwa: shōnen action (speed lines, dynamic angles, heavy
  screentone), shōjo (fine line, flowers and sparkle tones, large eyes),
  gekiga (realistic, gritty, cinematic), chibi or comedic yonkoma
  (four-panel strip), full-colour webtoon (clean line, soft cel shading,
  vertical scroll framing).
- Graphic novel and indie: cartoony minimal line (thin uniform line, no
  shading), two-colour risograph (two spot inks, grain, misregistration),
  woodcut or linocut (carved white lines, no greys), charcoal and graphite
  (smudged tone, no line art), muted watercolour graphic memoir, collage
  and mixed media.
- Children and humour: bright rounded cartoon for young readers,
  silent-strip pantomime, editorial cartoon (pen and wash caricature).
- Genre looks: horror with scratchy line and grey wash, retro pulp
  science fiction (painted, saturated), cyberpunk neon (dark grounds,
  saturated rim light), fantasy illuminated (ornate borders, rich colour).

For each candidate: check that the image tool can hold it across several
pages (draw the same test scene twice and compare), keep only the ones that
stay consistent, and note in the preset what tends to drift. Update
`templates/looks/README.md` with the list and when each look suits a
story.
