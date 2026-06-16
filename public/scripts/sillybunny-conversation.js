/* global name1, world_names */
import { eventSource, event_types } from './events.js';
import { generateRaw, characters, this_chid, selected_group, chat, saveChat, addOneMessage, Generate } from '../script.js';

// Default settings object for new characters
const DEFAULT_SETTINGS = {
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
};

// State variables
let activeAutoTriggerReason = null;
let originalWorldName = null;

// Helpers to get current active character
function getCurrentCharAvatar() {
    if (typeof this_chid === 'undefined' || !characters || !characters[this_chid]) {
        return null;
    }
    return characters[this_chid].avatar;
}

// Load settings from localStorage
function getSettings(avatar) {
    if (!avatar) return { ...DEFAULT_SETTINGS };
    const stored = localStorage.getItem(`sb_conv_settings_${avatar}`);
    if (!stored) return { ...DEFAULT_SETTINGS };
    try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
    } catch (e) {
        return { ...DEFAULT_SETTINGS };
    }
}

// Save settings to localStorage
function saveSettings(avatar, settings) {
    if (!avatar) return;
    localStorage.setItem(`sb_conv_settings_${avatar}`, JSON.stringify(settings));
}

// Track user activity for Idle silence limits
function updateLastUserActivity() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) return;
    localStorage.setItem(`sb_conv_last_user_activity_${avatar}`, String(Date.now()));
}

// Save panel settings
function saveCurrentPanelSettings() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) return;

    const settings = {
        availability: document.getElementById('sb_conv_availability')?.value || 'online',
        idle_action: document.getElementById('sb_conv_idle_action')?.value || 'disabled',
        idle_limit: parseInt(document.getElementById('sb_conv_idle_limit')?.value) || 15,
        offline_message: document.getElementById('sb_conv_offline_message')?.value || '',
        auto_message: document.getElementById('sb_conv_auto_message')?.checked || false,
        cooldown: parseInt(document.getElementById('sb_conv_cooldown')?.value) || 60,
        ai_schedule: document.getElementById('sb_conv_ai_schedule')?.value || '',
        geechan_prompt: document.getElementById('sb_conv_geechan_prompt')?.checked || false,
        multi_char: document.getElementById('sb_conv_multi_char')?.checked || false,
        multi_char_names: document.getElementById('sb_conv_multi_char_names')?.value || '',
        lorebook_override: document.getElementById('sb_conv_lorebook_override')?.value || '',
        authors_note: document.getElementById('sb_conv_authors_note')?.value || '',
        editable_messages: document.getElementById('sb_conv_editable_messages')?.checked || false,
        prose_polisher: document.getElementById('sb_conv_prose_polisher')?.checked || false,
        spontaneous_selfies: document.getElementById('sb_conv_spontaneous_selfies')?.checked || false,
        selfie_prompt: document.getElementById('sb_conv_selfie_prompt')?.value || '',
    };

    saveSettings(avatar, settings);
    updateProsePolisherButtonVisibility();
    updateEditableMessageButtons();
}

// Populate panel input values from loaded settings
function loadCurrentPanelSettings() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) return;
    const settings = getSettings(avatar);

    const fields = [
        { id: 'sb_conv_availability', prop: 'value', key: 'availability' },
        { id: 'sb_conv_idle_action', prop: 'value', key: 'idle_action' },
        { id: 'sb_conv_idle_limit', prop: 'value', key: 'idle_limit' },
        { id: 'sb_conv_offline_message', prop: 'value', key: 'offline_message' },
        { id: 'sb_conv_auto_message', prop: 'checked', key: 'auto_message' },
        { id: 'sb_conv_cooldown', prop: 'value', key: 'cooldown' },
        { id: 'sb_conv_ai_schedule', prop: 'value', key: 'ai_schedule' },
        { id: 'sb_conv_geechan_prompt', prop: 'checked', key: 'geechan_prompt' },
        { id: 'sb_conv_multi_char', prop: 'checked', key: 'multi_char' },
        { id: 'sb_conv_multi_char_names', prop: 'value', key: 'multi_char_names' },
        { id: 'sb_conv_lorebook_override', prop: 'value', key: 'lorebook_override' },
        { id: 'sb_conv_authors_note', prop: 'value', key: 'authors_note' },
        { id: 'sb_conv_editable_messages', prop: 'checked', key: 'editable_messages' },
        { id: 'sb_conv_prose_polisher', prop: 'checked', key: 'prose_polisher' },
        { id: 'sb_conv_spontaneous_selfies', prop: 'checked', key: 'spontaneous_selfies' },
        { id: 'sb_conv_selfie_prompt', prop: 'value', key: 'selfie_prompt' },
    ];

    for (const field of fields) {
        const el = document.getElementById(field.id);
        if (el) {
            el[field.prop] = settings[field.key];
        }
    }

    updateProsePolisherButtonVisibility();
    updateEditableMessageButtons();
}

