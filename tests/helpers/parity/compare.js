/**
 * The pure part of the family parity tool: how a measured value is compared with the canonical one, how the rows of a
 * measurement are built, how the allow-list is matched against them, and how the ratchet counts are checked. Nothing here
 * touches a browser, so a Jest test covers it.
 *
 * Vocabulary. A family's rules (`parity/<family>.js`) name the parts of a member and, for each part, the properties to
 * compare. The page measures every shown instance of a part and folds them by distinct value (see `measure.js`), so a
 * measurement of one member at one viewport is turned into rows, one per part, property and distinct value:
 *   { family, surface, viewport, part, property, value, count, canonical, source, floor, form, agree, selector, element, alternative }
 * A row is an outlier when its value is not the canonical one. The comparison depends on the property:
 *   - `size` (`offsetWidth`, `offsetHeight`, `minHeight`): equal within 1px;
 *   - `length` (borders, radii, padding, gap, font size): equal within 0.5px;
 *   - `exact` (text, the audit counts): equal.
 * A property with `floor` is satisfied by any size at or above the canonical one.
 * The property `markup` is the alternative of the part's selectors that an instance matched; the first alternative is the
 * canonical one, and a row is made for each alternative that the member uses. An alternative with `agrees: true` is another
 * form of the same part that the documents state (the loading form's spinner in place of the icon), so its row agrees.
 *
 * The canonical value of a property is `value` (a number or text, or an object keyed by `fine` and `coarse` for a target size,
 * which the pointer of the page selects) or `token` (a CSS custom property that the page resolves). `forms` gives the value
 * for a form of the surface that `DESIGN.md` states a rule for, as a list of `{ form, value | token }` that is searched in
 * order; the property's own `value` or `token` applies when no form holds, and a property that has neither is not compared
 * then. The forms are named in the family's `forms`: a media query or an ancestor selector, read in the page.
 */

export const SIZE_TOLERANCE = 1;
export const LENGTH_TOLERANCE = 0.5;

const SIZE_PROPERTIES = new Set(['offsetWidth', 'offsetHeight', 'minHeight']);

/** A computed property whose value is compared as text. */
const EXACT_PROPERTIES = new Set([
    'textTransform', 'textAlign', 'fontWeight', 'fontStyle', 'letterSpacing', 'flexDirection', 'alignItems', 'justifyContent',
    'overflowWrap', 'whiteSpace', 'textOverflow', 'position', 'boxSizing', 'borderTopStyle', 'borderBottomStyle', 'textDecorationLine',
    'lineHeight', 'markup',
]);

const TEXT_ALIGN = { left: 'start', right: 'end', '-webkit-left': 'start', '-webkit-right': 'end' };

/** `DESIGN.md` and `DESIGN.json` are the documents; `token` is a CSS custom property of the page; `census` is the most common value of the members. */
export const CANONICAL_SOURCES = Object.freeze(['DESIGN.md', 'DESIGN.json', 'token', 'census']);

export const ALLOWLIST_KINDS = Object.freeze(['temporary', 'registered']);

export const TEMPORARY_REASON = 'outlier at the base';

/**
 * Rounds to the nearest half pixel, so that a sub-pixel layout does not make two runs differ.
 * @param {number} value
 * @returns {number}
 */
export function roundHalf(value) {
    return Math.round(value * 2) / 2;
}

/**
 * How a property is compared.
 * @param {string} property
 * @returns {'size' | 'length' | 'exact'}
 */
export function kindOf(property) {
    if (SIZE_PROPERTIES.has(property)) {
        return 'size';
    }
    return EXACT_PROPERTIES.has(property) || /^audit[A-Z]/.test(property) ? 'exact' : 'length';
}

/**
 * Reads a measured value: a length string or number becomes a number rounded to 0.5px, anything else stays text.
 * @param {unknown} raw
 * @param {'size' | 'length' | 'exact'} kind
 * @param {string} [property]
 * @returns {number | string}
 */
