import { createPrefGroup, createRow, createSwitchRow, createButtonRow, releaseRowIds } from '../../../sillybunny-editor/rows.js';
import { createProfileRow } from '../../../sillybunny-editor/select-row.js';
import { createToggleRow } from '../../../sillybunny-editor/toggle-row.js';
import { closePicker } from '../../../sillybunny-editor/picker.js';
import { t, translate } from '../../../i18n.js';
import { attachTextareaFullscreen } from '../textarea-fullscreen.js';
import { createSettingsPageController } from './settings-page-controller.js';

export function pageElement(tag, className = '', text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

export function createAgentPage({ host, title, onClose }) {
    if (!(host instanceof HTMLElement) || host.childNodes.length) throw new Error('Agents pages require an empty host.');
    const root = pageElement('section', 'ica-agents-page');
    const header = pageElement('header', 'ica-agents-page-header');
    const back = pageElement('button', 'menu_button menu_button_icon ica-agents-page-back');
    back.type = 'button';
    back.title = t`Back`;
    back.setAttribute('aria-label', t`Back`);
    const glyph = pageElement('i', 'fa-solid fa-chevron-left');
    glyph.setAttribute('aria-hidden', 'true');
    back.append(glyph);
    back.addEventListener('click', onClose);
    header.append(back, pageElement('h2', 'ica-agents-page-title', title));
    const body = pageElement('div', 'ica-agents-page-body');
    root.append(header, body);
    host.append(root);
    return { root, header, body, focusTarget: () => back, destroy() { releaseRowIds(root); root.remove(); } };
}

export function mountAgentSettings({ host, services, onClose, preparePopup }) {
    const page = createAgentPage({ host, title: t`Settings`, onClose });
    page.root.dataset.agentPage = 'settings';
    const rows = new Map();
    const originals = [];
    const listeners = [];
    let destroyed = false;
    const controller = createSettingsPageController({ services });
    const titles = {
        connections: t`Connections`, 'running-agents': t`Running Agents`, chats: t`Chats`,
        'notifications-and-display': t`Notifications and Display`, advanced: t`Advanced`,
    };
    for (const group of controller.getState().groups) {
        const contents = group.rows.map(field => {
            const descriptor = services.fields.find(item => item.id === field.id);
            const input = services.controls.get(field.id);
            if (!descriptor || !input) throw new Error(`Missing Agents setting: ${field.id}`);
            originals.push({ input, attributes: [...input.attributes].map(attribute => [attribute.name, attribute.value]) });
            const staleCaption = field.id === 'ica--appendAgentsExecutionMode';
            const options = { label: translate(descriptor.label), subtitle: staleCaption ? t`lorum ipsum` : translate(descriptor.caption || descriptor.title), field: field.key };
            let row;
            let target = input;
            if (field.kind === 'profile') {
                row = createProfileRow({ ...options, select: input, bounds: page.root, onPick: () => preparePopup?.(null) });
                target = row.trigger;
            } else if (field.kind === 'toggle') {
                row = createToggleRow({
                    ...options, choices: [['parallel', t`Parallel`], ['sequential', t`Sequential`]],
                    value: field.value, fill: true,
                    onChange(value) {
                        input.value = value;
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                    },
                });
                input.hidden = true;
                input.tabIndex = -1;
                input.setAttribute('aria-hidden', 'true');
                row.row.append(input);
                target = row.group.querySelector('input:checked') ?? row.group.querySelector('input');
                const refresh = () => row.setValue(input.value);
                input.addEventListener('change', refresh);
                listeners.push(() => input.removeEventListener('change', refresh));
            } else if (field.kind === 'switch') {
                row = createSwitchRow({ ...options, input });
                const suffix = pageElement('span', 'ds-row-suffix');
                suffix.append(input);
                row.row.append(suffix);
            } else {
                row = createRow({ ...options, suffix: input, stacked: true });
                attachTextareaFullscreen(input);
                input.setAttribute('aria-label', options.label);
            }
            row.row.title = translate(descriptor.title);
            if (staleCaption) row.row.querySelector('.ds-row-subtitle').dataset.sbCopyPlaceholder = 'true';
            rows.set(field.id, { row, input, target, field });
            return row.row;
        });
        const section = createPrefGroup({ title: titles[group.id], subtitle: t`lorum ipsum`, field: group.id, rows: contents });
        section.section.querySelector('.ds-pref-group-subtitle').dataset.sbCopyPlaceholder = 'true';
        page.body.append(section.section);
    }
    const reset = createButtonRow({
        label: t`Reset Bundled Agents to Defaults`, icon: 'rotate-left', field: 'reset-bundled-agents',
        id: 'ica--resetDefaults', danger: true,
        onActivate: async () => {
            preparePopup?.(reset.row);
            reset.setDisabled(true);
            try {
                await controller.reset();
            } catch (error) {
                toastr.error(error.message);
            } finally {
                if (!destroyed) reset.setDisabled(false);
            }
        },
    });
    page.body.append(createPrefGroup({ field: 'reset', rows: [reset.row] }).section);
    const refresh = () => {
        if (destroyed) return;
        controller.refresh();
        for (const field of controller.getState().groups.flatMap(group => group.rows)) {
            const { row, input } = rows.get(field.id);
            if (field.kind === 'switch') input.checked = Boolean(field.value);
            else input.value = field.value;
            if (field.kind === 'toggle') row.setValue(field.value);
            row.sync?.();
        }
    };
    refresh();
    return {
        ...page, refresh,
        focusControl(id) {
            const entry = rows.get(id);
            if (!entry || destroyed) return false;
            const { row, input, target, field } = entry;
            const bodyRect = page.body.getBoundingClientRect();
            const rowRect = row.row.getBoundingClientRect();
            page.body.scrollTop += rowRect.top - bodyRect.top - (bodyRect.height - rowRect.height) / 2;
            const visibleTarget = field.kind === 'toggle' ? row.group.querySelector('input:checked') ?? target : target;
            (visibleTarget ?? input).focus({ preventScroll: true });
            return true;
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            controller.destroy();
            closePicker({ animate: false });
            listeners.forEach(dispose => dispose());
            rows.forEach(({ row }) => row.destroy());
            for (const { input, attributes } of originals) {
                for (const attribute of [...input.attributes]) input.removeAttribute(attribute.name);
                for (const [name, value] of attributes) input.setAttribute(name, value);
                services.controlStore.append(input);
            }
            page.destroy();
        },
    };
}
