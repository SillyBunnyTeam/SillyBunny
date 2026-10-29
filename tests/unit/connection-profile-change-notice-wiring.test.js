import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const normalizeSource = source => source.replace(/\r\n/g, '\n');
const source = normalizeSource(readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'connection-manager', 'index.js'), 'utf8'));
const read = name => normalizeSource(readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'connection-manager', name), 'utf8'));

const listenerStart = source.indexOf('profiles.addEventListener(\'change\', async function () {');
const listenerEnd = source.indexOf('const reloadButton = document.getElementById(\'reload_connection_profile\');');
const listener = source.slice(listenerStart, listenerEnd);

function getFunctionSourceFrom(source, name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);

    expect(start).toBeGreaterThanOrEqual(0);

    const bodyStart = source.indexOf('{', start);
    let depth = 0;

    for (let index = bodyStart; index < source.length; index++) {
        const char = source[index];
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return source.slice(start, index + 1);
            }
        }
    }

    throw new Error(`Unable to find function source for ${name}`);
}

function getFunctionSource(name) {
    return getFunctionSourceFrom(source, name);
}

describe('profile change notice wiring', () => {
    test('imports the notice module on its own line', () => {
        expect(source).toContain('import { abandonProfileSwitchReport, beginProfileSwitchReport, clearProfileSwitchOrigin, finishProfileSwitchReport, initProfileChangeNotice, markScriptedProfileSwitch, refreshProfileSetsLine, takeProfileSwitchStart } from \'./profile-change-notice.js\';');
    });
    test('reads the switch origin before the first await and reports around the apply', () => {
        const origin = listener.indexOf('const sbSwitchStart = takeProfileSwitchStart(); // SillyBunny:');
        const firstAwait = listener.indexOf('await ');
        const missing = listener.indexOf('if (!profile) {');
        const begin = listener.indexOf('const sbReport = beginProfileSwitchReport({ profile, applySequence, ...sbSwitchStart }); // SillyBunny:');
        const apply = listener.indexOf('await applyConnectionProfile(profile);');
        const loaded = listener.indexOf('await eventSource.emit(event_types.CONNECTION_PROFILE_LOADED, profile.name);');
        const finish = listener.indexOf('void finishProfileSwitchReport(sbReport, () => applySequence === profileApplySequence); // SillyBunny:');
        expect(origin).toBeGreaterThanOrEqual(0);
        expect(origin).toBeLessThan(firstAwait);
        expect(begin).toBeGreaterThan(missing);
        expect(begin).toBeLessThan(apply);
        expect(listener.slice(begin, apply)).not.toContain('await ');
        expect(finish).toBeGreaterThan(loaded);
    });
    test('the listener abandons the report when the apply fails', () => {
        const catchStart = listener.indexOf('} catch (error) {');
        const abandon = listener.indexOf('abandonProfileSwitchReport(sbReport); // SillyBunny:');
        const abortCheck = listener.indexOf('if (!isProfileApplicationAbort(error)) {', catchStart);
        const failure = listener.indexOf('console.error(\'Failed to apply connection profile\', error);');
        const catchReturn = listener.indexOf('return;', catchStart);
        expect(catchStart).toBeGreaterThan(0);
        expect(abandon).toBeGreaterThan(catchStart);
        expect(abandon).toBeLessThan(abortCheck);
        expect(abandon).toBeLessThan(catchReturn);
        expect(failure).toBeGreaterThan(catchStart);
        expect(failure).toBeLessThan(catchReturn);
    });
    test('Reload captures its sequence and reports as a user switch', () => {
        const reload = source.slice(source.indexOf('const reloadButton = document.getElementById(\'reload_connection_profile\');'), source.indexOf('toastr.success(\'Connection profile reloaded\''));
        expect(reload).toContain('const applySequence = ++profileApplySequence;');
        expect(reload).toContain('const sbReport = beginProfileSwitchReport({ profile, applySequence, origin: \'user\', notify: true, previousProfileId: profile.id }); // SillyBunny:');
        expect(source.slice(source.indexOf('toastr.success(\'Connection profile reloaded\''), source.indexOf('toastr.success(\'Connection profile reloaded\'') + 400)).toContain('void finishProfileSwitchReport(sbReport, () => applySequence === profileApplySequence); // SillyBunny:');
    });
    test('Reload abandons the report when the apply fails', () => {
        const reload = source.slice(source.indexOf('const reloadButton = document.getElementById(\'reload_connection_profile\');'), source.indexOf('toastr.success(\'Connection profile reloaded\''));
        const catchStart = reload.indexOf('} catch (error) {');
        const abandon = reload.indexOf('abandonProfileSwitchReport(sbReport); // SillyBunny:');
        const abortCheck = reload.indexOf('if (!isProfileApplicationAbort(error)) {', catchStart);
        const failure = reload.indexOf('console.error(\'Failed to reload connection profile\', error);');
        expect(catchStart).toBeGreaterThan(0);
        expect(abandon).toBeGreaterThan(catchStart);
        expect(abandon).toBeLessThan(abortCheck);
        expect(abandon).toBeLessThan(failure);
    });
    test('/profile gains quiet and marks scripted switches around its dispatch', () => {
        const command = source.slice(source.indexOf('name: \'profile\','), source.indexOf('name: \'profile-list\','));
        expect(command).toContain('name: \'quiet\',');
        const quietStart = command.indexOf('name: \'quiet\',');
        const quiet = command.slice(quietStart, command.indexOf('}),', quietStart));
        expect(quietStart).toBeGreaterThanOrEqual(0);
        expect(quiet).toContain('description: t`Suppress toast message notifications.`,');
        expect(quiet).toContain('defaultValue: \'true\',');
        expect(quiet).toContain('typeList: [ARGUMENT_TYPE.BOOLEAN],');
        expect(quiet).toContain('enumList: commonEnumProviders.boolean(\'trueFalse\')(),');
        const mark = command.indexOf('markScriptedProfileSwitch({ notify: isFalseBoolean(String(args?.quiet)) }); // SillyBunny:');
        const dispatch = command.indexOf('profiles.dispatchEvent(new Event(\'change\'));', command.indexOf('const awaitPromise'));
        const clear = command.indexOf('clearProfileSwitchOrigin(); // SillyBunny:');
        expect(mark).toBeGreaterThan(0);
        expect(mark).toBeLessThan(dispatch);
        expect(clear).toBeGreaterThan(dispatch);
        expect(command.slice(command.indexOf('if (value === NONE) {'), command.indexOf('const profile = findProfileByName(value);'))).not.toContain('SillyBunny');
    });
    test('the card line is in the template and refreshed from the render hooks', () => {
        const settingsHtml = normalizeSource(readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'connection-manager', 'settings.html'), 'utf8'));
        const actionsEnd = settingsHtml.lastIndexOf('</div>', settingsHtml.indexOf('<div id="connection_profile_details_content"'));
        expect(settingsHtml).toContain('aria-describedby="sb-connection-profile-sets"');
        expect(settingsHtml.indexOf('<p id="sb-connection-profile-sets" class="sb-connection-profile-sets" hidden></p>')).toBeGreaterThan(settingsHtml.indexOf('<div class="connection-profile-actions"'));
        expect(settingsHtml.indexOf('<p id="sb-connection-profile-sets"')).toBeLessThan(actionsEnd);
        expect(source).toContain('initProfileChangeNotice({ ccCommands: CC_COMMANDS, tcCommands: TC_COMMANDS, allowEmpty: ALLOW_EMPTY, fancyNames: FANCY_NAMES }); // SillyBunny:');
        const render = getFunctionSource('renderDetailsContent');
        expect(render).toContain('refreshProfileSetsLine(); // SillyBunny:');
        expect(render.indexOf('refreshProfileSetsLine(); // SillyBunny:')).toBeLessThan(render.indexOf('detailsContent.innerHTML = \'\';'));
    });
    test('View, Create and Edit are keyed by command id', () => {
        const view = read('view.html'); const create = read('profile.html'); const edit = read('edit.html');
        expect(view).toContain('{{#each applied}}');
        expect(view).toContain('<strong data-sb-profile-copy="true">{{snapshotHeading}}</strong>');
        expect(view).toContain('{{#each snapshot}}');
        expect(create).toContain('<input type="checkbox" value="{{id}}" name="exclude" checked>');
        expect(edit).toContain('<input type="checkbox" value="{{id}}" name="exclude"{{#if checked}} checked{{/if}}>');
        expect(source).not.toContain('Object.entries(FANCY_NAMES).find(x => x[1] ===');
        expect(source).not.toContain('function makeFancyProfile(');
        expect(getFunctionSource('buildProfileDetailsContent')).toContain('FANCY_NAMES[e] ?? PROFILE_SNAPSHOT_NAMES[e] ?? e');
    });
    test('View shows a template snapshot row for every profile that is not CC', () => {
        expect(getFunctionSource('buildProfileDetailsContent')).toContain('.filter(id => !pairedCommands[id] || (profile.mode !== \'cc\' && !appliedIds.has(pairedCommands[id])))');
    });
    test('Edit keeps the exclude entries it did not render and deletes only the unchecked ids', () => {
        const editStart = source.indexOf('const editButton = document.getElementById(\'edit_connection_profile\');');
        const editEnd = source.indexOf('async function showProfileDetails()');
        expect(editStart).toBeGreaterThanOrEqual(0);
        expect(editEnd).toBeGreaterThan(editStart);
        const edit = source.slice(editStart, editEnd);
        expect(edit).toContain('const newExcludeList = [...profile.exclude.filter(e => !renderedIds.has(e)), ...uncheckedIds];');
        expect(edit).toContain([
            '            profile.exclude = newExcludeList;',
            '            for (const command of uncheckedIds) { // SillyBunny: only the ids unchecked here lose their value, never carried-over entries.',
            '                delete profile[command];',
            '            }',
        ].join('\n'));
        expect(edit).not.toContain('for (const command of newExcludeList)');
    });
    test('imports the model module on its own line directly after the notice import', () => {
        const lines = source.split('\n');
        const notice = lines.findIndex(line => line.endsWith('from \'./profile-change-notice.js\';'));
        expect(notice).toBeGreaterThan(0);
        expect(lines[notice + 1]).toBe('import { PROFILE_SNAPSHOT_NAMES, PROFILE_SWITCH_COPY, getAppliedCommands, getProfileCommandList } from \'./profile-change-model.js\';');
    });
});