export function normaliseValue(raw, kind, property) {
    if (kind === 'exact') {
        const text = typeof raw === 'number' ? raw : String(raw);
        return property === 'textAlign' && text in TEXT_ALIGN ? TEXT_ALIGN[text] : text;
    }
    const number = typeof raw === 'number' ? raw : /^-?\d*\.?\d+(?:px)?$/.test(String(raw).trim()) ? parseFloat(String(raw)) : Number.NaN;
    return Number.isFinite(number) ? roundHalf(number) : String(raw);
}

/**
 * @param {number | string} value
 * @param {number | string} canonical
 * @param {'size' | 'length' | 'exact'} kind
 * @param {boolean} [floor] Whether the canonical size is a minimum.
 * @returns {boolean} Whether the value is the canonical one.
 */
export function valuesAgree(value, canonical, kind, floor = false) {
    if (kind !== 'exact' && typeof value === 'number' && typeof canonical === 'number') {
        const tolerance = kind === 'size' ? SIZE_TOLERANCE : LENGTH_TOLERANCE;
        return floor ? value >= canonical - tolerance : Math.abs(value - canonical) <= tolerance;
    }
    return String(value) === String(canonical);
}

/**
 * Whether two recorded values are the same difference.
 * @param {number | string} left
 * @param {number | string} right
 * @returns {boolean}
 */
export function sameValue(left, right) {
    return String(left) === String(right);
}

/**
 * The rules as they apply to one surface: a part or an alternative with `only` (a regular expression as text) applies to the
 * surfaces whose id it matches, so a part that belongs to one dialog tier is not looked for in the others.
 * @param {{ family: string, parts: any[] }} rules
 * @param {string} surfaceId
 * @returns {{ family: string, parts: any[] }}
 */
export function rulesFor(rules, surfaceId) {
    const applies = item => !item.only || new RegExp(item.only).test(surfaceId);
    return {
        ...rules,
        parts: rules.parts
            .filter(applies)
            .map(part => ({ ...part, selectors: part.selectors.filter(applies) }))
            .filter(part => part.selectors.length > 0),
    };
}

/**
 * What the page needs of the rules: the selectors, the forms and, for each property, the tokens it reads.
 * @param {any} rules
 * @returns {{ family: string, forms: Record<string, { media?: string, closest?: string }>, parts: any[] }} A copy that is safe to send to the page.
 */
export function prepareRules(rules) {
    return {
        family: rules.family,
        forms: rules.forms ?? {},
        parts: rules.parts.map(part => ({
            id: part.id,
            audit: Boolean(rules.audit && rules.audit.part === part.id),
            filter: part.filter ?? null,
            selectors: part.selectors.map(({ id, selector, ready }) => ({ id, selector: selector ?? '', ready: Boolean(ready) })),
            properties: part.properties.map(property => ({
                property: property.property,
                token: property.token ?? null,
                forms: (property.forms ?? []).filter(form => form.token).map(form => ({ form: form.form, token: form.token })),
                formNames: [...new Set((property.forms ?? []).map(form => form.form))],
                alts: property.alts ?? null,
                ifDisplay: property.ifDisplay ?? null,
            })),
        })),
    };
}

/**
 * The problems with the shape of a family's rules, as text; empty when they are well formed.
 * @param {any} rules
 * @returns {string[]}
 */
