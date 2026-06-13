import {
    chat,
    chat_metadata,
    normalizeContentText,
    saveChatDebounced,
    setExtensionPrompt,
    substituteParams,
} from '../../../../script.js';
import { power_user } from '../../../power-user.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { eventSource } from '../../../events.js';
import { getWorldInfoPrompt } from '../../../world-info.js';
import { getConnectionProfileDisplayName } from '../profile-utils.js';
import {
    getAgentById,
    getCompanionConfig,
    getEnabledAgents,
    getGlobalSettings,
    isCompanionAgent,
    normalizeCompanionConfig,
    resolveCompanionConnectionProfile,
} from '../agent-store.js';
import {
    buildPromptDynamicMacros,
    deleteAgentExtraValue,
    getAgentExtraValue,
    getAgentGenerationCancelRevision,
    registerCompanionRuntime,
    requestPromptTransform,
    setAgentExtraValue,
} from '../agent-runner.js';

export const COMPANION_RESULTS_EXTRA_KEY = 'inChatAgentCompanionResults';
export const COMPANION_RESULTS_UPDATED_EVENT = 'in_chat_agent_companion_results_updated';

const MAX_COMPANION_RESULT_CHARS = 64 * 1024;
const COMPANION_PROMPT_KEY_PREFIX = 'inchat_agent_companion_';
const BATCH_MARKER_RE = /<<<(?:COMPANION|companion):([\w-]+)>>>([\s\S]*?)<<<(?:END|end):\1>>>/g;
const CHATROOM_TEMPLATE_ID = 'tpl-chatroom-companion';
const DIRECTORS_COMMENTARY_TEMPLATE_ID = 'tpl-directors-commentary-companion';
const PLOT_COMPASS_TEMPLATE_ID = 'tpl-plot-compass-companion';
const CHATROOM_CUSTOM_STYLE_VALUE = 'custom';
const CHATROOM_CUSTOM_STYLES_MAX_CHARS = 6000;
const CHATROOM_CUSTOM_STYLE_NAME_MAX_CHARS = 80;
const CHATROOM_CUSTOM_STYLE_PROMPT_MAX_CHARS = 2000;
const CHATROOM_EXTRA_CHARACTER_LIMIT = 12;
const CHATROOM_EXTRA_CHARACTER_AVATAR_MAX_CHARS = 256;
const CHATROOM_EXTRA_CHARACTER_CARD_MAX_CHARS = 6000;
const DIRECTOR_COMMENTARY_CUSTOM_VOICE_VALUE = 'custom';
const DIRECTOR_COMMENTARY_CUSTOM_VOICES_MAX_CHARS = 6000;
const DIRECTOR_COMMENTARY_CUSTOM_VOICE_NAME_MAX_CHARS = 80;
const DIRECTOR_COMMENTARY_CUSTOM_VOICE_PROMPT_MAX_CHARS = 2000;
const CHATROOM_STYLE_VALUES = new Set([
    'mixed',
    'in-world',
    'discord/twitch',
    'twitter/x',
    'reddit',
    'ao3/wattpad',
    'newsroom',
    'thread-board/4chan',
    CHATROOM_CUSTOM_STYLE_VALUE,
]);
const DIRECTOR_COMMENTARY_VOICE_VALUES = new Set([
    'active',
    'conspiratorial-absurdity',
    'bureaucratic-irony',
    'cosmic-playbook',
    'beige-undercurrents',
    'gossipy-voyeurism',
    'cruel-realism',
    'solemn-witness',
    'grand-satirical-stage',
    'randomised',
    DIRECTOR_COMMENTARY_CUSTOM_VOICE_VALUE,
]);
const DIRECTOR_COMMENTARY_VOICE_PRESETS = Object.freeze({
    'conspiratorial-absurdity': '# Prose Voice\nMaintain an intimate, mischievous voice characterized by dry amusement, controlled irony, and direct, conspiratorial address. Center your perspective on the grand cosmic comedy: the absolute indifference of the physical universe contrasted against desperate human struggles for meaning. Place a short, razor-sharp aside immediately after any absurd, tense, revealing, reckless, or socially charged behavior. Use these asides to highlight the mechanical, empty nature of human routines, stripping away illusions of fate or grand purpose, and pointing directly to the stark physical reality of the immediate moment.',
    'bureaucratic-irony': '# Prose Voice\nCombine a dry, endless administrative nightmare with your intimate, conspiratorial voice. Frame every setting as a series of illogical, locked rooms or bizarre rules. Drop a sharp, whispering aside immediately after a character tries to appeal to authority or escape a loop: use these asides to point out the absolute, laughable futility of their efforts, then immediately push the scene forward.',
    'cosmic-playbook': '# Prose Voice\nBlend chilling, metaphysical dread with a highly mischievous, intimate delivery. Treat characters as flimsy, hollow puppets or clockwork toys going through the motions. Insert a brief, mocking aside whenever they show genuine emotion or try to assume control: use these commentaries to highlight the artificial, fragile illusion of their safety, then drag them right back into the cold reality of the scene.',
    'beige-undercurrents': '# Prose Voice\nDeliver the narrative in short, razor-sharp, loaded sentences while maintaining your intimate, teasing connection with the reader. Focus entirely on physical actions and concrete reality. Plant a dry, whispered aside immediately after a heavy pause or a tense, unspoken realization: use these brief comments to expose the massive emotional weight hiding beneath their simple actions, then immediately drive the next physical movement forward.',
    'gossipy-voyeurism': '# Prose Voice\nMerge a hyper-detailed, cold focus on prestige and items with your highly conspiratorial, gossipy voice. Whenever a character flaunts status, shows vanity, or behaves with shallow cruelty, drop a sharp, satirical aside immediately after: use these commentaries to mock their hollow priorities and flag the hidden rot beneath the polished surface, keeping the scene moving forward instantly.',
    'cruel-realism': '# Prose Voice\nExamine the petty pride and fragile dignity of the characters through your mischievous, cynical lens. Watch closely for moments of greed, social climbing, or sudden misfortune, and immediately slip in a dry, intimate aside: use these targeted comments to expose their hypocrisy and highlight the cruel irony of their choices, progressing the scene immediately after the jab.',
    'solemn-witness': '# Prose Voice\nUse a heavy, rhythmic, biblical cadence to paint a harsh and beautiful environment, keeping your narration voice intimately close to the action. Whenever the physical world forces a character\'s hand or reveals their primal vulnerability, insert a brief, solemn yet teasing aside: use this commentary to underline the sheer absurdity of human ambition against an indifferent universe, then march the scene forward.',
    'grand-satirical-stage': '# Prose Voice\nUnleash a bustling, highly theatrical world filled with colorful eccentrics and systemic hypocrisy, narrating with your signature playful intimacy. After any dramatic outburst, quirky gesture, or display of class inequality, deliver a swift, theatrical aside: use these comments to sharpen the social subtext and expose the folly of the wealthy or puffed-up, immediately steering the focus back to the unfolding action.',
});

