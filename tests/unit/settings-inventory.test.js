import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';
import {
    ACCEPTED_KINDS,
    FIXTURE_VERSION,
    PROBLEMS,
    applyAccepted,
    buildFixture,
    checkParts,
    compareKeys,
    compareSection,
    diffSettings,
    driftPaths,
    getPath,
    hiddenEverywhere,
    matchUnreachable,
    mergeCollections,
    nextNumber,
    normalizeControl,
    parseSectionKey,
    sameValue,
    sectionKey,
    serializeInventory,
    summarizeInventory,
    textCandidates,
    validateAccepted,
    validateInventory,
} from '../helpers/settings-inventory.js';
import { ACCEPTED_DIFFERENCES, exceptionFor, isIgnoredPath, readyExtrasFor, skipSelectorsFor } from '../helpers/settings-inventory-rules.js';

const control = (overrides = {}) => ({
    identity: '#power', identityKind: 'id', kind: 'switch', name: 'Power', group: 'General', where: 'visible', keys: ['power_user.power'], ...overrides,
});

const fixtureOf = (controls, section = {}) => ({
    version: FIXTURE_VERSION,
    recorded: { commit: '597301788', viewport: '1440x900' },
    sections: { 'settings.customize.interface': { root: '[data-sb-panel="interface"]', ...section, controls } },
});

const live = (overrides = {}) => ({ identity: '#power', identityKind: 'id', kind: 'switch', shown: true, disabled: false, ...overrides });

describe('section keys', () => {
    test('build and parse a page, a backend, a provider, a state and an extension', () => {
        expect(sectionKey('settings.backend.sampling', { backend: 'horde' })).toBe('settings.backend.sampling@horde');
        expect(sectionKey('settings.backend.connections', { backend: 'chat-completion', source: 'claude' })).toBe('settings.backend.connections@chat-completion:claude');
        expect(sectionKey('settings.backend.agents', { state: 'settings-page' })).toBe('settings.backend.agents#settings-page');
        expect(parseSectionKey('settings.backend.sampling@horde')).toEqual({ surface: 'settings.backend.sampling', backend: 'horde', source: undefined, state: undefined });
        expect(parseSectionKey('settings.backend.connections@text-completion:vertex_ai')).toMatchObject({ backend: 'text-completion', source: 'vertex_ai' });
        expect(parseSectionKey('settings.backend.agents#settings-page')).toMatchObject({ state: 'settings-page' });
        expect(parseSectionKey('extension:qig-settings')).toEqual({ extension: 'qig-settings' });
        expect(() => parseSectionKey('Not A Key')).toThrow(/not a section key/);
    });
});

