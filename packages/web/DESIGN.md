---
name: Agent Profiler — Graphite
description: A keyboard-first local workbench for inspecting recorded agent behavior.
colors:
  background: "#19191c"
  foreground: "#eeeeef"
  card: "#1e1e22"
  popover: "#242428"
  primary: "#b5aff3"
  primary-foreground: "#202025"
  secondary: "#28282e"
  secondary-foreground: "#b4b4bf"
  muted-foreground: "#a0a0ab"
  accent: "#303038"
  accent-foreground: "#f3f3f5"
  destructive: "#b54e52"
  destructive-foreground: "hsl(0 0% 98%)"
  border: "#34343b"
  input: "#41414a"
  green: "#8bc7ab"
  amber: "#dfbb80"
  red: "#ed9a9e"
  rail: "#141417"
  animal-lavender-deep: "#958bb8"
  animal-lavender-low: "#a095c0"
  animal-lavender-mid: "#aba0c8"
  animal-lavender-high: "#b6aad0"
  animal-lavender-light: "#c0b4d8"
typography:
  headline:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.035em"
  title:
    fontSize: "18px"
    fontWeight: 500
    letterSpacing: "-0.02em"
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "13px"
    lineHeight: 1.5
  label:
    fontSize: "12px"
    fontWeight: 500
  micro:
    fontSize: "11px"
  source:
    fontFamily: "ui-monospace, monospace"
    fontSize: "12px"
    lineHeight: 1.65
rounded:
  sm: "4px"
  rail: "5px"
  md: "6px"
  lg: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  control: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  workspace: "36px"
components:
  button-outline:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "4px 12px"
  button-primary:
    backgroundColor: "color-mix(in oklab, #b5aff3 15%, transparent)"
    textColor: "{colors.primary}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "4px 12px"
  button-ghost:
    rounded: "{rounded.md}"
    height: "32px"
    padding: "4px 12px"
  input:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "4px 12px"
  navigation:
    textColor: "{colors.secondary-foreground}"
    rounded: "{rounded.rail}"
    padding: "7px 9px"
  chip:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-foreground}"
    rounded: "{rounded.sm}"
    padding: "2px 6px"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
  finding:
    padding: "18px 0"
  background-settings:
    backgroundColor: "{colors.popover}"
    rounded: "{rounded.lg}"
    padding: "16px"
    width: "270px"
---

# Design System: Agent Profiler

## Overview

**Creative North Star: "Graphite workbench"**

A restrained Operate interface for developers refining a personal agent environment through recorded evidence. The user selected Graphite, system UI typography and Linear-like keyboard primacy; Kombai Selects informs composition, not copied assets. This is an investigation workspace, not an executive dashboard.

The built interface separates persistent navigation, working evidence and optional activity. A persistent lavender ASCII animal background appears across all pages by default, with header scene controls and protected reading areas. All visuals are code-led: CSS, SVG icons, charts and an original local canvas renderer; no photographic assets or shipping rasters.

**Key Characteristics:**
- Neutral graphite layers with muted violet selection.
- Compact, sentence-case system typography and aligned evidence rows.
- Keyboard-first controls with visible focus and explicit uncertainty.
- App-wide ASCII animals with pausable motion and protected reading areas.

Authority is local to `packages/web`: this file owns primitives; `.impeccable/design.json` extends it. Sources: `src/styles.css`, `src/App.tsx`, `src/LiveActivity.tsx`, `src/AnimalBackground.tsx`, `src/animals.ts`, and `src/components/ui/*.tsx`. Product intent and approved direction remain in `PRODUCT.md` and `UI-REDESIGN.md`. The user's app-wide background correction supersedes the earlier idle-only/sidebar-toggle concept. Browser evidence and the independent focused finish review (disposition: ship) are recorded in `UI-REDESIGN.md`; this system record is not an exhaustive accessibility or performance certification.

## Colors

