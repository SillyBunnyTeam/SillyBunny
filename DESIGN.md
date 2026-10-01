---
name: SillyBunny
description: An LLM frontend designed for roleplay and storywriting that stays out of the user's way until called for.
colors:
  accent: "#82b3ee"
  accent-soft: "#7191b8"
  on-accent: "#000000"
  view: "#1d1d20"
  window: "#222226"
  window-canvas: "#2f2f33"
  headerbar: "#2f2f33"
  popover: "#38383c"
  toast: "#4e4e52"
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

# Design System: SillyBunny

## 1. Overview

**"Simple by default, powerful when needed"**

SillyBunny is an LLM roleplay client that best embodies KDE Plasma's driving philosophy alongside the HIG (human interface guidelines) of the GNOME project. Although great inspiration is taken from these projects, SillyBunny still stands on its own with a slight sense of whimsy based on its focus on roleplay and storywriting. The shell is deliberately kept out of the way so the user can focus on the main content until configuration and navigation are needed.

Helpful wording, tactile and easily glanceable feedback, and deliberate purpose define the shell. Complex configuration remains available to the user if they wish to seek it (as per upstream SillyTavern), but a good default experience is mandatory and implied. Configuration remains behind the shell at all times until called for. All elements of the shell must remain themeable with user CSS themes, and be fully compatible with SillyTavern data, presets, extensions, and settings.

The design philosophies of libadwaita should always be taken into consideration. This means accessibility through lack of distractions, animations that guide the user to what is clicked/tapped, responsive layouts, predictable touch targets, and nothing getting in the way of the main user experience. Mobile design must remain purposefully designed alongside the desktop, adapting libadwaita to a smaller and more touch-heavy window.

With this in mind, SillyBunny can inject its own fun in the design too. After all, it is a roleplay and storywriting client at heart. Included tutorial characters are helpful yet creatively fun to interact with.

This system rejects UI creep, nested menu spirals, configuration sprawl, bottom bar bloat, mystery meat navigation, desktop-only assumptions, and generic SaaS polish.

**Reference version:** libadwaita 1.7+ (values checked against the 1.10.0 stylesheet). Where SillyBunny deviates, the deviation is stated next to the value.

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
| Window | `--sb-layer-window` | `--SmartThemeBlurTintColor` | `#222226` | `#fafafb` | `window-bg` |
| Canvas | `--sb-layer-canvas` | BlurTint 90% + Body 10% | `#38383c` (approx.) | `#e3e3e5` (approx.) | `sidebar-bg` |
| Header bar | `--sb-layer-headerbar` | Same as canvas; light uses ChatTint | `#38383c` (approx.) | `#ffffff` | `headerbar-bg` |
| Shell drawer | `--sb-layer-drawer` | Same as header bar; light uses BlurTint | `#38383c` (approx.) | `#fafafb` | `headerbar-bg` / `dialog-bg` |
| Popover | `--sb-layer-popover` | BlurTint 90% + Body 10%; light uses ChatTint | `#38383c` | `#ffffff` | `popover-bg` |
| Dialog | `--sb-layer-dialog` | BlurTint 90% + Body 10%; light uses BlurTint | `#38383c` | `#fafafb` | `dialog-bg` |
| Toast | `--sb-layer-toast` | BlurTint 80% + Body 20% | `#4e4e52` | inverse dark | toast `#505053` |

- **The chat column** is View. The canvas behind it, the top bar, and the composer are one tone lighter in dark mode, so the content column always reads as its own surface. In light mode the top bar and composer are white over a grey canvas and are separated by a shade line, as libadwaita header bars are.
- **The top bar is a flat libadwaita headerbar.** SillyBunny is chat-first, so the headerbar recedes and messages, the composer, and the character list carry the visual weight. In dark mode it shares the canvas tone and separates from the chat column by tone and the header bar shade; in light mode it is white over the grey canvas. Do not raise it into a heavier, toolbar-style band.
- **Shell drawers** continue the top bar. They separate from the view by tone and one overlay shadow, not by a heavy shadow or blur.
- **Popovers, menus, and dialogs** are the lightest opaque layer in dark mode. In light mode they rely on a border and shade.
- **Raised Panel** (`#38383c`) and **Hover Panel** (`#434347`) are `--sb-raised-bg` (10%) and `--sb-raised-hover-bg` (15%) over Window. Raised Panel is a control fill, not a layer.
- **Foreground** (`#ffffff`) and **Dim Foreground** (`#c6c6c7`, `--sb-muted-fg`, 74% body colour). Dim text is never the sole carrier of meaning.
- **Shadow Ink** (`#000006`): Shade and shadow tint only. Never a text colour.

