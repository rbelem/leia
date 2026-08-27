---
name: Leia
description: Reads webpages aloud with a highlight that follows the speech — warm stone surfaces, one amber lamp, native type.
colors:
  # Primary — the reading lamp. One amber voice, two scheme values.
  lamp-amber: "#b45309"
  lamplight: "#fbbf24"
  lamp-glow: "rgba(180, 83, 9, 0.12)"
  lamp-glow-dark: "rgba(251, 191, 36, 0.14)"
  # Neutral — warm stone, light scheme.
  warm-paper: "#faf9f7"
  sheet: "#ffffff"
  umber-ink: "#1c1917"
  marginalia: "#57534e"
  deckle-line: "#e7e5e4"
  # Neutral — warm stone, dark scheme.
  stone-panel: "#292524"
  dust-jacket: "#44403c"
  marginalia-dark: "#a8a29e"
  paper-ink: "#f5f5f4"
  chalk: "#f9fafb"
  # Semantic.
  bookmark-green: "#15803d"
  bookmark-green-dark: "#4ade80"
  redaction: "#b91c1c"
  redaction-dark: "#f87171"
  # Reading highlight — the default "sun" theme (wash + ink).
  sun-wash: "rgba(251, 191, 36, 0.42)"
  sun-ink: "#573a00"
typography:
  title:
    fontFamily: "system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "system-ui, sans-serif"
    fontSize: "10.5px"
    fontWeight: 650
    letterSpacing: "0.08em"
  caption:
    fontFamily: "system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  sm: "6px"
  md: "8px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "18px"
components:
  button-primary:
    backgroundColor: "{colors.lamp-amber}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "6px 10px"
  button-ghost:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.marginalia}"
    rounded: "{rounded.md}"
    padding: "5px 8px"
  transport-button:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.umber-ink}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
  chip:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.marginalia}"
    rounded: "{rounded.pill}"
    padding: "3px 7px"
  field-select:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.umber-ink}"
    rounded: "{rounded.md}"
    padding: "6px 8px"
  bar-pill:
    backgroundColor: "{colors.stone-panel}"
    textColor: "{colors.chalk}"
    rounded: "{rounded.pill}"
    padding: "8px 12px"
  swatch-chip:
    backgroundColor: "linear-gradient(135deg, {colors.sheet} 50%, {colors.stone-panel} 50%)"
    rounded: "{rounded.sm}"
    width: "34px"
    height: "24px"
---

# Design System: Leia

## Overview

**Creative North Star: "The Attentive Reader"**

Leia is a reading companion, not an app that happens to read. The visual world is a quiet library: warm stone surfaces the color of paper and linen bindings, a single amber lamp for attention, and type set in the browser's own native voice. Every surface exists to get out of the way of the page being read — the loudest thing in the product is the moving highlight on someone else's website, never the chrome around it.

Two extension surfaces share this world: the **popup** (a narrow, flat, hairline-sectioned panel in warm paper light or evening-stone dark) and the **floating bar** (a dark stone pill that drifts over arbitrary pages and can be dragged anywhere). The third surface is not chrome at all: the **marching highlight**, painted directly onto the host page's text through the CSS Custom Highlight API, contrast-checked against whatever background it lands on.

Controls are quiet and state-honest: every control visibly answers hover, press, focus, disabled, and loading, but nothing performs. A press dims and scales a whisper; a wait is a small spinning ring with words, never a skeleton screen.

**Key Characteristics:**
- Warm stone neutrals only — cool slates and blues are off-palette drift.
- One amber accent per scheme; its rarity is the point.
- Flat popup, one shadow in the whole system (the floating bar).
- Native `system-ui` type; counters in tabular numerals.
- Dark scheme by `prefers-color-scheme` only — no manual toggle.
- The brand mark (amber-haired Leia with reading glasses on a stone-900 disc) carries the same two hues as the UI.

## Colors

The palette is a warm stone ramp lit by one amber lamp; every hue in the system is either paper/binding or lamplight.

### Primary
- **Reading Lamp** (`lamp-amber`, light scheme): the single action color — primary buttons, selected swatch borders, focus rings. Roasted amber that holds 4.5:1+ as a focus ring on paper.
- **Lamplight** (`lamplight`, dark scheme): the same voice, lit for the dark — dark-scheme accent, and the universal focus-ring color on the floating bar (where it reads against the stone pill in any page context).
- **Lamp Glow** (`lamp-glow` / `lamp-glow-dark`): a 12–14% alpha wash of the accent, used for selected states (active theme swatch, transport hover) — attention without a second solid color.