// Toggle visibility of the magic wand Prose Polisher button next to send textarea
function updateProsePolisherButtonVisibility() {
    const button = document.getElementById('sb_prose_polisher_but');
    if (!button) return;

    if (selected_group) {
        button.style.display = 'none';
        return;
    }

    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        button.style.display = 'none';
        return;
    }

    const settings = getSettings(avatar);
    if (settings.prose_polisher) {
        button.style.display = 'flex';
        button.classList.remove('displayNone');
    } else {
        button.style.display = 'none';
        button.classList.add('displayNone');
    }
}

// Inject quick edit pencils on chat message elements for DMs
function updateEditableMessageButtons() {
    if (selected_group) {
        $('.sb_quick_edit_btn').remove();
        return;
    }

    const avatar = getCurrentCharAvatar();
    if (!avatar) return;

    const settings = getSettings(avatar);
    if (!settings.editable_messages) {
        $('.sb_quick_edit_btn').remove();
        return;
    }

    $('.mes').each(function () {
        const mes = $(this);
        if (mes.find('.sb_quick_edit_btn').length === 0) {
            const btn = $('<div class="sb_quick_edit_btn fa-solid fa-pencil interactable" title="Edit Message" style="position: absolute; right: 10px; top: 10px; cursor: pointer; opacity: 0.6; font-size: 0.9em; z-index: 10;"></div>');
            btn.on('click', (e) => {
                e.stopPropagation();
                mes.find('.mes_edit').first().trigger('click');
            });
            mes.css('position', 'relative');
            mes.append(btn);
        }
    });
}

// Call raw generation loop to improve text inside the send textarea
async function handleProsePolish() {
    const textEl = document.getElementById('send_textarea');
    if (!textEl) return;

    const originalText = textEl.value.trim();
    if (!originalText) return;

    const wand = document.getElementById('sb_prose_polisher_but');
    if (wand) {
        wand.classList.remove('fa-wand-magic-sparkles');
        wand.classList.add('fa-spinner', 'fa-spin');
    }

    try {
        const systemPrompt = 'You are a professional prose and roleplay editor. Your task is to polish, refine, and improve the user\'s message, correcting typos, spelling, punctuation, and style, while keeping the meaning and original intent identical. Output ONLY the polished message text, with no introductory or explanatory remarks, and no markdown wrapping other than the improved text itself.';
        const prompt = `Polish this message text:\n"${originalText}"`;

        const response = await generateRaw({
            prompt: prompt,
            systemPrompt: systemPrompt,
            responseLength: 200,
            trimNames: true,
        });

        if (response && response.trim()) {
            textEl.value = response.trim();
            textEl.dispatchEvent(new Event('input', { bubbles: true }));
            globalThis.toastr?.success?.('Prose polished successfully!');
        } else {
            globalThis.toastr?.error?.('Polishing failed. No response received.');
        }
    } catch (e) {
        console.error('Prose polishing error:', e);
        globalThis.toastr?.error?.('Error polishing message.');
    } finally {
        if (wand) {
            wand.classList.remove('fa-spinner', 'fa-spin');
            wand.classList.add('fa-wand-magic-sparkles');
        }
    }
}

