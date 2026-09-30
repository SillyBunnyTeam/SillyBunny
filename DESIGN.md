---
name: SillyBunny
description: An LLM frontend designed for roleplay and storywriting that stays out of the user's way until called for.
colors:
  accent: "#82b3ee"
  accent-soft: "#7191b8"
  window-canvas: "#2f2f33"
  view: "#1d1d20"
  ink-panel: "#222226"
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
    fontFamily: "Adwaita Sans, Noto Sans, sans-serif"
    fontSize: "calc(var(--mainFontSize) * 1.72)"
    fontWeight: 700
    lineHeight: 1.12
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Adwaita Sans, Noto Sans, sans-serif"
    fontSize: "calc(var(--mainFontSize) * 1.45)"
    fontWeight: 700
    lineHeight: 1.16
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Adwaita Sans, Noto Sans, sans-serif"
    fontSize: "calc(var(--mainFontSize) * 0.92)"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "0"
  body:
    fontFamily: "Adwaita Sans, Noto Sans, sans-serif"
    fontSize: "var(--mainFontSize)"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "0"
  label:
    fontFamily: "Adwaita Sans, Noto Sans, sans-serif"
    fontSize: "calc(var(--mainFontSize) * 0.72)"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "0.04em"
  mono:
    fontFamily: "Adwaita Mono, Noto Sans Mono, Consolas, monospace"
    fontSize: "calc(var(--mainFontSize) * 0.84)"
    fontWeight: 400
    lineHeight: 1.45
rounded:
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
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.shadow-ink}"
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
    textColor: "{colors.shadow-ink}"
    rounded: "{rounded.pill}"
    size: "38px"
  input-field:
    backgroundColor: "{colors.ink-panel}"
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
    backgroundColor: "{colors.ink-panel}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "4px"
  chip-enabled:
    backgroundColor: "{colors.panel-hover}"
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
    textColor: "{colors.shadow-ink}"
    rounded: "30%"
    size: "clamp(0.92rem, calc(0.78rem + 0.38vw), calc(var(--mainFontSize) + 0.12rem))"
  radio-checked:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.shadow-ink}"
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

**Key Characteristics:**
- Content-first chat viewport with no unsolicited permanent configuration panels.
- Familiar controls that disclose depth through deliberate input, not visual noise.
- Guided animations that promote accessibility and intuitive motion.
- Stable desktop and mobile interaction vocabulary, including WebKit-safe shell behavior.
- Personality expressed through usefulness and built-in assistants and characters.

## 2. Colours

The palette is a neutral base for customisation and exploration: the accent dictates user interaction. Values follow the official libadwaita dark style (the bundled Libadwaita theme); Libadwaita Light maps the same roles onto the libadwaita light style. The default accent is libadwaita blue (`#3584e4`).

### Primary
- **Accent** (`#82b3ee`): The default accent, derived from the theme's quote and body colours (`--sb-accent`), so it follows the user's theme. With the Libadwaita theme the quote colour is libadwaita blue `#3584e4`. Used for suggested actions (primary and send), checked checkboxes and radios, the range thumb, focus rings, the selected-item icon, and important agent state. Use it as a signal, never as ambient ornament.
- **Soft Accent** (`#7191b8`): Secondary accent for quiet helper states and badges. Selected backgrounds use neutral fills, not Soft Accent.

### Secondary
These are libadwaita's standalone status colours. The light style uses `#007c3d`, `#c30000`, and `#905400`, switched by `data-sb-surface-tone='light'`.
- **Success Green** (`#78e9ab`): Positive completion and healthy connection feedback. It must not compete with Accent for primary actions.
- **Destructive Red** (`#ff938c`): Destructive actions and errors that require attention.
- **Warning Yellow** (`#ffc252`): Caution and transient operational warnings.

### Neutral
- **Window Canvas** (`#2f2f33`): The page behind the chat column, one tone lighter than the view so the content column always reads as its own surface (libadwaita window behind view). Derived as 94% blur tint and 6% body colour.
- **View** (`#1d1d20`): The chat column and message surface (`--SmartThemeChatTintColor`, libadwaita `view-bg-color`).
- **Ink Panel** (`#222226`): The shell surface: top bar, composer, fields, drawers, and opaque popovers and sheets (`--SmartThemeBlurTintColor`, libadwaita `window-bg-color`).
- **Raised Panel** (`#38383c`): `--sb-raised-bg` (10% body colour) over Ink Panel. Raised pills and circles, the search entry, reasoning headers, and the bottom chat bar selects.
- **Hover Panel** (`#434347`): `--sb-raised-hover-bg` (15% body colour) over Ink Panel. Hover response for raised controls; never a resting background.
- **Foreground** (`#ffffff`): Primary text and readable control labels.
- **Dim Foreground** (`#c6c6c7`): `--sb-muted-fg` (74% body colour) over Ink Panel. Supporting text only when contrast remains accessible; never the sole carrier of meaning.
- **Shadow Ink** (`#000006`): Shadow tint. Text on a solid accent uses `--sb-on-solid-accent`, which resolves to black or white for contrast. Do not introduce new pure black or pure white surfaces.