### Neutral
- **Warm Paper** (`warm-paper`): the popup's light-scheme ground.
- **Sheet** (`sheet`): panels, inputs, and unpressed buttons in light scheme — a whiter page laid on the warm paper.
- **Umber Ink** (`umber-ink`): primary text in light scheme; doubles as the dark-scheme ground. One color, two roles — the book closed becomes the night table.
- **Marginalia** (`marginalia` / `marginalia-dark`): secondary text — hints, status lines, captions. Held to WCAG AA (≥4.5:1) on its ground in both schemes; the light value was deepened to stone-600 for exactly this reason.
- **Deckle Line** (`deckle-line`) / **Dust Jacket** (`dust-jacket`): hairline borders and dividers, light and dark. Structure comes from these 1px lines, not from shadows.
- **Stone Panel** (`stone-panel`): dark-scheme panels — and the floating bar's pill, and the icon's badge disc. One dark surface across product and brand.
- **Paper Ink** (`paper-ink`) / **Chalk** (`chalk`): near-white text on dark — popup dark ink and bar text respectively.

### Semantic
- **Bookmark Green** (`bookmark-green` / `-dark`): saved-state confirmation only (provider key saved).
- **Redaction** (`redaction` / `-dark`): engine errors, surfaced inline where reading happens.

### Reading highlight themes
The highlight layer ships five user-selectable wash themes — **sun** (default; the amber identity extended onto the page), **ocean**, **mint**, **berry**, **paper** — each with a light-band and dark-band variant (translucent wash + deliberate ink, inverted on dark pages). The default sun pair is tokenized above (`sun-wash` / `sun-ink`); the others live in `src/content/themes.ts` and follow the same wash-plus-ink discipline.

### Named Rules
**The One Lamp Rule.** Amber is the only accent on chrome surfaces. If a second saturated hue appears on a button, badge, or border, it is drift — the semantic greens/reds are for state text only.

**The Honest Contrast Rule.** A highlight variant ships only if its ink clears WCAG AA 4.5:1 against its own wash composited over the sampled page background — computed, not eyeballed (`pickVariant` in themes.ts). When no variant clears AA (mid-luminance pages), the system falls back to an underline-only variant that touches no colors. Never add a theme variant without running that check.

## Typography

**Display / Body / Label Font:** `system-ui, sans-serif` — one native stack for every surface, product-wide.

**Character:** deliberately voiceless. An extension lives inside the browser's chrome and on top of other people's pages; its type should feel like the platform, not like a brand. Personality is carried by color and the icon, never by letterforms.

### Hierarchy
- **Title** (650, 17px, -0.01em tracking): the popup masthead wordmark ("Leia") — the only display moment in the system.
- **Body** (400, 12.5px, 1.45 line-height): all popup UI text; the floating bar runs its own compact step (13px/1.4).
- **Label** (650, 10.5px, +0.08em, UPPERCASE, marginalia): section headings in the popup — small, spaced caps that recede under the content they name.
- **Caption** (400, 11–11.5px): hints, status lines, resume row, provider states. Status and position counters always set `font-variant-numeric: tabular-nums` so "sentence 3/12" never jitters.

### Named Rules
**The Native Stack Rule.** No webfonts, ever. A content script cannot afford font loading, and a toolbar popup shouldn't want it. If a surface needs character, reach for color, spacing, or the icon — not a typeface.

## Layout

Two fixed idioms, no grid system:

- **Popup:** a single 320px column. Sections stack vertically, separated by 1px deckle-line top borders with heading-above, content-below rhythm (10px above, 12px below). Related controls group tightly (6–8px gaps); sections separate generously. Nothing in the popup is responsive — the width is a platform constant.
- **Floating bar:** a horizontal pill, default-anchored 16px from the bottom-right viewport corner, `position: fixed` at the maximum z-index. The user can drag it anywhere; position clamps to the viewport on move and on window resize. A 4px movement threshold keeps drags from eating button clicks.
- **Highlight layer:** no layout of its own — it inherits the host page's geometry and re-samples the local background every time it moves, so it adapts crossing code blocks and callouts.

## Elevation & Depth

Nearly flat, by intent. The popup is a tonal world: depth comes from paper/panel layering and hairline rules, not shadows. The single exception is the floating bar, which must read as *above* an arbitrary page.

### Shadow Vocabulary
- **Bar lift** (`box-shadow: 0 2px 8px rgb(0 0 0 / .35)`): the floating bar only — a soft, low, offset lift. The one shadow in the system.

### Named Rules
**The One Shadow Rule.** Popup surfaces never cast shadows. If a panel needs separation, add a deckle-line border or a tonal step, not a shadow. Shadows belong to things that float over content the user owns.

## Shapes

Two radii, assigned by behavior, not by taste:

- **Gently squared** (8px radius): docked, panel-bound controls — popup buttons, selects, inputs, provider rows. 6px for small decorative chips (theme swatch tiles).
- **Full pill** (999px radius): anything that floats or filters — the bar itself, bar buttons, the speed select, capability chips, resume pills. Pills are for things unattached to the page flow.

