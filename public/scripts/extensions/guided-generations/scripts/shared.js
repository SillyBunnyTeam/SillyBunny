import { extension_settings, getContext } from '../../../extensions.js';
import {
    getCurrentProfile,
    getCurrentProfileId,
    getPresetsForApiType,
    getProfileApiType,
    getProfileById,
    getProfileList,
    handleSwitching,
    resolveStoredProfile,
} from './presetUtils.js';

const extensionName = 'guided-generations';
const guidedResponseInjectId = 'gg-guided-response';
const guidedSwipeInjectId = 'gg-guided-swipe';
const guidedCorrectionInjectId = 'gg-guided-correction';
const guidedImpersonateInjectId = 'gg-impersonate-voice';
const guidedGenerationInjectIds = [
    guidedResponseInjectId,
    guidedSwipeInjectId,
    guidedCorrectionInjectId,
    guidedImpersonateInjectId,
];

let previousImpersonateInput = '';
let lastImpersonateResult = '';

function debugLog(...args) {
    if (extension_settings[extensionName]?.debugMode) {
        console.log(`[${extensionName}][DEBUG]`, ...args);
    }
}

function debugWarn(...args) {
    if (extension_settings[extensionName]?.debugMode) {
        console.warn(`[${extensionName}][DEBUG]`, ...args);
    }
}

function setPreviousImpersonateInput(input) {
    previousImpersonateInput = input ?? '';
}

function getPreviousImpersonateInput() {
    return previousImpersonateInput;
}

function setLastImpersonateResult(result) {
    lastImpersonateResult = result ?? '';
}

function getLastImpersonateResult() {
    return lastImpersonateResult;
}

function isGroupChat() {
    const context = getContext();
    return Boolean(context?.groupId && context?.groups);
}

function getLastAiMessage() {
    const context = getContext();
    const chat = context?.chat;

    if (!Array.isArray(chat) || chat.length === 0) {
        return null;
    }

    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (message && !message.is_user && !message.is_system) {
            return { message, index: i };
        }
    }

    return null;
}

function applyPromptTemplate(template, input) {
    return String(template ?? '').split('{{input}}').join(input ?? '');
}

function getActiveGuides() {
    const injects = getContext()?.chatMetadata?.script_injects;
    if (!injects || typeof injects !== 'object') {
        return [];
    }

    return guidedGenerationInjectIds.filter(id => Boolean(injects[id]));
}

async function flushActiveGuides() {
    const activeGuides = getActiveGuides();
    if (activeGuides.length === 0) {
        return [];
    }

    const context = getContext();
    if (typeof context?.executeSlashCommandsWithOptions !== 'function') {
        throw new Error('SillyTavern slash command execution is not available.');
    }

    for (const id of activeGuides) {
        await context.executeSlashCommandsWithOptions(`/flushinject ${id}`);
    }

    return activeGuides;
}

export {
    applyPromptTemplate,
    debugLog,
    debugWarn,
    extensionName,
    extension_settings,
    flushActiveGuides,
    getActiveGuides,
    getContext,
    getCurrentProfile,
    getCurrentProfileId,
    guidedCorrectionInjectId,
    guidedImpersonateInjectId,
    guidedResponseInjectId,
    guidedSwipeInjectId,
    getLastAiMessage,
    getLastImpersonateResult,
    getPresetsForApiType,
    getPreviousImpersonateInput,
    getProfileApiType,
    getProfileById,
    getProfileList,
    handleSwitching,
    isGroupChat,
    resolveStoredProfile,
    setLastImpersonateResult,
    setPreviousImpersonateInput,
};