Settings groups and preference cards use a 4% body-colour tint (libadwaita dark cards use 8%; the page content keeps 4% until pages are migrated). Flat controls use the fills in the Flat Fill Vocabulary.

### Named Rules
**The Signal Scarcity Rule.** Accent appears for action, selection, focus, or meaningful state. If removing it does not reduce comprehension, remove it.

**The Theme Alias Rule.** New work consumes `SmartTheme*`, `color-*`, `sb-*`, spacing, and radius aliases. Do not hard-code a new color that bypasses saved user themes.

**The Contrast Rule.** Body and placeholder text target at least 4.5:1 contrast; large text targets at least 3:1. Muted text can be quiet, but never illegible.

**The Opaque Shell Rule.** Header bars, drawers, popovers, menus, dialogs, and toasts are opaque. No `backdrop-filter` on shell layers; background images may show only through the canvas and the chat column at the theme's own tint alpha.

**The Single Shell Rule.** The shell has one libadwaita direction; there is no Shell Style picker, and stored legacy `sb-theme` values are ignored. UI themes, custom CSS, and the accent colour are the theming surface.

## 3. Typography

**Interface Font:** Adwaita Sans, then `system-ui`, Noto Sans, and the platform sans stack (`--mainFontFamily`).

**Mono Font:** Adwaita Mono for logs, prompt fragments, regex, token diagnostics, and structured output (`--monoFontFamily`).

**Character:** One dependable sans keeps chat, shell navigation, settings, and onboarding in the same voice. Weight and size create hierarchy. libadwaita uses no letter-spacing; new work sets none, and the legacy `--sb-tracking-label` and `--sb-tracking-kicker` tokens stay only until the remaining uppercase labels are reworked.

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
- **Label:** Compact metadata and state labels in sentence case. Dimmed labels use `--sb-muted-fg`, the equivalent of `.dimmed` (55% in libadwaita, raised to 74% for contrast). Deviation: kept at 0.72 instead of libadwaita's 0.82 to avoid overflow in tight shell layouts like tab labels and conversation metadata.

### Named Rules
**The Interface Sans Rule.** Use the interface stack for controls, tabs, labels, and dense settings. Decorative type must never make repeated work harder.

**The User Scale Rule.** Product type follows `--mainFontSize` and existing user preferences. Do not add viewport-driven type or a parallel density system.

**The Wrap Safety Rule.** Headings use balanced wrapping where supported, and all labels must tolerate long translations, zoom, and narrow mobile widths without overflow.

**The Sentence Case Rule.** Group headings, list headings, and labels use bold sentence case with dimmed icons, as libadwaita preference groups do. No uppercase tracked kickers.

## 4. Elevation

SillyBunny uses tonal layering first and restrained shadows second. The main chat surface stays visually calm. A shadow is reserved for an opened shell or an overlay that must sit above the conversation. Resting surfaces never pair a border with a shadow as decoration; overlays (popovers, sheets, drawers, dialogs) keep a `1px` border with one overlay shadow, as libadwaita popovers do.

