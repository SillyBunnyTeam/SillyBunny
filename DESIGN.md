---
name: SillyBunny
description: An LLM frontend designed for roleplay and storywriting that stays out of the user's way until called for.
colors:
  accent: "#82b3ee"
  accent-soft: "#7191b8"
  on-accent: "#000000"
  view: "#1d1d20"
  window: "#222226"
  window-canvas: "#3a3a3e"
  headerbar: "#3a3a3e"
  popover: "#3a3a3e"
  toast: "#525255"
  panel-raised: "#38383c"
  panel-hover: "#434347"
  foreground: "#ffffff"
  dim-foreground: "#c6c6c7"
  shadow-ink: "#000006"
  success: "#78e9ab"
  danger: "#ff938c"
  warning: "#ffc252"
typography:
  display:
    fontFamily: "Adwaita Sans, system-ui, Noto Sans, sans-serif"
    fontSize: "calc(var(--mainFontSize) * 1.81)"
    fontWeight: 800
    lineHeight: 1.12
    letterSpacing: "0"
  headline:
    fontFamily: "Adwaita Sans, system-ui, Noto Sans, sans-serif"
    fontSize: "calc(var(--mainFontSize) * 1.35)"
    fontWeight: 800
    lineHeight: 1.18
    letterSpacing: "0"
  title:
    fontFamily: "Adwaita Sans, system-ui, Noto Sans, sans-serif"
    fontSize: "calc(var(--mainFontSize) * 1.08)"
    fontWeight: 700
    lineHeight: 1.18
    letterSpacing: "0"
  body:
    fontFamily: "Adwaita Sans, system-ui, Noto Sans, sans-serif"
    fontSize: "var(--mainFontSize)"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "0"
  label:
    fontFamily: "Adwaita Sans, system-ui, Noto Sans, sans-serif"
    fontSize: "calc(var(--mainFontSize) * 0.72)"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "0"
  mono:
    fontFamily: "Adwaita Mono, Noto Sans Mono, SFMono-Regular, Consolas, monospace"
    fontSize: "calc(var(--mainFontSize) * 0.84)"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  control: "9px"
  card: "12px"
  overlay: "15px"
  alert: "18px"
  sm: "10px"
  md: "14px"
  lg: "16px"
  xl: "20px"
  pill: "999px"
  shell-control: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  "2xl": "24px"
  "3xl": "32px"
  "4xl": "40px"
motion:
  state: "200ms cubic-bezier(0.25, 0.46, 0.45, 0.94)"
  reveal: "250ms cubic-bezier(0.25, 0.1, 0.25, 1)"
  surface: "300ms cubic-bezier(0.25, 0.1, 0.25, 1)"
  spring-dialog: "damping 0.62, mass 1, stiffness 500"
  spring-sheet: "damping 0.8, mass 1, stiffness 400"
  spring-navigation: "damping 1, mass 1, stiffness 1000"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
    height: "38px"
  button-ghost:
    backgroundColor: "color-mix(in srgb, {colors.foreground} 4%, transparent)"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
    height: "38px"
  button-suggested:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.pill}"
    size: "38px"
  input-field:
    backgroundColor: "{colors.window}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "12px"
    height: "46px"
  shell-tab-active:
    backgroundColor: "color-mix(in srgb, {colors.foreground} 10%, transparent)"
    textColor: "{colors.foreground}"
    rounded: "{rounded.shell-control}"
    padding: "8px 14px"
    height: "44px"
  card-surface:
    backgroundColor: "color-mix(in srgb, {colors.foreground} 4%, transparent)"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "14px"
  pref-group:
    backgroundColor: "color-mix(in srgb, {colors.foreground} 5%, transparent)"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}; {rounded.card} inside editors"
    border: "1px solid color-mix(in srgb, var(--sb-shell-border) 72%, transparent)"
    padding: "0; rows 6px 16px"
  popover-surface:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.overlay}"
    padding: "6px"
  menu-row:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "34px"
  toast:
    backgroundColor: "{colors.toast}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.overlay}"
    padding: "8px 12px"
  chip-enabled:
    backgroundColor: "color-mix(in srgb, {colors.accent} 16%, transparent)"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "6px 8px"
  shell-navigation-control:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.shell-control}"
    minimumHeight: "44px on coarse pointers; 40px on fine pointers"
  shell-icon-control:
    backgroundColor: "color-mix(in srgb, {colors.foreground} 10%, transparent)"
    textColor: "{colors.foreground}"
    rounded: "{rounded.shell-control}"
    size: "44px on coarse pointers; 40px on fine pointers"
  checkbox-checked:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "30%"
    size: "clamp(0.92rem, calc(0.78rem + 0.38vw), calc(var(--mainFontSize) + 0.12rem))"
  radio-checked:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.pill}"
  range:
    backgroundColor: "color-mix(in srgb, {colors.foreground} 16%, transparent)"
    textColor: "{colors.accent}"
    rounded: "{rounded.pill}"
    height: "4px trough; 18px thumb"
---

# Design Reference Documentation

- **GNOME HIG**: https://developer.gnome.org/hig/guidelines.html
- **GNOME Design Patterns**: https://developer.gnome.org/hig/patterns.html
- **GNOME HIG Reference** (keyboard shortcuts, palette, backgrounds): https://developer.gnome.org/hig/reference.html
- **GNOME Design Principles**: https://developer.gnome.org/hig/principles.html
- **libadwaita documentation** (stable): https://gnome.pages.gitlab.gnome.org/libadwaita/doc/1-latest/

SillyBunny follows the HIG unless a rule below says otherwise. Every departure is marked **Deviation:** next to the rule it affects.

# Design System: SillyBunny

## 1. Overview

**"Simple by default, powerful when needed"**

SillyBunny is an LLM roleplay client that best embodies KDE Plasma's driving philosophy alongside the HIG (human interface guidelines) of the GNOME project. Although great inspiration is taken from these projects, SillyBunny still stands on its own with a slight sense of whimsy based on its focus on roleplay and storywriting. The shell is deliberately kept out of the way so the user can focus on the main content until configuration and navigation are needed.

Helpful wording, tactile and easily glanceable feedback, and deliberate purpose define the shell. Complex configuration remains available to the user if they wish to seek it (as per upstream SillyTavern), but a good default experience is mandatory and implied. Configuration remains behind the shell at all times until called for. All elements of the shell must remain themeable with user CSS themes, and be fully compatible with SillyTavern data, presets, extensions, and settings.

The design philosophies of the GNOME project and its HIG should always be taken into consideration. This means accessibility through lack of distractions, animations that guide the user to what is clicked/tapped, responsive layouts, predictable touch targets, and nothing getting in the way of the main user experience. Mobile design must remain purposefully designed alongside the desktop, adapting libadwaita to a smaller and more touch-heavy window.

With this in mind, SillyBunny can inject its own fun in the design too. After all, it is a roleplay and storywriting client at heart. Included tutorial characters are helpful yet creatively fun to interact with.

This system rejects UI creep, nested menu spirals, configuration sprawl, bottom bar bloat, mystery meat navigation, desktop-only assumptions, and generic SaaS polish.

