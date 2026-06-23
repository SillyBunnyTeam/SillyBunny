# Product

## Register

product

## Users

SillyBunny serves creative roleplay and storytelling users who want to start writing quickly without first mastering the full SillyTavern surface. Many users arrive with characters, chats, presets, lorebooks, or extensions from SillyTavern, so familiarity and compatibility matter, but the primary design audience is the writer trying to keep a scene moving.

Users may be on desktop, tablets, phones, or Termux-style mobile setups. They often need to connect a model, choose a preset, pick or edit a character, adjust persona and world info, and then return to the chat without feeling lost in configuration depth. More advanced users also rely on in-chat agents, Companion Agents, Conversation Mode, Pathfinder, prompt stacks, custom endpoint profiles, accent profiles, and extension workflows, but those capabilities should sit behind clear progressive access instead of dominating the default experience.

## Product Purpose

SillyBunny is an elegant, Bun-first SillyTavern fork for creative writing, roleplay, and agent-assisted storytelling. It keeps SillyTavern data and feature compatibility while replacing the default interaction model with a cleaner graphical shell, mobile-aware navigation, global search, built-in tutorials, curated presets, optional extensions, in-chat agents, and companion-style helper workflows.

Success means a new creative user can reach a useful chat with sane defaults and plain guidance, while an experienced user can still find the full power of presets, APIs, sampling, world info, personas, backgrounds, extensions, server tools, and agent workflows without upstream compatibility becoming fragile.

Agent-facing product updates should describe durable behavior and decision criteria only. Do not turn this file into release notes, changelog copy, or a list of every shipped feature.

## Brand Personality

Expressive creator: playful, imaginative, practical, and confident. SillyBunny can feel more characterful than a generic admin tool, especially in onboarding and creative surfaces, but it should not let personality obscure the writing workflow.

The voice should be friendly and direct, explaining unfamiliar LLM and SillyTavern concepts in plain language. The product should feel like a creative companion workspace: warm enough for roleplay users, structured enough for power users, and careful enough for people migrating existing SillyTavern data.

## Anti-references

Do not make the interface feel complex for its own sake. Avoid dense control walls on default surfaces, gratuitous advanced settings, novelty interactions that slow repeated chat work, and visual treatments that make the app feel more like a showcase than a workspace.

Avoid generic SaaS polish, sterile upstream-clone blandness, and designs that hide essential writing controls behind mystery meat navigation. Do not rely on desktop-only assumptions, hover-only discovery, tiny touch targets, or browser behavior that breaks on iOS WebKit.

## Design Principles

1. Simple first, powerful nearby. The default path should make writing feel immediate, while advanced controls remain discoverable through clear shell structure, search, and progressive panels.
2. Preserve creative flow. UI changes should reduce context switching between chat, character, preset, persona, lore, and agent work.
3. Express personality through usefulness. Playful or stylized moments should guide, reassure, or clarify rather than decorate without purpose.
4. Stay close to upstream where it matters. New UI and feature work should be modular, compatible with SillyTavern data, and easy to reconcile during upstream syncs.
5. Mobile is a primary workspace. Desktop and mobile should have parity in capability, with special care for iOS WebKit rendering, scrolling, safe areas, focus behavior, and touch ergonomics.
6. Make agentic power inspectable. In-chat and companion workflows should expose run state, source context, edits, regeneration, and recovery paths without interrupting the main writing flow.

## Accessibility & Inclusion

Accessibility is a baseline expectation, not an afterthought. Aim for WCAG AA contrast where practical, visible focus states, keyboard-reachable controls, semantic labels, touch targets that work comfortably on mobile, and layouts that tolerate long labels, localization, zoom, and reduced motion preferences.

Mobile compatibility is especially important, including iOS WebKit. Avoid hover-only affordances, fragile fixed-position layering, unsafe viewport assumptions, and scroll/focus patterns that are known to misbehave on Safari. Motion should be purposeful, lightweight, and respectful of reduced motion settings.
