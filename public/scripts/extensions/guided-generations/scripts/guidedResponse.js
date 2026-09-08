import {
    applyPromptTemplate,
    debugLog,
    extensionName,
    extension_settings,
    getContext,
    guidedResponseInjectId,
    isGroupChat,
    setPreviousImpersonateInput,
} from './shared.js';
import { pickGroupMember } from './groupSelection.js';

let isGenerating = false;

async function guidedResponse() {
    if (isGenerating) {
        return;
    }
    const textarea = document.getElementById('send_textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) {
        console.error('[GuidedGenerations][Response] Textarea #send_textarea not found.');
        return;
    }

    const originalInput = textarea.value;
    const originalContext = getContext();
    const settings = extension_settings[extensionName] ?? {};
    const injectionRole = settings.injectionEndRole ?? 'system';
    const depth = settings.depthPromptGuidedResponse ?? 0;
    const promptTemplate = settings.promptGuidedResponse ?? '';
    const filledPrompt = applyPromptTemplate(promptTemplate, originalInput);
    setPreviousImpersonateInput(originalInput);
    let injectionAttempted = false;
    isGenerating = true;

    try {
        let triggerArgument = '';
        if (isGroupChat()) {
            const selectedMember = await pickGroupMember();
            if (selectedMember === null) {
                return;
            }
            triggerArgument = ` ${selectedMember}`;
        }

        const stscriptCommand = `/inject id=${guidedResponseInjectId} position=chat ephemeral=true scan=true depth=${depth} role=${injectionRole} ${filledPrompt}|
/trigger await=true${triggerArgument}|`;
        injectionAttempted = true;
        await getContext().executeSlashCommandsWithOptions(stscriptCommand);
        debugLog('[Response] Executed command:', stscriptCommand);
    } catch (error) {
        console.error('[GuidedGenerations][Response] Error executing Guided Response stscript:', error);
    } finally {
        const currentContext = getContext();
        const isOriginalChat = currentContext.chatId === originalContext.chatId && currentContext.groupId === originalContext.groupId;
        if (isOriginalChat && injectionAttempted) {
            textarea.value = originalInput;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }

        if (isOriginalChat && injectionAttempted) {
            try {
                await getContext().executeSlashCommandsWithOptions(`/flushinject ${guidedResponseInjectId}`);
            } catch (error) {
                console.warn('[GuidedGenerations][Response] Could not flush guided response injection:', error);
            }
        }
        isGenerating = false;
    }
}

export { guidedResponse };
