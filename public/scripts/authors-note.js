import {
    MAX_INJECTION_DEPTH,
    animation_duration,
    chat_metadata,
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    saveSettingsDebounced,
    this_chid,
} from '../script.js';
import { getGroupMembers, getSelectedGroupSpeakerAvatar, selected_group } from './group-chats.js';
import { extension_settings, getContext, saveMetadataDebounced } from './extensions.js';
import { getCharaFilename, debounce, delay } from './utils.js';
import { getTokenCountAsync } from './tokenizers.js';
import { debounce_timeout } from './constants.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from './slash-commands/SlashCommandArgument.js';
export { MODULE_NAME as NOTE_MODULE_NAME };
import { t } from './i18n.js';
import { macros, MacroCategory } from './macros/macro-system.js';
import { MacrosParser } from './macros.js';
import { power_user } from './power-user.js';

const MODULE_NAME = '2_floating_prompt'; // <= Deliberate, for sorting lower than memory

export var shouldWIAddPrompt = false;

export const metadata_keys = {
    prompt: 'note_prompt',
    interval: 'note_interval',
    depth: 'note_depth',
    position: 'note_position',
    role: 'note_role',
    chara: 'note_chara',
};

const chara_note_position = {
    replace: 0,
    before: 1,
    after: 2,
};

const DEFAULT_DEPTH = 4;
const DEFAULT_POSITION = 1;
const DEFAULT_INTERVAL = 1;
// script.js and this module import each other, so extension_prompt_roles is still in its temporal
// dead zone while this module body runs. The default role has to be read lazily, at call time.
const getDefaultRole = () => extension_prompt_roles.SYSTEM;

// SillyBunny: resolving these at read time keeps a chat that never used an Author's Note out of
// chat_metadata. Stamping the defaults in on load dirtied every chat the moment it was opened, and
// there is no metadata-only write: saving chat metadata rewrites the entire chat file.
export function getAuthorsNotePrompt() {
    return chat_metadata[metadata_keys.prompt] ?? extension_settings.note?.default ?? '';
}

export function getAuthorsNoteInterval() {
    return chat_metadata[metadata_keys.interval] ?? extension_settings.note?.defaultInterval ?? DEFAULT_INTERVAL;
}

export function getAuthorsNotePosition() {
    return chat_metadata[metadata_keys.position] ?? extension_settings.note?.defaultPosition ?? DEFAULT_POSITION;
}

export function getAuthorsNoteDepth() {
    return chat_metadata[metadata_keys.depth] ?? extension_settings.note?.defaultDepth ?? DEFAULT_DEPTH;
}

export function getAuthorsNoteRole() {
    return chat_metadata[metadata_keys.role] ?? extension_settings.note?.defaultRole ?? getDefaultRole();
}

// SillyBunny divergence: character and group Author's Notes use a fork-owned scoped store while preserving existing note settings.
function ensureCharacterNoteStore() {
    if (!extension_settings.note.chara) {
        extension_settings.note.chara = [];
    }

    return extension_settings.note.chara;
}

function getCharacterNoteKey(avatarId, groupId = '') {
    const avatarName = getCharaFilename(null, { manualAvatarKey: avatarId });
    if (!avatarName) {
        return null;
    }

    return groupId ? `group:${groupId}:${avatarName}` : `individual:${avatarName}`;
}

function getCharacterNoteByKey(noteKey) {
    if (!noteKey || !extension_settings.note.chara) {
        return null;
    }

    return extension_settings.note.chara.find((entry) => entry.name === noteKey) ?? null;
}

function getCharacterNoteByAvatar(avatarId, groupId = '') {
    const noteKey = getCharacterNoteKey(avatarId, groupId);
    const scopedNote = getCharacterNoteByKey(noteKey);
    if (scopedNote || groupId) {
        return scopedNote;
    }

    const legacyName = getCharaFilename(null, { manualAvatarKey: avatarId });
    return getCharacterNoteByKey(legacyName);
}

