import { createPrefGroup, createRow } from '../../../sillybunny-editor/rows.js';
import { createStatusPage } from '../../../sillybunny-editor/status-page.js';
import { t } from '../../../i18n.js';
import { createAgentPage, pageElement } from './settings-page.js';
import { createCompanionsPageController } from './companions-page-controller.js';
import { companionSummary } from './companion-labels.js';

export function mountCompanionsPage({ host, services, onClose, preparePopup }) {
    const page = createAgentPage({ host, title: t`Companions Overview`, onClose });
    page.root.dataset.agentPage = 'companions';
    const cache = new Map();
    const groups = new Map();
    let status;
    let controller;
    const runAction = callback => Promise.resolve().then(callback).catch(error => toastr.error(error.message));
    const action = (label, icon, callback) => {
        const button = pageElement('button', 'menu_button menu_button_icon ica-agents-page-action');
        button.type = 'button';
        button.title = label;
        button.setAttribute('aria-label', label);
        const glyph = pageElement('i', icon);
        glyph.setAttribute('aria-hidden', 'true');
        button.append(glyph);
        button.addEventListener('click', () => {
            preparePopup?.(button);
            runAction(callback);
        });
        return button;
    };
    const run = action(t`Run All on Last Message`, 'fa-solid fa-play', () => controller.runAll());
    const panel = action(t`Open Companion Panel`, 'fa-solid fa-table-columns', () => controller.openPanel());
    page.header.append(run, panel);
    const notice = pageElement('p', 'ica-agents-page-notice', t`lorum ipsum`);
    notice.dataset.sbCopyPlaceholder = 'true';
    page.body.append(notice);
    const render = state => {
        const scroll = page.body.scrollTop;
        run.hidden = panel.hidden = state.status !== 'ready';
        run.disabled = state.runAllDisabled;
        notice.hidden = !state.notice;
        if (state.status !== 'ready') {
            cache.forEach(entry => entry.row.destroy());
            cache.clear();
            groups.forEach(group => group.section.remove());
            groups.clear();
            if (!status) {
                status = createStatusPage({ icon: 'comments', title: t`Companions Unavailable`, description: t`lorum ipsum` });
                status.element.querySelector('.sb-status-page__description').dataset.sbCopyPlaceholder = 'true';
                page.body.append(status.element);
            }
            return;
        }
        status?.element.remove();
        status = null;
        const present = new Set();
        for (const section of state.sections) {
            if (!groups.has(section.id)) {
                const group = createPrefGroup({ title: section.id === 'companions' ? t`Companions` : t`Recent Notes`, subtitle: t`lorum ipsum`, field: section.id, rows: [] });
                group.section.querySelector('.ds-pref-group-subtitle').dataset.sbCopyPlaceholder = 'true';
                groups.set(section.id, group);
                page.body.append(group.section);
            }
            const group = groups.get(section.id);
            let previous = null;
            for (const value of section.rows) {
                const key = value.key ?? `companion:${value.id}`;
                present.add(key);
                let entry = cache.get(key);
                if (!entry) {
                    const tokens = pageElement('span', 'ica-agents-page-tokens');
                    const jump = action(t`Jump`, 'fa-solid fa-arrow-up-right-from-square', () => controller.jump(entry.value.messageIndex));
                    const row = createRow({
                        label: '', field: key, subtitle: ' ', activatable: section.id === 'companions',
                        suffix: section.id === 'companions' ? tokens : jump,
                        onActivate: () => runAction(() => controller.edit(entry.value.id)),
                    });
                    row.row.dataset.companionKey = key;
                    entry = { row, tokens, value };
                    cache.set(key, entry);
                }
                entry.value = value;
                const label = entry.row.row.querySelector('.ds-row-label');
                const subtitle = entry.row.row.querySelector('.ds-row-subtitle');
                label.textContent = value.name ?? value.agentName;
                if (section.id === 'companions') {
                    subtitle.textContent = companionSummary(value.config, value.enabled);
                    const input = value.tokenUsage.inputTokens.toLocaleString();
                    const output = value.tokenUsage.outputTokens.toLocaleString();
                    entry.tokens.textContent = value.tokenUsage.inputTokens || value.tokenUsage.outputTokens ? t`${input} in · ${output} out` : '';
                } else subtitle.textContent = value.snippet;
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
        page.body.scrollTop = scroll;
    };
    controller = createCompanionsPageController({ services, onChange: render });
    return {
        ...page, refresh: controller.refresh,
        captureState: () => ({ scrollTop: page.body.scrollTop, focusKey: document.activeElement?.closest('[data-companion-key]')?.dataset.companionKey }),
        restoreState(state) {
            if (!state) return;
            page.body.scrollTop = state.scrollTop ?? 0;
            cache.get(state.focusKey)?.row.row.focus({ preventScroll: true });
        },
        destroy() {
            controller.destroy();
            cache.forEach(entry => entry.row.destroy());
            page.destroy();
        },
    };
}
