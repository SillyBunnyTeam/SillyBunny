/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions and static HTML template contracts. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { importConnectionManagerModule } from '../util/connection-manager-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const normalizeSource = source => source.replace(/\r\n/g, '\n');
const readTemplate = name => normalizeSource(readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'connection-manager', name), 'utf8'));

async function settle() {
    await new Promise(resolve => setTimeout(resolve, 0));
}

afterEach(() => {
    jest.restoreAllMocks();
    document.body.replaceChildren();
});

describe('profile change notice wiring', () => {
    test('reads switch origin before the first await and reports begin/finish around profile apply', async () => {
        const timeline = [];
        const profile = { id: 'p1', name: 'Profile One', mode: 'cc', api: 'openai', model: 'gpt-4o', exclude: [] };
        const { eventSource, event_types, mocks } = await importConnectionManagerModule({
            extension_settings: {
                connectionManager: { selectedProfile: '', profiles: [profile], folders: [], favorites: [] },
            },
            notice: {
                takeProfileSwitchStart: jest.fn(() => {
                    timeline.push('takeStart');
                    return { origin: 'user', notify: true, previousProfileId: '' };
                }),
                beginProfileSwitchReport: jest.fn(payload => {
                    timeline.push('beginReport');
                    return { ...payload, id: 'rep-1' };
                }),
                finishProfileSwitchReport: jest.fn(async (report, isCurrent) => {
                    timeline.push(`finishReport:${isCurrent()}`);
                }),
            },
            commands: {
                api: async (_a, v) => { timeline.push(`apply:api:${v}`); return v; },
                model: async (_a, v) => { timeline.push(`apply:model:${v}`); return v; },
            },
        });
        eventSource.on(event_types.CONNECTION_PROFILE_LOADED, name => {
            timeline.push(`event:loaded:${name}`);
        });

        const select = document.getElementById('connection_profiles');
        select.value = 'p1';
        select.dispatchEvent(new Event('change'));
        // Origin must be captured synchronously before any await.
        expect(timeline[0]).toBe('takeStart');

        await settle();

        const beginIndex = timeline.indexOf('beginReport');
        const firstApplyIndex = timeline.indexOf('apply:api:openai');
        expect(beginIndex).toBeGreaterThan(0);
        expect(firstApplyIndex).toBe(beginIndex + 1);
        expect(timeline.indexOf('event:loaded:Profile One')).toBeGreaterThan(timeline.indexOf('apply:model:gpt-4o'));
        expect(timeline.indexOf('finishReport:true')).toBeGreaterThan(timeline.indexOf('event:loaded:Profile One'));
        expect(mocks.notice.beginProfileSwitchReport).toHaveBeenCalledWith(expect.objectContaining({
            profile,
            origin: 'user',
            notify: true,
        }));
    });

    test('abandons the report when applying a profile fails (e.g. aborted by a newer switch)', async () => {
        let rejectFirstApi;
        const firstPending = new Promise((_resolve, reject) => { rejectFirstApi = reject; });
        const profiles = [
            { id: 'p1', name: 'First', mode: 'cc', api: 'openai', exclude: [] },
            { id: 'p2', name: 'Second', mode: 'cc', api: 'claude', exclude: [] },
        ];
        const { mocks } = await importConnectionManagerModule({
            extension_settings: {
                connectionManager: { selectedProfile: '', profiles, folders: [], favorites: [] },
            },
            commands: {
                api: async (_a, value) => (value === 'openai' ? firstPending : value),
            },
        });

        const select = document.getElementById('connection_profiles');
        select.value = 'p1';
        select.dispatchEvent(new Event('change'));
        await Promise.resolve();

        // Trigger a second switch before the first finishes so the first apply aborts and abandons its report.
        select.value = 'p2';
        select.dispatchEvent(new Event('change'));
        rejectFirstApi(new Error('aborted'));
        await settle();

        expect(mocks.notice.abandonProfileSwitchReport).toHaveBeenCalledTimes(1);
        expect(mocks.notice.finishProfileSwitchReport).toHaveBeenCalledTimes(1);
    });

    test('Reload reports as a user switch with previousProfileId and abandons when reload fails', async () => {
        const profile = { id: 'p1', name: 'Reloadable', mode: 'cc', api: 'openai', exclude: [] };
        const { mocks } = await importConnectionManagerModule({
            extension_settings: {
                connectionManager: { selectedProfile: 'p1', profiles: [profile], folders: [], favorites: [] },
            },
            commands: {
                api: async (_a, value) => value,
            },
        });

        document.getElementById('reload_connection_profile').click();
        await settle();

        expect(mocks.notice.beginProfileSwitchReport).toHaveBeenCalledWith(expect.objectContaining({
            profile,
            origin: 'user',
            notify: true,
            previousProfileId: 'p1',
        }));
        expect(mocks.notice.finishProfileSwitchReport).toHaveBeenCalledTimes(1);
        expect(mocks.toastr.success).toHaveBeenCalledWith('Connection profile reloaded', '', { timeOut: 1500 });

        // A superseded reload abandons the first report.
        let finishFirst;
        const firstBlocked = new Promise(resolve => { finishFirst = resolve; });
        mocks.notice.abandonProfileSwitchReport.mockClear();
        const { mocks: abortMocks } = await importConnectionManagerModule({
            extension_settings: {
                connectionManager: { selectedProfile: 'p1', profiles: [profile], folders: [], favorites: [] },
            },
            commands: {
                api: async () => firstBlocked,
            },
        });
        document.getElementById('reload_connection_profile').click();
        await Promise.resolve();
        document.getElementById('reload_connection_profile').click();
        finishFirst('openai');
        await settle();

        expect(abortMocks.notice.abandonProfileSwitchReport).toHaveBeenCalledTimes(1);
    });

    test('/profile registers quiet boolean arg and marks scripted switches around its dispatch', async () => {
        const order = [];
        const profile = { id: 'p1', name: 'Scripted', mode: 'cc', api: 'openai', exclude: [] };
        const { addedCommands, mocks } = await importConnectionManagerModule({
            extension_settings: {
                connectionManager: { selectedProfile: '', profiles: [profile], folders: [], favorites: [] },
            },
            notice: {
                markScriptedProfileSwitch: jest.fn(opts => order.push(`mark:${opts.notify}`)),
                takeProfileSwitchStart: jest.fn(() => {
                    order.push('take');
                    return { origin: 'script', notify: false, previousProfileId: '' };
                }),
                clearProfileSwitchOrigin: jest.fn(() => order.push('clear')),
            },
            commands: { api: async (_a, v) => v },
        });

        const profileCmd = addedCommands.get('profile');
        expect(profileCmd).toBeDefined();
        const quietArg = profileCmd.namedArgumentList.find(arg => arg.name === 'quiet');
        expect(quietArg).toMatchObject({
            name: 'quiet',
            defaultValue: 'true',
            typeList: ['boolean'],
        });
        expect(quietArg.description).toContain('Suppress toast message notifications.');

        // Default quiet=true marks scripted switch with notify: false and clears origin after dispatch.
        await profileCmd.callback({ await: 'true', quiet: 'true' }, 'Scripted');
        expect(order).toEqual(['mark:false', 'take', 'clear']);

        // Explicit quiet=false marks scripted switch with notify: true.
        order.length = 0;
        mocks.notice.markScriptedProfileSwitch.mockClear();
        document.getElementById('connection_profiles').value = '';
        await profileCmd.callback({ await: 'true', quiet: 'false' }, 'Scripted');
        expect(order).toEqual(['mark:true', 'take', 'clear']);

        // Switching to <None> does not invoke markScriptedProfileSwitch.
        mocks.notice.markScriptedProfileSwitch.mockClear();
        await profileCmd.callback({ await: 'true' }, '<None>');
        expect(mocks.notice.markScriptedProfileSwitch).not.toHaveBeenCalled();
    });

    test('the card line is in settings.html and init/renderDetailsContent refresh it', async () => {
        const settingsHtml = readTemplate('settings.html');
        const actionsEnd = settingsHtml.lastIndexOf('</div>', settingsHtml.indexOf('<div id="connection_profile_details_content"'));
        expect(settingsHtml).toContain('aria-describedby="sb-connection-profile-sets"');
        expect(settingsHtml.indexOf('<p id="sb-connection-profile-sets" class="sb-connection-profile-sets" hidden></p>')).toBeGreaterThan(settingsHtml.indexOf('<div class="connection-profile-actions"'));
        expect(settingsHtml.indexOf('<p id="sb-connection-profile-sets"')).toBeLessThan(actionsEnd);

        const profile = { id: 'p1', name: 'Profile One', mode: 'cc', api: 'openai', exclude: [] };
        const { mocks } = await importConnectionManagerModule({
            extension_settings: {
                connectionManager: { selectedProfile: 'p1', profiles: [profile], folders: [], favorites: [] },
            },
        });

        expect(mocks.notice.initProfileChangeNotice).toHaveBeenCalledWith(expect.objectContaining({
            ccCommands: expect.any(Array),
            tcCommands: expect.any(Array),
            allowEmpty: expect.any(Array),
            fancyNames: expect.any(Object),
        }));

        // Updating the profile invokes renderDetailsContent, which refreshes the card line before clearing detailsContent.
        const select = document.getElementById('connection_profiles');
        select.value = 'p1';
        select.dispatchEvent(new Event('change'));
        await settle();
        expect(mocks.notice.refreshProfileSetsLine).toHaveBeenCalled();
    });

    test('View, Create and Edit templates are keyed by command id and View shows template snapshots only for non-CC profiles', async () => {
        const view = readTemplate('view.html');
        const create = readTemplate('profile.html');
        const edit = readTemplate('edit.html');
        expect(view).toContain('{{#each applied}}');
        expect(view).toContain('<strong data-sb-profile-copy="true">{{snapshotHeading}}</strong>');
        expect(view).toContain('{{#each snapshot}}');
        expect(create).toContain('<input type="checkbox" value="{{id}}" name="exclude" checked>');
        expect(edit).toContain('<input type="checkbox" value="{{id}}" name="exclude"{{#if checked}} checked{{/if}}>');

        const tcProfile = {
            id: 'tc-1',
            name: 'TC Profile',
            mode: 'tc',
            api: 'ooba',
            'instruct-template': 'Alpaca',
            'context-template': 'Alpaca',
            'system-prompt': 'Neutral',
            exclude: ['tokenizer', 'samplers'],
        };
        const ccProfile = {
            id: 'cc-1',
            name: 'CC Profile',
            mode: 'cc',
            api: 'openai',
            'instruct-template': 'Alpaca',
            'active-agents': ['Scout'],
            exclude: ['secret-id'],
        };

        const { mocks } = await importConnectionManagerModule({
            extension_settings: {
                connectionManager: {
                    selectedProfile: 'tc-1',
                    profiles: [tcProfile, ccProfile],
                    folders: [],
                    favorites: [],
                },
            },
        });

        // View TC profile renders instruct-template snapshot row and resolves omitted labels via FANCY_NAMES / PROFILE_SNAPSHOT_NAMES.
        document.getElementById('view_connection_profile').click();
        await settle();
        const tcViewCall = mocks.renderExtensionTemplateAsync.mock.calls.find(([, name]) => name === 'view');
        expect(tcViewCall[2].snapshot.map(row => row.label)).toContain('Instruct Template');
        expect(tcViewCall[2].omitted).toContain('Tokenizer');
        expect(tcViewCall[2].omitted).toContain('Samplers');

        // View CC profile omits paired template snapshot rows while keeping non-paired snapshot rows like Active Agents.
        mocks.renderExtensionTemplateAsync.mockClear();
        const select = document.getElementById('connection_profiles');
        select.value = 'cc-1';
        select.dispatchEvent(new Event('change'));
        await settle();
        document.getElementById('view_connection_profile').click();
        await settle();
        const ccViewCall = mocks.renderExtensionTemplateAsync.mock.calls.find(([, name]) => name === 'view');
        expect(ccViewCall[2].snapshot.map(row => row.label)).not.toContain('Instruct Template');
        expect(ccViewCall[2].snapshot.map(row => row.label)).toContain('Active Agents');
    });

    test('Edit keeps unrendered exclude entries and deletes only newly unchecked rendered command ids', async () => {
        const profile = {
            id: 'p1',
            name: 'Editable',
            mode: 'cc',
            api: 'openai',
            model: 'gpt-4o',
            preset: 'Default',
            // Carried-over non-CC exclude entry + stored value that is not rendered in CC edit form.
            tokenizer: 'best',
            exclude: ['tokenizer'],
        };
        const { state } = await importConnectionManagerModule({
            extension_settings: {
                connectionManager: { selectedProfile: 'p1', profiles: [profile], folders: [], favorites: [] },
            },
            onPopup: async ({ content }) => {
                // Uncheck only "model" while leaving "api" and "preset" checked.
                content.find('input[name="exclude"][value="model"]').prop('checked', false);
                return 'Editable';
            },
        });

        document.getElementById('edit_connection_profile').click();
        await settle();

        const edited = state.extension_settings.connectionManager.profiles[0];
        // Carried-over unrendered exclude 'tokenizer' and its property remain untouched; newly unchecked 'model' is removed.
        expect(edited.exclude).toContain('tokenizer');
        expect(edited.exclude).toContain('model');
        expect(edited.tokenizer).toBe('best');
        expect(edited).not.toHaveProperty('model');
        expect(edited.preset).toBe('Default');
    });
});
