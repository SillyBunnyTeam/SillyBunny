/**
 * The settings inventory as data: the shape of the fixture (`tests/fixtures/settings-inventory.json`), its validation, the
 * comparison of a recorded section with what a page holds now, and the diff of two saved settings objects. Nothing here
 * imports Playwright or reads the page, so Jest runs it.
 *
 * A fixture holds one section per page and backend (`settings.backend.sampling@text-completion`), one per state that
 * opens over a page (`settings.backend.agents#settings-page`) and one per built-in extension's subpage
 * (`extension:qr_container`). A section lists every control that a user can operate, as the page's DOM holds it.
 */

export const FIXTURE_VERSION = 1;

/** What a control is. A select row or a switch row drives a native element; the kind is the native element's. */
export const KINDS = Object.freeze(['switch', 'checkbox', 'select', 'number', 'range', 'text', 'textarea', 'radio', 'color', 'file', 'button', 'link']);

/**
 * Where a control is when the page is open: `visible` without opening anything, `expander` once the expanders are open,
 * `hidden` when it is in the page but not shown for this backend or state (another provider's key field, a mobile-only row, a popup's form).
 */
export const WHERES = Object.freeze(['visible', 'expander', 'hidden']);

/** How a control was identified, from the strongest: the element id, the `name`, a `data-*` hook, the row's editor field, the accessible name. */
export const IDENTITY_KINDS = Object.freeze(['id', 'name', 'data', 'field', 'label']);

/** The kinds whose value the round trip changes through the control the user sees. */
export const ROUND_TRIP_KINDS = Object.freeze(['switch', 'checkbox', 'select', 'number', 'range', 'text', 'textarea', 'radio']);

/** The kinds that the spec must round-trip whatever else is recorded (the rest are best effort and may be an exception). */
export const REQUIRED_ROUND_TRIP_KINDS = Object.freeze(['switch', 'select', 'number', 'range']);

