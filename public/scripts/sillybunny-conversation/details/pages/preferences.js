import { createButtonRow, createComboRow, createEntryRow, createSwitchRow, createTextAreaField } from '../../../sillybunny-editor/rows.js';
import { createSelectRow } from '../../../sillybunny-editor/select-row.js';
import { DEFAULT_GROUNDED_DIALOGUE_RULES } from '../../constants.js';
import { normalizeConversationQuietHour } from '../../context.js';
import { getConnectionProfiles, getUserPersonaStatus, getUserStatus, setUserPersonaStatus, setUserStatus } from '../../personas.js';
import { readModeSettings, writeModeKey } from '../access.js';
import { getPageTitle } from '../details-logic.js';
import { applyEmojiFont } from '../../emoji/emoji-font.js';
import { copyPlaceholder, createGroup, createPage, el } from '../page-kit.js';

const STATUS_CHOICES = Object.freeze([
    { value: 'online', label: 'Online' },
    { value: 'idle', label: 'Idle' },
    { value: 'dnd', label: 'Do Not Disturb' },
    { value: 'offline', label: 'Invisible' },
]);

function createProfileSelect(value) {
    const select = el('select');
    const none = el('option', '', 'Use current connection');
    none.value = '';
    select.append(none);
    const names = getConnectionProfiles().map(profile => profile?.name).filter(Boolean);
    if (value && !names.includes(value)) {
        names.push(value);
    }
    for (const name of names) {
        const option = el('option', '', name);
        option.value = name;
        select.append(option);
    }
    select.value = value;
    return select;
}

/** A time that is blank or on the clock. A blank one turns the window off, because it needs both ends. */
function createQuietHourRow({ label, key, value, placeholder }) {
    const row = createEntryRow({
        label,
        field: key.replace(/_/g, '-'),
        floating: true,
        value,
        placeholder,
        onChange: (text) => {
            const trimmed = text.trim();
            const normalized = normalizeConversationQuietHour(trimmed);
            if (trimmed && !normalized) {
                row.setError('Use a time on the 24-hour clock, such as 22:00');
                return;
            }
            row.clearError();
            row.setValue(normalized);
            writeModeKey(key, normalized);
        },
    });
    return row;
}

/** The status of the user is the app's, so the footer of the list is told when it changes, if the list has one. */
function refreshUserFooter() {
    void import('../../pickers.js').then(pickers => pickers.updateUserFooter?.());
}