export function ruleProblems(rules) {
    const problems = [];
    const where = text => `${rules?.family ?? '?'}: ${text}`;
    if (!rules?.family || !Array.isArray(rules.parts) || rules.parts.length === 0) {
        return [where('a family needs a name and parts')];
    }
    for (const [name, form] of Object.entries(rules.forms ?? {})) {
        if (Boolean(form.media) === Boolean(form.closest)) {
            problems.push(where(`the form ${name} needs a media query or an ancestor selector, and only one`));
        }
    }
    const partIds = new Set();
    for (const part of rules.parts) {
        const at = text => where(`${part.id}: ${text}`);
        if (partIds.has(part.id)) {
            problems.push(at('the part id is used twice'));
        }
        partIds.add(part.id);
        if (part.only) {
            try {
                new RegExp(part.only);
            } catch {
                problems.push(at(`only is not a regular expression: ${part.only}`));
            }
        }
        if (part.filter && part.filter !== 'icon-only') {
            problems.push(at(`the filter ${part.filter} is unknown`));
        }
        const alternativeIds = new Set();
        if (!Array.isArray(part.selectors) || part.selectors.length === 0) {
            problems.push(at('a part needs a selector alternative'));
        }
        for (const alternative of part.selectors ?? []) {
            if (alternativeIds.has(alternative.id)) {
                problems.push(at(`the alternative ${alternative.id} is used twice`));
            }
            alternativeIds.add(alternative.id);
            if (Boolean(alternative.selector) === Boolean(alternative.ready)) {
                problems.push(at(`the alternative ${alternative.id} needs a selector or ready: true, and only one`));
            }
            if (alternative.selector && !alternative.root && /(^|,)\s*:scope\s*(,|$)/.test(alternative.selector)) {
                problems.push(at(`the alternative ${alternative.id} measures the surface root as the part; a part that the surface lacks is absent (root: true marks a surface whose root is the part by definition)`));
            }
        }
        if (!Array.isArray(part.properties) || part.properties.length === 0) {
            problems.push(at('a part needs a property'));
        }
        for (const property of part.properties ?? []) {
            const on = text => at(`${property.property}: ${text}`);
            if (!CANONICAL_SOURCES.includes(property.source)) {
                problems.push(on(`the source must be one of ${CANONICAL_SOURCES.join(', ')}`));
            }
            const specs = [property, ...(property.forms ?? [])];
            if (!(property.value !== undefined || property.token || (property.forms ?? []).length)) {
                problems.push(on('there is no canonical value'));
            }
            for (const spec of specs) {
                if (spec.value !== undefined && spec.token) {
                    problems.push(on('a canonical value is a value or a token, not both'));
                }
                if (spec !== property && spec.source !== undefined && !CANONICAL_SOURCES.includes(spec.source)) {
                    problems.push(on(`the source ${spec.source} is unknown`));
                }
            }
            for (const form of property.forms ?? []) {
                if (!rules.forms?.[form.form]) {
                    problems.push(on(`the form ${form.form} is not defined by the family`));
                }
            }
            if (property.floor && kindOf(property.property) !== 'size') {
                problems.push(on('a floor applies to sizes only'));
            }
            if (property.value !== null && typeof property.value === 'object' && kindOf(property.property) !== 'size') {
                problems.push(on('a fine and coarse pair applies to target sizes only'));
            }
            for (const alternative of property.alts ?? []) {
                if (!alternativeIds.has(alternative)) {
                    problems.push(on(`alts names ${alternative}, which is not an alternative of the part`));
                }
            }
        }
    }
    return problems;
}

/**
 * The canonical value of a property for the instances of one cell entry.
 * @param {any} property The property as the rules file writes it.
 * @param {{ forms: string[] }} entry The forms that hold for the entry.
 * @param {'fine' | 'coarse'} pointer
 * @param {Record<string, string>} tokens The tokens the page resolved, by `property|token`.
 * @returns {{ canonical: number | string, source: string, form: string | null } | null} Null when the rules state no value for the entry.
 */
function resolveCanonical(property, entry, pointer, tokens) {
    const formSpec = (property.forms ?? []).find(candidate => entry.forms.includes(candidate.form));
    const spec = formSpec ?? (property.value !== undefined || property.token ? property : null);
    if (!spec) {
        return null;
    }
    const source = spec.source ?? property.source;
    const form = formSpec ? formSpec.form : null;
    const kind = kindOf(property.property);
    if (spec.token) {
        return { canonical: normaliseValue(tokens[`${property.property}|${spec.token}`], kind, property.property), source, form };
    }
    const literal = spec.value !== null && typeof spec.value === 'object' ? spec.value[pointer] : spec.value;
    return literal === undefined ? null : { canonical: normaliseValue(literal, kind, property.property), source, form };
}

const byValue = (left, right) => (typeof left === 'number' && typeof right === 'number' ? left - right : String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0);

