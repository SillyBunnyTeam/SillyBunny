import { Generate, eventSource, event_types, is_send_press } from '../../../../script.js';
import { is_group_generating } from '../../../group-chats.js';
import {
    applyPromptTemplate,
    debugLog,
    extensionName,
    extension_settings,
    getContext,
    guidedCorrectionInjectId,
    getLastAiMessage,
} from './shared.js';

async function executeSTScriptCommand(command) {
    const context = getContext();
    if (typeof context?.executeSlashCommandsWithOptions !== 'function') {
        throw new Error('SillyTavern slash command execution is not available.');
    }

    await context.executeSlashCommandsWithOptions(command);
}

async function waitForInjection(id) {
    for (let i = 0; i < 5; i++) {
        if (getContext().chatMetadata?.script_injects?.[id]) {
            return true;
        }

        await new Promise(resolve => setTimeout(resolve, 150));
    }

    return false;
}

function getTargetForceCharacterId(message) {
    const context = getContext();
    if (!context?.groupId || !Array.isArray(context.characters)) {
        return undefined;
    }

    const avatar = message?.original_avatar;
    if (avatar) {
        const avatarIndex = context.characters.findIndex(character => character?.avatar === avatar);
        if (avatarIndex !== -1) {
            return avatarIndex;
        }
    }

    const name = String(message?.name ?? '').trim();
    if (!name) {
        return undefined;
    }

    const nameIndex = context.characters.findIndex(character => character?.name === name);
    return nameIndex !== -1 ? nameIndex : undefined;
}

async function isolateTargetMessage(context, targetIndex) {
    const trailingMessages = context.chat.slice(targetIndex + 1);
    if (trailingMessages.length === 0) {
        return trailingMessages;
    }

    context.chat.length = targetIndex + 1;
    await context.redisplayChat({ targetChat: context.chat, startIndex: targetIndex, fade: false });
    return trailingMessages;
}

async function restoreTrailingMessages(context, targetIndex, trailingMessages) {
    if (trailingMessages.length === 0) {
        return;
    }

    context.chat.splice(targetIndex + 1, 0, ...trailingMessages);
    await context.redisplayChat({ targetChat: context.chat, startIndex: targetIndex + 1, fade: false });
    await context.saveChat();
}

async function restoreChatSnapshot(context, chatSnapshot, startIndex) {
    context.chat.length = 0;
    context.chat.push(...chatSnapshot);
    await context.redisplayChat({ targetChat: context.chat, startIndex, fade: false });
    await context.saveChat();
}

function cloneChatMessage(message) {
    const clone = { ...message };

    if (message?.extra && typeof message.extra === 'object') {
        clone.extra = { ...message.extra };
    }

    if (Array.isArray(message?.swipes)) {
        clone.swipes = [...message.swipes];
    }

    return clone;
}

function copyGeneratedMessageToTarget(targetMessage, generatedMessage) {
    const preservedIdentity = {
        name: targetMessage.name,
        is_user: targetMessage.is_user,
        is_system: targetMessage.is_system,
        force_avatar: targetMessage.force_avatar,
        original_avatar: targetMessage.original_avatar,
        send_date: targetMessage.send_date,
    };
    const originalExtra = { ...(targetMessage.extra ?? {}) };
    const generatedExtra = { ...(generatedMessage.extra ?? {}) };
    const generatedSwipes = Array.isArray(generatedMessage.swipes) ? [...generatedMessage.swipes] : undefined;

    for (const key of Object.keys(targetMessage)) {
        delete targetMessage[key];
    }

    Object.assign(targetMessage, generatedMessage, preservedIdentity);
    targetMessage.extra = { ...originalExtra, ...generatedExtra };

    if (generatedSwipes) {
        targetMessage.swipes = generatedSwipes;
    }
}

