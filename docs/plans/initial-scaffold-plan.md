# Initial scaffold plan

Build plan for the first version of everything-ai-comics. The binding contract
is [conventions.md](../conventions.md) plus [data-model.md](../data-model.md);
this file records why the scaffold has the shape it has and how it was built.

## Starting point

Two things already existed.

The filmmaking scaffold (everything-ai-filmmaking) has the layered structure
this repo reuses: rules, agents, commands, skills, contexts, schemas,
manifests, providers, hooks, and a zero-dependency Node tooling layer that
validates the content and generates the harness wrappers.

A manual comic pilot, run on top of that scaffold, produced a 12-page,
69-panel chapter through seven editions. It worked, but only as a written
procedure: the film schemas could not validate a comic page, and every lesson
lived in prose. The pilot's failures are the requirements for this repo.

## What the pilot taught, and where it lands

| Pilot failure | Mechanism here |
|---|---|
| A character drawn with another character's face; the caption named the right person. | `character.yaml` carries `distinguishing_features` and `visually_adjacent_to`; prompts state the difference; the `identity` check in every review reads pixels, not captions. |
| A character fires from a platform they never reached. | Location maps define levels and landmarks; every panel row states a position; `check-continuity.js` flags a level change with no `moved` or `ellipsis`. |
| A dropped revolver reappears as a different pistol in another hand. | Panel ledger tracks custody; holder changes need a `transfers` entry; `object_identity` and `object_custody` are separate review checks. |
| A bloodstained hoodie turns clean. | Persistent state tags per panel; a tag can only disappear through `state_changes.resolves`. |
| Someone carries a wounded person and shoots at the same time. | Hands budget: carrying takes two hands, props declare `hands_required`. |
| "Continuity was checked" with nothing to show for it. | `visual-review.yaml` has fourteen named checks, each with evidence, and findings with expected / visible / repair / recheck. |
| Passing repository tests was reported as quality. | The `visual-evidence` rule and two separate gates; scripts report mechanical validation and visual review apart. |
| A repair request "succeeded" but changed nothing. | A `fixed` finding needs a recheck against the new render; `validate-workspace.js` enforces it. |
| Rerolling without end. | `repair_policy.max_cycles` (default 2), enforced on `repair_cycle`. |
| Model, cost, and seed invented to fill a form. | Generation records accept `unreported` and `null`, with `metadata_unavailable`. |
| Exports overwritten by a later build. | Editions list exact renders; `build-edition.js` never overwrites an export. |
| A style word repeated instead of the style image. | Frozen `style-block.txt` plus the look master attached on every request, one role per reference. |

## Mapping from film to comics

| Film scaffold | Comics scaffold |
|---|---|
| scene → shot | issue → scene → page → panel |
| shot.yaml | page.yaml (layout, panel script, ledger, lettering text) |
| storyboard | thumbnails |
| keyframes and clips | page renders, versioned |
| continuity by axis and screen direction | continuity by position, custody, wardrobe, and state |
| edit plan | edition (selected renders, exports) |
| cinema / commercial layers | paged / webtoon layers |
| video and audio providers | image providers only |

## Build phases

1. Contract: conventions, data model, shared workspace library.
2. Parallel build, one owner per layer: tooling core, schemas with templates
   and the example workspace, prompt pipeline with providers, continuity and
   gates with hooks, publishing scripts, agents and contexts, commands, skills,
   rules.
3. Integration: manifests, harness sync, `npm run validate`, `npm test`, and
   the example workspace through every script.
4. Documentation: README, getting started, workflow guide, layer READMEs.
5. Repository: first commit and push.

## Out of scope for the first version

- Rasterizing lettering. `letter-pages.js` writes an SVG overlay; flattening
  it to PNG needs a browser or a vector tool.
- Resizing or compositing images for social carousels. The edition lists the
  deliverable; cropping is left to an image tool.
- Video, audio, and motion comics.