function normalizeCharacterNote(note, noteKey = '') {
    if (!note || typeof note !== 'object') {
        return null;
    }

    const position = Number(note.position);

    return {
        name: noteKey || note.name || '',
        prompt: String(note.prompt ?? ''),
        useChara: Boolean(note.useChara),
        position: Object.values(chara_note_position).includes(position) ? position : chara_note_position.replace,
    };
}

function getLegacyGroupCharacterNote(groupId) {
    if (!groupId) {
        return null;
    }

    const avatars = [
        getSelectedGroupSpeakerAvatar(),
        ...getGroupMembers(groupId).map(character => character?.avatar),
    ].filter(Boolean);

    const groupNotes = avatars
        .map(avatarId => getCharacterNoteByAvatar(avatarId, groupId))
        .filter(note => note?.prompt || note?.useChara);

    return groupNotes[0] ?? null;
}

function getGroupChatCharacterNote({ migrate = false } = {}) {
    const context = getContext();
    if (!context.groupId) {
        return null;
    }

    const metadataNote = normalizeCharacterNote(chat_metadata[metadata_keys.chara], `group:${context.groupId}`);
    if (metadataNote) {
        chat_metadata[metadata_keys.chara] = metadataNote;
        return metadataNote;
    }

    const legacyNote = normalizeCharacterNote(getLegacyGroupCharacterNote(context.groupId), `group:${context.groupId}`);
    if (legacyNote && migrate) {
        chat_metadata[metadata_keys.chara] = legacyNote;
        saveMetadataDebounced();
    }

    return legacyNote;
}

function getEditableCharacterNoteAvatar() {
    const context = getContext();
    return context.characterId !== undefined ? context.characters[context.characterId]?.avatar || '' : '';
}

function getEditableCharacterNoteName() {
    const context = getContext();
    if (context.groupId) {
        return `group:${context.groupId}`;
    }

    const avatarId = getEditableCharacterNoteAvatar();
    return avatarId ? getCharacterNoteKey(avatarId) : null;
}

function getEditableCharacterNote(options = {}) {
    const context = getContext();
    if (context.groupId) {
        return getGroupChatCharacterNote(options);
    }

    const note = getCharacterNoteByKey(getEditableCharacterNoteName());
    if (note) {
        return note;
    }

    const avatarId = getEditableCharacterNoteAvatar();
    return avatarId ? getCharacterNoteByAvatar(avatarId) : null;
}

function applyCharacterNote(prompt, charaNote) {
    if (!charaNote?.useChara) {
        return prompt;
    }

    switch (charaNote.position) {
        case chara_note_position.before:
            return [charaNote.prompt, prompt].filter(Boolean).join('\n');
        case chara_note_position.after:
            return [prompt, charaNote.prompt].filter(Boolean).join('\n');
        default:
            return charaNote.prompt;
    }
}

function getActiveGroupCharacterNote(context) {
    if (!context.groupId) {
        return null;
    }

    return getGroupChatCharacterNote({ migrate: true });
}

function setNoteTextCommand(_, text) {
    if (text) {
        $('#extension_floating_prompt').val(text).trigger('input');
        toastr.success(t`Author's Note text updated`);
    }
    return getAuthorsNotePrompt();
}

function setNoteDepthCommand(_, text) {
    if (text) {
        const value = Number(text);

        if (Number.isNaN(value)) {
            toastr.error(t`Not a valid number`);
            return;
        }

        $('#extension_floating_depth').val(Math.abs(value)).trigger('input');
        toastr.success(t`Author's Note depth updated`);
    }
    return getAuthorsNoteDepth();
}

function setNoteIntervalCommand(_, text) {
    if (text) {
        const value = Number(text);

        if (Number.isNaN(value)) {
            toastr.error(t`Not a valid number`);
            return;
        }

        $('#extension_floating_interval').val(Math.abs(value)).trigger('input');
        toastr.success(t`Author's Note frequency updated`);
    }
    return getAuthorsNoteInterval();
}

