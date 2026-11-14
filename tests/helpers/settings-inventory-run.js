/**
 * Records a section of the inventory, and checks one against the fixture. Both walk the same controls the same way, so a
 * control that the recording could reach and change is one that the check reaches and changes.
 */

import {
    ROUND_TRIP_KINDS,
    applyAccepted,
    compareKeys,
    compareSection,
    matchUnreachable,
    mergeCollections,
    normalizeControl,
} from './settings-inventory.js';
import { ACCEPTED_DIFFERENCES, exceptionFor } from './settings-inventory-rules.js';
import { SAVE_WATCH_MS, collectSection, enableDependentSets, markControl, reachMarked, restoreDependentSets, roundTrip } from './settings-inventory-steps.js';

const describe = control => `${control.kind}${control.name ? ` "${control.name}"` : ''}${control.group ? ` under "${control.group}"` : ''}`;

const PROBLEM_TEXT = Object.freeze({
    'not-found': 'is not on the page',
    'not-shown': 'is not shown, although the expanders are open',
    'no-box': 'has no box once scrolled into view',
    outside: 'is outside the window after it is scrolled into view',
    disabled: 'is disabled',
    covered: 'is covered by another element at its centre',
});

/** What covers a control is part of the message, and not of what is recorded: which element is on top changes from one run to the next. */
const withCover = (problem, coveredBy) => (coveredBy ? `${problem} (${coveredBy})` : problem);

/** The paths that two round trips of the same control both left changed: a path that only one of them did is another change's. */
const confirmedDrift = (first, second) => (first ?? []).filter(path => (second ?? []).includes(path));

/**
 * Marks a control, scrolls it into view and checks that a user could use it.
 * @returns {Promise<{ problem: string | null, code: string | null, coveredBy: string | null, via: string | null }>}
 * `code` is one of PROBLEMS of the pure module; `coveredBy` names the element that covers the control.
 */
export async function reachControl(page, root, skip, control) {
    const fail = (code, via, coveredBy = null) => ({ problem: PROBLEM_TEXT[code], code, coveredBy, via });
    const marked = await markControl(page, root, control.identity, { skip });
    if (!marked.found) {
        return fail('not-found', null);
    }
    if (!marked.shown) {
        return fail('not-shown', null);
    }
    const reach = await reachMarked(page);
    if (reach.width < 1 || reach.height < 1) {
        return fail('no-box', marked.via);
    }
    if (!reach.inViewport) {
        return fail('outside', marked.via);
    }
    if (reach.disabled && !control.disabled) {
        return fail('disabled', marked.via);
    }
    if (reach.covered) {
        return fail('covered', marked.via, reach.coveredBy);
    }
    return { problem: null, code: null, coveredBy: null, via: marked.via };
}

/**
 * Changes one control and puts it back, and ignores what was saved. Extensions fill in their defaults on the first change that
 * the page sees (Author's Note does), and those keys must not be taken for the keys of the first control that is tried.
 * The first usable control of the first section of a page is used, once.
 */
async function warmUp(page, recorder, { root, skip }, controls) {
    if (recorder.warmedUp) {
        return;
    }
    recorder.warmedUp = true;
    for (const control of controls) {
        if (control.where === 'hidden' || control.disabled || control.exception || control.unreachable
            || !['switch', 'checkbox', 'number', 'range'].includes(control.kind)) {
            continue;
        }
        const { problem, via } = await reachControl(page, root, skip, control);
        if (!problem) {
            await roundTrip(page, recorder, control, via, { root, skip });
            return;
        }
    }
}

/**
 * Collects a section, reaches every control that is shown and round-trips the value controls, and returns the section as the
 * fixture records it, with what could not be done as findings.
 * @param {import('@playwright/test').Page} page
 * @param {any} recorder
 * @param {{ key: string, root: string, skip: string[], roundTrip: boolean, only?: (record: any) => boolean }} target
 * `only` keeps the controls for which it answers true (each has `shown`): what a Connections source shows and the standard one does not.
 * @returns {Promise<{ section: any, findings: string[] }>}
 */
export async function recordSection(page, recorder, target) {
    const turned = await enableDependentSets(page, recorder, target.root);
    try {
        return await recordEnabledSection(page, recorder, target);
    } finally {
        await restoreDependentSets(page, recorder, turned);
    }
}

