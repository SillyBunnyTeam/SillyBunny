/*
 * Conversation message menu.
 * The toolbar's menu button (a fine pointer) and the gutter trigger (a coarse pointer) open the shared action menu,
 * built from the toolbar's own buttons; rows forward clicks to them so chrome.js keeps handling every action.
 */

import { translate } from '../i18n.js';
import { openActionMenu } from '../sillybunny-action-menu.js';

/** Which control opens a message's actions follows the pointer, never the width (DESIGN.md, Layout and Chat Transcript). */
const COARSE_POINTER_QUERY = '(pointer: coarse)';
const MESSAGE_SELECTOR = '.sb-conversation-message';
const TRIGGER_SELECTOR = `${MESSAGE_SELECTOR} [data-sb-conversation-menu]`;
const OPEN_CLASS = 'has-open-menu';
const META_COVERED_ATTRIBUTE = 'data-sb-meta-covered';
const META_CLEARANCE = 6;

let initialized = false;
let coarseQuery = null;
/**
 * The reactions of the workspace. This module starts with the page (`sillybunny-message-actions.js` imports it), so it
 * imports nothing of the mode's runtime: `reactions-ui.js` registers itself when the workspace loads, and a menu opens
 * only in the workspace.
 * @type {{ buildMenuReactions: (item: HTMLElement, trigger: HTMLElement) => import('../sillybunny-action-menu.js').ActionMenuReaction[], syncToolbarReactions: (item: HTMLElement) => void, bindReactionChips: () => void }|null}
 */
let reactions = null;

export function registerMessageMenuReactions(provider) {
    reactions = provider;
    provider.bindReactionChips();
}

function isCoarsePointer() {
    return coarseQuery?.matches === true;
}

function asElement(target) {
    return target instanceof Element ? target : null;
}

function isTypingTarget(element) {
    return element instanceof HTMLElement
        && (element.isContentEditable || element.matches('textarea, input:not([type="radio"], [type="checkbox"], [type="button"], [type="submit"]), select'));
}

function getIcon(button) {
    const classes = [...button.classList].filter(name => name === 'fa' || name.startsWith('fa-'));
    return classes.length ? classes.join(' ') : 'fa-solid fa-puzzle-piece';
}

function findLiveButton(item, button) {
    if (button.isConnected) {
        return button;
    }
    const action = CSS.escape(button.dataset.sbConversationAction || '');
    const messageId = CSS.escape(item.dataset.messageId || '');
    return document.querySelector(`${MESSAGE_SELECTOR}[data-message-id="${messageId}"] .sb-conversation-message-actions [data-sb-conversation-action="${action}"]`);
}

function forward(item, button) {
    findLiveButton(item, button)?.click();
}

function buildSections(item, actionBar, trigger) {
    // The reaction row comes from the quick row, not from the toolbar's buttons: the toolbar has room for two emoji only.
    const sections = [{ reactions: reactions?.buildMenuReactions(item, trigger) ?? [] }];
    for (const button of actionBar.querySelectorAll(':scope > .sb-conversation-message-action[data-sb-conversation-action]')) {
        const index = Number(button.getAttribute('data-sb-section'));
        const section = (sections[index + 1] ??= { items: [] });
        const label = button.getAttribute('aria-label') || button.title || '';
        if (!label) {
            continue;
        }
        section.items.push({
            label,
            icon: getIcon(button),
            danger: button.getAttribute('data-sb-conversation-action') === 'delete-message',
            onSelect: () => forward(item, /** @type {HTMLElement} */ (button)),
        });
    }
    return Array.from(sections, section => section ?? { items: [] });
}

function getSubtitle(item) {
    const name = item.querySelector('.sb-conversation-message-name')?.textContent?.trim() ?? '';
    const time = item.querySelector('.sb-conversation-message-time')?.textContent?.trim() ?? '';
    return [name, time].filter(Boolean).join(' · ');
}

function getTrigger(item) {
    const selector = isCoarsePointer() ? '.sb-conversation-mobile-menu-trigger' : '.sb-conversation-message-menu';
    return item.querySelector(`:scope ${selector}`);
}

export function openConversationMessageMenu(trigger, { point = null, keyboard = false } = {}) {
    const item = trigger.closest(MESSAGE_SELECTOR);
    const actionBar = item?.querySelector('.sb-conversation-message-actions');
    // Selection mode turns the per-message actions off; a keyboard route must not bring one back.
    if (!(item instanceof HTMLElement) || !actionBar || item.classList.contains('is-editing') || document.getElementById('sheld')?.dataset.selectionMode === 'true') {
        return;
    }
    item.classList.add(OPEN_CLASS);
    openActionMenu({
        trigger,
        sections: buildSections(item, actionBar, trigger),
        subtitle: getSubtitle(item),
        point,
        keyboard,
        bounds: document.getElementById('sb_conversation_timeline'),
        onClose: () => item.classList.remove(OPEN_CLASS),
    });
}

/**
 * The menu of a message for a long press with a finger. A coarse pointer gets the sheet; a finger on a screen whose main
 * pointer is fine gets the popover at the finger, as the secondary click does.
 * @param {HTMLElement} item
 * @param {{ x: number, y: number }} point
 */
