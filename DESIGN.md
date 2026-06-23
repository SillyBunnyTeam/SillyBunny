---
name: SillyBunny
description: Expressive creative roleplay workspace with a tactile, mobile-safe shell UI.
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
    lineHeight: 1.08
    letterSpacing: "0"
  headline:
    fontFamily: "Figtree, Noto Sans, sans-serif"
    fontSize: "calc(var(--mainFontSize) * 1.45)"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "0"
  title:
    fontFamily: "Figtree, Noto Sans, sans-serif"
    fontSize: "calc(var(--mainFontSize) * 0.92)"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "0"
  body:
    fontFamily: "Figtree, Noto Sans, sans-serif"
    fontSize: "var(--mainFontSize)"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "0"
  label:
    fontFamily: "Figtree, Noto Sans, sans-serif"
    fontSize: "calc(var(--mainFontSize) * 0.72)"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "0.08em"
  mono:
    fontFamily: "Noto Sans Mono, Courier New, Consolas, monospace"
    fontSize: "calc(var(--mainFontSize) * 0.84)"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  icon: "10px"
  button: "14px"
  md: "16px"
  lg: "22px"
  xl: "28px"
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
breakpoints:
  compact-desktop-max: "1000px"
  mobile-max: "768px"
  narrow-mobile-max: "620px"
  small-mobile-max: "420px"
components:
  button-primary:
    backgroundColor: "{colors.warm-signal}"
    textColor: "{colors.shadow-ink}"
    rounded: "{rounded.button}"
    padding: "10px 14px"
    height: "38px"
  button-ghost:
    backgroundColor: "{colors.ink-panel}"
    textColor: "{colors.linen-text}"
    rounded: "{rounded.button}"
    padding: "10px 14px"
    height: "38px"
  input-field:
    backgroundColor: "{colors.ink-panel}"
    textColor: "{colors.linen-text}"
    rounded: "{rounded.button}"
    padding: "12px"
    height: "46px"
  shell-tab-active:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.linen-text}"
    rounded: "{rounded.button}"
    padding: "8px 14px"
    height: "44px"
  card-surface:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.linen-text}"
    rounded: "{rounded.lg}"
    padding: "18px"
  chip-enabled:
    backgroundColor: "{colors.panel-hover}"
    textColor: "{colors.linen-text}"
    rounded: "{rounded.button}"
    padding: "6px"
---

# Design System: SillyBunny

## 1. Overview

**Creative North Star: "The Storyteller's Control Room"**

SillyBunny should feel like a creative control room for roleplay and storytelling: expressive enough to invite imagination, structured enough to keep the writer in flow, and practical enough to carry the full SillyTavern surface without making the first screen feel like a cockpit. The system uses warm signals against charcoal panels, rounded tactile controls, and atmospheric depth that helps separate chat, shell, onboarding, and agent work.

The product must preserve the PRODUCT.md line: "Express personality through usefulness." Personality belongs in onboarding, assistant surfaces, launchpad cards, and creative workflow affordances. Settings, API setup, presets, sampling, and server tools stay familiar, predictable, and compact.

This document is agent-facing design guidance, not release copy. Keep it aligned with README.md and PRODUCT.md, but do not use it to announce features or draft marketing language.

This system rejects needless complexity, generic SaaS polish, sterile upstream-clone blandness, hover-only discovery, tiny touch targets, and browser behavior that breaks on iOS WebKit.

**Key Characteristics:**
- Creative product UI, not a marketing surface.
- Dark charcoal default with warm signal accents and user-adjustable themes.
- Layered atmospheric panels: tonal surfaces first, restrained shadows second.
- Tactile and clear controls with stable dimensions and mobile-safe hit areas.
- Progressive complexity through shell panels, global search, compact mode, and launchpad guidance.

## 2. Colors

The palette is a Soft Console: charcoal surfaces, linen text, and a warm signal accent that reads like invitation, selection, and confidence rather than decoration.

### Primary

- **Warm Signal** (`warm-signal`): The primary accent for selected states, primary actions, active shell cues, range thumbs, focus rings, and important agent state. It should appear sparingly.
- **Soft Signal** (`warm-signal-soft`): A quieter accent for secondary glow, badges, helper chips, and background atmosphere.

### Secondary

- **Success Gold** (`success`): Success and positive status. Use as feedback, not as a competing brand color.
- **Danger Rose** (`danger`): Destructive actions, errors, and warnings that need stronger attention.
- **Warning Amber** (`warning`): Caution states and transient operational warnings.

### Neutral

