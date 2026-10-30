import { t } from './i18n.js';
import { createArtPlaceholder } from './sillybunny-home/art.js';
import { COPY_PLACEHOLDER, markCopyPlaceholder, markRowSubtitle } from './sillybunny-home/copy.js';
import { getGettingStartedSteps } from './sillybunny-home/getting-started.js';
import { openShellTarget } from './sillybunny-home/shell-targets.js';
import { createStepRow } from './sillybunny-home/step-rows.js';
import { openDialog } from './sillybunny-editor/dialog.js';
import { createEntryRow, createPrefGroup, createRow, createSwitchRow } from './sillybunny-editor/rows.js';
import { createSelectRow } from './sillybunny-editor/select-row.js';
import { ensureWindowStyles } from './sillybunny-window-styles.js';

const PAGE_COUNT = 3;
const LANGUAGE_SELECT_ID = 'onboarding_ui_language_select';

function createCopyBlock(slot) {
    return markCopyPlaceholder(document.createElement('p'), slot);
}

/** Dots for the eye, and one translatable sentence for assistive technology. */
function createPosition(position) {
    const wrapper = document.createElement('div');
    wrapper.className = 'sbWelcomeSteps';
    const dots = document.createElement('span');
    dots.className = 'sbWelcomeDots';
    dots.setAttribute('aria-hidden', 'true');
    for (let index = 1; index <= PAGE_COUNT; index++) {
        const dot = document.createElement('i');
        dot.classList.toggle('is-current', index === position);
        dots.append(dot);
    }
    const label = document.createElement('span');
    label.className = 'sr-only';
    label.textContent = t`Step ${position} of ${PAGE_COUNT}`;
    wrapper.append(dots, label);
    return wrapper;
}

function createActionButton(label, { stub = false } = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu_button';
    button.textContent = label;
    if (stub) {
        button.dataset.sbStub = 'true';
    }
    return button;
}

/**
 * The language select belongs to the first-run template. The row adopts it and puts it back when the
 * dialog closes, so the template keeps working for the first-run popup.
 */
function createLanguageRow() {
    const select = document.getElementById(LANGUAGE_SELECT_ID);
    if (!(select instanceof HTMLSelectElement)) {
        console.debug(`#${LANGUAGE_SELECT_ID} is not in the document, so the Welcome dialog shows no Language row.`);
        return null;
    }
    return createSelectRow({ select, label: t`Language`, field: 'welcome-language', searchLabel: t`Search` });
}

function fillHello(body, { language, openImport }) {
    const art = createArtPlaceholder('welcome-both');
    art.classList.add('sbWelcomeArt');

    const intro = document.createElement('div');
    intro.className = 'sbWelcomeIntro';
    intro.append(createCopyBlock('WD-1-GREETING'), createCopyBlock('WD-1-ABOUT'), createCopyBlock('WD-1-FORK'));

    const importRow = createRow({
        label: t`Import From SillyTavern`,
        subtitle: COPY_PLACEHOLDER,
        field: 'welcome-import',
        activatable: true,
        onActivate: openImport,
    });
    markRowSubtitle(importRow, 'WD-1-IMPORT-ROW');
    const rows = [...(language ? [language] : []), importRow];

    const fanWork = createCopyBlock('WD-1-FANWORK');
    fanWork.classList.add('sbWelcomeNote');
    body.append(art, intro, createPrefGroup({ field: 'welcome-hello-group', rows }).section, fanWork, createPosition(1));
}

function fillImport(body) {
    const folder = createEntryRow({ label: t`Folder Path`, field: 'welcome-import-folder', floating: true });
    const actions = document.createElement('div');
    actions.className = 'sbWindowActions';
    actions.append(createActionButton(t`Import Folder`, { stub: true }), createActionButton(t`Import Backup ZIP`, { stub: true }));
    body.append(
        createCopyBlock('WD-IMPORT-EXPLANATION'),
        createPrefGroup({ field: 'welcome-import-group', rows: [folder] }).section,
        actions,
    );
}

function fillPersona(body) {
    const name = createEntryRow({ label: t`Your Name`, field: 'welcome-persona-name', floating: true });
    body.append(
        createCopyBlock('WD-2-PROMPT'),
        createPrefGroup({ field: 'welcome-persona-group', rows: [name] }).section,
        createPosition(2),
    );
}

function fillWhatsNext(body, { showMe }) {
    const rows = getGettingStartedSteps().map((step, index) => createStepRow({
        step,
        field: `welcome-step-${step.id}`,
        slot: `WD-3-STEP-${index + 1}`,
        labelId: `sb-welcome-step-${step.id}-title`,
        onShowMe: showMe,
    }));
    const showAtStartup = createSwitchRow({ label: t`Show at Startup`, field: 'welcome-show-at-startup', checked: false });
    body.append(
        createCopyBlock('WD-3-INTRO'),
        createPrefGroup({ field: 'welcome-steps-group', rows }).section,
        createPrefGroup({ field: 'welcome-startup-group', rows: [showAtStartup] }).section,
        createPosition(3),
    );
}

/**
 * Opens the Welcome dialog on its first page. Next pushes the following page, the page header's Back pops it.
 * @returns {Promise<ReturnType<typeof openDialog>>}
 */
export async function openWelcomeDialog() {
    await ensureWindowStyles();
    /** @type {ReturnType<typeof openDialog>} */
    let dialog;
    // The row adopts the select before the dialog exists, so a failure while the dialog is built must give it back.
    const language = createLanguageRow();

    // Next is an affirmative response, which would close a page. The page vetoes the close and moves on.
    const stepGuard = advance => (reason) => {
        if (reason !== 'affirmative') {
            return true;
        }
        advance();
        return false;
    };
    const finish = () => queueMicrotask(() => dialog.close('start'));
    const showMe = (target) => {
        void dialog.close('show-me');
        void dialog.closed.then(() => openShellTarget(target));
    };
    const pushWhatsNext = () => dialog.push({
        title: t`What’s Next`,
        content: body => fillWhatsNext(body, { showMe }),
        responses: { affirmative: { id: 'start', label: t`Start` }, cancel: { label: t`Back` } },
        canClose: stepGuard(finish),
    });
    const pushPersona = () => dialog.push({
        title: t`Your Persona`,
        content: fillPersona,
        responses: { affirmative: { id: 'next', label: t`Next` }, cancel: { label: t`Back` } },
        canClose: stepGuard(pushWhatsNext),
    });
    const pushImport = () => dialog.push({ title: t`Import From SillyTavern`, content: fillImport });

    try {
        dialog = openDialog({
            tier: 'dialog',
            title: t`Welcome`,
            className: 'sbWelcomeDialog',
            responses: { affirmative: { id: 'next', label: t`Next` }, cancel: { label: t`Close` } },
            canClose: stepGuard(pushPersona),
            content: body => fillHello(body, { language, openImport: pushImport }),
        });
    } catch (error) {
        language?.destroy();
        throw error;
    }
    void dialog.closed.then(() => language?.destroy());
    return dialog;
}