describe('validateInventory', () => {
    test('accepts a well-formed fixture', () => {
        expect(validateInventory(fixtureOf([control()]))).toEqual([]);
    });

    test('names the section and the control of each problem', () => {
        const problems = validateInventory(fixtureOf([control({ kind: 'dial' }), control({ identity: '#other', where: 'nowhere' })]));
        expect(problems).toContain('settings.customize.interface: #power: kind "dial" is not one of switch, checkbox, select, number, range, text, textarea, radio, color, file, button, link.');
        expect(problems.some(problem => problem.startsWith('settings.customize.interface: #other: where "nowhere"'))).toBe(true);
    });

    test('rejects a wrong version, a missing commit and a section key that is not one', () => {
        expect(validateInventory({ ...fixtureOf([control()]), version: 9 })).toContain(`version must be ${FIXTURE_VERSION}.`);
        expect(validateInventory({ ...fixtureOf([control()]), recorded: {} })).toContain('recorded must name the commit and the viewport.');
        const bad = fixtureOf([control()]);
        bad.sections['Not A Key'] = bad.sections['settings.customize.interface'];
        expect(validateInventory(bad)).toContain('Not A Key: the key is not a section key.');
    });

    test('rejects an identity used twice and a section without controls', () => {
        expect(validateInventory(fixtureOf([control(), control()]))).toContain('settings.customize.interface: #power: identity is used twice in the section.');
        expect(validateInventory(fixtureOf([]))).toContain('settings.customize.interface: controls must be a non-empty list.');
    });

    test('a switch, select, number or range must say what it saves', () => {
        const bare = control({ keys: undefined });
        expect(validateInventory(fixtureOf([bare])).join('\n')).toMatch(/a switch needs keys, storage, requests, lands "none" or an exception/);
        expect(validateInventory(fixtureOf([{ ...bare, lands: 'none' }]))).toEqual([]);
        expect(validateInventory(fixtureOf([{ ...bare, exception: { reason: 'reloads the page' } }]))).toEqual([]);
        expect(validateInventory(fixtureOf([{ ...bare, disabled: true }]))).toEqual([]);
        expect(validateInventory(fixtureOf([{ ...bare, unreachable: 'is covered' }]))).toEqual([]);
        expect(validateInventory(fixtureOf([{ ...bare, where: 'hidden' }]))).toEqual([]);
    });

    test('an exception needs a reason, and an exception or an unreachable control saves nothing', () => {
        const bare = control({ keys: undefined });
        expect(validateInventory(fixtureOf([{ ...bare, exception: {} }])).join('\n')).toMatch(/an exception needs a reason/);
        expect(validateInventory(fixtureOf([control({ exception: { reason: 'x' } })])).join('\n')).toMatch(/an exception is not round-tripped/);
        expect(validateInventory(fixtureOf([control({ unreachable: 'covered' })])).join('\n')).toMatch(/an unreachable control is not round-tripped/);
        expect(validateInventory(fixtureOf([{ ...bare, where: 'hidden', unreachable: 'covered' }])).join('\n')).toMatch(/a hidden control is not reached/);
    });

    test('keys are sorted, unique and non-empty, and only a round-tripped control has them', () => {
        expect(validateInventory(fixtureOf([control({ keys: ['b', 'a'] })])).join('\n')).toMatch(/keys must be a non-empty, sorted list/);
        expect(validateInventory(fixtureOf([control({ keys: [] })])).join('\n')).toMatch(/keys must be a non-empty, sorted list/);
        expect(validateInventory(fixtureOf([control({ kind: 'button', keys: ['a'] })])).join('\n')).toMatch(/keys is recorded for a control that is not round-tripped/);
        expect(validateInventory(fixtureOf([control({ lands: 'none' })])).join('\n')).toMatch(/lands is "none" but a place is recorded/);
        expect(validateInventory(fixtureOf([control({ lands: 'elsewhere', keys: undefined })])).join('\n')).toMatch(/lands is only ever "none"/);
    });

    test('a section that is not round-tripped records no keys', () => {
        expect(validateInventory(fixtureOf([control()], { roundTrip: false })).join('\n')).toMatch(/the section is not round-tripped/);
        const bare = control({ keys: undefined });
        expect(validateInventory(fixtureOf([bare], { roundTrip: false }))).toEqual([]);
        expect(validateInventory(fixtureOf([bare], { roundTrip: true })).join('\n')).toMatch(/roundTrip is only ever false/);
    });

    test('drift is a sorted list of paths on a round-tripped control', () => {
        expect(validateInventory(fixtureOf([control({ drift: ['a.b'] })]))).toEqual([]);
        expect(validateInventory(fixtureOf([control({ drift: ['b', 'a'] })])).join('\n')).toMatch(/drift must be a non-empty, sorted list/);
        expect(validateInventory(fixtureOf([control({ kind: 'button', drift: ['a'] })])).join('\n')).toMatch(/drift is recorded for a control that is not round-tripped/);
    });

    test('a shown control needs an identity kind and a name', () => {
        const text = validateInventory(fixtureOf([control({ identityKind: undefined, name: undefined })])).join('\n');
        expect(text).toMatch(/identityKind "undefined" is not one of id, name, data, field, label/);
        expect(text).toMatch(/name must be a string/);
    });

    test('a value control that only its position tells apart is a problem, a button is not', () => {
        expect(validateInventory(fixtureOf([control({ identity: 'label:switch:power~2', identityKind: 'label' })])).join('\n')).toMatch(/told apart by its position/);
        const button = { identity: 'label:button:save~2', identityKind: 'label', kind: 'button', name: 'Save', where: 'visible' };
        expect(validateInventory(fixtureOf([button]))).toEqual([]);
    });

    test('selfSaves, keyboard and viaNesting have one shape each', () => {
        expect(validateInventory(fixtureOf([control({ selfSaves: true })]))).toEqual([]);
        expect(validateInventory(fixtureOf([control({ selfSaves: false })])).join('\n')).toMatch(/selfSaves is only ever true/);
        expect(validateInventory(fixtureOf([control({ keys: undefined, lands: 'none', selfSaves: true })])).join('\n')).toMatch(/selfSaves is only ever true/);
        expect(validateInventory(fixtureOf([control({ kind: 'range', keyboard: false })]))).toEqual([]);
        expect(validateInventory(fixtureOf([control({ keyboard: true })])).join('\n')).toMatch(/keyboard is a boolean, recorded for a range alone/);
        expect(validateInventory(fixtureOf([control({ viaNesting: false })])).join('\n')).toMatch(/viaNesting is only ever true/);
    });

    test('a skipped section says why and has no controls', () => {
        const skipped = fixtureOf([control()]);
        skipped.sections['settings.backend.connections@text-completion:ollama'] = { root: '#x', skipped: 'choosing it throws without a connection' };
        expect(validateInventory(skipped)).toEqual([]);
        skipped.sections['settings.backend.connections@text-completion:ollama'] = { root: '#x', skipped: '' };
        expect(validateInventory(skipped).join('\n')).toMatch(/skipped must say why/);
    });
});

