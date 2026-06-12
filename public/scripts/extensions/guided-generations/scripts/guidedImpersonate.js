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
    return [
        'Guided Impersonate: generate only the next text-box message for {{user}}.',
        'The guided impersonation prompt is authoritative for grammatical person, narration style, length, and exclusions.',
        'If it asks for first, second, or third person, follow that requested perspective exactly.',
        'Do not answer as {{char}}, explain the task, mention these instructions, or continue beyond the requested {{user}} message.',
        'Treat helper prefill text as context, not as a speaker override.',
    ].join(' ');
}

function buildGuidedImpersonatePrompt(filledPrompt, helperPrefillPrompt) {
    const prompt = String(filledPrompt ?? '').trim();
    const helper = String(helperPrefillPrompt ?? '').trim();
    const sections = [
        'Follow the guided impersonation prompt exactly when generating {{user}}\'s next text-box message. It is instruction text, not story text. Obey any requested first-, second-, or third-person perspective, narration style, dialogue requirements, length limits, and exclusions.',
    ];

    if (prompt) {
        sections.push(`<guided_impersonation_prompt>\n${prompt}\n</guided_impersonation_prompt>`);
    }

    if (helper) {
        sections.push(`<helper_prefill_context>\n${helper}\n</helper_prefill_context>`);
    }

    return sections.join('\n\n');
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
    const impersonatePrompt = buildGuidedImpersonatePrompt(filledPrompt, helperPrefillPrompt);
    const fullScript = `// Impersonate guide|
/inject id=gg-impersonate-voice position=chat ephemeral=true scan=true depth=0 role=system ${escapeSlashCommandDelimiters(getImpersonateSystemFrame())} |
/impersonate await=true ${escapeSlashCommandDelimiters(impersonatePrompt)} |
/flushinject gg-impersonate-voice |`;

    try {
        await switching.switch();
        await getContext().executeSlashCommandsWithOptions(fullScript);
        setLastImpersonateResult(textarea.value);
        debugLog('[Impersonate] STScript executed, new input stored in shared state.');
    } catch (error) {
        console.error('[GuidedGenerations][Impersonate] Error executing Guided Impersonate stscript:', error);
        setLastImpersonateResult('');
    } finally {
        await switching.restore();
    }
}

export { guidedImpersonate };
