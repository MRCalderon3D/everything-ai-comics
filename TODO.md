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