const DRIVERS = new Set(['select-row', 'select2', 'label']);
const SECTION_KEY = /^(?<surface>[a-z0-9.-]+)(?:@(?<backend>[a-z0-9-]+)(?::(?<source>[A-Za-z0-9_.-]+))?|#(?<state>[a-z0-9-]+))?$/;
const EXTENSION_KEY = /^extension:(?<container>[A-Za-z0-9_.-]+)$/;

/**
 * @param {string} surfaceId
 * @param {{ backend?: string, source?: string, state?: string }} [variant] `source` is the provider that a Connections page shows (a Chat Completion source, a Text Completion type).
 * @returns {string}
 */
export function sectionKey(surfaceId, { backend, source, state } = {}) {
    return `${surfaceId}${backend ? `@${backend}${source ? `:${source}` : ''}` : ''}${state ? `#${state}` : ''}`;
}

/** @param {string} key */
export function parseSectionKey(key) {
    const extension = EXTENSION_KEY.exec(key);
    if (extension) {
        return { extension: extension.groups.container };
    }
    const match = SECTION_KEY.exec(key);
    if (!match) {
        throw new Error(`"${key}" is not a section key.`);
    }
    return { surface: match.groups.surface, backend: match.groups.backend, source: match.groups.source, state: match.groups.state };
}

const isText = value => typeof value === 'string' && value.trim() !== '';
const isTextList = value => Array.isArray(value) && value.every(isText);
const isSortedUnique = list => list.every((item, index) => index === 0 || list[index - 1] < item);

/**
 * Checks the shape of a fixture. Returns one message per problem, each naming the section and the control.
 * @param {any} fixture
 * @returns {string[]}
 */
export function validateInventory(fixture) {
    const problems = [];
    if (!fixture || typeof fixture !== 'object') {
        return ['The fixture is not an object.'];
    }
    if (fixture.version !== FIXTURE_VERSION) {
        problems.push(`version must be ${FIXTURE_VERSION}.`);
    }
    if (!fixture.recorded || !isText(fixture.recorded.commit) || !isText(fixture.recorded.viewport)) {
        problems.push('recorded must name the commit and the viewport.');
    }
    if (!fixture.sections || typeof fixture.sections !== 'object' || Array.isArray(fixture.sections)) {
        return [...problems, 'sections must be an object.'];
    }
    for (const [key, section] of Object.entries(fixture.sections)) {
        const here = message => problems.push(`${key}: ${message}`);
        try {
            parseSectionKey(key);
        } catch {
            here('the key is not a section key.');
            continue;
        }
        if (!section || typeof section !== 'object') {
            here('is not an object.');
            continue;
        }
        if (!isText(section.root)) {
            here('root must be a selector.');
        }
        if (section.skip !== undefined && !isTextList(section.skip)) {
            here('skip must be a list of selectors.');
        }
        if (section.roundTrip !== undefined && section.roundTrip !== false) {
            here('roundTrip is only ever false (a section that is checked for existence and reach alone).');
        }
        if (section.skipped !== undefined) {
            if (!isText(section.skipped) || (section.controls ?? []).length) {
                here('skipped must say why the section was not recorded, and a skipped section has no controls.');
            }
            continue;
        }
        if (!Array.isArray(section.controls) || section.controls.length === 0) {
            here('controls must be a non-empty list.');
            continue;
        }
        const seen = new Set();
        for (const [index, control] of section.controls.entries()) {
            const name = isText(control?.identity) ? control.identity : `control #${index}`;
            const problem = message => problems.push(`${key}: ${name}: ${message}`);
            if (!control || typeof control !== 'object') {
                problem('is not an object.');
                continue;
            }
            if (!isText(control.identity)) {
                problem('identity is required.');
            } else if (seen.has(control.identity)) {
                problem('identity is used twice in the section.');
            }
            seen.add(control.identity);
            if (!KINDS.includes(control.kind)) {
                problem(`kind "${control.kind}" is not one of ${KINDS.join(', ')}.`);
            }
            if (!WHERES.includes(control.where)) {
                problem(`where "${control.where}" is not one of ${WHERES.join(', ')}.`);
            }
            if (control.where !== 'hidden') {
                if (!IDENTITY_KINDS.includes(control.identityKind)) {
                    problem(`identityKind "${control.identityKind}" is not one of ${IDENTITY_KINDS.join(', ')}.`);
                }
                if (typeof control.name !== 'string') {
                    problem('name must be a string (empty when the control has none).');
                }
            }
            if (control.driver !== undefined && !DRIVERS.has(control.driver)) {
                problem(`driver "${control.driver}" is not one of ${[...DRIVERS].join(', ')}.`);
            }
            for (const field of ['keys', 'storage', 'requests']) {
                if (control[field] === undefined) {
                    continue;
                }
                if (!isTextList(control[field]) || control[field].length === 0 || !isSortedUnique(control[field])) {
                    problem(`${field} must be a non-empty, sorted list of unique strings.`);
                }
                if (control.where === 'hidden' || !ROUND_TRIP_KINDS.includes(control.kind)) {
                    problem(`${field} is recorded for a control that is not round-tripped.`);
                }
            }
            if (control.drift !== undefined) {
                if (!isTextList(control.drift) || control.drift.length === 0 || !isSortedUnique(control.drift)) {
                    problem('drift must be a non-empty, sorted list of unique paths.');
                }
                if (control.where === 'hidden' || !ROUND_TRIP_KINDS.includes(control.kind) || control.exception || control.unreachable) {
                    problem('drift is recorded for a control that is not round-tripped.');
                }
            }
            if (/~\d+$/.test(control.identity ?? '') && ROUND_TRIP_KINDS.includes(control.kind)) {
                problem('a value control is told apart by its position (~n), and a change of the page that moves it is not seen; it needs what the markup says.');
            }
            if (control.selfSaves !== undefined && (control.selfSaves !== true || !control.keys)) {
                problem('selfSaves is only ever true, and only for a control that saves keys of the settings.');
            }
            if (control.keyboard !== undefined && (typeof control.keyboard !== 'boolean' || control.kind !== 'range')) {
                problem('keyboard is a boolean, recorded for a range alone.');
            }
            if (control.viaNesting !== undefined && control.viaNesting !== true) {
                problem('viaNesting is only ever true.');
            }
            if (control.lands !== undefined && control.lands !== 'none') {
                problem('lands is only ever "none" (the value changed and nothing was saved).');
            }
            if (control.lands === 'none' && (control.keys || control.storage || control.requests)) {
                problem('lands is "none" but a place is recorded.');
            }
            if (control.unreachable !== undefined) {
                if (!isText(control.unreachable)) {
                    problem('unreachable must say why the control cannot be reached.');
                }
                if (control.where === 'hidden') {
                    problem('a hidden control is not reached, so it is not recorded as unreachable.');
                }
                if (control.keys || control.storage || control.requests || control.lands) {
                    problem('an unreachable control is not round-tripped, so it records no keys.');
                }
            }
            if (control.exception !== undefined) {
                if (!control.exception || !isText(control.exception.reason)) {
                    problem('an exception needs a reason.');
                }
                if (control.exception?.lands !== undefined && !isText(control.exception.lands)) {
                    problem('exception.lands must be text.');
                }
                if (control.keys || control.storage || control.requests || control.lands) {
                    problem('an exception is not round-tripped, so it records no keys.');
                }
            }
            if (section.roundTrip === false && (control.keys || control.storage || control.requests || control.lands || control.exception)) {
                problem('the section is not round-tripped, so a control records no keys and no exception.');
            }
            if (section.roundTrip !== false && !control.exception && !control.unreachable && !control.disabled && control.where !== 'hidden' && REQUIRED_ROUND_TRIP_KINDS.includes(control.kind)
                && !control.keys && !control.storage && !control.requests && control.lands !== 'none') {
                problem(`a ${control.kind} needs keys, storage, requests, lands "none" or an exception, so that the spec knows what it saves.`);
            }
        }
    }
    return problems;
}

/**
 * The paths of the values that differ between two saved settings objects, sorted. A path is the keys joined with dots, down to
 * the first value that is not a plain object; an array is compared as a whole, and its path is the array's.
 * `_version` is ignored because every save moves it.
 * @param {any} before
 * @param {any} after
 * @returns {string[]}
 */
export function diffSettings(before, after) {
    const paths = [];
    const walk = (left, right, path) => {
        const bothObjects = left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right);
        if (!bothObjects) {
            if (JSON.stringify(left) !== JSON.stringify(right)) {
                paths.push(path);
            }
            return;
        }
        for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
            if (path === '' && key === '_version') {
                continue;
            }
            walk(left[key], right[key], path === '' ? key : `${path}.${key}`);
        }
    };
    walk(before, after, '');
    return paths.sort();
}

