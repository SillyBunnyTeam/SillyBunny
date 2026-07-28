import { createTreeNode, createEmptyTree, addEntryToNode, saveTree, getSettings } from './tree-store.js';

function categorizeEntries(entries) {
    const categories = {};
    for (const [, entry] of Object.entries(entries)) {
        if (!entry || entry.disable) continue;
        const title = (entry.comment || entry.key?.[0] || `Entry ${entry.uid}`).trim();
        let category = 'Uncategorized';
        if (/^\[Tracker\]/i.test(title)) category = 'Trackers';
        else if (/^\[Summary\]/i.test(title)) category = 'Summaries';
        else if (/^(character|npc|creature|faction)/i.test(title)) category = 'Characters';
        else if (/^(location|place|area|room|building|city|town|dungeon)/i.test(title)) category = 'Locations';
        else if (/^(rule|mechanic|system|magic|combat|skill)/i.test(title)) category = 'World Rules';
        if (!categories[category]) categories[category] = [];
        categories[category].push({ uid: entry.uid, title, content: entry.content || '' });
    }
    return categories;
}

export async function buildTreeFromMetadata(bookName, bookData) {
    if (!bookData || !bookData.entries) {
        return createEmptyTree();
    }

    const tree = createEmptyTree(bookName, '');
    const categories = categorizeEntries(bookData.entries);

    for (const [catName, catEntries] of Object.entries(categories)) {
        const catNode = createTreeNode(catName, `${catName} waypoint`);
        for (const entry of catEntries) {
            addEntryToNode(catNode, entry.uid);
        }
        tree.children.push(catNode);
    }

    saveTree(bookName, tree);
    return tree;
}

export async function buildTreeWithLLM(bookName, bookData, llmGenerate) {
    if (!bookData || !bookData.entries) {
        return createEmptyTree();
    }

    const entries = Object.values(bookData.entries).filter(e => e && !e.disable);
    if (entries.length === 0) {
        return createEmptyTree();
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

    const tree = createEmptyTree(bookName, '');
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
            const parsed = parseLLMTreeResponse(response, entries);
            for (const rootNode of parsed) {
                tree.children.push(rootNode);
            }
        } catch (err) {
            console.warn(`[Pathfinder] LLM tree build chunk ${i} failed:`, err);
            const fallback = await buildTreeFromMetadata(bookName, bookData);
            for (const child of fallback.children) {
                tree.children.push(child);
            }
        }
    }

    saveTree(bookName, tree);
    return tree;
}

function parseLLMTreeResponse(response, entries) {
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
            currentWaypoint = createTreeNode(name, `${name} waypoint`);
            currentSub = null;
            roots.push(currentWaypoint);
        } else if (trimmed.startsWith('SUB:')) {
            const name = trimmed.slice(4).trim();
            if (currentWaypoint) {
                currentSub = createTreeNode(name, `${name} sub-waypoint`);
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

export async function generateSummariesForTree(bookName, tree, llmGenerate) {
    if (!tree) return;
    tree.description = await generateNodeSummary(tree, llmGenerate);
    for (const child of tree.children || []) {
        await generateSummariesForTree(bookName, child, llmGenerate);
    }
    saveTree(bookName, tree);
}

async function generateNodeSummary(node, llmGenerate) {
    if (!node || node.entries.length === 0 && (!node.children || node.children.length === 0)) {
        return node.description || '';
    }
    const entrySummaries = (node.entries || []).map(uid => `Entry UID:${uid}`).join(', ');
    const childNames = (node.children || []).map(c => c.name).join(', ') || 'none';
    const prompt = `Write a 1-2 sentence summary for a waypoint named "${node.name}" that contains:
- Entries: ${entrySummaries || 'none'}
- Sub-waypoints: ${childNames}

Write ONLY the summary, no labels.`;
    try {
        return await llmGenerate(prompt);
    } catch {
        return node.description || '';
    }
}

export async function ingestChatMessages(bookName, messages, createEntryFn) {
    if (!Array.isArray(messages) || messages.length === 0) return 0;
    let count = 0;
    for (const msg of messages) {
        if (msg?.is_system || !msg?.mes?.trim()) continue;
        const title = `[Summary] ${msg.name || 'Unknown'} - Message ${count + 1}`;
        try {
            await createEntryFn(bookName, title, msg.mes, ['autogenerated', 'summary']);
            count++;
        } catch (err) {
            console.warn('[Pathfinder] Failed to ingest message:', err);
        }
    }
    return count;
}
