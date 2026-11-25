import { createEntryRow, createRow, createSpinRow, createSwitchRow } from '../../../sillybunny-editor/rows.js';
import { conversationData, readSettings, requireView, writeSetting } from '../access.js';
import { formatWhen, getPageTitle, listReminders } from '../details-logic.js';
import { copyPlaceholder, createGroup, createHint, createPage, el, icon, showUndoToast, watchConversation } from '../page-kit.js';
import { MAX_INACTIVITY_THRESHOLD, MIN_INACTIVITY_THRESHOLD } from '../../constants.js';

const REMINDER_STATE_TEXT = Object.freeze({
    'given-up': 'Could not be delivered',
    invalid: 'Its chat is gone',
});

/** One row that saves its own key, as it changes, and leaves every other key of the conversation alone. */
function settingSwitch(conversationId, settings, key, label, { subtitle, onChange } = {}) {
    return createSwitchRow({
        label,
        subtitle,
        field: key.replace(/_/g, '-'),
        checked: settings[key],
        onChange: (value) => {
            writeSetting(requireView(conversationId), key, value);
            onChange?.(value);
        },
    });
}

function settingSpin(conversationId, settings, key, label, { min, max, step }) {
    return createSpinRow({
        label,
        field: key.replace(/_/g, '-'),
        value: settings[key],
        min,
        max,
        step,
        onChange: value => writeSetting(requireView(conversationId), key, value),
    });
}

function settingEntry(conversationId, settings, key, label, placeholder) {
    return createEntryRow({
        label,
        field: key.replace(/_/g, '-'),
        floating: true,
        value: settings[key],
        placeholder,
        onChange: value => writeSetting(requireView(conversationId), key, value),
    });
}

function createReminderRows(conversationId) {
    const container = el('div', 'sb-details-reminders');

    const cancel = (reminder) => {
        const saved = structuredClone(requireView(conversationId).reminders.find(item => item.id === reminder.id));
        conversationData.cancelReminder(conversationId, reminder.id);
        showUndoToast('Reminder cancelled', () => {
            const view = conversationData.get(conversationId);
            if (view && saved) {
                conversationData.patchConversation(conversationId, { reminders: [...view.reminders, saved] });
            }
        });
    };

    const draw = () => {
        const list = listReminders(conversationData.reminders(conversationId));
        const focusedId = document.activeElement instanceof HTMLElement ? document.activeElement.closest('[data-reminder-id]')?.dataset.reminderId : null;
        container.replaceChildren();
        for (const reminder of list) {
            const button = el('button', 'ds-entity-row__button sb-details-row-button');
            button.type = 'button';
            button.title = `Cancel Reminder: ${reminder.text}`;
            button.setAttribute('aria-label', `Cancel Reminder: ${reminder.text}`);
            button.append(icon('xmark'));
            button.addEventListener('click', () => cancel(reminder));
            const when = formatWhen(reminder.triggerAt);
            const subtitle = [REMINDER_STATE_TEXT[reminder.state], when].filter(Boolean).join(' · ');
            const row = createRow({ label: reminder.text, subtitle, field: `reminder-${reminder.id}`, suffix: button });
            row.row.dataset.reminderId = reminder.id;
            container.append(row.row);
        }
        if (!list.length) {
            container.append(createHint('No reminders'));
        }
        if (focusedId) {
            const again = [...container.querySelectorAll('[data-reminder-id]')].find(node => node.dataset.reminderId === focusedId);
            again?.querySelector('button')?.focus();
        }
    };
    draw();
    return { container, draw };
}

/** Messaging first, the commands a character may use, images, and the reminders that wait. Every row saves as it changes. */
export function buildBehaviour({ conversationId, nav }) {
    const view = requireView(conversationId);
    const settings = readSettings(view);
    const { page, clamp } = createPage('sb-details-page--settings');

    const patience = createSpinRow({
        label: 'Patience (Mins)',
        field: 'inactivity-threshold',
        value: settings.inactivity_threshold,
        min: MIN_INACTIVITY_THRESHOLD,
        max: MAX_INACTIVITY_THRESHOLD,
        step: 5,
        onChange: value => writeSetting(requireView(conversationId), 'inactivity_threshold', value),
    });
    const unanswered = settingSpin(conversationId, settings, 'max_followups', 'Max Unanswered', { min: 1, max: 3, step: 1 });
    const dependents = [patience, unanswered];
    const messaging = settingSwitch(conversationId, settings, 'proactive_messaging', 'Messaging First', {
        onChange: on => dependents.forEach(row => row.setDisabled(!on)),
    });
    dependents.forEach(row => row.setDisabled(!settings.proactive_messaging));
    // What the switch does is for the maintainer to say.
    const description = copyPlaceholder('small', 'ds-row-subtitle');
    messaging.row.querySelector('.ds-row-text')?.append(description);

    // What the switch does is for the maintainer to say.
    const charactersReact = settingSwitch(conversationId, settings, 'characters_react', 'Characters React');
    charactersReact.row.querySelector('.ds-row-text')?.append(copyPlaceholder('small', 'ds-row-subtitle'));

    const reminders = createReminderRows(conversationId);
    const reminderGroup = createGroup({ title: 'Reminders', field: 'reminders', rows: [] });
    reminderGroup.group.append(reminders.container);

    clamp.append(
        createGroup({ title: 'Automatic Messages', field: 'messaging-first', rows: [messaging, patience, unanswered] }).section,
        createGroup({
            title: 'Auto-Responder and Commands',
            field: 'commands',
            rows: [
                settingEntry(conversationId, settings, 'offline_message', 'Offline and Busy Auto-Responder', '[{{user}} is currently offline. Leave a message!]'),
                settingSwitch(conversationId, settings, 'selfie_command_enabled', 'Selfies Through [selfie]'),
                settingSwitch(conversationId, settings, 'schedule_command_enabled', 'Status Updates Through [schedule_update]'),
                charactersReact,
            ],
        }).section,
        createGroup({
            title: 'Images',
            field: 'images',
            rows: [
                settingSwitch(conversationId, settings, 'image_gen_enabled', 'Generate Images'),
                settingEntry(conversationId, settings, 'image_gen_prompt_template', 'Image Prompt Template', 'a photo of {{char}}, {{scene}}'),
                settingEntry(conversationId, settings, 'image_gen_negative', 'Negative Prompt', 'blurry, distorted'),
                settingSpin(conversationId, settings, 'image_gen_cooldown', 'Image Cooldown (Minutes)', { min: 0, max: 1440, step: 1 }),
                settingSwitch(conversationId, settings, 'spontaneous_selfies', 'Spontaneous Selfies'),
            ],
        }).section,
        reminderGroup.section,
    );

    const signature = current => JSON.stringify(current.reminders.map(item => [item.id, item.text, item.triggerAt, item.fired, item.skippedAt, item.invalidAt]));
    const stop = watchConversation(conversationId, signature, { onChange: reminders.draw, onGone: () => nav.gone() });
    return { title: getPageTitle('behaviour'), content: page, dispose: stop };
}