### Shadow Vocabulary
All shadows mix `--SmartThemeShadowColor`, so themes control the ink.
- **Header bar shade** (`--sb-headerbar-shade`): a `1px` line at the bottom of the top bar and the top of the composer. No blurred shadow.
- **Popover Shadow** (`--sb-shadow-popover`): `0 1px 5px 1px` and `0 2px 14px 3px` at low shade alpha, plus the `1px` border. Menus, select dropdowns, the search results list, the persona picker, and message popovers.
- **Dialog Shadow** (`--sb-shadow-dialog`): `0 0 14px 2px` and `0 0 5px 2px` at low shade alpha, plus the `1px` border and, in dark mode, a `1px` inner highlight. Dialogs and shell drawers.
- **Dialog Backdrop** (`--sb-dialog-backdrop`): shade colour at about 50% (dark) or 14% (light). No backdrop blur.
- **Toast Shadow** (`--sb-shadow-toast`): `0 1px 3px 1px` and `0 2px 6px 2px` at low shade alpha.
- **Focus Ring** (`--sb-focus-ring-inset`: `inset 0 0 0 2px` of `--sb-focus-ring`): The only focus treatment for buttons, tabs, menu rows, and fields. Do not stack it with an outline or an outer ring. Checkboxes, radios, and ranges use a `2px` `--sb-focus-ring` outline with an offset instead. Deviation: the ring is about 55% accent rather than libadwaita's 50% to keep 3:1 against both tones.

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
- **Shell navigation:** Top-bar destinations, shell section triggers, back/close controls, and chat-navigation actions use a full pill radius (`999px`). Icon-only shell actions are circular. Controls are at least `44px` on coarse pointers and may be `40px` on fine pointers. Deviation: libadwaita controls are `34px`; SillyBunny keeps larger targets for touch.
- **Primary:** A libadwaita suggested action: Accent background, `--sb-on-solid-accent` text, `38px` minimum height, and `10px 14px` padding. Hover changes the fill slightly; there is no lift. It is the single primary action in a view.
- **Hover / Focus:** Flat toolbar buttons (header bar, composer, bottom chat bar, conversation mode) are transparent at rest and show a neutral fill (7% body color) on hover, gated behind `@media (hover: hover)`. Pressed and selected states use heavier fills (10-16%). Focus-visible shows the inset ring with no outer glow. Raised buttons (shell close, mobile nav back/trigger) use a subtle tonal fill at rest.
- **Composer extension rows:** Guided Generations and input-history buttons are flat, borderless, and circular (`999px`), with the same neutral hover and press fills. An active guide keeps its `1px` inset quote-color ring as the state cue.
- **Suggested action:** Send buttons (roleplay and Conversation) are icon-only solid-accent circles with `--sb-on-solid-accent` ink. When disabled they switch to a neutral raised fill with dimmed body ink, never a faded accent.
- **Settings sheets:** Conversation settings groups are borderless tonal cards with bold sentence-case headings and dimmed icons. Buttons inside are borderless raised pills; the sheet close is a flat circle; selected day pills use a solid accent fill.
- **Edit actions:** Message and reasoning edit buttons are flat circles with the semantic color as text (success for confirm, warning for cancel, danger for delete, accent otherwise). Hover and press use a `12%` and `20%` tint of that color.
- **Secondary / Ghost:** Generic `.menu_button`s use a `4%` body-colour fill (`--sb-button-bg`), Foreground, and the upstream one-pixel theme border, at the same height and padding as the primary family. Hover deepens the fill to `8%`. New shell work should prefer the borderless raised or flat fills.
- **States:** Default, hover, focus-visible, active, disabled, loading, and error are explicit. Labels describe the action; icons alone are not enough for essential controls. Selected tabs and nav items use a neutral fill without a bottom accent stripe or inset shadow.

### Chips
- **Style:** Compact rounded controls at `14px`, `6px 8px` padding, readable text, and a tonal background.
- **State:** Enabled or selected chips use a 16% Accent tint and a status icon. Inactive chips remain legible and low emphasis.
- **Use:** In-chat agent controls and metadata only; do not turn the bottom bar into a chip collection.

### Cards / Containers
- **Corner Style:** Content cards and preference groups keep `14px` until pages are migrated (libadwaita cards are `12px`, `--sb-radius-card`). Popovers, menus, dialogs, shell drawers, toasts, and the composer stack use `--sb-radius-overlay` (`15px`). Alert-style confirmation dialogs use `--sb-radius-alert` (`18px`). The welcome surface may use `20px`. Nothing is larger.
- **Background:** Preference groups are libadwaita boxed lists: a `4%` body-colour tint. Overlays use their layer token from the Layer Ladder so text never shows through.
- **Shadow Strategy:** Flat at rest. Only overlays carry a shadow.
- **Border:** Preference groups are borderless. Overlays keep a one-pixel theme-derived border. Never use a colored side stripe.
- **Internal Padding:** `12px`, `14px`, `16px`, or `18px` according to density; compact mode reduces padding without changing hierarchy.
- **Content Rule:** Cards are working surfaces, not a repeated icon-heading-text grid. Prefer an open list, tab row, or inline section when that is clearer.

### Menus and Popovers
- **Surface:** Popover layer, `15px` radius, `6px` padding, `1px` border, Popover Shadow.
- **Rows:** `34px` minimum height (`44px` on coarse pointers), `0 12px` padding, `9px` radius, full opacity text with dimmed icons. Hover uses the flat hover fill, press the flat active fill, keyboard focus the inset focus ring.
- **Dropdowns:** Select dropdowns and the search results list follow the same surface and row rules.