- **Charcoal Canvas** (`charcoal-canvas`): The application background and deep page foundation.
- **Ink Panel** (`ink-panel`): Default panel, chat, composer, and shell surface base.
- **Raised Panel** (`panel-raised`): Elevated setting groups, inline drawers, cards, and control clusters.
- **Hover Panel** (`panel-hover`): Hover and active surface response.
- **Linen Text** (`linen-text`): Primary readable text.
- **Muted Linen** (`muted-linen`): Helper text, descriptions, metadata, placeholders, and disabled-adjacent labels.
- **Shadow Ink** (`shadow-ink`): Shadow and on-accent ink. New work should tint deep neutrals instead of adding pure black.

### Named Rules

**The Warm Signal Rule.** Warm Signal is for action, current selection, focus, and meaningful state. If it is being used as decoration, remove it.

**The Theme-Compatible Rule.** SillyBunny themes use `SmartTheme*` and `sb-*` CSS variables. New colors must flow through those variables or documented semantic aliases, not hard-coded one-off values.

**The Accent Profile Rule.** Custom accent profiles and theme settings are user state. Do not reset, rename, or reinterpret saved accent values without a compatibility path.

**The No Pure Extremes Rule.** Do not introduce new pure black or pure white surfaces. Tint darks toward the charcoal system and lights toward the linen system.

## 3. Typography

**Display Font:** Figtree, with Noto Sans fallback.
**Body Font:** Figtree, with Noto Sans fallback.
**Label/Mono Font:** Noto Sans Mono for code, prompt fragments, logs, counters, and technical diagnostics.

**Character:** Figtree keeps SillyBunny warm and modern without becoming decorative. The same family carries headings, labels, buttons, and dense controls so the interface feels coherent while users move between chat and setup.

### Hierarchy

- **Display** (700, `calc(var(--mainFontSize) * 1.72)`, 1.08): Welcome hero titles and first-run surfaces only.
- **Headline** (700, `calc(var(--mainFontSize) * 1.45)`, 1.08): Shell titles, major panel headings, and onboarding section titles.
- **Title** (700, `calc(var(--mainFontSize) * 0.92)`, 1.25): Cards, action rows, setting groups, agent chips, and compact headings.
- **Body** (400, `var(--mainFontSize)`, 1.6): Chat-adjacent prose, setting descriptions, tutorials, and explanatory copy. Keep prose around 65 to 75 characters when the layout allows.
- **Label** (700, `calc(var(--mainFontSize) * 0.72)`, 0.08em where uppercase): Eyebrows, metadata, counters, and compact status labels.
- **Mono** (400, `calc(var(--mainFontSize) * 0.84)`, 1.45): Logs, regex, prompt snippets, token diagnostics, and structured technical output.

### Named Rules

**The Interface Sans Rule.** Do not introduce display fonts for controls, labels, tabs, or dense setting surfaces. The tool should stay readable under pressure.

**The No Viewport Type Rule.** Product UI type should scale from `--mainFontSize` and user settings, not from viewport width.

**The User Preference Rule.** New spacing, line-height, font-size, and density controls must compose with existing user settings instead of hardcoding a separate visual scale.

## 4. Elevation

SillyBunny uses layered atmospheric elevation: surfaces are separated first by tonal layers, borders, opacity, and background mixes; shadows add softness only where a panel, popup, card, or selected option needs to sit above the canvas. Mobile and iOS WebKit reliability take priority over decorative blur.

### Shadow Vocabulary

- **Shell Shadow** (`0 32px 90px color-mix(in srgb, var(--SmartThemeShadowColor) 34%, transparent)`): Large shell panels and major overlay surfaces.
- **Welcome Panel Shadow** (`0 30px 70px color-mix(in srgb, var(--SmartThemeShadowColor) 18%, transparent)`): Home and onboarding panels.
- **Card Lift** (`0 14px 28px color-mix(in srgb, var(--SmartThemeShadowColor) 12%, transparent)`): Welcome action cards, selected theme options, and medium interactive cards.
- **Control Glow** (`inset 0 0 0 1px color-mix(in srgb, var(--color-primary) 18%, transparent)`): Hover and focus confirmation on buttons, icon controls, and active utility controls.

### Named Rules

**The Layer Before Shadow Rule.** Add tonal separation before adding a stronger shadow. If a shadow is doing all the work, the surface token is wrong.

**The WebKit Reliability Rule.** On mobile and Safari surfaces, prefer solid or near-solid layers over fragile blur stacks. Depth must never break scrolling, focus, safe areas, or fixed positioning.

## 5. Components

### Buttons

Buttons are tactile and clear. They should look clickable without becoming glossy, oversized, or ornamental.

- **Shape:** Rounded rectangle for text/action buttons (`14px`), icon controls use a tighter radius (`10px`) or circles for close/utility controls.
- **Primary:** Warm Signal fill with dark ink text, typically `38px` minimum height and compact horizontal padding.
- **Hover / Focus:** Hover changes background and adds an inset accent confirmation. Focus uses a visible inset ring through `--sb-focus-ring`.
- **Secondary / Ghost:** Tonal panel backgrounds, linen text, and subtle borders. Do not invent new button families when existing `.menu_button`, `.menu_button_icon`, and shell controls fit.

