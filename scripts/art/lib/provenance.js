export const RECORD_SUFFIX = '.provenance.json';
export const LICENCES = Object.freeze(['CC-BY-NC-SA-4.0']);
export const CHARACTERS = Object.freeze(['reisen', 'tewi']);
export const REFERENCES = Object.freeze(['none', 'own-art', 'unknown']);
export const MODEL_USES = Object.freeze(['generate', 'edit', 'patch']);

// The record is public, so it is an allowlist: a prompt, a cost, a private path or a note has no key to live under.
const REQUIRED_KEYS = Object.freeze(['format', 'file', 'sha256', 'characters', 'licence', 'models', 'references', 'steps', 'handEdits']);
const OPTIONAL_KEYS = Object.freeze(['made', 'record', 'incomplete', 'tools']);
const MODEL_KEYS = Object.freeze(['provider', 'model', 'uses', 'first', 'last']);
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const NAME_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;
const INCOMPLETE_LIMIT = 200;

/** Picture masters carry a provenance record; motion descriptions are data and do not. */
export const needsRecord = (master) => master.endsWith('.png') || master.endsWith('.svg');

/**
 * @param {string} master A master path, such as `reisen/gs-reisen.png`.
 * @returns {string} The path of its record beside it, such as `reisen/gs-reisen.provenance.json`.
 */
export const recordPathOf = (master) => `${master.replace(/\.[a-z]+$/, '')}${RECORD_SUFFIX}`;

/**
 * @param {any} record
 * @param {{ file: string, sha256: string }} master The master's file name and the sha256 of its bytes.
 * @returns {{ code: 'provenance-invalid' | 'provenance-stale', message: string }[]}
 */
export function validateRecord(record, master) {
    const problems = [];
    const fail = (message) => problems.push({ code: 'provenance-invalid', message });
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        fail('The record must be an object.');
        return problems;
    }
    for (const key of Object.keys(record)) {
        if (!REQUIRED_KEYS.includes(key) && !OPTIONAL_KEYS.includes(key)) {
            fail(`The record has the key "${key}", which a public record may not hold. Allowed keys: ${[...REQUIRED_KEYS, ...OPTIONAL_KEYS].join(', ')}.`);
        }
    }
    for (const key of REQUIRED_KEYS) {
        if (!(key in record)) {
            fail(`The record needs "${key}".`);
        }
    }
    if (record.format !== 1) {
        fail('format must be 1.');
    }
    if (record.file !== master.file) {
        fail(`file is ${JSON.stringify(record.file)}, but the master is ${master.file}.`);
    }
    if (typeof record.sha256 === 'string' && record.sha256 !== master.sha256) {
        problems.push({ code: 'provenance-stale', message: `The record is for ${record.sha256.slice(0, 16)}, but the master is ${master.sha256.slice(0, 16)}.` });
    }
    if (!isListOf(record.characters, (value) => CHARACTERS.includes(value))) {
        fail(`characters must list any of ${CHARACTERS.join(', ')}.`);
    }
    if (!LICENCES.includes(record.licence)) {
        fail(`licence must be one of ${LICENCES.join(', ')}.`);
    }
    if (!isListOf(record.models, isModel)) {
        fail(`models must list { ${MODEL_KEYS.join(', ')} }, with uses from ${MODEL_USES.join(', ')} and days as YYYY-MM-DD.`);
    }
    if (!REFERENCES.includes(record.references)) {
        fail(`references must be one of ${REFERENCES.join(', ')}.`);
    }
    if (!isListOf(record.steps, (step) => typeof step === 'string' && NAME_PATTERN.test(step))) {
        fail('steps must list the names of the tools that made the master, in order.');
    }
    if (typeof record.handEdits !== 'boolean') {
        fail('handEdits must be true or false.');
    }
    if (record.made !== undefined && !DAY_PATTERN.test(record.made)) {
        fail('made must be a day as YYYY-MM-DD.');
    }
    if (record.record !== undefined && !/^sha256:[0-9a-f]{64}$/.test(record.record)) {
        fail('record must be "sha256:" and the digest of the private log lines.');
    }
    if (record.incomplete !== undefined && (typeof record.incomplete !== 'string' || record.incomplete.length === 0 || record.incomplete.length > INCOMPLETE_LIMIT)) {
        fail(`incomplete must be a reason of 1 to ${INCOMPLETE_LIMIT} characters.`);
    }
    if (record.record === undefined && record.incomplete === undefined) {
        fail('A record with no private log lines to point at must say why it is incomplete.');
    }
    if (record.tools !== undefined && !isListOf(record.tools, (tool) => isExactly(tool, ['name', 'version']) && typeof tool.name === 'string' && typeof tool.version === 'string')) {
        fail('tools must list { name, version }.');
    }
    return problems;
}

function isModel(model) {
    return isExactly(model, MODEL_KEYS)
        && typeof model.provider === 'string' && typeof model.model === 'string'
        && isListOf(model.uses, (use) => MODEL_USES.includes(use)) && model.uses.length > 0
        && DAY_PATTERN.test(model.first) && DAY_PATTERN.test(model.last);
}

const isListOf = (value, check) => Array.isArray(value) && value.every(check);
const isExactly = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => key in value);