**Reference version:** libadwaita 1.7+ (values checked against the 1.10.0 stylesheet); GNOME HIG pages checked 2026-10-19. Where SillyBunny deviates, the deviation is stated next to the value.

**Key Characteristics:**
- Content-first chat viewport with no unsolicited permanent configuration panels.
- Familiar controls that disclose depth through deliberate input, not visual noise.
- Guided animations that promote accessibility and intuitive motion.
- Stable desktop and mobile interaction vocabulary, including WebKit-safe shell behavior.
- Personality expressed through usefulness and built-in assistants and characters.

## 2. Colours

The palette is a neutral base for customisation and exploration: the accent dictates user interaction. Values follow the libadwaita dark style (the bundled Libadwaita theme); Libadwaita Light maps the same roles onto the libadwaita light style. Every role below is derived from the user's theme colours, so the hex values describe the bundled Libadwaita theme only.

### Primary
- **Accent** (`#82b3ee`): `--sb-accent`, a 62/38 mix of the theme quote colour and body colour. With the Libadwaita theme the quote colour is libadwaita blue `#3584e4`, so the derived accent sits close to libadwaita's dark standalone blue. Used for suggested actions (primary and send), checked checkboxes and radios, the range thumb, focus rings, the selected-item icon, and important agent state. Use it as a signal, never as ambient ornament.
- **On Accent** (`--sb-on-accent` / `--sb-on-solid-accent`): Text and glyphs on a solid accent fill. Resolves to black or white per theme for contrast. Deviation: libadwaita always uses white on `#3584e4` (about 3.9:1); SillyBunny picks the ink that reaches 4.5:1.
- **Soft Accent** (`#7191b8`): Secondary accent for quiet helper states and badges. Selected backgrounds use neutral fills, not Soft Accent.

### Secondary
These are libadwaita's standalone status colours. The light style uses `#007c3d`, `#c30000`, and `#905400`, switched by `data-sb-surface-tone='light'`.
- **Success Green** (`#78e9ab`): Positive completion and healthy connection feedback. It must not compete with Accent for primary actions.
- **Destructive Red** (`#ff938c`): Destructive actions and errors that require attention.
- **Warning Yellow** (`#ffc252`): Caution and transient operational warnings.

### Layer Ladder
Shell layers are separated by tone first, then by a `1px` shade line or one overlay shadow. Each layer has an `--sb-layer-*` token mixed from theme colours and forced opaque where `rgb(from …)` is supported.

| Layer | Token | Source (dark) | Dark | Light | libadwaita role |
|---|---|---|---|---|---|
| View | `--sb-layer-view` | `--SmartThemeChatTintColor` | `#1d1d20` | `#ffffff` | `view-bg` |
| Chat column (desktop) | `--sb-chat-view-bg` | View at the tint's own alpha, `min(1, alpha / 0.9)`, times the Background Visibility overlay | `#1d1d20` (0.9 maps to opaque) | `#ffffff` (0.9 maps to opaque) | `view-bg` |
| Window | `--sb-layer-window` | `--SmartThemeBlurTintColor` | `#222226` | `#fafafb` | `window-bg` |
| Page | `--sb-page-bg-source` | BlurTint 88% + Body 12% (light 86/14) | `#3f3f43` | `#dcdcdd` | window behind `#sheld` |
| Canvas | `--sb-layer-canvas` | BlurTint 90% + Body 10% | `#3a3a3e` | `#e4e4e6` | `sidebar-bg` |
| Header bar | `--sb-layer-headerbar` | Same as canvas | `#3a3a3e` | `#e4e4e6` | `headerbar-bg` |
| Bottom bar | `--sb-layer-bottombar` | Same as canvas; light uses BlurTint 95% + Body 5% | `#3a3a3e` | `#efeff0` | bottom toolbar |
| Shell drawer | `--sb-layer-drawer` | Same as header bar; light uses BlurTint | `#3a3a3e` | `#fafafb` | `headerbar-bg` / `dialog-bg` |
| Popover | `--sb-layer-popover` | BlurTint 90% + Body 10%; light uses ChatTint | `#3a3a3e` | `#ffffff` | `popover-bg` |
| Dialog | `--sb-layer-dialog` | BlurTint 90% + Body 10%; light uses BlurTint | `#3a3a3e` | `#fafafb` | `dialog-bg` |
| Toast | `--sb-layer-toast` | BlurTint 80% + Body 20%; light uses Body 90% + black 10% | `#525255` | `#2e2e32` | toast `#505053` |

Hex values are what the bundled Libadwaita and Libadwaita Light themes render. Their BlurTint and ChatTint carry 0.9 alpha, which `color-mix()` takes into account before the layer is forced opaque, so the mixes come out a few steps lighter than the same mix of opaque colours (checked in Chromium, 2026-10-19).

