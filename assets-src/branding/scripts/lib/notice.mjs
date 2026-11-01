import { approvedName } from './log.mjs';

const BEGIN = '<!-- generated:begin -->';
const END = '<!-- generated:end -->';

const usd = (value) => `$${value.toFixed(2)}`;
const day = (iso) => iso.slice(0, 10);

/** Each tool: how to ask for its version and how to pull the number out of the answer. */
const TOOL_PROBES = [
    { label: 'ImageMagick', command: 'magick', args: ['-version'], pattern: /ImageMagick\s+(\S+)/ },
    { label: 'cwebp', command: 'cwebp', args: ['-version'], pattern: /^(\S+)/ },
    { label: 'potrace', command: 'potrace', args: ['--version'], pattern: /potrace\s+(\d+(?:\.\d+)*)/i },
    { label: 'vtracer', command: 'vtracer', args: ['--version'], pattern: /vtracer\s+(\S+)/i },
    { label: 'python3', command: 'python3', args: ['--version'], pattern: /Python\s+(\S+)/ },
];

/**
 * @param {(command: string, args: string[]) => string} run Returns stdout or throws when the tool is missing.
 * @param {{ sharp: string, node: string }} runtimes
 */
export function detectTools(run, runtimes) {
    const found = TOOL_PROBES.map(({ label, command, args, pattern }) => {
        try {
            const match = pattern.exec(run(command, args).trim());
            return { label, version: match ? match[1] : 'unknown' };
        } catch {
            return { label, version: 'not installed' };
        }
    });
    return [...found, { label: 'sharp', version: runtimes.sharp }, { label: 'Node.js', version: runtimes.node }];
}

/** An approval counts until a newer approved output supersedes it. */
const isCurrentApproval = (output) => Boolean(output.approved) && !output.superseded;

function summariseByModel(entries) {
    const groups = new Map();
    for (const entry of entries) {
        const key = `${entry.provider}\u0000${entry.model}`;
        const group = groups.get(key) ?? { provider: entry.provider, model: entry.model, images: 0, first: entry.time, last: entry.time, approved: 0, chargedUsd: 0, charged: false, estimatedUsd: 0, estimated: false };
        group.images += entry.outputs.length;
        group.first = entry.time < group.first ? entry.time : group.first;
        group.last = entry.time > group.last ? entry.time : group.last;
        group.approved += entry.outputs.filter(isCurrentApproval).length;
        if (entry.chargedUsd === undefined) {
            group.estimatedUsd += entry.estimatedUsd ?? 0;
            group.estimated = true;
        } else {
            group.chargedUsd += entry.chargedUsd;
            group.charged = true;
        }
        groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => `${a.provider}${a.model}`.localeCompare(`${b.provider}${b.model}`));
}

function renderApprovals(entries) {
    const outputs = entries.flatMap((entry) => entry.outputs.map((output) => ({ output, model: entry.model })));
    const current = outputs.filter(({ output }) => isCurrentApproval(output));
    const lines = ['### Current approvals', ''];
    if (current.length === 0) {
        lines.push('No approved art yet.');
    } else {
        lines.push('| File | Model | SHA-256 |', '|---|---|---|');
        for (const { output, model } of current) {
            lines.push(`| ${approvedName(output)} | ${model} | ${output.sha256.slice(0, 16)} |`);
        }
    }
    const replaced = outputs.filter(({ output }) => output.approved && output.superseded);
    if (replaced.length > 0) {
        const pairs = replaced.map(({ output }) => `${output.sha256.slice(0, 8)} -> ${output.superseded.slice(0, 8)}`);
        lines.push('', `Superseded approvals (history): ${replaced.length} (${pairs.join(', ')}).`);
    }
    return lines;
}

/**
 * The facts block of NOTICE.md. Pure: the same log and tools always give the same text.
 * @param {{ entries: any[], tools: Array<{ label: string, version: string }>, checkedOn: string }} input
 */
export function renderGeneratedRegion({ entries, tools, checkedOn }) {
    const lines = ['### Generations', ''];
    if (entries.length === 0) {
        lines.push('No generations logged yet.');
    } else {
        lines.push('| Provider | Model | Images | First | Last | Approved | Charged | Estimated only |', '|---|---|---|---|---|---|---|---|');
        for (const group of summariseByModel(entries)) {
            lines.push(`| ${group.provider} | ${group.model} | ${group.images} | ${day(group.first)} | ${day(group.last)} | ${group.approved} | ${group.charged ? usd(group.chargedUsd) : '-'} | ${group.estimated ? usd(group.estimatedUsd) : '-'} |`);
        }
    }
    const refs = entries.reduce((sum, entry) => sum + entry.refs.length, 0);
    lines.push('', '| Fact | Value |', '|---|---|');
    lines.push('| Log | log/generations.jsonl |');
    lines.push(`| Reference images attached | ${refs} |`);
    const sum = (pick) => entries.reduce((total, entry) => total + pick(entry), 0);
    lines.push(`| Total charged | ${usd(sum((entry) => entry.chargedUsd ?? 0))} |`);
    lines.push(`| Total estimated, not yet measured | ${usd(sum((entry) => (entry.chargedUsd === undefined ? entry.estimatedUsd ?? 0 : 0)))} |`);
    lines.push('', ...renderApprovals(entries));
    lines.push('', `### Tools (checked ${checkedOn})`, '', '| Tool | Version |', '|---|---|');
    for (const tool of tools) {
        lines.push(`| ${tool.label} | ${tool.version} |`);
    }
    return lines.join('\n');
}

/** Replaces only what sits between the markers, so hand-written sections stay untouched. */
export function applyGeneratedRegion(noticeText, generated) {
    const start = noticeText.indexOf(BEGIN);
    const end = noticeText.indexOf(END);
    if (start === -1 || end === -1 || end < start) {
        throw new Error(`NOTICE.md needs ${BEGIN} and ${END} markers.`);
    }
    return `${noticeText.slice(0, start + BEGIN.length)}\n${generated}\n${noticeText.slice(end)}`;
}
