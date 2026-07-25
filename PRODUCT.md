# SILLYBUNNY PRODUCT

## Vision

SillyBunny is a distraction-free environment for roleplay and conversational AI, built on a single principle: **simple by default, powerful when needed.**

The main content surrounding a character card is the primary focus. Every UI decision defers to it. Powerful configuration and customisation are readily available to the end user; they simply stay out of the way until the user chooses to access them.

---

## Design Philosophies

SillyBunny embodies two distinct design philosophies:

**Simple and Intuitive**: SillyBunny prioritizes simplicity and user focus by default, teaching a user through consistent effort. This means anticipating user mistakes, and eliminating unnecessary interruptions. There should be one primary action per view, and progressive disclosure. This provides a welcoming and intuitive environment for the user while remaining distraction-free.

**Highly Malleable** — If a user wishes to, they can delve into vast configuration that's just an easy click away. This allows for maximum flexibility and malleability for the power user, without removing established features. Configuration exists only if the user requests it.

---

## Core Principles

### 1. Main content is the focus
The main interactive window must remain uninterrupted during active use. There should be no permanent panels, and no persistent left-over configuration competing for the user's attention. The shell recedes while the user is interacting with the main window.

### 2. Progressive disclosure
The default state is minimal, themeable, and legible. Complexity is layered across four defined navigation levels (see below). Each layer reveals the next only on deliberate user input.

### 3. Configuration is hidden behind the header bar
Header bars open up configuration for the user, only remaining open while the user requests it. Configuration must be called for deliberately, and remain out of the primary view at all other times.

### 4. Hidden by default, not buried
All configuration must be discoverable on intent. Every power feature must have a clear, learnable entry point. If a user must already know a feature exists to find it, it is buried, not hidden.

### 5. Desktop and mobile cross-compatibility
All gestures, placements, and patterns throughout the app should remain consistent with both desktop and mobile. Touch-first affordances must not degrade the desktop experience, and vice versa.

### 6. Distraction-free environment
The shell is a neutral and distraction-free environment. UI identity is expressed through typography, spacing, SillyBunny branding, and encouraging wording — not through visual noise or decorative motion. The end user can customise this default shell (colours, CSS, layout) as they see fit.

### 7. Respect the user's setup
Non-destructive and reversible. SillyTavern-compatible config, extensions, presets, and character data must survive by default.

---

## Navigation layout
**Layer 1:** The main chat window, where configuration is hidden from the user. The main content takes up the majority of the screen. A bottom bar exists for quick and easy access to interface with the main window.

**Layer 2:** Top bar, always visible. Navigation buttons, accessible through buttons located in a top bar element. They are in order:
Left:
- Workspace - for interfacing with the connected model backend and configuration. Settings here should be tied to a global preset option.
- Customize - for changing the graphical shell and SillyBunny configuration. User-created extensions also reside here. Settings here are independent of each other.
- Quick access button for whatever the user requests. Default is quick accessing agents.

Middle:
- Customisable title button.

Right:
- Second quick access button. Default is global search.
- Home - for accessing the program's home menu and tutorials.
- Characters - for interfacing with the character cards to be used in the program.

**Layer 3:** Header tabs per sub-category with config pop-down, allowing the user to specify what in the category they want to modify.

**Layer 4:** Sub-category content. All options for that category, with a maximum of one collapsible section.

---

## Anti-patterns

These are explicit violations of the principles above. Any contribution that introduces one should be revised before merge.

**UI creep** — Persistent panels, sidebars, or toolbars in the primary viewport during active use. Any config element that was not explicitly opened by the user should not be shown.

**Nested menu spiral** — Sub-menus that spawn further sub-menus. There should be no further sub-menu beyond the single collapsible allowed per sub-category at layer 4. If something cannot fit within four layers, a different solution must be found.

**Configuration sprawl** — Presenting a wall of options to a new or returning user. Options should only appear because the user explicitly seeks them out.

**Decorative motion** — Motion that has no navigational purpose and is not user-controllable. Motion should orient the user through disclosure and state changes. Any motion beyond that must be reducible by user preference.

**Bottom bar bloat** — Defaulting new quick-access actions into the bottom bar without justification for their inclusion. The bar has a finite default budget. Keep a careful constraint on additions, while not removing anything established unless explicitly called for.

**Inconsistent patterns across contexts** — Different gestures, placements, or flows for the same action in different parts of the app, mobile and desktop included.

**Modal interruption for non-critical config** — Blocking dialogs that interrupt an active conversation for a settings change that did not need to stop the user. Config must remain explicitly called for.

**Silent breaking changes** — Defaults or migrations that overwrite or invalidate an existing user's SillyTavern-compatible config, extensions, or presets without warning and a clear recovery path.

## Anti-references

These are aesthetic and behavioural traps to avoid. Any contribution that leans into one should be revised before merge.

**Generic SaaS polish** — Interchangeable, algorithmically-safe styling with no established character. Neutral design is the goal, but not at the expense of removing character.

**Sterile upstream-clone blandness** — Inheriting SillyTavern's look wholesale with no intentional identity of our own.

**Mystery meat navigation** — Hiding essential main-content controls behind unlabelled icons or unexplained affordances. Configuration may be hidden; the controls a user needs to interact with the main window may not be.

**Desktop-only assumptions** — Layouts, inputs, or interactions that presume a mouse, a keyboard, or a large viewport.

**Hover-only discovery** — Surfacing controls or information exclusively on hover, which is unreachable on touch.

**Tiny touch targets** — Controls too small to activate comfortably on mobile.

**iOS WebKit fragility** — Relying on browser behaviour that breaks on Safari/WebKit, including unsafe viewport assumptions and fragile fixed-position layering.

## Accessibility & Inclusion

Accessibility is a baseline expectation, not an afterthought. Any contribution that fails one of these should be revised before merge.

**Contrast** — Aim for WCAG AA contrast where practical.

**Visible focus** — Focus states must be visible for keyboard navigation.

**Keyboard reach** — All controls must be keyboard-reachable.

**Semantic labels** — Controls carry semantic labels, not visual-only cues.

**Comfortable touch targets** — Targets sized to work comfortably on mobile.

**Resilient layouts** — Tolerate long labels, localisation, zoom, and reduced-motion preferences.

**Mobile and WebKit parity** — Mobile compatibility, including iOS WebKit, is a first-class concern. Avoid hover-only affordances, fragile fixed-position layering, unsafe viewport assumptions, and scroll/focus patterns known to misbehave on Safari.

**Purposeful, reducible motion** — Motion should be purposeful, lightweight, and respect reduced-motion settings.

---

## Non-goals

- Replacing or fully diverging from SillyTavern's data formats, extension APIs, or character/preset schemas.
- Enforcing a single visual theme; the shell ships with defaults but customisation is a first-class feature.
- Reducing option count in the name of simplicity. Simplicity is achieved through organisation and disclosure, not removal.
