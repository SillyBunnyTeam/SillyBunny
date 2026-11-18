// Pins the verb list the user approved for the upstream confirms that used to read "Yes", and keeps new ones from
// reading "Yes" again. The scan reads the source, so it covers every call site without booting the pages.
import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const UPSTREAM_ORIGIN = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/upstream-origin-public-files.json'), 'utf8')));
const SKIPPED = /(^|\/)(lib|third-party|quick-image-gen|locales|node_modules)(\/|$)/;

/** Each upstream file's `confirmVerb` labels, sorted; `:destructive` is the red style, `:no` a "No" negative. */
const APPROVED = {
    'public/script.js': ['Delete:destructive', 'Delete:destructive', 'Duplicate', 'Duplicate', 'Rename', 'Save:destructive'],
    'public/scripts/BulkEditOverlay.js': ['Delete:destructive'],
    'public/scripts/RossAscends-mods.js': ['Regenerate'],
    'public/scripts/bookmarks.js': ['Convert to Group'],
    'public/scripts/extensions/assets/index.js': ['Connect'],
    'public/scripts/extensions/connection-manager/index.js': ['Delete:destructive', 'Delete:destructive', 'Delete:destructive'],
    'public/scripts/extensions/expressions/index.js': ['Continue', 'Continue', 'Continue:destructive', 'Delete:destructive', 'Regenerate:destructive', 'Remove', 'Remove:destructive'],
    'public/scripts/extensions/gallery/index.js': ['Delete:destructive'],
    'public/scripts/extensions/quick-reply/src/QuickReply.js': ['Remove:destructive'],
    'public/scripts/extensions/quick-reply/src/ui/SettingsUi.js': ['Delete:destructive', 'Overwrite:destructive', 'Overwrite:destructive'],
    'public/scripts/extensions/regex/index.js': ['Allow:no', 'Allow:no', 'Delete:destructive', 'Delete:destructive', 'Move', 'Move', 'Move'],
    'public/scripts/extensions/translate/index.js': ['Remove:destructive'],
    'public/scripts/extensions/tts/volcengine.js': ['Delete:destructive'],
    'public/scripts/extensions.js': ['Continue:destructive', 'Delete:destructive', 'Delete:destructive', 'Move'],
    'public/scripts/macros/engine/MacroDiagnostics.js': ['Enable:no'],
    'public/scripts/openai.js': ['Connect', 'Delete:destructive', 'Delete:destructive', 'Overwrite:destructive', 'Remove:no'],
    'public/scripts/personas.js': ['Apply', 'Apply:no', 'Confirm', 'Create', 'Delete:destructive', 'Duplicate', 'Overwrite:destructive', 'Remove'],
    'public/scripts/power-user.js': ['Delete:destructive', 'Import'],
    'public/scripts/preset-manager.js': ['Delete:destructive', 'Delete:destructive', 'Restore', 'Restore:destructive', 'Restore:destructive', 'Save'],
    'public/scripts/secrets.js': ['Add', 'Authorize'],
    'public/scripts/slash-commands.js': ['Delete:destructive'],
    'public/scripts/sysprompt.js': ['Import:no'],
    'public/scripts/tags.js': ['Remove:destructive'],
    'public/scripts/utils.js': ['Overwrite:destructive'],
    'public/scripts/welcome-screen.js': ['Delete:destructive', 'Delete:destructive', 'Delete:destructive'],
    'public/scripts/world-info.js': ['Continue:no', 'Delete:destructive', 'Delete:destructive'],
};

/** Confirms of upstream-origin files that show no "Yes" although they set no `okButton`. */
const NO_YES_ALLOWLIST = [
    // The OK button is hidden with `style.display`; the Move and Copy responses are custom buttons.
    { file: 'public/scripts/world-info.js', firstArgument: 'container' },
];

