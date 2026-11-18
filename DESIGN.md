---
name: SillyBunny
description: An LLM frontend designed for roleplay and storywriting that stays out of the user's way until called for.
colors:
  accent: "#b1e2ff"
  accent-soft: "#9ab9cd"
  on-accent: "#000000"
  view: "#1d1d20"
  window: "#222226"
  window-canvas: "#2e2e32"
  headerbar: "#2e2e32"
  bottombar: "#2e2e32"
  drawer: "#2e2e32"
  popover: "#36363a"
  dialog: "#36363a"
  toast: "#505053"
  card-fill: "#343437"
  panel-raised: "#38383c"
  panel-hover: "#434347"
  foreground: "#ffffff"
  dim-foreground: "#9c9c9d"
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
    fontSize: "calc(var(--mainFontSize) * 1.36)"
    fontWeight: 800
    lineHeight: 1.18
    letterSpacing: "0"
  title:
    fontFamily: "Adwaita Sans, system-ui, Noto Sans, sans-serif"
    fontSize: "var(--mainFontSize)"
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
    fontSize: "calc(var(--mainFontSize) * 0.82)"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "0"
  caption:
    fontFamily: "Adwaita Sans, system-ui, Noto Sans, sans-serif"
    fontSize: "calc(var(--mainFontSize) * 0.82)"
    fontWeight: 400
    lineHeight: 1.4
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
  inner: "6px"
  pill: "999px"
spacing:
  "2xs": "3px"
  xs: "6px"
  sm: "9px"
  md: "12px"
  lg: "18px"
  xl: "24px"
  "2xl": "36px"
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
    rounded: "{rounded.control}"
    padding: "10px 14px"
    height: "38px; 44px on coarse pointers"
  button-secondary:
    backgroundColor: "color-mix(in srgb, {colors.foreground} 10%, transparent)"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    padding: "10px 14px"
    height: "38px; 44px on coarse pointers"
  button-suggested:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.pill}"
    size: "38px; 44px on coarse pointers"
  input-field:
    backgroundColor: "{colors.window}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    padding: "12px"
    height: "46px"
  shell-tab-active:
    backgroundColor: "color-mix(in srgb, {colors.foreground} 10%, transparent)"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
    height: "44px"
  card-surface:
    backgroundColor: "color-mix(in srgb, {colors.foreground} 8%, transparent); View in light tone"
    textColor: "{colors.foreground}"
    rounded: "{rounded.card}"
    shadow: "Card Shadow"
    padding: "14px"
  pref-group:
    backgroundColor: "color-mix(in srgb, {colors.foreground} 8%, transparent); View in light tone"
    textColor: "{colors.foreground}"
    rounded: "{rounded.card}"
    shadow: "Card Shadow"
    padding: "0; rows 6px 12px, at least 50px"
  popover-surface:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.overlay}"
    padding: "6px for a menu list; 8px for any other popover"
  menu-row:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "32px"
  toast:
    backgroundColor: "{colors.toast}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.pill}"
    padding: "8px 12px"
  chip-enabled:
    backgroundColor: "color-mix(in srgb, {colors.accent} 16%, transparent)"
    textColor: "{colors.foreground}"
    rounded: "{rounded.pill}"
    padding: "6px 8px"
  shell-navigation-control:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    minimumHeight: "44px on coarse pointers; 32px on fine pointers"
  shell-icon-control:
    backgroundColor: "color-mix(in srgb, {colors.foreground} 10%, transparent)"
    textColor: "{colors.foreground}"
    rounded: "{rounded.pill}"
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
    backgroundColor: "color-mix(in srgb, {colors.foreground} 15%, transparent)"
    textColor: "{colors.accent}"
    rounded: "{rounded.pill}"
    height: "4px trough; 18px thumb"
  floating-entry-row:
    backgroundColor: "var(--sb-composer-input-bg); suffix outside the field"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    padding: "1.45em 12px 0.25em inside the field; 1.05em at the top in compact"
    minimumHeight: "var(--sb-field-min-height)"
  toggle-row:
    backgroundColor: "transparent; selected segment var(--sb-flat-selected-bg)"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    minimumHeight: "44px segments on coarse pointers"
  select-mirror-row:
    backgroundColor: "transparent; whole-row flat hover and active fills"
    textColor: "{colors.foreground}"
    padding: "6px 12px"
  list-row:
    backgroundColor: "color-mix(in srgb, {colors.foreground} 8%, transparent); View in light tone; neutral hover and selection fills"
    textColor: "{colors.foreground}"
    rounded: "{rounded.card}"
    shadow: "Card Shadow"
    minimumHeight: "52px"
  selection-mode-header:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control} on response buttons"
  toggle-group:
    backgroundColor: "color-mix(in srgb, {colors.foreground} 10%, transparent); selected toggle rgb(255 255 255 / 20%) on the dark tone, #ffffff on the light tone"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}; toggles 6px"
    padding: "3px; toggles 0 8px"
    minimumHeight: "28px toggles, raised to the target floors: 32px with a fine pointer, 44px on coarse pointers"
  banner:
    backgroundColor: "color-mix(in srgb, {colors.foreground} 10%, {colors.window})"
    textColor: "{colors.foreground}"
    padding: "6px"
  status-page:
    textColor: "{colors.foreground}"
    padding: "36px 12px; 24px 12px compact and spinner"
    size: "icon 128px; 96px compact; spinner 64px"
  tooltip:
    backgroundColor: "color-mix(in srgb, {colors.shadow-ink} 80%, transparent)"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    padding: "6px 10px"
  keycap:
    backgroundColor: "color-mix(in srgb, {colors.foreground} 10%, transparent)"
    textColor: "{colors.foreground}"
    rounded: "6px"
    padding: "6px"
    minimumWidth: "20px"
  spinner:
    textColor: "{colors.foreground}"
    size: "16px to 64px; stroke one eighth of the size"
---

# Design Reference Documentation

- **GNOME HIG**: https://developer.gnome.org/hig/guidelines.html
- **GNOME Design Patterns**: https://developer.gnome.org/hig/patterns.html
- **GNOME HIG Reference** (keyboard shortcuts, palette, backgrounds): https://developer.gnome.org/hig/reference.html
- **GNOME Design Principles**: https://developer.gnome.org/hig/principles.html
- **libadwaita documentation** (stable): https://gnome.pages.gitlab.gnome.org/libadwaita/doc/1-latest/

**Reference version:** libadwaita 1.10.0 (stylesheet checked 2026-11-12); GNOME HIG at commit `97028ea` (2026-06-20). Where SillyBunny deviates, the deviation is stated next to the value. `DESIGN.md` is authoritative; `DESIGN.json` is its companion and follows it.

SillyBunny follows the HIG unless a rule below says otherwise. Every departure is marked **Deviation:** next to the rule it affects, and says what the reference does, what SillyBunny does, why, and when to review it.

This document states patterns, roles, and conditions, never one feature of the application. Rules that describe a single feature are in [docs/feature-design-rules.md](docs/feature-design-rules.md).

# Design System: SillyBunny

## 1. Overview

**"Simple by default, powerful when needed"**

SillyBunny is an LLM roleplay client that best embodies the HIG (human interface guidelines) of the GNOME project. Although great inspiration is taken from this project, SillyBunny still stands on its own with its own personality and branding based on its focus on roleplay and storywriting. The shell is deliberately kept out of the way so the user can focus on the main content until configuration and navigation are needed.

Intuitive wording, tactile and easily glanceable feedback, and deliberate purpose define the shell. Complex configuration remains available to the user if they wish to seek it (as per upstream SillyTavern), but a good default experience is mandatory and implied - the goal is for a new user to navigate the shell with minimal to no difficulty. Configuration remains behind the shell at all times until called for. All elements of the shell must remain themeable with user CSS themes, and be fully compatible with SillyTavern data, presets, extensions, and settings.

The design philosophies of the GNOME project and its HIG should always be taken into consideration. This means accessibility through lack of distractions, animations that guide the user to what is clicked/tapped, responsive layouts, predictable touch targets, and nothing getting in the way of the main user experience. Mobile design must remain purposefully designed alongside the desktop, adapting libadwaita to a smaller and more touch-heavy window.

With this in mind, SillyBunny can inject its own fun in the design too. After all, it is a roleplay and storywriting client at heart.

This project rejects UI creep, nested menu spirals, configuration sprawl, screen bloat, mystery meat navigation, desktop-only assumptions, and generic SaaS polish.

**Key Characteristics:**
- Content-first main area with no unsolicited permanent configuration panels.
- Familiar controls that disclose depth through deliberate input, not visual noise.
- Guided animations that promote accessibility and intuitive motion.
- Stable desktop and mobile interaction vocabulary, safe shell behaviour for WebKit, Gecko, and Chromium browsers.
- Personality expressed through usefulness.

## 2. Colours

The palette is a neutral base for customisation and exploration: the accent dictates user interaction. Values follow the libadwaita dark style (the bundled Libadwaita theme); Libadwaita Light maps the same roles onto the libadwaita light style. Every role below is derived from the user's theme colours, so the hex values describe the bundled Libadwaita theme only.

Deviation: the HIG asks an app to follow the system's light or dark style; SillyBunny applies the theme the user saved and defaults to the dark bundled theme, because themes are user data and the app has no system-following mode. Review when the app gains a mode that follows the system's style.

### Primary
- **Accent** (`#b1e2ff` dark, `#16508b` light): `--sb-accent`, a 62/38 mix of the theme quote colour and body colour. The bundled quote colour is `#81d0ff` (dark) and `#0461be` (light). Used for suggested actions, checked checkboxes and radios, the range thumb, and the selected-item icon. Use it as a signal, never as ambient ornament.
- **On Accent** (`--sb-on-accent` / `--sb-on-solid-accent`): Text and glyphs on a solid accent fill. Black on the bundled dark theme and white on the bundled light theme. Deviation: libadwaita always uses white on `#3584e4` (about 3.8:1); SillyBunny picks the ink that reaches 4.5:1, because text on a solid accent fill must stay readable. Review when libadwaita changes this value.
- **Soft Accent** (`#9ab9cd` dark, `#395e86` light): Secondary accent for quiet helper states and badges. Selected backgrounds use neutral fills, not Soft Accent.
- **Link:** A link is Accent and underlined. Visited, it is Accent mixed 80% with the View ink; on hover its saturation and lightness are each multiplied by `1.1`; pressed, it returns to Accent; disabled, it takes the disabled strength. On a dark overlay (a tooltip, a toast) a link is Accent mixed 50% with white, visited 75%. The underline stays, so a link never relies on colour alone.
- **Text selection:** Selected text sits on the View ink at 10%; in the field that has focus it sits on Accent at 30%. Existing links and text selections move to these values as each surface is rebuilt.

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
| Content surface (desktop) | `--sb-chat-view-bg` | View at the tint's own alpha, `min(1, alpha / 0.9)` | `#1d1d20` (0.9 maps to opaque) | `#ffffff` (0.9 maps to opaque) | `view-bg` |
| Window (also Dialog and Window overlays) | `--sb-layer-window` | `--SmartThemeBlurTintColor` | `#222226` | `#fafafb` | `window-bg` |
| Page | `--sb-page-bg-source` | BlurTint 88% + Body 12% (light 86/14) | `#3f3f43` | `#dcdcdd` | none (window background behind the content) |
| Canvas | `--sb-layer-canvas` | BlurTint 95% + Body 5% (light 93.3/6.7) | `#2e2e32` | `#ebebed` | `sidebar-bg` |
| Header bar | `--sb-layer-headerbar` | Same as canvas; light uses ChatTint | `#2e2e32` | `#ffffff` | `headerbar-bg` |
| Bottom bar | `--sb-layer-bottombar` | Same as canvas; light uses ChatTint | `#2e2e32` | `#ffffff` | `headerbar-bg` |
| Shell drawer | `--sb-layer-drawer` | Same as header bar; light uses BlurTint | `#2e2e32` | `#fafafb` | `headerbar-bg` / `dialog-bg` |
| Popover | `--sb-layer-popover` | BlurTint 91.8% + Body 8.2%; light uses ChatTint | `#36363a` | `#ffffff` | `popover-bg` |
| Alert | `--sb-layer-dialog` | Same as popover; light uses BlurTint | `#36363a` | `#fafafb` | `dialog-bg` |
| Toast | `--sb-layer-toast` | BlurTint 81% + Body 19%; light uses Body 86% + white 14% | `#505053` | `#505053` | toast `#505053` |

A layer that names a libadwaita role renders that role's colour on the bundled themes. A layer with no role keeps the value its mix gives on the bundled themes; their BlurTint and ChatTint carry 0.9 alpha, which `color-mix()` takes into account before the layer is forced opaque, so such mixes come out a few steps lighter than the same mix of opaque colours (checked in Chromium, 2026-10-19). The mixes of the layers with a role are chosen for that alpha.