describe('diffSettings, getPath and driftPaths', () => {
    test('lists the dotted path of each value that differs, sorted, down to the first non-object', () => {
        const before = { a: { x: 1, y: [1, 2] }, b: 'one', c: { d: { e: true } } };
        const after = { a: { x: 2, y: [1, 2, 3] }, b: 'one', c: { d: { e: true } }, z: 1 };
        expect(diffSettings(before, after)).toEqual(['a.x', 'a.y', 'z']);
    });

    test('ignores `_version` at the top level only, and sees a key that was removed', () => {
        expect(diffSettings({ _version: 1, n: { _version: 1 } }, { _version: 2, n: { _version: 2 } })).toEqual(['n._version']);
        expect(diffSettings({ a: 1, b: 2 }, { a: 1 })).toEqual(['b']);
        expect(diffSettings({ a: 1 }, { a: 1 })).toEqual([]);
    });

    test('reads a dotted path', () => {
        expect(getPath({ a: { b: 3 } }, 'a.b')).toBe(3);
        expect(getPath({ a: { b: 3 } }, 'a.c.d')).toBeUndefined();
        expect(getPath({ a: null }, 'a.b')).toBeUndefined();
    });

    test('drift is only what existed before: a default that a save adds is not drift', () => {
        const before = { note: {}, power: 1 };
        const restored = { note: { default_note: '' }, power: 2 };
        expect(driftPaths(before, restored)).toEqual(['power']);
        expect(driftPaths(before, { note: {}, power: 1 })).toEqual([]);
        expect(driftPaths({ a: 1 }, {})).toEqual(['a']);
    });
});

describe('compareKeys', () => {
    test('passes when every recorded place is seen again, and reports a new one without failing', () => {
        expect(compareKeys(['a', 'b'], ['a', 'b'])).toEqual({ ok: true, missing: [], extra: [] });
        expect(compareKeys(['a'], ['a', 'ts'])).toEqual({ ok: true, missing: [], extra: ['ts'] });
    });

    test('fails when a recorded place is no longer written', () => {
        expect(compareKeys(['power_user.power'], ['power_user.other'])).toEqual({ ok: false, missing: ['power_user.power'], extra: ['power_user.other'] });
        expect(compareKeys(['a'], []).ok).toBe(false);
    });
});

describe('compareSection', () => {
    test('a page that matches reports nothing', () => {
        const result = compareSection({ controls: [control()] }, [live()]);
        expect(result).toEqual({ missing: [], added: [], kindChanged: [], notShown: [], nowDisabled: [], renamed: [], countChanged: [] });
    });

    test('reports a control that is gone, and a control that the fixture does not know', () => {
        const gone = compareSection({ controls: [control(), control({ identity: '#gone', name: 'Gone' })] }, [live()]);
        expect(gone.missing.map(item => item.identity)).toEqual(['#gone']);
        const fresh = compareSection({ controls: [control()] }, [live(), live({ identity: '#fresh', kind: 'select' })]);
        expect(fresh.added.map(item => item.identity)).toEqual(['#fresh']);
        expect(fresh.missing).toEqual([]);
    });

    test('reports a control whose kind changed', () => {
        const result = compareSection({ controls: [control()] }, [live({ kind: 'checkbox' })]);
        expect(result.kindChanged).toHaveLength(1);
        expect(result.kindChanged[0].recorded.kind).toBe('switch');
        expect(result.kindChanged[0].live.kind).toBe('checkbox');
    });

    test('reports a control that is not shown and one that became disabled', () => {
        const result = compareSection({ controls: [control(), control({ identity: '#b', kind: 'select' }), control({ identity: '#c', disabled: true })] }, [
            live({ shown: false }), live({ identity: '#b', kind: 'select', disabled: true }), live({ identity: '#c', disabled: true }),
        ]);
        expect(result.notShown.map(item => item.identity)).toEqual(['#power']);
        expect(result.nowDisabled.map(item => item.identity)).toEqual(['#b']);
    });

    test('a hidden control may be hidden, and is missing when the section does not hold it at all', () => {
        const hidden = { identity: '#other_provider_key', kind: 'text', where: 'hidden' };
        expect(compareSection({ controls: [hidden] }, [live({ identity: '#other_provider_key', kind: 'text', shown: false })]).notShown).toEqual([]);
        expect(compareSection({ controls: [hidden] }, []).missing).toEqual([hidden]);
    });

    test('a control of another section with the same name is not this one', () => {
        const hidden = { identity: 'label:button:save', kind: 'button', where: 'hidden' };
        expect(compareSection({ controls: [hidden] }, [live({ identity: 'label:button:save', kind: 'button' }), live({ identity: '#elsewhere' })]).missing).toEqual([]);
        expect(compareSection({ controls: [hidden] }, [live({ identity: '#elsewhere' })]).missing).toEqual([hidden]);
    });

    test('pairs a reworded label with the one that is now missing', () => {
        const recorded = control({ identity: 'label:button:save summary', identityKind: 'label', kind: 'button', keys: undefined });
        const now = live({ identity: 'label:button:save the summary', identityKind: 'label', kind: 'button' });
        const result = compareSection({ controls: [recorded] }, [now]);
        expect(result.missing).toEqual([recorded]);
        expect(result.added).toEqual([now]);
        expect(result.renamed).toEqual([{ recorded, live: now }]);
    });

    test('does not pair controls that are not known by their label', () => {
        expect(compareSection({ controls: [control()] }, [live({ identity: '#renamed' })]).renamed).toEqual([]);
    });

    test('controls that only their position tells apart are counted by name', () => {
        const button = (identity, shown = true) => ({ identity, identityKind: 'label', kind: 'button', name: 'Save', where: 'visible', shown });
        const recorded = [button('label:button:save'), button('label:button:save~2'), button('label:button:save~3')];
        const one = compareSection({ controls: recorded }, recorded.slice(0, 2));
        expect(one.countChanged).toEqual([{ base: 'label:button:save', recorded: 3, live: 2 }]);
        const same = compareSection({ controls: recorded }, recorded);
        expect(same.countChanged).toEqual([]);
        const more = compareSection({ controls: recorded.slice(0, 2) }, recorded);
        expect(more.countChanged).toEqual([{ base: 'label:button:save', recorded: 2, live: 3 }]);
    });
});

