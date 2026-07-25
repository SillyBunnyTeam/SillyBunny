---
name: SillyBunny
description: A quiet, malleable roleplay workspace that keeps the character and conversation in front.
colors:
  warm-signal: "#c9c6a8"
  warm-signal-soft: "#a6a493"
  charcoal-canvas: "#1b1f26"
  ink-panel: "#1d2128"
  panel-raised: "#2f3238"
  panel-hover: "#393d41"
  linen-text: "#cfcfc5"
  muted-linen: "#999992"
  shadow-ink: "#050607"
  success: "#f3c985"
  danger: "#fb7185"
  warning: "#facc15"
typography:
  display:
    fontFamily: "Figtree, Noto Sans, sans-serif"
    fontSize: "calc(var(--mainFontSize) * 1.72)"
    fontWeight: 700
    lineHeight: 1.12
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Figtree, Noto Sans, sans-serif"
    fontSize: "calc(var(--mainFontSize) * 1.45)"
    fontWeight: 700
    lineHeight: 1.16
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Figtree, Noto Sans, sans-serif"
    fontSize: "calc(var(--mainFontSize) * 0.92)"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "0"
  body:
    fontFamily: "Figtree, Noto Sans, sans-serif"
    fontSize: "var(--mainFontSize)"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "0"
  label:
    fontFamily: "Figtree, Noto Sans, sans-serif"
    fontSize: "calc(var(--mainFontSize) * 0.72)"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "0.04em"
  mono:
    fontFamily: "Noto Sans Mono, Courier New, Consolas, monospace"
    fontSize: "calc(var(--mainFontSize) * 0.84)"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  sm: "10px"
  md: "14px"
  lg: "16px"
  xl: "20px"
  pill: "999px"
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
    backgroundColor: "{colors.warm-signal}"
    textColor: "{colors.shadow-ink}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
    height: "38px"
  button-ghost:
    backgroundColor: "{colors.ink-panel}"
    textColor: "{colors.linen-text}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
    height: "38px"
  input-field:
    backgroundColor: "{colors.ink-panel}"
    textColor: "{colors.linen-text}"
    rounded: "{rounded.md}"
    padding: "12px"
    height: "46px"
  shell-tab-active:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.linen-text}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
    height: "44px"
  card-surface:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.linen-text}"
    rounded: "{rounded.lg}"
    padding: "16px"
  chip-enabled:
    backgroundColor: "{colors.panel-hover}"
    textColor: "{colors.linen-text}"
    rounded: "{rounded.md}"
    padding: "6px 8px"
---

# Design System: SillyBunny

## 1. Overview

**"Simple by default, powerful when needed"**

Picture a person writing at night with one conversation open, the rest of the desk cleared away, and a small set of tools within reach when needed. SillyBunny is a product UI, not a showcase surface: the character, messages, and composer own the visual priority. The shell is deliberately quiet so it can recede during active roleplay and become useful on demand.

The system carries personality through helpful wording, tactile feedback, and a warm signal accent rather than decoration. It makes complexity available without making it ambient: configuration belongs behind the header, sub-category tabs reveal the next layer, and each view has one primary action. The default charcoal theme is only the starting point; every visual token must remain compatible with user themes and SillyTavern data, presets, extensions, and settings.

The physical scene is a focused writing session on a dim screen, where the user needs comfortable contrast, predictable touch targets, and no panel competing with the conversation. This system rejects UI creep, nested menu spirals, configuration sprawl, bottom bar bloat, mystery meat navigation, desktop-only assumptions, and generic SaaS polish.

**Key Characteristics:**
- Content-first chat viewport with no unsolicited permanent configuration panels.
- Restrained charcoal, linen, and warm-signal palette with user-theme aliases.
- Familiar controls that disclose depth through deliberate input, not visual noise.
- Stable desktop and mobile interaction vocabulary, including WebKit-safe shell behavior.
- Personality expressed through usefulness, especially in Home, agents, onboarding, and helper states.

## 2. Colors

The palette is a restrained dark neutral system: warm signal is scarce and meaningful, while charcoal layers separate working surfaces without pretending to be decoration.

