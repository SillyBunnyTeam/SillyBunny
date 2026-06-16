import { getMessageTimeStamp } from './RossAscends-mods.js';
import { eventSource, event_types } from './events.js';
import { selected_group } from './group-chats.js';
import { world_names } from './world-info.js';
import { addOneMessage, chat, characters, Generate, generateRaw, getThumbnailUrl, is_send_press, name1, saveChat, selectCharacterById, this_chid } from '../script.js';

const SETTINGS_KEY_PREFIX = 'sb_conv_settings_';
const LAST_USER_ACTIVITY_PREFIX = 'sb_conv_last_user_activity_';
const LAST_AUTO_MESSAGE_PREFIX = 'sb_conv_last_auto_msg_';
const LAST_SCHEDULE_TRIGGER_PREFIX = 'sb_conv_last_trigger_';
const LAST_IDLE_SESSION_PREFIX = 'sb_conv_last_idle_session_';
const LAST_CHIME_SESSION_PREFIX = 'sb_conv_last_chime_session_';
const LAST_PREVIEW_PREFIX = 'sb_conv_last_preview_';
const UNREAD_PREFIX = 'sb_conv_unread_';
const AUTO_WORKER_INTERVAL_MS = 30000;
const CHROME_IDS = Object.freeze({
    header: 'sb_conversation_header',
    palsToggle: 'sb_conversation_pals_toggle',
    palsRail: 'sb_conversation_pals_rail',
    palsList: 'sb_conversation_pals_list',
    settingsBackdrop: 'sb_conversation_settings_backdrop',
    settingsDrawer: 'sb_conversation_settings_drawer',
});
const AVAILABILITY_COPY = Object.freeze({
    online: { label: 'Online', detail: 'Available for live DM replies.' },
    idle: { label: 'Idle', detail: 'May follow up after a quiet stretch.' },
    dnd: { label: 'Do Not Disturb', detail: 'Auto-responder answers new messages.' },
    offline: { label: 'Offline', detail: 'Auto-responder answers while away.' },
});

const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
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
    { id: 'sb_conv_enabled', key: 'enabled', prop: 'checked' },
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
let generationActive = false;

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

function getAvailabilityCopy(status) {
    return AVAILABILITY_COPY[status] ?? AVAILABILITY_COPY.online;
}

function getUnreadCount(avatar) {
    return parsePositiveInt(localStorage.getItem(getCharacterStorageKey(UNREAD_PREFIX, avatar)), 0, 0);
}

function setUnreadCount(avatar, count) {
    localStorage.setItem(getCharacterStorageKey(UNREAD_PREFIX, avatar), String(Math.max(0, count)));
}

function clearUnreadCount(avatar) {
    setUnreadCount(avatar, 0);
}

function stripPreviewText(messageText) {
    return String(messageText || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 130);
}

function setLastConversationPreview(avatar, messageText) {
    const preview = stripPreviewText(messageText);
    if (!avatar || !preview) {
        return;
    }

    localStorage.setItem(getCharacterStorageKey(LAST_PREVIEW_PREFIX, avatar), preview);
}

function getLastConversationPreview(avatar) {
    return localStorage.getItem(getCharacterStorageKey(LAST_PREVIEW_PREFIX, avatar)) || 'Conversation ready';
}

function updateLastPreviewFromMessage(messageId) {
    const avatar = getCurrentCharAvatar();
    const message = chat[messageId];

    if (!avatar || !message?.mes) {
        return;
    }

    setLastConversationPreview(avatar, message.mes);
    clearUnreadCount(avatar);
}

function updateLastPreviewFromChat() {
    const avatar = getCurrentCharAvatar();
    if (!avatar || !Array.isArray(chat) || !chat.length) {
        return;
    }

    const message = [...chat].reverse().find(item => item?.mes && !item.is_system);
    if (message) {
        setLastConversationPreview(avatar, message.mes);
    }

    clearUnreadCount(avatar);
}

function getConversationSettingsForCharacter(character) {
    return character?.avatar ? getSettings(character.avatar) : { ...DEFAULT_SETTINGS };
}

function getConversationPals() {
    if (!Array.isArray(characters)) {
        return [];
    }

    return characters
        .map((character, index) => ({ character, index, settings: getConversationSettingsForCharacter(character) }))
        .filter(item => item.character?.avatar && item.settings.enabled);
}

