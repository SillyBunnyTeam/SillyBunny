const REMOVED_IDS = new Set(['tpl-anti-slop-regex', 'tpl-director-core', 'tpl-nsfw-mode']);
const REMOVED_NAMES = new Set(['anti-slop regex', 'director core', 'nsfw mode']);
const STAGES = ['pre', 'both', 'post', 'companion'];
const companion = agent => agent.execution === 'companion' || agent.category === 'companion';
const order = agent => Number.isFinite(Number(agent.injection?.order)) ? Number(agent.injection.order) : 0;

function excluded(entry) {
    const agent = entry.agent;
    const source = agent.sourceTemplateId || entry.template?.id;
    return source === 'tpl-pathfinder' || agent.name === 'Pathfinder'
        || (agent.category === 'tool' && agent.tools?.some(tool => tool.name?.startsWith('Pathfinder_')))
        || REMOVED_IDS.has(source)
        || (REMOVED_NAMES.has(String(agent.name).trim().toLowerCase()) && String(agent.author).trim().toLowerCase() === 'sillybunny');
}

export function getAgentSelectionKey(key) {
    return key.startsWith('pinned:') ? key.slice(7) : key;
}

export function buildAgentListModel({ entries, categories, search = '', filters = {}, enabledKeys }) {
    const universe = entries.filter(entry => entry.kind === 'agent' && !excluded(entry));
    const enabled = entry => enabledKeys ? enabledKeys.has(entry.key) : Boolean(entry.agent.enabled);
    const query = search.toLowerCase();
    const filtered = Boolean(query || filters.onlyOn || filters.categories?.length);
    const visible = universe.filter(entry => {
        const agent = entry.agent;
        if (filters.onlyOn && !enabled(entry)) return false;
        if (filters.categories?.length && !filters.categories.includes(agent.category)) return false;
        return !query || [agent.name, agent.description, ...(agent.tags ?? [])].some(text => String(text ?? '').toLowerCase().includes(query));
    });
    function groups(items, pinnedCopy = false) {
        return Object.keys(categories).flatMap(category => {
            const members = items.filter(entry => entry.agent.category === category);
            if (!members.length) return [];
            const rows = members.sort((a, b) => order(a.agent) - order(b.agent)
                || a.agent.name.localeCompare(b.agent.name) || a.key.localeCompare(b.key))
                .map(entry => ({ key: pinnedCopy ? `pinned:${entry.key}` : entry.key, selectionKey: entry.key, entry, enabled: enabled(entry), pinnedCopy }));
            return [{ key: category, category, label: categories[category].label, rows }];
        });
    }
    const sections = [];
    const pinned = groups(visible.filter(entry => entry.agent.favorite), true);
    if (pinned.length) sections.push({ key: 'pinned', groups: pinned });
    for (const key of STAGES) {
        const stageGroups = groups(visible.filter(entry => (companion(entry.agent) ? 'companion' : entry.agent.phase) === key));
        if (stageGroups.length) sections.push({ key, groups: stageGroups });
    }
    const visibleKeys = sections.filter(section => section.key !== 'pinned').flatMap(section => section.groups.flatMap(group => group.rows.map(row => row.selectionKey)));
    return { sections, visibleKeys, savedCount: universe.length, onCount: universe.filter(enabled).length, filtered };
}

export function buildAgentTemplatePickerModel({ entries, categories, subcategories = {}, companionTemplates = false }) {
    const templates = new Map();
    for (const entry of entries) {
        const template = entry.template;
        if (!template || excluded({ agent: template, template }) || companion(template) !== companionTemplates) continue;
        if (!templates.has(template.id) || templates.get(template.id).kind !== 'agent') templates.set(template.id, entry);
    }
    return Object.keys(categories).flatMap(category => {
        const members = [...templates.values()].filter(entry => entry.template.category === category);
        const subgroup = entry => entry.template.subcategory || '';
        const unknown = [...new Set(members.map(subgroup))].filter(key => key && !Object.hasOwn(subcategories, key)).sort();
        return ['', ...Object.keys(subcategories), ...unknown].flatMap(subcategory => members
            .filter(entry => subgroup(entry) === subcategory)
            .sort((a, b) => a.template.name.localeCompare(b.template.name) || a.template.id.localeCompare(b.template.id))
            .map(entry => ({
                id: entry.template.id, label: entry.template.name, description: entry.template.description || '',
                group: subcategory ? `${categories[category].label} · ${subcategories[subcategory]?.label ?? subcategory}` : categories[category].label,
                added: entry.kind === 'agent', entry,
            })));
    });
}

export function getAgentSelectionKeys(model) {
    return [...new Set(model.visibleKeys)];
}

function savedNeighbours(model, key) {
    if (model.filtered || key.startsWith('pinned:')) return [];
    for (const section of model.sections) {
        if (section.key === 'pinned') continue;
        for (const group of section.groups) {
            const keys = group.rows.map(row => row.key);
            if (keys.includes(key)) return keys;
        }
    }
    return [];
}

export function moveAgentWithinSubheading(model, { key, direction, orderedKeys }) {
    const keys = savedNeighbours(model, key);
    if (!keys.length) return null;
    const next = [...keys];
    if (orderedKeys) {
        if (orderedKeys.length !== keys.length || new Set(orderedKeys).size !== keys.length || orderedKeys.some(key => !keys.includes(key))) return null;
        return { orderedKeys: [...orderedKeys], focusKey: key };
    }
    const index = keys.indexOf(key);
    const target = index + direction;
    if (![-1, 1].includes(direction) || target < 0 || target >= keys.length) return null;
    [next[index], next[target]] = [next[target], next[index]];
    return { orderedKeys: next, focusKey: key };
}

export function getAgentRowMenuItems(entry, { model, rowKey = entry.key }) {
    if (entry.kind !== 'agent') return [];
    const agent = entry.agent;
    const isCompanion = companion(agent);
    const items = [];
    const add = (id, section, values = {}) => items.push({ id, section, ...values });
    add(agent.favorite ? 'unpin' : 'pin', 'organise');
    if (moveAgentWithinSubheading(model, { key: rowKey, direction: -1 })) add('move-up', 'organise');
    if (moveAgentWithinSubheading(model, { key: rowKey, direction: 1 })) add('move-down', 'organise');
    if (isCompanion) {
        add('preview-feedback', 'run');
        add('run-last', 'run');
    } else {
        if (['pre', 'both'].includes(agent.phase) && String(agent.prompt ?? '').trim()) add('preview-prompt', 'run');
        add('apply-last', 'run');
        add('apply-target', 'run');
    }
    if (agent.category !== 'tool') add(isCompanion ? 'convert-inline' : 'convert-companion', 'manage');
    add('duplicate', 'manage');
    if (entry.kind === 'agent' && entry.template && Number(entry.template.version ?? 1) > Number(agent.version ?? 1)) {
        add('update', 'manage', { version: Number(entry.template.version) });
    }
    add('export', 'manage');
    if (entry.kind === 'agent') {
        if (entry.template) add('restore-default', 'destructive', { danger: true });
        add('delete', 'destructive', { danger: true });
    }
    return items;
}