### Primary
- **Warm Signal** (`#c9c6a8`): Primary action, current selection, focus confirmation, active tab cue, range thumb, and important agent state. Use it as a signal, never as ambient ornament.
- **Soft Signal** (`#a6a493`): Secondary accent for quiet helper states, badges, and low-emphasis selected backgrounds.

### Secondary
- **Success Gold** (`#f3c985`): Positive completion and healthy connection feedback. It must not compete with Warm Signal for primary actions.
- **Danger Rose** (`#fb7185`): Destructive actions and errors that require attention.
- **Warning Amber** (`#facc15`): Caution and transient operational warnings.

### Neutral
- **Charcoal Canvas** (`#1b1f26`): Deep application foundation and the lowest visual layer.
- **Ink Panel** (`#1d2128`): Chat, composer, field, and default shell surface.
- **Raised Panel** (`#2f3238`): Explicitly opened shell panels, setting groups, tabs, and selectable surfaces.
- **Hover Panel** (`#393d41`): Hover and active response for controls; never an inactive background flood.
- **Linen Text** (`#cfcfc5`): Primary text and readable control labels.
- **Muted Linen** (`#999992`): Supporting text only when contrast remains accessible; never the sole carrier of meaning.
- **Shadow Ink** (`#050607`): Shadow tint and text on Warm Signal. Do not introduce new pure black or pure white surfaces.

### Named Rules
**The Signal Scarcity Rule.** Warm Signal appears for action, selection, focus, or meaningful state. If removing it does not reduce comprehension, remove it.

**The Theme Alias Rule.** New work consumes `SmartTheme*`, `color-*`, `sb-*`, spacing, and radius aliases. Do not hard-code a new color that bypasses saved user themes.

**The Contrast Rule.** Body and placeholder text target at least 4.5:1 contrast; large text targets at least 3:1. Muted text can be quiet, but never illegible.

## 3. Typography

**Display Font:** Figtree (with Noto Sans fallback)

**Body Font:** Figtree (with Noto Sans fallback)

**Label/Mono Font:** Noto Sans Mono for logs, prompt fragments, regex, token diagnostics, and structured output.

**Character:** One dependable sans keeps chat, shell navigation, settings, and onboarding in the same voice. Weight and spacing create hierarchy; the interface does not need a decorative display face.

### Hierarchy
- **Display** (700, `calc(var(--mainFontSize) * 1.72)`, 1.12, `-0.02em`): Home and first-run welcome titles only; never a control label.
- **Headline** (700, `calc(var(--mainFontSize) * 1.45)`, 1.16, `-0.015em`): Shell titles and major opened-panel headings.
- **Title** (700, `calc(var(--mainFontSize) * 0.92)`, 1.3): Setting groups, action rows, cards, and compact headings.
- **Body** (400, `var(--mainFontSize)`, 1.55): Chat-adjacent explanation, tutorials, and settings prose. Keep prose near 65-75ch where the surface permits.
- **Label** (700, `calc(var(--mainFontSize) * 0.72)`, 1.35, `0.04em`): Compact metadata and state labels; avoid making every section an uppercase eyebrow.
- **Mono** (400, `calc(var(--mainFontSize) * 0.84)`, 1.45): Technical content where alignment and literal text matter.

### Named Rules
**The Interface Sans Rule.** Use Figtree or its fallback stack for controls, tabs, labels, and dense settings. Decorative type must never make repeated work harder.

**The User Scale Rule.** Product type follows `--mainFontSize` and existing user preferences. Do not add viewport-driven type or a parallel density system.

**The Wrap Safety Rule.** Headings use balanced wrapping where supported, and all labels must tolerate long translations, zoom, and narrow mobile widths without overflow.

## 4. Elevation

SillyBunny uses tonal layering first and restrained shadows second. The main chat surface stays visually calm. A shadow is reserved for an opened shell, an overlay that must sit above the conversation, or a selected surface that needs clear separation. Borders and shadows are not paired as generic card decoration; choose the one that communicates the state.

### Shadow Vocabulary
- **Shell Shadow** (`0 8px 24px color-mix(in srgb, var(--SmartThemeShadowColor) 24%, transparent)`): Open configuration shell or fixed overlay that must separate from chat.
- **Panel Lift** (`0 4px 8px color-mix(in srgb, var(--SmartThemeShadowColor) 16%, transparent)`): Selected theme option or explicitly elevated welcome action; not every container.
- **Focus Ring** (`inset 0 0 0 2px color-mix(in srgb, var(--sb-focus-ring) 70%, transparent)`): Keyboard and focus-visible confirmation for controls.