### Dialogs
- **Surface:** Dialog layer, `15px` radius (`18px` for confirmations), `1px` border, Dialog Shadow, Dialog Backdrop without blur.
- **Buttons:** Response buttons follow the primary and ghost families. The close button is a flat circle with at least a `34px` target.

### Toasts
- **Surface:** Toast layer with white ink in both tones, `15px` radius, Toast Shadow, no border.
- **Status:** Error, warning, and success toasts keep the toast layer and use the standalone status colour for the icon and title only.

### Tooltips
- **Surface:** libadwaita OSD tooltip: shadow ink at 80%, white text, `9px` radius, `1px` 10% white border. Used for hover titles and the touch press-and-hold label.

### Inputs / Fields
- **Style:** Window background (`--sb-input-bg`), one-pixel theme border, `14px` radius, `46px` default height, and `12px` inline padding.
- **Focus:** Neutral, not accent. The border strengthens to `--sb-entry-focus-border` (42% body colour) and the field receives a `1px` inset `--sb-entry-focus-ring` (22% body colour). The fill does not change. Buttons keep the accent focus ring.
- **Error / Disabled:** Destructive Red uses a readable tint and explicit text; disabled fields preserve label and layout context rather than disappearing.
- **Mobile:** Controls meet the `44px` touch target contract on coarse pointers and remain usable with the software keyboard open.
- **Bottom chat bar:** The chat select and the mobile chat chip are borderless raised pills (`--sb-raised-*` fills). The search field is a borderless neutral pill. Both show the inset focus ring. The persona bubble has no border or scale; hover adds a neutral `2px` ring. On desktop the bar and composer join into one toolbar stack split by a `1px` hairline, unless group speaker controls or the delete dialog sit between them.
- **Global search:** The entry is a borderless raised pill over an opaque base, with the inset focus ring. Results sit in a popover. Rows are flat, `9px` radius, and filled only on hover, press, or keyboard selection. Group headings use dimmed sentence case.

### Reasoning
- **Header:** A libadwaita expander row: neutral raised fill, `10px` radius, no border, inset focus ring. Desktop and mobile share one treatment.
- **Body:** Keeps the upstream thin left rule in the reasoning ink colour.

### Selection Controls
- **Checkbox:** Rounded square (radius `30%` of its size) with a `2px` neutral outline at rest. Checked fills solid Accent with a check glyph in `--sb-on-solid-accent`. No highlights, glow, or inner shadow.
- **Radio:** Circle with the same `2px` outline. Checked fills solid Accent with a centered dot in `--sb-on-solid-accent`. Segmented boolean radios (`.sb-boolean-radio-option`) keep their overlay input and are styled as the segment instead.
- **Range:** `4px` neutral trough and an `18px` Accent thumb with a `1px` shade. Firefox fills the trough up to the value; WebKit and Blink show the trough only. Hover grows the thumb slightly on hover-capable pointers.
- **Focus / Disabled:** Small controls use a `2px` focus-ring outline with an offset so the ring stays visible around the control. Disabled controls drop to reduced opacity and a `not-allowed` cursor.

### Navigation
- **Layer 1:** The main chat window is the primary surface with a bottom bar for direct conversation actions.
- **Layer 2:** An always-visible top bar holds Workspace, Customize, the customisable title, two quick-access positions, Home, and Characters. Essential main-content controls stay labelled and visible.
- **Layer 3:** Opened categories expose a single header-tab row and a configuration pop-down.
- **Layer 4:** Sub-category content contains the options for that category and at most one collapsible section.
- **Active State:** Use a neutral selected fill, with Accent on the icon where it helps. No border, bottom accent stripe, or underline. Never use a thick left or right stripe.
- **Mobile:** Preserve the same destinations, ordering, action names, and shell-control shapes. Use the mobile section hub and trigger menu in place of the desktop tab strip, safe-area-aware sheets, comfortable touch targets, and no hover-only discovery.
- **Desktop:** Keep the existing top-bar actions and chat-navigation rows visible. Users may hide the Guided Generations and Chat Navigation rows in settings; the shell restyle does not change that behavior.

