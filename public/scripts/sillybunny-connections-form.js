import { createEntryRow } from './sillybunny-editor/rows.js';
import { createSelectRow } from './sillybunny-editor/select-row.js';

const GATES = '[data-source], [data-tg-type], [data-tg-type-mode], [data-source-mode], [data-mode], [data-cc-type], #openai_external_category, #pollinations_key_section, #oai_max_context_unlocked_block, .reverse_proxy_warning, .displayNone';
const TITLES = 'h4, label, .range-block-title';
const INTERACTIVE = 'a, button, .menu_button, .right_menu_button, i, .displayNone';
const MODEL_IDS = 'input[id$="_model_id"], #generic_model_textgenerationwebui';
const SUFFIX_ACTIONS = '.ds-row-suffix > :is(button, .menu_button, .right_menu_button):not(.ds-select-row__trigger), .sb-connections-model-field > :is(button, .menu_button, .right_menu_button)';

function gateChain(node) {
    const gates = [];
    for (let parent = node; parent; parent = parent.parentElement) {
        if (parent.matches(GATES)) gates.push(parent);
    }
    return gates;
}

function canMove(node, parent) {
    const before = gateChain(node);
    const after = [...(node.matches(GATES) ? [node] : []), ...gateChain(parent)];
    return before.length === after.length && before.every((gate, index) => gate === after[index]);
}

function titleText(node) {
    const read = parent => [...parent.childNodes].map(child => {
        if (child.nodeType === Node.TEXT_NODE) return child.textContent;
        if (!(child instanceof Element) || child.matches(INTERACTIVE)) return '';
        return read(child);
    }).join(' ');
    return (read(node).trim() || node.textContent).replace(/\s+/g, ' ').trim().replace(/\s*[:：]\s*$/, '');
}

function pickerNoneLabel(select) {
    if (select.dataset.placeholder) return select.dataset.placeholder;
    const placeholder = globalThis.jQuery?.(select).data('select2')?.options?.get('placeholder');
    const text = typeof placeholder === 'string' ? placeholder : placeholder?.text;
    return text || [...select.options].find(option => option.value === '')?.textContent.trim() || '';
}

function isHelp(node) {
    return !node.matches(`${TITLES}, ${GATES}, button, .menu_button, .right_menu_button, .select2-container, .neutral_warning[data-for], .ds-row, .inline-drawer, .online_status, .sb-connections-status-row`)
        && !node.querySelector('input, select, button, .menu_button, .inline-drawer')
        && Boolean(node.textContent.trim() || node.querySelector('a'));
}

function hasTextAfter(node) {
    for (let sibling = node.nextSibling; sibling; sibling = sibling.nextSibling) {
        if (sibling.textContent.trim()) return true;
    }
    return false;
}

function fieldContext(field, block) {
    let anchor = field;
    const help = [];
    while (anchor !== block) {
        if (anchor.matches('label') && anchor.contains(field)) return { anchor, title: anchor, help };
        for (let previous = anchor.previousElementSibling; previous; previous = previous.previousElementSibling) {
            if (previous.matches(TITLES)) return { anchor, title: previous, help };
            if (previous.matches('.sb-nanogpt-provider-picker')) continue;
            if (!isHelp(previous)) break;
            help.unshift(previous);
        }
        const parent = anchor.parentElement;
        if (!parent || parent === block || parent.matches(GATES) || parent.querySelectorAll('input, select').length !== 1) break;
        anchor = parent;
    }
    return { anchor: field, title: null, help: [] };
}

