import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { masterFile, mastersOf } from './manifest.js';
import { needsRecord, recordPathOf } from './provenance.js';

export const NOTICE_PATH = 'assets-src/art/NOTICE.md';
const BEGIN = '<!-- generated:begin -->';
const END = '<!-- generated:end -->';

/**
 * Every picture master of the manifest with its record, sorted by path. A master whose record is missing or not JSON
 * is left out, because `check` reports it.
 * @param {string} root
 * @param {any} manifest
 * @returns {{ master: string, record: any }[]}
 */
export function readRecords(root, manifest) {
    const masters = [...new Set(Object.values(manifest.assets).flatMap(mastersOf))].filter(needsRecord).sort();
    return masters.flatMap((master) => {
        try {
            return [{ master, record: JSON.parse(readFileSync(masterFile(root, recordPathOf(master)), 'utf8')) }];
        } catch {
            return [];
        }
    });
}

const table = (headings, rows) => [
    `| ${headings.join(' | ')} |`,
    `|${headings.map(() => '---').join('|')}|`,
    ...rows.map((cells) => `| ${cells.map((cell) => (cell === '' ? '-' : String(cell).replaceAll('|', '\\|'))).join(' | ')} |`),
];

/**
 * The generated region of NOTICE.md. It depends on nothing but the records and the manifest, so the same art always
 * gives the same text, and a stale region shows as a difference.
 * @param {{ master: string, record: any }[]} records
 * @param {any} manifest
 */
export function renderNoticeRegion(records, manifest) {
    const masters = table(['Master', 'Characters', 'Models', 'Steps', 'Hand edits', 'SHA-256'], records.map(({ master, record }) => [
        master,
        record.characters.join(', '),
        record.models.map(({ provider, model }) => `${provider} ${model}`).join(', '),
        record.steps.join(', '),
        record.handEdits ? 'yes' : 'no',
        record.sha256.slice(0, 16),
    ]));
    const incomplete = records.filter(({ record }) => record.incomplete !== undefined);
    const models = new Map();
    for (const { record } of records) {
        for (const { provider, model, first, last } of record.models) {
            const key = `${provider} ${model}`;
            const seen = models.get(key) ?? { provider, model, masters: 0, first, last };
            seen.masters++;
            seen.first = first < seen.first ? first : seen.first;
            seen.last = last > seen.last ? last : seen.last;
            models.set(key, seen);
        }
    }
    const pinned = Object.entries(manifest.assets).filter(([, asset]) => asset.type === 'pinned');
    return [
        '### Masters',
        '',
        ...masters,
        '',
        '### Incomplete records',
        '',
        ...(incomplete.length === 0 ? ['None.'] : table(['Master', 'Reason'], incomplete.map(({ master, record }) => [master, record.incomplete]))),
        '',
        '### Models',
        '',
        ...table(['Provider', 'Model', 'Masters', 'First', 'Last'], [...models.values()]
            .sort((a, b) => `${a.provider} ${a.model}`.localeCompare(`${b.provider} ${b.model}`))
            .map(({ provider, model, masters: count, first, last }) => [provider, model, count, first, last])),
        '',
        '### Shipped files without a master',
        '',
        ...table(['Asset', 'Files'], pinned.map(([id, asset]) => [id, asset.outputs.length])),
        '',
        '### Encoder',
        '',
        ...table(['Library', 'Version'], Object.entries(manifest.encoder)),
    ].join('\n');
}

/**
 * Replaces only what sits between the markers, so the hand-written sections stay as they are.
 * @param {string} text
 * @param {string} generated
 */
export function applyGeneratedRegion(text, generated) {
    const start = text.indexOf(BEGIN);
    const end = text.indexOf(END);
    if (start === -1 || end === -1 || end < start) {
        throw new Error(`NOTICE.md needs the markers ${BEGIN} and ${END}.`);
    }
    return `${text.slice(0, start + BEGIN.length)}\n${generated}\n${text.slice(end)}`;
}

/**
 * NOTICE.md as it is and as the records make it.
 * @param {string} root
 * @param {any} manifest
 * @returns {{ current: string | null, expected: string | null, problems: object[] }}
 */
export function noticeState(root, manifest) {
    const path = join(root, NOTICE_PATH);
    if (!existsSync(path)) {
        return { current: null, expected: null, problems: [{ code: 'notice-missing', path: NOTICE_PATH, message: `${NOTICE_PATH} does not exist.` }] };
    }
    const current = readFileSync(path, 'utf8');
    try {
        const expected = applyGeneratedRegion(current, renderNoticeRegion(readRecords(root, manifest), manifest));
        const problems = expected === current ? [] : [{ code: 'notice-stale', path: NOTICE_PATH, message: `The generated region of ${NOTICE_PATH} is not what the records give. Run notice --write.` }];
        return { current, expected, problems };
    } catch (error) {
        return { current, expected: null, problems: [{ code: 'notice-invalid', path: NOTICE_PATH, message: error.message }] };
    }
}