describe('mergeCollections', () => {
    test('says where each control is: visible, behind an expander, or hidden', () => {
        const before = [{ identity: '#a', shown: true }, { identity: '#b', shown: false }, { identity: '#c', shown: false }];
        const after = [{ identity: '#a', shown: true }, { identity: '#b', shown: true }, { identity: '#c', shown: false }, { identity: '#d', shown: true }];
        expect(mergeCollections(before, after).map(item => [item.identity, item.where])).toEqual([
            ['#a', 'visible'], ['#b', 'expander'], ['#c', 'hidden'], ['#d', 'expander'],
        ]);
        expect(mergeCollections(before, after)[0]).not.toHaveProperty('shown');
    });
});

describe('normalizeControl', () => {
    test('keeps a stable key order and drops what is false or empty, except a keyboard that did nothing', () => {
        const normalized = normalizeControl({ keys: ['a'], kind: 'range', identity: '#a', identityKind: 'id', name: 'A', group: '', where: 'visible', disabled: false, driver: 'label', keyboard: false, selfSaves: true });
        expect(Object.keys(normalized)).toEqual(['identity', 'identityKind', 'kind', 'name', 'where', 'driver', 'keyboard', 'keys', 'selfSaves']);
        expect(normalized.keyboard).toBe(false);
    });

    test('a hidden control is stored as identity, kind and where', () => {
        expect(normalizeControl({ identity: '#h', identityKind: 'id', kind: 'text', name: 'H', group: 'G', where: 'hidden', disabled: true }))
            .toEqual({ identity: '#h', kind: 'text', where: 'hidden' });
    });
});

describe('serializeInventory', () => {
    test('writes one control per line, and reads back as the same fixture', () => {
        const fixture = fixtureOf([control(), control({ identity: '#b', kind: 'select', keys: ['x.y'] }), { identity: '#h', kind: 'text', where: 'hidden' }], { skip: ['.bg_list'] });
        fixture.sections['settings.backend.agents#settings-page'] = { root: '[data-agent-page]', roundTrip: false, controls: [{ identity: '#z', identityKind: 'id', kind: 'button', name: 'Z', where: 'visible' }] };
        const text = serializeInventory(fixture);
        expect(JSON.parse(text)).toEqual(fixture);
        expect(text.split('\n').filter(line => line.includes('"identity"'))).toHaveLength(4);
        expect(text.endsWith('\n')).toBe(true);
        expect(validateInventory(JSON.parse(text))).toEqual([]);
    });

    test('a skipped section is one line', () => {
        const fixture = fixtureOf([control()]);
        fixture.sections['settings.backend.connections@text-completion:ollama'] = { root: '#c', skipped: 'throws' };
        const text = serializeInventory(fixture);
        expect(JSON.parse(text)).toEqual(fixture);
        expect(text).toContain('"settings.backend.connections@text-completion:ollama": {"root":"#c","skipped":"throws"}');
    });

    test('lists sections in key order, so that a recording in any order gives the same file', () => {
        const a = fixtureOf([control()]);
        a.sections['a.first'] = { root: '#a', roundTrip: false, controls: [{ identity: '#q', identityKind: 'id', kind: 'button', name: 'Q', where: 'visible' }] };
        const b = { ...a, sections: Object.fromEntries(Object.entries(a.sections).reverse()) };
        expect(serializeInventory(a)).toBe(serializeInventory(b));
    });
});