async function applyAppendedGenerationToTarget(context, targetIndex, targetMessage) {
    if (context.chat[targetIndex] !== targetMessage) {
        return false;
    }

    const generatedIndex = context.chat.length - 1;
    const generatedMessage = context.chat[generatedIndex];
    if (generatedIndex <= targetIndex || !generatedMessage || generatedMessage.is_user || generatedMessage.is_system) {
        return false;
    }

    copyGeneratedMessageToTarget(targetMessage, generatedMessage);
    context.updateMessageBlock(targetIndex, targetMessage);
    await eventSource.emit(event_types.MESSAGE_EDITED, targetIndex);
    await eventSource.emit(event_types.MESSAGE_UPDATED, targetIndex);
    await context.deleteMessage(generatedIndex, undefined, false);
    await context.saveChat();
    return true;
}

async function generateCorrection(target) {
    const forceCharacterId = getTargetForceCharacterId(target.message);
    const options = { preserveLastMessage: true };

    if (forceCharacterId !== undefined) {
        options.force_chid = forceCharacterId;
    }

    await Generate('regenerate', options);
}

async function guidedCorrection() {
    if (is_send_press || is_group_generating) {
        toastr.warning('Please wait for the current generation to complete.', 'Guided Correction');
        return;
    }

    const textarea = document.getElementById('send_textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) {
        console.error('[GuidedGenerations][Correction] Textarea #send_textarea not found.');
        return;
    }

    const originalInput = textarea.value;
    if (!originalInput.trim()) {
        toastr.warning('Please enter a correction instruction.', 'Guided Correction');
        return;
    }

    const target = getLastAiMessage();
    if (!target) {
        toastr.error('No AI message found to correct.', 'Guided Correction');
        return;
    }

    const context = getContext();
    const chatSnapshot = context.chat.map(cloneChatMessage);
    let trailingMessages = [];
    let didRestoreSnapshot = false;

    try {
        const settings = extension_settings[extensionName] ?? {};
        const injectionRole = settings.injectionEndRole ?? 'system';
        const depth = settings.depthPromptGuidedCorrection ?? 0;
        const promptTemplate = settings.promptGuidedCorrection ?? '';
        const filledPrompt = applyPromptTemplate(promptTemplate, originalInput);
        const stscriptCommand = `/inject id=${guidedCorrectionInjectId} position=chat ephemeral=true scan=true depth=${depth} role=${injectionRole} ${filledPrompt} |`;

        await executeSTScriptCommand(stscriptCommand);
        debugLog('[Correction] Executed command:', stscriptCommand);

        if (!await waitForInjection(guidedCorrectionInjectId)) {
            toastr.error('Could not verify correction instruction injection.', 'Guided Correction');
            return;
        }

        trailingMessages = await isolateTargetMessage(context, target.index);

        if (context.groupId) {
            textarea.value = '';
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }

        await generateCorrection(target);
        const targetWasUpdatedInPlace = await applyAppendedGenerationToTarget(context, target.index, target.message);
        const regeneratedMessage = context.chat[target.index];
        const targetWasRegenerated = Boolean(regeneratedMessage && regeneratedMessage !== target.message && !regeneratedMessage.is_user && !regeneratedMessage.is_system);

        if (!targetWasRegenerated && !targetWasUpdatedInPlace) {
            await restoreChatSnapshot(context, chatSnapshot, target.index);
            didRestoreSnapshot = true;
            toastr.error('Guided Correction did not produce a replacement message.', 'Guided Correction');
            return;
        }

        await restoreTrailingMessages(context, target.index, trailingMessages);
    } catch (error) {
        console.error('[GuidedGenerations][Correction] Error during guided correction execution:', error);

        if (!didRestoreSnapshot) {
            try {
                await restoreChatSnapshot(context, chatSnapshot, target.index);
            } catch (restoreError) {
                console.error('[GuidedGenerations][Correction] Could not restore chat after correction failure:', restoreError);
            }
        }

        toastr.error(String(error?.message || error), 'Guided Correction');
    } finally {
        textarea.value = originalInput;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        try {
            await executeSTScriptCommand(`/flushinject ${guidedCorrectionInjectId}`);
        } catch (error) {
            console.warn('[GuidedGenerations][Correction] Could not flush guided correction injection:', error);
        }
    }
}

export { guidedCorrection };
