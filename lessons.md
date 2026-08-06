# SillyBunny Engineering Lessons

This document records durable lessons for changing SillyBunny. It explains why recurring risks matter and how to reason about them; it is not a commit-history report, release record, or substitute for task-specific investigation.

## Read The Documentation As A System

- `PRODUCT.md` defines the intended product, navigation model, and user experience.
- `DESIGN.md` and `DESIGN.json` define the visual and interaction system.
- `AGENTS.md` defines enforceable repository workflow and validation rules.
- `README.md` and `CONTRIBUTING.md` define user-facing setup and contribution expectations.
- `docs/upstream-sync.md` defines the separate upstream synchronization process.
- This file provides engineering judgment where a rule alone is not enough.

When documents disagree, preserve user data and shipped compatibility first, then follow the most specific current instruction. Resolve genuine product-policy conflicts with a maintainer instead of inventing a migration or silently choosing a direction.

## Product Lessons

### Protect the main content

Chat, characters, and the content around them are the product focus. Shell and configuration changes carry a higher burden than their visual size suggests because persistent chrome competes directly with the active experience.

- Keep configuration absent until the user deliberately opens it.
- Do not turn a useful shortcut into permanent interface weight by default.
- Judge additions by attention consumed, not only by pixels occupied.
- Restore focus and context when a temporary surface closes.

### Simplicity comes from structure, not removal

SillyBunny remains powerful by organizing complexity behind deliberate entry points. Reducing option count, breaking compatibility, or hiding controls without a learnable path does not make the product simpler.

- Place behavior in the established four navigation layers.
- Keep one primary action clear within each view.
- Allow no more than one collapsible level inside layer-four content.
- Give advanced features a stable, discoverable route from the header.

### Hidden must remain discoverable

Configuration should stay out of the main view, but users should not need prior knowledge to find it. Icon-only, hover-only, and context-dependent routes are weak substitutes for consistent navigation.

- Use semantic labels and familiar placement for essential controls.
- Keep equivalent actions in equivalent locations across contexts.
- Ensure discovery works with keyboard, touch, and assistive technology.
- Treat a feature that can only be found by documentation as buried.

### Mobile and desktop are one product

Mobile support is not a reduced fallback. Narrow viewports, touch input, virtual keyboards, safe areas, focus changes, and WebKit scrolling expose architectural assumptions that desktop testing can hide.

- Design the interaction once, then adapt its presentation.
- Preserve the same terminology, order, and state across viewport modes.
- Avoid hover-only behavior and fragile fixed-position layering.
- Verify drawers, pop-downs, scrolling, focus, and the composer with an active virtual keyboard.
- Test transitions across breakpoints, not only settled desktop and mobile states.

### User setup is part of the product

Settings, chats, characters, extensions, presets, agents, templates, and bundled defaults may outlive many application versions. A technically cleaner schema is not an improvement if it invalidates a user's working setup.

- Prefer existing IDs, metadata keys, and state formats.
- Make migrations explicit, reversible where practical, and safe to repeat.
- Distinguish a new-install default from an existing-user update.
- Preserve unknown compatible fields rather than normalizing them away.
- Provide a recovery path before changing persisted behavior.

## Engineering Lessons

### Isolate fork-specific seams

Every edit to upstream-derived code increases future synchronization cost. Prefer self-contained SillyBunny modules, styles, and adapters when they can own the behavior cleanly.

- Change upstream files only when the behavior truly belongs there.
- Keep divergence narrow and explain non-obvious fork seams in code.
- Do not mix an upstream sync with feature or cleanup work.
- Inspect nearby history when changing a known integration hotspot.

### Treat orchestration as a subsystem

Shell, generation, agent, retrieval, and update code often coordinates several owners at once. Files that appear to be glue may define ordering, persistence, rendering, and lifecycle behavior for the whole application.

- Name the state transition being changed before editing.
- Separate visual movement, data loading, and persistence when possible.
- Preserve cancellation, teardown, retry, and active-context checks.
- Test interrupted paths such as chat switches, regeneration, deletion, restart, and delayed events.

### Streaming and scrolling are stateful

Message rendering is not a sequence of independent DOM updates. Streaming, regeneration, swipes, user scroll position, layout shifts, and mobile viewport changes interact over time.