describe('buildFixture and checkParts', () => {
    const recorded = { commit: '597301788', viewport: '1440x900' };
    const section = { root: '#x', controls: [control()] };

    test('joins the sections of every part', () => {
        const fixture = buildFixture({ one: { sections: { 'a.page': section } }, two: { sections: { 'b.page@horde': section } } }, recorded);
        expect(Object.keys(fixture.sections)).toEqual(['a.page', 'b.page@horde']);
        expect(fixture).toMatchObject({ version: FIXTURE_VERSION, recorded });
    });

    test('a section in two parts is a bug', () => {
        expect(() => buildFixture({ one: { sections: { 'a.page': section } }, two: { sections: { 'a.page': section } } }, recorded)).toThrow(/in two parts \(two\)/);
    });

    test('a recording is complete when every planned test wrote its part', () => {
        expect(checkParts({ a: {}, b: {} }, ['a', 'b'])).toEqual({ complete: true, missing: [], unexpected: [] });
        expect(checkParts({ a: {} }, ['a', 'b'])).toEqual({ complete: false, missing: ['b'], unexpected: [] });
        expect(checkParts({ a: {}, old: {} }, ['a'])).toEqual({ complete: true, missing: [], unexpected: ['old'] });
    });
});

describe('summaries', () => {
    const fixture = () => {
        const base = fixtureOf([
            control({ selfSaves: true }),
            control({ identity: '#b', kind: 'select', keys: undefined, storage: ['language'] }),
            control({ identity: '#c', kind: 'range', keys: undefined, lands: 'none', viaNesting: true }),
            control({ identity: '#d', kind: 'text', keys: undefined, exception: { reason: 'secret' } }),
            { identity: '#h', kind: 'text', where: 'hidden' },
            { identity: '#shown_elsewhere', kind: 'text', where: 'hidden' },
        ]);
        base.sections['settings.customize.appearance'] = { root: '#a', controls: [{ identity: '#shown_elsewhere', identityKind: 'id', kind: 'text', name: 'S', where: 'visible', lands: 'none' }] };
        base.sections['settings.backend.connections@text-completion:ollama'] = { root: '#c', skipped: 'throws' };
        return base;
    };

    test('count by section, kind, identity kind, and where the value lands', () => {
        const { sections, totals } = summarizeInventory(fixture());
        expect(sections['settings.customize.interface']).toEqual({ controls: 6, kinds: { switch: 1, select: 1, range: 1, text: 3 } });
        expect(totals).toMatchObject({
            controls: 7, exceptions: 1, roundTripped: 4, selfSaves: 1, viaNesting: 1, skippedSections: 1,
            where: { visible: 5, hidden: 2 }, identityKinds: { id: 5 }, lands: { settings: 1, storage: 1, requests: 0, none: 2 },
        });
    });

    test('lists the value controls that no section of their page shows, and a control of the same name on another page is another control', () => {
        const base = fixture();
        base.sections['settings.customize.interface#detail'] = { root: '#d', controls: [{ identity: '#h', identityKind: 'id', kind: 'text', name: 'H', where: 'visible', lands: 'none' }] };
        expect(hiddenEverywhere(fixture())).toEqual({ 'settings.customize.interface': ['#h', '#shown_elsewhere'] });
        expect(hiddenEverywhere(base)).toEqual({ 'settings.customize.interface': ['#shown_elsewhere'] });
    });
});

describe('rules', () => {
    test('a secret field is always an exception, with where its value lands', () => {
        expect(exceptionFor({ identity: '#api_key_openai', kind: 'text', secret: true })).toMatchObject({ lands: expect.stringContaining('secrets') });
    });

    test('a preset picker is an exception, and a select of the same kind that is not one is not', () => {
        expect(exceptionFor({ identity: '#settings_preset_openai', kind: 'select' })).toMatchObject({ reason: expect.stringContaining('loads all of its values') });
        expect(exceptionFor({ identity: '#sysprompt_select', kind: 'select' })).not.toBeNull();
        expect(exceptionFor({ identity: '#sysprompt_select', kind: 'button' })).toBeNull();
        expect(exceptionFor({ identity: '#instruct_names_behavior', kind: 'select' })).toBeNull();
    });

    test('the language select, the backend picker and the branch select are exceptions', () => {
        expect(exceptionFor({ identity: '#ui_language_select', kind: 'select' })).toMatchObject({ lands: expect.stringContaining('local storage') });
        expect(exceptionFor({ identity: 'field:backend-type:radio@#x', kind: 'radio' })).not.toBeNull();
        expect(exceptionFor({ identity: '#sb-branch-select', kind: 'select' })).toMatchObject({ reason: expect.stringContaining('git checkout') });
    });

    test('the data-driven lists of a page are skipped by selector, and nothing is skipped by a control name', () => {
        expect(skipSelectorsFor('settings.customize.appearance')).toEqual(['.bg_list']);
        expect(skipSelectorsFor('settings.conversation.panel')).toEqual(['.sb-conversation-member-list']);
        expect(skipSelectorsFor('extension:qr_container')).toEqual(['.qr--setList', '.qr--set-qrListContents']);
        expect(skipSelectorsFor('settings.backend.sampling')).toEqual(['.openai_logit_bias_list', '.logit_bias_list']);
        expect(skipSelectorsFor('settings.customize.interface')).toEqual([]);
        expect(skipSelectorsFor('settings.customize.appearance', 'anything')).toEqual(['.bg_list']);
        expect(exceptionFor({ identity: 'label:checkbox:seraphina', kind: 'checkbox' })).toBeNull();
    });

    test('the Getting Started checklist is not a change that a control made', () => {
        expect(isIgnoredPath('accountStorage.WelcomePage_GettingStarted')).toBe(true);
        expect(isIgnoredPath('power_user.power')).toBe(false);
    });

    test('a page that fills itself from the server names what it waits for', () => {
        expect(readyExtrasFor('settings.customize.data-security')).toContain('#sb-branch-select');
        expect(readyExtrasFor('settings.customize.interface')).toEqual([]);
    });
});