/**
 * Turns one measurement into rows and part states.
 * @param {object} input
 * @param {string} input.surface
 * @param {string} input.viewport
 * @param {{ family: string, parts: any[] }} input.rules The rules as written (with `source` and the canonical values).
 * @param {{ pointer: 'fine' | 'coarse', tokens: Record<string, string>, parts: Record<string, any> }} input.measured
 * @returns {{ rows: any[], parts: any[] }} The rows, and for each part of the rules whether the member has it, how many instances were measured, and the alternatives used.
 */
export function buildRows({ surface, viewport, rules, measured }) {
    const rows = [];
    const states = [];
    for (const part of rules.parts) {
        const found = measured.parts[part.id];
        if (!found) {
            continue;
        }
        if (found.absent) {
            states.push({ part: part.id, absent: true });
            continue;
        }
        const alternativeOrder = part.selectors.map(alternative => alternative.id);
        const alternatives = Object.fromEntries(Object.entries(found.alternatives).sort(([left], [right]) => alternativeOrder.indexOf(left) - alternativeOrder.indexOf(right)));
        states.push({ part: part.id, absent: false, instances: found.instances, capped: found.capped, alternatives, ...(found.hidden && { hidden: found.hidden }) });
        const base = { family: rules.family, surface, viewport, part: part.id };
        const selectorOf = id => part.selectors.find(alternative => alternative.id === id)?.selector || 'ready';
        if (part.selectors.length > 1) {
            const canonicalAlternative = part.selectors[0].id;
            for (const [alternative, count] of Object.entries(alternatives)) {
                rows.push({
                    ...base,
                    property: 'markup',
                    kind: 'exact',
                    value: alternative,
                    count,
                    canonical: canonicalAlternative,
                    source: 'census',
                    floor: false,
                    form: null,
                    agree: alternative === canonicalAlternative || Boolean(part.selectors.find(candidate => candidate.id === alternative)?.agrees),
                    selector: selectorOf(alternative),
                    element: null,
                    alternative,
                });
            }
        }
        for (const property of part.properties) {
            const kind = kindOf(property.property);
            const merged = new Map();
            for (const entry of found.cells[property.property] ?? []) {
                const value = normaliseValue(entry.value, kind, property.property);
                const resolved = resolveCanonical(property, entry, measured.pointer, measured.tokens);
                const key = `${value}|${resolved?.canonical ?? ''}|${resolved?.form ?? ''}`;
                const before = merged.get(key);
                if (before) {
                    before.count += entry.count;
                } else {
                    merged.set(key, { value, resolved, count: entry.count, element: entry.element, alternative: entry.alternative });
                }
            }
            for (const { value, resolved, count, element, alternative } of [...merged.values()].sort((left, right) => byValue(left.value, right.value))) {
                const floor = Boolean(property.floor);
                rows.push({
                    ...base,
                    property: property.property,
                    kind,
                    value,
                    count,
                    canonical: resolved ? resolved.canonical : null,
                    source: resolved ? resolved.source : property.source,
                    floor,
                    form: resolved ? resolved.form : null,
                    agree: resolved ? valuesAgree(value, resolved.canonical, kind, floor) : true,
                    selector: selectorOf(alternative),
                    element,
                    alternative,
                });
            }
        }
    }
    return { rows, parts: states };
}

/** The rows of a measurement that differ from the canonical value. */
export const outliersOf = rows => rows.filter(row => !row.agree);

const sameCell = (entry, row) => entry.family === row.family && entry.surface === row.surface && entry.part === row.part && entry.property === row.property;
const viewportMatches = (entry, viewport) => entry.viewport === '*' || entry.viewport === viewport;

/**
 * Checks the rows of one surface at one viewport against the allow-list. An entry is one distinct value of a cell.
 * - An outlier without an entry for its cell and value fails, naming the surface, part, property, value and canonical value.
 *   When the cell has entries with other values, the message says that the difference has changed.
 * - An entry for this surface and viewport whose difference no longer occurs fails with "remove this entry". An entry whose
 *   viewport is `*` (a registered one) is left alone, because one test sees one viewport and cannot tell that the difference
 *   is gone at both; the script that regenerates the list checks it against a full run.
 * @param {{ surface: string, viewport: string, rows: any[], entries: any[] }} input
 * @returns {{ failures: string[], allowed: any[] }}
 */