export function openConversationMessageMenuAt(item, point) {
    const trigger = getTrigger(item) ?? item.querySelector('[data-sb-conversation-menu]');
    if (trigger instanceof HTMLElement) {
        openConversationMessageMenu(trigger, { point: isCoarsePointer() ? null : point });
    }
}

/** Desktop menu button tooltip: adds the Shift hint unless the Expand Message Actions setting is on. */
function syncMenuTitle(target) {
    const trigger = asElement(target)?.closest(TRIGGER_SELECTOR);
    if (!(trigger instanceof HTMLElement)) {
        return;
    }
    const label = translate('Message Actions');
    const expanded = isCoarsePointer() || document.body.classList.contains('expandMessageActions');
    const title = expanded || trigger.classList.contains('sb-conversation-mobile-menu-trigger')
        ? label
        : `${label}\n${translate('Hold shift to expand.')}`;
    if (trigger.title !== title) {
        trigger.title = title;
    }
    if (trigger.getAttribute('aria-label') !== label) {
        trigger.setAttribute('aria-label', label);
    }
}

/** The two emoji of a toolbar follow the user's recent reactions, which change without the message changing. */
function syncToolbarQuickRow(target) {
    const item = asElement(target)?.closest(MESSAGE_SELECTOR);
    if (item instanceof HTMLElement) {
        reactions?.syncToolbarReactions(item);
    }
}

/**
 * The toolbar rests over the name row. A short bubble leaves the row no room beside the toolbar, so the row is marked for
 * the style sheet to hide while the toolbar shows, and the toolbar covers no text. The toolbar is laid out even while it is
 * transparent, so its box is known before it appears.
 */
function syncMetaClearance(target) {
    const item = asElement(target)?.closest(MESSAGE_SELECTOR);
    if (!(item instanceof HTMLElement)) {
        return;
    }
    const toolbar = item.querySelector('.sb-conversation-message-actions');
    const meta = item.querySelector('.sb-conversation-message-meta');
    let covered = false;
    if (!isCoarsePointer() && toolbar instanceof HTMLElement && meta instanceof HTMLElement && item.dataset.showHeader === 'true') {
        const bar = toolbar.getBoundingClientRect();
        covered = bar.width > 0 && [...meta.children].some((child) => {
            const box = child.getBoundingClientRect();
            return box.width > 0 && box.right > bar.left - META_CLEARANCE && box.left < bar.right + META_CLEARANCE;
        });
    }
    if (item.hasAttribute(META_COVERED_ATTRIBUTE) !== covered) {
        item.toggleAttribute(META_COVERED_ATTRIBUTE, covered);
    }
}

/** Holding Shift widens the toolbar of the message under the pointer or focus, so its clearance is measured again. */
function syncHoveredMetaClearance(event) {
    if (event.key !== 'Shift') {
        return;
    }
    requestAnimationFrame(() => {
        document.querySelectorAll(`${MESSAGE_SELECTOR}:hover, ${MESSAGE_SELECTOR}:focus-within`).forEach(syncMetaClearance);
    });
}

function handleClickCapture(event) {
    const trigger = asElement(event.target)?.closest(TRIGGER_SELECTOR);
    if (!(trigger instanceof HTMLElement)) {
        return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    openConversationMessageMenu(trigger, { keyboard: event.detail === 0 });
}

function handleContextMenu(event) {
    if (isCoarsePointer() || event.shiftKey) {
        return;
    }
    const target = asElement(event.target);
    const item = target?.closest(MESSAGE_SELECTOR);
    if (!(item instanceof HTMLElement) || !target.closest('.sb-conversation-message-meta, .sb-conversation-message-actions')) {
        return;
    }
    const trigger = getTrigger(item);
    if (!(trigger instanceof HTMLElement)) {
        return;
    }
    event.preventDefault();
    openConversationMessageMenu(trigger, { point: { x: event.clientX, y: event.clientY } });
}

function handleMenuKey(event) {
    const isMenuKey = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
    // On a reaction chip the same keys open the list of who reacted (reactions-ui.js).
    if (!isMenuKey || isTypingTarget(document.activeElement) || asElement(document.activeElement)?.closest('.sb-conversation-message-reaction-chip')) {
        return;
    }
    const item = asElement(document.activeElement)?.closest(MESSAGE_SELECTOR);
    const trigger = item ? getTrigger(item) : null;
    if (!(trigger instanceof HTMLElement)) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    openConversationMessageMenu(trigger, { keyboard: true });
}

export function initializeConversationMessageMenu() {
    if (initialized) {
        return;
    }
    initialized = true;
    coarseQuery = window.matchMedia(COARSE_POINTER_QUERY);
    window.addEventListener('click', handleClickCapture, true);
    window.addEventListener('keydown', handleMenuKey, true);
    document.addEventListener('contextmenu', handleContextMenu);
    document.addEventListener('pointerover', (event) => {
        syncMenuTitle(event.target);
        syncToolbarQuickRow(event.target);
        syncMetaClearance(event.target);
    }, { passive: true });
    document.addEventListener('focusin', (event) => {
        syncMenuTitle(event.target);
        syncToolbarQuickRow(event.target);
        syncMetaClearance(event.target);
    });
    window.addEventListener('keydown', syncHoveredMetaClearance, { passive: true });
    window.addEventListener('keyup', syncHoveredMetaClearance, { passive: true });
}