function setNotePositionCommand(_, text) {
    const validPositions = {
        'after': 0,
        'scenario': 0,
        'chat': 1,
        'before_scenario': 2,
        'before': 2,
    };

    if (text) {
        const position = validPositions[text?.trim()?.toLowerCase()];

        if (typeof position === 'undefined') {
            toastr.error(t`Not a valid position`);
            return;
        }

        $(`input[name="extension_floating_position"][value="${position}"]`).prop('checked', true).trigger('input');
        toastr.info(t`Author's Note position updated`);
    }
    return Object.keys(validPositions).find(key => validPositions[key] == getAuthorsNotePosition());
}

function setNoteRoleCommand(_, text) {
    const validRoles = {
        'system': 0,
        'user': 1,
        'assistant': 2,
    };

    if (text) {
        const role = validRoles[text?.trim()?.toLowerCase()];

        if (typeof role === 'undefined') {
            toastr.error(t`Not a valid role`);
            return;
        }

        $('#extension_floating_role').val(Math.abs(role)).trigger('input');
        toastr.info(t`Author's Note role updated`);
    }
    return Object.keys(validRoles).find(key => validRoles[key] == getAuthorsNoteRole());
}

function updateSettings({ saveExtensionSettings = true } = {}) {
    if (saveExtensionSettings) {
        saveSettingsDebounced();
    }
    loadSettings();
    setFloatingPrompt();
}

const setMainPromptTokenCounterDebounced = debounce(async (value) => $('#extension_floating_prompt_token_counter').text(await getTokenCountAsync(value)), debounce_timeout.relaxed);
const setCharaPromptTokenCounterDebounced = debounce(async (value) => $('#extension_floating_chara_token_counter').text(await getTokenCountAsync(value)), debounce_timeout.relaxed);
const setDefaultPromptTokenCounterDebounced = debounce(async (value) => $('#extension_floating_default_token_counter').text(await getTokenCountAsync(value)), debounce_timeout.relaxed);

async function onExtensionFloatingPromptInput() {
    chat_metadata[metadata_keys.prompt] = $(this).val();
    setMainPromptTokenCounterDebounced(chat_metadata[metadata_keys.prompt]);
    updateSettings();
    saveMetadataDebounced();
}

async function onExtensionFloatingIntervalInput() {
    chat_metadata[metadata_keys.interval] = Number($(this).val());
    updateSettings();
    saveMetadataDebounced();
}

async function onExtensionFloatingDepthInput() {
    let value = Number($(this).val());

    if (value < 0) {
        value = Math.abs(value);
        $(this).val(value);
    }

    chat_metadata[metadata_keys.depth] = value;
    updateSettings();
    saveMetadataDebounced();
}

async function onExtensionFloatingPositionInput(e) {
    chat_metadata[metadata_keys.position] = Number(e.target.value);
    updateSettings();
    saveMetadataDebounced();
}

async function onDefaultPositionInput(e) {
    extension_settings.note.defaultPosition = Number(e.target.value);
    saveSettingsDebounced();
}

async function onDefaultDepthInput() {
    let value = Number($(this).val());

    if (value < 0) {
        value = Math.abs(value);
        $(this).val(value);
    }

    extension_settings.note.defaultDepth = value;
    saveSettingsDebounced();
}

async function onDefaultIntervalInput() {
    extension_settings.note.defaultInterval = Number($(this).val());
    saveSettingsDebounced();
}

function onExtensionFloatingRoleInput(e) {
    chat_metadata[metadata_keys.role] = Number(e.target.value);
    updateSettings();
    saveMetadataDebounced();
}

function onExtensionDefaultRoleInput(e) {
    extension_settings.note.defaultRole = Number(e.target.value);
    saveSettingsDebounced();
}