/** The value at a dotted path, or undefined. */
export function getPath(settings, dotted) {
    return dotted.split('.').reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), settings);
}

/**
 * The paths where a restore did not bring the saved settings back: those that differ and that the settings held at the start. A key
 * that did not exist then (an extension that fills in its defaults on the first save, a setting that is stored only once a user
 * has set it) holds its default now, which is the value that its absence meant.
 * @param {any} before The settings before the change.
 * @param {any} restored The settings after the change was put back.
 * @returns {string[]}
 */
export function driftPaths(before, restored) {
    return diffSettings(before, restored).filter(dotted => getPath(before, dotted) !== undefined);
}

/**
 * Compares the places that a control's value was recorded to land in with the ones that a round trip just saw. Every recorded
 * place must be seen again; a place that is new is reported, but does not fail (a save that also moves a timestamp is not a lost setting).
 * @param {readonly string[]} recorded
 * @param {readonly string[]} observed
 * @returns {{ ok: boolean, missing: string[], extra: string[] }}
 */
export function compareKeys(recorded, observed) {
    const seen = new Set(observed);
    const known = new Set(recorded);
    const missing = recorded.filter(key => !seen.has(key));
    return { ok: missing.length === 0, missing, extra: observed.filter(key => !known.has(key)) };
}

