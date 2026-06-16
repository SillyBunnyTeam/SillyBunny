import { getMessageTimeStamp } from './RossAscends-mods.js';
import { eventSource, event_types } from './events.js';
import { selected_group } from './group-chats.js';
import { world_names } from './world-info.js';
import { addOneMessage, chat, characters, Generate, generateRaw, is_send_press, name1, saveChat, this_chid } from '../script.js';

const SETTINGS_KEY_PREFIX = 'sb_conv_settings_';
const LAST_USER_ACTIVITY_PREFIX = 'sb_conv_last_user_activity_';
const LAST_AUTO_MESSAGE_PREFIX = 'sb_conv_last_auto_msg_';
const LAST_SCHEDULE_TRIGGER_PREFIX = 'sb_conv_last_trigger_';
const LAST_IDLE_SESSION_PREFIX = 'sb_conv_last_idle_session_';
const LAST_CHIME_SESSION_PREFIX = 'sb_conv_last_chime_session_';
const AUTO_WORKER_INTERVAL_MS = 30000;

const DEFAULT_SETTINGS = Object.freeze({
    availability: 'online',
    idle_action: 'disabled',
    idle_limit: 15,
    offline_message: '[{{char}} is currently offline. Leave a message!]',
    auto_message: false,
    cooldown: 60,
    ai_schedule: '',
    geechan_prompt: false,
    multi_char: false,
    multi_char_names: '',
    lorebook_override: '',
    authors_note: '',
    editable_messages: true,
    prose_polisher: false,
    spontaneous_selfies: false,
    selfie_prompt: 'raw photo, selfie of {{char}}',
});

const SETTINGS_FIELDS = Object.freeze([
    { id: 'sb_conv_availability', key: 'availability', prop: 'value' },
    { id: 'sb_conv_idle_action', key: 'idle_action', prop: 'value' },
    { id: 'sb_conv_idle_limit', key: 'idle_limit', prop: 'value', type: 'number', fallback: DEFAULT_SETTINGS.idle_limit, min: 1 },
    { id: 'sb_conv_offline_message', key: 'offline_message', prop: 'value' },
    { id: 'sb_conv_auto_message', key: 'auto_message', prop: 'checked' },
    { id: 'sb_conv_cooldown', key: 'cooldown', prop: 'value', type: 'number', fallback: DEFAULT_SETTINGS.cooldown, min: 1 },
    { id: 'sb_conv_ai_schedule', key: 'ai_schedule', prop: 'value' },
    { id: 'sb_conv_geechan_prompt', key: 'geechan_prompt', prop: 'checked' },
    { id: 'sb_conv_multi_char', key: 'multi_char', prop: 'checked' },
    { id: 'sb_conv_multi_char_names', key: 'multi_char_names', prop: 'value' },
    { id: 'sb_conv_lorebook_override', key: 'lorebook_override', prop: 'value' },
    { id: 'sb_conv_authors_note', key: 'authors_note', prop: 'value' },
    { id: 'sb_conv_editable_messages', key: 'editable_messages', prop: 'checked' },
    { id: 'sb_conv_prose_polisher', key: 'prose_polisher', prop: 'checked' },
    { id: 'sb_conv_spontaneous_selfies', key: 'spontaneous_selfies', prop: 'checked' },
    { id: 'sb_conv_selfie_prompt', key: 'selfie_prompt', prop: 'value' },
]);

let initialized = false;
let autoWorkerBusy = false;
let pendingWorldRestore = null;

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getCurrentCharacter() {
    if (typeof this_chid === 'undefined' || !Array.isArray(characters)) {
        return null;
    }

    return characters[this_chid] ?? null;
}

function getCurrentCharAvatar() {
    return getCurrentCharacter()?.avatar ?? null;
}

function getCurrentCharName(fallback = 'Character') {
    return getCurrentCharacter()?.name || fallback;
}

function getCharacterStorageKey(prefix, avatar) {
    return `${prefix}${avatar}`;
}

function parsePositiveInt(value, fallback, min = 1) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function safeParseSettings(stored) {
    if (!stored) {
        return { ...DEFAULT_SETTINGS };
    }

    try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

function getSettings(avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return { ...DEFAULT_SETTINGS };
    }

    return safeParseSettings(localStorage.getItem(getCharacterStorageKey(SETTINGS_KEY_PREFIX, avatar)));
}