async function onExtensionFloatingCharPositionInput(e) {
    const value = e.target.value;
    const charaNote = getEditableCharacterNote();

    if (charaNote) {
        charaNote.position = Number(value);
        const context = getContext();
        updateSettings({ saveExtensionSettings: !context.groupId });
        if (context.groupId) {
            saveMetadataDebounced();
        }
    }
}

function onExtensionFloatingCharaPromptInput() {
    const tempPrompt = $(this).val();
    const context = getContext();

    setCharaPromptTokenCounterDebounced(tempPrompt);

    if (context.groupId) {
        const tempCharaNote = {
            name: getEditableCharacterNoteName(),
            prompt: tempPrompt,
            useChara: Boolean($('#extension_use_floating_chara').prop('checked')),
            position: Number($('input[name="extension_floating_char_position"]:checked').val() ?? chara_note_position.replace),
        };

        chat_metadata[metadata_keys.chara] = tempCharaNote;

        updateSettings({ saveExtensionSettings: false });
        saveMetadataDebounced();
        return;
    }

    const avatarName = getEditableCharacterNoteName();
    let tempCharaNote = {
        name: avatarName,
        prompt: tempPrompt,
        useChara: Boolean($('#extension_use_floating_chara').prop('checked')),
        position: Number($('input[name="extension_floating_char_position"]:checked').val() ?? chara_note_position.replace),
    };

    let existingCharaNoteIndex;
    let existingCharaNote;

    if (extension_settings.note.chara) {
        existingCharaNoteIndex = extension_settings.note.chara.findIndex((e) => e.name === avatarName);
        existingCharaNote = extension_settings.note.chara[existingCharaNoteIndex];
    }

    if (tempPrompt.length === 0 &&
        extension_settings.note.chara &&
        existingCharaNote &&
        !existingCharaNote.useChara
    ) {
        extension_settings.note.chara.splice(existingCharaNoteIndex, 1);
    } else if (extension_settings.note.chara && existingCharaNote) {
        Object.assign(existingCharaNote, tempCharaNote);
    } else if (avatarName && tempPrompt.length > 0) {
        ensureCharacterNoteStore().push(tempCharaNote);
    } else {
        console.log('Character author\'s note error: No avatar name key could be found.');
        toastr.error(t`Something went wrong. Could not save character's author's note.`);

        // Don't save settings if something went wrong
        return;
    }

    updateSettings();
}

function onExtensionFloatingCharaCheckboxChanged() {
    const value = !!$(this).prop('checked');
    const context = getContext();

    if (context.groupId) {
        const charaNote = getGroupChatCharacterNote() ?? {
            name: getEditableCharacterNoteName(),
            prompt: '',
            useChara: false,
            position: chara_note_position.replace,
        };

        charaNote.useChara = value;

        chat_metadata[metadata_keys.chara] = charaNote;

        updateSettings({ saveExtensionSettings: false });
        saveMetadataDebounced();
        return;
    }

    let charaNote = getEditableCharacterNote();
    const avatarName = getEditableCharacterNoteName();

    if (!charaNote && avatarName && value) {
        charaNote = { name: avatarName, prompt: '', useChara: false, position: chara_note_position.replace };
        ensureCharacterNoteStore().push(charaNote);
    }

    if (charaNote) {
        charaNote.useChara = value;
        updateSettings();
    }
}

function onExtensionFloatingDefaultInput() {
    extension_settings.note.default = $(this).val();
    setDefaultPromptTokenCounterDebounced(extension_settings.note.default);
    updateSettings();
}