describe('accepted differences', () => {
    const SECTION = 'settings.customize.interface';
    const recorded = [control(), control({ identity: '#spin', kind: 'number', keys: ['power_user.spin'] })];
    const fixture = fixtureOf(recorded);
    fixture.sections['settings.customize.appearance'] = { root: '#a', controls: [control({ identity: '#moved', keys: ['power_user.moved'] }), { identity: '#h', kind: 'text', where: 'hidden' }] };
    const compare = (liveControls, controls = recorded) => compareSection({ controls }, liveControls);
    const unchanged = [live(), live({ identity: '#spin', kind: 'number' })];
    const entry = (fields) => ({ section: SECTION, reason: 'a rebuild of the page', ...fields });

    test('a rebuild that only regroups a control changes nothing that is compared', () => {
        const regrouped = [live(), live({ identity: '#spin', kind: 'number', group: 'Another group', name: 'Another name' })];
        expect(compare(regrouped)).toMatchObject({ missing: [], added: [], kindChanged: [], notShown: [] });
    });

    test('a listed kind change passes, and any other kind of that control still fails', () => {
        const kind = entry({ identity: '#spin', difference: 'kind', from: 'number', to: 'text' });
        const accepted = applyAccepted(SECTION, compare([live(), live({ identity: '#spin', kind: 'text' })]), [kind]);
        expect(accepted.result.kindChanged).toEqual([]);
        expect(accepted.unused).toEqual([]);
        const other = applyAccepted(SECTION, compare([live(), live({ identity: '#spin', kind: 'range' })]), [kind]);
        expect(other.result.kindChanged).toHaveLength(1);
        expect(other.unused).toEqual([kind]);
        expect(applyAccepted(SECTION, compare([live(), live({ identity: '#spin', kind: 'text' })]), [{ ...kind, from: 'select' }]).result.kindChanged).toHaveLength(1);
    });

    test('a control that left is accepted when an entry names it', () => {
        const gone = compare([live()]);
        expect(applyAccepted(SECTION, gone, [entry({ identity: '#power', difference: 'left' })]).result.missing).toHaveLength(1);
        const left = entry({ identity: '#spin', difference: 'left', to: 'settings.customize.appearance' });
        const accepted = applyAccepted(SECTION, gone, [left]);
        expect(accepted.result.missing).toEqual([]);
        expect(accepted.unused).toEqual([]);
    });

    test('a control that arrives is taken out of the new ones and handed back to be checked', () => {
        const arrived = entry({ identity: '#moved', difference: 'arrived', from: 'settings.customize.appearance' });
        const result = applyAccepted(SECTION, compare([...unchanged, live({ identity: '#moved' }), live({ identity: '#other' })]), [arrived]);
        expect(result.result.added.map(item => item.identity)).toEqual(['#other']);
        expect(result.arrived.map(item => item.live.identity)).toEqual(['#moved']);
    });

    test('a renamed control passes as the recorded one under its new identity, in both lists at once', () => {
        const labelled = [control({ identity: 'label:button:save summary', identityKind: 'label', kind: 'button', keys: undefined })];
        const renamed = entry({ difference: 'renamed', from: 'label:button:save summary', to: 'label:button:save' });
        const result = applyAccepted(SECTION, compare([live({ identity: 'label:button:save', kind: 'button' })], labelled), [renamed]);
        expect(result.result.missing).toEqual([]);
        expect(result.result.added).toEqual([]);
        expect(result.renamed).toHaveLength(1);
        expect(result.renamed[0].recorded.identity).toBe('label:button:save summary');
        expect(result.unused).toEqual([]);
    });

    test('a rename needs both halves: a control that is only missing, or only new, is not accepted', () => {
        const labelled = [control({ identity: 'label:button:save summary', identityKind: 'label', kind: 'button', keys: undefined })];
        const renamed = entry({ difference: 'renamed', from: 'label:button:save summary', to: 'label:button:save' });
        const onlyMissing = applyAccepted(SECTION, compare([], labelled), [renamed]);
        expect(onlyMissing.result.missing).toHaveLength(1);
        expect(onlyMissing.unused).toEqual([renamed]);
    });

    test('an added control is accepted by name, and the others stay new', () => {
        const added = entry({ identity: '#fresh', difference: 'added' });
        const result = applyAccepted(SECTION, compare([...unchanged, live({ identity: '#fresh' }), live({ identity: '#another' })]), [added]);
        expect(result.result.added.map(item => item.identity)).toEqual(['#another']);
        expect(result.added.map(item => item.live.identity)).toEqual(['#fresh']);
    });

    test('every kind of entry is unused, and so a failure, once its difference no longer occurs', () => {
        const entries = [
            entry({ identity: '#spin', difference: 'kind', to: 'text' }),
            entry({ identity: '#spin', difference: 'left' }),
            entry({ identity: '#moved', difference: 'arrived', from: 'settings.customize.appearance' }),
            entry({ identity: '#fresh', difference: 'added' }),
            entry({ difference: 'renamed', from: '#spin', to: '#spin2' }),
        ];
        for (const one of entries) {
            expect(applyAccepted(SECTION, compare(unchanged), [one]).unused).toEqual([one]);
        }
    });

    test('an entry applies to its own section and its own control only', () => {
        const kind = entry({ identity: '#spin', difference: 'kind', to: 'text' });
        const changed = [live(), live({ identity: '#spin', kind: 'text' })];
        expect(applyAccepted('settings.customize.appearance', compare(changed), [kind]).result.kindChanged).toHaveLength(1);
        expect(applyAccepted('settings.customize.appearance', compare(changed), [kind]).unused).toEqual([]);
        const both = [live({ kind: 'checkbox' }), live({ identity: '#spin', kind: 'text' })];
        expect(applyAccepted(SECTION, compare(both), [kind]).result.kindChanged.map(pair => pair.recorded.identity)).toEqual(['#power']);
    });

    test('an unreachable entry pins the control, the problem, and the element that covers it', () => {
        const pinned = entry({ identity: '#spin', difference: 'unreachable', problem: 'covered', coveredBy: 'ds-row-suffix' });
        expect(matchUnreachable([pinned], '#spin', 'covered', 'div.ds-row-suffix')).toBe(pinned);
        expect(matchUnreachable([pinned], '#spin', 'covered', 'div.sb-dialog-scrim')).toBeNull();
        expect(matchUnreachable([pinned], '#spin', 'disabled', null)).toBeNull();
        expect(matchUnreachable([pinned], '#power', 'covered', 'div.ds-row-suffix')).toBeNull();
        const anyCover = entry({ identity: '#spin', difference: 'unreachable', problem: 'covered' });
        expect(matchUnreachable([anyCover], '#spin', 'covered', null)).toBe(anyCover);
        expect(applyAccepted(SECTION, compare(unchanged), [pinned]).unused).toEqual([]);
    });

    test('validateAccepted wants the section, the control, a known difference and a reason', () => {
        const kind = entry({ identity: '#spin', difference: 'kind', from: 'number', to: 'text' });
        expect(validateAccepted([kind], fixture)).toEqual([]);
        expect(validateAccepted([entry({ identity: '#moved', difference: 'arrived', from: 'settings.customize.appearance' })], fixture)).toEqual([]);
        expect(validateAccepted([entry({ difference: 'renamed', from: '#spin', to: '#spin2' })], fixture)).toEqual([]);
        expect(validateAccepted([entry({ identity: '#fresh', difference: 'added' })], fixture)).toEqual([]);
        expect(validateAccepted([{ ...kind, section: 'nowhere' }], fixture).join('\n')).toMatch(/section "nowhere" is not a section of the fixture/);
        expect(validateAccepted([{ ...kind, identity: '' }], fixture).join('\n')).toMatch(/an entry names the control/);
        expect(validateAccepted([{ ...kind, difference: 'anything' }], fixture).join('\n')).toMatch(/is not one of kind, left, arrived/);
        expect(validateAccepted([{ ...kind, reason: '' }], fixture).join('\n')).toMatch(/reason is required/);
        expect(validateAccepted([{ ...kind, to: 'dial' }], fixture).join('\n')).toMatch(/needs `to`/);
        expect(validateAccepted([kind, kind], fixture).join('\n')).toMatch(/is listed twice/);
        expect(validateAccepted([entry({ identity: '#nope', difference: 'arrived', from: 'settings.customize.appearance' })], fixture).join('\n')).toMatch(/is not recorded in section/);
        expect(validateAccepted([entry({ identity: '#h', difference: 'arrived', from: 'settings.customize.appearance' })], fixture).join('\n')).toMatch(/hidden control is not reached/);
        expect(validateAccepted([entry({ difference: 'renamed', from: '#nope', to: '#spin2' })], fixture).join('\n')).toMatch(/is not recorded in section/);
        expect(validateAccepted([entry({ difference: 'renamed', from: '#spin', to: '#spin' })], fixture).join('\n')).toMatch(/needs a `to` that is not `from`/);
        expect(validateAccepted([entry({ identity: '#spin', difference: 'unreachable', problem: 'weird' })], fixture).join('\n')).toMatch(/problem "weird" is not one of/);
        expect(validateAccepted([entry({ identity: '#spin', difference: 'unreachable', problem: 'disabled', coveredBy: 'x' })], fixture).join('\n')).toMatch(/coveredBy is text/);
    });

    test('no kind of entry can accept a change of what a control saves', () => {
        // An entry has no field that names a key, a place or a save, so a control that saves something else is a failure whatever is listed.
        const forms = ACCEPTED_KINDS.map(difference => entry({ identity: '#spin', difference, from: 'settings.customize.appearance', to: 'text', problem: 'covered' }));
        for (const form of forms) {
            for (const field of ['keys', 'storage', 'requests', 'selfSaves', 'lands', 'drift']) {
                expect(validateAccepted([{ ...form, [field]: ['power_user.spin'] }], fixture).join('\n')).toMatch(new RegExp(`${field} is not a field of an entry`));
            }
        }
        // And the comparison that decides it takes no part in the list: the same keys fail with every entry present.
        expect(compareKeys(['power_user.spin'], ['power_user.other']).ok).toBe(false);
        expect(PROBLEMS).not.toContain('keys');
    });

    test('the list of the tree is valid for the fixture of the tree', () => {
        const tree = JSON.parse(readFileSync(new URL('../fixtures/settings-inventory.json', import.meta.url), 'utf8'));
        expect(validateAccepted(ACCEPTED_DIFFERENCES, tree)).toEqual([]);
    });
});