function saveSettings(avatar, settings) {
    if (!avatar) {
        return;
    }

    localStorage.setItem(getCharacterStorageKey(SETTINGS_KEY_PREFIX, avatar), JSON.stringify(settings));
}

function getLastUserActivity(avatar, fallback = Date.now()) {
    return parsePositiveInt(localStorage.getItem(getCharacterStorageKey(LAST_USER_ACTIVITY_PREFIX, avatar)), fallback, 1);
}

function setLastUserActivity(avatar, timestamp = Date.now()) {
    localStorage.setItem(getCharacterStorageKey(LAST_USER_ACTIVITY_PREFIX, avatar), String(timestamp));
}

function updateLastUserActivity() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        return;
    }

    setLastUserActivity(avatar);
}

function readSettingsFromPanel(avatar) {
    const settings = getSettings(avatar);

    for (const field of SETTINGS_FIELDS) {
        const element = document.getElementById(field.id);
        if (!(element instanceof HTMLElement)) {
            continue;
        }

        if (field.prop === 'checked') {
            settings[field.key] = Boolean(element.checked);
        } else if (field.type === 'number') {
            settings[field.key] = parsePositiveInt(element.value, field.fallback, field.min);
        } else {
            settings[field.key] = element.value ?? '';
        }
    }

    return settings;
}

function saveCurrentPanelSettings() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        return;
    }

    saveSettings(avatar, readSettingsFromPanel(avatar));
    updateProsePolisherButtonVisibility();
    updateEditableMessageButtons();
}

function applySettingsToPanel(settings) {
    for (const field of SETTINGS_FIELDS) {
        const element = document.getElementById(field.id);
        if (!(element instanceof HTMLElement)) {
            continue;
        }

        if (field.prop === 'checked') {
            element.checked = Boolean(settings[field.key]);
        } else {
            element.value = settings[field.key] ?? '';
        }
    }
}

function loadCurrentPanelSettings() {
    const avatar = getCurrentCharAvatar();

    if (!avatar) {
        applySettingsToPanel(DEFAULT_SETTINGS);
        updateProsePolisherButtonVisibility();
        updateEditableMessageButtons();
        return;
    }

    applySettingsToPanel(getSettings(avatar));
    updateProsePolisherButtonVisibility();
    updateEditableMessageButtons();
}

function updateProsePolisherButtonVisibility() {
    const button = document.getElementById('sb_prose_polisher_but');
    if (!(button instanceof HTMLElement)) {
        return;
    }

    const avatar = getCurrentCharAvatar();
    const shouldShow = Boolean(!selected_group && avatar && getSettings(avatar).prose_polisher);
    button.classList.toggle('displayNone', !shouldShow);
    button.hidden = !shouldShow;
}

function updateEditableMessageButtons() {
    $('.sb_quick_edit_btn').remove();
    $('.sb-message-has-quick-edit').removeClass('sb-message-has-quick-edit');

    const avatar = getCurrentCharAvatar();
    if (selected_group || !avatar || !getSettings(avatar).editable_messages) {
        return;
    }

    $('.mes').each(function () {
        const message = $(this);
        const editButton = message.find('.mes_edit').first();

        if (!editButton.length) {
            return;
        }

        const button = $('<button class="sb_quick_edit_btn fa-solid fa-pencil interactable" type="button" title="Edit Message" aria-label="Edit Message"></button>');
        button.on('click', (event) => {
            event.stopPropagation();
            editButton.trigger('click');
        });

        message.addClass('sb-message-has-quick-edit');
        message.append(button);
    });
}

async function handleProsePolish() {
    const textElement = document.getElementById('send_textarea');
    if (!(textElement instanceof HTMLTextAreaElement)) {
        return;
    }

    const originalText = textElement.value.trim();
    if (!originalText) {
        return;
    }

    const wand = document.getElementById('sb_prose_polisher_but');
    if (wand instanceof HTMLElement) {
        wand.classList.remove('fa-wand-magic-sparkles');
        wand.classList.add('fa-spinner', 'fa-spin');
    }

    try {
        const systemPrompt = 'You are a professional prose and roleplay editor. Polish the user\'s message by correcting typos, spelling, punctuation, and style while keeping the meaning and intent identical. Output only the polished message text.';
        const prompt = `Polish this message text:\n"${originalText}"`;
        const response = await generateRaw({
            prompt,
            systemPrompt,
            responseLength: 200,
            trimNames: true,
        });

        if (response?.trim()) {
            textElement.value = response.trim();
            textElement.dispatchEvent(new Event('input', { bubbles: true }));
            globalThis.toastr?.success?.('Prose polished successfully!');
        } else {
            globalThis.toastr?.error?.('Polishing failed. No response received.');
        }
    } catch (error) {
        console.error('Prose polishing error:', error);
        globalThis.toastr?.error?.('Error polishing message.');
    } finally {
        if (wand instanceof HTMLElement) {
            wand.classList.remove('fa-spinner', 'fa-spin');
            wand.classList.add('fa-wand-magic-sparkles');
        }
    }
}

