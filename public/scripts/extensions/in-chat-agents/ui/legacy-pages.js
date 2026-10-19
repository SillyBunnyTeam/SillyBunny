import { createPrefGroup, createRow, createButtonRow } from '../../../sillybunny-editor/rows.js';
import { normalizeBackendSettingsRows } from '../../../sillybunny-settings-presentation.js';
import { confirmDestructiveAction } from '../../../sillybunny-delete-confirm.js';
import { t } from '../../../i18n.js';

function page(host, title, onClose) {
    const root = document.createElement('section');
    root.className = 'ica-agents-page';
    const header = document.createElement('header');
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'sb-editor-icon-button ica-agents-page-back';
    back.title = t`Back`;
    back.setAttribute('aria-label', t`Back`);
    const chevron = document.createElement('i');
    chevron.className = 'fa-solid fa-chevron-left';
    chevron.setAttribute('aria-hidden', 'true');
    back.append(chevron);
    back.addEventListener('click', onClose);
    const heading = document.createElement('h2');
    heading.textContent = title;
    header.append(back, heading);
    root.append(header);
    host.replaceChildren(root);
    return root;
}

export function mountLegacySettings({ host, footer, onClose }) {
    const marker = document.createComment('Agents settings origin');
    footer.before(marker);
    const root = page(host, t`Settings`, onClose);
    root.append(footer);
    normalizeBackendSettingsRows(footer);
    return { destroy() { marker.replaceWith(footer); root.remove(); } };
}

export function mountLegacyGroups({ host, adapter, onClose, run }) {
    const root = page(host, t`Agent Groups`, onClose);
    const render = () => {
        for (const child of [...root.children].slice(1)) child.remove();
        for (const builtin of [true, false]) {
            const rows = adapter.getGroups().filter(group => Boolean(group.builtin) === builtin).map(group => {
                const controls = document.createElement('span');
                controls.className = 'ica-agents-group-actions';
                const turnOn = document.createElement('button');
                turnOn.type = 'button';
                turnOn.className = 'menu_button';
                turnOn.textContent = t`Turn On`;
                turnOn.addEventListener('click', () => run(async () => {
                    turnOn.disabled = true;
                    try { await adapter.turnOnGroup(group); } finally { turnOn.disabled = false; }
                }));
                controls.append(turnOn);
                if (!builtin) {
                    const remove = document.createElement('button');
                    remove.type = 'button';
                    remove.className = 'menu_button';
                    remove.textContent = t`Delete…`;
                    remove.addEventListener('click', () => run(async () => {
                        if (!await confirmDestructiveAction({ text: t`lorum ipsum`, confirmLabel: t`Delete`, copyPlaceholder: true })) return;
                        await adapter.deleteGroup(group.id);
                        render();
                    }));
                    controls.append(remove);
                }
                return createRow({ label: group.name, subtitle: group.description, suffix: controls }).row;
            });
            const group = createPrefGroup({ title: builtin ? t`Built-in Groups` : t`Custom Groups`, rows });
            root.append(group.section);
        }
        const create = createButtonRow({ label: t`Save Agents as Group…`, icon: 'plus', onActivate: () => run(async () => { await adapter.createGroup(); render(); }) });
        root.append(createPrefGroup({ rows: [create.row] }).section);
    };
    render();
    return { destroy() { root.remove(); } };
}