function buildSettingsDrawerHtml() {
    return `
        <div class="sb-conversation-settings-header">
            <div>
                <div class="sb-conversation-settings-kicker">Conversation Mode</div>
                <div class="sb-conversation-settings-title">DM controls</div>
                <div class="sb-conversation-settings-subtitle">Presence, schedules, context, and message helpers for this character.</div>
            </div>
            <button type="button" class="menu_button menu_button_icon" data-sb-conversation-action="close-settings" title="Close Conversation settings" aria-label="Close Conversation settings">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
        <div class="sb-conversation-settings-body">
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-power-off" aria-hidden="true"></i><span>Conversation Interface</span></h4>
                <label class="checkbox_label" title="Auto-activate the DM interface for this character">
                    <input id="sb_conv_enabled" type="checkbox" />
                    <span>Auto-activate Conversation Mode for this character</span>
                </label>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-signal" aria-hidden="true"></i><span>Presence & Availability</span></h4>
                <div class="sb-conversation-field-row">
                    <label class="checkbox_label" title="Character availability status">
                        <span>Status</span>
                        <select id="sb_conv_availability" class="text_pole textarea_compact">
                            <option value="online">Online</option>
                            <option value="idle">Idle</option>
                            <option value="dnd">Do Not Disturb</option>
                            <option value="offline">Offline</option>
                        </select>
                    </label>
                    <label class="checkbox_label" title="Action when user is idle">
                        <span>User Idle Action</span>
                        <select id="sb_conv_idle_action" class="text_pole textarea_compact">
                            <option value="disabled">Disabled</option>
                            <option value="followup">Send Auto Follow-up</option>
                            <option value="spontaneous">Spontaneous Ping</option>
                        </select>
                    </label>
                    <label class="checkbox_label sb-conversation-inline-number" title="User idle silence limit in minutes">
                        <span>Idle Limit</span>
                        <input id="sb_conv_idle_limit" class="text_pole textarea_compact widthUnset" type="number" min="1" max="1440" step="1" value="15" />
                        <span class="auto_mode_delay_unit">mins</span>
                    </label>
                </div>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_offline_message">Offline/DND Auto-responder</label>
                    <textarea id="sb_conv_offline_message" class="text_pole textarea_compact autoSetHeight wide100p" rows="2" placeholder="[Character is currently away. Leave a message!]"></textarea>
                </div>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-clock" aria-hidden="true"></i><span>Auto-Messaging & Scheduling</span></h4>
                <div class="sb-conversation-field-row">
                    <label class="checkbox_label" title="Enable autonomous scheduled messages">
                        <input id="sb_conv_auto_message" type="checkbox" />
                        <span>Enable Scheduling</span>
                    </label>
                    <label class="checkbox_label sb-conversation-inline-number" title="Auto-message minimum delay/cooldown in seconds">
                        <span>Cooldown</span>
                        <input id="sb_conv_cooldown" class="text_pole textarea_compact widthUnset" type="number" min="10" max="9999" step="1" value="60" />
                        <span class="auto_mode_delay_unit">secs</span>
                    </label>
                </div>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_ai_schedule">Message Schedule</label>
                    <textarea id="sb_conv_ai_schedule" class="text_pole textarea_compact autoSetHeight wide100p" rows="3" placeholder="08:00 - Good morning selfie!&#10;14:00 - Casual afternoon check-in&#10;22:00 - Good night chat"></textarea>
                </div>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-scroll" aria-hidden="true"></i><span>Prompts & Formats</span></h4>
                <div class="sb-conversation-field-row">
                    <label class="checkbox_label" title="Inject Geechan style system prompt and formatting overrides">
                        <input id="sb_conv_geechan_prompt" type="checkbox" />
                        <span>Use Geechan Chatroom Format</span>
                    </label>
                    <label class="checkbox_label" title="Enable dynamic character-to-character chiming when idle or discussed">
                        <input id="sb_conv_multi_char" type="checkbox" />
                        <span>Multi-Character Chiming</span>
                    </label>
                </div>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_multi_char_names">Chiming Partners</label>
                    <input id="sb_conv_multi_char_names" type="text" class="text_pole wide100p" placeholder="Geechan, Seraphina" />
                </div>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-book-atlas" aria-hidden="true"></i><span>Context Overrides</span></h4>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_lorebook_override">Lorebook Override</label>
                    <input id="sb_conv_lorebook_override" type="text" class="text_pole wide100p" placeholder="Leave empty for character default" />
                </div>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_authors_note">Author's Note Override</label>
                    <textarea id="sb_conv_authors_note" class="text_pole textarea_compact autoSetHeight wide100p" rows="2" placeholder="[Author's Note: Keep responses short, direct, and conversational as if chatting in a DM.]"></textarea>
                </div>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i><span>DM Tweaks & Spontaneous Media</span></h4>
                <label class="checkbox_label" title="Add quick inline edit buttons next to messages in the chat list">
                    <input id="sb_conv_editable_messages" type="checkbox" />
                    <span>Enable Quick-Edit DM Actions</span>
                </label>
                <label class="checkbox_label" title="Enable the Prose Polisher magic wand button to automatically style your input before sending">
                    <input id="sb_conv_prose_polisher" type="checkbox" />
                    <span>Prose Polisher Send Assistant</span>
                </label>
                <label class="checkbox_label" title="Allows character to spontaneously send selfies using Stable Diffusion slash commands">
                    <input id="sb_conv_spontaneous_selfies" type="checkbox" />
                    <span>Enable Spontaneous Selfies</span>
                </label>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_selfie_prompt">Selfie Prompt Template</label>
                    <input id="sb_conv_selfie_prompt" type="text" class="text_pole wide100p" placeholder="raw photo, selfie of {{char}}" />
                </div>
            </div>
        </div>
    `;
}