describe('number steps', () => {
    test('nextNumber moves a tenth of the way across the limits, on the side that has room', () => {
        expect(nextNumber('50', { min: '0', max: '100', step: '1' })).toBe('60');
        expect(nextNumber('100', { min: '0', max: '100', step: '1' })).toBe('90');
        expect(nextNumber('0.5', { min: '0', max: '2', step: '0.01' })).toBe('0.7');
        expect(nextNumber('', { min: '5', max: '9' })).toBe('5');
        expect(nextNumber('3', { min: '3', max: '3', step: '1' })).toBeNull();
        expect(nextNumber('7', {})).toBe('8');
    });

    test('a step of "any" is one unit, and a step of zero is too', () => {
        expect(nextNumber('7', { step: 'any' })).toBe('8');
        expect(nextNumber('7', { step: '0' })).toBe('8');
        expect(nextNumber('1', { min: '0', max: '1', step: 'any' })).toBe('0');
    });

    test('sameValue compares numbers as numbers, and everything else as it is', () => {
        expect(sameValue('number', '1', '1.00')).toBe(true);
        expect(sameValue('range', '0.5', '0.50')).toBe(true);
        expect(sameValue('number', '1', '2')).toBe(false);
        expect(sameValue('number', '', '0')).toBe(false);
        expect(sameValue('text', '1', '1.00')).toBe(false);
        expect(sameValue('switch', true, true)).toBe(true);
    });
});

