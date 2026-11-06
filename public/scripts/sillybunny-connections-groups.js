import { createPrefGroup } from './sillybunny-editor/rows.js';

const MIRROR_ATTRIBUTES = ['data-source', 'data-source-mode', 'data-tg-type', 'data-tg-type-mode'];
const FIXED_GATES = '[data-mode], [data-cc-type], #openai_external_category, #pollinations_key_section, #oai_max_context_unlocked_block, .reverse_proxy_warning, .displayNone, [data-for]';
const SKIP = '.sb-connections-field-title, .sb-connections-source-label, .sb-connections-empty, .sb-connections-legacy, #chat_completion_source, #textgen_type, h4:has(+ #chat_completion_source), h4:has(+ #textgen_type), datalist, br, hr';
const ATOMIC = `.ds-row, .checkbox_label, .inline-drawer, .sb-connections-connect, .sb-connections-status-extra, #vertexai_form, ${FIXED_GATES}, .flexGap10:has(#featherless_model_search_bar)`;

// Ordered: indivisible units win over their descendants; unknown upstream fields remain reachable in Advanced.
const GROUP_RULES = [
    ['connection', '.sb-connections-connect, .sb-connections-status-extra, #vertexai_form, #pollinations_key_section, #ReverseProxyWarningMessage, #ReverseProxyWarningMessage2, #openai_proxy_preset, #custom_endpoint_preset'],
    ['providers', '.openrouter_providers, .openrouter_quantizations, [id^="openrouter_service_tier"], #openrouter_allow_fallbacks, #openrouter_allow_fallbacks_textgenerationwebui, #nanogpt_allowed_providers, #nanogpt_ignored_providers, #nanogpt_billing_warning, #nanogpt_provider_warning, #nanogpt_payg_override, #nanogpt_service_tier'],
    ['connection', 'input[id^="api_key_"], #horde_api_key, input[data-server-history], #custom_api_url_text, #azure_base_url, #azure_deployment_name, #azure_api_version, #workers_ai_account_id, select[id$="_endpoint"]'],
    ['model', '.sb-connections-model-row, select[id^="model_"], select[id$="_model"], #generic_model_select, #custom_model_textgenerationwebui, #azure_openai_model, #openai_show_external_models, #openrouter_use_fallback, [id$="_sort_models"], [id$="_group_models"], #featherless_model_search_bar'],
];

function matchesUnit(node, selector) {
    return node.matches(selector) || Boolean(node.querySelector(selector));
}

function groupFor(node) {
    return GROUP_RULES.find(([, selector]) => matchesUnit(node, selector))?.[0] ?? 'advanced';
}

function mirrorChain(node, block) {
    const chain = [];
    for (let parent = node.parentElement; parent && parent !== block; parent = parent.parentElement) {
        const attributes = MIRROR_ATTRIBUTES.filter(name => parent.hasAttribute(name)).map(name => [name, parent.getAttribute(name)]);
        if (attributes.length) chain.unshift({ attributes, display: parent.style.display });
        if (parent.matches(FIXED_GATES)) throw new Error(`Cannot regroup a descendant of ${parent.id || parent.className}`);
    }
    return chain;
}

function hasDisplayedContent(node) {
    if (getComputedStyle(node).display === 'none') return false;
    if (node.matches('input, select, button, a, .ds-row, .checkbox_label, .inline-drawer, .sb-connections-connect')) return true;
    return [...node.childNodes].some(child => child instanceof Element ? hasDisplayedContent(child) : child.nodeType === Node.TEXT_NODE && Boolean(child.textContent.trim()));
}

