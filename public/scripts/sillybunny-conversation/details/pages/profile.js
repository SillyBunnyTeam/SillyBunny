import { openAlert } from '../../../sillybunny-editor/dialog.js';
import { createButtonRow, createComboRow, createPropertyRow, createSwitchRow, createTextAreaField } from '../../../sillybunny-editor/rows.js';
import { conversationData, describeCharacterStatus, getCard, getCardName, getFullPictureUrl, requireView } from '../access.js';
import { openCharacterEditor, openDirectConversationWith, identityOf } from '../actions.js';
import { createCharacterAvatar } from '../avatars.js';
import { routineToText, textToRoutine } from '../details-logic.js';
import { copyPlaceholder, createGroup, createPage, createPillButton, el } from '../page-kit.js';
import { AVAILABILITY_COPY } from '../../constants.js';
import { getRoutine, getStatusOverride, regenerateRoutine, setRoutineEnabled, setRoutineText, setStatusOverride } from '../../schedule.js';
import { getTalkativeness } from '../../talkativeness.js';

const AUTOMATIC = 'auto';
const STATUS_OPTIONS = Object.freeze([
    { value: AUTOMATIC, label: 'Automatic' },
    ...['online', 'idle', 'dnd', 'offline'].map(status => ({ value: status, label: AVAILABILITY_COPY[status].label })),
]);

async function confirmRegenerate(name) {
    const body = el('div', 'sb-details-alert-body');
    body.append(copyPlaceholder());
    return await openAlert({
        heading: `Regenerate Routine for ${name}?`,
        bodyNode: body,
        responses: [
            { id: 'cancel', label: 'Cancel' },
            { id: 'regenerate', label: 'Regenerate', appearance: 'destructive' },
        ],
        closeResponse: 'cancel',
    }) === 'regenerate';
}

/**
 * The profile of one character of the conversation: its picture, its status and the override of it, its daily routine,
 * and how talkative its card says it is.
 * @param {{ conversationId: string, nav: any }} context
 * @param {{ avatar: string }} args
 */
export function buildProfile({ conversationId, nav }, { avatar }) {
    const view = requireView(conversationId);
    const card = getCard(avatar);
    if (!card) {
        throw new Error(`The card ${avatar} is not in the library.`);
    }
    const name = getCardName(avatar);
    const { groupId } = identityOf(view);
    const generation = { personaId: view.personaId, groupId, character: card };
    const isThisConversation = view.kind === 'direct' && view.characters[0] === avatar;
    const { page, clamp } = createPage('sb-details-page--profile');

    // The hero: a press on the picture opens the full picture as a page of this window.
    const hero = el('div', 'sb-details-hero');
    const pictureButton = el('button', 'sb-details-hero__avatar-button');
    pictureButton.type = 'button';
    pictureButton.title = `Show Full Picture for ${name}`;
    pictureButton.setAttribute('aria-label', `Show Full Picture for ${name}`);
    pictureButton.append(createCharacterAvatar(avatar, { size: 128 }));
    pictureButton.addEventListener('click', () => nav.viewPicture({ title: name, src: getFullPictureUrl(avatar), alt: name }));
    const statusLine = el('p', 'sb-details-hero__subtitle');
    hero.append(pictureButton, el('h3', 'sb-details-hero__name', name), statusLine);
    if (!isThisConversation) {
        hero.append(createPillButton('Open Conversation', {
            onClick: async () => {
                if (await openDirectConversationWith(avatar, { personaId: view.personaId })) {
                    await nav.close();
                }
            },
        }));
    }
    const drawStatus = () => { statusLine.textContent = describeCharacterStatus(avatar).line; };
    drawStatus();

    const status = createComboRow({
        label: 'Status',
        field: 'character-status',
        options: STATUS_OPTIONS,
        value: getStatusOverride(avatar) ?? AUTOMATIC,
        onChange: (value) => {
            setStatusOverride(avatar, value === AUTOMATIC ? null : value);
            drawStatus();
        },
    });

    const routineSwitch = createSwitchRow({
        label: 'Daily Routine',
        field: 'character-routine',
        checked: getRoutine(avatar)?.enabled === true,
        // The routine is made from the card the first time it is turned on; after that a switch costs no request.
        onChange: on => void runGeneration(() => setRoutineEnabled(avatar, on, generation), { slow: on && !getRoutine(avatar)?.text }),
    });
    const routineText = createTextAreaField({
        label: 'Routine',
        field: 'character-routine-text',
        value: routineToText(getRoutine(avatar)?.text ?? ''),
        placeholder: 'Monday\n09:00-17:00 working (dnd)',
        rows: 8,
        expand: false,
        onChange: (text) => {
            try {
                setRoutineText(avatar, textToRoutine(text));
                routineText.clearError();
                drawStatus();
            } catch (error) {
                routineText.setError(error.message);
            }
        },
    });
    const regenerate = createButtonRow({
        label: 'Regenerate Routine',
        icon: 'rotate',
        field: 'regenerate-routine',
        onActivate: async () => {
            if (getRoutine(avatar)?.text && !await confirmRegenerate(name)) {
                return;
            }
            await runGeneration(() => regenerateRoutine(avatar, generation));
        },
    });
    const routineParts = [routineText, regenerate];

    const showRoutine = () => {
        const routine = getRoutine(avatar);
        routineParts.forEach(row => row.setVisible(routineSwitch.getValue() && Boolean(routine?.text)));
        routineText.setValue(routineToText(routine?.text ?? ''));
        routineText.clearError();
    };
    // Making a routine asks the model, which takes a moment: the controls that start another request wait.
    async function runGeneration(task, { slow = true } = {}) {
        if (slow) {
            routineSwitch.setDisabled(true);
            regenerate.setDisabled(true);
            globalThis.toastr?.info?.(`Writing a routine for ${name}…`);
        }
        try {
            await task();
        } catch (error) {
            console.error('Conversation Mode: the routine could not be made', error);
            globalThis.toastr?.error?.(error.message);
            routineSwitch.setValue(getRoutine(avatar)?.enabled === true);
        } finally {
            routineSwitch.setDisabled(false);
            regenerate.setDisabled(false);
            showRoutine();
            drawStatus();
        }
    }
    showRoutine();

    const talkativeness = createPropertyRow({ label: 'Talkativeness', value: getTalkativeness(avatar).toFixed(2), field: 'character-talkativeness' });
    const editTalkativeness = createButtonRow({
        label: 'Edit Talkativeness in the Character',
        arrow: true,
        field: 'open-character-talkativeness',
        onActivate: async () => {
            await nav.close();
            await openCharacterEditor(avatar, { field: 'talkativeness_slider' });
        },
    });
    const openCharacter = createButtonRow({
        label: 'Open Character',
        arrow: true,
        field: 'open-character',
        onActivate: async () => {
            await nav.close();
            await openCharacterEditor(avatar);
        },
    });

    clamp.append(
        hero,
        createGroup({ label: 'Status', rows: [status], field: 'profile-status' }).section,
        createGroup({ title: 'Routine', rows: [routineSwitch, ...routineParts], field: 'profile-routine' }).section,
        createGroup({ title: 'Replies', rows: [talkativeness, editTalkativeness], field: 'profile-replies' }).section,
        createGroup({ label: 'Character', rows: [openCharacter], field: 'profile-character' }).section,
    );

    const stop = conversationData.subscribe((event) => {
        if (event.type === 'characters' && (!event.avatar || event.avatar === avatar)) {
            drawStatus();
            status.setValue(getStatusOverride(avatar) ?? AUTOMATIC);
        }
    });
    return { title: name, content: page, dispose: stop };
}
