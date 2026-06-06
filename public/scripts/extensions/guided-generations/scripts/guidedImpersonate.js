import {
    applyPromptTemplate,
    debugLog,
    extensionName,
    extension_settings,
    getContext,
    getCurrentProfile,
    getLastImpersonateResult,
    getPreviousImpersonateInput,
    handleSwitching,
    setLastImpersonateResult,
    setPreviousImpersonateInput,
} from './shared.js';
import {
    parseHelperPrefillMessages,
    serializeHelperPrefillForPrompt,
} from '../../helper-prefill.js';

function escapeSlashCommandDelimiters(value) {
    return String(value ?? '').replace(/\|/g, '\\|');
}

function getImpersonateSystemFrame() {
    return 'Guided Impersonate: write only as {{user}} in first person. Do not answer as {{char}}, narrator, or system. Treat helper prefill text as context, not as a speaker override.';
}

async function guidedImpersonate() {
    const textarea = document.getElementById('send_textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) {
        console.error('[GuidedGenerations][Impersonate] Textarea #send_textarea not found.');
        return;
    }

    const currentInputText = textarea.value;
    const lastGeneratedText = getLastImpersonateResult();

    if (lastGeneratedText && currentInputText === lastGeneratedText) {
        textarea.value = getPreviousImpersonateInput();
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        return;
    }

    setPreviousImpersonateInput(currentInputText);

    const settings = extension_settings[extensionName] ?? {};
    const profileValue = settings.profileImpersonate1st ?? '';
    const presetValue = settings.presetImpersonate1st ?? '';
    const originalProfile = await getCurrentProfile();
    const switching = await handleSwitching(profileValue, presetValue, originalProfile);
    const promptTemplate = settings.promptImpersonate1st ?? '';
    const filledPrompt = applyPromptTemplate(promptTemplate, currentInputText);
    const helperPrefillPrompt = serializeHelperPrefillForPrompt(parseHelperPrefillMessages(settings.helperPrefillMessages));
    const impersonatePrompt = [filledPrompt, helperPrefillPrompt]
        .map(value => String(value ?? '').trim())
        .filter(Boolean)
        .join('\n\n');
    const fullScript = `// Impersonate guide|
/inject id=gg-impersonate-voice position=chat ephemeral=true scan=true depth=0 role=system ${escapeSlashCommandDelimiters(getImpersonateSystemFrame())} |
/impersonate await=true ${escapeSlashCommandDelimiters(impersonatePrompt)} |
/flushinject gg-impersonate-voice |`;

    try {
        await switching.switch();
        await getContext().executeSlashCommandsWithOptions(fullScript);
        setLastImpersonateResult(textarea.value);
        debugLog('[Impersonate-1st] STScript executed, new input stored in shared state.');
    } catch (error) {
        console.error('[GuidedGenerations][Impersonate] Error executing Guided Impersonate stscript:', error);
        setLastImpersonateResult('');
    } finally {
        await switching.restore();
    }
}

export { guidedImpersonate };