/**
 * Compares a section of the fixture with the controls that the page holds now.
 * @param {{ controls: any[] }} section The recorded section.
 * @param {readonly { identity: string, kind: string, shown: boolean, disabled: boolean, identityKind?: string }[]} live What `collect()` found, after the expanders were opened.
 * @param {{ present?: ReadonlySet<string> }} [options] `present`: the recorded identities that were found elsewhere in the document, which is where a hidden control may sit.
 * @returns {{ missing: any[], added: any[], kindChanged: { recorded: any, live: any }[], notShown: any[], nowDisabled: any[], renamed: { recorded: any, live: any }[] }}
 */
export function compareSection(section, live, { present = new Set() } = {}) {
    const liveByIdentity = new Map(live.map(control => [control.identity, control]));
    const recordedByIdentity = new Map(section.controls.map(control => [control.identity, control]));
    const missing = [];
    const kindChanged = [];
    const notShown = [];
    const nowDisabled = [];
    for (const recorded of section.controls) {
        const found = liveByIdentity.get(recorded.identity);
        if (!found) {
            if (!present.has(recorded.identity)) {
                missing.push(recorded);
            }
            continue;
        }
        if (found.kind !== recorded.kind) {
            kindChanged.push({ recorded, live: found });
        }
        if (recorded.where !== 'hidden' && !found.shown) {
            notShown.push(recorded);
        }
        if (recorded.where !== 'hidden' && found.shown && found.disabled && !recorded.disabled) {
            nowDisabled.push(recorded);
        }
    }
    const added = live.filter(control => !recordedByIdentity.has(control.identity));
    // A control that is known by its label alone shows up as one missing and one new when its label is reworded; pair them, so that the report says so.
    const renamed = [];
    const unclaimed = [...added];
    for (const recorded of missing.filter(control => control.identityKind === 'label')) {
        const index = unclaimed.findIndex(control => control.identityKind === 'label' && control.kind === recorded.kind);
        if (index >= 0) {
            renamed.push({ recorded, live: unclaimed[index] });
            unclaimed.splice(index, 1);
        }
    }
    // Controls that are told apart by position only: what a page loses of them shows as a count, however the numbers shift.
    const countsOf = controls => controls.reduce((counts, control) => {
        const base = control.identity.replace(/~\d+$/, '');
        return control.identity === base && !controls.some(other => other.identity === `${base}~2`) ? counts : counts.set(base, (counts.get(base) ?? 0) + 1);
    }, new Map());
    const recordedCounts = countsOf(section.controls);
    const liveCounts = countsOf(live);
    const countChanged = [...new Set([...recordedCounts.keys(), ...liveCounts.keys()])]
        .filter(base => (recordedCounts.get(base) ?? 0) !== (liveCounts.get(base) ?? 0))
        .map(base => ({ base, recorded: recordedCounts.get(base) ?? 0, live: liveCounts.get(base) ?? 0 }));
    return { missing, added, kindChanged, notShown, nowDisabled, renamed, countChanged };
}

/**
 * The differences that a rebuild of a page makes on purpose, which the check then accepts. Every entry names the section and the
 * control (`identity`; for `renamed` the recorded `from` and the new `to`), has a reason, and fails the check once its difference no
 * longer occurs, so that an entry leaves together with the change that makes the fixture agree:
 *   kind         the control is now a `to`, and was `from` when that is given
 *   left         the control is no longer in this section (it moved; `to` may say where)
 *   arrived      the control is now in this section, and was recorded in the section `from`
 *   renamed      the control that was recorded as `from` is now `to`, in the same section
 *   added        a control that the fixture does not know is on the page on purpose
 *   unreachable  the control is on the page and a known defect keeps a user from reaching it; `problem` is one of PROBLEMS, so
 *                that a different problem is still a failure
 * A moved, renamed or arrived control is checked as the recorded one, with its recorded keys. No entry has a way to name a saved key, a
 * place or a save: a control that saves something else fails whatever is listed.
 */
export const ACCEPTED_KINDS = Object.freeze(['kind', 'left', 'arrived', 'renamed', 'added', 'unreachable']);

/** What `reachControl()` can say is wrong with a control, as a code. */
export const PROBLEMS = Object.freeze(['not-found', 'not-shown', 'no-box', 'outside', 'disabled', 'covered']);