// Background Worker: Checks schedule, idle status, multi-character chiming
function conversationModeAutoMessageWorker() {
    // If generation is actively running or a group is selected, skip
    const isGenerating = document.getElementById('mes_stop')?.style.display !== 'none';
    if (isGenerating || selected_group) return;

    const avatar = getCurrentCharAvatar();
    if (!avatar) return;

    const settings = getSettings(avatar);
    const now = Date.now();

    // Check Cooldown
    const lastMsgTime = parseInt(localStorage.getItem(`sb_conv_last_auto_msg_${avatar}`)) || 0;
    const elapsedSecs = (now - lastMsgTime) / 1000;
    if (elapsedSecs < settings.cooldown) return;

    // 1. Check Schedules
    if (settings.auto_message && settings.ai_schedule) {
        const currentDate = new Date();
        const HH = String(currentDate.getHours()).padStart(2, '0');
        const MM = String(currentDate.getMinutes()).padStart(2, '0');
        const currentMinute = `${HH}:${MM}`;

        const lastTriggeredKey = `sb_conv_last_trigger_${avatar}`;
        const lastTriggeredMinute = localStorage.getItem(lastTriggeredKey);

        if (lastTriggeredMinute !== currentMinute) {
            const lines = settings.ai_schedule.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                // Absolute daily schedule match
                const matchTime = trimmed.match(/^(\d{2}):(\d{2})\s*-\s*(.*)$/);
                if (matchTime) {
                    const schedTime = `${matchTime[1]}:${matchTime[2]}`;
                    if (schedTime === currentMinute) {
                        localStorage.setItem(lastTriggeredKey, currentMinute);
                        localStorage.setItem(`sb_conv_last_auto_msg_${avatar}`, String(now));
                        triggerAutoMessage(`[System Directive: Your schedule is due: "${matchTime[3]}". Start the message with this context in mind.]`, settings);
                        return;
                    }
                }

                // Relative delay interval match
                const matchDelay = trimmed.match(/^(\d+)\s*-\s*(.*)$/);
                if (matchDelay) {
                    const delayMins = parseInt(matchDelay[1]);
                    const lastActivityKey = `sb_conv_last_activity_${avatar}`;
                    const lastActivityTime = parseInt(localStorage.getItem(lastActivityKey)) || now;
                    const elapsedMins = (now - lastActivityTime) / (60 * 1000);

                    if (elapsedMins >= delayMins) {
                        localStorage.setItem(lastActivityKey, String(now));
                        localStorage.setItem(lastTriggeredKey, currentMinute);
                        localStorage.setItem(`sb_conv_last_auto_msg_${avatar}`, String(now));
                        triggerAutoMessage(`[System Directive: You are sending a check-in due to ${delayMins} minutes of silence: "${matchDelay[2]}".]`, settings);
                        return;
                    }
                }
            }
        }
    }

    // 2. Check Discord Pals User Idle
    if (settings.idle_action !== 'disabled') {
        const lastUserActivity = parseInt(localStorage.getItem(`sb_conv_last_user_activity_${avatar}`)) || now;
        const idleMins = (now - lastUserActivity) / (60 * 1000);

        if (idleMins >= settings.idle_limit) {
            const sessionKey = `sb_conv_last_idle_session_${avatar}`;
            const lastTriggeredSession = localStorage.getItem(sessionKey);

            if (lastTriggeredSession !== String(lastUserActivity)) {
                localStorage.setItem(sessionKey, String(lastUserActivity));
                localStorage.setItem(`sb_conv_last_auto_msg_${avatar}`, String(now));

                if (settings.idle_action === 'followup') {
                    triggerAutoMessage('[System Directive: The user has been quiet for a while. Send a casual auto follow-up checking in or asking what they are up to.]', settings);
                } else if (settings.idle_action === 'spontaneous') {
                    triggerAutoMessage('[System Directive: Send a spontaneous ping to the user, starting a new topic or sharing a casual thought.]', settings);
                }
                return;
            }
        }
    }

    // 3. Multi-Character Chiming
    if (settings.multi_char && settings.multi_char_names) {
        const lastUserActivity = parseInt(localStorage.getItem(`sb_conv_last_user_activity_${avatar}`)) || now;
        const idleMins = (now - lastUserActivity) / (60 * 1000);

        // If user is idle and partners can chime in
        if (idleMins >= settings.idle_limit / 2) {
            const sessionKey = `sb_conv_last_chime_session_${avatar}`;
            const lastChimeSession = localStorage.getItem(sessionKey);

            if (lastChimeSession !== String(lastUserActivity)) {
                localStorage.setItem(sessionKey, String(lastUserActivity));
                localStorage.setItem(`sb_conv_last_auto_msg_${avatar}`, String(now));
                triggerMultiCharacterChime(settings);
            }
        }
    }
}

// Fire automated generation with a schedule directive
function triggerAutoMessage(directive, settings) {
    activeAutoTriggerReason = directive;

    // Optionally append selfie generation directive
    if (settings.spontaneous_selfies) {
        let selfiePrompt = settings.selfie_prompt || 'raw photo, selfie of {{char}}';
        selfiePrompt = selfiePrompt.replace('{{char}}', characters[this_chid]?.name || 'Character');
        activeAutoTriggerReason += `\n[Selfie Generation Directive: Include the Stable Diffusion slash command '/imagine ${selfiePrompt}' in your message to capture a selfie of what you are doing.]`;
    }

    // Call SillyBunny generation loop
    Generate('normal', { automatic_trigger: true });
}

// Generate raw message from another character chiming in
async function triggerMultiCharacterChime(settings) {
    const partners = settings.multi_char_names.split(',').map(s => s.trim()).filter(Boolean);
    if (partners.length === 0) return;

    const partnerName = partners[Math.floor(Math.random() * partners.length)];
    const charName = characters[this_chid]?.name || 'Character';
    const userName = (typeof name1 !== 'undefined' ? name1 : null) || 'User';

    try {
        const systemPrompt = `You are playing the role of ${partnerName}, chiming in on a Discord conversation between ${charName} and ${userName}. Write a short, casual message responding to the latest conversation context. Format your message EXACTLY beginning with **${partnerName}:** followed by your message body. Example: "**${partnerName}:** Oh hey! What are you guys talking about?"`;
        const prompt = `Write a short, engaging chatroom message from the perspective of ${partnerName} chiming in.`;

        const response = await generateRaw({
            prompt: prompt,
            systemPrompt: systemPrompt,
            responseLength: 150,
            trimNames: false,
        });

        if (response && response.trim()) {
            const chimeMsg = {
                name: partnerName,
                is_user: false,
                is_system: false,
                mes: response.trim(),
                send_date: new Date().toLocaleTimeString(),
                extra: {
                    chime: true,
                },
            };
            chat.push(chimeMsg);
            addOneMessage(chimeMsg);
            saveChat();
        }
    } catch (e) {
        console.error('Multi-character chime error:', e);
    }
}