function readSource(file) {
    return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function extractVerbs(file) {
    const source = readSource(file);
    const lines = source.split('\n');
    const verbs = [];
    for (const match of source.matchAll(/confirmVerb\(t`([^`]+)`(?:,\s*\{([^}]*)\})?\)/g)) {
        const line = source.slice(0, match.index).split('\n').length - 1;
        const nearby = lines.slice(Math.max(0, line - 3), line + 1).join('\n');
        expect(nearby).toContain('SillyBunny:');
        const flags = match[2] ?? '';
        verbs.push(match[1] + (flags.includes('destructive: true') ? ':destructive' : '') + (flags.includes('negative: t`No`') ? ':no' : ''));
    }
    return verbs.sort();
}

function listFiles(directory) {
    const found = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        const relative = path.relative(ROOT, full);
        if (SKIPPED.test(relative)) continue;
        if (entry.isDirectory()) found.push(...listFiles(full));
        else if (/\.js$/.test(entry.name)) found.push(relative);
    }
    return found;
}

function walk(node, visit) {
    if (!node || typeof node.type !== 'string') return;
    visit(node);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(child => walk(child, visit));
        else if (value && typeof value.type === 'string') walk(value, visit);
    }
}

/** Calls that create a CONFIRM popup and set neither a literal `okButton` nor a `confirmVerb` spread. */
function findUnlabelledConfirms(file) {
    const source = readSource(file);
    let ast;
    try {
        ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
    } catch {
        ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
    }
    const unlabelled = [];
    walk(ast, node => {
        if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return;
        const callee = source.slice(node.callee.start, node.callee.end);
        let optionsIndex;
        let isConfirm;
        if (/(^|\.)callGenericPopup$/.test(callee) || (node.type === 'NewExpression' && callee === 'Popup')) {
            optionsIndex = 3;
            const type = node.arguments[1] ? source.slice(node.arguments[1].start, node.arguments[1].end) : '';
            isConfirm = /POPUP_TYPE\.CONFIRM$|^'confirm'$/.test(type);
        } else if (/(^|\.)Popup\.show\.confirm$/.test(callee)) {
            optionsIndex = 2;
            isConfirm = true;
        } else return;
        if (!isConfirm) return;
        const options = node.arguments[optionsIndex];
        const text = options ? source.slice(options.start, options.end) : '';
        if (options && options.type !== 'ObjectExpression') return;
        if (/\bokButton\b|confirmVerb\(/.test(text)) return;
        const firstArgument = node.arguments[0] ? source.slice(node.arguments[0].start, node.arguments[0].end) : '';
        unlabelled.push({ file, firstArgument, line: source.slice(0, node.start).split('\n').length });
    });
    return unlabelled;
}

describe('approved confirm verbs', () => {
    test.each(Object.entries(APPROVED))('%s names its confirms with the approved verbs', (file, expected) => {
        expect(extractVerbs(file)).toEqual([...expected].sort());
    });

    test('the table covers 72 confirms', () => {
        expect(Object.values(APPROVED).flat()).toHaveLength(72);
    });

    test('the seven negatives that are not a cancel keep "No"', () => {
        const withNo = Object.entries(APPROVED).flatMap(([file, verbs]) => verbs.filter(verb => verb.endsWith(':no')).map(verb => `${path.basename(file)} ${verb}`));
        expect(withNo.sort()).toEqual([
            'MacroDiagnostics.js Enable:no', 'index.js Allow:no', 'index.js Allow:no', 'openai.js Remove:no',
            'personas.js Apply:no', 'sysprompt.js Import:no', 'world-info.js Continue:no',
        ]);
    });
});

describe('upstream confirms read no "Yes"', () => {
    test('every CONFIRM call in an upstream-origin file sets its response', () => {
        const unlabelled = listFiles(path.join(ROOT, 'public'))
            .filter(file => UPSTREAM_ORIGIN.has(file))
            .flatMap(findUnlabelledConfirms)
            .filter(site => !NO_YES_ALLOWLIST.some(allowed => allowed.file === site.file && allowed.firstArgument === site.firstArgument));
        expect(unlabelled).toEqual([]);
    });
});

describe('templates that used to name the "Yes" button', () => {
    test('the theme import warning asks the question and no longer names a button', () => {
        const html = readSource('public/scripts/templates/themeImportWarning.html');
        expect(html).toContain('<h3>\n    Import Theme?\n</h3>');
        expect(html).toContain('Its Custom CSS has @import lines, which load more styles from other files or websites when the theme is applied.');
        expect(html.replace(/<!--[\s\S]*?-->/g, '')).not.toMatch(/Yes|Press/);
        expect(html).toContain('<!-- SillyBunny:');
    });

    test('the system prompt migration names the template and drops the button explanations', () => {
        const html = readSource('public/scripts/templates/migrateInstructPrompt.html');
        expect(html).toContain('Import the Template’s System Prompt?');
        expect(html).toContain('This instruct template also contains a system prompt. Importing saves it as “[Migrated] {{name}}” and selects it. Otherwise it is left out, and your current system prompt stays.');
        expect(html).toContain('{{#if existing}}');
        expect(html).toContain('<textarea class="wide100p textarea_compact" rows="10">{{prompt}}</textarea>');
        expect(html.replace(/<!--[\s\S]*?-->/g, '')).not.toMatch(/"Yes"|"No"/);
        expect(html).toContain('<!-- SillyBunny:');
        expect(readSource('public/scripts/sysprompt.js')).toContain('renderTemplateAsync(\'migrateInstructPrompt\', { prompt: template.system_prompt, existing: existingName, name })');
    });
});