async function recordEnabledSection(page, recorder, { key, root, skip, roundTrip: exercise, only = () => true }) {
    const { before, after } = await collectSection(page, root, skip);
    const findings = [];
    const controls = [];
    const merged = mergeCollections(before, after).filter(record => only({ ...record, shown: record.where !== 'hidden' }));
    if (exercise) {
        await warmUp(page, recorder, { root, skip }, merged);
    }
    for (const record of merged) {
        const control = { ...record };
        if (/~\d+$/.test(record.identity) && ROUND_TRIP_KINDS.includes(record.kind)) {
            findings.push(`${key}: ${record.identity} (${describe(record)}) is a value control that only its position tells from another one.`);
        }
        if (record.where !== 'hidden') {
            const { problem, coveredBy, via } = await reachControl(page, root, skip, record);
            if (problem) {
                control.unreachable = problem;
                findings.push(`${key}: ${record.identity} (${describe(record)}) ${withCover(problem, coveredBy)}.`);
            } else if (exercise && ROUND_TRIP_KINDS.includes(record.kind) && !record.disabled) {
                const exception = exceptionFor(record);
                if (exception) {
                    control.exception = exception;
                } else {
                    const result = await roundTrip(page, recorder, record, via, { root, skip });
                    if (result.problem || result.restoreProblem) {
                        const why = result.problem ?? `it did not restore: ${result.restoreProblem}`;
                        control.exception = { reason: `could not be round-tripped when it was recorded: ${why}` };
                        findings.push(`${key}: ${record.identity} (${describe(record)}) could not be round-tripped: ${why}.`);
                    } else {
                        if (result.keys.length) {
                            control.keys = result.keys;
                            if (result.selfSaves) {
                                control.selfSaves = true;
                            } else {
                                findings.push(`${key}: ${record.identity} (${describe(record)}) changes ${result.keys.join(', ')}, and the app did not save by itself within ${SAVE_WATCH_MS} ms; only a forced save found it.`);
                            }
                        }
                        if (result.storage.length) {
                            control.storage = result.storage;
                        }
                        // A request is a place the value lands only when nothing else took it: a save of the settings brings other writes along.
                        if (result.requests.length && !result.keys.length && !result.storage.length) {
                            control.requests = result.requests;
                        }
                        if (!control.keys && !control.storage && !control.requests) {
                            control.lands = 'none';
                            findings.push(`${key}: ${record.identity} (${describe(record)}) was changed and nothing was saved, stored or requested.`);
                        }
                        if (result.keyboard !== undefined) {
                            control.keyboard = result.keyboard;
                        }
                        if (result.drift) {
                            const again = await roundTrip(page, recorder, record, via, { root, skip });
                            const drift = confirmedDrift(result.drift, again.drift);
                            if (drift.length) {
                                control.drift = drift;
                                findings.push(`${key}: ${record.identity} (${describe(record)}) leaves settings changed once its value is put back: ${result.driftDetail.filter(line => drift.some(path => line.startsWith(`${path} `))).join('; ')}.`);
                            }
                        }
                    }
                }
            }
        }
        controls.push(normalizeControl(control));
    }
    return { section: { root, ...(skip.length && { skip }), ...(!exercise && { roundTrip: false }), controls }, findings };
}

/**
 * Checks a section against the fixture: every recorded control is on the page and reachable, the value controls take a new value
 * and save what was recorded (and by themselves, where they did), and no control is on the page that the fixture does not know.
 * @param {import('@playwright/test').Page} page
 * @param {any} recorder
 * @param {{ key: string, root: string, section: any, fixture?: any, accepted?: readonly any[], only?: (live: any) => boolean }} target
 * @returns {Promise<string[]>} One message per failure.
 */
export async function checkSection(page, recorder, target) {
    const turned = await enableDependentSets(page, recorder, target.root);
    try {
        return await checkEnabledSection(page, recorder, target);
    } finally {
        await restoreDependentSets(page, recorder, turned);
    }
}