async function appendConversationMessage(messageText, { name = getCurrentCharName(), extra = {} } = {}) {
    const message = {
        name,
        is_user: false,
        is_system: false,
        mes: messageText,
        send_date: getMessageTimeStamp(),
        extra,
    };

    chat.push(message);
    addOneMessage(message);
    await saveChat();
    updateEditableMessageButtons();
    return message;
}

function buildAutoMessageDirective(directive, settings) {
    let fullDirective = directive;

    if (settings.spontaneous_selfies) {
        const selfiePrompt = (settings.selfie_prompt || DEFAULT_SETTINGS.selfie_prompt).replace('{{char}}', getCurrentCharName());
        fullDirective += `\n[Selfie directive: If an image would fit the moment, include a Stable Diffusion slash command on its own line: /imagine ${selfiePrompt}]`;
    }

    return fullDirective;
}

async function triggerAutoMessage(directive, settings, extra = {}) {
    if (autoWorkerBusy || selected_group || is_send_press || !getCurrentCharacter()) {
        return false;
    }

    autoWorkerBusy = true;

    try {
        const quietPrompt = buildAutoMessageDirective(directive, settings);
        const response = await Generate('quiet', {
            automatic_trigger: true,
            quiet_prompt: quietPrompt,
            quietToLoud: true,
            suppressUserMessage: true,
        });

        if (response?.trim()) {
            await appendConversationMessage(response.trim(), {
                extra: {
                    conversation_mode_auto: true,
                    ...extra,
                },
            });
            return true;
        }
    } catch (error) {
        console.error('Conversation auto-message error:', error);
        globalThis.toastr?.warning?.('Conversation Mode auto-message failed.');
    } finally {
        autoWorkerBusy = false;
    }

    return false;
}

function getCurrentMinuteKey(date = new Date()) {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
}

function getCurrentDayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getLastAutoMessageTime(avatar) {
    return parsePositiveInt(localStorage.getItem(getCharacterStorageKey(LAST_AUTO_MESSAGE_PREFIX, avatar)), 0, 0);
}

function setLastAutoMessageTime(avatar, timestamp = Date.now()) {
    localStorage.setItem(getCharacterStorageKey(LAST_AUTO_MESSAGE_PREFIX, avatar), String(timestamp));
}

function getScheduleTriggerState(avatar) {
    try {
        return JSON.parse(localStorage.getItem(getCharacterStorageKey(LAST_SCHEDULE_TRIGGER_PREFIX, avatar))) || {};
    } catch {
        return {};
    }
}

function setScheduleTriggered(avatar, triggerKey, timestamp) {
    const state = getScheduleTriggerState(avatar);
    state[triggerKey] = timestamp;

    const stateEntries = Object.entries(state).sort((first, second) => first[1] - second[1]);
    while (stateEntries.length > 100) {
        const [oldestKey] = stateEntries.shift();
        delete state[oldestKey];
    }

    localStorage.setItem(getCharacterStorageKey(LAST_SCHEDULE_TRIGGER_PREFIX, avatar), JSON.stringify(state));
}

function hasScheduleTriggered(avatar, triggerKey) {
    return Object.prototype.hasOwnProperty.call(getScheduleTriggerState(avatar), triggerKey);
}