export function checkSurface({ surface, viewport, rows, entries }) {
    const failures = [];
    const allowed = [];
    const mine = entries.filter(entry => entry.surface === surface && viewportMatches(entry, viewport));
    const used = new Set();
    const where = `${surface} at ${viewport}`;
    for (const row of outliersOf(rows)) {
        const sameCellEntries = mine.filter(candidate => sameCell(candidate, row));
        const entry = sameCellEntries.find(candidate => sameValue(candidate.value, row.value));
        const detail = `${row.part} ${row.property} is ${row.value} in ${row.count} of the instances, the canonical value is ${row.canonical} (${row.source})`;
        if (entry) {
            used.add(entry);
            allowed.push(row);
        } else if (sameCellEntries.length > 0) {
            failures.push(`${where}: ${detail}, and its allow-list entry records ${sameCellEntries.map(candidate => candidate.value).join(', ')}. The difference has changed; update or remove the entry.`);
            sameCellEntries.forEach(candidate => used.add(candidate));
        } else {
            failures.push(`${where}: ${detail}. Fix it, or add it to the allow-list.`);
        }
    }
    for (const entry of mine) {
        if (!used.has(entry) && entry.viewport !== '*') {
            failures.push(`${where}: the allow-list entry for ${entry.part} ${entry.property} (${entry.value}, canonical ${entry.canonical}) no longer applies, because the difference does not occur: remove this entry.`);
        }
    }
    return { failures, allowed };
}

/**
 * The problems with the shape of an allow-list entry, as text; empty when it is well formed.
 * @param {any} entry
 * @param {readonly string[] | null} [viewports] The viewports that the entry's surface has, when the caller knows them.
 * @returns {string[]}
 */
export function entryProblems(entry, viewports = null) {
    const problems = [];
    const text = value => typeof value === 'string' && value.trim() !== '';
    for (const key of ['family', 'surface', 'viewport', 'part', 'property', 'reason']) {
        if (!text(entry?.[key])) {
            problems.push(`${key} must be a non-empty string`);
        }
    }
    for (const key of ['value', 'canonical']) {
        if (!(typeof entry?.[key] === 'number' || text(entry?.[key]))) {
            problems.push(`${key} must be a number or a non-empty string`);
        }
    }
    if (!ALLOWLIST_KINDS.includes(entry?.kind)) {
        problems.push(`kind must be one of ${ALLOWLIST_KINDS.join(', ')}`);
    }
    if (entry?.kind === 'registered' && !/DESIGN\.md|DESIGN\.json|\b[DQ]\d+\b/.test(String(entry.reason))) {
        problems.push('a registered entry needs a reason that cites DESIGN.md, DESIGN.json or a decision id such as D12');
    }
    if (entry?.kind === 'temporary' && entry.reason !== TEMPORARY_REASON) {
        problems.push(`a temporary entry has the reason "${TEMPORARY_REASON}"`);
    }
    if (entry?.kind === 'temporary' && entry.viewport === '*') {
        problems.push('a temporary entry names its viewport, because the stale check cannot see a viewport that is "*"');
    }
    if (viewports && text(entry?.viewport) && entry.viewport !== '*' && !viewports.includes(entry.viewport)) {
        problems.push(`the surface is not measured at ${entry.viewport} (it has ${viewports.join(', ')})`);
    }
    return problems;
}

/** The identity of an entry: a distinct value of a cell of a surface at a viewport. */
export const entryKey = entry => [entry.family, entry.surface, entry.viewport, entry.part, entry.property, String(entry.value)].join('\u0000');

/** A stable sort key, so that a generated allow-list does not depend on the order that tests finished in. */
export const entrySortKey = entryKey;

const sortEntryList = entries => entries.sort((left, right) => (entrySortKey(left) < entrySortKey(right) ? -1 : entrySortKey(left) > entrySortKey(right) ? 1 : 0));

/**
 * Builds the temporary entries for outlier rows. An outlier that a registered entry covers (same cell, value and viewport)
 * gets no temporary entry, so that regenerating the list never duplicates a registered one.
 * @param {any[]} rows Rows of any number of surfaces.
 * @param {any[]} [existing] The entries of the current allow-list.
 * @returns {any[]} Entries sorted by family, surface, viewport, part, property and value, one for each distinct key.
 */
