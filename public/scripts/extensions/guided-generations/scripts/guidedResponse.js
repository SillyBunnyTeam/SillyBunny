import {
    applyPromptTemplate,
    debugLog,
    extensionName,
    extension_settings,
    getContext,
    getPreviousImpersonateInput,
    guidedResponseInjectId,
    isGroupChat,
    setPreviousImpersonateInput,
} from './shared.js';

function getGroupCharacterNames() {
    const context = getContext();
    const currentGroupId = context?.groupId;
    const groups = context?.groups;

    if (!currentGroupId || !Array.isArray(groups)) {
        return [];
    }

    const currentGroup = groups.find(group => group.id === currentGroupId);
    if (!Array.isArray(currentGroup?.members)) {
        return [];
    }

    return currentGroup.members
        .map(member => {
            if (typeof member === 'string' && member.toLowerCase().endsWith('.png')) {
                return member.slice(0, -4);
            }

            return member;
        })
        .filter(Boolean);
}

async function guidedResponse() {
    const textarea = document.getElementById('send_textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) {
        console.error('[GuidedGenerations][Response] Textarea #send_textarea not found.');
        return;
    }

    const originalInput = textarea.value;
    const settings = extension_settings[extensionName] ?? {};
    const injectionRole = settings.injectionEndRole ?? 'system';
    const depth = settings.depthPromptGuidedResponse ?? 0;
    const promptTemplate = settings.promptGuidedResponse ?? '';
    const filledPrompt = applyPromptTemplate(promptTemplate, originalInput);
    setPreviousImpersonateInput(originalInput);

    let stscriptCommand = `// Single character logic|
/inject id=${guidedResponseInjectId} position=chat ephemeral=true scan=true depth=${depth} role=${injectionRole} ${filledPrompt}|
/trigger await=true|
`;

    if (isGroupChat()) {
        const characterNames = getGroupCharacterNames();
        if (characterNames.length > 0) {
            stscriptCommand = `// Group chat logic|
/buttons labels=${JSON.stringify(characterNames)} "Select member to respond as" |
/setglobalvar key=selection {{pipe}} |
/inject id=${guidedResponseInjectId} position=chat ephemeral=true scan=true depth=${depth} role=${injectionRole} ${filledPrompt} |
/trigger await=true {{getglobalvar::selection}}|
`;
        } else {
            console.warn(`[${extensionName}][Response] Could not get character list for group chat. Falling back to single character logic.`);
        }
    }

    try {
        await getContext().executeSlashCommandsWithOptions(stscriptCommand);
        debugLog('[Response] Executed command:', stscriptCommand);
    } catch (error) {
        console.error('[GuidedGenerations][Response] Error executing Guided Response stscript:', error);
    } finally {
        textarea.value = getPreviousImpersonateInput();
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        try {
            await getContext().executeSlashCommandsWithOptions(`/flushinject ${guidedResponseInjectId}`);
        } catch (error) {
            console.warn('[GuidedGenerations][Response] Could not flush guided response injection:', error);
        }
    }
}

export { guidedResponse };
