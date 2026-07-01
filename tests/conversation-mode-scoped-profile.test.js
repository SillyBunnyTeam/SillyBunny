import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const conversationDir = path.join(repoRoot, 'public', 'scripts', 'sillybunny-conversation');
const normalizeSource = source => source.replace(/\r\n/g, '\n');

function readConversationSource(file) {
    return normalizeSource(readFileSync(path.join(conversationDir, file), 'utf8'));
}

function getFunctionSource(source, name) {
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

const generationSource = readConversationSource('generation.js');
const attachmentsSource = readConversationSource('attachments.js');
const personasSource = readConversationSource('personas.js');
const chromeSource = readConversationSource('chrome.js');
const contextSource = readConversationSource('context.js');
const initSource = readConversationSource('init.js');
const mediaSource = readConversationSource('media.js');
const palsRailSource = readConversationSource('pals-rail.js');
const pickersSource = readConversationSource('pickers.js');
const promptSource = readConversationSource('prompt.js');
const renderUtilsSource = readConversationSource('render-utils.js');
const settingsStoreSource = readConversationSource('settings-store.js');
const stateSource = readConversationSource('state.js');
const threadStoreSource = readConversationSource('thread-store.js');
const timelineSource = readConversationSource('timeline-render.js');
const timelineSlashSource = readConversationSource('timeline-slash-commands.js');
const conversationTtsSource = readConversationSource('tts.js');
const extensionTtsSource = normalizeSource(readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'tts', 'index.js'), 'utf8'));
const serverStartupSource = normalizeSource(readFileSync(path.join(repoRoot, 'src', 'server-startup.js'), 'utf8'));
const welcomeSource = normalizeSource(readFileSync(path.join(repoRoot, 'public', 'scripts', 'welcome-screen.js'), 'utf8'));