- Define when the application may follow the newest content.
- Never steal position from a user reading earlier messages.
- Account for content resizing after the initial render.
- Verify both generation completion and interruption.
- Reproduce scroll issues with realistic message length and streaming cadence.

### Cache and startup changes span lifecycles

A cache fix that works after a hard refresh may still fail during an update, restart, first install, or stale mobile session. Startup changes likewise depend on import order, generated assets, persisted state, and the selected runtime.

- State which lifecycle the change addresses.
- Keep startup-order-sensitive imports intact unless ordering is the task.
- Check stale and current asset states when cache identity changes.
- Verify structural backend changes with both Bun and Node.js.
- Avoid using cache clearing as a substitute for correct invalidation.

### Bundled content is versioned behavior

Files under `default/` influence first-run behavior and may participate in reset or update flows. They are executable product decisions even when represented as JSON, prompts, presets, or templates.

- Compare generated or installed results, not only source files.
- Verify new installs separately from existing profiles.
- Preserve identifiers and bundled-template update paths.
- Check whether reset behavior overwrites user customization.

### Optional systems should fail open

Retrieval, agents, extensions, and enhancement layers should not make core chat unusable when they are slow, unavailable, or malformed unless correctness or safety requires blocking.

- Define timeout, cancellation, and fallback behavior.
- Distinguish not run, no result, failure, and delay in diagnostics.
- Keep errors visible enough to debug without exposing private content.
- Tear down pending work when its chat, message, or active context changes.

### Performance needs a named constraint

Optimization can alter execution order, rendering cadence, asset availability, and cache behavior. A smaller or faster implementation is not successful if it changes user-visible behavior.

- Record the budget or observed bottleneck before optimizing.
- Measure the narrow path being changed.
- Keep behavior changes separate from performance changes.
- Run frontend budget checks when generated assets are affected.
- Revert the optimization, not the invariant, when the two conflict.

### Security boundaries must stay explicit

Content, extensions, imported data, and generated text may be untrusted. Convenience must not erase the boundary between user-controlled content and application authority.

- Require explicit user action before executing imported or embedded behavior.
- Validate message origin, identity, schema, allowlists, and rate limits at boundaries.
- Expose the minimum data and capability needed for the operation.
- Fail closed for unknown privileged commands.
- Remove listeners, handles, and transient authority during lifecycle teardown.

## Verification Lessons

Choose checks from the behavior changed, then broaden only as needed.

- **Shell or navigation:** verify all four layers, open/close behavior, focus return, keyboard access, touch targets, narrow viewports, and WebKit-sensitive layout.
- **Chat rendering:** verify send, streaming, regenerate, swipe, delete, long-message scrolling, interrupted generation, and user-controlled scroll position.
- **Agents or retrieval:** verify automatic and manual runs, queued work, cancellation, chat switching, failure fallback, diagnostics, and persisted settings.
- **Defaults or migrations:** verify fresh install, existing profile, repeated migration, reset/update flow, identifier preservation, and unknown fields.
- **Startup or backend:** verify Bun and Node.js, restart behavior, startup ordering, static assets, and failure reporting.
- **Cache or frontend build:** verify fresh and stale clients, update/restart paths, generated assets, and frontend budgets.
- **Upstream-derived code:** verify the fork behavior before and after the change and follow `docs/upstream-sync.md` when the task is an upstream sync.

Automate a check when it is stable and valuable, but do not claim coverage that the test does not provide. Record manual verification for timing, touch, viewport, or browser behavior that automation cannot represent reliably.

## Working Method

1. State the user-visible invariant and the failure being corrected.
2. Locate the owning subsystem, persisted formats, and upstream seam.
3. Inspect relevant tests and recent history around risky code.
4. Make the smallest complete change that preserves compatibility.
5. Run the narrowest meaningful check, then broader checks justified by the risk.
6. Review the final diff for unrelated edits, generated artifacts, and migration impact.
7. Report what was verified and what remains unverified.

Prefer complete, focused fixes over broad cleanup or chains of speculative follow-ups. A small patch is valuable only when it closes the behavior end to end.

## Keeping This File Useful

- Add a lesson only when it applies beyond one incident.
- Write the invariant and reasoning, not commit counts or dated narratives.
- Link to authoritative procedures instead of copying them here.
- Remove advice when product direction or architecture makes it false.
- Keep proposed work in issues or plans, not as permanent "future" sections.
- Never use this file as release notes, a changelog, or raw agent memory.