Settings groups and preference cards use a 4% body-colour tint rather than a named panel colour. Flat controls use the fills in the Flat Fill Vocabulary.

### Named Rules
**The Signal Scarcity Rule.** Accent appears for action, selection, focus, or meaningful state. If removing it does not reduce comprehension, remove it.

**The Theme Alias Rule.** New work consumes `SmartTheme*`, `color-*`, `sb-*`, spacing, and radius aliases. Do not hard-code a new color that bypasses saved user themes.

**The Contrast Rule.** Body and placeholder text target at least 4.5:1 contrast; large text targets at least 3:1. Muted text can be quiet, but never illegible.

**The Single Shell Rule.** The shell has one libadwaita direction; there is no Shell Style picker, and stored legacy `sb-theme` values are ignored. UI themes, custom CSS, and the accent colour are the theming surface.

## 3. Typography

**Display Font:** Adwaita Sans (with Noto Sans fallback)

**Body Font:** Adwaita Sans (with Noto Sans fallback)

**Mono Font:** Adwaita Mono for logs, prompt fragments, regex, token diagnostics, and structured output.

**Character:** One dependable sans keeps chat, shell navigation, settings, and onboarding in the same voice. Weight and spacing create hierarchy; the interface does not need a decorative display face.

### Hierarchy
- **Display** (700, `calc(var(--mainFontSize) * 1.72)`, 1.12, `-0.02em`): Home and first-run welcome titles only; never a control label.
- **Headline** (700, `calc(var(--mainFontSize) * 1.45)`, 1.16, `-0.015em`): Shell titles and major opened-panel headings.
- **Title** (700, `calc(var(--mainFontSize) * 0.92)`, 1.3): Setting groups, action rows, cards, and compact headings.
- **Body** (400, `var(--mainFontSize)`, 1.55): Chat-adjacent explanation, tutorials, and settings prose. Keep prose near 65-75ch where the surface permits.
- **Label** (700, `calc(var(--mainFontSize) * 0.72)`, 1.35, `0`): Compact metadata and state labels in sentence case.
- **Mono** (400, `calc(var(--mainFontSize) * 0.84)`, 1.45): Technical content where alignment and literal text matter.

### Named Rules
**The Interface Sans Rule.** Use Adwaita Sans or its fallback stack for controls, tabs, labels, and dense settings. Decorative type must never make repeated work harder.

**The User Scale Rule.** Product type follows `--mainFontSize` and existing user preferences. Do not add viewport-driven type or a parallel density system.

**The Wrap Safety Rule.** Headings use balanced wrapping where supported, and all labels must tolerate long translations, zoom, and narrow mobile widths without overflow.

**The Sentence Case Rule.** Group headings, list headings, and labels use bold sentence case with dimmed icons, as libadwaita preference groups do. No uppercase tracked kickers.

## 4. Elevation

SillyBunny uses tonal layering first and restrained shadows second. The main chat surface stays visually calm. A shadow is reserved for an opened shell or an overlay that must sit above the conversation. Resting surfaces never pair a border with a shadow as decoration; overlays (popovers, sheets, drawers, modals) may keep a `1px` border with one overlay shadow, as libadwaita popovers do.

### Shadow Vocabulary
- **Shell Shadow** (`--sb-shell-shadow`: `0 24px 60px color-mix(in srgb, var(--SmartThemeShadowColor) 20%, transparent)` in the pinned direction): The opened configuration shell.
- **Overlay Shadow** (`0 8px 24px` to `0 12px 32px` at `24-30%` shadow colour): Popovers, the search results list, the persona picker, and sheets above chat. One shadow per overlay.
- **Focus Ring** (`--sb-focus-ring-inset`: `inset 0 0 0 2px color-mix(in srgb, var(--sb-focus-ring) 78%, transparent)`): The only focus treatment for buttons, tabs, and fields. Do not stack it with an outline or an outer ring. Checkboxes, radios, and ranges use a `2px` `--sb-focus-ring` outline with an offset instead.

