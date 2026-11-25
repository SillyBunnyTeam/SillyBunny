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
const actionMenuSource = normalizeSource(readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-action-menu.js'), 'utf8'));
const constantsSource = readConversationSource('constants.js');
const initSource = readConversationSource('init.js');
const conversationListSource = readConversationSource('conversation-list.js');
const pickersSource = readConversationSource('pickers.js');
const promptSource = readConversationSource('prompt.js');
const sharedHelpersSource = readConversationSource('shared-helpers.js');
const settingsStoreSource = readConversationSource('settings-store.js');
const stateSource = readConversationSource('state.js');
const conversationStoreSource = readConversationSource('conversation-store.js');
const timelineSource = readConversationSource('timeline-render.js');
const conversationTtsSource = readConversationSource('tts.js');
const extensionTtsSource = normalizeSource(readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'tts', 'index.js'), 'utf8'));
const pollinationsTtsSource = normalizeSource(readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'tts', 'pollinations.js'), 'utf8'));
const speechEndpointSource = normalizeSource(readFileSync(path.join(repoRoot, 'src', 'endpoints', 'speech.js'), 'utf8'));
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
        // The scoped request keeps its own length, or the length of the preset of the profile. Only the request to the active API is limited.
        expect(helperSource).toContain('CMRS.sendRequest(profile.id, messages, profileResponseLength, {');
        expect(helperSource).toContain('options.responseLength > 0 ? options.responseLength : await getProfileResponseLength(profile)');
        expect(helperSource.indexOf('CMRS.sendRequest')).toBeLessThan(helperSource.indexOf('getActiveApiResponseLength(options.responseLength)'));
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
        const replyStepsSource = readConversationSource('reply-steps.js');
        expect(replyStepsSource).toContain('getSpeakerPrefixMatch');
        expect(replyStepsSource).toContain('resolveReplySpeaker');
        expect(generationSource).toContain('buildReplySteps');
        expect(generationSource).toContain('resolvedExtra.member_avatar = speakerAvatar');
    });

    test('adds context-aware implicit references for group DMs', () => {
        expect(promptSource).toContain('buildConversationGroupReferenceContext');
        expect(promptSource).toContain('conversation-group-reference-context');
        expect(sharedHelpersSource).toContain('last non-user speaker before it');
        expect(sharedHelpersSource).toContain('do not assume every you means');
        expect(generationSource).toContain('buildConversationPromptMessages(messages, directive, speakerName, { groupId, personaId, worldInfo })');
        expect(attachmentsSource).toContain('chooseGroupSpeakers');
        expect(readConversationSource('speaker-selection.js')).toContain('isBroadGroupAddress');
    });

    test('adds device date time and timezone context to Conversation prompts', () => {
        expect(promptSource).toContain('getConversationLocalTimeContext');
        expect(promptSource).toContain('Current device time context');
        expect(promptSource).toContain('Intl.DateTimeFormat().resolvedOptions().timeZone');
        expect(promptSource).toContain('weekday: \'long\'');
        expect(promptSource).toContain('computer/phone time');
        expect(promptSource).toContain('getCharacterStatus(avatar, now, { personaId })');
    });

    test('adds compact editable Grounded Dialogue Rules as an optional global prompt block', () => {
        expect(constantsSource).toContain('DEFAULT_GROUNDED_DIALOGUE_RULES');
        expect(constantsSource).toContain('grounded_dialogue_rules_enabled: false');
        expect(constantsSource).toContain('grounded_dialogue_rules_enabled');
        expect(constantsSource).toContain('grounded_dialogue_rules');
        expect(promptSource).toContain('getGroundedDialogueRulesPrompt');
        expect(promptSource).toContain('from \'./shared-helpers.js\'');
        expect(promptSource).toContain('fields.push(groundedRules)');
    });

    test('picker menus pass their trigger, and the composer and the timeline are the markup that the actions read', () => {
        expect(chromeSource).toContain('toggleStartDirectConversationPicker(target)');
        expect(chromeSource).toContain('toggleConversationGroupPicker({ anchor: target })');
        expect(chromeSource).toContain('togglePersonaPicker(target)');
        expect(pickersSource).toContain('preferBelow: true');
        // The rail keeps the order of the list that the server sends, newest message first, and does not move the open row.
        expect(conversationListSource).toContain('conversationData.list({ personaId })');
        expect(conversationListSource).not.toContain('.sort(');
        expect(conversationListSource).not.toContain('first.key === activeKey');
        expect(chromeSource).not.toContain('LAYOUT_MOBILE_QUERY');
        // Attach is a button of its own and the "+" menu holds the other four tools, so the four quick buttons are not in the markup.
        expect(timelineSource).toContain('sb-conversation-composer-attach');
        expect(timelineSource).toContain('data-sb-conversation-action="attach-file"');
        expect(timelineSource).toContain('data-sb-conversation-action="open-composer-menu"');
        expect(timelineSource).not.toContain('sb-conversation-composer-actions');
        expect(timelineSource).not.toContain('data-sb-conversation-action="quick-selfie"');
        expect(timelineSource).toContain('content.append(bubble, actionBar)');
        expect(timelineSource).toContain('item.append(avatarWrap, body, mobileTrigger)');
        expect(timelineSource).not.toContain('bubble.append(actionBar, mobileTrigger)');
        expect(pickersSource).toContain('maxLeft < minLeft');
        expect(actionMenuSource).toContain('maxLeft < minLeft');
        expect(chromeSource).toContain('css/sillybunny-conversation.css?v=20261125e');
    });

    // Behaviour that these three tests used to pin in the source (a group without messages, the forced group settings,
    // the persona scoping) is tested on the real data module in sillybunny-conversation-settings-store.test.js and
    // sillybunny-conversation-core-data-regressions.test.js.
    test('lists the conversations of the persona from the data module, and starts again when the persona changes', () => {
        expect(conversationListSource).toContain('conversationData.list({ personaId })');
        expect(settingsStoreSource).toContain('conversationData.list({ personaId: getConversationPersonaId() })');
        expect(initSource).toContain('event_types.PERSONA_CHANGED');
    });

    test('the settings of a conversation are layered with what is derived on top, and nothing is forced on a group', () => {
        const layers = settingsStoreSource.slice(settingsStoreSource.indexOf('const settings = mergeConversationSettingsLayers('));
        expect(layers.indexOf('globalSettings')).toBeGreaterThanOrEqual(0);
        expect(layers.indexOf('globalSettings')).toBeLessThan(layers.indexOf('getDerivedSettings'));
        expect(settingsStoreSource).not.toContain('FORCED_SETTINGS');
    });

    test('uses reply metadata instead of copying quoted text into the composer', () => {
        expect(stateSource).toContain('conversationReplyTarget');
        expect(timelineSource).toContain('renderConversationComposerReplyPreview');
        expect(timelineSource).toContain('conversationReplyTarget = {');
        expect(timelineSource).toContain('!String(reference.messageId || \'\').trim()');
        expect(timelineSource).not.toContain('reference?.text || reference?.attachmentSummary || \'Message\'');
        expect(timelineSource).not.toContain('quoteBlock');
        expect(timelineSource).not.toContain('> **${speakerName}');
        expect(attachmentsSource).toContain('conversation_reply_to');
    });

    test('does not inline reply references in the Conversation prompt transcript', () => {
        expect(promptSource).not.toContain('formatConversationReplyReference');
        expect(promptSource).not.toContain('(replying to');
    });

    test('lets generated character replies use message reply metadata', () => {
        expect(conversationStoreSource).toContain('export function buildConversationMessageReplyReference');
        expect(timelineSource).toContain('buildConversationMessageReplyReference(context.message)');
        expect(generationSource).toContain('getGeneratedReplyReference');
        expect(generationSource).toContain('buildConversationMessageReplyReference(message)');
        expect(generationSource).toContain('resolvedExtra.conversation_reply_to = replyReference');
        expect(generationSource).toContain('const attachReplyReference = !replyReferenceSpeakers.has(speakerAvatar)');
        expect(generationSource).toContain('replyReferenceSpeakers.add(speakerAvatar)');

        const replyRefFuncStart = generationSource.indexOf('function getGeneratedReplyReference(');
        const nextFuncStart = generationSource.indexOf('function getResolvedReplyExtra(', replyRefFuncStart);
        const replyRefSource = generationSource.slice(replyRefFuncStart, nextFuncStart);
        expect(replyRefSource).toContain('previous message from the same speaker');
        expect(replyRefSource).toContain('break;');
    });

    test('suppresses the welcome recent-chat surface while Conversation Mode opens', () => {
        expect(welcomeSource).toContain('setConversationWelcomeOpeningSuppressed(true)');
        expect(welcomeSource).toContain('element.style.visibility = \'hidden\'');
        expect(welcomeSource).toContain('clearConversationWelcomeOpeningSuppressionAfterRender');
        expect(welcomeSource).toContain('requestAnimationFrame(() => requestAnimationFrame(clearSuppression))');
        expect(welcomeSource).toContain('setConversationWelcomeOpeningSuppressed(false)');
    });

    test('connects Conversation messages to the existing TTS extension', () => {
        expect(extensionTtsSource).toContain('export async function narrateTtsMessage');
        expect(extensionTtsSource).toContain('async function ensureTtsProviderLoaded');
        expect(extensionTtsSource).toContain('await ensureTtsProviderLoaded()');
        expect(extensionTtsSource.indexOf('await ensureTtsProviderLoaded()')).toBeLessThan(extensionTtsSource.indexOf('await initVoiceMap(Boolean(unrestrictedVoiceMap), [speaker])'));
        expect(extensionTtsSource).toContain('await initVoiceMap(Boolean(unrestrictedVoiceMap), [speaker])');
        expect(extensionTtsSource).toContain('await wrapper.update()');
        expect(extensionTtsSource).toContain('await processTtsQueue()');
        expect(extensionTtsSource).toContain('setTimeout(() => void wrapper.update(), 0)');
        expect(extensionTtsSource).toContain('processAndQueueTtsMessage({ ...message, name: speaker }, messageId, { manual: isManual })');
        expect(conversationTtsSource).toContain('getExtensionCapability(\'tts\')');
        expect(conversationTtsSource).not.toContain('../extensions/tts/index.js');
        expect(conversationTtsSource).toContain('narrateTtsMessage(ttsMessage');
        expect(conversationStoreSource).toContain('void narrateConversationMessage(message, { isStillVisible })');
        expect(timelineSource).toContain('action: \'speak-message\'');
        expect(timelineSource).toContain('speakConversationMessage');
        expect(chromeSource).toContain('case \'speak-message\':');
    });

    test('sends Pollinations TTS text as literal speech input', () => {
        expect(pollinationsTtsSource).toContain('text: chunk');
        expect(pollinationsTtsSource).not.toContain('Say exactly this and nothing else');
        expect(speechEndpointSource).toContain('https://gen.pollinations.ai/v1/audio/speech');
        expect(speechEndpointSource).toContain('model === \'openai-audio\' ? \'tts-1\' : model');
        expect(speechEndpointSource).toContain('input: text');
        expect(speechEndpointSource).not.toContain('modalities: [\'text\', \'audio\']');
    });

    test('advances TTS queue immediately after segment generation completes', () => {
        const extensionTtsLines = extensionTtsSource.split('\n');
        const completeTtsJobIndex = extensionTtsLines.findIndex(line => line.includes('function completeTtsJob()'));
        expect(completeTtsJobIndex).toBeGreaterThanOrEqual(0);

        // Find the closing brace of completeTtsJob function
        let braceCount = 0;
        let endIndex = completeTtsJobIndex;
        for (let i = completeTtsJobIndex; i < extensionTtsLines.length; i++) {
            const line = extensionTtsLines[i];
            braceCount += (line.match(/{/g) || []).length;
            braceCount -= (line.match(/}/g) || []).length;
            if (braceCount === 0 && i > completeTtsJobIndex) {
                endIndex = i;
                break;
            }
        }

        const completeTtsJobBody = extensionTtsLines.slice(completeTtsJobIndex, endIndex + 1).join('\n');
        expect(completeTtsJobBody).toContain('ttsJobQueue.length > 0');
        expect(completeTtsJobBody).toContain('scheduleTtsQueueWakeup()');

        // The wakeup helper must schedule a macrotask; a microtask can run before
        // SimpleMutex releases and be swallowed.
        const wakeupIndex = extensionTtsLines.findIndex(line => line.includes('function scheduleTtsQueueWakeup()'));
        expect(wakeupIndex).toBeGreaterThanOrEqual(0);
        const wakeupBody = extensionTtsLines.slice(wakeupIndex, wakeupIndex + 6).join('\n');
        expect(wakeupBody).toContain('setTimeout(() => void wrapper.update(), 0)');
        expect(extensionTtsSource).not.toContain('queueMicrotask(() => void wrapper.update())');
    });

    test('waits around five seconds for rapid follow-up messages before replying', () => {
        expect(constantsSource).toContain('SEND_QUEUE_COALESCE_MS = 5000');
        expect(attachmentsSource).toContain('windowMs: SEND_QUEUE_COALESCE_MS');
        expect(readConversationSource('send-queue-utils.js')).toContain('DEFAULT_COALESCE_WINDOW_MS = 5000');
    });
});