- **The chat column** is the raw chat tint on mobile (upstream's rule) and `--sb-chat-view-bg` on desktop: View at the theme's tint alpha times the Background Visibility overlay, so the bundled 0.9 tints stay opaque and lower tints show the background. The page behind `#sheld` is `--sb-page-bg-source`, a mix of BlurTint toward Body so the main window stays distinct from the canvas in every theme. The top bar is Header bar. The Roleplay composer, bottom chat bar, and Conversation composer sit on Bottom bar. In dark mode that is the Canvas tone, the same as the top bar, so a light chat tint can never turn the bar white; the composer stays distinct from the darker chat column. In light mode it is a step between the white View and the Header bar, so page, top bar, bottom bar, and chat never share one tone.
- **The top bar is a flat libadwaita headerbar.** SillyBunny is chat-first, so the headerbar recedes and messages, the composer, and the character list carry the visual weight. It shares the canvas tone in both styles and separates from the chat column by tone and the header bar shade. Do not raise it into a heavier, toolbar-style band.
- **Shell drawers** continue the top bar. They separate from the view by tone and one overlay shadow, not by a heavy shadow or blur.
- **Popovers, menus, and dialogs** share the Canvas tone in dark mode and separate from what is behind them by their border and overlay shadow. In light mode they are the lightest layers and rely on a border and shade.
- **Raised Panel** (`#38383c`) and **Hover Panel** (`#434347`) are `--sb-raised-bg` (10%) and `--sb-raised-hover-bg` (15%) over Window. Raised Panel is a control fill, not a layer.
- **Foreground** (`#ffffff`) and **Dim Foreground** (`#c6c6c7`, `--sb-muted-fg`, 74% body colour). Dim text is never the sole carrier of meaning.
- **Shadow Ink** (`#000006`): Shade and shadow tint only. Never a text colour.

Preference groups use a 5% body-colour tint (libadwaita dark cards use 8%); the Tag Manager's groups use 8%. Flat controls use the fills in the Flat Fill Vocabulary.

### Named Rules
**The Signal Scarcity Rule.** Accent appears for action, selection, focus, or meaningful state. If removing it does not reduce comprehension, remove it.

**The Theme Alias Rule.** New work consumes `SmartTheme*`, `color-*`, `sb-*`, spacing, and radius aliases. Do not hard-code a new color that bypasses saved user themes.

**The Contrast Rule.** Body and placeholder text target at least 4.5:1 contrast; large text targets at least 3:1. Muted text can be quiet, but never illegible. Colour is never the only carrier of information; pair it with text, an icon, or shape (HIG UI Styling). Surfaces stay usable under `prefers-contrast: more` and `forced-colors: active`.

**The Opaque Shell Rule.** Header bars, drawers, popovers, menus, dialogs, and toasts are opaque. No `backdrop-filter` on shell layers; background images may show only through the canvas and the chat column at the theme's own tint alpha.

**The Single Shell Rule.** The shell has one libadwaita direction; there is no Shell Style picker, and stored legacy `sb-theme` values are ignored. UI themes, custom CSS, and the accent colour are the theming surface.

## 3. Typography

**Interface Font:** Adwaita Sans, then `system-ui`, Noto Sans, and the platform sans stack (`--mainFontFamily`).

**Mono Font:** Adwaita Mono for logs, prompt fragments, regex, token diagnostics, and structured output (`--monoFontFamily`).

**Character:** One dependable sans keeps chat, shell navigation, settings, and onboarding in the same voice. Weight and size create hierarchy. libadwaita uses no letter-spacing; new work sets none, and the legacy `--sb-tracking-label` and `--sb-tracking-kicker` tokens stay only until the remaining uppercase labels are reworked. Interface chrome avoids italic and oblique faces (HIG Typography); italics in chat messages are user formatting and are unaffected.

### Hierarchy
| Role | Token | Weight | Size | Line | libadwaita |
|---|---|---|---|---|---|
| Display | `--sb-type-display` | 800 | 1.81 | 1.12 | `.title-1` |
| Headline | `--sb-type-headline` | 800 | 1.35 | 1.18 | `.title-2` |
| Title | `--sb-type-title` | 700 | 1.08 | 1.18 | `.heading` / `.title-4` |
| Body | `--sb-type-body` | 400 | 1.0 | 1.55 | `.body` (1.4) |
| Label | `--sb-type-caption` | 700 | 0.72 | 1.35 | `.caption-heading` |
| Mono | `--monoFontFamily` | 400 | 0.84 | 1.45 | `.monospace` |

- **Display:** Home and first-run welcome titles only; never a control label.
- **Headline:** Shell titles and major opened-panel headings.
- **Title:** Setting groups, action rows, cards, and compact headings. Slightly larger than libadwaita's `.heading` because chat body text runs at `--mainFontSize`.
- **Body:** Chat and settings prose. Deviation: line height 1.55 instead of 1.4 for long-form roleplay reading. Keep prose near 65-75ch where the surface permits.
- **Label:** Compact metadata and state labels; capitalisation follows the Capitalisation Rule. Dimmed labels use `--sb-muted-fg`, the equivalent of `.dimmed` (55% in libadwaita, raised to 74% for contrast). Deviation: kept at 0.72 instead of libadwaita's 0.82 to avoid overflow in tight shell layouts like tab labels and conversation metadata.

### Named Rules
**The Interface Sans Rule.** Use the interface stack for controls, tabs, labels, and dense settings. Decorative type must never make repeated work harder.

**The User Scale Rule.** Product type follows `--mainFontSize` and existing user preferences. Do not add viewport-driven type or a parallel density system.

**The Wrap Safety Rule.** Headings use balanced wrapping where supported, and all labels must tolerate long translations, zoom, and narrow mobile widths without overflow.

**The Capitalisation Rule.** Follow the HIG Writing Style.
- **Header capitalisation** for headings (group, list, page, sheet, and dialog titles), header bar and view titles, view switcher and tab labels, button labels, menu items, tooltips, field labels, and the titles of rows in boxed lists (switch, combo, entry, spin, action, and button rows). Capitalise the first and last word, nouns, verbs, hyphenated words, and every word of four or more letters: "Find and Replace", "Self-Test", "Document Cannot Be Found".
- **Sentence capitalisation** for checkbox and radio labels, drop-down items, placeholders, row subtitles, captions, and body text in dialogs, banners, toasts, and status pages.
- Headings omit articles and auxiliary verbs ("Three Documents Updated"). An informal heading written as a full sentence uses sentence capitalisation and stays bold.
- Never all caps, and no uppercase tracked kickers.
- Group headings are bold (`.heading`). Deviation: a dimmed leading icon on group headings is SillyBunny's; libadwaita group titles have none.
- Resolution: the HIG Writing Style and Drop-Down Lists pages ask for sentence capitalisation on field and drop-down labels, while the Text Fields and Switches pages ask for header capitalisation. Every field label and boxed-list row title uses header capitalisation so a group reads consistently, as GNOME apps commonly do.
- Upstream SillyTavern strings keep their upstream wording and `data-i18n` keys. Existing sentence-case SillyBunny labels move to this rule as each surface is reworked.

## 4. Elevation

SillyBunny uses tonal layering first and restrained shadows second. The main chat surface stays visually calm. A shadow is reserved for an opened shell or an overlay that must sit above the conversation. Resting surfaces never pair a border with a shadow as decoration; overlays (popovers, sheets, drawers, dialogs) keep a `1px` border with one overlay shadow, as libadwaita popovers do.

### Shadow Vocabulary
All shadows mix `--SmartThemeShadowColor`, so themes control the ink.
- **Header bar shade** (`--sb-headerbar-shade`): a `1px` line at the bottom of the top bar and the top of the composer. No blurred shadow.
- **Popover Shadow** (`--sb-shadow-popover`): `0 1px 5px 1px` and `0 2px 14px 3px` at low shade alpha, plus the `1px` border. Menus, select dropdowns, the search results list, the persona picker, and message popovers.
- **Dialog Shadow** (`--sb-shadow-dialog`): `0 0 14px 2px` and `0 0 5px 2px` at low shade alpha, plus the `1px` border and, in dark mode, a `1px` inner highlight. Dialogs and shell drawers.
- **Dialog Backdrop** (`--sb-dialog-backdrop`): shade colour at about 50% (dark) or 14% (light). No backdrop blur.
- **Toast Shadow** (`--sb-shadow-toast`): `0 1px 3px 1px` and `0 2px 6px 2px` at low shade alpha.
- **Focus Ring** (`--sb-focus-ring-inset`: `inset 0 0 0 2px` of `--sb-focus-ring`): The only focus treatment for buttons, tabs, and menu rows. Fields draw the same colour as their border plus a `1px` inset, which reads as the same `2px` ring (see Inputs / Fields). Do not stack it with an outline or an outer ring. Checkboxes, radios, and ranges use a `2px` `--sb-focus-ring` outline with an offset instead. Deviation: the ring is about 55% accent rather than libadwaita's 50% to keep 3:1 against both tones.

### Flat Fill Vocabulary
Flat and raised controls use fills mixed from `--SmartThemeBodyColor`, so they follow light and dark themes without a new color. These are libadwaita's values.
- **Flat:** `--sb-flat-hover-bg` (7%), `--sb-flat-active-bg` (16%), `--sb-flat-selected-bg` (10%), and `--sb-flat-selected-hover-bg` (13%).
- **Raised:** `--sb-raised-bg` (10%), `--sb-raised-hover-bg` (15%), and `--sb-raised-active-bg` (22%; libadwaita uses 30%).
- **Toolbars:** The top bar, bottom chat bar, and composer are separated by a `1px` shade line only. On desktop the bottom chat bar and composer join into one stack split by a `1px` hairline. The generating state keeps its accent border and progress bar and has no outer glow.

### Named Rules
**The Layer Before Shadow Rule.** Establish a tonal surface before adding elevation. If a shadow is doing all the work, the surface token is wrong.

**The Flat Toolbar Rule.** Toolbar and navigation buttons are transparent at rest. Hover, press, and selection use neutral fills mixed from the body color, with no borders, bottom stripes, underlines, glows, or hover lift. Hover fills apply only under `(hover: hover)`.

**The WebKit Reliability Rule.** Prefer solid surfaces on mobile. Fixed layers must respect safe areas, keyboard resizing, scrolling, and focus behavior in Safari/WebKit.

## 5. Motion

Motion shows where something came from and where it went. It never delays a task.

### Tokens
| Token | Value | Use | libadwaita |
|---|---|---|---|
| `--sb-transition-fast` | `200ms` `--sb-ease-out-quad` | Hover, press, focus, selection, colour and fill changes | `$button_transition`, `$focus_transition` |
| `--sb-transition` | `250ms` `--sb-ease` | Reveals, expanders, height changes, banners, crossfades | GtkRevealer, AdwExpanderRow |
| `--sb-transition-slow` | `300ms` `--sb-ease` | Toasts and large surface fades | AdwToast |
| `--sb-ease-out-quad` | `cubic-bezier(0.25, 0.46, 0.45, 0.94)` | State changes | `$ease-out-quad` |
| `--sb-ease` | `cubic-bezier(0.25, 0.1, 0.25, 1)` | Timed animations | `ADW_EASE` |
| `--sb-ease-out-cubic` | `cubic-bezier(0.33, 1, 0.68, 1)` | Exits and fades | ease-out-cubic |

Springs are sampled from libadwaita's AdwSpringAnimation into CSS `linear()` easings, with a cubic-bezier fallback where `linear()` is unsupported (Safari before 17.2). `public/scripts/sillybunny-motion.js` owns the JS presets.
- **Dialog spring** (0.62, 1, 500): about 510ms, peak 1.08. Dialog open: scale `0.8 → 1` and fade from centre. This is the only motion that overshoots.
- **Sheet spring** (0.8, 1, 400): about 470ms, near-critical. Mobile bottom sheets and shell drawers.
- **Navigation spring** (1, 1, 1000): about 330ms, critically damped. Mobile page push and pop.
- **Closing** uses the clamped spring or `--sb-ease-out-cubic` and never overshoots.

### Per Surface
- **Shell drawers:** Sheet spring, fade and scale `0.96 → 1` from the trigger. Close is a 200ms fade and scale to `0.98`. Mobile drawers animate both ways.
- **Popovers and menus** (options, extensions, select dropdowns, search results, context menus, message popovers): 200ms fade and scale `0.96 → 1` from the trigger edge; close is a 150ms fade. Deviation: GTK4 popovers do not animate; SillyBunny keeps the short origin cue so the user sees what opened.
- **Dialogs:** Dialog spring in; clamped out at 200ms to scale `0.9` and fade. The backdrop fades with the dialog.
- **Toasts:** In over 300ms, sliding from their own height plus a fade. Out over 300ms with a fade and scale to `0.95`.
- **Tabs and page sections:** 200ms crossfade (AdwViewStack). Mobile section pages use the navigation spring.
- **Expanders:** 250ms reveal; the chevron rotates over 200ms.

### Named Rules
**The State-Only Motion Rule.** Animate state, origin, and destination only. No decorative choreography, ambient loops, or hover lift.

**The Reduced Motion Rule.** `prefers-reduced-motion: reduce` or the Reduced Motion setting removes movement and scale. State changes become instant or a crossfade of 200ms or less. JS helpers are no-ops under reduced motion.

## 6. Components

### Buttons
- **General shape:** Content buttons keep `--sb-radius-button` (`14px`) and icon-only content controls `10px` until each page is migrated. New shell controls that are not pills use `--sb-radius-control` (`9px`, libadwaita `$button_radius`).
- **Shell navigation:** Top-bar destinations, shell section triggers, back/close controls, and chat-navigation actions use a full pill radius (`999px`). Icon-only shell actions are circular. Controls are at least `44px` on coarse pointers and may be `40px` on fine pointers. Every top-bar control has a tooltip (HIG Header Bars). Deviation: libadwaita controls are `34px`; SillyBunny keeps larger targets for touch. Deviation: libadwaita header-bar buttons are rounded rectangles (`9px`); the HIG reserves pills for a primary text button in open space and circles for clusters of small buttons.
- **Primary:** A libadwaita suggested action: Accent background, `--sb-on-solid-accent` text, `38px` minimum height, and `10px 14px` padding. Hover changes the fill slightly; there is no lift. A view has at most one button in the suggested or destructive style (HIG Buttons).
- **Content:** Outside the top bar, a button shows an icon or a label, not both (HIG Buttons). Labels are short imperative verbs in header capitalisation ("Save", "Update"). A button whose action is unavailable is insensitive instead of showing an error when clicked. No actions on double-click or right-click of a button. Existing buttons that pair an icon with a label move to this rule as each surface is reworked.
- **Hover / Focus:** Flat toolbar buttons (header bar, composer, bottom chat bar, conversation mode) are transparent at rest and show a neutral fill (7% body color) on hover, gated behind `@media (hover: hover)`. Pressed and selected states use heavier fills (10-16%). Focus-visible shows the inset ring with no outer glow. Raised buttons (shell close, mobile nav back/trigger) use a subtle tonal fill at rest.
- **Composer extension rows:** Guided Generations and input-history buttons are flat, borderless, and circular (`999px`), with the same neutral hover and press fills. An active guide keeps its `1px` inset quote-color ring as the state cue.
- **Suggested action:** Send buttons (roleplay and Conversation) are icon-only solid-accent circles with `--sb-on-solid-accent` ink. When disabled they switch to a neutral raised fill with dimmed body ink, never a faded accent.
- **Settings sheets:** Conversation settings groups are borderless tonal cards with bold headings and dimmed icons (Capitalisation Rule). Boolean options are switch rows with the title on the start and the switch on the end; a suffix control such as the Grounded Rules pencil sits outside the label. Buttons inside are borderless raised pills; the sheet close is a flat circle; selected day pills use a solid accent fill.
- **Edit actions:** Message and reasoning edit buttons are flat circles. Their text colour shows the role: success for Confirm, Destructive Red for Delete, the body colour for Cancel, and Accent otherwise. Cancel is neutral because Warning Yellow means caution, not cancel (HIG UI Styling: keep colour roles to their intended use). Hover and press use a `12%` and `20%` tint of the action's colour. Deviation: several coloured actions share one row; the HIG reserves strong colour for a single suggested or destructive button per view. Existing edit rows keep the yellow Cancel until they are reworked.
- **Secondary / Ghost:** Generic `.menu_button`s use a `4%` body-colour fill (`--sb-button-bg`), Foreground, and the upstream one-pixel theme border, at the same height and padding as the primary family. Hover deepens the fill to `8%`. New shell work should prefer the borderless raised or flat fills.
- **States:** Default, hover, focus-visible, active, disabled, loading, and error are explicit. Labels describe the action; icons alone are not enough for essential controls. Selected tabs and nav items use a neutral fill without a bottom accent stripe or inset shadow.

### Chips
- **Style:** Compact rounded controls at `14px`, `6px 8px` padding, readable text, and a tonal background.
- **State:** Enabled or selected chips use a 16% Accent tint and a status icon. Inactive chips remain legible and low emphasis.
- **Use:** In-chat agent controls and metadata only; do not turn the bottom bar into a chip collection.

### Cards / Containers
- **Corner Style:** Preference groups on settings pages use `--sb-radius-lg` (`16px`). Groups inside editors (List → Split Editor detail panes, editor sheets, Import, Tag Manager) use `--sb-radius-card` (`12px`, libadwaita's card radius). Content cards keep `14px` until pages are migrated. Popovers, menus, dialogs, shell drawers, toasts, and the composer stack use `--sb-radius-overlay` (`15px`). Alert-style confirmation dialogs use `--sb-radius-alert` (`18px`). The welcome surface may use `20px`. Nothing is larger.
- **Background:** Preference groups are libadwaita boxed lists: a `5%` body-colour tint (`8%` in the Tag Manager). Overlays use their layer token from the Layer Ladder so text never shows through.
- **Shadow Strategy:** Flat at rest. Only overlays carry a shadow.
- **Border:** Preference groups carry a `1px` theme-derived border. Overlays keep a one-pixel theme-derived border. Never use a colored side stripe.
- **Internal Padding:** `12px`, `14px`, `16px`, or `18px` according to density; compact mode reduces padding without changing hierarchy.
- **Content Rule:** Cards are working surfaces, not a repeated icon-heading-text grid. Prefer an open list, tab row, or inline section when that is clearer.

### Menus and Popovers
- **Surface:** Popover layer, `15px` radius, `6px` padding, `1px` border, Popover Shadow.
- **Rows:** `34px` minimum height (`44px` on coarse pointers), `0 12px` padding, `9px` radius, full opacity text with dimmed icons. Hover uses the flat hover fill, press the flat active fill, keyboard focus the inset focus ring. Deviation: GNOME popover menus show labels only (HIG UI Icons: a control has a label or an icon, not both).
- **Items (HIG Menus):** Verbs for commands and adjectives for settings, in header capitalisation. Checkbox and radio items are allowed; keep actions, checkbox items, and radio items in separate sections. Order by importance, task order, or frequency, with the most important items at the top or bottom. No nested submenus. Menus hold three to twelve items. Deviation: the message menu can exceed twelve rows because extensions add items.
- **Menu buttons:** Secondary menus use the vertical ellipsis (`view-more-symbolic` in GNOME). Its tooltip and accessible name name the menu ("Menu", or more specifically "Message Menu").
- **Popovers (HIG Popovers):** Small and simple, covering no more than about a third of the window. No Close or Done button. A heading only when the content's purpose is unclear. Esc closes the popover and returns focus to its trigger.
- **Dropdowns:** Select dropdowns and the search results list follow the same surface and row rules.

### Dialogs
- **Surface:** Dialog layer, `15px` radius (`18px` for confirmations), `1px` border, Dialog Shadow, Dialog Backdrop without blur.
- **Buttons:** Response buttons follow the primary and ghost families. The close button is a flat circle with at least a `34px` target.
- **Response order:** Cancel comes first and the affirmative last, as in GNOME. Custom responses sit between them.
- **Use (HIG Dialogs):** A dialog opens only in direct response to a deliberate action, never unexpectedly. Prefer inline controls to action dialogs. Alert dialogs carry one to three responses. Action dialogs label the affirmative response with a specific verb ("Save", "Export"), never "OK" or "Done", and keep it insensitive until required options are set. Avoid error dialogs; show non-critical errors inline or in a toast. Dialogs never stack on other dialogs.
- **Keyboard:** Initial focus goes to the control the user is expected to operate first. Esc activates Cancel. Return activates the affirmative response only when it is neither destructive nor irreversible; otherwise there is no default response.
- **Destructive actions:** Confirmed with an alert dialog: Cancel first and focused, the destructive response in Destructive Red. Changes inside an editor with explicit save need no confirmation, because Discard restores them. Deviation: the HIG prefers an undo toast to a confirmation dialog wherever the action can be reversed; SillyBunny confirms committed destructive actions, such as message deletion, instead.
- **Narrow widths (`768px` and below):** Dialogs become bottom sheets, as AdwDialog does. They span the full width, have overlay-radius top corners, a grab handle, safe-area padding, and scrolling content. They slide up with the sheet spring and slide down to close. Responses stack full-width at `44px`, with the affirmative on top and Cancel at the bottom.
- **Exclusions:** Large, wide, transparent, image-zoom, crop, and swipe-picker popups keep their own frames.

### Toasts
- **Surface:** Toast layer with white ink in both tones, `15px` radius, Toast Shadow, no border.
- **Status:** Error, warning, and success toasts keep the toast layer and use the standalone status colour for the icon and title only.
- **Use (HIG Toasts):** Transient and dismissible, for events and completion summaries that only matter while the app is open. A button only when it is directly useful, such as Undo. A toast is never the only place a persistent failure or state is shown: persistent states use a banner or the inline status next to the control that resolves them.
- **Position:** Deviation: toasts default to the top centre (upstream SillyTavern, adjustable by theme) instead of the bottom of the window.

### Banners, Status Pages, and Progress
- **Banners (HIG Banners):** For persistent states only, never for events or short-lived states. One short title written as an informal heading, and at most one button.
- **Status pages (HIG Placeholder Pages, `AdwStatusPage`):** Empty views, empty search results, and unavailable states show a symbolic icon, a heading that names the state, an optional line of guidance, and an optional action. Symbolic placeholders stay neutral in colour and tone.
- **Progress (HIG Spinners, Progress Bars):** Show progress for any operation that takes more than about three seconds. A spinner for operations up to about thirty seconds, placed in or next to the control it relates to, shown only after a short delay, and one at a time. A progress bar with text for longer tasks, inline with the content it tracks.

### Tooltips
- **Surface:** libadwaita OSD tooltip: shadow ink at 80%, white text, `9px` radius, `1px` 10% white border. Used for hover titles and the touch press-and-hold label.
- **Use (HIG Tooltips):** Every top-bar control has one. Elsewhere, use them only where they add information, and if one control in a container has a tooltip, all of them do. Tooltips never carry essential information, since touch and keyboard users may not see them. Text is short and in header capitalisation, and does not repeat a visible label: "Back", "Search", "Main Menu".

### Inputs / Fields
- **Style:** Window background (`--sb-input-bg`), one-pixel theme border, `14px` radius, `46px` default height, and `12px` inline padding.
- **Focus:** Accent, as in libadwaita, where entries take the same accent focus ring as every other control. The border turns `--sb-entry-focus-border` and the field receives a `1px` inset `--sb-entry-focus-ring` in the same colour, together a `2px` ring in the focus-ring colour (78% of `--sb-focus-ring`, about 55% accent). The fill does not change. The composer keeps its own accent outline (`--sb-composer-focus-*`).
- **Behaviour:** In forms and preferences, prefer entry rows to standalone fields (HIG Text Fields). A field that holds a setting applies its change on Return or when it loses focus. Validation feedback appears as the field is edited and favours a positive "valid" cue over showing an error while the user is still typing. Placeholders read like labels, or as an instruction ending in an ellipsis for action fields ("Search for a city…"). Secret fields hide their text where the browser supports masking and offer a reveal button; their input type is not changed. Typing never starts a network action; connecting and testing stay behind explicit buttons.
- **Error / Disabled:** Destructive Red uses a readable tint and explicit text; disabled fields preserve label and layout context rather than disappearing.
- **Mobile:** Controls meet the `44px` touch target contract on coarse pointers and remain usable with the software keyboard open.
- **Bottom chat bar:** The chat select and the mobile chat chip are borderless raised pills (`--sb-raised-*` fills). The search field is a borderless neutral pill. Both show the inset focus ring. The persona bubble has no border or scale; hover adds a neutral `2px` ring. On desktop the bar and composer join into one toolbar stack split by a `1px` hairline, unless group speaker controls or the delete dialog sit between them.
- **Global search:** The entry is a borderless raised pill over an opaque base, with the inset focus ring. Results sit in a popover. Rows are flat, `9px` radius, and filled only on hover, press, or keyboard selection. Group headings are dimmed and follow the Capitalisation Rule.

### Reasoning
- **Header:** A libadwaita expander row: neutral raised fill, `10px` radius, no border, inset focus ring. Desktop and mobile share one treatment.
- **Body:** Keeps the upstream thin left rule in the reasoning ink colour.

### Selection Controls
- **Choosing a control (HIG Switches, Checkboxes, Radio Buttons, Drop-Down Lists, Sliders, Spin Buttons):**
  - A switch is for an option with a clear binary nature, and is preferred to a checkbox for settings.
  - Checkboxes are for lists of independent choices, mixed states, and menu items. Label them by their checked effect and never negatively ("Play alert sound", not "Disable alert sound").
  - Two exclusive options use a segmented toggle or radio buttons, never a drop-down. Small exclusive sets use radio buttons or a segmented toggle; longer sets use a drop-down, with search for long lists.
  - A slider is for a fixed, ordered range with live feedback; pair it with a number field when exact values matter. A spin button is for an exact value, right-aligned.
  - A control that enables others sits directly above the controls it affects.
- **Checkbox:** Rounded square (radius `30%` of its size) with a `2px` neutral outline at rest. Checked fills solid Accent with a check glyph in `--sb-on-solid-accent`. No highlights, glow, or inner shadow.
- **Radio:** Circle with the same `2px` outline. Checked fills solid Accent with a centered dot in `--sb-on-solid-accent`. Segmented boolean radios (`.sb-boolean-radio-option`) keep their overlay input and are styled as the segment instead.
- **Range:** `4px` neutral trough and an `18px` Accent thumb with a `1px` shade. Firefox fills the trough up to the value; WebKit and Blink show the trough only. Hover grows the thumb slightly on hover-capable pointers.
- **Switch:** A `42×24` pill (`38×22` in compact mode) with `appearance: none` and `-webkit-appearance: none`. Off uses a `16%` body-colour trough; on fills solid Accent with a circular thumb in `--sb-on-solid-accent`. The thumb travels with `inset-inline-*` so RTL mirrors. Reduced motion snaps with no travel.
- **Focus / Disabled:** Small controls use a `2px` focus-ring outline with an offset so the ring stays visible around the control. Disabled controls drop to reduced opacity and a `not-allowed` cursor.

### Settings Rows
- **Foundation:** Settings panels use a consistent row anatomy borrowed from libadwaita `AdwActionRow` and `AdwExpanderRow`. Each `.ds-row` is a flex container, `44px`–`52px` minimum height, with `6px` vertical and `16px` horizontal padding, and a `1px` bottom separator (except the last row in a `.ds-pref-group`).
- **Anatomy:** Left side is `.ds-row-text` (flexing, `0` min-width for text wrapping): a title label followed by an optional `.ds-row-subtitle` (small grey text, visible description promoted from `title=` attributes). Right side is `.ds-row-suffix` (flex-shrink: 0): a control (select, input, switch, slider, button) or custom content.
- **Sizing contract:** Setting controls use `.ds-control-flex` (`flex: 1 1 190px; min-width: 0`) to maintain consistent width across varied label text. Labels in settings rows use `.ds-label-bounded` (`flex: 0 1 180px`) to prevent overflow. Controls with intrinsic width (`widthNatural`, `widthUnset`) are excluded from this contract and keep their natural dimensions.
- **Toggles (`.ds-row-switch`):** Boolean rows put `role="switch"` on the native checkbox input; its `checked` state is the switch state. Never add `aria-checked` to it (ARIA in HTML: "Authors MUST NOT use the aria-checked attribute on input type=checkbox elements"). The entire row is clickable (pointer events target the label). Keyboard focus and spacebar toggle the state.
- **Sliders (`.ds-row-slider`):** Title and optional subtitle on the left; range input and paired number field on the right. On viewports ≤ 620px, content stacks vertically and spans full width.
- **Expanders (`.ds-row-expander`):** Collapsible sections follow libadwaita `AdwExpanderRow`: a header row with a title, optional subtitle, optional suffix controls, and a trailing chevron after them. The chevron points down when collapsed and up when expanded. Content nests inside with `0` left margin.
- **Groups (`.ds-pref-group`):** Boxed lists with a `5%` body-colour tint, `16px` radius (`12px` inside editors), a `1px` border at 72% of `--sb-shell-border`, `6px 16px` padding on rows, and `0px` margin between groups (separators show where rows meet). The heading and optional description (`.ds-pref-group-header`) sit above the boxed list, not inside it, as in `AdwPreferencesGroup`.
- **Boxed-list rules (HIG Boxed Lists):**
  - Boxed lists are for small, static sets of rows. Large or dynamic collections use a list view (List → Split Editor).
  - A row holds one control, two at most. Clicking the row background activates its control; the control takes keyboard focus, not the row.
  - Rows that can be reordered offer Move Up and Move Down in their menu, which the HIG requires for accessibility, instead of a per-row remove button.
  - A button row that opens a new view ends with a trailing arrow instead of an ellipsis.
  - Groups and lists have a minimum and a maximum width.
- **Density:** Row heights and padding adjust for compact mode (set `--sb-density-scale`) without changing hierarchy.
- **Contrast:** Row text (including subtitles) maintains ≥ 4.5:1 contrast against background. Placeholders and secondary text use `--sb-input-placeholder` (78% body colour mixed with theme tint).

### Navigation
- **Layer 1:** The main chat window is the primary surface with a bottom bar for direct conversation actions.
- **Layer 2:** An always-visible top bar. Start: Backend, Customize, Search, and up to three quick-access slots. Centre: the title, which shows the active character's name by default. End: an extension slot, up to three quick-access slots, the mode switcher (a menu with Roleplay and Conversation), Home, and Characters. Quick access is configurable and desktop-only; Agents and Extensions fill two slots by default. Essential main-content controls stay labelled and visible.
- **Layer 3:** Backend and Customize open a full-screen settings page: a sidebar of pages with its own heading and settings search (HIG Sidebars), and a content pane headed by the page title and description. Page labels are nouns in header capitalisation and of similar length. The HIG asks that, in preferences, one page's controls never change the controls on another page (HIG View Switchers). Deviation: the backend chosen in Connections decides which controls Sampling, Presets, and Formatting show (upstream SillyTavern behaviour).
- **Layer 4:** Page content holds the options for that page.
- **Depth (HIG Navigation, Browsing):** Hierarchies are generally one level deep below a view. A pushed page has its Back control at the top start. Header content updates to match the current view. Secondary windows, sheets, and dialogs never stack on each other.
- **Sidebars and panes (HIG Sidebars, Utility Panes):** A sidebar navigates between locations, such as a conversation list or the list of a List → Split Editor. A utility pane holds tools or details for the main view, such as a settings pane. Both collapse at narrow widths: a sidebar becomes a pushed navigation stack, and a utility pane overlays the content or becomes a page.
- **Active State:** Use a neutral selected fill, with Accent on the icon where it helps. No border, bottom accent stripe, or underline. Never use a thick left or right stripe.
- **Mobile:** Preserve the same destinations, ordering, action names, and shell-control shapes. The settings sidebar becomes a full-width list of pages; choosing one pushes the page with a Back control, as `AdwNavigationSplitView` collapses. Use safe-area-aware sheets, comfortable touch targets, and no hover-only discovery.
- **Adaptive sizes (HIG Scaling & Adaptiveness):** Every layout works from `360×294px` (phone) up; the HIG's smallest supported desktop size is `1024×600px`. Content sits in containers with a maximum width so lines and controls do not spread apart on large windows. Crossing a breakpoint never makes a control or icon disappear without a transition, and the same functions stay available at every width.
- **Desktop:** Keep the existing top-bar actions and chat-navigation rows visible. Users may hide the Guided Generations and Chat Navigation rows in settings; the shell restyle does not change that behavior.

### List → Split Editor
- **Pattern:** SillyBunny-specific pattern built from Libadwaita parts; `AdwNavigationSplitView` collapse rules. Libadwaita sidebars are not user-resizable and no stock widget animates from a full-width list into a split view.
- **Sidebar:** Resizable sidebar `240–420px`, default `30%`; collapse at viewport `≤768px` or Editor pane `<720px`. Collapsed navigation: the editor is a full-screen page with a back button; no sidebar.
- **Sizing:** The editor pane never scrolls. The textarea takes the highest sizing priority: `flex: 1 1 auto; min-height: 0`; it fills the leftover height and scrolls internally.
- **Transition:** Full list → list shrinks to a sidebar while the editor slides in from the right; reverse on close. `SPRING_NAVIGATION` (`334ms`), continuous compression. Clicking another row in the sidebar swaps editor content without replaying the slide, after the dirty check.
- **Reduced motion:** Instant swap for OS `prefers-reduced-motion` or `body.reduced-motion`.
- **Search (HIG Search):** Live as the user types, across the whole collection, with a status page when nothing matches. Every item stays reachable without search.
- **Selection mode (HIG Selection & Edit Modes):** Entered deliberately, and only offered when at least three actions apply to a selection. Clicking anywhere on a row toggles its selection. The header shows Cancel and the number of selected items.

### Message Actions
- **Placement:** Actions sit in the message name row, aligned to the inline end. The name truncates before the actions move. Only the desktop expanded row may wrap.
- **Sizing:** Use `--sb-message-hit-size` for the target and `--sb-message-glyph-size` for the icon. Mobile targets are `44px` (`40px` in compact mode). Swipe arrows keep `--sb-message-icon-size`.
- **Row:** Mobile (`<=768px`) shows Edit, then the message menu button. Desktop shows Copy, Edit, then the message menu button. The menu button is the vertical ellipsis (`fa-ellipsis-vertical`) and is always last.
- **Edit row:** Both widths start with Cancel, then Confirm, followed by the remaining edit actions. Mobile puts those actions behind the message menu button. Desktop shows them inline after a divider: Copy this message, Add a reasoning block, Move up, Move down, then Delete this message last.
- **Expanded row (desktop):** Holding Shift while the pointer is over a message, or while focus is inside one, expands that message's row to show every menu action as icons in menu section order, including Delete, then Copy, Edit, and the menu button. The row stays expanded after Shift is released, so Shift+click shortcuts on its buttons stay optional, and collapses when the pointer leaves the message, focus leaves it, or Escape is pressed. Shift does nothing while focus is in a text field. The menu button tooltip carries the hint "Hold shift to expand." The Expand Message Actions setting keeps every row expanded on desktop and drops the hint. On mobile neither applies. Sections are split by dividers, which are hidden once the row wraps; a row that does not fit beside the name moves below it, end-aligned.
- **Message menu:** Every other action, including checkpoint, Delete, and extension buttons, is a labelled menu row: dimmed icon plus the action's existing title. Rows follow the Menus and Popovers row rules, `44px` on coarse pointers. Sections are split by separators with no headings, in this order: reply actions (Delete + Add Swipe, swipe history, Narrate, Translate, image generation), copy (Copy, Screenshot), chat structure (branch, checkpoint, hide or include), tools (Prompt, agent changes, trackers, companions, card scripts, Embed, media display), other extension buttons, then Delete alone in Destructive Red. Rows that do not apply are omitted, never disabled, except Move up and Move down at the chat edges.
- **Edit menu:** Copy this message and Add a reasoning block, then Move up and Move down, then Delete this message alone in Destructive Red.
- **Surfaces:** On mobile the menu is a bottom sheet with the drawer layer, overlay radius, Dialog Shadow, Dialog Backdrop, sheet spring, safe-area padding, a title with the message's sender and position, and a close button. It traps focus and returns it to the menu button. On desktop it is a popover anchored to the menu button, trailing-aligned, that flips above when there is no room below and stays inside the chat width. Right-click on the name row, Shift+F10, and the Menu key open the same menu. Long-press on message text does not open it, so text selection keeps working.
- **Dismissal:** The menu closes on action, Escape, outside tap, generation start, and chat change; the popover also closes on scroll. Arrow, Home, and End keys move focus between rows.
- **Delete:** Delete always confirms, regardless of the confirm-deletion setting. The confirmation is an alert dialog with Cancel focused by default and the destructive response in Destructive Red; Return never confirms a deletion.
- **Labels:** Icon-only row buttons keep a `title` or `aria-label`. On touch, press-and-hold shows that label as a tooltip without triggering the action.
- **Touch states:** Hover fills apply only under `(hover: hover)`; touch uses `:active` so fills do not stick after a tap.
- **Chat styles:** Every chat style keeps the same row contract. Mirrored user rows (echo, tide) anchor the actions and popover to their start edge, with the menu button on the outer edge.
- **Conversation chrome:** Desktop is a Fractal-style split view: an opaque pals sidebar (`220–280px`) with its own header bar, and a content column with a header bar, search bar, a full-width timeline (`20px` gutters), and a full-width composer. The pals rail, rail title, and search bar use `--sb-conv-sidebar-bg` (`#2e2e32` in Libadwaita dark, `#ebebed` in light); the workspace, content header, and timeline use `--sb-layer-view` so they match Roleplay's chat column and sit darker than the shell top bar; the composer sits on `--sb-layer-bottombar`, as in Roleplay. Sidebar header start is the persona/status button; end is New (`+`) and search. Content header start is the mobile back control and participant avatars; the title button hugs the name and opens the branch menu; end is search, settings (desktop), and overflow. Desktop composer is `[attach] [entry] [selfie, remind, summarize, force reply] [send]`; mobile keeps `[+] [entry] [send]`, with `+` opening Attach, Selfie, Remind, Summarize, and Force reply. Search reveals Main/Pins/Selfies/Files/OOC/Memories chips under the header. Settings is an opaque complementary pane on desktop (a third split-view column that tucks closed) and a pushed page on mobile; boolean rows use switches. Persona and status pickers open downward from the account button; add-DM and group pickers anchor to the New trigger. Rail, header, and composer icon buttons are flat circles. Send is the icon-only suggested-action circle. Pal, persona, status, and add-DM rows use neutral hover and selected fills with no border or lift. Channel chips are flat pills. The workspace, rail, stage, and settings pane are opaque `--sb-layer-*` surfaces with no accent gradient. The pals list stays in recency order by last message; selecting a thread does not move it.
- **Conversation mode:** Messages group on sender change, a 20-minute gap, or a day boundary. Only the first message of a group shows avatar, name, and locale time. Own bubbles are end-aligned with no avatar; others are start-aligned with a reserved 36px avatar slot. Outer bubble corners are `18px`; attached corners are `6px`. Own fill is `--sb-conv-bubble-own-bg`; others use `--sb-conv-bubble-other-bg`. Day dividers sit between calendar days. Reactions are toggleable chips under the bubble. Receipts sit under the last own message of a group. On desktop, an opaque pill toolbar appears on hover or `:focus-within` overlapping the same top-end corner of every bubble with flat `28px` buttons: the quick reactions, a divider, Reply, Edit, Copy, and the message menu button. Own messages do not flip the pill to the other side. Shift and Expand Message Actions expand the pill to every menu action in section order, including Delete. On mobile, a small vertical-ellipsis trigger sits in a trailing gutter beside that same top-end corner with a `44px` hit area and opens the message menu as a bottom sheet. Compact mode applies here as in Roleplay: pill buttons drop to `24px`, and the trigger hit area, sheet rows, reactions, and close button drop to `40px`. The menu sections are: quick reactions, then Reply, Edit, and Polish, then Copy, Pin, and Branch, then Speak and Regenerate, then Delete alone in Destructive Red. Delete confirms with the same alert dialog. The trigger reports `aria-expanded`.

### Signature Surfaces
- **Composer:** The bottom bar stays available for writing, keeps the textarea central, and scales to keyboard and safe-area changes without covering chat. On desktop it joins the bottom chat bar into one toolbar stack on the Bottom bar layer, separated from the chat column by the header bar shade.
- **Welcome Actions:** Home and first-run shortcuts may use a centered icon and text, but they remain sparse, labelled, and helpful rather than decorative.
- **Companion Agent Panel:** A sidecar workspace preserves chat visibility and exposes source context plus regenerate, edit, copy, delete, and manual-run actions without nested modal chains.
- **Paper Texture:** An opt-in grain over the canvas and chat column. It may add texture, but it must take its colours from the active theme and never override border or message tints. Deviation: the HIG advises against text over textures or graphical backgrounds; the grain and chat backgrounds stay opt-in and must still meet the Contrast Rule.

## 7. Do's and Don'ts

### Do:
- **Do** keep main content uninterrupted and let configuration appear only after deliberate input.
- **Do** give every view at most one suggested or destructive button, then place powerful options behind learnable progressive disclosure.
- **Do** preserve SillyTavern-compatible settings, character data, chats, presets, extensions, and migration paths.
- **Do** use `SmartTheme*`, `sb-*`, `color-*`, spacing, and radius tokens so user themes continue to work.
- **Do** keep desktop and mobile gestures, ordering, labels, and action vocabulary consistent.
- **Do** provide visible focus, semantic labels, comfortable touch targets, resilient wrapping, and reduced-motion behavior.
- **Do** use tonal surfaces before shadows and verify text contrast before shipping.
- **Do** make every action possible with the keyboard as well as with a pointer or touch. Custom shortcuts use Ctrl with a letter, never Alt (reserved for access keys) or Super. Esc closes popovers, sheets, and dialogs (HIG Keyboard, Popovers, Windows).
- **Do** test every surface with a high-contrast or forced-colours mode, 200% text size, the keyboard alone, a screen reader, and an on-screen keyboard (HIG Accessibility). Every element has a short, descriptive accessible name.
- **Do** write UI text by the HIG Writing Style: short and neutral, familiar terms over system terms, "your" over "my" when ownership must be stated, no Latin abbreviations ("for example", not "e.g."), and no trailing period on labels, headings, or descriptions. An ellipsis (`…`, U+2026) ends a label only when more input or confirmation follows ("Delete…", not "Preferences…"). Never build one sentence from several strings or controls, so translations stay intact. Use typographic characters: “quotes”, ’ apostrophes, – ranges, × dimensions.

### Don't:
- **Don't** add configuration panels, extra toolbars, or utility panes to the chat viewport unless the user opens them. Navigation sidebars, split views, and utility panes follow the HIG (Navigation): each view keeps one clear subject, and panes collapse or overlay at narrow widths.
- **Don't** create a nested menu spiral: no nested submenus, and hierarchies generally one level deep below a view (HIG Menus, Navigation).
- **Don't** present configuration sprawl, bottom bar bloat, or a dense control wall by default.
- **Don't** interrupt active conversation with a modal for non-critical configuration; try inline or progressive alternatives first.
- **Don't** rely on mystery meat navigation, hover-only discovery, desktop-only assumptions, tiny touch targets, or fragile iOS WebKit behavior.
- **Don't** use generic SaaS polish, sterile upstream-clone blandness, or decorative motion without navigational purpose.
- **Don't** use gradient text, decorative glassmorphism, backdrop blur on shell layers, ambient accent glows, repeating stripe or grid backgrounds, identical repeated card grids, or sketchy illustrations.
- **Don't** use `border-left` or `border-right` greater than `1px` as a colored accent.
- **Don't** pair a `1px` border with a shadow of `16px` blur or more on a resting surface. Overlays may keep one border and one overlay shadow.
- **Don't** use uppercase tracked kickers for group or list headings, or hover lift on buttons.
- **Don't** rely on tooltips, hover, or colour alone to carry essential information.
- **Don't** use radii above `20px` for cards or sections, or let long labels and headings overflow narrow viewports.
- **Don't** introduce new pure black or pure white surfaces, or silently overwrite compatible user configuration.