async function checkScheduledAutoMessages(avatar, settings, now) {
    if (!settings.auto_message || !settings.ai_schedule) {
        return false;
    }

    const currentDate = new Date(now);
    const currentMinute = getCurrentMinuteKey(currentDate);
    const currentDay = getCurrentDayKey(currentDate);

    for (const line of settings.ai_schedule.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        const absoluteMatch = trimmed.match(/^(\d{2}):(\d{2})\s*-\s*(.*)$/);
        if (absoluteMatch && `${absoluteMatch[1]}:${absoluteMatch[2]}` === currentMinute) {
            const triggerKey = `absolute:${currentDay}:${currentMinute}:${trimmed}`;
            if (hasScheduleTriggered(avatar, triggerKey)) {
                continue;
            }

            const triggered = await triggerAutoMessage(`[System directive: Your schedule is due: "${absoluteMatch[3]}". Send a message with this context in mind.]`, settings, { schedule: trimmed });
            if (triggered) {
                setScheduleTriggered(avatar, triggerKey, now);
                setLastAutoMessageTime(avatar, now);
            }

            return triggered;
        }

        const relativeMatch = trimmed.match(/^(\d+)\s*-\s*(.*)$/);
        if (relativeMatch) {
            const delayMinutes = parsePositiveInt(relativeMatch[1], 0, 0);
            const lastUserActivity = getLastUserActivity(avatar, now);
            const elapsedMinutes = (now - lastUserActivity) / (60 * 1000);

            if (delayMinutes > 0 && elapsedMinutes >= delayMinutes) {
                const triggerKey = `relative:${lastUserActivity}:${trimmed}`;
                if (hasScheduleTriggered(avatar, triggerKey)) {
                    continue;
                }

                const triggered = await triggerAutoMessage(`[System directive: You are sending a check-in due to ${delayMinutes} minutes of silence: "${relativeMatch[2]}".]`, settings, { schedule: trimmed });
                if (triggered) {
                    setScheduleTriggered(avatar, triggerKey, now);
                    setLastAutoMessageTime(avatar, now);
                }

                return triggered;
            }
        }
    }

    return false;
}

async function checkIdleAutoMessage(avatar, settings, now) {
    if (settings.idle_action === 'disabled') {
        return false;
    }

    const lastUserActivity = getLastUserActivity(avatar, now);
    const idleMinutes = (now - lastUserActivity) / (60 * 1000);

    if (idleMinutes < settings.idle_limit) {
        return false;
    }

    const sessionKey = getCharacterStorageKey(LAST_IDLE_SESSION_PREFIX, avatar);
    if (localStorage.getItem(sessionKey) === String(lastUserActivity)) {
        return false;
    }

    const directive = settings.idle_action === 'followup'
        ? '[System directive: The user has been quiet for a while. Send a casual auto follow-up checking in or asking what they are up to.]'
        : '[System directive: Send a spontaneous ping to the user, starting a new topic or sharing a casual thought.]';

    const triggered = await triggerAutoMessage(directive, settings, { idle_action: settings.idle_action });
    if (triggered) {
        localStorage.setItem(sessionKey, String(lastUserActivity));
        setLastAutoMessageTime(avatar, now);
    }

    return triggered;
}

async function triggerMultiCharacterChime(settings) {
    const partners = settings.multi_char_names.split(',').map(name => name.trim()).filter(Boolean);
    if (!partners.length || autoWorkerBusy) {
        return false;
    }

    autoWorkerBusy = true;

    try {
        const partnerName = partners[Math.floor(Math.random() * partners.length)];
        const charName = getCurrentCharName();
        const userName = name1 || 'User';
        const systemPrompt = `You are playing the role of ${partnerName}, chiming in on a Discord conversation between ${charName} and ${userName}. Write a short, casual message responding to the latest conversation context. Format your message exactly beginning with **${partnerName}:** followed by your message body.`;
        const prompt = `Write a short, engaging chatroom message from ${partnerName}'s perspective.`;
        const response = await generateRaw({
            prompt,
            systemPrompt,
            responseLength: 150,
            trimNames: false,
        });

        if (response?.trim()) {
            await appendConversationMessage(response.trim(), {
                name: partnerName,
                extra: {
                    conversation_mode_chime: true,
                },
            });
            return true;
        }
    } catch (error) {
        console.error('Multi-character chime error:', error);
    } finally {
        autoWorkerBusy = false;
    }

    return false;
}

async function checkMultiCharacterChime(avatar, settings, now) {
    if (!settings.multi_char || !settings.multi_char_names) {
        return false;
    }

    const lastUserActivity = getLastUserActivity(avatar, now);
    const idleMinutes = (now - lastUserActivity) / (60 * 1000);

    if (idleMinutes < settings.idle_limit / 2) {
        return false;
    }

    const sessionKey = getCharacterStorageKey(LAST_CHIME_SESSION_PREFIX, avatar);
    if (localStorage.getItem(sessionKey) === String(lastUserActivity)) {
        return false;
    }

    const triggered = await triggerMultiCharacterChime(settings);
    if (triggered) {
        localStorage.setItem(sessionKey, String(lastUserActivity));
        setLastAutoMessageTime(avatar, now);
    }

    return triggered;
}

