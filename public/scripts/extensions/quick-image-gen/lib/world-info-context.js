function hasContent(content) {
    return content !== null && content !== undefined && content !== "";
}

function appendRecord(records, metadata, content) {
    if (!hasContent(content)) return;
    records.push({ ...metadata, content });
}

function exampleAnchor(position) {
    if (position === 0) return "before";
    if (position === 1) return "after";
    return undefined;
}

export function normalizeWorldInfoRecords(result) {
    const source = result && typeof result === "object" ? result : {};
    const records = [];

    appendRecord(records, { slot: "before" }, source.worldInfoBefore);
    appendRecord(records, { slot: "after" }, source.worldInfoAfter);

    if (Array.isArray(source.EMEntries)) {
        for (const entry of source.EMEntries) {
            appendRecord(records, {
                slot: "example",
                anchor: exampleAnchor(entry?.position),
            }, entry?.content);
        }
    }

    if (Array.isArray(source.ANBeforeEntries)) {
        for (const content of source.ANBeforeEntries) {
            appendRecord(records, { slot: "authorsNote", anchor: "before" }, content);
        }
    }

    if (Array.isArray(source.ANAfterEntries)) {
        for (const content of source.ANAfterEntries) {
            appendRecord(records, { slot: "authorsNote", anchor: "after" }, content);
        }
    }

    if (Array.isArray(source.WIDepthEntries)) {
        for (const entry of source.WIDepthEntries) {
            if (!Array.isArray(entry?.entries)) continue;
            for (const content of entry.entries) {
                appendRecord(records, {
                    slot: "depth",
                    depth: entry.depth,
                    role: entry.role,
                }, content);
            }
        }
    }

    if (source.outletEntries && typeof source.outletEntries === "object") {
        for (const [outlet, entries] of Object.entries(source.outletEntries)) {
            if (!Array.isArray(entries)) continue;
            for (const content of entries) {
                appendRecord(records, { slot: "outlet", outlet }, content);
            }
        }
    }

    return records;
}

function metadataText(value) {
    return value === null || value === undefined || value === "" ? "unspecified" : String(value);
}

function recordLabel(record) {
    switch (record?.slot) {
        case "before":
            return "Before";
        case "after":
            return "After";
        case "example":
            return `Example | anchor: ${metadataText(record.anchor)}`;
        case "authorsNote":
            return `Author's Note | anchor: ${metadataText(record.anchor)}`;
        case "depth":
            return `Depth | depth: ${metadataText(record.depth)} | role: ${metadataText(record.role)}`;
        case "outlet":
            return `Outlet | name: ${metadataText(record.outlet)}`;
        default:
            return null;
    }
}

export function formatWorldInfoRecords(records) {
    if (!Array.isArray(records)) return "";

    const groups = [];
    for (const record of records) {
        if (!hasContent(record?.content)) continue;
        const label = recordLabel(record);
        if (!label) continue;

        const content = typeof record.content === "string" ? record.content : String(record.content);
        const previous = groups.at(-1);
        if (previous?.label === label) {
            previous.contents.push(content);
        } else {
            groups.push({ label, contents: [content] });
        }
    }

    if (groups.length === 0) return "";
    const sections = groups.map(group => `[${group.label}]\n${group.contents.join("\n\n")}`);
    return `=== World Info ===\n\n${sections.join("\n\n")}`;
}

export function buildWorldInfoScanChat(messages, throughIndex, formatMessage) {
    if (!Array.isArray(messages)) throw new TypeError("World Info messages must be an array");
    if (typeof formatMessage !== "function") throw new TypeError("World Info formatMessage must be a function");
    if (messages.length === 0) return [];

    const requestedIndex = Number(throughIndex);
    const integerIndex = Number.isNaN(requestedIndex) ? 0 : Math.trunc(requestedIndex);
    const endpoint = Math.min(messages.length - 1, Math.max(0, integerIndex));
    const formatted = [];

    for (let index = 0; index <= endpoint; index += 1) {
        const value = formatMessage(messages[index], index);
        if (value === null || value === undefined) continue;
        const text = typeof value === "string" ? value : String(value);
        if (!text.trim()) continue;
        formatted.push(text);
    }

    return formatted.reverse();
}

export function composeWorldInfoScanChat(sceneText, historyChat) {
    const scene = typeof sceneText === "string" ? sceneText.trim() : "";
    const history = Array.isArray(historyChat) ? historyChat : [];
    return scene ? [scene, ...history] : [...history];
}

export function formatWorldInfoScanMessage(message, {
    text = "",
    speakerName = "",
    includeNames = true,
} = {}) {
    if (message?.is_system) return "";
    const content = String(text || "");
    if (!content.trim()) return "";
    const speaker = String(speakerName || "").trim();
    return includeNames && speaker ? `${speaker}: ${content}` : content;
}

export function getWorldInfoContextBudget(scriptModule) {
    const value = typeof scriptModule?.getMaxPromptTokens === "function"
        ? scriptModule.getMaxPromptTokens()
        : scriptModule?.max_context;
    const maxContext = Number(value);
    if (!Number.isFinite(maxContext) || maxContext <= 0) {
        throw new Error("SillyTavern World Info context budget is unavailable");
    }
    return maxContext;
}

export async function resolveWorldInfoContext({
    checkWorldInfo,
    chat,
    maxContext,
    globalScanData,
} = {}) {
    if (typeof checkWorldInfo !== "function") {
        throw new Error("World Info API unavailable: checkWorldInfo dependency is required");
    }

    const result = await checkWorldInfo(chat, maxContext, true, globalScanData);
    const records = normalizeWorldInfoRecords(result);
    return { records, text: formatWorldInfoRecords(records) };
}