The palette uses near-neutral graphite, off-white text and measured semantic accents. Frontmatter preserves the numeric CSS palette; matching foreground aliases, `muted = popover`, `purple = primary`, and `ring = primary` share values in `styles.css`.

Sidecar neutral ramps reuse the built graphite/text family. Its chromatic OKLCH ramps are generated panel previews, not additional shipping tokens or replacements for the source colors.

### Primary

Muted violet (`primary`) marks actionable evidence links, selected controls, focus and model-call waterfall bars. Primary buttons use a translucent violet wash, not a solid promotional fill.

### Neutral

The darkest `rail` anchors navigation; `background` carries the workspace; `card` and `popover` lift supporting content. `foreground` is primary reading text; `secondary-foreground` supports descriptions; `muted-foreground` carries timestamps and metadata. `border` divides regions; `input` makes control outlines stronger. `accent` is hover/active fill, not another brand hue. Rail selection has its own quiet violet wash in the source.

The five `animal-lavender-*` shades are density-dependent glyph shading in `animals.ts`, not semantic status colors. The fixed background composites at 40% opacity, with additional per-animal alpha and a feathered reading-area mask. The header uses near-opaque graphite (`rgb(25 25 28 / .96)`); activity uses translucent card graphite (`rgb(30 30 34 / .85)`). These are layered fills, not glass effects.

### Semantic roles

`green` denotes recorded positive/status information, including a connected collector. `amber` marks recorded issues and tool-call bars. `red` marks critical badges; `destructive` is the destructive-action fill. Words and icons accompany state: connected is not synonymous with a successful run, and no recorded errors does not establish success.

**The Evidence Color Rule.** Use semantic color to distinguish recorded states, never to imply configuration causation or an invented health score.

## Typography

**Body and heading font:** the operating-system UI stack in frontmatter, explicitly chosen for this Operate screen. No display face or downloaded font is required. **Source font:** UI monospace for code, IDs and raw payloads, not general interface labels. Decorative animal glyphs separately use a canvas monospace stack; they are not interface text or icon art.

The hierarchy is compact rather than theatrical: page headline (24px/600), empty-state title (18px/500), metric value (16px/500), finding title and dialog text (14px), body and section heading (13px), controls/captions (12px), and supporting metadata/keycaps (11px). Mobile page headlines reduce to 21px. Section headings are weight 600; ordinary labels remain sentence case. Tabular numerals align measured values without making counters display typography.

Descriptions and finding summaries stop at 72ch; empty-state explanations stop at 48ch. Source blocks wrap long content, use the source role, and scroll after 360px. Do not reduce body evidence to microtext.

**The Operate Type Rule.** Preserve system UI for operating the workbench; reserve text monospace for source/data, apart from decorative canvas glyphs, and never add decorative display typography.

## Layout

The shell is a viewport-height grid (`100dvh`): a 224px rail and a `minmax(0, 1fr)` workspace. A 52px breadcrumb/action bar stays above independently scrolling evidence. Rail spacing is 20px top, 12px sides/bottom; the workspace uses 32px top, 36px sides and 64px bottom. Rhythm is mostly 4/8/12/16/24/32px, with observed 18px row spacing and 36px workspace gaps.

The relatively positioned shell isolates its stacking context. One viewport-fixed, pointer-transparent canvas sits at z-index -1 inside it, persists across route changes, and places animals in the workspace area after the desktop rail. It is not a sidebar graphic or an empty-state component. Desktop scenes contain four animals; widths below 768px use two. Pausing retains this background rather than removing it.

At 1440px, retain the desktop rail, compact aligned table, and review grid with a flexible evidence column, 240px property inspector and 36px gap. Properties have a left separator and 22px inset; values wrap rather than widening the grid. Optional activity occupies 390px, capped at 45vw, with its own scroll area. At widths up to 1150px, properties move below evidence with a top separator and two-column property list. At 1600px and above, workspace side padding becomes 48px.

