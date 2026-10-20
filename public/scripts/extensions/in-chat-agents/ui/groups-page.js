import { createPrefGroup, createRow, createButtonRow } from '../../../sillybunny-editor/rows.js';
import { openActionMenu, closeActionMenu } from '../../../sillybunny-action-menu.js';
import { confirmDestructiveAction } from '../../../sillybunny-delete-confirm.js';
import { t } from '../../../i18n.js';
import { createAgentPage, pageElement } from './settings-page.js';
import { createGroupsPageController } from './groups-page-controller.js';

export function mountAgentGroups({ host, services, onClose, preparePopup }) {
    const page = createAgentPage({ host, title: t`Agent Groups`, onClose });
    page.root.dataset.agentPage = 'groups';
    const cache = new Map();
    const groups = new Map();
    let controller;
    const run = async callback => {
        try {
            await callback();
        } catch (error) {
            toastr.error(error.message);
        }
    };
    const render = state => {
        const present = new Set();
        for (const section of state.sections) {
            if (!groups.has(section.id)) {
                const group = createPrefGroup({ title: section.id === 'builtin' ? t`Built-in Groups` : t`Custom Groups`, subtitle: t`lorum ipsum`, field: section.id, rows: [] });
                group.section.querySelector('.ds-pref-group-subtitle').dataset.sbCopyPlaceholder = 'true';
                groups.set(section.id, group);
                page.body.append(group.section);
            }
            const group = groups.get(section.id);
            let previous = null;
            for (const value of section.rows) {
                present.add(value.key);
                let entry = cache.get(value.key);
                if (!entry) {
                    const turnOn = pageElement('button', 'menu_button ica-agents-group-turn-on', t`Turn On`);
                    turnOn.type = 'button';
                    turnOn.addEventListener('click', () => run(() => controller.turnOn(value.key)));
                    const suffix = [turnOn];
                    const menu = pageElement('button', 'menu_button menu_button_icon ica-agents-page-group-menu');
                    if (value.canDelete) {
                        menu.type = 'button';
                        menu.title = t`Group Menu`;
                        menu.setAttribute('aria-label', t`Group Menu`);
                        menu.setAttribute('aria-haspopup', 'menu');
                        const icon = pageElement('i', 'fa-solid fa-ellipsis-vertical');
                        icon.setAttribute('aria-hidden', 'true');
                        menu.append(icon);
                        menu.addEventListener('click', () => {
                            preparePopup?.(menu);
                            openActionMenu({ trigger: menu, sections: [{ items: [{
                                label: t`Delete…`, icon: 'fa-solid fa-trash', danger: true,
                                onSelect: () => run(() => controller.delete(value.key)),
                            }] }] });
                        });
                        suffix.push(menu);
                    }
                    const row = createRow({ label: value.name, field: value.key, subtitle: ' ', suffix });
                    entry = { row, turnOn, menu };
                    cache.set(value.key, entry);
                }
                entry.row.row.querySelector('.ds-row-label').textContent = value.name;
                const count = value.memberCount;
                entry.row.row.querySelector('.ds-row-subtitle').textContent = value.description
                    || (count === 1 ? t`1 agent` : t`${count} agents`);
                entry.turnOn.disabled = entry.menu.disabled = value.pending;
                const expected = previous ? previous.nextSibling : group.group.firstChild;
                if (expected !== entry.row.row) group.group.insertBefore(entry.row.row, expected);
                previous = entry.row.row;
            }
            group.section.hidden = !section.rows.length;
        }
        for (const [key, entry] of cache) {
            if (present.has(key)) continue;
            entry.row.destroy();
            cache.delete(key);
        }
    };
    controller = createGroupsPageController({
        services: {
            ...services,
            confirmDelete: () => {
                preparePopup?.(null);
                return confirmDestructiveAction({ text: t`lorum ipsum`, confirmLabel: t`Delete`, copyPlaceholder: true });
            },
            notifyTurnOn: ({ added, enabled }) => toastr.success(t`${added} added · ${enabled} enabled`),
        },
        onChange: render,
    });
    render(controller.getState());
    const create = createButtonRow({
        label: t`Save Agents as Group…`, field: 'create-group', icon: 'layer-group',
        onActivate: () => {
            preparePopup?.(create.row);
            return run(() => controller.create());
        },
    });
    page.body.append(createPrefGroup({ field: 'save-group', rows: [create.row] }).section);
    return {
        ...page, refresh: controller.refresh,
        destroy() {
            closeActionMenu({ animate: false });
            controller.destroy();
            cache.forEach(entry => entry.row.destroy());
            page.destroy();
        },
    };
}