const ACCEPTED_FIELDS = Object.freeze(['section', 'identity', 'difference', 'from', 'to', 'problem', 'coveredBy', 'reason']);

/**
 * @param {readonly any[]} accepted
 * @param {any} fixture
 * @returns {string[]} One message per problem.
 */
export function validateAccepted(accepted, fixture) {
    const problems = [];
    const seen = new Set();
    for (const [index, entry] of accepted.entries()) {
        const subject = entry?.difference === 'renamed' ? entry.from : entry?.identity;
        const problem = message => problems.push(`accepted difference #${index + 1} (${subject ?? '?'}): ${message}`);
        if (!entry || typeof entry !== 'object') {
            problem('is not an object.');
            continue;
        }
        for (const field of Object.keys(entry).filter(name => !ACCEPTED_FIELDS.includes(name))) {
            problem(`${field} is not a field of an entry, and nothing that a control saves can be accepted.`);
        }
        const sectionControls = fixture?.sections?.[entry.section]?.controls;
        if (!isText(entry.section) || !sectionControls) {
            problem(`section "${entry.section}" is not a section of the fixture.`);
        }
        if (!ACCEPTED_KINDS.includes(entry.difference)) {
            problem(`difference "${entry.difference}" is not one of ${ACCEPTED_KINDS.join(', ')}.`);
        }
        if (!isText(subject)) {
            problem(entry.difference === 'renamed' ? 'from is required: an entry names the control.' : 'identity is required: an entry names the control.');
        }
        if (!isText(entry.reason)) {
            problem('reason is required.');
        }
        const recorded = sectionControls?.find(control => control.identity === subject);
        if (entry.difference === 'kind' && (!KINDS.includes(entry.to) || (entry.from !== undefined && !KINDS.includes(entry.from)))) {
            problem('a kind difference needs `to` (and `from`, when given) to be a kind.');
        }
        if (entry.difference === 'renamed') {
            if (!isText(entry.to) || entry.to === entry.from) {
                problem('a renamed difference needs a `to` that is not `from`.');
            }
            if (sectionControls && !recorded) {
                problem(`the control is not recorded in section "${entry.section}".`);
            }
        }
        if (entry.difference === 'arrived') {
            const source = fixture?.sections?.[entry.from]?.controls.find(control => control.identity === entry.identity);
            if (!source) {
                problem(`the control is not recorded in section "${entry.from}".`);
            } else if (source.where === 'hidden') {
                problem('a hidden control is not reached, so it needs no entry to move.');
            }
        }
        if (entry.difference === 'unreachable' && !PROBLEMS.includes(entry.problem)) {
            problem(`problem "${entry.problem}" is not one of ${PROBLEMS.join(', ')}.`);
        }
        if (entry.coveredBy !== undefined && (entry.difference !== 'unreachable' || entry.problem !== 'covered' || !isText(entry.coveredBy))) {
            problem('coveredBy is text that the covering element must contain, and only for an unreachable control that is covered.');
        }
        const id = `${entry.section}|${subject}|${entry.difference}`;
        if (seen.has(id)) {
            problem('is listed twice.');
        }
        seen.add(id);
    }
    return problems;
}

/**
 * Takes the accepted differences of one section out of a comparison.
 * @param {string} key The section.
 * @param {ReturnType<typeof compareSection>} result
 * @param {readonly any[]} accepted
 * @returns {{ result: ReturnType<typeof compareSection>, unused: any[], arrived: { entry: any, live: any }[], renamed: { entry: any, recorded: any, live: any }[], added: { entry: any, live: any }[] }}
 * `unused` are the entries of the section whose difference did not occur; the check fails on them. The rest are what the check goes on
 * to reach: an arrived or renamed control as the recorded one, an added control as one with nothing recorded.
 */