### Chips

Chips show selected states, agent enablement, quick actions, badges, and compact metadata.

- **Style:** Pill or rounded chip containers with tonal backgrounds, thin borders, and restrained accent tint.
- **State:** Enabled and selected states use Warm Signal through border, background mix, or icon color. Inactive chips stay muted and readable.

### Cards / Containers

Containers are working surfaces, not decorative cards.

- **Corner Style:** Medium shell cards use `16px`; welcome and chat surfaces may reach `20px` to `28px` when they frame a distinct experience.
- **Background:** Ink Panel and Raised Panel tokens, often with subtle gradients or theme-derived mixes.
- **Shadow Strategy:** Use Card Lift only for selected or truly elevated surfaces.
- **Border:** One-pixel theme-derived borders. No thick side-stripe accents.
- **Internal Padding:** Use `12px`, `14px`, `16px`, or `18px` according to density. Compact mode tightens these values.

### Inputs / Fields

Inputs should feel stable on desktop and mobile.

- **Style:** Tonal field background, one-pixel border, `14px` radius, `46px` default height, and `12px` inline padding.
- **Focus:** Border shifts toward Warm Signal and adds an inset focus ring. Outline must remain visible and keyboard-reachable.
- **Error / Disabled:** Error uses Danger Rose tints. Disabled states reduce opacity but keep shape, layout, and label context intact.

### Navigation

The shell is the signature product component. It turns upstream drawers into Workspace, Customize, Characters, Home, Search, and mobile tool surfaces.

- **Desktop:** Top bar and shell panels use layered surfaces, horizontal tab rows, direct icon/text labels, and global search.
- **Mobile:** Navigation uses stable `dvh`/safe-area-aware sizing, visible buttons, touch-friendly controls, and `-webkit-overflow-scrolling: touch` where scroll containers need momentum.
- **Active State:** Active tabs use a tonal accent background, thin border, and an inset bottom accent, not a thick side stripe.

### Breakpoints

Canonical responsive breakpoints are **1000 / 768 / 620 / 420**.

| Breakpoint | Contract |
| --- | --- |
| `1000px` | Compact desktop ceiling. Upstream `style.css` 1000px blocks may apply. |
| `768px` | Mobile shell ceiling. Fork mobile chrome and mobile stylesheet gates stop here. |
| `620px` | Narrow mobile tuning for dense phone layouts. |
| `420px` | Small mobile tuning for the tightest phone layouts. |

Compact desktop is `769px` through `1000px`: no fork mobile chrome. The 820x1180 smoke checkpoint pins this contract.

### Signature Components

**Welcome Action Cards** are onboarding shortcuts. They use centered icon plus text, `20px` radius, a medium shadow, and restrained accent icon color.

**Theme Options** are compact selectable cards. Selected state uses the active shell background and shadow rather than loud color flooding.

**In-Chat Agent Chips** are modular control chips. Enabled states use accent tints and status icons while keeping the chip layout compact enough for dense agent lists.

**Companion Agent Panels** are sidecar workspaces, not modals. They must preserve chat visibility, make source-message context reachable, and keep regenerate, edit, copy, delete, and manual-run controls touch-safe.

**Conversation Mode Surfaces** should read like focused character DMs while preserving SillyTavern chat data expectations. Keep coalesced messages, persona context, and group handoff behavior visually clear.

## 6. Do's and Don'ts

### Do:

- **Do** keep the default path simple first and powerful nearby.
- **Do** use Warm Signal for current selection, focus, meaningful state, and primary action only.
- **Do** preserve creative flow between chat, characters, presets, world info, personas, and agents.
- **Do** test mobile layouts with iOS WebKit constraints in mind: safe areas, fixed layers, focus behavior, scroll containers, and touch targets.
- **Do** route new visual work through existing `SmartTheme*`, `sb-*`, `color-*`, spacing, and radius tokens.
- **Do** keep controls tactile and clear, with default, hover, focus, active, disabled, and loading or empty states where relevant.

### Don't:

- **Don't** make the interface feel complex for its own sake.
- **Don't** ship dense control walls on default surfaces, gratuitous advanced settings, or novelty interactions that slow repeated chat work.
- **Don't** create generic SaaS polish, sterile upstream-clone blandness, or showcase-style visual treatments.
- **Don't** hide essential writing controls behind mystery meat navigation.
- **Don't** rely on desktop-only assumptions, hover-only discovery, tiny touch targets, or browser behavior that breaks on iOS WebKit.
- **Don't** use border-left or border-right greater than `1px` as a colored accent on cards, list items, callouts, or alerts.
- **Don't** add gradient text, decorative glassmorphism, identical repeated card grids, or modal-first flows.
- **Don't** introduce pure black or pure white as new surface colors. Use tinted charcoal and linen neutrals.