At 390px (the ≤767px layout), hide the persistent rail and expose modal navigation from the menu button. Workspace padding becomes 24px 18px 40px; the bar uses 16px side insets. Session rows retain session identity and recorded cost while desktop-only metrics disappear. Toolbars wrap; the filter fills available width below 640px. Properties become one column. Activity replaces the visible main pane at full width rather than squeezing both. Tables keep local overflow; long source content wraps or scrolls within its own container.

## Elevation & Depth

Flat resting surfaces use subtle separators and tonal layering, not glass, glow or hard offset shadows. Cards are outlined, not floating statistic tiles. Modal dialogs use the Tailwind `shadow-2xl` elevation with a black 60% scrim; the header background-settings popover uses `0 12px 30px rgb(0 0 0 / .3)`, and the destructive button primitive retains a small shadow. Focus is functional: global focus uses a 2px violet outline with 3px offset; controls commonly substitute a 2px ring, and compact links use a 1px ring. Do not remove focus when changing control styles.

**The Flat Evidence Rule.** Separate evidence with alignment, tone and rules; reserve elevation for dialogs and control popovers.

## Shapes

Controls use the gently curved medium radius; keycaps and badges use the small radius; rail links use their 5px radius. Cards/dialogs use the larger 8px radius. Borders are normally 1px. The mobile drawer is deliberately square and full-height. Circular marks denote compact status, not decorative pill containers around every label. Icons are SVG components rather than text glyph substitutes.

## Components

### Buttons and fields

Outline is the default button: card fill, input border, accent hover. The named primary variant adds a violet 15% fill and 30% border, increasing fill to 25% on hover. Ghost buttons add no resting box; secondary uses the secondary surface; link uses violet text and hover underline. Destructive uses its semantic fill. Heights are 32px default/icon, 28px small and 36px large; icon controls are 32px square. Disabled controls use 50% opacity and suppress pointer interaction. Inputs match the default height/radius, with card fill, input border, muted placeholder and visible focus ring.

### Tables, properties and findings

Tables use a shared 13px text scale, 40px headers, 12px cell insets, row separators, muted hover and a distinct selected-row fill. Sorting remains a button with `aria-sort`; session titles remain real links even when the row is clickable. Right-align numeric evidence and use tabular numerals. Property lists use 85px term columns and 10px gaps; values wrap anywhere.

Findings are separated rows, not severity-colored cards. An observation/issue icon precedes a plain-language title and summary. “Inspect evidence” opens native disclosure content on a bordered card surface; keys and values remain inspectable, and recorded-context actions remain explicit. Neutral and semantic badges use small rounded corners, 11px text and restrained tinted fills.

### Navigation and command palette

Rail links are at least 34px high, with icon, label and optional trailing keycap. Hover uses the muted surface; selection uses a quiet violet tint and `aria-current` or `aria-pressed`. A skip link focuses the workspace.

On mobile, Radix Dialog supplies portal, scrim, modal focus containment and Escape dismissal. The drawer is `min(300px, 85vw)` wide and full `100dvh` height, with a title/description for assistive technology. Dismissal returns focus to the menu; a chosen route focuses the workspace, activity focuses its region, and opening another dialog hands focus to it. Switching back to desktop closes the drawer and focuses the workspace. These describe the current implementation, not independent browser verification.

Command search is a Radix modal with a focused combobox, listbox options, active-descendant selection and a live result count. It searches loaded sessions and commands, not an implied complete remote index. Arrow keys change the active result; Enter opens it; Escape closes. Focus returns to the opener or moves to the chosen workspace/activity region. Dialog width is viewport minus 32px, capped at 576px for commands; command height is capped at 75dvh. General dialogs cap at 672px and 80dvh, positioned 12% from the top.

Keyboard behavior: ⌘/Ctrl K opens command search even while typing; `?` opens help; `/` focuses the session filter; G S / G C navigate within an 800ms prefix window; A toggles activity. J/K select next/previous sessions (Enter opens selection) or navigate turns on a turn page. Plain-key navigation is suppressed in text-entry controls and dialogs; composition events do not invoke shortcuts. Escape also closes nonmodal activity when outside a dialog/text field.