function ensureConversationChrome() {
    const sheld = document.getElementById('sheld');
    const chatElement = document.getElementById('chat');
    if (!(sheld instanceof HTMLElement) || !(chatElement instanceof HTMLElement)) {
        return null;
    }

    let header = document.getElementById(CHROME_IDS.header);
    if (!(header instanceof HTMLElement)) {
        header = document.createElement('div');
        header.id = CHROME_IDS.header;
        header.hidden = true;
        header.innerHTML = `
            <button id="${CHROME_IDS.palsToggle}" type="button" class="menu_button menu_button_icon" data-sb-conversation-action="toggle-pals" title="Open Conversation pals" aria-label="Open Conversation pals">
                <i class="fa-solid fa-address-book"></i>
            </button>
            <div class="sb-conversation-header-avatar">
                <img data-sb-conversation-avatar alt="" loading="lazy">
                <span class="sb-conversation-status-dot" data-sb-conversation-status-dot data-status="online" aria-hidden="true"></span>
            </div>
            <div class="sb-conversation-header-copy">
                <div class="sb-conversation-header-kicker">Direct Message</div>
                <div class="sb-conversation-header-name" data-sb-conversation-name>Conversation</div>
                <div class="sb-conversation-header-status" data-sb-conversation-status>Available for live DM replies.</div>
            </div>
            <div class="sb-conversation-header-actions">
                <button type="button" class="menu_button menu_button_icon" data-sb-conversation-action="open-settings" title="Conversation settings" aria-label="Conversation settings">
                    <i class="fa-solid fa-gear"></i>
                </button>
            </div>
        `;
        sheld.insertBefore(header, chatElement);
    }

    let palsRail = document.getElementById(CHROME_IDS.palsRail);
    if (!(palsRail instanceof HTMLElement)) {
        palsRail = document.createElement('aside');
        palsRail.id = CHROME_IDS.palsRail;
        palsRail.hidden = true;
        palsRail.setAttribute('aria-label', 'Conversation pals');
        palsRail.innerHTML = `
            <div class="sb-conversation-rail-header">
                <div>
                    <div class="sb-conversation-rail-kicker">Pals</div>
                    <div class="sb-conversation-rail-title">Conversation Cast</div>
                </div>
                <button type="button" class="menu_button menu_button_icon sb-conversation-rail-close" data-sb-conversation-action="close-pals" title="Close Conversation pals" aria-label="Close Conversation pals">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
            <div id="${CHROME_IDS.palsList}" class="sb-conversation-pals-list"></div>
        `;
        sheld.insertBefore(palsRail, header);
    }

    let backdrop = document.getElementById(CHROME_IDS.settingsBackdrop);
    if (!(backdrop instanceof HTMLElement)) {
        backdrop = document.createElement('div');
        backdrop.id = CHROME_IDS.settingsBackdrop;
        backdrop.hidden = true;
        sheld.appendChild(backdrop);
    }

    let drawer = document.getElementById(CHROME_IDS.settingsDrawer);
    if (!(drawer instanceof HTMLElement)) {
        drawer = document.createElement('aside');
        drawer.id = CHROME_IDS.settingsDrawer;
        drawer.hidden = true;
        drawer.setAttribute('aria-label', 'Conversation settings');
        drawer.innerHTML = buildSettingsDrawerHtml();
        sheld.appendChild(drawer);
    }

    bindConversationChromeControls(sheld);
    return { sheld, header, palsRail, backdrop, drawer };
}