/** The mode-wide settings and the status of the persona. It belongs to no conversation, so every row applies to all of them. */
export function buildPreferences({ nav }) {
    const settings = readModeSettings();
    const { page, clamp } = createPage('sb-details-page--settings');

    const rulesEdit = createButtonRow({
        label: 'Edit Grounded Dialogue Rules',
        icon: 'pencil',
        arrow: true,
        field: 'edit-grounded-rules',
        onActivate: () => nav.push('grounded-rules'),
    });
    rulesEdit.setDisabled(!settings.grounded_dialogue_rules_enabled);
    const rules = createSwitchRow({
        label: 'Grounded Dialogue Rules',
        field: 'grounded-dialogue-rules',
        checked: settings.grounded_dialogue_rules_enabled,
        onChange: (value) => {
            writeModeKey('grounded_dialogue_rules_enabled', value);
            rulesEdit.setDisabled(!value);
        },
    });

    // What the switch does is for the maintainer to say.
    const lorebooks = createSwitchRow({ label: 'Use Character Lorebooks', field: 'lorebooks-enabled', checked: settings.lorebooks_enabled, onChange: value => writeModeKey('lorebooks_enabled', value) });
    lorebooks.row.querySelector('.ds-row-text')?.append(copyPlaceholder('small', 'ds-row-subtitle'));

    // What the switch does is for the maintainer to say.
    const deviceEmoji = createSwitchRow({
        label: 'Use Device Emoji',
        field: 'use-device-emoji',
        checked: settings.use_device_emoji,
        onChange: (value) => {
            writeModeKey('use_device_emoji', value);
            applyEmojiFont({ useDeviceEmoji: value });
        },
    });
    deviceEmoji.row.querySelector('.ds-row-text')?.append(copyPlaceholder('small', 'ds-row-subtitle'));

    clamp.append(
        createGroup({
            title: 'Replies',
            field: 'prefs-replies',
            rows: [
                createSwitchRow({ label: 'Simulate Reply Delay', field: 'simulate-reply-delay', checked: settings.simulate_reply_delay, onChange: value => writeModeKey('simulate_reply_delay', value) }),
                createSelectRow({ select: createProfileSelect(settings.connection_profile), label: 'Connection Profile', field: 'connection-profile', onChange: value => writeModeKey('connection_profile', value) }),
                lorebooks,
            ],
        }).section,
        createGroup({
            title: 'Prompts',
            field: 'prefs-prompts',
            rows: [
                createTextAreaField({
                    label: 'Custom Instructions',
                    field: 'custom-instructions',
                    value: settings.custom_instructions,
                    placeholder: 'Type any custom instructions or guidelines here…',
                    rows: 3,
                    expandLabel: 'Expand the Editor',
                    onChange: value => writeModeKey('custom_instructions', value),
                }),
                rules,
                rulesEdit,
            ],
        }).section,
        createGroup({
            title: 'Emoji',
            field: 'prefs-emoji',
            rows: [deviceEmoji],
        }).section,
        createGroup({
            title: 'Quiet Hours',
            field: 'prefs-quiet-hours',
            rows: [
                createQuietHourRow({ label: 'Quiet Hours Start', key: 'quiet_hours_start', value: settings.quiet_hours_start, placeholder: '22:00' }),
                createQuietHourRow({ label: 'Quiet Hours End', key: 'quiet_hours_end', value: settings.quiet_hours_end, placeholder: '07:00' }),
            ],
        }).section,
        createGroup({
            title: 'Your Status',
            field: 'prefs-persona',
            rows: [
                createComboRow({
                    label: 'Status',
                    field: 'persona-status',
                    options: STATUS_CHOICES,
                    value: getUserStatus(),
                    onChange: (value) => {
                        setUserStatus(value);
                        refreshUserFooter();
                    },
                }),
                createEntryRow({
                    label: 'Status Message',
                    field: 'persona-status-message',
                    floating: true,
                    value: getUserPersonaStatus(),
                    placeholder: 'What are you up to?',
                    maxLength: 80,
                    onChange: (value) => {
                        setUserPersonaStatus(value);
                        refreshUserFooter();
                    },
                }),
            ],
        }).section,
    );
    return { title: getPageTitle('preferences'), content: page };
}

/** The rules text that is added to the prompts while Grounded Dialogue Rules is on. Save keeps it; Cancel leaves it as it was. */
export function buildGroundedRules() {
    const settings = readModeSettings();
    const { page, clamp } = createPage('sb-details-page--settings');
    let draft = settings.grounded_dialogue_rules;
    const editor = createTextAreaField({
        label: 'Grounded Dialogue Rules',
        field: 'grounded-dialogue-rules-text',
        value: draft,
        rows: 18,
        expand: false,
        onInput: (value) => { draft = value; },
    });
    const reset = createButtonRow({
        label: 'Reset to Default',
        icon: 'rotate-left',
        field: 'reset-grounded-rules',
        onActivate: () => {
            draft = DEFAULT_GROUNDED_DIALOGUE_RULES;
            editor.setValue(draft);
        },
    });
    clamp.append(createGroup({ label: 'Rules', rows: [editor, reset], field: 'grounded-rules' }).section);
    return {
        title: 'Grounded Dialogue Rules',
        content: page,
        responses: { cancel: {}, affirmative: { id: 'save', label: 'Save' } },
        onResponse() {
            writeModeKey('grounded_dialogue_rules', draft);
        },
    };
}