async function conversationModeAutoMessageWorker() {
    if (autoWorkerBusy || selected_group || is_send_press) {
        return;
    }

    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        return;
    }

    const settings = getSettings(avatar);
    const now = Date.now();
    const elapsedSeconds = (now - getLastAutoMessageTime(avatar)) / 1000;
    if (elapsedSeconds < settings.cooldown) {
        return;
    }

    if (await checkScheduledAutoMessages(avatar, settings, now)) {
        return;
    }

    if (await checkIdleAutoMessage(avatar, settings, now)) {
        return;
    }

    await checkMultiCharacterChime(avatar, settings, now);
}

async function handleAvailabilityAutoResponder(messageId) {
    if (selected_group) {
        return;
    }

    const message = chat[messageId];
    if (!message?.is_user) {
        return;
    }

    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        return;
    }

    const settings = getSettings(avatar);
    if (!['offline', 'dnd'].includes(settings.availability)) {
        return;
    }

    $('#mes_stop:visible').trigger('click');
    await delay(250);

    const offlineText = (settings.offline_message || DEFAULT_SETTINGS.offline_message).replace('{{char}}', getCurrentCharName());
    await appendConversationMessage(offlineText, {
        extra: {
            conversation_mode_auto_responder: true,
            availability: settings.availability,
        },
    });
}

function appendPromptText(data, key, text) {
    data[key] = `${data[key] || ''}\n\n${text}`;
}

function applyPromptOverrides(data) {
    if (selected_group) {
        return;
    }

    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        return;
    }

    const settings = getSettings(avatar);

    if (settings.geechan_prompt) {
        appendPromptText(data, 'main', `[System directive: Geechan is a participant in a messaging interface. Format your message beginning with the sender name, followed by a colon and the message body, like: **${data.char}:** message content. Keep actions, expression, and thoughts wrapped in markdown italics or nested inside the message body.]`);
    }

    if (settings.authors_note) {
        const note = settings.authors_note.replace('{{char}}', data.char).replace('{{user}}', data.user);
        appendPromptText(data, 'storyString', note);
    }

    if (settings.lorebook_override && Array.isArray(world_names)) {
        const character = getCurrentCharacter();
        const match = world_names.find(worldName => worldName.toLowerCase() === settings.lorebook_override.toLowerCase());

        if (character && match) {
            pendingWorldRestore = {
                chid: this_chid,
                world: character.world,
            };
            character.world = match;
        }
    }
}

function restorePromptOverrides() {
    if (!pendingWorldRestore) {
        return;
    }

    const character = characters[pendingWorldRestore.chid];
    if (character) {
        character.world = pendingWorldRestore.world;
    }

    pendingWorldRestore = null;
}

function handleChatChanged() {
    loadCurrentPanelSettings();
    updateLastUserActivity();
}

function bindPanelInputs() {
    const panel = document.getElementById('sb_character_conversation_panel');
    if (panel instanceof HTMLElement && panel.dataset.sbConversationBound !== 'true') {
        panel.dataset.sbConversationBound = 'true';
        panel.addEventListener('change', saveCurrentPanelSettings);
        panel.addEventListener('input', saveCurrentPanelSettings);
    }
}

function bindProsePolisher() {
    const polishButton = document.getElementById('sb_prose_polisher_but');
    if (polishButton instanceof HTMLElement && polishButton.dataset.sbConversationBound !== 'true') {
        polishButton.dataset.sbConversationBound = 'true';
        polishButton.addEventListener('click', handleProsePolish);
    }
}

function init() {
    if (initialized) {
        return;
    }

    initialized = true;
    eventSource.on(event_types.USER_MESSAGE_RENDERED, async (messageId) => {
        updateLastUserActivity();
        updateEditableMessageButtons();
        await handleAvailabilityAutoResponder(messageId);
    });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, updateEditableMessageButtons);
    eventSource.on(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, applyPromptOverrides);
    eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, restorePromptOverrides);
    eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);
    eventSource.on(event_types.CHAT_LOADED, handleChatChanged);

    bindPanelInputs();
    bindProsePolisher();
    window.setInterval(() => void conversationModeAutoMessageWorker(), AUTO_WORKER_INTERVAL_MS);
    loadCurrentPanelSettings();
}

eventSource.on(event_types.APP_READY, init);
