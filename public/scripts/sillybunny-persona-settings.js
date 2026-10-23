import { eventSource, event_types } from './events.js';
import { t } from './i18n.js';
import { createPrefGroup, createRow } from './sillybunny-editor/rows.js';

const PRESENTATION_ATTRIBUTES = ['class', 'role', 'aria-checked', 'aria-labelledby', 'aria-describedby', 'disabled'];

function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

export function mountPersonaSettings({ host, onClose }) {
    if (!(host instanceof HTMLElement) || host.childNodes.length) throw new Error('Persona settings need an empty host.');
    if (typeof onClose !== 'function') throw new TypeError('Persona settings need an onClose callback.');

    const switches = [
        { id: 'persona_show_notifications', label: t`Show notifications on switching personas` },
        {
            id: 'persona_allow_multi_connections', label: t`Allow multiple persona connections per character`,
            subtitle: t`When multiple personas are connected to a character, a popup will appear to select which one to use`,
        },
        {
            id: 'persona_auto_lock', label: t`Auto-lock a chosen persona to the chat`,
            subtitle: t`Whenever a persona is selected, it will be locked to the current chat and automatically selected when the chat is opened.`,
        },
    ].map(descriptor => {
        const input = document.getElementById(descriptor.id);
        if (!input?.matches('input[type="checkbox"]') || !input.parentNode) throw new Error(`Persona settings require #${descriptor.id}.`);
        if (input.closest('.sb-persona-settings')) throw new Error('Persona settings are already mounted.');
        return { ...descriptor, input };
    });
    // Capture all origins before moving the upstream nodes, whose handlers must survive.
    const origins = switches.map(({ input }) => ({
        input, parent: input.parentNode, next: input.nextSibling,
        attributes: PRESENTATION_ATTRIBUTES.map(name => [name, input.getAttribute(name)]),
    }));
    const listeners = [];
    let destroyed = false;
    const listen = (target, type, handler) => {
        target.addEventListener(type, handler);
        listeners.push(() => target.removeEventListener(type, handler));
    };

    const root = element('section', 'sb-persona-settings');
    const header = element('header', 'sb-persona-detail-header sb-persona-settings-header');
    const back = element('button', 'menu_button menu_button_icon sb-persona-detail-back');
    back.type = 'button';
    back.title = t`Back`;
    back.setAttribute('aria-label', t`Back`);
    const glyph = element('i', 'fa-solid fa-chevron-left');
    glyph.setAttribute('aria-hidden', 'true');
    back.append(glyph);
    listen(back, 'click', event => {
        event.stopPropagation();
        onClose();
    });
    header.append(back, element('h2', 'sb-persona-settings-title', t`Global Settings`));
    const body = element('div', 'sb-persona-settings-body');
    const switchRows = switches.map(({ id, input, label, subtitle }) => {
        // The shared adopting switch has no disposer; use removable listeners for persistent controls.
        const content = createRow({ label, subtitle, field: id, suffix: input }).row;
        const row = element('label', 'ds-row ds-row-switch sb-persona-settings-switch');
        row.dataset.sbEditorField = id;
        row.htmlFor = id;
        row.append(...content.childNodes);
        const caption = row.querySelector('.ds-row-label');
        caption.id = `sb-persona-settings-${id}-label`;
        input.classList.add('sb-switch');
        input.setAttribute('role', 'switch');
        input.setAttribute('aria-labelledby', caption.id);
        const description = row.querySelector('.ds-row-subtitle');
        if (description) {
            description.id = `sb-persona-settings-${id}-description`;
            const descriptions = new Set((input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean));
            descriptions.add(description.id);
            input.setAttribute('aria-describedby', [...descriptions].join(' '));
        }
        const refresh = () => {
            // ARIA in HTML forbids aria-checked on a native checkbox; teardown restores the original attributes.
            input.removeAttribute('aria-checked');
            row.classList.toggle('is-insensitive', input.disabled);
            row.setAttribute('aria-disabled', String(input.disabled));
        };
        listen(input, 'input', refresh);
        listen(input, 'change', refresh);
        refresh();
        return { row, refresh };
    });
    const group = createPrefGroup({ title: t`Persona Management`, field: 'persona-settings', rows: switchRows.map(({ row }) => row) });
    body.append(group.section);
    root.append(header, body);
    host.append(root);

    const refresh = () => {
        if (!destroyed) switchRows.forEach(row => row.refresh());
    };
    listen(root, 'keydown', event => {
        if (event.key !== 'Escape' || event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.target.matches('input, select, textarea')) event.target.blur();
        else onClose();
    });
    eventSource.on(event_types.SETTINGS_UPDATED, refresh);

    return {
        focusTarget: () => destroyed ? null : back,
        refresh,
        destroy() {
            if (destroyed) return;
            destroyed = true;
            eventSource.removeListener(event_types.SETTINGS_UPDATED, refresh);
            listeners.forEach(dispose => dispose());
            for (const { input, parent, next, attributes } of [...origins].reverse()) {
                for (const [name, value] of attributes) {
                    if (value === null) input.removeAttribute(name);
                    else input.setAttribute(name, value);
                }
                parent.insertBefore(input, next?.parentNode === parent ? next : null);
            }
            root.remove();
        },
    };
}