function loadSettings() {
    if (extension_settings.note.defaultPosition === undefined) {
        extension_settings.note.defaultPosition = DEFAULT_POSITION;
    }

    if (extension_settings.note.defaultDepth === undefined) {
        extension_settings.note.defaultDepth = DEFAULT_DEPTH;
    }

    if (extension_settings.note.defaultInterval === undefined) {
        extension_settings.note.defaultInterval = DEFAULT_INTERVAL;
    }

    if (extension_settings.note.defaultRole === undefined) {
        extension_settings.note.defaultRole = getDefaultRole();
    }

    $('#extension_floating_prompt').val(getAuthorsNotePrompt());
    $('#extension_floating_interval').val(getAuthorsNoteInterval());
    $('#extension_floating_allow_wi_scan').prop('checked', extension_settings.note.allowWIScan ?? false);
    $('#extension_floating_depth').val(getAuthorsNoteDepth());
    $('#extension_floating_role').val(getAuthorsNoteRole());
    $(`input[name="extension_floating_position"][value="${getAuthorsNotePosition()}"]`).prop('checked', true);

    const context = getContext();
    const canEditCharacterNote = Boolean(context.groupId || getEditableCharacterNoteAvatar());
    if (canEditCharacterNote) {
        const charaNote = getEditableCharacterNote({ migrate: true });

        $('#extension_floating_chara').val(charaNote ? charaNote.prompt : '');
        $('#extension_use_floating_chara').prop('checked', charaNote ? charaNote.useChara : false);
        $(`input[name="extension_floating_char_position"][value="${charaNote?.position ?? chara_note_position.replace}"]`).prop('checked', true);
    } else {
        $('#extension_floating_chara').val('');
        $('#extension_use_floating_chara').prop('checked', false);
        $(`input[name="extension_floating_char_position"][value="${chara_note_position.replace}"]`).prop('checked', true);
    }

    $('#extension_floating_default').val(extension_settings.note.default);
    $('#extension_default_depth').val(extension_settings.note.defaultDepth);
    $('#extension_default_interval').val(extension_settings.note.defaultInterval);
    $('#extension_default_role').val(extension_settings.note.defaultRole);
    $(`input[name="extension_default_position"][value="${extension_settings.note.defaultPosition}"]`).prop('checked', true);
}

export function setFloatingPrompt() {
    const context = getContext();
    if (!context.groupId && context.characterId === undefined) {
        console.debug('setFloatingPrompt: Not in a chat. Skipping.');
        shouldWIAddPrompt = false;
        return;
    }

    // take the count of messages
    let lastMessageNumber = Array.isArray(context.chat) && context.chat.length ? context.chat.filter(m => m.is_user).length : 0;

    console.debug(`
    setFloatingPrompt entered
    ------
    lastMessageNumber = ${lastMessageNumber}
    metadata_keys.interval = ${getAuthorsNoteInterval()}
    metadata_keys.position = ${getAuthorsNotePosition()}
    metadata_keys.depth = ${getAuthorsNoteDepth()}
    metadata_keys.role = ${getAuthorsNoteRole()}
    ------
    `);

    // interval 1 should be inserted no matter what
    if (getAuthorsNoteInterval() === 1) {
        lastMessageNumber = 1;
    }

    if (lastMessageNumber <= 0 || getAuthorsNoteInterval() <= 0) {
        context.setExtensionPrompt(MODULE_NAME, '', extension_prompt_types.NONE, MAX_INJECTION_DEPTH);
        $('#extension_floating_counter').text('(disabled)');
        shouldWIAddPrompt = false;
        return;
    }

    const messagesTillInsertion = lastMessageNumber >= getAuthorsNoteInterval()
        ? (lastMessageNumber % getAuthorsNoteInterval())
        : (getAuthorsNoteInterval() - lastMessageNumber);
    const shouldAddPrompt = messagesTillInsertion == 0;
    shouldWIAddPrompt = shouldAddPrompt;

    let prompt = shouldAddPrompt ? $('#extension_floating_prompt').val() : '';
    if (shouldAddPrompt) {
        const charaNote = context.groupId ? getActiveGroupCharacterNote(context) : getEditableCharacterNote();
        prompt = applyCharacterNote(prompt, charaNote);
    }
    context.setExtensionPrompt(
        MODULE_NAME,
        String(prompt),
        getAuthorsNotePosition(),
        getAuthorsNoteDepth(),
        extension_settings.note.allowWIScan,
        getAuthorsNoteRole(),
    );
    $('#extension_floating_counter').text(shouldAddPrompt ? '0' : messagesTillInsertion);
}