### Message Actions
- **Placement:** Actions sit in the message name row, aligned to the inline end. The name truncates before the actions move. Desktop may wrap actions below a long name; mobile (`<=768px`) never wraps the row.
- **Sizing:** Use `--sb-message-hit-size` for the target and `--sb-message-glyph-size` for the icon. Mobile targets are `44px` (`40px` in compact mode). Swipe arrows keep `--sb-message-icon-size`.
- **Mobile row:** Overflow, Edit, and Delete only. Every other action, including bookmark and extension buttons, opens in an overflow icon-grid popover. The edit row is Overflow, Confirm, and Cancel.
- **Popover:** Popover layer, `14px` radius, no transparency over message text. It flips above when there is no room below, stays inside the chat width, and closes on outside tap, scroll, action, Escape, generation start, and chat change. Arrow, Home, and End keys move focus inside it.
- **Labels:** Icon-only actions keep a `title` or `aria-label`. On touch, press-and-hold shows that label as a tooltip without triggering the action.
- **Touch states:** Hover fills apply only under `(hover: hover)`; touch uses `:active` so fills do not stick after a tap.
- **Chat styles:** Every chat style keeps the same row contract. Mirrored user rows (echo, tide) anchor the actions and popover to their start edge.
- **Conversation chrome:** Rail, header, footer, and composer icon buttons are flat circles. Rail close is a raised circle. Send is the icon-only suggested-action circle. Pal, branch, persona, status, and add-DM rows use neutral hover and selected fills with no border or lift. Channel and tool tabs are flat pills. The workspace, rail, stage, and settings drawer are flat surfaces with no accent gradient; the drawer keeps its overlay shadow.
- **Conversation mode:** On desktop, message actions sit in an opaque pill toolbar that appears on hover or `:focus-within`, holding flat `28px` buttons. On mobile, a small ellipsis trigger with a `44px` hit area opens an inline tray of `44px` flat buttons (`40px` in compact mode). The trigger reports `aria-expanded`.

### Signature Surfaces
- **Composer:** The bottom bar stays available for writing, keeps the textarea central, and scales to keyboard and safe-area changes without covering chat. On desktop it joins the bottom chat bar into one toolbar stack on the header-bar layer.
- **Welcome Actions:** Home and first-run shortcuts may use a centered icon and text, but they remain sparse, labelled, and helpful rather than decorative.
- **Companion Agent Panel:** A sidecar workspace preserves chat visibility and exposes source context plus regenerate, edit, copy, delete, and manual-run actions without nested modal chains.
- **Paper Texture:** An opt-in grain over the canvas and chat column. It may add texture, but it must take its colours from the active theme and never override border or message tints.

## 7. Do's and Don'ts

### Do:
- **Do** keep main content uninterrupted and let configuration appear only after deliberate input.
- **Do** give every view one primary action, then place powerful options behind learnable progressive disclosure.
- **Do** preserve SillyTavern-compatible settings, character data, chats, presets, extensions, and migration paths.
- **Do** use `SmartTheme*`, `sb-*`, `color-*`, spacing, and radius tokens so user themes continue to work.
- **Do** keep desktop and mobile gestures, ordering, labels, and action vocabulary consistent.
- **Do** provide visible focus, semantic labels, comfortable touch targets, resilient wrapping, and reduced-motion behavior.
- **Do** use tonal surfaces before shadows and verify text contrast before shipping.

### Don't:
- **Don't** ship UI creep: persistent panels, sidebars, or toolbars in the active primary viewport.
- **Don't** create a nested menu spiral or more than one collapsible section at layer 4.
- **Don't** present configuration sprawl, bottom bar bloat, or a dense control wall by default.
- **Don't** interrupt active conversation with a modal for non-critical configuration; try inline or progressive alternatives first.
- **Don't** rely on mystery meat navigation, hover-only discovery, desktop-only assumptions, tiny touch targets, or fragile iOS WebKit behavior.
- **Don't** use generic SaaS polish, sterile upstream-clone blandness, or decorative motion without navigational purpose.
- **Don't** use gradient text, decorative glassmorphism, backdrop blur on shell layers, ambient accent glows, repeating stripe or grid backgrounds, identical repeated card grids, or sketchy illustrations.
- **Don't** use `border-left` or `border-right` greater than `1px` as a colored accent.
- **Don't** pair a `1px` border with a shadow of `16px` blur or more on a resting surface. Overlays may keep one border and one overlay shadow.
- **Don't** use uppercase tracked kickers for group or list headings, or hover lift on buttons.
- **Don't** use radii above `20px` for cards or sections, or let long labels and headings overflow narrow viewports.
- **Don't** introduce new pure black or pure white surfaces, or silently overwrite compatible user configuration.