describe('textCandidates', () => {
    test('a plain change comes first, and an empty field gets a word', () => {
        expect(textCandidates('abc')).toEqual(['abc~']);
        expect(textCandidates('')).toEqual(['sb-inventory']);
        expect(textCandidates(null)).toEqual(['sb-inventory']);
    });

    test('a field that takes a time is given a time one minute later', () => {
        expect(textCandidates('22:00', { placeholder: 'HH:MM' })).toEqual(['22:00~', '22:01']);
        expect(textCandidates('23:59')[1]).toBe('00:00');
        expect(textCandidates('', { placeholder: 'HH:MM' })[1]).toBe('22:01');
        expect(textCandidates('', { type: 'time' })[1]).toBe('22:01');
    });

    test('a field that takes JSON is given JSON, and a field that takes a URL a URL', () => {
        expect(textCandidates('', { id: 'tabby_json_schema' })).toEqual(['sb-inventory', '{"sb_inventory":1}']);
        expect(textCandidates('{"a":1}')[1]).toBe('{"a":1,"sb_inventory":1}');
        expect(textCandidates('[1]')[1]).toBe('[1,"sb-inventory"]');
        expect(textCandidates('{broken')[1]).toBe('{"sb_inventory":1}');
        expect(textCandidates('', { id: 'bpt-animated-bg-url' })[1]).toBe('https://sb-inventory.invalid/');
    });
});