### Named Rules
**The Layer Before Shadow Rule.** Establish a tonal surface before adding elevation. If a shadow is doing all the work, the surface token is wrong.

**The State-Only Motion Rule.** Use the existing 180ms and 240ms ease-out transitions for hover, focus, active, reveal, loading, and feedback. No decorative choreography, bounce, or motion that delays a task. Every transition has a reduced-motion path.

**The WebKit Reliability Rule.** Prefer solid or near-solid surfaces on mobile. Fixed layers must respect safe areas, keyboard resizing, scrolling, and focus behavior in Safari/WebKit.

## 5. Components

### Buttons
- **Shape:** Rounded rectangle at `14px`; icon-only controls use `10px`. Full pills are reserved for chips and status tags.
- **Primary:** Warm Signal background, Shadow Ink text, `38px` minimum height, and `10px 14px` padding. It is the single primary action in a view.
- **Hover / Focus:** Adjust tonal value and use a visible inset focus ring. Do not combine a 1px border with a wide shadow.
- **Secondary / Ghost:** Ink Panel background, Linen Text, one-pixel theme border, same height and padding as the primary family.
- **States:** Default, hover, focus-visible, active, disabled, loading, and error are explicit. Labels describe the action; icons alone are not enough for essential controls.

### Chips
- **Style:** Compact rounded controls at `14px`, `6px 8px` padding, readable text, and a tonal background.
- **State:** Enabled or selected chips use a restrained Warm Signal tint and status icon. Inactive chips remain legible and low emphasis.
- **Use:** In-chat agent controls and metadata only; do not turn the bottom bar into a chip collection.

### Cards / Containers
- **Corner Style:** `16px` for working containers, `20px` for a distinct welcome surface, and no larger radius for a card or section.
- **Background:** Ink Panel for default content and Raised Panel for an explicitly opened or selected layer.
- **Shadow Strategy:** Flat or bordered at rest; Panel Lift only for selection or necessary separation.
- **Border:** One-pixel theme-derived border when it improves grouping. Never use a colored side stripe.
- **Internal Padding:** `12px`, `14px`, `16px`, or `18px` according to density; compact mode reduces padding without changing hierarchy.
- **Content Rule:** Cards are working surfaces, not a repeated icon-heading-text grid. Prefer an open list, tab row, or inline section when that is clearer.

### Inputs / Fields
- **Style:** Ink Panel background, one-pixel theme border, `14px` radius, `46px` default height, and `12px` inline padding.
- **Focus:** Border shifts toward Warm Signal and receives the visible inset focus ring.
- **Error / Disabled:** Danger Rose uses a readable tint and explicit text; disabled fields preserve label and layout context rather than disappearing.
- **Mobile:** Controls meet the `44px` touch target contract on coarse pointers and remain usable with the software keyboard open.

### Navigation
- **Layer 1:** The main chat window is the primary surface with a bottom bar for direct conversation actions.
- **Layer 2:** An always-visible top bar holds Workspace, Customize, the customisable title, two quick-access positions, Home, and Characters. Essential main-content controls stay labelled and visible.
- **Layer 3:** Opened categories expose a single header-tab row and a configuration pop-down.
- **Layer 4:** Sub-category content contains the options for that category and at most one collapsible section.
- **Active State:** Use Raised Panel, a thin theme border, and a restrained bottom accent. Never use a thick left or right stripe.
- **Mobile:** Preserve the same destinations and ordering. Use fixed drawers only when requested, safe-area-aware sizing, touch targets, and no hover-only discovery.

### Signature Surfaces
- **Composer:** The bottom bar stays available for writing, keeps the textarea central, and scales to keyboard and safe-area changes without covering chat.
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
- **Don't** pair a `1px` border with a shadow of `16px` blur or more; choose tonal separation, a border, or a restrained shadow.
- **Don't** use card or section radii above `20px`, or let long labels and headings overflow narrow viewports.
- **Don't** introduce new pure black or pure white surfaces, or silently overwrite compatible user configuration.