export function entriesFromRows(rows, existing = []) {
    const registered = existing.filter(entry => entry.kind === 'registered');
    const covered = row => registered.some(entry => sameCell(entry, row) && viewportMatches(entry, row.viewport) && sameValue(entry.value, row.value));
    const byKey = new Map();
    for (const row of outliersOf(rows)) {
        if (covered(row)) {
            continue;
        }
        const entry = {
            family: row.family,
            surface: row.surface,
            viewport: row.viewport,
            part: row.part,
            property: row.property,
            value: row.value,
            canonical: row.canonical,
            kind: 'temporary',
            reason: TEMPORARY_REASON,
        };
        if (!byKey.has(entryKey(entry))) {
            byKey.set(entryKey(entry), entry);
        }
    }
    return sortEntryList([...byKey.values()]);
}

/**
 * The registered entries that no outlier of a complete run matches. A registered entry that names a viewport of `*` matches
 * an outlier at either.
 * @param {any[]} entries
 * @param {any[]} rows The rows of a complete run.
 * @returns {any[]}
 */
export function unmatchedRegistered(entries, rows) {
    const outliers = outliersOf(rows);
    return entries.filter(entry => entry.kind === 'registered'
        && !outliers.some(row => sameCell(entry, row) && viewportMatches(entry, row.viewport) && sameValue(entry.value, row.value)));
}

/**
 * The allow-list after a record run: the entries of the cells that the run measured are replaced by the entries that the
 * run produced, and every other entry stays, so a partial run never drops what it did not measure. Registered entries are
 * never replaced.
 * @param {any[]} existing
 * @param {any[]} produced Temporary entries from `entriesFromRows`.
 * @param {Set<string>} measuredCells `surface|viewport` of each measurement that the run made.
 * @returns {any[]}
 */
export function mergeEntries(existing, produced, measuredCells) {
    const kept = existing.filter(entry => entry.kind === 'registered'
        || entry.viewport === '*'
        || !measuredCells.has(`${entry.surface}|${entry.viewport}`));
    return sortEntryList([...kept, ...produced]);
}

/**
 * @param {any[]} entries
 * @param {readonly string[]} families
 * @returns {Record<string, number>} The number of temporary entries of each family.
 */
export function temporaryCounts(entries, families) {
    return Object.fromEntries(families.map(family => [family, entries.filter(entry => entry.kind === 'temporary' && entry.family === family).length]));
}

/**
 * The ratchet: a count may fall and may not rise.
 * @param {Record<string, number>} counts The ratchet file's counts.
 * @param {Record<string, number>} actual The counts of the allow-list.
 * @returns {{ over: string[], under: string[] }} Families over their ratchet count, and families under it (where the ratchet file can be lowered).
 */
export function compareToRatchet(counts, actual) {
    const over = [];
    const under = [];
    for (const [family, count] of Object.entries(actual)) {
        const limit = counts[family] ?? 0;
        if (count > limit) {
            over.push(`${family}: ${count} temporary entries, the ratchet allows ${limit}`);
        } else if (count < limit) {
            under.push(`${family}: ${count} temporary entries, the ratchet holds ${limit}`);
        }
    }
    return { over, under };
}

/**
 * The next ratchet counts: every family takes the lower of its old and its new count; a rise is refused unless allowed.
 * @param {Record<string, number> | null} previous The ratchet file's counts, or null when there is none.
 * @param {Record<string, number>} actual
 * @param {{ allowIncrease?: boolean }} [options]
 * @returns {{ counts: Record<string, number>, rises: string[] }}
 */
export function nextRatchet(previous, actual, { allowIncrease = false } = {}) {
    const rises = [];
    const counts = {};
    for (const [family, count] of Object.entries(actual)) {
        const before = previous?.[family];
        if (before === undefined || allowIncrease) {
            counts[family] = count;
        } else if (count > before) {
            rises.push(`${family}: ${before} -> ${count}`);
            counts[family] = before;
        } else {
            counts[family] = count;
        }
    }
    return { counts, rises };
}