export function applyAccepted(key, result, accepted) {
    const next = { ...result, missing: [...result.missing], added: [...result.added], kindChanged: [...result.kindChanged] };
    // An `unreachable` entry is decided by the reach check, not by the comparison.
    const mine = accepted.filter(entry => entry.section === key && entry.difference !== 'unreachable');
    const used = new Set();
    const out = { arrived: [], renamed: [], added: [] };
    const take = (list, test) => {
        const index = list.findIndex(test);
        return index < 0 ? null : list.splice(index, 1)[0];
    };
    for (const entry of mine) {
        if (entry.difference === 'kind') {
            if (take(next.kindChanged, pair => pair.recorded.identity === entry.identity && pair.live.kind === entry.to && (!entry.from || pair.recorded.kind === entry.from))) {
                used.add(entry);
            }
        } else if (entry.difference === 'left') {
            if (take(next.missing, control => control.identity === entry.identity)) {
                used.add(entry);
            }
        } else if (entry.difference === 'arrived') {
            const live = take(next.added, control => control.identity === entry.identity);
            if (live) {
                used.add(entry);
                out.arrived.push({ entry, live });
            }
        } else if (entry.difference === 'added') {
            const live = take(next.added, control => control.identity === entry.identity);
            if (live) {
                used.add(entry);
                out.added.push({ entry, live });
            }
        } else if (entry.difference === 'renamed') {
            const recorded = next.missing.find(control => control.identity === entry.from);
            const live = next.added.find(control => control.identity === entry.to);
            if (recorded && live) {
                take(next.missing, control => control === recorded);
                take(next.added, control => control === live);
                used.add(entry);
                out.renamed.push({ entry, recorded, live });
            }
        }
    }
    next.renamed = result.renamed.filter(pair => next.missing.includes(pair.recorded) && next.added.includes(pair.live));
    return { result: next, unused: mine.filter(entry => !used.has(entry)), ...out };
}

/**
 * The accepted `unreachable` entry that covers a reach problem, or null: it names the control and pins the problem, and for a
 * covered control the element that covers it. A different problem of the same control is not covered.
 * @param {readonly any[]} entries
 * @param {string} identity
 * @param {string | null} code One of PROBLEMS.
 * @param {string | null} coveredBy The covering element, as `reachControl()` names it.
 */
export function matchUnreachable(entries, identity, code, coveredBy) {
    return entries.find(entry => entry.identity === identity && entry.problem === code && (!entry.coveredBy || (coveredBy ?? '').includes(entry.coveredBy))) ?? null;
}

/**
 * The step to take a value control to, a tenth of the way across its limits from the current value (a counter that shows two
 * decimals ignores a change of one step of 0.001), on the side that has room. Null when there is no room on either side.
 * @param {string | number | null} current
 * @param {{ min?: string, max?: string, step?: string }} limits
 * @returns {string | null}
 */
export function nextNumber(current, { min, max, step }) {
    const lower = min === undefined || min === '' ? -Infinity : Number(min);
    const upper = max === undefined || max === '' ? Infinity : Number(max);
    const size = step && step !== 'any' && Number(step) > 0 ? Number(step) : 1;
    const decimals = (String(size).split('.')[1] ?? '').length;
    const format = number => String(Number(number.toFixed(Math.max(decimals, 6))));
    const span = Number.isFinite(lower) && Number.isFinite(upper) ? upper - lower : 0;
    const delta = Math.max(size, Math.round(span / 10 / size) * size);
    if (current === '' || current === null || current === undefined || Number.isNaN(Number(current))) {
        return Number.isFinite(lower) ? format(lower) : format(Number.isFinite(upper) ? upper : 1);
    }
    const value = Number(current);
    for (const candidate of [value + delta, value - delta, value + size, value - size]) {
        if (candidate >= lower && candidate <= upper && candidate !== value) {
            return format(candidate);
        }
    }
    return null;
}

/**
 * The values to try in a text field, in order: a plain change first, and then one in the format that the field asks for when its
 * type, placeholder or id says so (a time, JSON, a URL), because a field that parses what it is given saves nothing for a plain change.
 * @param {string | null} original
 * @param {{ type?: string, placeholder?: string, id?: string }} [hints]
 * @returns {string[]}
 */
