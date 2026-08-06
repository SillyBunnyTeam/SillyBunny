/**
 * Pure report formatting — no DOM, no context. ui.js gathers the data.
 */

const REPORT_LIMIT = 15000;
const MAX_ERROR_LINES = 50;
const MAX_REQUEST_LINES = 20;
const TRANSFORM_LIMIT = 48;
const ERROR_KINDS = new Set(['warn', 'error', 'window-error', 'rejection', 'resource-error']);
const SECTION_TRUNCATED = '\n\n[Section truncated.]';
const HEADER_LIMIT = 3500;
const REQUEST_LIMIT = 3000;
const LAYOUT_LIMIT = 3000;

function clock(ts) {
    return new Date(ts).toISOString().slice(11, 23);
}

function inline(value) {
    return String(value).replace(/[\r\n]+/g, ' ').replace(/([\\`*_[\]<>])/g, '\\$1');
}

function code(value) {
    return String(value).split(/\r\n?|\n/).map((line) => `    ${line}`);
}

function capSection(section, limit) {
    return section.length > limit
        ? `${section.slice(0, limit - SECTION_TRUNCATED.length)}${SECTION_TRUNCATED}`
        : section;
}

export function formatLayoutRows(rows) {
    const width = Math.max(8, ...rows.map((row) => row.selector.length)) + 2;
    return rows.map((row) => {
        if (!row.found) {
            return `${row.selector.padEnd(width)}— not found`;
        }
        const rect = `${row.x},${row.y} ${row.width}x${row.height}`;
        const transform = String(row.transform).slice(0, TRANSFORM_LIMIT);
        return `${row.selector.padEnd(width)}${rect.padEnd(22)}${String(row.position).padEnd(10)}`
            + `${String(row.display).padEnd(8)}overflow:${row.overflow} transform:${transform}`;
    }).join('\n');
}

export function buildReport({ header = [], entries = [], counters = {}, requests = [], layout = null, layoutHeader = '' }) {
    const problems = entries.filter((entry) => ERROR_KINDS.has(entry.kind));
    const headerLines = ['## SillyBunny Diagnostic Report'];
    for (const [label, value] of header) headerLines.push(`- ${inline(label)}: ${inline(value)}`);
    const headerSection = capSection(headerLines.join('\n'), HEADER_LIMIT);

    const renderErrors = (count) => {
        const shown = count ? problems.slice(-count) : [];
        const lines = [`### Errors & warnings (showing ${shown.length} of ${problems.length}; ${counters.total ?? 0} events captured in total)`];
        if (!shown.length) {
            lines.push('None captured.');
        } else {
            for (const entry of shown) {
                lines.push(...code(`[${clock(entry.ts)}] ${entry.kind.padEnd(14)} ${entry.text}`));
                if (entry.stack) {
                    lines.push(...code(entry.stack.split(/\r\n?|\n/).map((line) => `    ${line.trim()}`).join('\n')));
                }
            }
        }
        return lines.join('\n');
    };

    const renderRequests = (count) => {
        const shown = count ? requests.slice(-count) : [];
        const lines = [`### Failed requests (last ${shown.length})`];
        if (!shown.length) {
            lines.push('None captured.');
        } else {
            for (const request of shown) {
                const status = request.status === 0 ? 'network error' : request.status;
                lines.push(...code(`${clock(request.ts)} ${request.method.padEnd(6)} ${request.url} → ${status}`));
            }
        }
        return lines.join('\n');
    };
    let requestCount = Math.min(MAX_REQUEST_LINES, requests.length);
    let requestSection = renderRequests(requestCount);
    while (requestSection.length > REQUEST_LIMIT && requestCount > 1) {
        requestCount = Math.max(1, Math.floor(requestCount / 2));
        requestSection = renderRequests(requestCount);
    }
    requestSection = capSection(requestSection, REQUEST_LIMIT);

    let layoutSection = '';
    if (layout) {
        const layoutLines = ['### Layout snapshot'];
        if (layoutHeader) layoutLines.push(...code(layoutHeader));
        layoutLines.push(...code(layout));
        layoutSection = capSection(layoutLines.join('\n'), LAYOUT_LIMIT);
    }

    const fixedSections = [headerSection, requestSection, layoutSection].filter(Boolean);
    const errorLimit = REPORT_LIMIT - fixedSections.reduce((sum, section) => sum + section.length, 0)
        - (fixedSections.length * 2);
    let errorCount = Math.min(MAX_ERROR_LINES, problems.length);
    let errorSection = renderErrors(errorCount);
    while (errorSection.length > errorLimit && errorCount > 1) {
        errorCount = Math.max(1, Math.floor(errorCount / 2));
        errorSection = renderErrors(errorCount);
    }
    errorSection = capSection(errorSection, errorLimit);
    return [headerSection, errorSection, requestSection, layoutSection].filter(Boolean).join('\n\n');
}