describe('conversation mode scoped connection profile', () => {
    test('removes the global profile switch wrapper and slash-command helpers', () => {
        expect(personasSource).not.toContain('withConversationConnectionProfile');
        expect(personasSource).not.toContain('applyConnectionProfileByName');
        expect(personasSource).not.toContain('queueConversationProfileSwitch');
        expect(personasSource).not.toContain('quoteSlashArg');
        // The old path ran the `/profile` slash command to flip the global profile.
        expect(personasSource).not.toContain('getSelectedConnectionProfileName');
        expect(personasSource).not.toContain('/profile ');
    });

    test('drops the now-unused selected-profile name reader and switch queue', () => {
        expect(chromeSource).not.toContain('getSelectedConnectionProfileName');
        expect(stateSource).not.toContain('conversationProfileSwitchQueue');
    });

    test('exposes a scoped generateConversationRaw helper that never switches the global profile', () => {
        const helperSource = getFunctionSource(generationSource, 'generateConversationRaw');

        // Resolves the configured profile by name and routes through the scoped
        // ConnectionManagerRequestService instead of touching the global profile.
        expect(helperSource).toContain('getConnectionProfiles');
        expect(helperSource).toContain('ConnectionManagerRequestService');
        expect(helperSource).toContain('CMRS.sendRequest');
        expect(helperSource).toContain('extractData: true');
        expect(helperSource).toContain('includePreset: true');
        // It must not run the `/profile` slash command or mutate global state.
        expect(helperSource).not.toContain('/profile ');
        expect(helperSource).not.toContain('applyConnectionProfileByName');
        // Falls back to generateRaw (the active profile) when scoped path is unavailable.
        expect(helperSource).toContain('generateRaw(options)');
    });

    test('replaces every generation call site with the scoped helper', () => {
        const consumers = ['generation.js', 'interface.js', 'prompt.js', 'schedule.js', 'timeline-render.js'];
        for (const file of consumers) {
            const source = readConversationSource(file);
            expect(source).toContain('generateConversationRaw');
            expect(source).not.toContain('withConversationConnectionProfile');
        }
    });

    test('keeps Conversation DM selection decoupled from roleplay chats and groups', () => {
        expect(chromeSource).not.toContain('selectCharacterById');
        expect(chromeSource).not.toContain('openGroupById');
        expect(pickersSource).not.toContain('/api/groups/create');
        expect(initSource).not.toContain('syncConversationWorkspaceToRoleplaySelection');
        expect(initSource).not.toContain('isAvatarInConversationGroup');
    });

    test('routes explicitly prefixed group replies to the named participant', () => {
        expect(generationSource).toContain('getSpeakerPrefixMatch');
        expect(generationSource).toContain('resolveConversationReplySpeaker');
        expect(generationSource).toContain('resolvedExtra.partner_avatar = speakerAvatar');
    });

    test('adds context-aware implicit references for group DMs', () => {
        expect(promptSource).toContain('buildConversationGroupReferenceContext');
        expect(promptSource).toContain('conversation-group-reference-context');
        expect(promptSource).toContain('last non-user speaker before it');
        expect(promptSource).toContain('do not assume every you means');
        expect(generationSource).toContain('buildConversationPromptMessages(messages, directive, speakerName, { groupId })');
        expect(attachmentsSource).toContain('getImplicitGroupReplyCandidate');
        expect(attachmentsSource).toContain('isBroadGroupAddress');
    });

    test('adds device date time and timezone context to Conversation prompts', () => {
        expect(promptSource).toContain('getConversationLocalTimeContext');
        expect(promptSource).toContain('Current device time context');
        expect(promptSource).toContain('Intl.DateTimeFormat().resolvedOptions().timeZone');
        expect(promptSource).toContain('weekday: \'long\'');
        expect(promptSource).toContain('computer/phone time');
        expect(promptSource).toContain('getCurrentActivityFromSchedule(schedule, avatar, now)');
    });

    test('keeps saved Conversation-owned group DMs visible without messages', () => {
        expect(settingsStoreSource).toContain('const hasConversationGroups');
        expect(settingsStoreSource).toContain('getConversationGroups().forEach');
        expect(settingsStoreSource).toContain('!group.is_conversation_group');
        expect(palsRailSource).toContain('getConversationGroups().forEach');
        expect(palsRailSource).toContain('isEmptyThread && !group?.is_conversation_group');
        expect(settingsStoreSource.indexOf('getConversationGroups().forEach')).toBeLessThan(settingsStoreSource.indexOf('Object.entries(getConversationStore().characters || {}).forEach'));
        expect(palsRailSource.indexOf('getConversationGroups().forEach')).toBeLessThan(palsRailSource.indexOf('Object.entries(getConversationStore().characters || {}).forEach'));
        expect(contextSource).toContain('group.updatedAt = Date.now();');
        expect(timelineSource).toContain('group.updatedAt = Date.now();');
    });

    test('defaults group DM cross-talk settings on without global solo overrides hiding them', () => {
        const groupSettingsIndex = settingsStoreSource.indexOf('if (groupId) {');
        expect(groupSettingsIndex).toBeGreaterThanOrEqual(0);
        expect(settingsStoreSource.indexOf('globalSettings', groupSettingsIndex)).toBeLessThan(settingsStoreSource.indexOf('GROUP_CONVERSATION_FORCED_SETTINGS', groupSettingsIndex));
        expect(settingsStoreSource.indexOf('GROUP_CONVERSATION_FORCED_SETTINGS', groupSettingsIndex)).toBeLessThan(settingsStoreSource.indexOf('getGroupConversationSettings(groupId)', groupSettingsIndex));
    });

    test('scopes Conversation storage by active persona to prevent bleedthrough', () => {
        expect(contextSource).toContain('PERSONA_CONVERSATION_STORE_PREFIX');
        expect(contextSource).toContain('getConversationPersonaId');
        expect(contextSource).toContain('scopeConversationStorageKey');
        expect(contextSource).toContain('isConversationThreadKeyForPersona');
        expect(contextSource).toContain('migrateLegacyConversationStoreToPersona');
        expect(contextSource).toContain('personaId: getConversationPersonaId(personaId)');
        expect(settingsStoreSource).toContain('isConversationThreadKeyForPersona(storeKey)');
        expect(palsRailSource).toContain('isConversationThreadKeyForPersona(storeKey)');
        expect(initSource).toContain('event_types.PERSONA_CHANGED');
    });

    test('uses reply metadata instead of copying quoted text into the composer', () => {
        expect(stateSource).toContain('conversationReplyTarget');
        expect(timelineSource).toContain('renderConversationComposerReplyPreview');
        expect(timelineSource).toContain('conversationReplyTarget = {');
        expect(timelineSource).toContain("!String(reference.messageId || '').trim()");
        expect(timelineSource).not.toContain("reference?.text || reference?.attachmentSummary || 'Message'");
        expect(timelineSource).not.toContain('quoteBlock');
        expect(timelineSource).not.toContain('> **${speakerName}');
        expect(attachmentsSource).toContain('conversation_reply_to');
        expect(promptSource).toContain('formatConversationReplyReference');
    });

    test('lets generated character replies use message reply metadata', () => {
        expect(threadStoreSource).toContain('export function buildConversationMessageReplyReference');
        expect(timelineSource).toContain('buildConversationMessageReplyReference(context.message)');
        expect(generationSource).toContain('getGeneratedReplyReference');
        expect(generationSource).toContain('buildConversationMessageReplyReference(message)');
        expect(generationSource).toContain('resolvedExtra.conversation_reply_to = replyReference');
        expect(generationSource).toContain('attachReplyReference = false');
    });

    test('adds Quick Image Gen actions for actual selfie commands', () => {
        expect(timelineSource).toContain('getConversationSelfieCommandRequests');
        expect(timelineSource).toContain('conversation_commands?.selfieRequests');
        expect(timelineSource).toContain('SELFIE_COMMAND_RE');
        expect(timelineSource).toContain('sb-conversation-selfie-action');
        expect(timelineSource).toContain('force: true');
        expect(timelineSource).toContain('notify: true');
        expect(timelineSlashSource).toContain('force: true, notify: true');
        expect(renderUtilsSource).toContain('compactConversationCommandsFingerprint');
        expect(chromeSource).toContain('generate-selfie-command');
        expect(generationSource).toContain('force = false');
        expect(generationSource).toContain('notify = false');
        expect(generationSource).toContain('!force && (!resolvedSettings.image_gen_enabled');
        expect(mediaSource).toContain('Quick Image Gen failed');
        expect(mediaSource).toContain('../extensions/quick-image-gen/index.js');
    });

    test('suppresses the welcome recent-chat surface while Conversation Mode opens', () => {
        expect(welcomeSource).toContain('setConversationWelcomeOpeningSuppressed(true)');
        expect(welcomeSource).toContain('element.style.visibility = \'hidden\'');
        expect(welcomeSource).toContain('clearConversationWelcomeOpeningSuppressionAfterRender');
        expect(welcomeSource).toContain('requestAnimationFrame(() => requestAnimationFrame(clearSuppression))');
        expect(welcomeSource).toContain('setConversationWelcomeOpeningSuppressed(false)');
    });

    test('exposes Conversation REST discovery on both supported API base paths', () => {
        expect(serverStartupSource).toContain("app.use('/api/sillybunny-conversation', sillyBunnyConversationRouter)");
        expect(serverStartupSource).toContain("app.use('/api/sillybunny/conversation', sillyBunnyConversationRouter)");
    });

    test('connects Conversation messages to the existing TTS extension', () => {
        expect(extensionTtsSource).toContain('export async function narrateTtsMessage');
        expect(extensionTtsSource).toContain('await initVoiceMap(Boolean(unrestrictedVoiceMap))');
        expect(extensionTtsSource).toContain('processAndQueueTtsMessage(message, messageId, { manual: isManual })');
        expect(conversationTtsSource).toContain('../extensions/tts/index.js');
        expect(conversationTtsSource).toContain('narrateTtsMessage(ttsMessage');
        expect(threadStoreSource).toContain('void narrateConversationMessage(message)');
        expect(timelineSource).toContain("action: 'speak-message'");
        expect(timelineSource).toContain('speakConversationMessage');
        expect(chromeSource).toContain("case 'speak-message':");
    });
});