export function textCandidates(original, { type = '', placeholder = '', id = '' } = {}) {
    const text = original === null || original === undefined ? '' : String(original);
    const candidates = [text === '' ? 'sb-inventory' : `${text}~`];
    const time = /^(\d{1,2}):(\d{2})$/.exec(text);
    if (type === 'time' || time || /hh?:mm/i.test(placeholder)) {
        const minutes = ((time ? Number(time[1]) * 60 + Number(time[2]) : 22 * 60) + 1) % 1440;
        candidates.push(`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`);
    }
    if (/json/i.test(`${id} ${placeholder}`) || /^\s*[[{]/.test(text)) {
        let parsed = {};
        try {
            parsed = text.trim() ? JSON.parse(text) : {};
        } catch {
            parsed = {};
        }
        candidates.push(JSON.stringify(Array.isArray(parsed) ? [...parsed, 'sb-inventory'] : { ...parsed, sb_inventory: 1 }));
    }
    if (type === 'url' || /url/i.test(id)) {
        candidates.push('https://sb-inventory.invalid/');
    }
    return candidates;
}

/** A value as the control reports it; the numbers that a control reformats (`1` shown as `1.00`) are the same number. */
export function sameValue(kind, left, right) {
    if ((kind === 'number' || kind === 'range') && left !== '' && right !== '' && left !== null && right !== null) {
        return Number(left) === Number(right);
    }
    return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Merges the records of the same page collected before the expanders were opened and after. A control shown at the first
 * collection is `visible`, one shown only after is `expander`, one shown at neither is `hidden`.
 * @param {readonly any[]} before
 * @param {readonly any[]} after
 * @returns {any[]} Records of the second collection, in order, with `where` and without `shown`.
 */
export function mergeCollections(before, after) {
    const shownBefore = new Set(before.filter(control => control.shown).map(control => control.identity));
    return after.map(({ shown, ...control }) => ({
        ...control,
        where: shown ? (shownBefore.has(control.identity) ? 'visible' : 'expander') : 'hidden',
    }));
}

const CONTROL_ORDER = ['identity', 'identityKind', 'viaNesting', 'kind', 'name', 'group', 'where', 'disabled', 'driver', 'multiple', 'secret', 'min', 'max', 'step', 'accept', 'keyboard', 'keys', 'selfSaves', 'storage', 'requests', 'lands', 'drift', 'exception', 'unreachable'];

/** A control without the fields that only a shown control has, in a stable key order. */
export function normalizeControl(control) {
    const ordered = {};
    for (const key of CONTROL_ORDER) {
        if (control[key] !== undefined && (control[key] !== false || key === 'keyboard') && !(key === 'group' && control[key] === '')) {
            ordered[key] = control[key];
        }
    }
    if (control.where === 'hidden') {
        return { identity: ordered.identity, kind: ordered.kind, where: 'hidden', ...(ordered.exception && { exception: ordered.exception }) };
    }
    return ordered;
}

/**
 * Writes a fixture as JSON with one control per line, so that a change to one control is one line of a diff.
 * @param {any} fixture
 * @returns {string}
 */
export function serializeInventory(fixture) {
    const lines = ['{', `  "version": ${JSON.stringify(fixture.version)},`, `  "recorded": ${JSON.stringify(fixture.recorded)},`, '  "sections": {'];
    const keys = Object.keys(fixture.sections).sort();
    keys.forEach((key, sectionIndex) => {
        const { controls, ...rest } = fixture.sections[key];
        const last = sectionIndex < keys.length - 1 ? ',' : '';
        if (!controls) {
            lines.push(`    ${JSON.stringify(key)}: ${JSON.stringify(rest)}${last}`);
            return;
        }
        lines.push(`    ${JSON.stringify(key)}: {`);
        for (const [name, value] of Object.entries(rest)) {
            lines.push(`      ${JSON.stringify(name)}: ${JSON.stringify(value)},`);
        }
        lines.push('      "controls": [');
        controls.forEach((control, index) => lines.push(`        ${JSON.stringify(control)}${index < controls.length - 1 ? ',' : ''}`));
        lines.push('      ]', `    }${last}`);
    });
    lines.push('  }', '}', '');
    return lines.join('\n');
}

/**
 * Counts for the report: controls by section and kind, and by identity kind.
 * @param {any} fixture
 */
export function summarizeInventory(fixture) {
    const sections = {};
    const totals = { controls: 0, kinds: {}, identityKinds: {}, where: {}, exceptions: 0, roundTripped: 0, selfSaves: 0, viaNesting: 0, numbered: 0, skippedSections: 0, lands: { settings: 0, storage: 0, requests: 0, none: 0 } };
    for (const [key, section] of Object.entries(fixture.sections)) {
        const kinds = {};
        if (section.skipped) {
            totals.skippedSections++;
        }
        for (const control of section.controls ?? []) {
            if (section.roundTrip !== false && ROUND_TRIP_KINDS.includes(control.kind) && control.where !== 'hidden' && !control.exception && !control.unreachable && !control.disabled) {
                totals.roundTripped++;
            }
            totals.selfSaves += control.selfSaves ? 1 : 0;
            totals.viaNesting += control.viaNesting ? 1 : 0;
            totals.numbered += /~\d+$/.test(control.identity) ? 1 : 0;
            kinds[control.kind] = (kinds[control.kind] ?? 0) + 1;
            totals.kinds[control.kind] = (totals.kinds[control.kind] ?? 0) + 1;
            totals.where[control.where] = (totals.where[control.where] ?? 0) + 1;
            if (control.identityKind) {
                totals.identityKinds[control.identityKind] = (totals.identityKinds[control.identityKind] ?? 0) + 1;
            }
            if (control.exception) {
                totals.exceptions++;
            }
            if (control.keys) {
                totals.lands.settings++;
            }
            if (control.storage) {
                totals.lands.storage++;
            }
            if (control.requests) {
                totals.lands.requests++;
            }
            if (control.lands === 'none') {
                totals.lands.none++;
            }
        }
        totals.controls += (section.controls ?? []).length;
        sections[key] = { controls: (section.controls ?? []).length, kinds };
    }
    return { sections, totals };
}

/**
 * The value controls that no section shows: they are in the page under every backend, source and state that the inventory opens,
 * and so are never reached or changed. Listed by the page (the surface) that holds them.
 * @param {any} fixture
 * @returns {Record<string, string[]>}
 */
export function hiddenEverywhere(fixture) {
    const shown = new Set();
    const hidden = new Map();
    for (const [key, section] of Object.entries(fixture.sections)) {
        const page = key.startsWith('extension:') ? key : parseSectionKey(key).surface;
        for (const control of section.controls ?? []) {
            if (!ROUND_TRIP_KINDS.includes(control.kind)) {
                continue;
            }
            if (control.where === 'hidden') {
                hidden.set(`${page}\u0000${control.identity}`, { page, identity: control.identity });
            } else {
                shown.add(`${page}\u0000${control.identity}`);
            }
        }
    }
    const byPage = {};
    for (const [id, { page, identity }] of hidden) {
        if (!shown.has(id)) {
            (byPage[page] ??= []).push(identity);
        }
    }
    return byPage;
}

/**
 * Builds the fixture from the parts that the tests of a recording wrote: each part holds the sections of one test.
 * A section that two parts both hold is a bug in the spec, so it throws.
 * @param {Record<string, { sections: Record<string, any> }>} parts
 * @param {{ commit: string, viewport: string, date: string }} recorded
 */
export function buildFixture(parts, recorded) {
    const sections = {};
    for (const [id, part] of Object.entries(parts)) {
        for (const [key, section] of Object.entries(part.sections)) {
            if (key in sections) {
                throw new Error(`The section ${key} is in two parts (${id}).`);
            }
            sections[key] = section;
        }
    }
    return { version: FIXTURE_VERSION, recorded, sections };
}

/**
 * Whether a set of parts is a complete recording: one part for each expected test id, and no other.
 * @param {Record<string, any>} parts
 * @param {readonly string[]} expected
 * @returns {{ complete: boolean, missing: string[], unexpected: string[] }}
 */
export function checkParts(parts, expected) {
    const have = new Set(Object.keys(parts));
    return {
        complete: expected.every(key => have.has(key)),
        missing: expected.filter(key => !have.has(key)),
        unexpected: [...have].filter(key => !expected.includes(key)),
    };
}
