function getDatasetValue(row, key) {
    return row?.dataset?.[key] ?? row?.[key] ?? '';
}

function hasClass(row, className) {
    if (row?.classList?.contains?.(className)) {
        return true;
    }

    if (typeof row?.className === 'string') {
        return row.className.split(/\s+/u).includes(className);
    }

    if (Array.isArray(row?.classes)) {
        return row.classes.includes(className);
    }

    return row?.classes instanceof Set && row.classes.has(className);
}

function normalizeKey(value) {
    return String(value || '').trim();
}

function ensureLockStore(settings) {
    if (!settings || typeof settings !== 'object') {
        return {};
    }

    if (!settings.promptSectionLocks || typeof settings.promptSectionLocks !== 'object') {
        settings.promptSectionLocks = {};
    }

    return settings.promptSectionLocks;
}

export function getSectionLockState(settings, sectionId, sectionName, defaultValue = true) {
    const locks = ensureLockStore(settings);
    const idKey = normalizeKey(sectionId);
    const nameKey = normalizeKey(sectionName);
    const stateById = idKey ? locks[idKey] : undefined;
    const stateByName = nameKey ? locks[nameKey] : undefined;
    const resolvedState = typeof stateById === 'boolean'
        ? stateById
        : typeof stateByName === 'boolean'
            ? stateByName
            : Boolean(defaultValue);

    if (idKey) {
        locks[idKey] = resolvedState;
    }
    if (nameKey) {
        locks[nameKey] = resolvedState;
    }

    return resolvedState;
}

export function setSectionLockState(settings, sectionId, sectionName, isLocked) {
    const locks = ensureLockStore(settings);
    const idKey = normalizeKey(sectionId);
    const nameKey = normalizeKey(sectionName);
    const nextState = Boolean(isLocked);

    if (idKey) {
        locks[idKey] = nextState;
    }
    if (nameKey) {
        locks[nameKey] = nextState;
    }
}

export function buildSectionBlocks(rows) {
    const blocks = [];
    const blockBySectionId = new Map();
    let currentBlock = null;

    Array.from(rows || []).forEach(row => {
        const sectionId = normalizeKey(getDatasetValue(row, 'sectionId'));
        const identifier = normalizeKey(getDatasetValue(row, 'pmIdentifier') || getDatasetValue(row, 'identifier'));
        const isSectionRow = Boolean(row?.isSection) || hasClass(row, 'bpt-section-row');

        if (isSectionRow && sectionId) {
            currentBlock = { sectionId, promptIds: [] };
            blocks.push(currentBlock);
            blockBySectionId.set(sectionId, currentBlock);
            return;
        }

        if (!identifier || !sectionId) {
            return;
        }

        const block = currentBlock?.sectionId === sectionId
            ? currentBlock
            : blockBySectionId.get(sectionId) ?? { sectionId, promptIds: [] };

        if (!blockBySectionId.has(sectionId)) {
            blocks.push(block);
            blockBySectionId.set(sectionId, block);
        }

        if (!block.promptIds.includes(identifier)) {
            block.promptIds.push(identifier);
        }
    });

    return blocks;
}

export function computeReorderedOrder(order, blocks, fromSectionId, toSectionId) {
    const promptOrder = Array.isArray(order) ? order : [];
    const sectionBlocks = Array.isArray(blocks) ? blocks : [];
    const fromId = normalizeKey(fromSectionId);
    const toId = toSectionId === null || toSectionId === undefined ? null : normalizeKey(toSectionId);

    if (!fromId || fromId === toId) {
        return promptOrder.slice();
    }

    const fromBlock = sectionBlocks.find(block => normalizeKey(block?.sectionId) === fromId);
    const toBlock = toId ? sectionBlocks.find(block => normalizeKey(block?.sectionId) === toId) : null;

    if (!fromBlock || (toId && !toBlock)) {
        return promptOrder.slice();
    }

    const entryById = new Map(promptOrder.map(entry => [normalizeKey(entry?.identifier), entry]));
    const movingIds = Array.from(fromBlock.promptIds || [])
        .map(normalizeKey)
        .filter(identifier => identifier && entryById.has(identifier));

    if (!movingIds.length) {
        return promptOrder.slice();
    }

    const movingIdSet = new Set(movingIds);
    const movingEntries = movingIds.map(identifier => entryById.get(identifier));
    const remainingEntries = promptOrder.filter(entry => !movingIdSet.has(normalizeKey(entry?.identifier)));
    let targetIndex = remainingEntries.length;

    if (toBlock) {
        const targetIds = new Set(Array.from(toBlock.promptIds || []).map(normalizeKey).filter(Boolean));
        targetIndex = remainingEntries.findIndex(entry => targetIds.has(normalizeKey(entry?.identifier)));

        if (targetIndex === -1) {
            return promptOrder.slice();
        }
    }

    return [
        ...remainingEntries.slice(0, targetIndex),
        ...movingEntries,
        ...remainingEntries.slice(targetIndex),
    ];
}
