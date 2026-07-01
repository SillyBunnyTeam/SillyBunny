import { eventSource, event_types } from '../../../../script.js';
import {
    applyPromptTemplate,
    debugLog,
    extensionName,
    extension_settings,
    getContext,
    getPreviousImpersonateInput,
    guidedSwipeInjectId,
    setPreviousImpersonateInput,
} from './shared.js';

async function executeSTScriptCommand(command) {
    const context = getContext();
    if (typeof context?.executeSlashCommandsWithOptions !== 'function') {
        throw new Error('SillyTavern slash command execution is not available.');
    }

    await context.executeSlashCommandsWithOptions(command);
}

async function generateNewSwipe() {
    let context = getContext();
    const missingProps = ['chat', 'messageFormatting'].filter(prop => context?.[prop] === undefined);
    if (missingProps.length > 0) {
        const errorMessage = `Could not get required context properties: ${missingProps.join(', ')}`;
        console.error(`[GuidedGenerations][Swipe] ${errorMessage}`);
        alert(`Guided Swipe Error: ${errorMessage}`);
        return false;
    }

    try {
        if (!Array.isArray(context.chat) || context.chat.length === 0) {
            alert('Guided Swipe Error: Cannot access chat context.');
            return false;
        }

        const lastMessageIndex = context.chat.length - 1;
        const messageData = context.chat[lastMessageIndex];
        const mesDom = document.querySelector(`#chat .mes[mesid="${lastMessageIndex}"]`);

        if (messageData && Array.isArray(messageData.swipes) && messageData.swipes.length > 1) {
            const targetSwipeIndex = messageData.swipes.length - 1;
            if (messageData.swipe_id !== targetSwipeIndex) {
                messageData.swipe_id = targetSwipeIndex;
                messageData.mes = messageData.swipes[targetSwipeIndex];

                if (mesDom) {
                    const mesTextElement = mesDom.querySelector('.mes_text');
                    if (mesTextElement) {
                        mesTextElement.innerHTML = context.messageFormatting(
                            messageData.mes,
                            messageData.name,
                            messageData.is_system,
                            messageData.is_user,
                            lastMessageIndex,
                        );
                    }

                    mesDom.querySelectorAll('.swipes-counter').forEach(counter => {
                        counter.textContent = `${messageData.swipe_id + 1}/${messageData.swipes.length}`;
                    });
                }

                eventSource.emit(event_types.MESSAGE_SWIPED, lastMessageIndex);
                await new Promise(resolve => setTimeout(resolve, 150));
            }
        }

        context = getContext();
        if (typeof context?.swipe?.right !== 'function') {
            alert('Guided Swipe Error: SillyTavern swipe generation API is not available.');
            return false;
        }

        debugLog('[Swipe] Calling context.swipe.right() to trigger new swipe generation.');
        context.swipe.right();

        await new Promise(resolve => {
            let resolved = false;
            const resolveOnce = () => {
                if (resolved) {
                    return;
                }
                resolved = true;
                eventSource.removeListener(event_types.GENERATION_ENDED, resolveOnce);
                eventSource.removeListener(event_types.GENERATION_STOPPED, resolveOnce);
                resolve();
            };
            eventSource.once(event_types.GENERATION_ENDED, resolveOnce);
            eventSource.once(event_types.GENERATION_STOPPED, resolveOnce);
        });
        await new Promise(resolve => setTimeout(resolve, 200));
        return true;
    } catch (error) {
        console.error('[GuidedGenerations][Swipe] Error during swipe generation process:', error);
        const errorMessage = String(error?.message || error);
        alert(errorMessage.startsWith('Guided Swipe Error:') ? errorMessage : `Guided Swipe Error: ${errorMessage}`);
        return false;
    }
}

async function guidedSwipe() {
    const textarea = document.getElementById('send_textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) {
        console.error('[GuidedGenerations][Swipe] Textarea #send_textarea not found.');
        alert('Guided Swipe Error: Textarea not found.');
        return;
    }

    const originalInput = textarea.value;
    if (!originalInput.trim()) {
        debugLog('[Swipe] No input detected, performing plain swipe.');
        await generateNewSwipe();
        return;
    }

    const settings = extension_settings[extensionName] ?? {};
    const injectionRole = settings.injectionEndRole ?? 'system';
    const depth = settings.depthPromptGuidedSwipe ?? 0;
    const promptTemplate = settings.promptGuidedSwipe ?? '';
    const filledPrompt = applyPromptTemplate(promptTemplate, originalInput);

    try {
        setPreviousImpersonateInput(originalInput);
        const stscriptCommand = `/inject id=${guidedSwipeInjectId} position=chat ephemeral=true scan=true depth=${depth} role=${injectionRole} ${filledPrompt} |`;
        await executeSTScriptCommand(stscriptCommand);
        debugLog('[Swipe] Executed command:', stscriptCommand);

        let injectionFound = false;
        for (let i = 0; i < 5; i++) {
            if (getContext().chatMetadata?.script_injects?.[guidedSwipeInjectId]) {
                injectionFound = true;
                break;
            }

            await new Promise(resolve => setTimeout(resolve, 150));
        }

        if (!injectionFound) {
            alert('Guided Swipe Error: Could not verify instruction injection. Aborting swipe generation.');
            textarea.value = originalInput;
            await executeSTScriptCommand(`/flushinject ${guidedSwipeInjectId}`);
            return;
        }

        await generateNewSwipe();
    } catch (error) {
        console.error('[GuidedGenerations][Swipe] Error during guided swipe execution:', error);
        const errorMessage = String(error?.message || error);
        if (!errorMessage.startsWith('Guided Swipe Error:')) {
            alert(`Guided Swipe Error: ${errorMessage}`);
        }
    } finally {
        textarea.value = getPreviousImpersonateInput();
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        try {
            await executeSTScriptCommand(`/flushinject ${guidedSwipeInjectId}`);
        } catch (error) {
            console.warn('[GuidedGenerations][Swipe] Could not flush guided swipe injection:', error);
        }
    }
}

export { generateNewSwipe, guidedSwipe };
