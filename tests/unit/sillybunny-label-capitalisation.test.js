/* eslint-disable playwright/no-standalone-expect -- Jest source contract test. */
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { checkLabel } from '../helpers/capitalisation.js';
import { fileExists, inventorySwitchNames, isMarked, markupLabels, placeText, readSource, scriptLabels, sourceFiles, translatedKeys, upstreamOriginFiles } from '../helpers/label-reader.js';
import { COPY_RULE_MODULES } from '../helpers/copy-rule-modules.js';

// DESIGN.md, The Capitalisation Rule and the writing-style rules. Every role-tagged label that SillyBunny writes is read from
// the source and checked against the rule of its role. A label in an upstream-origin file counts as SillyBunny-written when a
// `SillyBunny:` marker sits on its line or just above it, and a string that a locale translates is upstream wording whose key
// must not change, so both are skipped by rule. Anything else that must stay goes into the allowlist, with its reason.
const ALLOWLIST = JSON.parse(readFileSync(new URL('../fixtures/label-capitalisation-allowlist.json', import.meta.url), 'utf8'));

// The Agents `ui/` modules have their own test of the writing style (in-chat-agents-ui-copy-rules.test.js).
const AGENTS_UI = 'public/scripts/extensions/in-chat-agents/ui/';
// `sillybunny-copy-rules.test.js` checks the ellipsis of every translated string of its modules.
const ELLIPSIS_CHECKED = new Set(COPY_RULE_MODULES);

function collect() {
    const upstream = upstreamOriginFiles();
    const translated = translatedKeys();
    const counts = { read: 0, translated: 0, upstream: 0, allowlisted: 0, checked: 0, switchRows: 0, unplaced: 0, byRole: {} };
    const violations = [];
    const used = new Set();
    const files = sourceFiles();
    const allowed = (file, text, role) => ALLOWLIST.findIndex(each => each.file === file && each.text === text && (!each.role || each.role === role));
    for (const file of files) {
        const source = readSource(file);
        const lines = source.split('\n');
        const labels = file.endsWith('.html') ? markupLabels(source) : scriptLabels(source, file);
        for (const label of labels) {
            counts.read++;
            if (translated.has(label.text)) { counts.translated++; continue; }
            if (upstream.has(file) && !isMarked(lines, label.anchor, label.line)) { counts.upstream++; continue; }
            const entry = allowed(file, label.text, label.role);
            const style = !file.startsWith(AGENTS_UI) && !ELLIPSIS_CHECKED.has(file.replace('public/', ''));
            const result = checkLabel(label.role, label.text, { style });
            counts.checked++;
            counts.byRole[label.role] = (counts.byRole[label.role] ?? 0) + 1;
            if (result.ok) continue;
            if (entry >= 0) { used.add(entry); counts.allowlisted++; continue; }
            violations.push({ ...label, file, ...result });
        }
    }
    // The settings pass draws a check box as a switch row, so the rendered name of every switch is a row title (see `inventorySwitchNames`).
    for (const name of inventorySwitchNames()) {
        if (translated.has(name)) { counts.translated++; continue; }
        const result = checkLabel('row title', name);
        if (result.ok) { counts.switchRows++; continue; }
        const places = placeText(name, files);
        if (!places.length) { counts.unplaced++; continue; }
        const own = places.find(place => place.ownedBySillyBunny);
        if (!own) { counts.upstream++; continue; }
        counts.switchRows++;
        const entry = allowed(own.file, name, 'row title');
        if (entry >= 0) { used.add(entry); counts.allowlisted++; continue; }
        violations.push({ ...own, text: name, role: 'row title', via: 'switch row of the settings inventory', ...result });
    }
    return { counts, violations, stale: ALLOWLIST.filter((_entry, index) => !used.has(index)) };
}