function setConversationBackdropVisible() {
    const backdrop = document.getElementById(CHROME_IDS.settingsBackdrop);
    const drawer = document.getElementById(CHROME_IDS.settingsDrawer);
    const palsRail = document.getElementById(CHROME_IDS.palsRail);
    if (!(backdrop instanceof HTMLElement)) {
        return;
    }

    const settingsOpen = drawer instanceof HTMLElement && !drawer.hidden;
    const palsOpen = palsRail instanceof HTMLElement && palsRail.dataset.open === 'true';
    backdrop.hidden = !(settingsOpen || palsOpen);
}

function closePalsRail() {
    const palsRail = document.getElementById(CHROME_IDS.palsRail);
    if (palsRail instanceof HTMLElement) {
        palsRail.dataset.open = 'false';
    }
    setConversationBackdropVisible();
}

function togglePalsRail() {
    const palsRail = document.getElementById(CHROME_IDS.palsRail);
    if (!(palsRail instanceof HTMLElement)) {
        return;
    }

    palsRail.dataset.open = palsRail.dataset.open === 'true' ? 'false' : 'true';
    setConversationBackdropVisible();
}

function openConversationSettings() {
    const chrome = ensureConversationChrome();
    if (!chrome) {
        return;
    }

    closePalsRail();
    applySettingsToPanel(getSettings());
    chrome.drawer.hidden = false;
    setConversationBackdropVisible();
    chrome.drawer.querySelector('input, select, textarea, button')?.focus?.({ preventScroll: true });
}

function closeConversationSettings() {
    const drawer = document.getElementById(CHROME_IDS.settingsDrawer);
    if (drawer instanceof HTMLElement) {
        drawer.hidden = true;
    }
    setConversationBackdropVisible();
}

function bindConversationChromeControls(sheld) {
    if (sheld.dataset.sbConversationChromeBound === 'true') {
        return;
    }

    sheld.dataset.sbConversationChromeBound = 'true';
    sheld.addEventListener('click', async (event) => {
        const target = event.target instanceof Element ? event.target.closest('[data-sb-conversation-action], .sb-conversation-pal') : null;
        if (!(target instanceof HTMLElement)) {
            return;
        }

        if (target.classList.contains('sb-conversation-pal')) {
            const index = parsePositiveInt(target.dataset.characterIndex, -1, 0);
            if (index >= 0) {
                closePalsRail();
                await selectCharacterById(index, { switchMenu: false });
            }
            return;
        }

        switch (target.dataset.sbConversationAction) {
            case 'toggle-pals':
                togglePalsRail();
                break;
            case 'close-pals':
                closePalsRail();
                break;
            case 'open-settings':
                openConversationSettings();
                break;
            case 'close-settings':
                closeConversationSettings();
                break;
            default:
                break;
        }
    });

    const drawer = document.getElementById(CHROME_IDS.settingsDrawer);
    if (drawer instanceof HTMLElement && drawer.dataset.sbConversationBound !== 'true') {
        drawer.dataset.sbConversationBound = 'true';
        drawer.addEventListener('change', saveCurrentPanelSettings);
        drawer.addEventListener('input', saveCurrentPanelSettings);
    }

    const backdrop = document.getElementById(CHROME_IDS.settingsBackdrop);
    if (backdrop instanceof HTMLElement && backdrop.dataset.sbConversationBound !== 'true') {
        backdrop.dataset.sbConversationBound = 'true';
        backdrop.addEventListener('click', () => {
            closeConversationSettings();
            closePalsRail();
        });
    }
}

function syncEntryPanel(settings = getSettings()) {
    const character = getCurrentCharacter();
    const nameElement = document.getElementById('sb_conv_entry_name');
    const summaryElement = document.getElementById('sb_conv_entry_summary');
    const toggle = document.getElementById('sb_conv_entry_enabled');
    const openButton = document.getElementById('sb_conv_open_dm');

    if (nameElement instanceof HTMLElement) {
        nameElement.textContent = character?.name || 'No character selected';
    }

    if (summaryElement instanceof HTMLElement) {
        summaryElement.textContent = character
            ? settings.enabled
                ? 'This chat will auto-open as a DM workspace. Use the gear in the chat header for schedules, presence, and context.'
                : 'Enable Conversation Mode to turn this character\'s chat into a DM workspace. Settings live inside the in-chat gear menu.'
            : 'Select a character before enabling Conversation Mode.';
    }

    if (toggle instanceof HTMLInputElement) {
        toggle.checked = Boolean(character && settings.enabled);
        toggle.disabled = !character;
    }

    if (openButton instanceof HTMLButtonElement) {
        openButton.disabled = !character;
    }
}