### Flat Fill Vocabulary
Flat and raised controls use fills mixed from `--SmartThemeBodyColor`, so they follow light and dark themes without a new color.
- **Flat:** `--sb-flat-hover-bg` (7%), `--sb-flat-active-bg` (16%), `--sb-flat-selected-bg` (10%), and `--sb-flat-selected-hover-bg` (13%).
- **Raised:** `--sb-raised-bg` (10%), `--sb-raised-hover-bg` (15%), and `--sb-raised-active-bg` (22%).
- **Toolbars:** The top bar, bottom chat bar, and composer are separated by a `1px` border only, with no blurred drop shadow. On desktop the bottom chat bar and composer join into one stack split by a `1px` hairline. The generating state keeps its accent border and progress bar and has no outer glow.

### Named Rules
**The Layer Before Shadow Rule.** Establish a tonal surface before adding elevation. If a shadow is doing all the work, the surface token is wrong.

**The Flat Toolbar Rule.** Toolbar and navigation buttons are transparent at rest. Hover, press, and selection use neutral fills mixed from the body color, with no borders, bottom stripes, underlines, glows, or hover lift. Hover fills apply only under `(hover: hover)`.

**The State-Only Motion Rule.** Use the existing 180ms and 240ms ease-out transitions for hover, focus, active, reveal, loading, and feedback. No decorative choreography, bounce, or motion that delays a task. Every transition has a reduced-motion path.

**The WebKit Reliability Rule.** Prefer solid or near-solid surfaces on mobile. Fixed layers must respect safe areas, keyboard resizing, scrolling, and focus behavior in Safari/WebKit.

## 5. Components

### Buttons
- **General shape:** Rounded rectangle at `14px`; general icon-only controls use `10px`.
- **Shell navigation:** Top-bar destinations, shell section triggers, back/close controls, and chat-navigation actions use a full pill radius (`999px`). Icon-only shell actions are circular. Controls are at least `44px` on coarse pointers and may be `40px` on fine pointers. This shared vocabulary applies on desktop and mobile while each layout keeps its appropriate density and navigation pattern.
- **Primary:** A libadwaita suggested action: Accent background, `--sb-on-accent` text, `38px` minimum height, and `10px 14px` padding. Hover lightens the fill slightly; there is no lift. It is the single primary action in a view.
- **Hover / Focus:** Flat toolbar buttons (header bar, composer, bottom chat bar, conversation mode) are transparent at rest and show a neutral fill (~7% body color) on hover, gated behind `@media (hover: hover)`. Pressed and selected states use heavier fills (~10-16%). Focus-visible shows an inset ring with no outer glow. Raised buttons (shell close, mobile nav back/trigger) use a subtle tonal fill at rest.
- **Composer extension rows:** Guided Generations and input-history buttons are flat, borderless, and circular (`999px`), with the same neutral hover and press fills. An active guide keeps its `1px` inset quote-color ring as the state cue.
- **Suggested action:** Send buttons (roleplay and Conversation) are icon-only solid-accent circles with `--sb-on-solid-accent` ink. When disabled they switch to a neutral raised fill with dimmed body ink, never a faded accent.
- **Settings sheets:** Conversation settings groups are borderless tonal cards with bold sentence-case headings and dimmed icons. Buttons inside are borderless raised pills; the sheet close is a flat circle; selected day pills use a solid accent fill.
- **Edit actions:** Message and reasoning edit buttons are flat circles with the semantic color as text (success for confirm, warning for cancel, danger for delete, accent otherwise). Hover and press use a `12%` and `20%` tint of that color.
- **Secondary / Ghost:** Generic `.menu_button`s use a `4%` body-colour fill (`--sb-button-bg`), Foreground, and the upstream one-pixel theme border, at the same height and padding as the primary family. Hover deepens the fill to `8%`. New shell work should prefer the borderless raised or flat fills.
- **States:** Default, hover, focus-visible, active, disabled, loading, and error are explicit. Labels describe the action; icons alone are not enough for essential controls. Selected tabs and nav items use a neutral fill without a bottom accent stripe or inset shadow.

### Chips
- **Style:** Compact rounded controls at `14px`, `6px 8px` padding, readable text, and a tonal background.
- **State:** Enabled or selected chips use a restrained Accent tint and status icon. Inactive chips remain legible and low emphasis.
- **Use:** In-chat agent controls and metadata only; do not turn the bottom bar into a chip collection.