async function checkEnabledSection(page, recorder, { key, root, section: recorded, fixture = null, accepted = ACCEPTED_DIFFERENCES, only = () => true }) {
    const skip = recorded.skip ?? [];
    const failures = [];
    const after = (await collectSection(page, root, skip)).after.filter(only);
    // Every lookup is made inside the section's root: the same identity on another page is another control.
    const compared = compareSection(recorded, after);
    const { result, unused, arrived, renamed, added } = applyAccepted(key, compared, accepted);

    // A control that arrived or was renamed is checked as the recorded one; one that was added is reached and nothing else is known of it.
    const adopted = [];
    const sourceOf = (section, identity) => fixture?.sections?.[section]?.controls.find(control => control.identity === identity);
    for (const { entry, live } of arrived) {
        const source = sourceOf(entry.from, entry.identity);
        if (!source) {
            failures.push(`${key}: ${entry.identity} arrived from ${entry.from}, which does not record it.`);
        } else if (source.kind !== live.kind) {
            failures.push(`${key}: ${entry.identity} arrived from ${entry.from} as a ${live.kind}, and was recorded there as a ${source.kind}.`);
        } else {
            adopted.push(source);
        }
    }
    for (const { entry, recorded: was, live } of renamed) {
        if (was.kind !== live.kind) {
            failures.push(`${key}: ${entry.from} was renamed ${entry.to}, and is now a ${live.kind}; it was recorded as a ${was.kind}.`);
        } else {
            adopted.push({ ...was, identity: entry.to });
        }
    }
    for (const { live } of added) {
        adopted.push({ identity: live.identity, identityKind: live.identityKind, kind: live.kind, name: live.name ?? '', where: live.shown ? 'visible' : 'hidden', exception: { reason: 'accepted as a new control: nothing is recorded of what it saves' } });
    }
    const section = { ...recorded, controls: [...recorded.controls.filter(control => !renamed.some(pair => pair.recorded === control)), ...adopted] };
    for (const entry of unused) {
        failures.push(`${key}: the accepted difference "${entry.difference}" of ${entry.identity ?? entry.from} no longer occurs (${entry.reason}); remove it from ACCEPTED_DIFFERENCES.`);
    }

    const numbered = control => /~\d+$/.test(control.identity);
    for (const control of result.missing.filter(item => !numbered(item))) {
        const rename = result.renamed.find(pair => pair.recorded === control);
        failures.push(`${key}: ${control.identity} is missing (${describe(control)}).${rename ? ` A ${rename.live.kind} that is now called ${rename.live.identity} may be it.` : ''}`);
    }
    for (const { recorded: control, live } of result.kindChanged) {
        failures.push(`${key}: ${control.identity} is now a ${live.kind}, and was recorded as a ${control.kind}.`);
    }
    for (const control of result.added.filter(item => !numbered(item))) {
        failures.push(`${key}: new control ${control.identity} (${describe(control)}) is not in the fixture.`);
    }
    for (const { base, recorded: was, live } of result.countChanged) {
        failures.push(`${key}: ${was} controls of the identity ${base} were recorded and ${live} are on the page.`);
    }
    for (const control of result.notShown) {
        failures.push(`${key}: ${control.identity} (${describe(control)}) is not shown, although the expanders are open.`);
    }
    for (const control of result.nowDisabled) {
        failures.push(`${key}: ${control.identity} (${describe(control)}) is disabled, and was recorded as enabled.`);
    }
    if (section.roundTrip !== false) {
        await warmUp(page, recorder, { root, skip }, section.controls);
    }
    // A control that is known to be unreachable (an entry names it and the problem) passes while it is, and the entry fails once it is not.
    const knownUnreachable = accepted.filter(entry => entry.section === key && entry.difference === 'unreachable');
    const stillUnreachable = new Set();
    const skipExercise = new Set([...result.missing, ...result.notShown, ...result.kindChanged.map(pair => pair.recorded)].map(control => control.identity));
    for (const control of section.controls) {
        if (control.where === 'hidden' || skipExercise.has(control.identity) || control.unreachable) {
            continue;
        }
        const { problem, code, coveredBy, via } = await reachControl(page, root, skip, control);
        if (problem) {
            const known = matchUnreachable(knownUnreachable, control.identity, code, coveredBy);
            if (known) {
                stillUnreachable.add(known);
            } else if (!result.nowDisabled.includes(control)) {
                failures.push(`${key}: ${control.identity} (${describe(control)}) ${withCover(problem, coveredBy)}.`);
            }
            continue;
        }
        if (section.roundTrip === false || control.exception || control.disabled || !ROUND_TRIP_KINDS.includes(control.kind)) {
            continue;
        }
        const outcome = await roundTrip(page, recorder, control, via, { root, skip });
        if (outcome.problem) {
            failures.push(`${key}: ${control.identity} (${describe(control)}) could not be changed: ${outcome.problem}.`);
            continue;
        }
        if (outcome.restoreProblem) {
            failures.push(`${key}: ${control.identity} (${describe(control)}) did not restore: ${outcome.restoreProblem}.`);
        }
        let newDrift = (outcome.drift ?? []).filter(path => !(control.drift ?? []).includes(path));
        if (newDrift.length) {
            // A change that shows once may be another process's; it counts when a second round trip leaves it too.
            const again = await roundTrip(page, recorder, control, via, { root, skip });
            newDrift = confirmedDrift(newDrift, again.drift);
        }
        if (newDrift.length) {
            failures.push(`${key}: ${control.identity} (${describe(control)}) leaves ${newDrift.join(', ')} changed once its value is put back.`);
        }
        for (const [field, label] of [['keys', 'saved settings'], ['storage', 'local storage keys'], ['requests', 'requests']]) {
            if (control[field]) {
                const places = compareKeys(control[field], outcome[field]);
                if (!places.ok) {
                    failures.push(`${key}: ${control.identity} (${describe(control)}) no longer changes the ${label} ${places.missing.join(', ')}; it changes ${outcome[field].join(', ') || 'nothing'}.`);
                }
            }
        }
        if (control.selfSaves && !outcome.selfSaves) {
            failures.push(`${key}: ${control.identity} (${describe(control)}) no longer saves by itself: the app's debounced save did not send ${control.keys.join(', ')} within ${SAVE_WATCH_MS} ms, and only a forced save found it.`);
        }
    }
    for (const entry of knownUnreachable.filter(candidate => !stillUnreachable.has(candidate))) {
        failures.push(`${key}: the accepted difference "unreachable" (${entry.problem}) of ${entry.identity} no longer occurs (${entry.reason}); remove it from ACCEPTED_DIFFERENCES.`);
    }
    return failures;
}