function enableConversationModeForCurrentCharacter() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        return;
    }

    const settings = getSettings(avatar);
    settings.enabled = true;
    saveSettings(avatar, settings);
    applySettingsToPanel(settings);
    refreshConversationInterface({ syncControls: false });
    document.getElementById('send_textarea')?.focus?.({ preventScroll: false });
}

function bindEntryPanel() {
    const panel = document.getElementById('sb_character_conversation_panel');
    if (!(panel instanceof HTMLElement) || panel.dataset.sbConversationEntryBound === 'true') {
        return;
    }

    panel.dataset.sbConversationEntryBound = 'true';
    panel.addEventListener('change', (event) => {
        if (!(event.target instanceof HTMLInputElement) || event.target.id !== 'sb_conv_entry_enabled') {
            return;
        }

        const avatar = getCurrentCharAvatar();
        if (!avatar) {
            return;
        }

        const settings = getSettings(avatar);
        settings.enabled = event.target.checked;
        saveSettings(avatar, settings);
        applySettingsToPanel(settings);
        refreshConversationInterface({ syncControls: false });
    });

    const openButton = document.getElementById('sb_conv_open_dm');
    if (openButton instanceof HTMLButtonElement) {
        openButton.addEventListener('click', enableConversationModeForCurrentCharacter);
    }
}

function setConversationInterfaceActive(active) {
    const chrome = active ? ensureConversationChrome() : { sheld: document.getElementById('sheld') };
    if (!(chrome?.sheld instanceof HTMLElement)) {
        return;
    }

    if (!active) {
        chrome.sheld.removeAttribute('data-sb-conversation-mode');
        closeConversationSettings();
        closePalsRail();
        for (const id of [CHROME_IDS.header, CHROME_IDS.palsRail]) {
            const element = document.getElementById(id);
            if (element instanceof HTMLElement) {
                element.hidden = true;
            }
        }
        return;
    }

    chrome.sheld.dataset.sbConversationMode = 'on';
    for (const id of [CHROME_IDS.header, CHROME_IDS.palsRail]) {
        const element = document.getElementById(id);
        if (element instanceof HTMLElement) {
            element.hidden = false;
        }
    }
}

function renderPalsRail() {
    const list = document.getElementById(CHROME_IDS.palsList);
    if (!(list instanceof HTMLElement)) {
        return;
    }

    const pals = getConversationPals();
    list.textContent = '';

    if (!pals.length) {
        const empty = document.createElement('div');
        empty.className = 'sb-conversation-empty';
        empty.textContent = 'Enable Conversation Mode on characters to build your DM cast.';
        list.appendChild(empty);
        return;
    }

    for (const { character, index, settings } of pals) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sb-conversation-pal';
        button.dataset.characterIndex = String(index);
        button.dataset.unread = String(getUnreadCount(character.avatar) > 0);
        button.setAttribute('aria-current', String(!selected_group && Number(this_chid) === index));
        button.innerHTML = `
            <span class="sb-conversation-pal-avatar">
                <img alt="" loading="lazy">
                <span class="sb-conversation-status-dot" aria-hidden="true"></span>
            </span>
            <span class="sb-conversation-pal-copy">
                <span class="sb-conversation-pal-name"></span>
                <span class="sb-conversation-pal-preview"></span>
            </span>
            <span class="sb-conversation-pal-unread" aria-hidden="true"></span>
        `;

        const image = button.querySelector('img');
        const statusDot = button.querySelector('.sb-conversation-status-dot');
        const name = button.querySelector('.sb-conversation-pal-name');
        const preview = button.querySelector('.sb-conversation-pal-preview');

        if (image instanceof HTMLImageElement) {
            image.src = getThumbnailUrl('avatar', character.avatar);
        }
        if (statusDot instanceof HTMLElement) {
            statusDot.dataset.status = settings.availability;
        }
        if (name instanceof HTMLElement) {
            name.textContent = character.name || 'Character';
        }
        if (preview instanceof HTMLElement) {
            preview.textContent = getLastConversationPreview(character.avatar);
        }

        list.appendChild(button);
    }
}