### Empty, error, stale and Unknown

Empty history, no filter matches, loading, read failure and idle activity are different states. Read errors use an alert plus Retry, retaining last-loaded evidence where available; a failed read is never styled as an empty successful history. Stale activity values retain explicit “may be stale” or “last loaded” copy and snapshot timestamps. Pausing activity freezes display, not capture; pending updates remain counted.

Missing measured values read “Unknown,” not zero; chart gaps remain gaps. Existing unrecorded model metadata may instead use a dash or “Model not recorded.” Unknown is not a warning about agent quality. Synthetic sessions retain the Demo workspace disclosure. Recorded cost is not necessarily billed spend; receipt ordering is not execution chronology.

### App-wide ASCII animal background

Animals remain behind the UI on session lists, details, turns, cache, prompts and comparison, including populated views. The canvas is decorative and `aria-hidden`, never evidence or a collector/health signal. The app header's Background button opens a nonmodal settings group: native select choices are Ocean mix (default), Sharks, Rays, Seahorses and Jellyfish. Pause/Play changes motion, not presence. Scene and pause preferences persist under `agent-profiler:animal-background:v1`; unavailable/invalid storage falls back to an unpaused Ocean mix. Pointer-down outside dismisses the panel; Escape dismisses and returns focus to its trigger. The panel is 270px wide, capped at viewport minus 32px, with a 12px gap below its trigger, 16px padding and 8px radius. It is not a modal focus trap.

Original analytical density fields render four species: a curved shark, winged ray, curled-tail seahorse and pulsing/tentacled jellyfish. These are shaded glyph forms, not enlarged SVG/icon silhouettes. Each animal texture is 640×480 with a 100×70 glyph grid. The 67ms timer plus animation-frame scheduling bounds motion to at most 15fps; canvas DPR is capped at 1.5, and the viewport scene and protection backing stores are each capped at two million pixels using floored dimensions, not two million combined. Four fixed-size textures are separate from that viewport budget. Hidden tabs suspend scheduling; reduced-motion preference renders a still and disables Play/Pause. Paused/still scenes can redraw when viewport or reading regions change; global reduced-motion CSS also suppresses interface transitions.

Reading protection is a cached destination-out mask over heading/paragraph bounds in main, tables, findings, metric baselines, property lists, source blocks, notes, session-list footer and main code. Masks use 60% removal with a 20px blur and 12px expansion, followed by a 25% unblurred core pass, reducing rather than guaranteeing zero glyphs behind text. Scroll, main resize and main DOM mutations invalidate the mask; paused scenes can repaint after a 100ms invalidation delay. Do not characterize this as automatic full-page contrast verification.

Visual references only: [stackedlol/ascii-sharks](https://github.com/stackedlol/ascii-sharks) and [the user-pinned lavender ASCII seahorse post](https://x.com/dezinish13/status/2115140937689301263). The active animal implementation copies no upstream code, assets, pixels or paths; the old vendored MIT renderer is not part of this runtime. No reference images or network requests ship with the scene. Review screenshots in the repository-root `.impeccable/review/` are evidence, not shipping raster assets.

## Do's and Don'ts

### Do:
- **Do** preserve the Graphite shell, system UI typography and compact aligned evidence.
- **Do** keep uncertainty, stale reads and synthetic provenance visible in words.
- **Do** preserve keyboard paths, modal focus containment and visible focus.
- **Do** keep animals present across all pages, with header scene controls, pausable motion and reduced-motion stills.

### Don't:
- **Don't** add navy/neon dashboard styling, promotional counters or uppercase micro-labels.
- **Don't** infer instruction causation, success or agent health from trace counts or decoration.
- **Don't** restrict animals to a sidebar or empty state, let unmasked glyphs compete with reading areas, or substitute photography for code-led visuals.
- **Don't** treat a source-derived system record as a completed visual/accessibility review.