/** Connections alone adopts upstream form fields; the generic settings normaliser keeps forms opaque. */
export function applyConnectionsFormPass(block, ctx) {
    const { moveNode, snapshotAttributes, addLegacyClass, controllers, generated, t } = ctx;
    const touch = node => {
        snapshotAttributes(node);
        return node;
    };
    const move = (node, parent) => {
        if (!canMove(node, parent)) return false;
        moveNode(touch(node), parent);
        return true;
    };
    const describe = (control, node) => {
        touch(node);
        node.id ||= `sb-connections-help-${control.id}-${control.getAttribute('aria-describedby')?.split(' ').length ?? 0}`;
        const ids = new Set((control.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean));
        ids.add(node.id);
        control.setAttribute('aria-describedby', [...ids].join(' '));
    };
    const applyTitle = (row, title) => {
        if (!title) return;
        const caption = row.querySelector('.ds-row-label');
        const source = title.matches('[data-i18n]') ? title : title.querySelector('[data-i18n]:not(a):not(i):not(small)');
        if (source?.dataset.i18n && !source.dataset.i18n.includes('[')) caption.dataset.i18n = source.dataset.i18n;
        addLegacyClass(touch(title), 'sb-connections-field-title');
        addLegacyClass(title, 'sb-legacy-search-hidden');
    };
    const placeHelp = (control, row, nodes) => {
        for (const node of nodes) {
            if (!canMove(node, row)) continue;
            if (node.matches('a') && !node.textContent.trim() && node.querySelector('i, .fa-solid, .fa-regular, .fa')) {
                let suffix = row.querySelector('.ds-row-suffix');
                if (!suffix) {
                    suffix = document.createElement('span');
                    suffix.className = 'ds-row-suffix';
                    (row.querySelector('.ds-row-entry__line') ?? row).append(suffix);
                }
                addLegacyClass(touch(node), 'sb-connections-icon-help');
                if (node.title) node.setAttribute('aria-label', node.title);
                else {
                    const label = row.querySelector('.ds-row-label');
                    label.id ||= `sb-connections-label-${control.id}`;
                    node.setAttribute('aria-labelledby', label.id);
                }
                move(node, suffix);
                continue;
            }
            const multiline = node.matches('ol, ul') || node.querySelector('ol, ul') || [...node.querySelectorAll('br')].some(hasTextAfter);
            if (multiline) {
                addLegacyClass(touch(node), 'sb-connections-description');
                move(node, row.parentElement);
                row.before(node);
                continue;
            }
            const caption = document.createElement('div');
            caption.className = 'ds-row-subtitle ds-row-entry__caption';
            row.append(caption);
            move(node, caption);
            describe(control, node);
        }
    };

    for (const input of block.querySelectorAll(MODEL_IDS)) {
        const upstreamRow = input.parentElement;
        const { title } = fieldContext(upstreamRow, block);
        if (!title || !canMove(upstreamRow, upstreamRow.parentElement)) continue;
        touch(input);
        if (!input.hasAttribute('placeholder')) input.setAttribute('placeholder', ' ');
        const shell = document.createElement('div');
        shell.className = 'ds-row ds-row-entry ds-row-entry--floating sb-connections-model-row';
        shell.dataset.sbEditorField = input.id;
        const line = document.createElement('div');
        line.className = 'ds-row-entry__line';
        shell.append(line);
        upstreamRow.before(shell);
        move(upstreamRow, line);
        addLegacyClass(upstreamRow, 'ds-row-entry__field');
        addLegacyClass(upstreamRow, 'sb-connections-model-field');
        const label = document.createElement('label');
        label.className = 'ds-row-label ds-row-entry__title';
        label.htmlFor = input.id;
        label.textContent = titleText(title);
        upstreamRow.prepend(label);
        generated.push(shell, label);
        applyTitle(shell, title);
    }

    for (const input of block.querySelectorAll('input, select')) {
        const isSelect = input instanceof HTMLSelectElement;
        if ((!isSelect && !['text', 'url', 'search', 'email', 'tel'].includes(input.type))
            || input.matches(`${MODEL_IDS}, #featherless_model_search_bar, select[id^="featherless_"], select.displayNone, select[hidden], #chat_completion_source, #textgen_type`)
            || input.closest('.ds-row-entry--floating, .ds-select-row')) continue;
        const context = fieldContext(input, block);
        const { title, anchor } = context;
        const label = input.id === 'custom_model_textgenerationwebui' ? t`Custom Model`
            : input.matches('select[id$="_sort_models"]') ? t`Sort Models` : title ? titleText(title) : '';
        if (!label || !canMove(input, anchor.parentElement)) continue;
        const rowParent = anchor.parentElement;
        const help = [...context.help];
        for (let following = anchor.nextElementSibling; following && isHelp(following); following = following.nextElementSibling) help.push(following);
        const holding = document.createElement('div');
        holding.hidden = true;
        rowParent.insertBefore(holding, anchor);
        generated.push(holding);
        const container = isSelect && input.nextElementSibling?.matches('.select2-container') ? input.nextElementSibling : null;
        const noneLabel = isSelect ? pickerNoneLabel(input) : '';
        move(input, holding);
        if (container) move(container, holding);
        const manager = anchor.querySelector?.('.manage-api-keys');
        const suffix = [...(manager ? [manager] : [])];
        if (isSelect) {
            const tied = {
                openai_proxy_preset: '#save_proxy, #delete_proxy',
                custom_endpoint_preset: '#save_custom_endpoint, #delete_custom_endpoint',
                ollama_model: '#ollama_download_model',
                tabby_model: '#tabby_download_model',
                model_openai_select: '#model_openai_favorite_toggle',
            };
            if (tied[input.id]) suffix.push(...block.querySelectorAll(tied[input.id]));
        }
        if (title && title !== anchor) suffix.push(...title.querySelectorAll('button, .menu_button, .right_menu_button, i:not(a i)'));
        const extra = input.id === 'horde_api_key' ? block.querySelector('#horde_api_key_button')
            : input.id === 'vertexai_service_account_json' ? block.querySelector('#vertexai_validate_service_account')
                : input.id === 'openai_proxy_access_key' ? block.querySelector('#openai_proxy_access_key_show') : null;
        if (extra) suffix.push(extra);
        const safeSuffix = suffix.filter(node => canMove(node, holding));
        safeSuffix.forEach(node => move(node, holding));
        const viewer = document.getElementById('viewSecrets');
        const row = isSelect ? createSelectRow({
            select: input,
            label,
            field: input.id,
            noneLabel,
            ordered: input.classList.contains('openrouter_providers'),
            suffix: safeSuffix,
        }) : createEntryRow({
            input,
            label,
            field: input.id,
            floating: true,
            suffix: safeSuffix,
            ...(manager ? { secret: {
                savedText: viewer?.getAttribute('key_saved_text') ?? '',
                missingText: viewer?.getAttribute('missing_key_text') ?? '',
                revealLabel: input.id === 'vertexai_service_account_json' ? t`Reveal Service Account JSON` : t`Reveal API Key`,
            } } : {}),
        });
        rowParent.insertBefore(row.row, holding);
        controllers.push(row);
        applyTitle(row.row, title);
        const warning = block.querySelector(`[data-for="${CSS.escape(input.id)}"]`);
        if (warning) {
            addLegacyClass(touch(warning), 'ds-row-entry__caption');
            addLegacyClass(warning, 'ds-row-subtitle');
            describe(input, warning);
        }
        placeHelp(input, row.row, help);
        if (title && title !== anchor) {
            const links = [...title.querySelectorAll('a')];
            placeHelp(input, row.row, links);
        }
        if (anchor !== input && anchor !== title && !anchor.textContent.trim()
            && !anchor.querySelector('input, select, button, a, .menu_button')) {
            addLegacyClass(touch(anchor), 'sb-connections-empty');
        }
    }

    for (const drawer of block.querySelectorAll('.inline-drawer')) {
        const header = drawer.querySelector(':scope > .inline-drawer-toggle');
        const content = drawer.querySelector(':scope > .inline-drawer-content');
        if (!header || !content) continue;
        addLegacyClass(touch(drawer), 'sb-connections-expander');
        addLegacyClass(drawer, 'ds-row-expander');
        addLegacyClass(touch(header), 'ds-row');
        touch(content);
        content.id ||= `sb-connections-drawer-${block.id}-${[...block.querySelectorAll('.inline-drawer')].indexOf(drawer)}`;
        header.setAttribute('role', 'button');
        header.tabIndex = 0;
        header.setAttribute('aria-controls', content.id);
        const sync = () => header.setAttribute('aria-expanded', String(header.querySelector('.inline-drawer-icon')?.classList.contains('up') ?? false));
        sync();
        const observer = new MutationObserver(sync);
        observer.observe(header.querySelector('.inline-drawer-icon') ?? content, { attributes: true, attributeFilter: ['class', 'style'] });
        const keydown = event => {
            if (event.target !== header || !['Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            header.click();
        };
        header.addEventListener('keydown', keydown);
        controllers.push({ destroy() { observer.disconnect(); header.removeEventListener('keydown', keydown); } });
    }

    const adaptedActions = new WeakSet();
    const syncActions = () => {
        for (const action of block.querySelectorAll(SUFFIX_ACTIONS)) {
            addLegacyClass(touch(action), 'sb-connections-flat-action');
            if (!action.hasAttribute('aria-label') && (action.title || action.textContent.trim())) {
                action.setAttribute('aria-label', action.title || action.textContent.trim());
            }
            if (!adaptedActions.has(action) && !action.matches('button, a')) {
                action.setAttribute('role', 'button');
                action.tabIndex = 0;
                const keydown = event => {
                    if (event.target !== action || !['Enter', ' '].includes(event.key)) return;
                    event.preventDefault();
                    action.click();
                };
                action.addEventListener('keydown', keydown);
                controllers.push({ destroy() { action.removeEventListener('keydown', keydown); } });
            }
            adaptedActions.add(action);
            const textOnly = action.textContent.trim() && !action.matches('.fa-solid, .fa-regular') && !action.querySelector('.fa-solid, .fa-regular, i');
            if (textOnly) {
                addLegacyClass(action, 'sb-connections-text-action');
                continue;
            }
            for (const label of action.querySelectorAll('span[data-i18n]')) addLegacyClass(label, 'sr-only');
            // openai.js reapplies inline !important geometry on rebuilds; keep its priority but let CSS choose the pointer size.
            for (const property of ['width', 'min-width', 'max-width', 'height', 'min-height', 'max-height', 'flex-basis']) {
                if (action.style.getPropertyValue(property) && action.style.getPropertyValue(property) !== 'var(--sb-connections-icon-size)') {
                    action.style.setProperty(property, 'var(--sb-connections-icon-size)', 'important');
                }
            }
        }
    };
    syncActions();
    const actionObserver = new MutationObserver(syncActions);
    actionObserver.observe(block, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    controllers.push({ destroy() { actionObserver.disconnect(); } });

    const parameters = block.querySelector('#customize_additional_parameters');
    const body = block.querySelector('.sb-connections-provider-body');
    if (parameters && body && canMove(parameters, body)) {
        const wrapper = document.createElement('div');
        wrapper.className = 'sb-connections-parameters';
        body.append(wrapper);
        generated.push(wrapper);
        move(parameters, wrapper);
        addLegacyClass(parameters, 'ds-row');
        addLegacyClass(parameters, 'ds-button-row');
    }
}