### Cards / Containers
- **Corner Style:** `14px` for preference groups, popovers, and working containers; `16px` for the composer and toolbar stack; `20px` for a distinct welcome surface; no larger radius for a card or section.
- **Background:** Preference groups are libadwaita boxed lists: a `4%` body-colour tint over Ink Panel. Popovers and sheets are opaque Ink Panel so text never shows through.
- **Shadow Strategy:** Flat at rest. Only overlays carry a shadow.
- **Border:** Preference groups are borderless. Overlays keep a one-pixel theme-derived border. Never use a colored side stripe.
- **Internal Padding:** `12px`, `14px`, `16px`, or `18px` according to density; compact mode reduces padding without changing hierarchy.
- **Content Rule:** Cards are working surfaces, not a repeated icon-heading-text grid. Prefer an open list, tab row, or inline section when that is clearer.

### Inputs / Fields
- **Style:** Ink Panel background (`--sb-input-bg`), one-pixel theme border, `14px` radius, `46px` default height, and `12px` inline padding.
- **Focus:** Border shifts toward Accent, the fill takes a faint accent tint, and the field receives the inset focus ring.
- **Error / Disabled:** Destructive Red uses a readable tint and explicit text; disabled fields preserve label and layout context rather than disappearing.
- **Mobile:** Controls meet the `44px` touch target contract on coarse pointers and remain usable with the software keyboard open.
- **Bottom chat bar:** The chat select and the mobile chat chip are borderless raised pills (`--sb-raised-*` fills). The search field is a borderless neutral pill. Both show the inset focus ring. The persona bubble has no border or scale; hover adds a neutral `2px` ring. On desktop the bar and composer join into one toolbar stack split by a `1px` hairline, unless group speaker controls or the delete dialog sit between them.
- **Global search:** The entry is a borderless raised pill over an opaque base, with the inset focus ring. Results sit in an opaque popover with a `1px` border and one overlay shadow. Rows are flat, `10px` radius, and filled only on hover, press, or keyboard selection. Group headings use dimmed sentence case.

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
- **Popover:** Opaque raised surface, `14px` radius, no transparency over message text. It flips above when there is no room below, stays inside the chat width, and closes on outside tap, scroll, action, Escape, generation start, and chat change. Arrow, Home, and End keys move focus inside it.
- **Labels:** Icon-only actions keep a `title` or `aria-label`. On touch, press-and-hold shows that label as a tooltip without triggering the action.
- **Touch states:** Hover fills apply only under `(hover: hover)`; touch uses `:active` so fills do not stick after a tap.
- **Chat styles:** Every chat style keeps the same row contract. Mirrored user rows (echo, tide) anchor the actions and popover to their start edge.
- **Conversation chrome:** Rail, header, footer, and composer icon buttons are flat circles. Rail close is a raised circle. Send is the icon-only suggested-action circle. Pal, branch, persona, status, and add-DM rows use neutral hover and selected fills with no border or lift. Channel and tool tabs are flat pills. The workspace, rail, stage, and settings drawer are flat surfaces with no accent gradient; the drawer keeps its overlay shadow.
- **Conversation mode:** On desktop, message actions sit in an opaque pill toolbar that appears on hover or `:focus-within`, holding flat `28px` buttons. On mobile, a small ellipsis trigger with a `44px` hit area opens an inline tray of `44px` flat buttons (`40px` in compact mode). The trigger reports `aria-expanded`.

### Signature Surfaces
- **Composer:** The bottom bar stays available for writing, keeps the textarea central, and scales to keyboard and safe-area changes without covering chat. On desktop it joins the bottom chat bar into one toolbar stack.
- **Welcome Actions:** Home and first-run shortcuts may use a centered icon and text, but they remain sparse, labelled, and helpful rather than decorative.
- **Companion Agent Panel:** A sidecar workspace preserves chat visibility and exposes source context plus regenerate, edit, copy, delete, and manual-run actions without nested modal chains.

## 6. Do's and Don'ts

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
- **Don't** use gradient text, decorative glassmorphism, repeating stripe or grid backgrounds, identical repeated card grids, or sketchy illustrations.
- **Don't** use `border-left` or `border-right` greater than `1px` as a colored accent.
- **Don't** pair a `1px` border with a shadow of `16px` blur or more on a resting surface; choose tonal separation, a border, or a restrained shadow. Overlays may keep one border and one overlay shadow.
- **Don't** use uppercase tracked kickers for group or list headings, or hover lift on buttons.
- **Don't** use card or section radii above `20px`, or let long labels and headings overflow narrow viewports.
- **Don't** introduce new pure black or pure white surfaces, or silently overwrite compatible user configuration.
