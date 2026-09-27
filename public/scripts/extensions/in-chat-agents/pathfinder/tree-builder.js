import { addEntryToNode, saveTree, getSettings, getTree, isEntryEligible, syncTrackerUidsForLorebook } from './tree-store.js';
import { createLayoutNode, getEntryPlacement, readTreeLayout } from './tree-layout.js';

function getCategory(entry) {
    const title = String(entry.comment || entry.key?.[0] || `Entry ${entry.uid}`).trim();
    if (/^\[Tracker\]/i.test(title)) return 'Trackers';
    if (/^\[Summary\]/i.test(title)) return 'Summaries';
    if (/^(character|npc|creature|faction)/i.test(title)) return 'Characters';
    if (/^(location|place|area|room|building|city|town|dungeon)/i.test(title)) return 'Locations';
    if (/^(rule|mechanic|system|magic|combat|skill)/i.test(title)) return 'World Rules';
    return 'Uncategorized';
}

export function deriveTreeFromMetadata(bookName, bookData, cachedTree = null) {
    const layout = readTreeLayout(bookData);
    const nodes = new Map();
    const categories = new Map();
    const restore = (stored, runtime = false) => {
        const node = createLayoutNode(bookName, stored.name, stored.description, runtime ? stored.localId : stored.id);
        if (stored.generatedCategory !== undefined) {
            node.generatedCategory = stored.generatedCategory;
            categories.set(node.generatedCategory, node);
        }
        nodes.set(node.localId, node);
        node.children = (stored.children || []).map(child => restore(child, runtime));
        return node;
    };
    const tree = layout ? restore(layout)
        : layout === undefined && cachedTree ? restore(cachedTree, true)
            : createLayoutNode(bookName, 'Root', 'Top-level waypoint map', 'root');
    nodes.set(tree.localId, tree);

    const seen = new Set();
    for (const entry of Object.values(bookData?.entries || {})) {
        if (!isEntryEligible(entry) || seen.has(entry.uid)) continue;
        seen.add(entry.uid);
        let target = nodes.get(getEntryPlacement(entry));
        if (!target) {
            const category = getCategory(entry);
            target = categories.get(category);
            if (!target) {
                let localId = `category_${category.replaceAll(' ', '_')}`;
                while (nodes.has(localId)) localId += '_';
                target = createLayoutNode(bookName, category, `${category} waypoint`, localId);
                target.generatedCategory = category;
                nodes.set(localId, target);
                categories.set(category, target);
                tree.children.push(target);
            }
        }
        addEntryToNode(target, entry.uid);
    }
    return tree;
}

export async function buildTreeFromMetadata(bookName, bookData) {
    const tree = deriveTreeFromMetadata(bookName, bookData);
    saveTree(bookName, tree);
    syncTrackerUidsForLorebook(bookName, bookData);
    return tree;
}

export async function getTreeWithAutoBuild(bookName) {
    const cachedTree = getTree(bookName);
    if (cachedTree) return cachedTree;
    try {
        const bookData = await window?.SillyTavern?.getContext?.()?.loadWorldInfo?.(bookName);
        return bookData?.entries ? await buildTreeFromMetadata(bookName, bookData) : null;
    } catch {
        return null;
    }
}

export async function buildTreeWithLLM(bookName, bookData, llmGenerate) {
    if (!bookData?.entries || readTreeLayout(bookData) !== undefined) {
        return await buildTreeFromMetadata(bookName, bookData);
    }

    const entries = Object.values(bookData.entries).filter(isEntryEligible);
    if (entries.length === 0) {
        return await buildTreeFromMetadata(bookName, bookData);
    }

    const chunkSize = getSettings().llmChunkSize ?? 30000;
    const chunks = [];
    let current = '';
    for (const entry of entries) {
        const text = `--- Entry UID:${entry.uid} Title:${entry.comment || entry.key?.[0] || 'Untitled'} ---\n${entry.content || ''}\n`;
        if ((current + text).length > chunkSize && current) {
            chunks.push(current);
            current = text;
        } else {
            current += text;
        }
    }
    if (current) chunks.push(current);

    const tree = createLayoutNode(bookName, 'Root', 'Top-level waypoint map', 'root');
    for (let i = 0; i < chunks.length; i++) {
        const prompt = `You are a knowledge base organizer. Given these lorebook entries, create a hierarchical waypoint map (tree structure) for organizing them into logical categories and sub-categories.

Format your response as:
WAYPOINT: Category Name
SUB: Sub-category Name
ENTRIES: uid1, uid2, uid3

Here are the entries:
${chunks[i]}

Respond ONLY with the waypoint structure. Do not add commentary.`;

        try {
            const response = await llmGenerate(prompt);
            const parsed = parseLLMTreeResponse(response, entries, bookName);
            for (const rootNode of parsed) {
                tree.children.push(rootNode);
            }
        } catch (err) {
            // The metadata fallback covers ALL entries, so appending it per
            // failed chunk would duplicate the whole category tree. Discard
            // the partial LLM tree and fall back once.
            console.warn(`[Pathfinder] LLM tree build chunk ${i} failed; falling back to metadata categorization:`, err);
            return await buildTreeFromMetadata(bookName, bookData);
        }
    }

    saveTree(bookName, tree);
    syncTrackerUidsForLorebook(bookName, bookData);
    return tree;
}

function parseLLMTreeResponse(response, entries, bookName) {
    const lines = (response || '').split('\n');
    const roots = [];
    let currentWaypoint = null;
    let currentSub = null;
    const entryMap = new Map();
    for (const e of entries) {
        entryMap.set(String(e.uid), e.uid);
    }

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('WAYPOINT:')) {
            const name = trimmed.slice(9).trim();
            currentWaypoint = createLayoutNode(bookName, name, `${name} waypoint`);
            currentSub = null;
            roots.push(currentWaypoint);
        } else if (trimmed.startsWith('SUB:')) {
            const name = trimmed.slice(4).trim();
            if (currentWaypoint) {
                currentSub = createLayoutNode(bookName, name, `${name} sub-waypoint`);
                currentWaypoint.children.push(currentSub);
            }
        } else if (trimmed.startsWith('ENTRIES:')) {
            const uidList = trimmed.slice(8).split(/[, ]+/).map(u => u.trim()).filter(Boolean);
            const target = currentSub || currentWaypoint;
            if (target) {
                for (const uidStr of uidList) {
                    const uid = entryMap.get(uidStr);
                    if (uid !== undefined) addEntryToNode(target, uid);
                }
            }
        }
    }
    return roots;
}