function updateConversationHeader(settings = getSettings()) {
    const character = getCurrentCharacter();
    const image = document.querySelector(`#${CHROME_IDS.header} [data-sb-conversation-avatar]`);
    const name = document.querySelector(`#${CHROME_IDS.header} [data-sb-conversation-name]`);
    const status = document.querySelector(`#${CHROME_IDS.header} [data-sb-conversation-status]`);
    const statusDot = document.querySelector(`#${CHROME_IDS.header} [data-sb-conversation-status-dot]`);
    const statusCopy = getAvailabilityCopy(settings.availability);

    if (image instanceof HTMLImageElement && character?.avatar) {
        image.src = getThumbnailUrl('avatar', character.avatar);
    }
    if (name instanceof HTMLElement) {
        name.textContent = character?.name || 'Conversation';
    }
    if (status instanceof HTMLElement) {
        status.textContent = generationActive && character
            ? `${character.name || 'Character'} is writing...`
            : `${statusCopy.label}: ${statusCopy.detail}`;
    }
    if (statusDot instanceof HTMLElement) {
        statusDot.dataset.status = settings.availability;
    }
}

function updateConversationChrome(settings = getSettings()) {
    updateConversationHeader(settings);
    renderPalsRail();
}

function refreshConversationInterface({ syncControls = false } = {}) {
    const avatar = getCurrentCharAvatar();
    const settings = getSettings(avatar);
    const active = Boolean(!selected_group && avatar && settings.enabled);

    syncEntryPanel(settings);
    setConversationInterfaceActive(active);

    if (syncControls) {
        applySettingsToPanel(settings);
    }

    if (active) {
        clearUnreadCount(avatar);
        updateConversationChrome(settings);
    }

    updateProsePolisherButtonVisibility();
    updateEditableMessageButtons();
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

    const settings = readSettingsFromPanel(avatar);
    saveSettings(avatar, settings);
    refreshConversationInterface({ syncControls: false });
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
        syncEntryPanel(DEFAULT_SETTINGS);
        refreshConversationInterface({ syncControls: false });
        return;
    }

    const settings = getSettings(avatar);
    applySettingsToPanel(settings);
    refreshConversationInterface({ syncControls: false });
}

function updateProsePolisherButtonVisibility() {
    const button = document.getElementById('sb_prose_polisher_but');
    if (!(button instanceof HTMLElement)) {
        return;
    }

    const avatar = getCurrentCharAvatar();
    const settings = getSettings(avatar);
    const shouldShow = Boolean(!selected_group && avatar && settings.enabled && settings.prose_polisher);
    button.classList.toggle('displayNone', !shouldShow);
    button.hidden = !shouldShow;
}

function updateEditableMessageButtons() {
    $('.sb_quick_edit_btn').remove();
    $('.sb-message-has-quick-edit').removeClass('sb-message-has-quick-edit');

    const avatar = getCurrentCharAvatar();
    const settings = getSettings(avatar);
    if (selected_group || !avatar || !settings.enabled || !settings.editable_messages) {
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
    const avatar = getCurrentCharAvatar();
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
    setLastConversationPreview(avatar, messageText);
    updateEditableMessageButtons();
    refreshConversationInterface({ syncControls: false });
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
    if (!settings.enabled) {
        return;
    }

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
    if (!settings.enabled) {
        return;
    }

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
    if (!settings.enabled) {
        return;
    }

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
    updateLastPreviewFromChat();
    loadCurrentPanelSettings();
    updateLastUserActivity();
}

function bindPanelInputs() {
    bindEntryPanel();
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
        updateLastPreviewFromMessage(messageId);
        updateEditableMessageButtons();
        refreshConversationInterface({ syncControls: false });
        await handleAvailabilityAutoResponder(messageId);
    });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
        updateLastPreviewFromMessage(messageId);
        updateEditableMessageButtons();
        refreshConversationInterface({ syncControls: false });
    });
    eventSource.on(event_types.GENERATION_STARTED, (_type, _params, isDryRun) => {
        if (isDryRun) {
            return;
        }

        generationActive = true;
        refreshConversationInterface({ syncControls: false });
    });
    eventSource.on(event_types.GENERATION_ENDED, () => {
        generationActive = false;
        refreshConversationInterface({ syncControls: false });
    });
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        generationActive = false;
        refreshConversationInterface({ syncControls: false });
    });
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
