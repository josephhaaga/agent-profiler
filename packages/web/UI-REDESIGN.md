# Profiler workbench

Mode: Operate. Scope: all existing SPA routes and their shared controls.
Confirmed direction: graphite, selected by the user on 2026-10-28. Linear is the
craft/keyboard reference; Kombai Selects is additional composition inspiration.
User correction: ASCII animals are an app-wide background on every page, not a
sidebar feature or empty-state-only illustration. Preserve legibility with local
attenuation under reading areas. This supersedes the first implementation's
quiet-state-only restriction.

## Direction contract

THESIS: A workspace for investigating agent behavior and refining a personal
development environment, not a metrics dashboard. Reject the incumbent navy,
neon badges, display counters and uppercase micro-labels.

OWN-WORLD: Neutral graphite shell, slightly lighter working surface, off-white
text, muted violet selection and measured semantic colors. System UI typography,
monospace only for source/data, 6px controls, subtle separators, no glow or glass.

STORY: Select a session, identify recorded behavior worth investigating, inspect
the source evidence, and decide what to change outside this tool. Do not invent
configuration attribution or imply that recorded errors prove bad instructions.

FIRST VIEWPORT: A 224px left rail with search, session review, comparison, recent
sessions and connection state. A slim breadcrumb/action bar above the workspace.
Session list has a title and purpose, compact filters and legible aligned rows.
Session detail separates the review/execution content from a property inspector.

FORM: User-pinned Linear-like workbench; seed: none (user-pinned direction).
Signature interaction: persistent large ASCII animals behind every route. Ocean
mix, shark, ray, seahorse and jellyfish scenes share slow drift, pause and reduced
motion. Text regions attenuate the scene; decoration never claims agent health.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Verification

Preserve all existing routes and provenance. Test command palette, shortcut help,
session/turn keyboard selection, filtering, findings, tool evidence, prompt data,
cache unknown gaps, activity stale reads and mobile navigation. No production
collector changes or publication. Use disposable demo data only.

## First redesign finish evidence — 2026-10-28

- Root build, typecheck, and all 165 tests (724 assertions) pass. The mechanical
  design detector returned no findings for the redesigned UI.
- Browser checks used disposable synthetic data, desktop at 1440×1000 and mobile
  at 390×844. Captures live in the root `.impeccable/review/` directory.
- Verified session J/Enter, turn J/K, command palette arrow selection, G S,
  slash-to-filter, and prompt inspection with synthetic instruction attribution
  plus captured messages. Mobile keeps session identity and cost visible without
  document overflow. Unknown metrics remain Unknown.
- Fresh finish review accepted the graphite direction and identified one material
  mobile focus-isolation defect. It was fixed using a modal Radix navigation
  drawer. Eighteen Tab/Shift+Tab checks stayed inside it; Escape restored menu
  focus; selecting Compare focused the workspace. Desktop remains a normal rail.
- Drawer-to-command-search handoff leaves one dialog with focus on its combobox.
  Token contrast calculations pass the 4.5:1 text floor: body 15.13:1, secondary
  text 8.09:1, muted text on selected surface 5.05:1, rail secondary 8.95:1.
- Reviewer verdict pass: **ship**, mobile focus fix **resolved**. The verdict
  scores that correction; it is not a new whole-app audit or a claim of exhaustive
  accessibility coverage. No approved image comp or QUALITY BAR card was used;
  this was a user-pinned, code-led reference-based direction.
- ASCII renderer is adapted from a pinned MIT source, with reduced-motion,
  pause, offscreen suspension, cleanup, and a distributed third-party notice.
  This compact prototype was subsequently replaced by original app-wide forms;
  the old component, vendored renderer and its notice were removed together.

All redesign work is local and unpublished. Existing backend correctness changes
remain intact. The product still does not edit configuration or attribute an
outcome causally to an instruction, skill, or tool definition.

## Global-background correction — 2026-10-28

Focal moment: large, recognizable ASCII marine animals inhabit the workspace
behind every page, inspired by the user's seahorse reference. No sidebar toggle.
Continuity: a single canvas and clock persist across routes; scene and pause
preferences persist locally. Pause and reduced motion keep a deliberate still.
Feedback: the app-header Background control changes species and motion without
touching session data. Budget: at most four creatures, two on mobile, at most
15 frames/second, DPR capped at 1.5 and backing pixels capped at two million.
Cached feathered reading-area protection attenuates glyphs beneath evidence.

The four animal forms are original parametric ASCII artwork. X/GitHub references
are visual inspiration, not copied pixels or code. The compact shark prototype
and its vendored adaptation are no longer used.

### Background validation

- Full build/typecheck pass; **181 tests, 10,338 assertions**, including 16 new
  pure animal-form tests. Final focused web/CLI builds and web typecheck pass.
- Browser checks confirm the exact same nonempty canvas survives all six route
  kinds. All five scene choices render distinct images and persist locally.
- Pause produced identical pixels across 400ms; reduced motion across 450ms,
  retaining the scene with motion controls disabled. Escape closes settings and
  restores trigger focus. The mobile popover fits a 390px viewport without
  document overflow. The background cannot receive pointer or keyboard focus.
- A local desktop sample measured 12.2ms median and 14.3ms maximum CPU time for
  animal drawing commands (20 frames); this excludes GPU completion and mask
  refresh and is not a guarantee across devices. Four textures plus viewport and
  protection canvases have separate memory budgets. Conservative sampled muted
  text contrast over the default scene was at least 5.41:1 in the checked state.
- Detector found no issues in the new animal modules. It also surfaced existing
  App/CSS type/color/radius documentation advisories; unrelated token drift was
  not repaired as a side effect of this scoped correction.

Current captures are `animals-*.png` under the root `.impeccable/review/`.
Earlier compact-shark captures describe the superseded first interpretation.
Fresh independent review of this correction: **ship**, no material fixes.
It confirmed global placement, recognizable reference-derived character, distinct
original species, preserved reading hierarchy, and fitting mobile controls from
the supplied captures and source. Browser behavior remains separately verified;
the review is not an exhaustive accessibility or cross-device performance claim.