describe('the source reader', () => {
    test('reads the keys of row, dialog, menu and status page factories by their role', () => {
        const source = `
            createSwitchRow({ label: t\`Auto Close\`, subtitle: t\`Close the others\` });
            createCheckRow({ label: 'Keep it' });
            createButtonRow({ label: 'Reset' });
            openDialog({ title: t\`Rename Chat\`, responses: [{ id: 'ok', label: t\`Rename\` }] });
            createStatusPage({ title: 'No Results', description: 'Nothing here' });
            openActionMenu({ sections: [{ items: [{ id: 'a', icon: 'x', label: 'Copy Text', onSelect() {} }] }] });
            createEntryRow({ label: 'Name', placeholder: 'Type a name', title: 'Hint' });
            toastr.error('Could not save', 'Save Failed');`;
        expect(scriptLabels(source).map(({ role, text }) => [role, text])).toEqual([
            ['row title', 'Auto Close'], ['row subtitle', 'Close the others'], ['check or radio label', 'Keep it'], ['button', 'Reset'],
            ['heading', 'Rename Chat'], ['dialog response', 'Rename'], ['heading', 'No Results'],
            ['menu item', 'Copy Text'], ['row title', 'Name'], ['placeholder', 'Type a name'], ['tooltip', 'Hint'],
            ['body', 'Could not save'], ['toast title', 'Save Failed'],
        ]);
    });

    test('reads the labels that a helper takes by position, in the file that defines it', () => {
        const source = 'createServerButtonRow(t`Reload file`, field, go); createServerSection(\'Status\', null);';
        expect(scriptLabels(source, 'public/scripts/sillybunny-server-tools.js').map(({ role, text }) => [role, text])).toEqual([['button', 'Reload file'], ['heading', 'Status']]);
        expect(scriptLabels(source, 'public/scripts/other.js')).toEqual([]);
    });

    test('reads attributes in markup strings and assignments, and ignores code and placeholders', () => {
        const source = 'node.title = t`Close it`; el.setAttribute("aria-label", "Open it"); html = `<i title="Go ${x}" class="a-b"></i>`; label: \'sb-class-name\'; node.title = \'lorum ipsum\';';
        expect(scriptLabels(source).map(({ role, text }) => [role, text])).toEqual([['tooltip', 'Close it'], ['accessible name', 'Open it'], ['tooltip', 'Go ${}']]);
    });

    test('reads attributes, headings and buttons of markup', () => {
        const html = '<h3>Mass delete chats</h3><button title="Close it" aria-label="Close">Go on</button><input placeholder="Search here"><button><i class="fa"></i>Icon</button>';
        expect(markupLabels(html).map(({ role, text }) => [role, text])).toEqual([['heading', 'Mass delete chats'], ['tooltip', 'Close it'], ['accessible name', 'Close'], ['button', 'Go on'], ['placeholder', 'Search here']]);
    });

    test('a marker from the line above an element or statement down to the label makes the label SillyBunny-written', () => {
        const lines = ['a', '// SillyBunny: why', 'b', 'c', 'd'];
        expect(isMarked(lines, 3)).toBe(true);
        expect(isMarked(lines, 4)).toBe(false);
        expect(isMarked(lines, 3, 5)).toBe(true);
        expect(isMarked(lines, 4, 5)).toBe(false);
        expect(isMarked(['x // SillyBunny: same line'], 1)).toBe(true);
    });
    test('the anchor of a label is the start of its statement', () => {
        const source = 'a();\n// SillyBunny: why\nopenDialog({\n    title: t`Rename Chat`,\n});';
        const [label] = scriptLabels(source);
        expect([label.line, label.anchor]).toEqual([4, 3]);
        expect(isMarked(source.split('\n'), label.anchor, label.line)).toBe(true);
    });
});

describe('label capitalisation', () => {
    const { counts, violations, stale } = collect();

    test('reads enough labels for the rule to mean something', () => {
        expect(counts.checked).toBeGreaterThan(1200);
        expect(counts.switchRows).toBeGreaterThan(80);
    });

    test('reads every role that the rule names a form for', () => {
        const roles = ['accessible name', 'body', 'button', 'dialog response', 'drop-down item', 'heading', 'menu item', 'placeholder', 'row subtitle', 'row title', 'tab', 'toast title', 'tooltip'];
        expect(roles.filter(role => !counts.byRole[role])).toEqual([]);
    });

    test('every role-tagged SillyBunny label follows the rule', () => {
        const message = violations.map(({ file, line, role, text, via, expected, why }) => `${file}:${line}: ${role} (${via}) ${JSON.stringify(text)} should be ${JSON.stringify(expected)}: ${why}`);
        expect(message).toEqual([]);
    });

    test('the allowlist has an entry for nothing that follows the rule, and a reason for every entry', () => {
        expect(stale.map(({ file, text }) => `${file}: ${JSON.stringify(text)} follows the rule or is gone; delete its entry`)).toEqual([]);
        expect(ALLOWLIST.filter(entry => !entry.file || !entry.text || !entry.reason || !fileExists(entry.file))).toEqual([]);
    });
});