// INITIALIZATION
function init() {
    // 1. Listen for user messaging activity to reset idle timers
    eventSource.on(event_types.USER_MESSAGE_RENDERED, () => {
        updateLastUserActivity();
        updateEditableMessageButtons();
    });

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
        updateEditableMessageButtons();
    });

    // 2. Intercept and handle Offline auto-responders
    eventSource.on(event_types.USER_MESSAGE_RENDERED, async () => {
        if (selected_group) return;

        const avatar = getCurrentCharAvatar();
        if (!avatar) return;

        const settings = getSettings(avatar);
        if (settings.availability === 'offline' || settings.availability === 'dnd') {
            // Trigger abort immediately
            $('#mes_stop').trigger('click');

            // Small delay for generation abort to complete gracefully
            await new Promise(r => setTimeout(r, 250));

            let offlineText = settings.offline_message || '[{{char}} is currently offline. Leave a message!]';
            offlineText = offlineText.replace('{{char}}', characters[this_chid]?.name || 'Character');

            const responseMes = {
                name: characters[this_chid]?.name || 'Character',
                is_user: false,
                is_system: false,
                mes: offlineText,
                send_date: new Date().toLocaleTimeString(),
                extra: {
                    auto_responder: true,
                },
            };

            chat.push(responseMes);
            addOneMessage(responseMes);
            saveChat();
        }
    });

    // 3. Inject Geechan format, schedule directives, and Author's Notes at prompt compile
    eventSource.on(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, (data) => {
        if (selected_group) return;

        const avatar = getCurrentCharAvatar();
        if (!avatar) return;

        const settings = getSettings(avatar);

        // Geechan Prompt Formatting Override
        if (settings.geechan_prompt) {
            const geechanSystem = `\n\n[System directive: Geechan is a participant in a messaging interface. Format your message beginning with the name of the sender, followed by a colon and the message body, like: **${data.char}:** message content. Keep actions, expression, and thoughts wrapped in markdown italics *italics* or nested inside the message body.]`;
            data.main += geechanSystem;
        }

        // Author's Note Override
        if (settings.authors_note) {
            let note = settings.authors_note;
            note = note.replace('{{char}}', data.char).replace('{{user}}', data.user);
            data.storyString += `\n\n${note}`;
        }

        // Auto-message Directive Injection
        if (activeAutoTriggerReason) {
            data.main += `\n\n${activeAutoTriggerReason}`;
            activeAutoTriggerReason = null;
        }

        // Lorebook Override
        if (settings.lorebook_override && characters[this_chid] && typeof world_names !== 'undefined') {
            const match = world_names.find(w => w.toLowerCase() === settings.lorebook_override.toLowerCase());
            if (match) {
                originalWorldName = characters[this_chid].world;
                characters[this_chid].world = match;
            }
        }
    });

    // 4. Restore original Lorebook state after prompt construction
    eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, () => {
        if (originalWorldName !== null && characters[this_chid]) {
            characters[this_chid].world = originalWorldName;
            originalWorldName = null;
        }
    });

    // 5. Update panel fields when active chat changes
    eventSource.on(event_types.CHAT_CHANGED, () => {
        loadCurrentPanelSettings();
        updateLastUserActivity();
    });

    eventSource.on(event_types.CHAT_LOADED, () => {
        loadCurrentPanelSettings();
        updateLastUserActivity();
    });

    // 6. Bind inputs inside the settings panel
    const panel = document.getElementById('sb_character_conversation_panel');
    if (panel) {
        panel.addEventListener('change', saveCurrentPanelSettings);
        panel.addEventListener('input', saveCurrentPanelSettings);
    }

    // 7. Bind Prose Polisher button
    const polishBtn = document.getElementById('sb_prose_polisher_but');
    if (polishBtn) {
        polishBtn.addEventListener('click', handleProsePolish);
    }

    // 8. Start Background Worker (runs every 30 seconds for schedule accuracy)
    setInterval(conversationModeAutoMessageWorker, 30000);

    // Initial load
    loadCurrentPanelSettings();
}

// Register on APP_READY
eventSource.on(event_types.APP_READY, init);