let companionRunnerInitialized = false;

function normalizeText(value = '') {
    return normalizeContentText(String(value ?? '')).trim();
}

function normalizeChatroomStyle(value = '') {
    const normalized = String(value ?? '').trim().toLowerCase();
    return CHATROOM_STYLE_VALUES.has(normalized) ? normalized : 'mixed';
}

function normalizeChatroomCustomStyles(value = '') {
    return String(value ?? '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .join('\n')
        .slice(0, CHATROOM_CUSTOM_STYLES_MAX_CHARS);
}

function normalizeChatroomCustomStyleName(value = '') {
    return String(value ?? '').trim().slice(0, CHATROOM_CUSTOM_STYLE_NAME_MAX_CHARS);
}

function parseChatroomCustomStyles(value = '') {
    const seenNames = new Set();
    return normalizeChatroomCustomStyles(value)
        .split('\n')
        .map(line => {
            const separatorIndex = line.indexOf(':');
            if (separatorIndex <= 0) return null;

            const name = normalizeChatroomCustomStyleName(line.slice(0, separatorIndex));
            const prompt = line.slice(separatorIndex + 1).trim().slice(0, CHATROOM_CUSTOM_STYLE_PROMPT_MAX_CHARS);
            const normalizedName = name.toLowerCase();

            if (!name || !prompt || seenNames.has(normalizedName)) return null;
            seenNames.add(normalizedName);
            return { name, prompt };
        })
        .filter(Boolean);
}

function getChatroomCustomStylesSetting(settings = {}) {
    const customStyles = normalizeChatroomCustomStyles(settings?.chatroomCustomStyles);
    if (customStyles) return customStyles;

    const legacyCustomStyle = String(settings?.chatroomCustomStyle ?? '').trim();
    return legacyCustomStyle ? normalizeChatroomCustomStyles(`Custom: ${legacyCustomStyle}`) : '';
}

function normalizeChatroomExtraCharacterAvatars(value = []) {
    const rawValues = Array.isArray(value)
        ? value
        : String(value ?? '').split(/[\n,]/);
    const seenAvatars = new Set();
    const avatars = [];

    for (const rawValue of rawValues) {
        const avatar = String(rawValue ?? '').trim().slice(0, CHATROOM_EXTRA_CHARACTER_AVATAR_MAX_CHARS);
        const key = avatar.toLowerCase();
        if (!avatar || seenAvatars.has(key)) continue;

        seenAvatars.add(key);
        avatars.push(avatar);
        if (avatars.length >= CHATROOM_EXTRA_CHARACTER_LIMIT) break;
    }

    return avatars;
}

function getActiveChatroomCharacterAvatarKeys(context = getContext()) {
    const activeAvatars = new Set();
    const characters = Array.isArray(context?.characters) ? context.characters : [];

    if (context?.groupId) {
        const activeGroup = Array.isArray(context?.groups)
            ? context.groups.find(group => String(group?.id ?? '') === String(context.groupId ?? ''))
            : null;
        const members = Array.isArray(activeGroup?.members) ? activeGroup.members : [];
        for (const avatar of members) {
            const value = String(avatar ?? '').trim();
            if (value) activeAvatars.add(value.toLowerCase());
        }
        return activeAvatars;
    }

    const characterIndex = Number(context?.characterId);
    if (Number.isInteger(characterIndex) && characters[characterIndex]?.avatar) {
        activeAvatars.add(String(characters[characterIndex].avatar).trim().toLowerCase());
    }

    return activeAvatars;
}

function getChatroomCharacterName(character = {}, index = 0) {
    return normalizeText(character?.name || character?.data?.name || character?.avatar || `Character ${index + 1}`);
}

function getChatroomCharacterCardFields(context, characterIndex, character = {}) {
    if (typeof context?.getCharacterCardFields === 'function') {
        try {
            const fields = context.getCharacterCardFields({ chid: characterIndex });
            if (fields && typeof fields === 'object') {
                return fields;
            }
        } catch (error) {
            console.warn('[InChatAgents] Chatroom extra character card lookup failed:', error);
        }
    }

    return {
        description: character.description,
        personality: character.personality,
        scenario: character.scenario,
        system: character.data?.system_prompt,
        creatorNotes: character.data?.creator_notes || character.creatorcomment,
        firstMessage: character.first_mes,
        mesExamples: character.mes_example,
    };
}

function formatChatroomExtraCharacterCard(character, fields, index = 0) {
    const parts = [`Name: ${getChatroomCharacterName(character, index)}`];

    for (const [label, value] of [
        ['Description', fields.description],
        ['Personality', fields.personality],
        ['Scenario', fields.scenario],
        ['System', fields.system],
        ['Creator Notes', fields.creatorNotes],
        ['First Message', fields.firstMessage],
        ['Examples', fields.mesExamples],
    ]) {
        const text = normalizeText(value);
        if (text) {
            parts.push(`${label}:\n${text}`);
        }
    }

    return parts.join('\n\n').slice(0, CHATROOM_EXTRA_CHARACTER_CARD_MAX_CHARS);
}

function getChatroomExtraCharacterCardsBlock(settings = {}) {
    const selectedAvatars = normalizeChatroomExtraCharacterAvatars(settings?.chatroomExtraCharacterAvatars);
    if (!selectedAvatars.length) return '';

    const context = getContext();
    const characters = Array.isArray(context?.characters) ? context.characters : [];
    const activeAvatarKeys = getActiveChatroomCharacterAvatarKeys(context);
    const selectedAvatarKeys = new Set(selectedAvatars.map(avatar => avatar.toLowerCase()));
    const sections = [];

    characters.forEach((character, index) => {
        const avatar = String(character?.avatar ?? '').trim();
        const key = avatar.toLowerCase();
        if (!avatar || !selectedAvatarKeys.has(key) || activeAvatarKeys.has(key)) return;

        const fields = getChatroomCharacterCardFields(context, index, character);
        sections.push(formatChatroomExtraCharacterCard(character, fields, index));
    });

    return sections.filter(Boolean).join('\n\n---\n\n');
}

function resolveChatroomCustomStyle(settings = {}) {
    const styles = parseChatroomCustomStyles(getChatroomCustomStylesSetting(settings));
    if (!styles.length) return null;

    const selectedName = normalizeChatroomCustomStyleName(settings?.chatroomCustomStyleName).toLowerCase();
    return styles.find(style => style.name.toLowerCase() === selectedName) || styles[0];
}

function normalizeDirectorCommentaryVoice(value = '') {
    const normalized = String(value ?? '').trim().toLowerCase();
    return DIRECTOR_COMMENTARY_VOICE_VALUES.has(normalized) ? normalized : 'active';
}

function normalizeDirectorCustomVoices(value = '') {
    return String(value ?? '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .join('\n')
        .slice(0, DIRECTOR_COMMENTARY_CUSTOM_VOICES_MAX_CHARS);
}

function normalizeDirectorCustomVoiceName(value = '') {
    return String(value ?? '').trim().slice(0, DIRECTOR_COMMENTARY_CUSTOM_VOICE_NAME_MAX_CHARS);
}

function parseDirectorCustomVoices(value = '') {
    const seenNames = new Set();
    return normalizeDirectorCustomVoices(value)
        .split('\n')
        .map(line => {
            const separatorIndex = line.indexOf(':');
            if (separatorIndex <= 0) return null;

            const name = normalizeDirectorCustomVoiceName(line.slice(0, separatorIndex));
            const prompt = line.slice(separatorIndex + 1).trim().slice(0, DIRECTOR_COMMENTARY_CUSTOM_VOICE_PROMPT_MAX_CHARS);
            const normalizedName = name.toLowerCase();

            if (!name || !prompt || seenNames.has(normalizedName)) return null;
            seenNames.add(normalizedName);
            return { name, prompt };
        })
        .filter(Boolean);
}

function getDirectorCustomVoicesSetting(settings = {}) {
    const customVoices = normalizeDirectorCustomVoices(settings?.directorCommentaryCustomVoices);
    if (customVoices) return customVoices;

    const legacyCustomVoice = String(settings?.directorCommentaryCustomVoice ?? '').trim();
    return legacyCustomVoice ? normalizeDirectorCustomVoices(`Custom: ${legacyCustomVoice}`) : '';
}

function resolveDirectorCustomVoice(settings = {}) {
    const voices = parseDirectorCustomVoices(getDirectorCustomVoicesSetting(settings));
    if (!voices.length) return null;

    const selectedName = normalizeDirectorCustomVoiceName(settings?.directorCommentaryCustomVoiceName).toLowerCase();
    return voices.find(voice => voice.name.toLowerCase() === selectedName) || voices[0];
}

function getDirectorRandomisedVoicePrompt() {
    const presetBlocks = Object.entries(DIRECTOR_COMMENTARY_VOICE_PRESETS)
        .map(([id, prompt]) => `Preset: ${id}\n${prompt}`)
        .join('\n\n');

    return `Pick one built-in Narration Voice preset for this run and keep the commentary in that single voice.\n\n${presetBlocks}`;
}

function getDirectorCommentaryVoicePrompt(voice, settings = {}) {
    const normalizedVoice = normalizeDirectorCommentaryVoice(voice);

    if (normalizedVoice === DIRECTOR_COMMENTARY_CUSTOM_VOICE_VALUE) {
        const customVoice = resolveDirectorCustomVoice(settings);
        return customVoice
            ? `Name: ${customVoice.name}\n${customVoice.prompt}`
            : 'none set - use active Narration Voice';
    }

    if (normalizedVoice === 'randomised') {
        return getDirectorRandomisedVoicePrompt();
    }

    if (normalizedVoice === 'active') {
        return 'Use the active Prose Voice block from the template above. If that block is empty, use the template native default voice.';
    }

    return DIRECTOR_COMMENTARY_VOICE_PRESETS[normalizedVoice] || DIRECTOR_COMMENTARY_VOICE_PRESETS['conspiratorial-absurdity'];
}

function getTemplateSettingsPromptBlock(agent = {}) {
    const sourceTemplateId = String(agent?.sourceTemplateId ?? '').trim();

    if (sourceTemplateId === CHATROOM_TEMPLATE_ID) {
        const style = normalizeChatroomStyle(agent.settings?.chatroomStyle);
        const blocks = [`[Selected Chatroom Style]\n${style}`];

        if (style === CHATROOM_CUSTOM_STYLE_VALUE) {
            const customStyle = resolveChatroomCustomStyle(agent.settings);
            blocks.push(customStyle
                ? `[Custom Chatroom Style]\nName: ${customStyle.name}\n${customStyle.prompt}`
                : '[Custom Chatroom Style]\nnone set - use mixed');
        }

        const extraCharacterCards = getChatroomExtraCharacterCardsBlock(agent.settings);
        if (extraCharacterCards) {
            blocks.push(`[Chatroom Extra Character Cards]\n${extraCharacterCards}`);
        }

        return blocks.join('\n\n');
    }

    if (sourceTemplateId === DIRECTORS_COMMENTARY_TEMPLATE_ID) {
        const voice = normalizeDirectorCommentaryVoice(agent.settings?.directorCommentaryVoice);
        return [
            `[Selected Director Commentary Voice]\n${voice}`,
            `[Director Commentary Voice]\n${getDirectorCommentaryVoicePrompt(voice, agent.settings)}`,
        ].join('\n\n');
    }

    if (sourceTemplateId === PLOT_COMPASS_TEMPLATE_ID) {
        const objective = String(agent.settings?.plotCompassObjective ?? '').trim();
        return `[Plot Compass Objective]\n${objective || 'none set'}`;
    }

    return '';
}

export function stripMarkdownFence(value = '') {
    const text = String(value ?? '').trim();
    const match = text.match(/^```[\w-]*\s*\n([\s\S]*?)\n```$/);
    return (match ? match[1] : text).trim();
}

function capResultContent(value = '') {
    return stripMarkdownFence(value).slice(0, MAX_COMPANION_RESULT_CHARS);
}

function getProfileLabel(agent, responseProfileId = '') {
    const profileId = String(responseProfileId || resolveCompanionConnectionProfile(agent?.connectionProfile) || '').trim();
    if (!profileId) {
        return 'Main model';
    }

    // Show a friendly profile name or nothing: a raw profile id in the card header reads as noise.
    const displayName = getConnectionProfileDisplayName(profileId);
    return displayName === profileId ? '' : displayName;
}

function getModelLabel(agent = {}) {
    return String(agent?.modelOverride ?? '').trim();
}

export function getCompanionResults(message) {
    const stored = getAgentExtraValue(message, COMPANION_RESULTS_EXTRA_KEY);
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

export function setCompanionResult(message, agent, update = {}) {
    if (!message || !agent?.id) {
        return null;
    }

    const existingResults = getCompanionResults(message);
    const existing = existingResults[agent.id] && typeof existingResults[agent.id] === 'object'
        ? existingResults[agent.id]
        : {};
    const companion = getCompanionConfig(agent);
    const nextResults = {
        ...existingResults,
        [agent.id]: {
            agentName: String(agent.name ?? '').trim() || 'Companion',
            icon: String(agent.icon ?? '').trim(),
            format: companion.format,
            displayMode: companion.displayMode,
            status: 'pending',
            content: '',
            collapsed: Boolean(existing.collapsed),
            updatedAt: new Date().toISOString(),
            profileLabel: getProfileLabel(agent, update.profileId),
            modelLabel: getModelLabel(agent),
            ...existing,
            ...update,
            format: update.format ?? companion.format,
            displayMode: update.displayMode ?? companion.displayMode,
            updatedAt: update.updatedAt ?? new Date().toISOString(),
        },
    };

    setAgentExtraValue(message, COMPANION_RESULTS_EXTRA_KEY, nextResults);
    return nextResults[agent.id];
}

export function updateCompanionResult(message, agentId, update = {}) {
    const results = getCompanionResults(message);
    if (!message || !agentId || !results[agentId] || typeof results[agentId] !== 'object') {
        return null;
    }

    const nextResults = {
        ...results,
        [agentId]: {
            ...results[agentId],
            ...update,
            updatedAt: update.updatedAt ?? new Date().toISOString(),
        },
    };

    setAgentExtraValue(message, COMPANION_RESULTS_EXTRA_KEY, nextResults);
    return nextResults[agentId];
}

export function deleteCompanionResult(message, agentId) {
    const results = getCompanionResults(message);
    if (!agentId || !Object.hasOwn(results, agentId)) {
        return false;
    }

    const nextResults = { ...results };
    delete nextResults[agentId];

    if (Object.keys(nextResults).length > 0) {
        setAgentExtraValue(message, COMPANION_RESULTS_EXTRA_KEY, nextResults);
    } else {
        deleteAgentExtraValue(message, COMPANION_RESULTS_EXTRA_KEY);
    }

    return true;
}

async function emitCompanionResultsUpdated(messageIndex, agentId = '') {
    if (typeof eventSource?.emit === 'function') {
        await eventSource.emit(COMPANION_RESULTS_UPDATED_EVENT, { messageIndex, agentId });
    }
}

function isAssistantMessage(message) {
    return Boolean(message && !message.is_user && !message.is_system);
}

function getMessageLine(message) {
    const name = String(message?.name ?? '').trim();
    const role = message?.is_user ? 'User' : 'Assistant';
    const label = name || role;
    return `${label}: ${normalizeText(message?.mes ?? '')}`;
}

function getRecentConversationSection(messageIndex, companion) {
    const start = Math.max(0, messageIndex + 1 - companion.contextMessages);
    const lines = chat.slice(start, messageIndex + 1)
        .map(getMessageLine)
        .filter(line => line.trim());
    return lines.length ? lines.join('\n') : '';
}

function getCharacterCardSection(companion) {
    if (!companion.includeCharacterCard && !companion.includePersona) {
        return '';
    }

    const context = getContext();
    const fields = typeof context?.getCharacterCardFields === 'function'
        ? context.getCharacterCardFields()
        : {};
    const parts = [];

    if (companion.includeCharacterCard) {
        // Greeting (first_mes) and example dialogue are roleplay starters, not character
        // definition. Including them leaks the greeting into companion context, so keep only
        // the descriptive card fields.
        for (const [label, value] of [
            ['Description', fields.description],
            ['Personality', fields.personality],
            ['Scenario', fields.scenario],
            ['System', fields.system],
            ['Creator Notes', fields.creatorNotes],
        ]) {
            const text = normalizeText(value);
            if (text) {
                parts.push(`${label}:\n${text}`);
            }
        }
    }

    if (companion.includePersona) {
        const persona = normalizeText(fields.persona);
        if (persona) {
            parts.push(`Persona:\n${persona}`);
        }
    }

    return parts.join('\n\n');
}

async function getWorldInfoSection(messageIndex, companion) {
    if (!companion.includeWorldInfo) {
        return '';
    }

    try {
        const scanLines = chat.slice(0, messageIndex + 1)
            .map(message => normalizeText(message?.mes ?? ''))
            .filter(Boolean)
            .reverse();
        const result = await getWorldInfoPrompt(scanLines, 4096, true);
        return normalizeText(result?.worldInfoString ?? '');
    } catch (error) {
        console.warn('[InChatAgents] Companion world info scan failed:', error);
        return '';
    }
}

export function collectRecentCompanionResults(agentId, { beforeMessageIndex = chat.length, depth = 1 } = {}) {
    const results = [];
    const maxDepth = Math.max(1, Math.min(10, Number(depth) || 1));

    for (let index = Math.min(beforeMessageIndex - 1, chat.length - 1); index >= 0 && results.length < maxDepth; index--) {
        const message = chat[index];
        if (!isAssistantMessage(message)) {
            continue;
        }

        const result = getCompanionResults(message)[agentId];
        if (result?.status === 'done' && normalizeText(result.content)) {
            results.push({
                messageIndex: index,
                ...result,
            });
        }
    }

    return results;
}

function getPreviousNotesSection(agent, messageIndex, companion) {
    if (!companion.includeHistory) {
        return '';
    }

    return collectRecentCompanionResults(agent.id, {
        beforeMessageIndex: messageIndex,
        depth: companion.historyDepth,
    }).map(result => `Message ${result.messageIndex}:\n${normalizeText(result.content)}`).join('\n\n');
}

function getSystemPromptSection(companion) {
    if (!companion.includeSystemPrompt) {
        return '';
    }

    return normalizeText(substituteParams(String(power_user?.sysprompt?.content ?? '')));
}

function getAuthorsNoteSection(companion) {
    if (!companion.includeAuthorsNote) {
        return '';
    }

    const note = String(chat_metadata?.note_prompt ?? '').trim()
        || String(extension_settings?.note?.default ?? '').trim();
    return normalizeText(substituteParams(note));
}

function normalizeExtraContextSections(extraContextSections = []) {
    if (!Array.isArray(extraContextSections)) {
        return [];
    }

    return extraContextSections
        .map(section => ({
            title: normalizeText(section?.title || 'Extra context'),
            content: normalizeText(section?.content || ''),
        }))
        .filter(section => section.title && section.content)
        .slice(0, 5);
}

async function buildCompanionContextSections(agent, messageIndex, { extraContextSections = [] } = {}) {
    const companion = getCompanionConfig(agent);
    const sections = [];
    const systemPrompt = getSystemPromptSection(companion);
    const characterCard = getCharacterCardSection(companion);
    const worldInfo = await getWorldInfoSection(messageIndex, companion);
    const authorsNote = getAuthorsNoteSection(companion);
    const previousNotes = getPreviousNotesSection(agent, messageIndex, companion);
    const recentConversation = getRecentConversationSection(messageIndex, companion);

    for (const [title, content] of [
        ['System Prompt', systemPrompt],
        ['Character', characterCard],
        ['World Info', worldInfo],
        ["Author's Note", authorsNote],
        ['Your previous notes', previousNotes],
        ['Recent conversation', recentConversation],
    ]) {
        if (content) {
            sections.push(`[${title}]\n${content}`);
        }
    }

    for (const section of normalizeExtraContextSections(extraContextSections)) {
        sections.push(`[${section.title}]\n${section.content}`);
    }

    return sections.join('\n\n');
}

// Companion prompts were written to ride along with a story reply; running standalone,
// especially on small models, they can continue the scene or echo the task unless the boundary
// is explicit. These guards stack on top of rawPrompt, which only suppresses format instructions.
const COMPANION_GUARD_INSTRUCTION = 'Companion task boundary: produce the private sidecar result for this companion, separate from the chat reply and scene continuation.';
// Small models weigh the end of the prompt heaviest, and the context ends with roleplay
// dialogue begging to be continued, so anchor the task after it.
const COMPANION_TASK_ANCHOR = '[Task]\nUse the conversation above as context for the companion result. Complete the companion task from the system message and return the result directly.';

function getFormatInstruction(format) {
    switch (format) {
        case 'html':
            return 'Write a safe HTML fragment for the companion card body using ordinary content elements.';
        case 'text':
            return 'Write a plain text companion card body.';
        case 'markdown':
        default:
            return 'Write a markdown companion card body.';
    }
}

function expandCompanionPrompt(agent, messageIndex, generationType = 'normal') {
    const message = chat[messageIndex];
    const messageText = normalizeText(message?.mes ?? '');
    const prompt = substituteParams(agent.prompt, {
        name2Override: String(message?.name ?? '').trim(),
        original: messageText,
        dynamicMacros: buildPromptDynamicMacros(messageText, message, agent, generationType),
    }).trim();

    return [prompt, getTemplateSettingsPromptBlock(agent)].filter(Boolean).join('\n\n').trim();
}

const COMPANION_REPAIR_INSTRUCTION = 'Repair mode: produce the companion artifact again in the requested format. Keep scene prose, character dialogue, and narrative continuation outside the result. For choice/menu agents, return the bracketed choice or direction block.';

export async function buildCompanionPromptMessages(agent, messageIndex, generationType = 'normal', { repair = false, extraContextSections = [] } = {}) {
    const companion = getCompanionConfig(agent);
    const expandedPrompt = expandCompanionPrompt(agent, messageIndex, generationType);
    const contextSections = await buildCompanionContextSections(agent, messageIndex, { extraContextSections });
    // rawPrompt sends the agent prompt verbatim: tracker prompts define their own exact output
    // format and break when extra format instructions are appended around them. The guard
    // leads so the companion boundary is established before the agent's own instructions.
    const systemContent = [
        COMPANION_GUARD_INSTRUCTION,
        expandedPrompt,
        companion.rawPrompt ? '' : getFormatInstruction(companion.format),
        repair ? COMPANION_REPAIR_INSTRUCTION : '',
    ].filter(Boolean).join('\n\n');

    return [
        {
            role: 'system',
            content: systemContent.trim(),
        },
        {
            role: 'user',
            content: `${contextSections || '[Recent conversation]\nConversation context is empty.'}\n\n${COMPANION_TASK_ANCHOR}`,
        },
    ];
}

function getBatchKey(agent, messageIndex) {
    const companion = getCompanionConfig(agent);
    return JSON.stringify({
        profile: resolveCompanionConnectionProfile(agent.connectionProfile),
        model: String(agent.modelOverride ?? '').trim(),
        contextMessages: companion.contextMessages,
        includeCharacterCard: companion.includeCharacterCard,
        includePersona: companion.includePersona,
        includeWorldInfo: companion.includeWorldInfo,
        includeAuthorsNote: companion.includeAuthorsNote,
        includeSystemPrompt: companion.includeSystemPrompt,
        includeHistory: companion.includeHistory,
        historyDepth: companion.historyDepth,
        messageIndex,
    });
}

function getCompanionBatchAgentIdSet(agent) {
    return new Set(
        (Array.isArray(getCompanionConfig(agent).batchAgentIds) ? getCompanionConfig(agent).batchAgentIds : [])
            .map(id => String(id ?? '').trim())
            .filter(Boolean),
    );
}

function partitionCompanionRuns(agents, messageIndex) {
    const singles = [];
    const agentById = new Map(agents.map(agent => [agent.id, agent]));
    const batchableAgents = agents.filter(agent => getCompanionConfig(agent).batch);
    const adjacency = new Map(batchableAgents.map(agent => [agent.id, new Set()]));

    for (const agent of batchableAgents) {
        const companion = getCompanionConfig(agent);
        const selectedIds = getCompanionBatchAgentIdSet(agent);
        if (selectedIds.size === 0) continue;

        const key = getBatchKey(agent, messageIndex);
        for (const selectedId of selectedIds) {
            const selectedAgent = agentById.get(selectedId);
            if (!selectedAgent) continue;
            if (getBatchKey(selectedAgent, messageIndex) !== key) continue;

            if (!adjacency.has(selectedAgent.id)) {
                adjacency.set(selectedAgent.id, new Set());
            }
            adjacency.get(agent.id)?.add(selectedAgent.id);
            adjacency.get(selectedAgent.id)?.add(agent.id);
        }
    }

    const batches = [];
    const visitedIds = new Set();
    for (const agent of agents) {
        if (!adjacency.has(agent.id)) {
            singles.push({ type: 'single', agent });
            continue;
        }

        if (visitedIds.has(agent.id)) continue;
        const stack = [agent.id];
        const componentIds = [];
        visitedIds.add(agent.id);

        while (stack.length > 0) {
            const currentId = stack.pop();
            componentIds.push(currentId);

            for (const nextId of adjacency.get(currentId) ?? []) {
                if (visitedIds.has(nextId)) continue;

                visitedIds.add(nextId);
                stack.push(nextId);
            }
        }

        const componentAgents = componentIds.map(id => agentById.get(id)).filter(Boolean);
        if (componentAgents.length > 1) {
            batches.push({ type: 'batch', agents: componentAgents });
        } else {
            singles.push({ type: 'single', agent });
        }
    }

    return [...batches, ...singles];
}

function parseBatchResponse(output = '') {
    const parsed = new Map();
    BATCH_MARKER_RE.lastIndex = 0;

    for (const match of String(output ?? '').matchAll(BATCH_MARKER_RE)) {
        parsed.set(match[1], capResultContent(match[2]));
    }

    return parsed;
}

async function runSingleCompanionAgent(agent, messageIndex, generationType, cancelRevision, { repair = false, extraContextSections = [] } = {}) {
    const message = chat[messageIndex];
    if (!isAssistantMessage(message)) {
        return null;
    }

    const companion = getCompanionConfig(agent);

    try {
        if (getAgentGenerationCancelRevision() !== cancelRevision) {
            throw new DOMException('Companion run cancelled.', 'AbortError');
        }

        const promptMessages = await buildCompanionPromptMessages(agent, messageIndex, generationType, { repair, extraContextSections });
        const response = await requestPromptTransform(agent, promptMessages, companion.maxTokens);

        if (getAgentGenerationCancelRevision() !== cancelRevision) {
            setCompanionResult(message, agent, {
                status: 'cancelled',
                content: '',
                error: 'Cancelled.',
                profileId: response.profileId,
                profileLabel: getProfileLabel(agent, response.profileId),
                modelLabel: getModelLabel(agent),
            });
            await emitCompanionResultsUpdated(messageIndex, agent.id);
            return getCompanionResults(message)[agent.id];
        }

        setCompanionResult(message, agent, {
            status: 'done',
            content: capResultContent(response.output),
            error: '',
            profileId: response.profileId,
            profileLabel: getProfileLabel(agent, response.profileId),
            modelLabel: getModelLabel(agent),
        });
    } catch (error) {
        const cancelled = getAgentGenerationCancelRevision() !== cancelRevision || error?.name === 'AbortError';
        setCompanionResult(message, agent, {
            status: cancelled ? 'cancelled' : 'error',
            content: '',
            error: cancelled ? 'Cancelled.' : (error instanceof Error ? error.message : String(error)),
        });
    }

    await emitCompanionResultsUpdated(messageIndex, agent.id);
    return getCompanionResults(message)[agent.id];
}

async function buildBatchPromptMessages(agents, messageIndex, generationType) {
    const contextSections = await buildCompanionContextSections(agents[0], messageIndex);
    const tasks = agents.map(agent => {
        const companion = getCompanionConfig(agent);
        const formatLines = companion.rawPrompt ? [] : ['Output format:', getFormatInstruction(companion.format)];
        return [
            `<<<companion:${agent.id}>>>`,
            `Agent: ${String(agent.name ?? '').trim() || agent.id}`,
            COMPANION_GUARD_INSTRUCTION,
            'Instruction:',
            expandCompanionPrompt(agent, messageIndex, generationType),
            ...formatLines,
            `<<<end:${agent.id}>>>`,
        ].join('\n');
    }).join('\n\n');

    return [
        {
            role: 'system',
            content: 'Run each Companion task independently. Put every result inside its matching <<<companion:agentId>>> and <<<end:agentId>>> markers. Text outside markers is ignored.',
        },
        {
            role: 'user',
            content: `${contextSections || '[Recent conversation]\nConversation context is empty.'}\n\n[Companion tasks]\n${tasks}\n\nPlace every companion result inside its markers now.`,
        },
    ];
}

async function runBatchCompanionAgents(agents, messageIndex, generationType, cancelRevision) {
    const message = chat[messageIndex];
    if (!isAssistantMessage(message)) {
        return [];
    }

    try {
        const promptMessages = await buildBatchPromptMessages(agents, messageIndex, generationType);
        const maxTokens = Math.min(32000, agents.reduce((sum, agent) => sum + normalizeCompanionConfig(agent.companion).maxTokens, 0));
        const response = await requestPromptTransform(agents[0], promptMessages, maxTokens);

        if (getAgentGenerationCancelRevision() !== cancelRevision) {
            for (const agent of agents) {
                setCompanionResult(message, agent, {
                    status: 'cancelled',
                    content: '',
                    error: 'Cancelled.',
                    profileId: response.profileId,
                    profileLabel: getProfileLabel(agent, response.profileId),
                    modelLabel: getModelLabel(agent),
                });
                await emitCompanionResultsUpdated(messageIndex, agent.id);
            }
            return agents.map(agent => getCompanionResults(message)[agent.id]);
        }

        const parsed = parseBatchResponse(response.output);
        const missingAgents = [];
        for (const agent of agents) {
            if (!parsed.has(agent.id)) {
                missingAgents.push(agent);
                continue;
            }

            setCompanionResult(message, agent, {
                status: 'done',
                content: parsed.get(agent.id),
                error: '',
                profileId: response.profileId,
                profileLabel: getProfileLabel(agent, response.profileId),
                modelLabel: getModelLabel(agent),
            });
            await emitCompanionResultsUpdated(messageIndex, agent.id);
        }

        for (const agent of missingAgents) {
            await runSingleCompanionAgent(agent, messageIndex, generationType, cancelRevision);
        }
    } catch (error) {
        console.warn('[InChatAgents] Companion batch failed, falling back to individual runs:', error);
        for (const agent of agents) {
            await runSingleCompanionAgent(agent, messageIndex, generationType, cancelRevision);
        }
    }

    return agents.map(agent => getCompanionResults(message)[agent.id]);
}

async function runCompanionUnit(unit, messageIndex, generationType, cancelRevision) {
    if (unit.type === 'batch') {
        return await runBatchCompanionAgents(unit.agents, messageIndex, generationType, cancelRevision);
    }

    return await runSingleCompanionAgent(unit.agent, messageIndex, generationType, cancelRevision);
}

/** Rough chat size from the stored per-message token accounting (chars/4 as fallback). */
export function getChatTokenEstimate(beforeMessageIndex = chat.length) {
    let total = 0;
    for (let index = 0; index < Math.min(beforeMessageIndex, chat.length); index++) {
        const message = chat[index];
        const counted = Number(message?.extra?.token_count);
        total += Number.isFinite(counted) && counted > 0
            ? counted
            : Math.ceil(String(message?.mes ?? '').length / 4);
    }

    return total;
}

/** Companions like the memory shard only become useful once the chat is large enough. */
export function meetsCompanionContextThreshold(agent, messageIndex = chat.length - 1) {
    const minContextTokens = getCompanionConfig(agent).minContextTokens;
    return !minContextTokens || getChatTokenEstimate(messageIndex + 1) >= minContextTokens;
}

function getRunnableCompanionAgents(activeAgents = [], { manual = false, messageIndex = chat.length - 1 } = {}) {
    return activeAgents.filter(agent => {
        const companion = getCompanionConfig(agent);
        return isCompanionAgent(agent) &&
            String(agent.prompt ?? '').trim() &&
            (manual || (companion.trigger === 'auto' && meetsCompanionContextThreshold(agent, messageIndex)));
    });
}

export async function runCompanionStage({ messageIndex, message, generationType = 'normal', activeAgents = [] } = {}) {
    if (!isAssistantMessage(message)) {
        return [];
    }

    const agents = getRunnableCompanionAgents(activeAgents, { messageIndex });
    if (agents.length === 0) {
        return [];
    }

    for (const agent of agents) {
        setCompanionResult(message, agent, {
            status: 'pending',
            content: '',
            error: '',
        });
        await emitCompanionResultsUpdated(messageIndex, agent.id);
    }

    const cancelRevision = getAgentGenerationCancelRevision();
    const units = partitionCompanionRuns(agents, messageIndex);
    const executionMode = getGlobalSettings().companionExecutionMode === 'sequential' ? 'sequential' : 'parallel';

    if (executionMode === 'sequential') {
        for (const unit of units) {
            await runCompanionUnit(unit, messageIndex, generationType, cancelRevision);
        }
    } else {
        await Promise.all(units.map(unit => runCompanionUnit(unit, messageIndex, generationType, cancelRevision)));
    }

    saveChatDebounced({ deferBackup: false });
    return agents.map(agent => getCompanionResults(message)[agent.id]);
}

export function injectCompanionFeedbackPrompts(activeAgents = []) {
    // A generation that starts with an assistant tail is rewriting that message
    // (swipe/regenerate/continue) — its own stored state is stale, never feed it back.
    const tailMessage = chat[chat.length - 1];
    const beforeMessageIndex = isAssistantMessage(tailMessage) ? chat.length - 1 : chat.length;

    for (const agent of activeAgents) {
        if (!isCompanionAgent(agent)) {
            continue;
        }

        const companion = getCompanionConfig(agent);
        if (!companion.feedback?.enabled) {
            continue;
        }

        const notes = collectRecentCompanionResults(agent.id, {
            beforeMessageIndex,
            depth: companion.feedback.depth,
        });
        if (notes.length === 0) {
            continue;
        }

        const body = notes.map(result => normalizeText(result.content)).filter(Boolean).join('\n\n');
        if (!body) {
            continue;
        }

        setExtensionPrompt(
            COMPANION_PROMPT_KEY_PREFIX + agent.id,
            `[${String(agent.name ?? 'Companion').trim()} - auxiliary notes]\n${body}`,
            agent.injection.position,
            agent.injection.depth,
            agent.injection.scan,
            agent.injection.role,
        );
    }
}

export async function runCompanionAgentOnMessage(agentId, messageIndex, { cancelRevision = getAgentGenerationCancelRevision(), repair = false, extraContextSections = [], pendingContent = '' } = {}) {
    const agent = getAgentById(agentId);
    const message = chat[messageIndex];
    if (!agent || !isCompanionAgent(agent) || !isAssistantMessage(message)) {
        return null;
    }

    setCompanionResult(message, agent, {
        status: 'pending',
        content: capResultContent(pendingContent),
        error: '',
    });
    await emitCompanionResultsUpdated(messageIndex, agent.id);
    const result = await runSingleCompanionAgent(agent, messageIndex, 'normal', cancelRevision, { repair, extraContextSections });
    saveChatDebounced({ deferBackup: false });
    return result;
}

export async function runCompanionsOnMessage(messageIndex) {
    const message = chat[messageIndex];
    if (!isAssistantMessage(message)) {
        return [];
    }

    const agents = getRunnableCompanionAgents(getEnabledAgents(), { manual: true });
    if (agents.length === 0) {
        return [];
    }

    for (const agent of agents) {
        setCompanionResult(message, agent, {
            status: 'pending',
            content: '',
            error: '',
        });
        await emitCompanionResultsUpdated(messageIndex, agent.id);
    }

    const cancelRevision = getAgentGenerationCancelRevision();
    const units = partitionCompanionRuns(agents, messageIndex);
    const executionMode = getGlobalSettings().companionExecutionMode === 'sequential' ? 'sequential' : 'parallel';

    if (executionMode === 'sequential') {
        for (const unit of units) {
            await runCompanionUnit(unit, messageIndex, 'normal', cancelRevision);
        }
    } else {
        await Promise.all(units.map(unit => runCompanionUnit(unit, messageIndex, 'normal', cancelRevision)));
    }

    saveChatDebounced({ deferBackup: false });
    return agents.map(agent => getCompanionResults(message)[agent.id]);
}

export function initCompanionRunner() {
    if (companionRunnerInitialized) {
        return;
    }

    companionRunnerInitialized = true;
    registerCompanionRuntime({
        runCompanionStage,
        injectCompanionFeedbackPrompts,
        runCompanionAgentOnMessage,
    });
}
