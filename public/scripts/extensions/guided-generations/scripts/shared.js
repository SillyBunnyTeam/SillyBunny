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

export {
    applyPromptTemplate,
    debugLog,
    debugWarn,
    extensionName,
    extension_settings,
    getContext,
    getCurrentProfile,
    getCurrentProfileId,
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