Borders are always 1px in the current line color; selected states swap the border to amber and add the lamp-glow wash (theme swatches) rather than growing the stroke. The brand mark is a full-bleed circular badge — the only circle in the identity.

## Components

### Buttons
- **Shape:** gently squared (8px) in the popup; pill (999px) on the bar.
- **Primary:** solid Reading Lamp with white text (dark scheme: Lamplight with umber-ink text), semibold (600), 6px 10px padding. One primary per view — the Play action.
- **Hover / Active / Focus:** hover brightens (`brightness(1.06)`); press dims and compresses (`brightness(0.94)` + `scale(0.98)`); focus is a 2px amber ring, 1px offset, always visible. Transitions are short and plain (0.12s ease color, 0.06s transform).
- **Ghost:** panel background, marginalia text, smaller padding (5px 8px); hover lifts text to ink and border to muted. Used for secondary actions ("Open controls in page", "Preview", "clear").
- **Disabled:** opacity 0.5, default cursor — no other state leaks through (all hover rules are `:not(:disabled)`-guarded).
- **Loading (Play while synthesizing):** disabled + `aria-busy`, CSS-only spinner ring (10px, 2px border, 0.8s linear rotation) beside "starting… / resuming…", `cursor: progress`. Never a spinner alone — the word says what is happening.

### Transport (popup + bar)
- **Style:** ⏮ ▶ ⏭ ⏹ icon buttons around a flex-growing primary Play; icon buttons carry `title` + `aria-label`. Hover takes the lamp-glow wash; same press/focus grammar as all buttons.
- **State honesty:** skip buttons disable at playlist bounds and when stopped; Play's label and icon always reflect the true session state (⏸ only while playing).

### Chips
- **Style:** pill (999px), sheet background, deckle-line border, marginalia caption text (10.5px), 3px 7px padding — engine capability disclosure ("free · on-device · word timing").

### Inputs / Fields
- **Style:** sheet background, 1px deckle-line border, 8px radius, 6px 8px padding; labeled by visible text or `aria-label`, never placeholder-only.
- **Focus:** the universal 2px amber ring. Password API-key fields pair with a ghost show/hide toggle.

### Floating Bar (signature)
- **Style:** stone-panel pill, chalk text, the system's only shadow; controls are glass-tinted pills (white at 10–25% alpha) that brighten to 22% on hover.
- **Drag:** `grab` cursor at rest, `grabbing` while moving; `mousedown` is always prevented so the bar never steals the page's text selection or focus.
- **Status line:** marginalia-dark caption, ellipsized at 180px with a `title` tooltip mirroring the full text — long engine errors stay readable.
- **Scheme-locked:** the bar is always dark. It floats over unknown pages; a fixed dark pill is the only scheme-safe answer.
- **Injected stylesheet discipline:** pseudo-class states live in one injected `<style>` scoped under `#leia-floating-bar`; `!important` is used *only* where the element's inline `cssText` would otherwise win (backgrounds, cursors). The popup's real stylesheet never uses `!important`.

### Theme Swatches
- **Style:** 34×24 tiles, 6px radius, split diagonally light/dark to preview both bands of a highlight theme; radio semantics (`role="radio"`, `aria-checked`). Selected: amber border + lamp-glow background, label in ink.

### Brand Mark
- Flat bust of Leia — amber hair with side buns, cream face, dark reading glasses, open book — centered on a stone-panel circular badge with transparent corners. Ships at 16/32/48/128px; the glasses and buns are drawn bold enough to survive 16px.

## Do's and Don'ts

### Do:
- **Do** keep every neutral on the warm stone ramp (warm-paper → umber-ink); Marginalia text must hold ≥4.5:1 on its ground in both schemes.
- **Do** use the 2px amber focus ring (1px offset) on every focusable element, both surfaces.
- **Do** handle dark scheme exclusively through `prefers-color-scheme` token swaps.
- **Do** keep counters and positions in `tabular-nums`.
- **Do** answer every interaction state — hover, active, focus-visible, disabled, loading — with the quiet grammar above.
- **Do** paint the reading highlight with the Custom Highlight API (`::highlight`), which never mutates the host page's DOM.

### Don't:
- **Don't** introduce cool slates, blues, or pure grays on chrome surfaces — that drift was corrected once (the bar's old slate pill) and stays corrected.
- **Don't** add webfonts or a second typeface.
- **Don't** cast shadows inside the popup; one shadow system-wide, and it belongs to the bar.
- **Don't** add saturated accent colors beyond the one amber; state hues are text-only.
- **Don't** ship a highlight theme variant without the computed AA check; the underline-only fallback is the honest answer on hard backgrounds.
- **Don't** use `!important` in popup CSS, and in the bar's injected stylesheet only against inline `cssText`.
- **Don't** use image or GIF spinners; motion is CSS-only.
