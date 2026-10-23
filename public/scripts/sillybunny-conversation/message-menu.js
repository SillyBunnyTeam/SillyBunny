/*
 * Conversation message menu (DESIGN.md "Message Actions" > Conversation mode).
 * The pill's menu button (desktop) and the mobile trigger open the shared action menu, built from
 * the pill's own buttons; rows forward clicks to them so chrome.js keeps handling every action.
 */

import { translate } from '../i18n.js';
import { MOBILE_QUERY, openActionMenu } from '../sillybunny-action-menu.js';

const MESSAGE_SELECTOR = '.sb-conversation-message';
const TRIGGER_SELECTOR = `${MESSAGE_SELECTOR} [data-sb-conversation-menu]`;
const OPEN_CLASS = 'has-open-menu';

let initialized = false;
let mobileQuery = null;

function isMobileLayout() {
    return mobileQuery?.matches === true;
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
    const reaction = button.dataset.reaction ? `[data-reaction="${CSS.escape(button.dataset.reaction)}"]` : '';
    const messageId = CSS.escape(item.dataset.messageId || '');
    return document.querySelector(`${MESSAGE_SELECTOR}[data-message-id="${messageId}"] .sb-conversation-message-actions [data-sb-conversation-action="${action}"]${reaction}`);
}

function forward(item, button) {
    findLiveButton(item, button)?.click();
}

function buildSections(item, actionBar) {
    const reactions = [...actionBar.querySelectorAll(':scope > .sb-conversation-reaction-button')].map(button => ({
        text: button.textContent || '',
        pressed: button.getAttribute('aria-pressed') === 'true',
        onSelect: () => forward(item, button),
    }));
    const sections = [{ reactions }];
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
    const selector = isMobileLayout() ? '.sb-conversation-mobile-menu-trigger' : '.sb-conversation-message-menu';
    return item.querySelector(`:scope ${selector}`);
}

export function openConversationMessageMenu(trigger, { point = null, keyboard = false } = {}) {
    const item = trigger.closest(MESSAGE_SELECTOR);
    const actionBar = item?.querySelector('.sb-conversation-message-actions');
    if (!(item instanceof HTMLElement) || !actionBar || item.classList.contains('is-editing')) {
        return;
    }
    item.classList.add(OPEN_CLASS);
    openActionMenu({
        trigger,
        sections: buildSections(item, actionBar),
        subtitle: getSubtitle(item),
        point,
        keyboard,
        bounds: document.getElementById('sb_conversation_timeline'),
        onClose: () => item.classList.remove(OPEN_CLASS),
    });
}

/** Desktop menu button tooltip: adds the Shift hint unless the Expand Message Actions setting is on. */
function syncMenuTitle(target) {
    const trigger = asElement(target)?.closest(TRIGGER_SELECTOR);
    if (!(trigger instanceof HTMLElement)) {
        return;
    }
    const label = translate('Message Actions');
    const expanded = isMobileLayout() || document.body.classList.contains('expandMessageActions');
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
    if (isMobileLayout() || event.shiftKey) {
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
    if (!isMenuKey || isTypingTarget(document.activeElement)) {
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
    mobileQuery = window.matchMedia(MOBILE_QUERY);
    window.addEventListener('click', handleClickCapture, true);
    window.addEventListener('keydown', handleMenuKey, true);
    document.addEventListener('contextmenu', handleContextMenu);
    document.addEventListener('pointerover', event => syncMenuTitle(event.target), { passive: true });
    document.addEventListener('focusin', event => syncMenuTitle(event.target));
}