function onANMenuItemClick() {
    if (!selected_group && this_chid === undefined) {
        toastr.warning(t`Select a character before trying to use Author's Note`, '', { timeOut: 2000 });
        return;
    }

    //show AN if it's hidden
    const $ANcontainer = $('#floatingPrompt');
    if ($ANcontainer.css('display') !== 'flex') {
        $ANcontainer.addClass('resizing');
        $ANcontainer.css('display', 'flex');
        $ANcontainer.css('opacity', 0.0);
        $ANcontainer.transition({
            opacity: 1.0,
            duration: animation_duration,
        }, async function () {
            await delay(50);
            $ANcontainer.removeClass('resizing');
        });

        //auto-open the main AN inline drawer
        if ($('#ANBlockToggle')
            .siblings('.inline-drawer-content')
            .css('display') !== 'block') {
            $ANcontainer.addClass('resizing');
            $('#ANBlockToggle').trigger('click');
        }
    } else {
        //hide AN if it's already displayed
        $ANcontainer.addClass('resizing');
        $ANcontainer.transition({
            opacity: 0.0,
            duration: animation_duration,
        }, async function () {
            await delay(50);
            $ANcontainer.removeClass('resizing');
        });
        setTimeout(function () {
            $ANcontainer.hide();
        }, animation_duration);
    }

    //duplicate options menu close handler from script.js
    //because this listener takes priority
    $('#options').stop().fadeOut(animation_duration);
}

async function onChatChanged() {
    loadSettings();
    setFloatingPrompt();
    const context = getContext();

    const canEditCharacterNote = Boolean(context.groupId || getEditableCharacterNoteAvatar());
    $('#extension_floating_chara').prop('disabled', !canEditCharacterNote);
    $('#extension_use_floating_chara').prop('disabled', !canEditCharacterNote);
    $('input[name="extension_floating_char_position"]').prop('disabled', !canEditCharacterNote);

    const authorsNotePrompt = getAuthorsNotePrompt();
    const tokenCounter1 = authorsNotePrompt ? await getTokenCountAsync(authorsNotePrompt) : 0;
    $('#extension_floating_prompt_token_counter').text(tokenCounter1);

    let tokenCounter2;
    if (context.characterId !== undefined || context.groupId) {
        const charaNote = getEditableCharacterNote({ migrate: true });

        if (charaNote) {
            tokenCounter2 = await getTokenCountAsync(charaNote.prompt);
        }
    }

    $('#extension_floating_chara_token_counter').text(tokenCounter2 || 0);

    const tokenCounter3 = extension_settings.note.default ? await getTokenCountAsync(extension_settings.note.default) : 0;
    $('#extension_floating_default_token_counter').text(tokenCounter3);
}

function onAllowWIScanCheckboxChanged() {
    extension_settings.note.allowWIScan = !!$(this).prop('checked');
    updateSettings();
}

/**
 * Inject author's note options and setup event listeners.
 */