- **The content surface** is the raw chat tint on mobile (upstream's rule) and `--sb-chat-view-bg` on desktop, so the bundled 0.9 tints stay opaque and lower tints show the background. The window background behind the content mixes BlurTint toward Body, so the main window stays distinct from the canvas in every theme.
- **Bars:** a bar is flat and recedes, so messages and lists carry the visual weight; do not raise it into a heavier, toolbar-style band. The top bar uses Header bar, and the composers and bottom bar use Bottom bar, which takes the header bar fill as libadwaita's bottom bars do. Where two layers share a colour, as a bar and the View do in the light tone, the `1px` shade line separates them, as in libadwaita.
- **Overlays:** shell drawers continue the top bar and separate from the view by tone and one overlay shadow. Popovers, menus, and alerts use the Popover and Alert layers, a step lighter than the Canvas in the dark tone; dialogs and windows use the Window layer, as `AdwDialog` does. Each separates from what is behind it by its edge and overlay shadow. In the light tone these layers are the lightest and rely on that edge and shade.
- **Raised Panel** (`#38383c`) and **Hover Panel** (`#434347`) are `--sb-raised-bg` (10%) and `--sb-raised-hover-bg` (15%) over Window. Raised Panel is a control fill, not a layer.
- **Foreground** (`#ffffff`) and **Dim Foreground** (`#9c9c9d`, `--sb-muted-fg`): 55% of the body colour on the dark tone, as libadwaita's `.dimmed`, and 74% on the light tone (see Typography). Under `prefers-contrast: more` dim text is 90% on both tones. Dim text is never the sole carrier of meaning.
- **Strengths:** Lines, dimmed content, disabled controls and troughs are the body colour at a fixed strength, so they follow every theme. Each value has a stronger one under `prefers-contrast: more`. These are libadwaita's values unless a deviation says otherwise. Existing surfaces move to the high-contrast strengths as each surface is rebuilt.
- **Border and separator:** `1px`, 15%; under `prefers-contrast: more`, 50% of the body colour, as libadwaita draws it. Deviation: libadwaita draws a border as the text colour at this strength; SillyBunny draws it in the theme's border colour at the normal contrast, because the border colour is part of the user's theme (The Theme Alias Rule). Review when libadwaita changes this value.
- **Disabled:** 50% opacity; under `prefers-contrast: more`, 40%, so a disabled control stays distinct from the stronger enabled one. An icon or label inside an already faded control (a toggle, the edit icon of an entry row) fades again to 30%.
- **Quiet marks:** Indicators and separators inside menus are 30%; under `prefers-contrast: more`, 80%.
- **Trough:** 15%, 20% on hover, 25% pressed; under `prefers-contrast: more`, 30%, 40% and 50%. The outline of a checkbox or radio is a `2px` ring at the trough strength; under `prefers-contrast: more` it takes the border strength.
- **Window outline:** a dialog or sheet edge is a `1px` ring of white at 7%; under `prefers-contrast: more`, 30%.
- **Shadow Ink** (`#000006`): Shade and shadow tint only. Never a text colour.
- **Texture:** An opt-in texture or background image over the canvas and content surface. It takes its colours from the active theme and never overrides border or message tints. Deviation: the HIG advises against text over textures or graphical backgrounds; SillyBunny allows an opt-in texture or background image, because the user chooses it and it must still meet the Contrast Rule. Review when the HIG changes this advice.

### Named Rules
**The Signal Scarcity Rule.** Accent appears for action, selection, focus, or meaningful state. If removing it does not reduce comprehension, remove it.

**The Theme Alias Rule.** New work consumes `SmartTheme*`, `color-*`, `sb-*`, spacing, and radius aliases. Do not hard-code a new color that bypasses saved user themes. `white` and `black` may be mixed into a theme colour with `color-mix()` to lighten or darken it, as libadwaita's stylesheet does; there they are operands, not colours of their own. Deviation: the HIG asks for style variables rather than fixed colours; SillyBunny lets an illustration's backdrop keep its own colour in every theme, because the backdrop belongs to the artwork. It is dropped under forced colours and is never used for anything but the illustration. Review when the HIG changes this advice.

**The Contrast Rule.** Body and placeholder text target at least 4.5:1 contrast; large text targets at least 3:1. Muted text can be quiet, but never illegible. Colour is never the only carrier of information; pair it with text, an icon, or shape (HIG UI Styling). Surfaces stay usable under `prefers-contrast: more` and `forced-colors: active`.

**The Opaque Shell Rule.** Header bars, drawers, popovers, menus, dialogs, and toasts are opaque. No `backdrop-filter` on shell layers; background images may show only through the canvas and the content surface at the theme's own tint alpha. Tooltips and overlaid controls are the two translucent exceptions.

**The Single Shell Rule.** The shell has one libadwaita direction; UI themes, custom CSS, and the accent colour are the theming surface.

## 3. Typography

**Interface Font:** Adwaita Sans, then `system-ui`, Noto Sans, and the platform sans stack (`--mainFontFamily`).

**Mono Font:** Adwaita Mono for code-like, structured, or machine-readable text (`--monoFontFamily`).

**Character:** One dependable sans keeps all interface text in the same voice. Weight and size create hierarchy. libadwaita uses no letter-spacing, and neither does SillyBunny's interface text. Interface chrome avoids italic and oblique faces (HIG Typography); italics in chat messages are user formatting and are unaffected.

### Hierarchy
| Role | Token | Weight | Size | Line | libadwaita |
|---|---|---|---|---|---|
| Display | `--sb-type-display` | 800 | 1.81 | 1.12 | `.title-1` |
| Headline | `--sb-type-headline` | 800 | 1.36 | 1.18 | `.title-2` |
| Title | `--sb-type-title` | 700 | 1.0 | 1.18 | `.heading` |
| Body | `--sb-type-body` | 400 | 1.0 | 1.55 | `.body` (1.4) |
| Label | `--sb-type-caption` | 700 | 0.82 | 1.35 | `.caption-heading` |
| Caption | `--sb-type-caption` | 400 | 0.82 | 1.4 | `.caption` |
| Mono | `--monoFontFamily` | 400 | 0.84 | 1.45 | `.monospace` |

- **Display:** The one large heading of a welcome or first-run page; never a control label.
- **Headline:** Major page and opened-panel headings.
- **Title:** Group headings, shell titles, and header bar titles.
- **Body:** Long-form and settings prose, and the titles of rows in boxed lists, at regular weight, as a libadwaita row title. Deviation: libadwaita's `.body` line height is 1.4; SillyBunny uses 1.55, because long-form reading needs it. Review when libadwaita changes this value. Keep prose near 65-75ch where the surface permits.
- **Document:** The main content of a view, such as the text of an article or a book, is document text. libadwaita sets it in the document font, which raises the font size and the line height to make long text easier to read (example `12pt`, line height 140%; `.document`); other long text in the interface is Body. In SillyBunny document text is Body at the user's text size (`--mainFontSize`), and the Body line-height deviation applies to it.
- **Numeric figures:** Numbers that change or line up in a column (counts, times, progress text, a column of values) use tabular figures (`font-variant-numeric: tabular-nums`), so the width of a number does not change as its digits do.
- **Label:** Compact metadata and state labels; capitalisation follows the Capitalisation Rule. Dimmed labels use `--sb-muted-fg`, the equivalent of `.dimmed`: 55% of the body colour on the dark tone, as libadwaita, and 74% on the light tone. Deviation, light tone only: libadwaita's `.dimmed` is 55%; SillyBunny uses 74%, because 55% gives 3.2:1 there, under 4.5:1. Review when libadwaita changes this value.
- **Caption:** Row subtitles and help captions; sentence capitalisation. It shares the size token of Label and is dimmed in the same way.

Existing rows and titles move to these roles as each surface is rebuilt.

### Named Rules
**The Interface Sans Rule.** Use the interface stack for controls, tabs, labels, and dense settings. Decorative type must never make repeated work harder.

**The User Scale Rule.** Product type follows `--mainFontSize` and existing user preferences. Do not add viewport-driven type or a parallel density system.

**The Wrap Safety Rule.** Headings use balanced wrapping where supported, and all labels must tolerate long translations, zoom, and narrow mobile widths without overflow.

**The Capitalisation Rule.** Follow the HIG Writing Style.
- **Header capitalisation** for headings (group, list, page, sheet, and dialog titles), header bar and view titles, view switcher and tab labels, button labels, menu items, tooltips, field labels, and the titles of rows in boxed lists (switch, combo, entry, spin, action, and button rows). Capitalise the first and last word, nouns, verbs, hyphenated words, and every word of four or more letters: "Find and Replace", "Self-Test", "Document Cannot Be Found".
- **Sentence capitalisation** for checkbox and radio labels, drop-down items, placeholders, row subtitles, captions, and body text in dialogs, banners, toasts, and status pages.
- Headings omit articles and auxiliary verbs ("Three Documents Updated"). An informal heading written as a full sentence uses sentence capitalisation and stays bold.
- Never all caps, and no uppercase tracked kickers.
- Group headings are bold (`.heading`) and carry no icon, as libadwaita's group titles.
- Deviation: the HIG Writing Style, Drop-Down Lists and Spin Buttons pages ask for sentence capitalisation on field, drop-down and spin-button labels, while the Text Fields and Switches pages ask for header capitalisation; SillyBunny uses header capitalisation for every field label and boxed-list row title, because a group then reads consistently, as GNOME apps commonly do. Review when the HIG resolves this conflict.
- Upstream SillyTavern strings keep their upstream wording and `data-i18n` keys. Existing sentence-case SillyBunny labels move to this rule as each surface is reworked.

## 4. Layout

- **Adaptive sizes (HIG Scaling & Adaptiveness):** Every layout works from `360×294px` (phone) up; the HIG's smallest supported desktop size is `1024×600px`. Content sits in containers with a maximum width so lines and controls do not spread apart on large windows; groups and lists have a minimum and a maximum width. Crossing a breakpoint never makes a control or icon disappear without a transition, and the same functions stay available at every width.
- **Breakpoints:** Alerts, Dialogs and Windows become bottom sheets at `max-width: 450px` or `max-height: 360px`, the AdwDialog condition (the overlay breakpoint). Menus and pickers become sheets in the whole mobile layout, at `max-width: 768px` or `max-height: 360px`, so a menu opened in the mobile layout is never a desktop popover. The shell layout breakpoint is `768px`, because libadwaita leaves layout breakpoints to each app. A mobile-only surface whose trigger exists only in the `768px` layout keeps its sheet tied to that breakpoint. Deviation: libadwaita writes breakpoints in `sp`, which follows the system's text scale; SillyBunny writes them in `px`, because a media query cannot read the application's text size setting, so a text-scaled unit would follow only the browser's default size. Review when a media query can read a custom property. Implementation: [docs/dialogs.md](docs/dialogs.md#breakpoints).
- **Touch targets:** Every interactive control is at least `44px` on coarse pointers and at least `32px` on fine pointers. The size and the set of controls shown follow `(pointer: coarse)`, never the viewport width. Where this document quotes a libadwaita size that is under a floor, that is the drawn size of the control, and its target still meets the floor. Deviation: libadwaita controls are `34px`; SillyBunny uses at least `44px` on coarse pointers, because fingers need larger targets. Review when libadwaita changes this value.
- **Icons (HIG UI Icons):** Interface icons are symbolic: simple, monochrome, drawn on a `16px` grid and recoloured with the text colour. Use them at `16px`, or at `32px`, `64px` and `128px` where the icon is the focus of attention; avoid other sizes, which render fuzzy. A compact status page's `96px` icon is libadwaita's own exception. A large icon uses a heavier stroke (libadwaita weight `134`, `267` for a spinner). Status icons take the status colours of the icon palette: success, warning, error and Accent. A control shows an icon or a label, not both (Buttons); sidebars and view switchers are the exception. Use only icons users recognise, such as search, menu, back, forward and share. Some icons are recognised only as a set: a stop square needs play and pause beside it, a remove line needs an add. Deviation: GNOME uses symbolic icons drawn on a `16px` grid; SillyBunny uses the Font Awesome glyph set, sized by the text around it, because upstream markup and extensions use that set. Review when the icon set is replaced.
- **Density:** Compact mode (`--sb-density-scale`) reduces row heights, padding, and targets without changing hierarchy, and never goes under the target floors above. Containers pad `12px`, and `9px` in compact mode (`--sb-density-container-padding`).
- **Spacing:** The spacing scale is `3`, `6`, `9`, `12`, `18`, `24`, and `36px` (front matter `spacing`; `--spacing-2xs` to `--spacing-2xl`), libadwaita's rhythm. New and rebuilt surfaces use the scale. A measure in these documents that is off the scale is an existing one, and moves to the scale when its component is rebuilt.
- **Mobile:** Preserve the same destinations, ordering, action names, and control shapes as desktop. Use safe-area-aware sheets, comfortable touch targets, and no hover-only discovery. Controls stay usable with the software keyboard open.
- **Pointer (HIG Pointer & Touch):** The primary action activates, opens or selects. The secondary action (right-click, long press) opens a context menu (see Menus and Popovers, Secondary and context menus). Esc cancels a pointer operation in progress, such as a drag. Avoid double-click and chording. Text never names a device ("move the mouse"). Controls that exist only for some pointing devices are never the only way to do something.

### Named Rules
**The WebKit Reliability Rule.** Prefer solid surfaces on mobile. Fixed layers must respect safe areas, keyboard resizing, scrolling, and focus behavior in Safari/WebKit.

**The Layer Order Rule.** Layers stack in this order, lowest to highest: dropdown, sticky, shell, overlay, modal, toast. A new layer takes the place of the kind it is and never sits above a toast.

## 5. Elevation

SillyBunny uses tonal layering first and restrained shadows second. The main content surface stays visually calm. A shadow is reserved for a card or group at rest (the Card Shadow), an opened shell, or an overlay that must sit above the content. Overlays (sheets, drawers, dialogs) keep a `1px` border with one overlay shadow; a popover's edge is a `1px` ring inside its shadow, not a border (libadwaita 1.10).

### Shadow Vocabulary
All shadows mix `--SmartThemeShadowColor`, so themes control the ink.
- **Header bar shade** (`--sb-headerbar-shade`): a `1px` line at the edge of a bar. No blurred shadow.
- **Card Shadow** (`--sb-shadow-card`, with the card fill `--sb-card-fill`):** libadwaita's card style for a card or group at rest: a `1px` ring at 3% and two soft shadows, `0 1px 3px 1px` at 7% and `0 2px 6px 2px` at 3%, all in the shade colour. Under `prefers-contrast: more` the ring takes the border colour. A card has no separate border. Existing cards and groups move to it as each surface is rebuilt.
- **Popover Shadow** (`--sb-shadow-popover`): `0 1px 5px 1px` and `0 2px 14px 3px` at low shade alpha, inside a `1px` ring (`0 0 0 1px` at 5%), not a border. Menus, dropdowns, pickers, and search results. Existing popovers move to the ring as each surface is rebuilt.
- **Dialog Shadow** (`--sb-shadow-dialog`): `0 0 14px 2px` and `0 0 5px 2px` at low shade alpha, plus the `1px` border and, in dark mode, a `1px` inner highlight. Dialogs and shell drawers.
- **Dialog Backdrop** (`--sb-dialog-backdrop`): shade colour at about 50% (dark) or 14% (light). No backdrop blur.
- **Toast Shadow** (`--sb-shadow-toast`): `0 1px 3px 1px` and `0 2px 6px 2px` at low shade alpha.
- **Page Transition Shade:** while one page slides over another in a page stack, the covered page dims under shade colour that deepens as it is covered, to about half the Dialog Backdrop (25% dark, 7% light), and the sliding page casts a soft `56px` shadow from its leading edge. Both exist only while the page moves; no page carries them at rest, and reduced motion, which removes the slide, removes them too. This is libadwaita's navigation transition shade. Deviation: libadwaita keeps the Dialog Shadow while a page slides; SillyBunny drops it from the dialog surface and restores it when the motion ends, because repainting the blurred shadow on every frame of the dialog's height change stalls WebKit. Review when WebKit's repainting of blurred shadows changes.
- **Focus Ring** (`--sb-focus-ring-inset`: `inset 0 0 0 2px` of `--sb-focus-ring-color`): The focus treatment for buttons, tabs, and menu rows. Fields draw the same colour as their border plus a `1px` inset, which reads as the same `2px` ring (see Text Fields). Do not stack it with an outline or an outer ring. A button with a solid fill (a suggested or destructive action, the send button) and a control on a picture (an avatar) draw the ring outside instead, as libadwaita draws it for opaque and on-image buttons: a `2px` outline in `--sb-focus-ring-color` with a `1px` gap, and no inset ring. Inside a toast, which is dark in both tones, the ring takes a light form of the accent, as libadwaita's toast does. Checkboxes, radios, and ranges use a `2px` `--sb-focus-ring` outline with an offset instead. Under forced colours every focused element also draws a `Highlight` outline, because forced colours remove shadows. Deviation: libadwaita's ring is 50% of its accent colour; SillyBunny's is about 55% on the dark tone and about 66% on the light tone, because 55% gives about 2.5:1 on the light tone and 3:1 is the target. Review when libadwaita changes this value.
  The ring is drawn in Accent, as libadwaita's.
  Deviation: libadwaita draws the ring of checkboxes, radios, and ranges inside the control; SillyBunny draws it outside with an offset, because the ring then stays visible around a small control. Review when libadwaita changes this rule.
- **Drop Target:** An element that accepts a drop draws Accent as an inset `2px` ring when it is a button, and `1px` for any other element, with no change of fill. A whole drop area, such as a thumbnail or a drop zone, takes a `2px` ring at 40% Accent and a 10% Accent fill. Every drag-and-drop action has a keyboard route, and Esc cancels a drag (HIG Keyboard, Pointer & Touch). Existing drop targets move to this rule as each surface is rebuilt.

### Flat Fill Vocabulary
Flat and raised controls use fills mixed from `--SmartThemeBodyColor`, so they follow light and dark themes without a new color. These are libadwaita's values.
- **Flat:** transparent at rest; `--sb-flat-hover-bg` (7%), `--sb-flat-active-bg` (16%), `--sb-flat-selected-bg` (10%), and `--sb-flat-selected-hover-bg` (13%).
- **Raised:** a secondary button is a raised button: `--sb-raised-bg` (10%) at rest, `--sb-raised-hover-bg` (15%) on hover, and `--sb-raised-active-bg` (30%) when pressed.
- **Boxed rows:** A row that activates fills 3% on hover and 8% when pressed. Rows are separated by a `1px` line in the shade colour; under `prefers-contrast: more` the line takes the border strength. Existing rows move to these fills as each surface is rebuilt.
- **Sidebar rows:** The flat fills apply, and a selected row that is pressed fills 19%. Under `prefers-contrast: more`, hover, pressed and selected rows add a `1px` ring at the border strength.
- **List-view rows:** Hover 4% and pressed 8% of the body colour. A selected row fills Accent at 25%, 32% on hover and 39% pressed; under `prefers-contrast: more` it adds a `1px` ring at the border strength.
- **Trough:** the range trough and the switch's off trough are 15%.
- **Toolbars:** Bars are separated by a `1px` shade line only. A busy state may use an accent border and a progress bar; no glow.

### Named Rules
**The Layer Before Shadow Rule.** Establish a tonal surface before adding elevation. If a shadow is doing all the work, the surface token is wrong.

**The Flat Toolbar Rule.** Toolbar and navigation buttons are transparent at rest. Hover, press, and selection use neutral fills mixed from the body color, with no borders, bottom stripes, underlines, glows, or hover lift. Hover fills apply only under `(hover: hover)`.

## 6. Shapes

Nothing is larger than `18px`, except pills and circles.

- **Control** (`--sb-radius-control`, `9px`, libadwaita `$button_radius`): controls in bars (destinations, section triggers, Back, actions, and fields in a bar), as libadwaita's header bar buttons, plus menu and search result rows, tooltips, and segments. Back and section buttons are flat. Existing bar controls move to this radius as each surface is rebuilt.
- **Card** (`--sb-radius-card`, `12px`, libadwaita's card radius): groups inside editors, dialogs, windows, and side panels, and the boxed rows of list sidebars.
- **Overlay** (`--sb-radius-overlay`, `15px`): popovers, menus, dialogs, windows, shell drawers, and bars that float over content. Bottom sheets round their top corners only. Docked side panels are square.
- **Alert** (`--sb-radius-alert`, `18px`): alert dialogs.
- **Pill** (`999px`): a primary text button in open space (HIG Buttons). A circle is for Close, which has a tonal fill, and for an icon-only suggested action.
- **Toast** (`999px`): a pill, as libadwaita's toast (`150px`).
- **Content:** content buttons, fields, and icon-only content controls take the Control radius; content cards and preference groups take the Card radius. The older names `--sb-radius-button`, `--sb-radius-sm`, `--sb-radius-md`, `--sb-radius-lg`, `--sb-radius-xl`, and `--sb-shell-control-radius` remain as aliases of these two for existing rules and user CSS.
- **Inner** (`--sb-radius-inner`, `6px`): a small part inside a control or a row, such as a keycap or the title of an expander, as libadwaita's.
- **Small controls:** checkboxes are rounded squares (radius `30%` of their size); radios, switches, and selection-mode checks are round.

## 7. Motion

Motion shows where something came from and where it went. It never delays a task.

### Tokens
| Token | Value | Use | libadwaita |
|---|---|---|---|
| `--sb-transition-fast` | `200ms` `--sb-ease-out-quad` | Hover, press, focus, selection, colour and fill changes | `$button_transition`, `$focus_transition` |
| `--sb-transition` | `250ms` `--sb-ease` | Reveals, expanders, height changes, banners | GtkRevealer, AdwExpanderRow |
| `--sb-transition-slow` | `300ms` `--sb-ease` | Toasts and large surface fades | AdwToast |
| `--sb-duration-fast`, `--sb-duration-normal`, `--sb-duration-slow` | `200ms`, `250ms`, `300ms` | The durations of the three transitions alone, for a delay or a property whose easing is set elsewhere | |
| `--sb-ease-out-quad` | `cubic-bezier(0.25, 0.46, 0.45, 0.94)` | State changes | `$ease-out-quad` |
| `--sb-ease` | `cubic-bezier(0.25, 0.1, 0.25, 1)` | Timed animations | `ADW_EASE` |
| `--sb-ease-out-cubic` | `cubic-bezier(0.33, 1, 0.68, 1)` | Exits and fades | ease-out-cubic |

Springs are sampled from libadwaita's AdwSpringAnimation into CSS `linear()` easings, with a cubic-bezier fallback where `linear()` is unsupported (Safari before 17.2). `public/scripts/sillybunny-motion.js` owns the JS presets.
- **Dialog spring** (0.62, 1, 500): about 510ms, peak 1.08. This is the only spring with a pronounced overshoot.
- **Sheet spring** (0.8, 1, 400): about 470ms, near-critical.
- **Navigation spring** (1, 1, 1000): about 330ms, critically damped.
- **Closing** uses the clamped spring or `--sb-ease-out-cubic` and never overshoots.

### By Pattern
- **Overlays:** Alert and Dialog open with the Dialog spring, scaling `0.8 → 1` and fading from the centre, and close clamped over 200ms to scale `0.9`. A Window opens with the Sheet spring (`0.96 → 1`) and fades to `0.98` over 200ms. Shell drawers use the Sheet spring with a fade and scale `0.96 → 1` from the trigger, and close with a 200ms fade and scale to `0.98`. Bottom sheets slide up with the Sheet spring and down to close. The backdrop fades with the surface.
- **Popovers and menus:** 200ms fade and scale `0.96 → 1` from the trigger edge; close is a 150ms fade. Deviation: GTK4 popovers do not animate; SillyBunny fades and scales them from the trigger edge, because the user then sees what opened. Review when libadwaita changes this behaviour.
- **Pages:** The Navigation spring (`334ms`) pushes and pops dialog pages and section pages on narrow layouts, with the Page Transition Shade. A Popup page pops over 200ms with `--sb-ease-out-cubic`. A List → Split Editor list shrinks to a sidebar while the editor slides in from the right, with continuous compression, and reverses on close; picking another row swaps the editor content without replaying the slide.
- **Toasts:** In over 300ms, sliding from their own height plus a fade. Out over 300ms with a fade and scale to `0.95`.
- **Tabs and expanders:** Tabs and page sections crossfade over 200ms (AdwViewStack). Expanders reveal over 250ms; the chevron rotates over 200ms.
- **Side panels:** The main content shifts over `--sb-transition` (`250ms`) when a panel docks or closes. The panel appears after the content has settled.

### Named Rules
**The State-Only Motion Rule.** Animate state, origin, and destination only. No decorative choreography, ambient loops, or hover lift. A loading indicator or a spinner shows the busy state and may move in place while it lasts. Deviation: the HIG animates to show state, origin, and destination; SillyBunny also lets an illustration move in place, because the art is content, not interface motion. Review when the HIG changes this rule. Such motion stays inside the illustration, the indicator or the spinner, never moves layout, pauses while it is hidden, and stops under the Reduced Motion Rule, which shows the first frame (a loading indicator shows finished; a spinner shows its still arc).

**The Reduced Motion Rule.** `prefers-reduced-motion: reduce` or the Reduced Motion setting removes movement and scale. State changes become instant or a crossfade of 200ms or less. JS helpers are no-ops under reduced motion.

## 8. Components

Patterns follow the HIG pattern groups. Sizes and corners come from Layout and Shapes.

### Containers

#### Dialogs
- **Implementation:** [docs/dialogs.md](docs/dialogs.md) is the code reference for Alerts, Dialogs, Windows, pages, and side panels: the `openDialog` and `openAlert` APIs, the Popup hook, page chains, adapters, and a testing checklist. Read it before you build or change one.
- **Tiers:** **Alert** is for messages, confirmations, one-field prompts, and at most one boolean option: `300px` preferred and `372px` maximum (`600px` when wide), content-sized and centred, with a centred heading and body. **Dialog** is for forms and action dialogs: `min(640px, 100% - 32px)` wide with a `360px` minimum, a header bar, and one scrolling body. **Window** is for lists, editors, and viewers: at least `640px` and at least as wide as the main content column, never wider than the viewport minus `32px` (`min(max(640px, var(--sheldWidth)), 100% - 32px)`). A Dialog or Window that shows something beside its content, such as an illustration, is wider by that width (`--sb-dialog-aside`). Dialog and Window heights follow their content up to `90dvh`; a Window that fills (document viewers and editors) is `90dvh` tall. How a surface picks its tier is in the implementation reference.
- **Short and wide Alerts:** In a short view (`max-height: 360px`) an Alert tightens: `24px` above the message, `18px` between its parts and at its sides, `18px` around the responses with `9px` above them, and `16px` button padding with no minimum width. Its responses stay in one row and the Alert grows as needed, so no label is cut. Otherwise, two or more responses that do not fit in a row stack. An Alert with short labels may prefer a row at medium widths, which makes it wider, to `600px`.
- **Primary and secondary windows (HIG Windows):** A primary window hosts the main functions of the application and is independent of any other primary window. A secondary window belongs to a primary one and closes with it; the Dialog and Window tiers are secondary windows. A secondary window is modal to its parent, except one that offers the same functions as the primary window, such as a pop-out. It is no bigger than its parent and holds limited, simple content. Avoid stacking secondary windows (see Pages and stacking). Esc closes a modal window. A primary window restores its previous size with its previous view.
- **Surface:** An Alert uses the Dialog layer. A Dialog or Window uses the Window layer, as `AdwDialog` uses `window-bg`; a Window header uses Header bar, and the body of a Window that shows a document uses View. All three have a `1px` border, Dialog Shadow, and a Dialog Backdrop without blur.
- **Headers:** Cancel comes first and the affirmative last, as in GNOME; custom responses sit between them. An explicit-action Dialog or Window puts Cancel at the header start and the affirmative action at the end, with no Close. An immediate-apply surface shows Close at the end. With three or more responses, other responses sit in a bottom bar aligned to the end. Responses use the primary and secondary button families; Close is a circle with a tonal fill.
- **Pages and stacking:** One Alert may open above any surface. A Dialog or Window opened over another becomes a page in the same frame, never a second visible frame, and the parent becomes inert. A pushed page shows Back at the start. With explicit responses, Cancel acts as Back and the affirmative stays at the end, with no Close; without them, Close sits at the end. Back and Esc pop one page. Close closes the whole frame one page at a time, from the top, and stops at a page that refuses to close. A page over a bottom sheet keeps the sheet's shape and grab handle, and a downward swipe on the handle pops the page.
- **Use (HIG Dialogs):** A dialog opens only in direct response to a deliberate action, never unexpectedly. Prefer inline controls to action dialogs. Alert dialogs carry one to three responses. Action dialogs label the affirmative response with a specific verb ("Save", "Export"), never "OK" or "Done", and keep it insensitive until required options are set. Avoid error dialogs; show non-critical errors inline or in a toast.
- **Shortcuts overview (`AdwShortcutsDialog`):** A Dialog titled "Keyboard Shortcuts" that lists the shortcuts of the application. It opens from the primary menu and with Ctrl+? (HIG Keyboard reference). It is `600px` wide. Shortcuts are grouped in sections, titled and ordered by menu-bar convention, with the most general in "General" rather than "File"; an untitled section subdivides a long one. A search entry fills the header bar, `400px` at most, with the placeholder "Search shortcuts"; Ctrl+F focuses it. With no match the dialog shows a status page, "No Results Found" and "Try a different search". A shortcut is a row at least `36px` tall with `9px 12px` padding: the title and an optional dimmed caption at the start and the keys beside them, wrapping below the title when the row is narrow; an item with no shortcut reads "No Shortcut". Each key is a keycap: a 10% body-colour fill, `6px` radius, `6px` padding, `20px` minimum width, a `2px` lower edge in the shade ink (`#000006`) at 36% on the dark tone and 7% on the light tone, and a `1px` border at the border strength under `prefers-contrast: more`. With four or more sections and twenty or more shortcuts, round buttons (`3px 12px` padding) let the user jump between sections. List only shortcuts the application has. Existing shortcut overviews move to this rule as each surface is rebuilt.
- **Preferences dialog (`AdwPreferencesDialog`):** Settings are gathered into pages of groups. The dialog is `640px` wide and works down to `360px`. A page content column is clamped to `600px`, with `24px 12px` margin and `24px` between groups. The page switcher sits in the header bar; when the dialog is narrower than `400px`, or than `110pt` (about `147px`) for each page, the switcher moves to a bottom bar, and a dialog with one page shows its title instead.
  - **Search:** When search is on, a toggle button with the search icon at the header start (tooltip "Search") swaps the title for a search entry, `400px` at most, with the placeholder "Search preferences". Ctrl+F opens it and typing while the dialog has focus starts it. Results are rows from every page; activating one opens its page at that row. Up from the first result returns focus to the header. A hidden page is left out of the results.
  - **Page banner:** A page can show a banner above its groups and outside the scrolling area.
- **About dialog (`AdwAboutDialog`):** Opened by the primary menu item "About" followed by the application's name. A Dialog `360px` wide, every part optional. The main page is centred: the application icon (`128px`, hidden from assistive technology), the name in the Display role, the developer's name, and the version as a pill button (`999px` radius, `3px 18px` padding, Accent text) that copies the version. Rows below open pages: What's New (the release notes of one version), Details (a long description, the website and extra links), Troubleshooting (Support Questions, Report an Issue and debug information that cannot contain markup or links and can be saved to a file), Credits (Developers, Designers, Artists, Documenters, Translators) and Legal. The main page has `12px` margin, `6px` between items and `18px` around the name block; a subpage has `18px 12px` margin and `18px` between items.
- **Keyboard:** Initial focus goes to the control the user is expected to operate first. Esc activates Cancel. Return activates the affirmative response only when it is neither destructive nor irreversible; otherwise there is no default response. On close, focus returns to the opener, or to the nearest visible control when the opener is gone.
- **Destructive actions (HIG Dialogs, Toasts):** A destructive action that cannot be reversed is confirmed with an alert dialog: Cancel first and focused, the destructive response in Destructive Red. A destructive action that can be reversed is done at once and offers Undo in a toast. Changes inside an editor with explicit save need no confirmation, because Discard restores them. Existing confirmations of reversible actions stay until each action offers Undo.
- **Sheets:** Under the overlay breakpoint every overlay is a bottom sheet: full width, a grab handle, safe-area padding, and scrolling content. A downward swipe from the handle or header (on an Alert, from the handle or heading) follows the finger, closes the sheet, and springs back when short. An Alert stacks its responses full-width at `44px`, with the affirmative on top and Cancel at the bottom. A Dialog or Window keeps Cancel and the affirmative in its header. Deviation: libadwaita keeps alert dialogs floating and gives its dialog sheet no grab handle; SillyBunny makes every overlay a bottom sheet with a grab handle, because a sheet gives `44px` rows and reach for the thumb, and the grab handle is the only visible cue that a sheet can be swiped away. Review when libadwaita changes this behaviour.
- **Bottom sheet (`AdwBottomSheet`):** A sheet attached to the bottom edge at full width, its top corners at the Overlay radius (`15px`). The grab handle is a `54×6px` pill with `15px` margin, in the body colour at 25%; it also lets a pointer drag the sheet, so a sheet without a handle cannot be dragged with a pointer. A modal sheet dims what is behind it with the shade colour at twice its alpha, and its edge is a `1px` ring of white at 7% (30% under `prefers-contrast: more`) inside the shadow. The sheet follows its content's height and leaves a gap above it of `30px`, growing from a viewport height of `720px` to `120px` at `1440px`. A header bar under a handle is at least `36px` tall. It opens and closes with the Sheet spring; under reduced motion the spring is critically damped. A persistent sheet is non-modal and has a bottom bar that expands into the sheet when pressed; use one only where the sheet is part of the layout, and a Dialog for anything transient. A sheet is not adaptive: at larger widths replace it with a sidebar or another layout.

#### Menus and Popovers
- **Surface:** Popover layer, overlay radius, Popover Shadow. Padding is `6px` for a menu list and `8px` for any other popover. The edge is a `1px` ring inside the shadow, not a border.
- **Rows:** `32px` minimum height (`44px` on coarse pointers and in sheets), `0 12px` padding, Control radius, and full-opacity labels with dimmed icons. Hover, press, and keyboard selection use the flat fills.
- **Items (HIG Menus):** Verbs for commands and adjectives for settings, in header capitalisation. Keep actions, checkbox items, and radio items in separate sections. Order by importance, task order, or frequency, with the most important items at the top or bottom. No nested submenus. Menus hold three to twelve items. Omit items that do not apply rather than disabling them, and never add commands only to reach three. Destructive items sit last in their own section, in Destructive Red, and follow the rule for destructive actions (see Dialogs). Deviation: the HIG holds a menu to three to twelve items; a menu that carries extension items, Move Up and Move Down, or saved views may exceed twelve, because extensions and users add items, and the HIG itself asks for the move items. Review when the HIG changes this rule.
- **Icons:** Every command item has an explicit, relevant icon; a generic placeholder icon is never shown. Check and radio items use their state indicator. Deviation: GNOME menus show labels only (HIG UI Icons: a control has a label or an icon, not both); SillyBunny gives every command item an icon, because icons aid scanning in long menus. Review when the HIG changes this rule.
- **Menu buttons:** A secondary menu uses the vertical ellipsis (`view-more-symbolic` in GNOME). A primary menu, where a surface has one, uses the menu icon (`open-menu-symbolic` in GNOME). The tooltip and accessible name name the menu: "Main Menu" for a primary menu, and for a secondary menu the item it applies to (for example "Document Menu").
- **Primary menu (HIG Menus):** The menu of the whole application, for the features every application has. Its button uses the menu icon (`open-menu-symbolic` in GNOME) and carries the tooltip and accessible name "Main Menu". It sits at the end of the header bar, or above the list when the window has a sidebar. With hierarchical navigation it shows only on the top-level view; deeper views use a secondary menu if they need one. The standard items form the last group: Preferences, Keyboard Shortcuts, Help, and About followed by the application's name, for those the application has; About is always there. A primary menu has no Close or Quit item. An existing menu of the whole application moves to this rule as each surface is rebuilt.
- **Secondary and context menus (HIG Menus, Pointer & Touch):** A secondary menu sits in the header bar and holds actions and settings for the current view or item, such as a document, contact or photo. It is optional, used only when there are enough items, and does not repeat Preferences or About. A context menu opens on the secondary click, a long press, Shift+F10 or the Menu key, for what is under the pointer or focus, and F10 opens the header bar's menu. The secondary click opens a menu and never runs an action itself, such as Delete. A context menu appears only when it has relevant items, and every action in it is also reachable by keyboard.
- **Popovers (HIG Popovers):** Small and simple, covering no more than about a third of the window. No Close or Done button. A heading only when the content's purpose is unclear. Esc closes the popover and returns focus to its trigger.
- **One at a time:** Select dropdowns and search results follow the same surface and row rules. A second click on an open trigger, or on a select row's background, closes its popup instead of reopening it. Opening another menu, picker, or popover closes the current one first.
- **Sheets:** In the mobile layout (`max-width: 768px` or `max-height: 360px`), menus and pickers become bottom sheets with a grab handle and the same swipe to close as Dialogs. Deviation: GTK popovers stay popovers on mobile; SillyBunny turns menus and pickers into sheets, because a sheet gives `44px` rows and reach for the thumb, and the grab handle is the only visible cue that a sheet can be swiped away. Review when libadwaita changes this behaviour. A type-ahead list (the completions or suggestions under a text field) is not a menu: it stays anchored below its field at every size, because the field and the on-screen keyboard must stay in view while the user types.

#### Boxed Lists and Rows
- **Groups:** Preference groups are libadwaita boxed lists (`AdwPreferencesGroup`) in the card style: the card fill (`8%` of the body colour on the dark tone, View on the light tone, as libadwaita's card background) and Card Shadow, with no separate border; `1px` separators between rows, and `24px` between groups. The bold heading and optional description sit `6px` above the list, not inside it. A group may have no title, as an `AdwPreferencesGroup` may; its box then names itself with an accessible label. A settings page pads its content `24px` at the top and `12px` at the sides, as a libadwaita preferences page. Groups never take a coloured side stripe. Existing groups move to this fill and shadow as each surface is rebuilt.
- **Cards:** Cards are working surfaces, not a repeated icon-heading-text grid; prefer an open list, tab row, or inline section when that is clearer. A welcome or first-run view may use a centred icon and text, if it stays sparse, labelled, and helpful rather than decorative.
- **Rows:** At least `50px` tall, with `6px` block and `12px` inline padding and `6px` between their parts, as libadwaita's action row; a subtitle makes the row as tall as its two lines need. The title (Body at regular weight) and an optional dimmed subtitle (Caption) sit at the start, the control at the end. The control stays beside the title at every width and moves under it only when the two do not fit; no width breakpoint decides it. Bounded labels and flexible controls keep widths stable across varied label text; controls with an intrinsic width keep it. Expanders put a trailing chevron after any suffix controls, pointing down when collapsed and up when expanded. The expander's header toggles it with a click, Enter or Space, and a suffix control in it keeps its own focus; collapsed content is out of the tab order, and several expanders may be open at once, as libadwaita's. Row text, subtitles included, keeps at least 4.5:1 contrast; placeholders and secondary text use `--sb-input-placeholder` (78% body colour mixed with theme tint). Existing rows move to these roles as each surface is rebuilt.
- **Row types:** Choose by the Selection Controls hierarchy; the row factories are in the implementation reference. A switch row puts `role="switch"` on its native checkbox and never adds `aria-checked` (ARIA in HTML forbids it on `input type=checkbox`). The whole row toggles its switch or check. A switch sits at the end of its row and a check at the start. A toggle row (`AdwToggleGroup`) is an exclusive choice, not a view switcher: label-only native radio segments in a named `radiogroup`, drawn as a toggle group (see Selection Controls); filled, it puts the title above equal-width segments whose labels wrap at word boundaries. A select row (`AdwComboRow`) shows the value and opens the shared searchable picker; a row built on a native form control keeps that control as its source of truth. A select row whose items can be grouped or starred, and which has item actions, shows a trailing menu button only when it has actions.
  - **Property row:** A read-only name and value. The name is the title at the smaller Caption size and dimmed; the value is the subtitle, at full strength and selectable, so it stands out and can be copied. A value that is code or an identifier uses the Mono role. A property row has no control. Existing property rows move to this rule as each surface is rebuilt.
  - **Spin row:** A row with an exact number, right-aligned at the end, with a round minus and a round plus button of `30px` beside it, `6px` apart with a fine pointer and `14px` apart with a coarse one, so each button keeps a `44px` target. The number takes the free width of the row, so its placeholder shows in full. The number's own field draws no outline of its own; the row draws the focus ring. Use it when the exact value matters; otherwise a slider (HIG Spin Buttons). Existing spin rows move to this rule as each surface is rebuilt.
  - **Button row:** A row that acts as a button, at the end of a list or for an action that is part of the list, such as adding an item. It has a title in the Title role between an optional icon at the start and one at the end, `40px` tall inside, with `12px` side margin. A suggested button row fills the whole row with Accent and its ink, and a destructive button row takes Destructive Red text; a view still has at most one suggested or destructive button. Label rules follow Buttons, including the ellipsis rule.
  - **Pill button with a list:** A single action that needs attention or must stand apart from the list above it is a pill button below the list, not a row.
- **List rows:** In list sidebars, a row carries an optional leading grip and dimmed icon, a title with a one-line description, optional dimmed metadata, then at most a switch and a ⋮. Beside an open detail pane, rows hide their subtitles and ⋮ and keep the `52px` minimum. Deviation: the HIG allows a boxed-list row at most two controls; a reorderable row with a switch has a drag handle, a switch, and a menu button, three controls in all, because a reorderable row that can also be switched on and off needs all three. Review when the HIG changes this rule. There are never three trailing controls.
- **Boxed-list rules (HIG Boxed Lists):** A row holds one control, two at most. Clicking the row background activates its control; the control takes keyboard focus, not the row. A button row that opens a new view ends with a trailing arrow instead of an ellipsis. Deviation: the HIG reserves boxed lists for small, static sets of rows; the sidebars of List → Split Editor use boxed rows (card radius, card fill, Card Shadow) for collections of any size, and load large ones in batches with a Show More row, because one visual language serves every list, and large collections load in batches. Review when the HIG changes this rule.
- **List and column views (HIG List & Column Views):** The alternative to a boxed list for very large or dynamic collections. Keep rows simple and regular: one or two elements each. Differentiate several text elements by size and weight, and use symbolic icons. Order the list in the way that is most useful. A list has a minimum and a maximum width. A column view has a header per column that sorts it: clicking an unsorted header sorts in natural order and shows a down arrow, clicking again reverses it and shows an up arrow. Natural order is alphabetical, smallest number first, earliest date first or checked items first. A list view shares its data with a grid view, so the two can offer the same collection in two forms. Selected rows follow the List-view rows fills.
- **Reordering:** Rows that can be reordered offer Move Up and Move Down in their menu, which the HIG requires for accessibility, beside drag and grip keyboard actions; all three share one saved order. Omit a move at its boundary and while a search or filter is active, and keep focus on the moved row. Existing reorderable rows without move menu items move to this rule as each surface is rebuilt. Deviation: lists whose rows and drag handles come from upstream markup get keyboard moves instead of move menu items: the row or its handle takes focus, Alt+Up and Alt+Down move it one place and Alt+Home and Alt+End to the ends, and the move is saved and announced as a drag would be; SillyBunny adds no row menus there, because the markup stays upstream's for compatibility with upstream and its extensions. Review when the HIG changes its reordering advice.
- **Adding and removing:** A list that can change has an add button at the top of the list or an add row at its end. Each row has a remove button at its end. A list that can also be reordered has a drag handle at the start of each row, and a menu button at the end in place of the remove button, with Move Up, Move Down and Remove; the move items are required for accessibility.

#### Grid Views
- **Grid (HIG Grid Views):** A grid of images, such as thumbnails of items or a chooser of pictures. Each item has its own thumbnail where possible. Order items by what is most useful to the user; most recently added is often best. Style the grid to the content: minimal, so the content shines; outline a cell only where images are irregular or inconsistent. Offer a list view of the same collection where extra details (dates, authors) help. Give a grid a maximum width so rows do not grow uncomfortably long, and test it across window sizes. A grid cell has the Control radius and a `3px` inset; its fills are those of a list-view row, and under `prefers-contrast: more` hover and pressed cells add a `1px` ring.

#### Header Bars and Toolbars
- **Header bars (HIG Header Bars):** Every top-bar control has a tooltip. Header content updates to match the current view, and essential main-content controls stay labelled and visible. Header actions that do not fit move into the ⋮ menu as space runs out. As a bar narrows, its title shortens first; then labelled buttons drop their labels and keep their icons and tooltips; then the title hides, once less than `60px` of it would show; last, the buttons that still do not fit move into a ⋮ menu named by what it holds. An editor's view switch (Edit/Preview) moves into its item menu on a phone before the title shortens, so the item's name keeps its room; an editor with no item menu keeps the switch. Each step stays taken as the bar narrows further, and nothing in the bar is clipped, scrolled out of view or drawn over another control. A bar keeps one row: its controls never wrap to a second row, because a control that changes rows loses the place the hand has learned; folding into the ⋮ menu is the only way a control leaves the row. The mobile layout states its own rows. At most one destination in a bar is active, the view on screen; a toggle keeps its own on state.
- **Toolbar buttons:** Buttons in any bar follow the Flat Toolbar Rule and use the Control radius. Back and section buttons are flat, as libadwaita's. Close is a circle with a tonal fill (`--sb-raised-bg`). A pill is for a primary text button in open space, and a circle for Close and for an icon-only suggested action (see Shapes). A toggle button in a bar is flat; when on, it takes a neutral fill with Accent on its icon (see Active State, and Buttons, Toggle button). Existing bar controls move to this shape and fill as each surface is rebuilt.
- **Grouping (HIG Header Bars):** Related buttons in a bar (back and forward, for instance) are grouped by a gap of `12px` between sets (libadwaita's spacer), not by joining them into a linked strip: a linked button keeps its background in a bar. A split button, one button with a connected drop-down, is the other way to group. A label-only button, a suggested or destructive button and a linked button are avoided in a primary window's bar; give a label-only button an icon instead. An action dialog's bar keeps its label-only buttons.
- **Composer:** A bottom bar that holds a text input stays available for writing, keeps the input central, and adjusts to keyboard and safe-area changes without covering the content. Adjacent bars join into one stack on the Bottom bar layer, split by a `1px` hairline.
- **Bar fields:** Selects, chips, and search fields in a bar use the Control radius, a borderless raised or neutral fill, and the inset focus ring.

#### List → Split Editor
- **Pattern:** A master list beside an editor, built from libadwaita parts with `AdwNavigationSplitView` collapse rules. Libadwaita sidebars are not user-resizable and no stock widget animates from a full-width list into a split view.
- **Sidebar:** Resizable sidebar `240–420px`, default `30%`; collapse at viewport `≤768px` or Editor pane `<720px`. These are defaults; a list inside a Window may set a narrower range and an earlier collapse. Collapsed, the editor is a full-screen page with a back button and no sidebar. A list with its own sidebar of locations collapses into three pages: locations, list, and detail.
- **Divider:** The edge between two resizable panes is a `1px` line at the border strength; a wide handle is `5px` with a `1px` line on each side.
- **Editor body:** Text-first editors keep the pane from scrolling: text areas take the remaining height (`flex: 1 1 0; min-height: 0`) and scroll internally. Multi-group editors scroll one body container; the shell and detail frame do not scroll. Main text areas there have a minimum height and Expand rather than competing for leftover height; on phones the focused text area stays visible as the visual viewport changes. Header and property controls stay outside the body; avoid nested group scrollers.
- **Explicit save:** The editor header shows, in this order, Back where the editor is a pushed page, an editable title, a dirty indicator, the token count, Edit/Preview where the editor has it, the item menu, Cancel, and Save, with the same control shapes and tooltips in every editor. Where the header collapses for a phone, the token count moves to the second row as a dimmed Caption toward its inline end: into the toolbar of a single-content editor, before its trailing toggles, in its short form (the full count stays in its accessible name), or beside the property summary of a list-content editor, outside the summary button; the context warning stays attached to it. Cancel discards local changes without closing the page. Back, row switches, and navigation ask first, with Cancel, Discard in Destructive Red, and Save as the suggested response, as libadwaita's save-changes alert, and keep a recoverable draft.
- **Property bar:** Item properties sit in a bar directly under the header. On collapsed layouts the bar becomes a `44px` summary button that opens a sheet holding the same controls, not copies.
- **Secondary pages:** Settings and overviews that belong to a list open from its ⋮ as detail pages, not as fixed list entries. Each has an in-pane Back and one scrolling body.

#### Selection Mode
- **Use (HIG Selection & Edit Modes):** Entered deliberately, and only offered when at least three actions apply to a selection. Clicking anywhere on a row toggles its selection. The checks sit at the start of the row and are `28px` circles on every device (libadwaita's size), with a `2px` outline at 15% of the body colour, filled with Accent and the shared check glyph when selected. Under `prefers-contrast: more` the outline takes the high-contrast border strength (50%), and 60% on hover.
- **Entering:** Outside selection mode a check shows over each item on hover; pressing it selects the item. A secondary click or a long press on an item also selects it. Once one item is selected, selection mode is active, with the header and the action bar below.
- **Edit mode:** Where each item has two or three actions that fit over or beside it, use edit mode instead: the actions show inline on every item. A dedicated Edit button enters it and a Done button leaves it. If editing is the main way users work with the collection, show the controls by default and have no mode.
- **Header:** Cancel is at the start, a live selected-count title in the middle, and Select All at the end. Both buttons are raised text buttons (`--sb-raised-bg`), never a solid Accent button. Keep labels readable in forced colours and at user font scale.
- **Window header:** Selection mode replaces the header content. Close stays visible and other header controls are hidden. An open search closes, and its query returns on exit. When the count does not fit beside the buttons, it moves to a second header row.
- **Action bar:** The action bar sits at the bottom. A consumer may opt in to icon-only actions under the overlay breakpoint; the icons spread evenly, the bar is `44px` tall, and each action keeps its `aria-label` and `title`.
- **Scope:** Select All covers only the current filtered items and counts a duplicated item once. Selection gestures, keyboard behaviour, and focus return are the same wherever selection mode is used.

#### Side Panels
- **Implementation:** `registerSidePanel` and its options are in [docs/dialogs.md](docs/dialogs.md#side-panels).
- **Use:** Non-modal utility panes that keep the main view available, such as a notes or tools pane. Panels do not use a scrim or focus trap.
- **Docking:** Dock into the gaps beside the main view. Width is `280–420px`; move the main view as little as possible, never place a panel over the main content column or top bar. When the gap is too small, the main view returns to its normal width and the panels become sheets. Deviation: libadwaita sidebars are `180px` to `280px` wide; SillyBunny side panels are `280–420px`, because a side panel holds a form, and under `280px` its labels wrap and its title is lost. Review when libadwaita changes this range.
- **Surface:** The Window layer with a `1px` border and square corners. A docked panel has no shadow. A panel sheet follows the Dialog surface.
- **Sides:** Each panel has a default side, and its header menu offers Move to Other Side. Two panels on one side split the available height. Save the side through the existing `movingUIState` keys; opening a panel is not persisted.
- **Default side (HIG Utility Panes):** A panel that affects the main view defaults to the start side; a subordinate one defaults to the end side. A panel that the user can show and hide uses F9 as its shortcut. A panel may be permanent or transient: transient ones are shown on request or while a feature is in use. Existing side panels move to this rule as each surface is rebuilt.
- **Sheet:** At most one panel at a time, persistent and non-blocking above the bottom bar, at most `50dvh`; the bottom bar remains visible and usable. It has its own scrolling, a grab handle, and Close.
- **Keyboard:** Escape closes the panel. Opening moves focus into the panel; closing returns it to its opener.

#### Illustrations
- **Pixel art:** drawn at a whole number of device pixels per art pixel (the screen scale rounded, at least 1), so a picture is the same size everywhere on one screen. Where no whole step fits, it is shrunk by a fraction and drawn smooth, never in uneven blocks.
- **In a Dialog or Window:** beside the content when the content column keeps its minimum width (`360px`, scaled with the text size) and the illustration fits the window's height; the window then grows by the illustration's width and does not narrow while it is open. Otherwise above the content, at most 30% of the viewport height, and hidden when too little of the figure would show.
- **Accessibility:** a decorative illustration is hidden from assistive technology (`aria-hidden`, `alt=""`) and takes no focus.

### Navigation

#### Shell
- **Primary surface:** The main content view is the primary surface; a bottom bar holds the direct actions on it.
- **Top bar:** An always-visible top bar with a start group, a centred title, and an end group (HIG Header Bars). The title shows the name of the open item by default. Either group can hold an extension slot and configurable quick-access slots. Deviation: the HIG, and Layout, ask that the same functions stay available at every width; SillyBunny shows optional quick-access controls only where the bar has the width, which is on desktop, because a narrow bar has no room for them. This is the exception to that rule. Review when the HIG changes this rule. Deviation: the HIG asks a header bar for only a small number of controls; SillyBunny's top bar holds more, because this is a deliberate design decision. Review when the top bar is redesigned.
- **Settings:** Settings open as a full-screen page: a sidebar of pages with its own heading and settings search (HIG Sidebars), and a content pane headed by the page title and description. Page labels are nouns in header capitalisation and of similar length. Settings that the application ships, the settings of its bundled extensions included, are built from the shared rows; the settings of third-party extensions keep their own markup and take only the restyled shared fields. Deviation: the HIG asks that, in preferences, one page's controls never change the controls on another page (HIG View Switchers); SillyBunny lets a setting that selects a mode decide which controls other pages show, because upstream SillyTavern behaviour depends on it. Review when upstream behaviour changes. Deviation: libadwaita gathers preferences in a dialog (see Dialogs, Preferences dialog); SillyBunny opens settings as a full-screen page with a sidebar of pages, because the settings fill more pages than a dialog holds. Review when the settings surface is redesigned.
- **Optional bars:** The user can hide optional bars in settings.

#### Pages and Sidebars
- **Depth (HIG Navigation, Browsing):** Hierarchies are generally one level deep below a view. A pushed page has its Back control at the top start. Close, where it shows, closes the whole frame.
- **Sidebars and panes (HIG Sidebars, Utility Panes):** A sidebar navigates between locations, such as a list of items to open or the list of a List → Split Editor. A utility pane holds tools or details for the main view, such as a settings pane. Both collapse at narrow widths: a sidebar becomes a pushed navigation stack, as `AdwNavigationSplitView` collapses, and a utility pane overlays the content or becomes a page.
- **Split views (`AdwNavigationSplitView`, `AdwOverlaySplitView`):** By default a sidebar takes 25% of the width, between `180px` and `280px`, and the content takes the rest; collapsed, it uses its maximum width where it fits. A pattern in this document that gives its own width (List → Split Editor, Side Panels) uses that width. A navigation split view collapses into a navigation stack with the sidebar as its root page; the content page's header bar then shows Back and the page title. An overlay split view collapses by hiding the sidebar and showing it above the content on request: a toggle button for it appears at the start of the content's header bar, and the primary menu button moves from the sidebar's header bar to the content's. The overlaid sidebar uses the Window colour, dims the content with the shade colour and casts a `56px` shadow from its edge, as a pushed page does (Page Transition Shade). On touch, an edge swipe shows it and a swipe from the sidebar hides it; Esc, or a press on the dimmed content, hides it while collapsed. A sidebar can sit before or after the content.
- **Sidebar parts (`AdwSidebar`, `AdwViewSwitcherSidebar`):** An optional prefix above the list and an optional suffix below it, each with `6px` margin (header bar controls that affect the list go above it). A row is at least `36px` tall, with `3px 14px` padding, `12px` between its icon and text, the Control radius and `6px` margin at its sides. Section headings use the Title role. A row can show a badge: a pill in the body colour at 40% with white bold text, at least `1.6em` high and wide, `6px` padding at the sides; a dot is `8px`. A row that needs attention uses Accent and its ink. A count above 999 reads "999+". Every badge has an accessible name. An empty sidebar shows a compact status page.
- **Active State:** Use a neutral selected fill, with Accent on the icon where it helps; a toggled button in a bar follows the same rule. No border, bottom accent stripe, or underline. Never use a thick left or right stripe.

#### Tabs and View Switchers
- **Tabs (HIG Tabs):** Tabs let a window hold a changeable set of content items, such as pages, documents or images; they suit editors and browsers, not a fixed set of sections (use a view switcher for those). A tab has a label and an icon only where an icon is needed. Keep labels short with the useful part first, so the label still works when it is cut with an ellipsis. The tab bar may always show, or hide until there is more than one tab. Each tab has a context menu: Move to New Window where that exists, Duplicate, Pin or Unpin, Mute and Reload where they apply, and Close last; avoid "left" and "right" in its items. The bar uses the Header bar colour with a `1px` shade line below it, at least `34px` tall. A tab is at least `26px` tall with `4px` padding and the Control radius; the selected tab uses the neutral selected fill, hover 7% and pressed 16%, and a lone tab has no fill. A tab's close button is a `24px` circle. Under `prefers-contrast: more` a hovered, pressed or selected tab adds a `1px` ring at the border strength. A `2px` Accent line at 50% (full Accent under `prefers-contrast: more`) shows where a dragged tab will land. Keys: Ctrl+Tab and Ctrl+Page Up or Page Down switch tabs, Ctrl+Home and Ctrl+End go to the first and last, Alt+1 to 9 go to one of the first nine.
- **View switcher (`AdwViewSwitcher`, HIG View Switchers):** A control for switching between three to five predefined views; more views suit a sidebar. Labels are nouns in header capitalisation and of similar length. Each button has an icon and a label (an exception to icon-or-label), and can show activity: a dot for new content, or a count (`999+` at most). In a header bar the buttons sit side by side, `3px` apart, `34px` tall, with `12px` side padding and `6px` between icon and label. When the header bar is too narrow for them, the switcher leaves it and a bar at the bottom edge takes its place, where each button shows its icon above a label at `0.75rem`. The bottom bar shows only with two or more views. The width at which this happens has no fixed value: it depends on the number and length of the labels (libadwaita uses `550sp` in its example and `110pt` for each page in its preferences dialog), so test it with the longest translations.
- **Inline view switcher (`AdwInlineViewSwitcher`):** The same switching placed in the content instead of the header bar: a toggle group whose toggles are the views, each showing an icon, a label or both, set once for the group. It takes the flat and round variants of the toggle group. Its toggles carry the tab role and its group the tab list role. A toggle can show a dot or a count. Dragging an item over an inactive toggle and holding for half a second switches to that view. Use it to switch between views of one piece of content; use the header bar switcher for the main views of the window.

#### Search
- **Behaviour (HIG Search):** Live as the user types, across the whole collection, with a status page when nothing matches. Every item stays reachable without search.
- **Placement:** Search sits in the header, revealed from an icon where space is short; Esc closes an open search before anything else. Filters sit beside the field or in the header, never in the ⋮ menu.
- **Activation (HIG Search):** The search bar slides down from under the header bar and stays hidden until the user activates it, in one of three ways: typing while no field has focus, Ctrl+F, or the header button, which toggles. Where search is central to the application, the field may stay visible elsewhere.
- **Tolerance:** Search accepts mistakes (approximate matching, suggestions of similar or related items) and broad terms: a list of cities can match a country or region. Results show as they are found, with the most relevant first.
- **Global search:** The entry is a borderless raised field with the Control radius and the inset focus ring. Results sit in a popover with flat rows, filled only on hover, press, or keyboard selection; group headings are dimmed.

### Controls

#### Buttons
- **Primary:** A libadwaita suggested action: Accent background, `--sb-on-solid-accent` text, `38px` minimum height (`44px` on coarse pointers), and `10px 14px` padding. Hover changes the fill slightly; there is no lift. A view has at most one button in the suggested or destructive style (HIG Buttons). Deviation: an alert in which more than one response destroys something that cannot be restored, such as deleting one item or all of them, shows each of those responses in Destructive Red, because a response in another style would read as the safe choice. Review when the HIG covers alerts with several destructive responses. Icon-only suggested actions, such as Send, are solid-accent circles. A disabled suggested button fades with libadwaita's disabled opacity (`50%`, `40%` under `prefers-contrast: more`).
- **Content:** Outside the top bar, a button shows an icon or a label, not both (HIG Buttons). The arrow on a button that opens a menu or expands content shows the button's state and is not an icon in this sense. Labels are short imperative verbs in header capitalisation ("Save", "Update"). A button whose action is unavailable is insensitive instead of showing an error when clicked. No actions on double-click or right-click of a button. Existing buttons that pair an icon with a label move to this rule as each surface is reworked.
- **Shape:** A button is a rounded rectangle at the Control radius. A pill has a full radius and `10px 32px` padding; a circle is `34px` at least. Shapes states where each applies.
- **Widths:** Use one or two button widths in a window, and give buttons side by side the same width.
- **Toggle button:** A button that switches between two states looks pushed in when set: a 30% fill, 35% on hover, 40% pressed. Use it for a mode or setting with an obvious binary nature where space is limited, as an alternative to a switch. A choice between several short options is a toggle group. In a bar a toggle button follows Active State.
- **Secondary:** A secondary button is a libadwaita raised button: a `10%` body-colour fill at rest (`--sb-raised-bg`), `15%` on hover, and `30%` when pressed, Foreground, at the same height and padding as the primary family. A flat button is transparent at rest and uses the flat fills (see the Flat Toolbar Rule). A button that keeps upstream markup also keeps its `1px` theme border. Deviation: libadwaita buttons have no border; SillyBunny keeps the border on buttons with upstream markup, because user themes style that markup. Review when those buttons are rebuilt.
- **States:** Default, hover, focus-visible, active, disabled, loading, and error are explicit. Focus-visible shows the inset ring with no outer glow. Every icon-only button has an accessible name and a tooltip. Fills use `:active`, so they do not stick after a tap. Selected tabs and nav items use a neutral fill without a bottom accent stripe or inset shadow.

#### Text Fields
- **Style:** Window background (`--sb-input-bg`), a `1px` theme border, the Control radius (`9px`), `--sb-field-min-height` as the height (`46px`, `40px` in compact, `44px` on a coarse pointer), and `12px` inline padding. Deviation: libadwaita fields are a `10%` fill without a border; SillyBunny keeps the Window colour as fill and a `1px` border, because a `10%` fill alone is about 1.4:1 against the window, so the border marks the field's edge. Review when libadwaita changes this value.
- **Focus:** The border turns `--sb-entry-focus-border` and a `1px` inset `--sb-entry-focus-ring` in the same colour completes a `2px` ring in the focus-ring colour (see Focus Ring). The fill does not change. A standalone field draws focus on the input; an entry row draws it around the whole row (see Entry rows). A multi-line input in a bar, the composer, keeps its own accent outline (`--sb-composer-focus-*`).
- **Behaviour (HIG Text Fields):** In forms and preferences, prefer entry rows to standalone fields. A field that holds a setting applies its change on Return or when it loses focus. Validation feedback appears as the field is edited and favours a positive "valid" cue over showing an error while the user is still typing. Placeholders read like labels, or as an instruction ending in an ellipsis for action fields ("Search for a city…"). Typing never starts a network action; connecting and testing stay behind explicit buttons.
- **Entry rows (`AdwEntryRow`):** The row is the field: it has no inner fill, border or radius, and its text sits in the row's editable area, `12px` from the row's edges like any row content. The title is a linked `<label>`. While the row is empty and not being edited, the title sits where the text goes, at Body size and dimmed, and doubles as the placeholder; on focus, a value, or autofill it moves above the text at Caption size, still dimmed, as `AdwEntryRow`'s. A placeholder that an adopted input carries is kept as its accessible description and is not painted. The title is single-line with ellipsis and remains the accessible name. An edit icon at the end of the editable area, a `16px` symbolic icon in the text colour, marks the row as editable while it is not being edited. While the text has focus, the whole row carries the focus ring, inset by `1px`, and hovering does not change its fill; prefixes and suffixes (Reveal, key buttons) sit inside the row and inside the ring. A vertical separator, the height of an icon button in the row's separator colour, sets the buttons after the field apart from it and its edit icon, as GNOME Settings draws one before a row's separate button. A short value that may still hold a line break (a name, a version) keeps its multi-line control in the row: it shows one line and grows with its text, to about five lines. Existing stacked fields remain until each surface is migrated.
- **Secret fields:** Saved or missing key status is an icon with visually hidden text at the end of the field, before the edit icon, where `AdwEntryRow` keeps its indicator; an unknown status is hidden. Mask and offer Reveal only where `-webkit-text-security` is supported; never change the input type or invite a password manager. Deviation: libadwaita and the HIG use a dedicated password entry; SillyBunny masks an upstream text input and keeps its type, because this preserves upstream text inputs and avoids password-manager prompts. Review when upstream inputs change. Deviation: the HIG allows a boxed-list row at most two controls; a secret row may hold three (entry, reveal, and key management), because the function needs all three. Review when the HIG changes this rule.
- **Caps Lock:** A secret field shows a Caps Lock indicator at its end, a quiet icon at 30% (80% under `prefers-contrast: more`), while its text is masked and Caps Lock is on. It does not show while the text is revealed.
- **Help captions:** One-line help is a dimmed Caption below the field, linked by `aria-describedby`. Multi-line instructions and lists stay above the field, and visibility-gated warnings keep their gates. Deviation: `AdwEntryRow` has no subtitle; SillyBunny shows captions, because they preserve upstream help and status. Review when libadwaita adds a subtitle to entry rows.
- **Error / Disabled:** Destructive Red uses a readable tint and explicit text; disabled fields preserve label and layout context rather than disappearing.

#### Selection Controls
- **Choosing a control (HIG Switches, Checkboxes, Radio Buttons, Drop-Down Lists, Sliders, Spin Buttons):**
  - A switch is for an option with a clear binary nature, and is preferred to a checkbox for settings.
  - Checkboxes are for lists of independent choices, mixed states, and menu items. Label them by their checked effect and never negatively ("Play alert sound", not "Disable alert sound").
  - Two exclusive options use a segmented toggle or radio buttons, never a drop-down. Small exclusive sets use radio buttons or a segmented toggle; longer sets use a drop-down, with search for long lists.
  - A slider is for a fixed, ordered range with live feedback; pair it with a number field when exact values matter. A spin button is for an exact value, right-aligned.
  - A control that enables others sits directly above the controls it affects.
- **Hierarchy:** One boolean option uses a switch row. A pick-several list uses a check row per item, with Select All when there are more than five items. Two or three exclusive options use a segmented toggle; four or more use a combo or searchable select row.
- **Toggle group (`AdwToggleGroup`):** A set of exclusive toggles, each an icon, a label, both, or custom content; for a few options that short labels can express (HIG Buttons). It is a tray: the raised fill (the body colour at 10%) with `3px` padding and the Control radius. A toggle is bold, at least `28px` tall, and at least the target floors of Layout (`32px` with a fine pointer, `44px` with a coarse one) (`34px` wide for an icon), with a radius of `6px` and `8px` side padding around a label. The selected toggle is raised: white at 20% on the dark tone and white on the light tone, with two soft shadows (`0 1px 3px 1px` at 7% and `0 2px 6px 2px` at 3% of the shade colour). Hover fills a toggle 7% and press 16%. Under `prefers-contrast: more` the tray, a hovered or pressed toggle and the selected toggle gain a `1px` ring at the border strength. A disabled group fades its tray to the disabled strength. Focus draws the ring outside the toggle. A thin separator sits between toggles and is hidden beside a toggle that is selected, hovered or has keyboard focus. Variants: round (a pill tray, `17px` radius, `12px` side padding on labels), flat (no tray; the selected toggle is the neutral selected fill at 10%, 13% on hover, 19% pressed) and vertical (for icon-only toggles). An icon-only toggle has a tooltip, which is also its accessible description. Each toggle has the radio role, or the tab role when the group switches views. Tab moves focus into the group at the selected toggle and out of it again; arrow keys move between toggles. When space is not limiting, radio buttons are the better choice. Existing toggle rows and segmented controls move to this form as each surface is rebuilt.
- **Checkbox:** Rounded square with a `2px` neutral outline at rest. Checked fills solid Accent with a check glyph in `--sb-on-solid-accent`. No highlights, glow, or inner shadow.
- **Mixed state:** A checkbox for a setting that holds for some of the selected items and not others shows a mixed state: the Accent fill of a checked box with a dash in place of the check. Pressing it once checks it and applies the setting to every selected item; pressing again unchecks it and clears the setting everywhere; a third press returns it to mixed and restores each item's own value.
- **Radio:** Circle with the same `2px` outline. Checked fills solid Accent with a centered dot in `--sb-on-solid-accent`. Segmented boolean radios keep their overlay input and are styled as the segment instead.
- **Range:** `4px` trough at `15%` of the body colour (libadwaita's trough) and an `18px` Accent thumb with a `1px` shade. Firefox fills the trough up to the value; WebKit and Blink show the trough only. Hover grows the thumb slightly on hover-capable pointers. When a row is too narrow to hold the title, the range, and the number field side by side, a slider row stacks its range and number field under the title. Deviation: libadwaita's range has a white thumb; SillyBunny's thumb is Accent, because libadwaita's next release changes the range again, so restyling it now would be done twice. Review when libadwaita 1.11 is released. Deviation: libadwaita's range fills the track up to the value; in WebKit and Blink SillyBunny shows the trough only, because those engines expose no pseudo-element for the filled part. Review when libadwaita 1.11 is released.
- **Switch:** A pill `26px` high, with a `20px` thumb and `3px` of padding around it, as libadwaita's, and wide enough for the thumb to travel its own width (`46px`); `38×22` in compact mode. It sets `appearance: none` and `-webkit-appearance: none`. Off uses a `15%` body-colour trough (the same trough as the range); on fills solid Accent with a circular thumb in `--sb-on-solid-accent`. The thumb travels with `inset-inline-*` so RTL mirrors. Reduced motion snaps with no travel. Existing switches move to this size as each surface is rebuilt.
- **Focus / Disabled:** Small controls use a `2px` focus-ring outline with an offset so the ring stays visible around the control. Disabled controls fade to the disabled opacity and show a `not-allowed` cursor.

#### Chips
- **Style:** Compact controls at the Pill radius, `6px 8px` padding, readable text, and a tonal background.
- **State:** Enabled or selected chips use a 16% Accent tint and a status icon. Inactive chips remain legible and low emphasis.
- **Tag lists (HIG Text Fields, `AdwWrapBox`):** A set of chips flows like words in a line: it wraps to the next line when the next chip does not fit, with a gap between the chips of a line and a gap between lines. A tag field shows each value as a chip inside the field, so it reads well and each value can be removed; it needs a custom implementation, as no standard field has tags. An editor's tags are one row that opens the shared picker, as a single choice does: the row's dimmed subtitle names the applied tags (two lines at most) and its value is their count; the picker ticks them and lists them first, each with a dot in the tag's colour, and a search that names no tag offers to create it. The row stays one row however many tags there are.
- **Status chips:** A non-interactive chip that names a row's state in words, placed before the row's buttons. A positive or finished state (Installed, Enabled, Done) takes a 16% Success Green tint and a leading check in Success Green; any other state (Not installed, Skipped) takes an 8% body-colour tint and no icon. The text uses the strong contrast ink rather than the body colour, so it reaches 4.5:1 on the tint in every bundled theme, and the check reaches 3:1. The words always carry the state; colour and the check only reinforce it.
- **Use:** Chips carry compact controls and metadata, and status chips sit in list rows; do not collect many chips in one bar.

#### Avatars and Overlaid Controls
- **Avatar (`AdwAvatar`):** A round image of a person or an entity. With no image it shows the initials of its name, in bold, on a gradient chosen by a hash of the name, so a name always gets the same colour; with no name it shows a generic person icon. Its size comes from the layout that holds it. It is an image to assistive technology, named by the name it shows.
- **Overlaid controls (HIG Overlaid Controls):** Semi-transparent controls that appear over content when the pointer moves over it, when it is tapped, or when focus enters it, so fewer controls show while the user is not interacting. Use them for content that is watched or read, not for content that is edited: where they would hide what the user needs to see, put the controls beside it. Follow the convention of the content: browse buttons at the left and right edges of an image, player controls at the bottom edge of a video. They attach to an edge or float. The fill is black at 70% and the ink white at 90% (the OSD colours); an OSD button is black at 65% and at least `32px`, and under `prefers-contrast: more` it gains a `1px` ring in its ink colour. Existing overlaid toolbars move to this rule as each surface is rebuilt.

### Feedback

#### Toasts
- **Surface:** Toast layer with white ink in both tones, a pill shape (libadwaita's toast radius is `150px`), Toast Shadow, no border.
- **Status:** Error, warning, and success toasts keep the toast layer and use the standalone status colour for the icon and title only.
- **Use (HIG Toasts):** Transient and dismissible, for events and completion summaries that only matter while the app is open. A button only when it is directly useful, such as Undo after a reversible destructive action. A toast is never the only place a persistent failure or state is shown.
- **Timing:** A toast stays for 5 seconds; a toast with no timeout stays until it is dismissed. It does not disappear while it is hovered, pressed (on touch) or has keyboard focus inside it. It shows and hides over `300ms` (see Motion, By Pattern). A second toast waits behind the first; a toast of high priority, such as an Undo, shows at once and pushes the first back into the queue. Replacing a toast takes 500ms. A toast's button runs its action once and is then disabled. Existing toasts move to this timing as the toast layer is rebuilt.
- **Metrics:** A toast has `12px` margin on every side and `24px` from the window edge it sits at, `6px` padding (`12px` at the start), and `6px` between its parts. Deviation: libadwaita keeps a toast's title to one line and ends a long one with an ellipsis; SillyBunny wraps it, because upstream SillyTavern and extensions send full sentences and error messages that a toast must not cut, so a toast pads `9px` above and below, `36px` at the start (its icon) and `24px` at the end, which keeps every wrapped line clear of the pill's rounded ends. Review when libadwaita changes this behaviour. A toast with a button is at least `450px` wide, never wider than the window; one without a button is as wide as its text. Under `prefers-contrast: more` it gains a `1px` ring at the border strength.
- **Position:** Deviation: the HIG places toasts towards the bottom of the window, horizontally centred; SillyBunny defaults to the top centre (upstream SillyTavern, adjustable by theme), because the position follows upstream and users' saved settings. Review when upstream changes the default position.

#### Banners, Status Pages, and Progress
- **Banners (HIG Banners):** For persistent states only, never for events or short-lived states. One short title written as an informal heading, and at most one button. A persistent state, including an error that one action resolves, shows in a banner whose button is that action. Existing inline status for such states moves to a banner as each surface is rebuilt.
- **Banner placement and metrics (`AdwBanner`):** A banner is a strip across the top of a view, under that view's header bar and above its content, at the view's full width. It is hidden until the state it reports applies, and it reveals and hides with the reveal transition. It has `6px` padding and the Window ink. Its fill is a neutral step over the Window colour. Deviation: libadwaita's banner fill is a fixed grey (`#7d7d83`) at 30% over the Window colour; SillyBunny mixes the theme's body colour into the Window colour instead, because a fixed colour bypasses user themes (The Theme Alias Rule). Review when libadwaita changes this value. The title is centred or starts at the start edge, depending on the space; parts are `6px` apart, `36px` when centred, and `9px` apart when the button is stacked below the title. The button is at least `84px` wide beside the title and `160px` wide below it, in the default or the suggested style; it runs the action that resolves the state. A banner is a polite status region (`role="status"`) that is read out when it appears. Deviation: libadwaita's banner is a group labelled by its title and announces nothing; SillyBunny announces it, because WCAG 2.2 success criterion 4.1.3 (Status Messages) asks that a status message reach assistive technology without taking focus. Review when libadwaita changes this behaviour. Existing banners move to these metrics as each surface is rebuilt.
- **Status pages (HIG Placeholder Pages, `AdwStatusPage`):** Empty views, empty search results, and unavailable states show a symbolic icon, a heading that names the state, an optional line of guidance, and an optional action. Symbolic placeholders stay neutral in colour and tone.
- **Metrics:** The default set is a `128px` icon, the title in the Display role, `36px` between icon and text, `36px` above and below the page and `12px` at its sides, `12px` between title and description; the description is Body. The compact set, for a sidebar, a popover or a pane and the default for an empty sidebar, is a `96px` icon, the title in the Headline role, and `24px` gaps and margins. The icon is dimmed (and fades to the disabled strength when the page is disabled) and is drawn with the heavier stroke (weight `134`). The text is clamped to `600px`, centred, and wraps. The page is labelled by its title and described by its description, and its icon is hidden from assistive technology. Illustrations in colour belong to the first view of an application only (HIG Placeholder Pages). Existing full views that use the compact set move to the default set as each surface is rebuilt.
- **Inline hint:** An empty part inside a section, card, popover or pane, such as a list with no items yet, shows a one-line hint instead of a status page: a single centred line in the Caption role and the dimmed foreground, with the section's padding and no icon, title or action. A status page is for a whole view or region; in a small surface its icon and title would crowd out the content around it.
- **Loading state:** A view or region that waits for its content shows one form: a status page in the spinner form, which is the compact set with a spinner in place of the icon. The spinner is `64px` high with a thinner stroke (`6px` at that size), the title is in the Headline role, and gaps and margins are `24px` (libadwaita `.spinner` status page). The spinner is the shared spinner, never a symbolic icon, an hourglass or a font glyph that spins. The title names what is loading, in header capitalisation and without an ellipsis, such as "Loading Documents"; a description and an action appear only when they help, such as Cancel for a load the user can stop. The page takes the place of the region that is loading. It appears only after a short delay, so a quick load shows nothing, and it goes as soon as the content is ready. The region is marked busy (`aria-busy`), and the page is its label. A load that is expected to take longer than about thirty seconds, or that knows its proportion, shows a progress bar; a load inside a control shows a spinner beside it (see Progress). Deviation: libadwaita's spinner keeps turning when animations are off; SillyBunny stops it under reduced motion and shows its still arc, because the Reduced Motion Rule removes movement and the title carries the state. Review when libadwaita changes this behaviour. Existing loading views move to this form as each surface is rebuilt.
- **Progress (HIG Spinners, Progress Bars):** Show progress for any operation that takes more than about three seconds. A spinner for operations up to about thirty seconds, placed in or next to the control it relates to, shown only after a short delay, and one at a time. A progress bar with text for longer tasks, inline with the content it tracks.
- **Spinner (`AdwSpinner`, HIG Spinners):** A label beside the spinner can name the task, and a long wait can add progress to the label: a percentage, time left, or items done. The spinner scales between `16px` and `64px` to the space it is given, turns once in 1.2 seconds on a track at 15% in the body colour, with a stroke of one eighth of its size (`2px` at `16px`), and draws a still arc when it is not moving. It is announced as a progress indicator that is busy. A spinner fades to the disabled strength when its control is disabled. Existing spinning glyphs move to the shared spinner as each surface is rebuilt.
- **Progress bar (HIG Progress Bars):** The bar shows the proportion done and the time remaining. The bar is `8px` high and at least `150px` wide, fully rounded, with an Accent fill on a trough at the trough strength; its text is smaller, dimmed and in tabular figures. A bar has text: units for a short task ("13 of 19 images rotated"), or the time left for a long one, with "About" when it is an estimate ("About 3 minutes left"). A task that overestimates pauses at 100% with "Almost done"; one that underestimates skips ahead. A bar with no known proportion (activity mode) is avoided, above all for long periods, and a bar changes mode as rarely as possible. Several simultaneous subtasks show one combined bar, unless each needs its own pause or stop. A task that is destructive or resource-heavy offers Pause and Cancel. Avoid a window that holds only a progress bar. A thin bar (`2px`, no trough, no text) attached to the bottom of the header bar suits background work.

#### Tooltips
- **Surface:** libadwaita OSD tooltip: shadow ink at 80%, white text, control radius, `1px` 10% white border. Used for hover titles and the touch press-and-hold label.
- **Metrics:** `6px 10px` padding and no shadow; the gap between an icon and text inside it is `6px`. The `1px` border of white at 10% keeps it from melting into a dark background. Existing tooltips move to these metrics as the tooltip layer is rebuilt.
- **Use (HIG Tooltips):** Every top-bar control has one. Elsewhere, use them only where they add information, and if one control in a container has a tooltip, all of them do. Tooltips never carry essential information, since touch and keyboard users may not see them. On touch, press-and-hold shows the label without triggering the action. Text is short and in header capitalisation, and does not repeat a visible label: "Back", "Search", "Main Menu".
- **Standard labels:** Back; Search (with the content type where useful: "Search Documents"); Main Menu for the primary menu; Menu for a secondary menu, naming the item where possible ("Document Menu"); New Tab; Bookmarks. Where a control has a visible label, the tooltip adds information or rephrases it ("Open…" with "Select a File"). Useful tooltips for content show the full address of a link or the message of a syntax error.

#### Notifications
- **Notifications (HIG Notifications):** A system notification tells the user about an event that matters to them while they use other applications: a long operation has finished, new content has arrived, a message was received. On the web they use the Notification API. Ask whether the user needs to be told at all, limit how often one shows (a periodic summary in place of one per message), offer a way to turn them off or reduce them, and remove a notification once it is no longer valid. Never rely on a notification alone: the window shows the same information. A notification has the application's icon, a title that summarises the event and is understood alone, in header capitalisation, an optional body in sentence capitalisation, a default action when it is pressed (dismiss it and show the relevant part of the window), and up to three buttons. A button relates to the content, is often needed, does not replace a control in the window and does not repeat the default action. A message that matters only while the application is in use is a toast.

### Chat Transcript

A transcript is a list of messages with its own row, action, and edit patterns.

- **Transcript:** A scrolling list of message rows on the View layer, with the composer below it. A sidebar list of transcripts stays in recency order; selecting one does not move it.
- **Message row:** A message shows its sender's name and optional avatar, then its content. A row that groups consecutive messages shows the avatar, name, and time on the first of a group only; a group breaks on a change of sender, a long gap, or a day boundary. A person's own messages may align to the end edge and others' to the start edge, with a reserved avatar slot on the start side.
- **Action row:** Actions sit in the message name row at the inline end; the name truncates before they move. A row that does not fit beside the name moves below it, and section dividers hide once it wraps. Targets use `--sb-message-hit-size`, icons `--sb-message-glyph-size`, and swipe arrows `--sb-message-icon-size`, and follow the touch-target rule: at least `44px` on coarse pointers and `32px` on fine pointers, in compact density too. The set of actions shown follows `(pointer: coarse)`, not the viewport width: a coarse pointer shows fewer actions, then the menu button, and every other action is in the menu. The menu button is the vertical ellipsis and always last. In every layout variant the action row keeps this contract; a mirrored row anchors its actions and menu to its start edge. An action row may be an overlaid toolbar that appears on hover or `:focus-within` on fine pointers; a coarse pointer gets a menu trigger beside the corner (reporting `aria-expanded`) instead, so a hover toolbar is never the only way to reach an action on touch. Existing action rows move to the pointer rule and the target sizes as each surface is rebuilt.
- **Action menu:** Every action not in the row is a labelled menu item with a dimmed icon. Sections are split by separators with no headings, ordered by importance: primary actions, copy, structure, tools, other items; then a destructive item alone, in Destructive Red.
- **Menu surface:** A popover anchored to the menu button, trailing-aligned, that flips above when there is no room below and stays inside the main content width. In the mobile layout it is a bottom sheet titled with the name of the item the menu belongs to, with Close, that traps focus. Focus returns to the menu button. Right-click on the name row, Shift+F10, and the Menu key open the same menu; long-press on message text does not, so text selection keeps working. It closes on action, Escape, outside tap, and when the content it belongs to changes, and the popover also on scroll. Arrow, Home, and End move between rows.
- **Edit row:** Cancel and Confirm first, then the item's edit actions in sections, with a destructive action alone and last in Destructive Red. Coarse pointers put them behind the menu button; fine pointers show them inline after a divider. At the ends of the transcript, Move up and Move down stay, disabled: the one exception to omitting items that do not apply. Edit buttons are flat circles whose text colour shows the role: success for Confirm, Destructive Red for Delete, the body colour for Cancel, and Accent otherwise. Cancel is neutral because Warning Yellow means caution, not cancel (HIG UI Styling). Hover and press use a `12%` and `20%` tint of the action's colour. Deviation: the HIG reserves strong colour for a single suggested or destructive button per view; SillyBunny colours several actions in one row, because each colour shows its action's role. Review when the HIG changes this rule.
- **Delete:** Deleting an item always confirms with the destructive alert (see Dialogs), whatever the user's confirmation setting, because it cannot be undone; Return never confirms a deletion.

## 9. Do's and Don'ts

### Do:
- **Do** keep main content uninterrupted and let configuration appear only after deliberate input.
- **Do** give every view at most one suggested or destructive button, then place powerful options behind learnable progressive disclosure.
- **Do** preserve SillyTavern-compatible settings, character data, chats, presets, extensions, and migration paths.
- **Do** use `SmartTheme*`, `sb-*`, `color-*`, spacing, and radius tokens so user themes continue to work.
- **Do** keep desktop and mobile gestures, ordering, labels, and action vocabulary consistent.
- **Do** provide visible focus, semantic labels, comfortable touch targets, resilient wrapping, and reduced-motion behavior.
- **Do** use tonal surfaces before shadows and verify text contrast before shipping.
- **Do** make every action possible with the keyboard as well as with a pointer or touch. Custom shortcuts use Ctrl with a letter, never Alt (reserved for access keys) or Super. Support the standard navigation keys on custom controls: Tab and Shift+Tab move focus, Ctrl+Tab moves it where Tab has another function (a text field), Return activates, Space toggles, F10 opens the primary or secondary menu, Menu or Shift+F10 opens the context menu for the focused item, and arrow keys move around a group of related controls. A control's label immediately precedes it in the focus order. Esc closes popovers, sheets, and dialogs (HIG Keyboard, Popovers, Windows).
- **Do** test every surface with a high-contrast or forced-colours mode, 200% text size, the keyboard alone, a screen reader, and an on-screen keyboard (HIG Accessibility). Every element has a short, descriptive accessible name.
- **Do** write UI text by the HIG Writing Style: short and neutral, familiar terms over system terms, "your" over "my" when ownership must be stated, no Latin abbreviations ("for example", not "e.g."), and no trailing period on labels, headings, or descriptions. An ellipsis (`…`, U+2026) ends a label only when more input or confirmation follows ("Delete…", not "Preferences…"). Never build one sentence from several strings or controls, so translations stay intact. Use typographic characters: “quotes”, ’ apostrophes, – ranges, × dimensions, a bullet `•` (U+2022) in an inline list, and a narrow no-break space (U+202F) between a number and its unit ("32 GB") (HIG Typography).
- **Do** translate each new counter or sentence as one string with placeholders, never joined fragments. Use `…`, never three periods, in new labels. Reuse existing upstream strings and keys verbatim, including trailing periods; the punctuation rule applies to new copy. Unsupplied descriptions, help, and dialog bodies use exactly `TODO(copy)`, marked with `data-sb-copy-placeholder="true"` and reported for maintainer replacement; do not draft project prose.

### Don't:
- **Don't** add configuration panels, extra toolbars, or utility panes to the main content view unless the user opens them. Navigation sidebars, split views, and utility panes follow the HIG (Navigation): each view keeps one clear subject, and panes collapse or overlay at narrow widths.
- **Don't** create a nested menu spiral: no nested submenus, and hierarchies generally one level deep below a view (HIG Menus, Navigation).
- **Don't** present configuration sprawl, bottom bar bloat, or a dense control wall by default.
- **Don't** interrupt the user's main task with a modal for non-critical configuration; try inline or progressive alternatives first.
- **Don't** rely on mystery meat navigation, hover-only discovery, desktop-only assumptions, tiny touch targets, or fragile iOS WebKit behavior.
- **Don't** use generic SaaS polish, sterile upstream-clone blandness, or decorative motion without navigational purpose, except an illustration moving in place (Motion).
- **Don't** use gradient text, decorative glassmorphism, backdrop blur on shell layers, ambient accent glows, repeating stripe or grid backgrounds, identical repeated card grids, or sketchy illustrations.
- **Don't** use `border-left` or `border-right` greater than `1px` as a colored accent.
- **Don't** pair a `1px` border with a shadow of `16px` blur or more on a resting surface. Overlays may keep one border and one overlay shadow.
- **Don't** use uppercase tracked kickers for group or list headings, or hover lift on buttons.
- **Don't** rely on tooltips, hover, or colour alone to carry essential information.
- **Don't** use radii above `20px` for cards or sections, or let long labels and headings overflow narrow viewports.
- **Don't** introduce new pure black or pure white surfaces, or silently overwrite compatible user configuration.