/** Regroups adopted rows, retaining every upstream node and all non-document-wide visibility gates. */
export function applyConnectionsGroups(block, { moveNode, addLegacyClass, snapshotAttributes, controllers, generated, t }) {
    const body = block.querySelector(':scope > .sb-connections-provider-body');
    if (!body) return;
    const entries = [];
    const help = [];
    const record = (node, notes = false) => {
        const chain = mirrorChain(node, block);
        const entry = { node, nodes: [node], group: groupFor(node), chain, signature: JSON.stringify(chain.map(gate => gate.attributes)) };
        (notes ? help : entries).push(entry);
    };
    const collect = parent => {
        for (const node of [...parent.children]) {
            if (node.matches(SKIP) || (node.hidden && !node.querySelector('input, select, button'))) continue;
            if (node.matches(ATOMIC)) {
                record(node, node.hasAttribute('data-for'));
                // Vertex auth queries are scoped to this element. Only model rows outside its modes can leave it.
                if (node.id === 'vertexai_form') {
                    for (const row of node.querySelectorAll('.sb-connections-model-row, .ds-select-row:has(#model_vertexai_select)')) record(row);
                }
                continue;
            }
            if (node.querySelector('input, select, button, .ds-row, .checkbox_label, .inline-drawer, .sb-connections-connect, .sb-connections-status-extra')) {
                collect(node);
                continue;
            }
            if (node.matches('input, select, button, .menu_button') || node.textContent.trim() || node.querySelector('a')) record(node, !node.matches('input, select, button, .menu_button'));
        }
    };
    collect(body);

    for (const note of help) {
        const sameGate = entries.filter(entry => entry.signature === note.signature);
        const field = note.node.getAttribute('data-for');
        const associated = field && sameGate.find(entry => entry.node.contains(document.getElementById(field)));
        const following = sameGate.find(entry => note.node.compareDocumentPosition(entry.node) & Node.DOCUMENT_POSITION_FOLLOWING);
        const previous = sameGate.filter(entry => note.node.compareDocumentPosition(entry.node) & Node.DOCUMENT_POSITION_PRECEDING).at(-1);
        const intro = note.node.querySelector('a[href]') && !note.node.matches('h4');
        const classified = note.group !== 'advanced' && sameGate.find(entry => entry.group === note.group);
        const owner = associated || classified || (intro ? sameGate.find(entry => entry.group === 'connection') : null) || following || previous;
        if (owner) {
            note.group = owner.group;
            const precedes = Boolean(note.node.compareDocumentPosition(owner.node) & Node.DOCUMENT_POSITION_FOLLOWING);
            if (precedes) owner.nodes.splice(owner.nodes.indexOf(owner.node), 0, note.node);
            else owner.nodes.push(note.node);
        } else {
            entries.push(note);
        }
    }

    const groups = new Map([
        ['connection', t`Connection`, t`Supply the backend's API key and test for a connection`],
        ['model', t`Model`, t`Specify which model is queried from the backend`],
        ['providers', t`Providers`, t`Extra settings for model providers`],
        ['advanced', t`Advanced`, t`Advanced settings that affect your backend queries`],
    ].map(([id, title, subtitle]) => {
        const group = createPrefGroup({ title, subtitle, field: `${block.id}-${id}` });
        group.section.dataset.sbConnectionsGroup = id;
        body.before(group.section);
        generated.push(group.section);
        return [id, { ...group, units: [], lastSignature: null, destination: null }];
    }));
    const priority = entry => entry.node.matches('.sb-connections-connect') ? -2 : entry.node.matches('.sb-connections-status-extra') ? -1
        : matchesUnit(entry.node, '#openai_proxy_preset') ? 2 : entry.node.id === 'ReverseProxyWarningMessage' ? 3 : 0;
    entries.sort((a, b) => priority(a) - priority(b));
    for (const entry of entries) {
        const group = groups.get(entry.group);
        if (entry.signature !== group.lastSignature) {
            group.destination = group.group;
            for (const gate of entry.chain) {
                const mirror = document.createElement('div');
                mirror.className = 'sb-connections-mirror';
                mirror.dataset.sbConnectionsMirror = '';
                for (const [name, value] of gate.attributes) mirror.setAttribute(name, value);
                mirror.style.display = gate.display;
                group.destination.append(mirror);
                group.destination = mirror;
            }
            group.lastSignature = entry.signature;
        }
        const unit = document.createElement('div');
        unit.className = 'sb-connections-unit';
        group.destination.append(unit);
        for (const node of entry.nodes) moveNode(node, unit);
        group.units.push({ ...entry, unit });
    }
    snapshotAttributes(body);
    addLegacyClass(body, 'sb-connections-legacy');

    const isDisplayedWithin = (node, root) => {
        for (let element = node; element && element !== root; element = element.parentElement) {
            if (getComputedStyle(element).display === 'none') return false;
        }
        return true;
    };
    let frame = null;
    const sync = () => {
        frame = null;
        const updates = [];
        for (const group of groups.values()) {
            let first = true;
            const units = [];
            for (const { nodes, unit } of group.units) {
                const displayed = nodes.some(node => {
                    for (let parent = node.parentElement; parent && parent !== group.group; parent = parent.parentElement) {
                        if (parent === unit) continue;
                        if (getComputedStyle(parent).display === 'none') return false;
                    }
                    return hasDisplayedContent(node);
                });
                const firstUnit = first && displayed;
                if (displayed) first = false;
                // Rows nested at different depths inside one unit (#vertexai_form) cannot be separated by a sibling selector.
                let firstRow = true;
                const rows = [...unit.querySelectorAll('.ds-row')].map(row => {
                    const shown = isDisplayedWithin(row, unit);
                    const separator = shown && !firstRow;
                    if (shown) firstRow = false;
                    return { row, separator };
                });
                units.push({ unit, displayed, firstUnit, rows });
            }
            updates.push({ section: group.section, hidden: first, units });
        }
        // Read every display state before changing attributes; interleaving them forces a style recalculation per row.
        for (const { section, hidden, units } of updates) {
            for (const { unit, displayed, firstUnit, rows } of units) {
                if (unit.hidden === displayed) unit.hidden = !displayed;
                unit.toggleAttribute('data-sb-connections-first', firstUnit);
                for (const { row, separator } of rows) row.toggleAttribute('data-sb-connections-row-separator', separator);
            }
            if (section.hidden !== hidden) section.hidden = hidden;
        }
    };
    const schedule = () => { frame ??= requestAnimationFrame(sync); };
    const observer = new MutationObserver(schedule);
    observer.observe(block, { subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'], childList: true });
    controllers.push({ destroy() { observer.disconnect(); if (frame !== null) cancelAnimationFrame(frame); } });
    sync();
    return { sync: schedule };
}