// Inserts the extension first since it's statically imported
export function initAuthorsNote() {
    $('#extension_floating_prompt').on('input', onExtensionFloatingPromptInput);
    $('#extension_floating_interval').on('input', onExtensionFloatingIntervalInput);
    $('#extension_floating_depth').on('input', onExtensionFloatingDepthInput);
    $('#extension_floating_chara').on('input', onExtensionFloatingCharaPromptInput);
    $('#extension_use_floating_chara').on('input', onExtensionFloatingCharaCheckboxChanged);
    $('#extension_floating_default').on('input', onExtensionFloatingDefaultInput);
    $('#extension_default_depth').on('input', onDefaultDepthInput);
    $('#extension_default_interval').on('input', onDefaultIntervalInput);
    $('#extension_floating_allow_wi_scan').on('input', onAllowWIScanCheckboxChanged);
    $('#extension_floating_role').on('input', onExtensionFloatingRoleInput);
    $('#extension_default_role').on('input', onExtensionDefaultRoleInput);
    $('input[name="extension_floating_position"]').on('change', onExtensionFloatingPositionInput);
    $('input[name="extension_default_position"]').on('change', onDefaultPositionInput);
    $('input[name="extension_floating_char_position"]').on('change', onExtensionFloatingCharPositionInput);
    $('#ANClose').on('click', function () {
        $('#floatingPrompt').transition({
            opacity: 0,
            duration: animation_duration,
            easing: 'ease-in-out',
        });
        setTimeout(function () { $('#floatingPrompt').hide(); }, animation_duration);
    });
    $('#option_toggle_AN').on('click', onANMenuItemClick);

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'note',
        callback: setNoteTextCommand,
        returns: 'current author\'s note',
        unnamedArgumentList: [
            new SlashCommandArgument(
                'text', [ARGUMENT_TYPE.STRING], false,
            ),
        ],
        helpString: `
            <div>
                Sets an author's note for the currently selected chat if specified and returns the current note.
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'note-depth',
        aliases: ['depth'],
        callback: setNoteDepthCommand,
        returns: 'current author\'s note depth',
        unnamedArgumentList: [
            new SlashCommandArgument(
                'number', [ARGUMENT_TYPE.NUMBER], false,
            ),
        ],
        helpString: `
            <div>
                Sets an author's note depth for in-chat positioning if specified and returns the current depth.
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'note-frequency',
        aliases: ['freq', 'note-freq'],
        callback: setNoteIntervalCommand,
        returns: 'current author\'s note insertion frequency',
        namedArgumentList: [],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'number', [ARGUMENT_TYPE.NUMBER], false,
            ),
        ],
        helpString: `
            <div>
                Sets an author's note insertion frequency if specified and returns the current frequency.
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'note-position',
        callback: setNotePositionCommand,
        aliases: ['pos', 'note-pos'],
        returns: 'current author\'s note insertion position',
        namedArgumentList: [],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'position', [ARGUMENT_TYPE.STRING], false, false, null, ['before', 'after', 'chat'],
            ),
        ],
        helpString: `
            <div>
                Sets an author's note position if specified and returns the current position.
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'note-role',
        callback: setNoteRoleCommand,
        returns: 'current author\'s note chat insertion role',
        namedArgumentList: [],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'role', [ARGUMENT_TYPE.STRING], false, false, null, ['system', 'user', 'assistant'],
            ),
        ],
        helpString: `
            <div>
                Sets an author's note chat insertion role if specified and returns the current role.
            </div>
        `,
    }));
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.GROUP_UPDATED, onChatChanged);

    registerAuthorsNoteMacros();
}

function registerAuthorsNoteMacros() {
    if (power_user.experimental_macro_engine) {
        macros.register('authorsNote', {
            category: MacroCategory.PROMPTS,
            description: t`The contents of the Author's Note`,
            handler: () => getAuthorsNotePrompt(),
        });
        macros.register('charAuthorsNote', {
            category: MacroCategory.PROMPTS,
            description: t`The contents of the Character Author's Note`,
            handler: () => getEditableCharacterNote()?.prompt ?? '',
        });
        macros.register('defaultAuthorsNote', {
            category: MacroCategory.PROMPTS,
            description: t`The contents of the Default Author's Note`,
            handler: () => extension_settings.note.default ?? '',
        });
    } else {
        // TODO: Remove this when the experimental macro engine is replacing the old macro engine
        MacrosParser.registerMacro('authorsNote',
            () => getAuthorsNotePrompt(),
            t`The contents of the Author's Note`,
        );
        MacrosParser.registerMacro('charAuthorsNote',
            () => getEditableCharacterNote()?.prompt ?? '',
            t`The contents of the Character Author's Note`,
        );
        MacrosParser.registerMacro('defaultAuthorsNote',
            () => extension_settings.note.default ?? '',
            t`The contents of the Default Author's Note`,
        );
    }
}
