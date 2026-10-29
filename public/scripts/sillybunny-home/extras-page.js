import { t } from '../i18n.js';
import { getBundledExtraSlot, groupBundledExtras } from '../sillybunny-bundled-extras.js';
import { createPrefGroup, createRow } from '../sillybunny-editor/rows.js';
import { createArtPlaceholder } from './art.js';
import { COPY_PLACEHOLDER, markCopyPlaceholder, markRowSubtitle } from './copy.js';
import { openShellTarget } from './shell-targets.js';

const TITLE_ID = 'sb-home-extras-title';

function getGroupTitle(groupId) {
    switch (groupId) {
        case 'first-party-extensions': return t`First-Party Extensions`;
        case 'third-party-extensions': return t`Third-Party Extensions`;
        case 'themes': return t`Themes`;
        case 'presets': return t`Presets`;
        default: throw new Error(`No title for the Bundled Extras group: ${groupId}`);
    }
}

function createHeader(goBack) {
    const header = document.createElement('header');
    header.className = 'sbHomePageHeader';

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'sbHomeBack';
    back.dataset.sbPageBack = 'true';
    back.title = t`Back`;
    back.setAttribute('aria-label', t`Back`);
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-chevron-left';
    icon.setAttribute('aria-hidden', 'true');
    back.append(icon);
    back.addEventListener('click', goBack);

    const title = document.createElement('h2');
    title.id = TITLE_ID;
    title.className = 'sbHomePageTitle';
    title.textContent = t`Bundled Extras`;

    header.append(back, title);
    return header;
}

function createIntro() {
    const intro = document.createElement('div');
    intro.className = 'sbHomeIntro';
    const text = markCopyPlaceholder(document.createElement('p'), 'BE-INTRO');
    intro.append(createArtPlaceholder('extras-tewi'), text);
    return intro;
}

function createItemGroup(group) {
    const rows = group.items.map((item) => {
        const row = createRow({ label: item.name, subtitle: COPY_PLACEHOLDER, field: `bundled-extra-${item.id}` });
        markRowSubtitle(row, getBundledExtraSlot(item.id));
        return row;
    });
    return createPrefGroup({ title: getGroupTitle(group.id), field: `bundled-extras-${group.id}`, rows }).section;
}

/**
 * The Bundled Extras page: a header with Back, an intro and one boxed list per group.
 * @param {object} options
 * @param {() => void} options.goBack
 * @param {(target: string) => unknown} [options.openTarget]
 * @returns {HTMLElement}
 */
export function createExtrasPage({ goBack, openTarget = openShellTarget }) {
    const page = document.createElement('div');
    page.className = 'sbHomePage';
    page.tabIndex = -1;
    page.setAttribute('role', 'region');
    page.setAttribute('aria-labelledby', TITLE_ID);

    const uiThemes = createRow({
        label: t`UI Themes`,
        field: 'bundled-extras-ui-themes',
        activatable: true,
        onActivate: () => openTarget('ui-theme'),
    });

    const body = document.createElement('div');
    body.className = 'sbHomePageBody';
    body.append(
        createIntro(),
        ...groupBundledExtras().map(createItemGroup),
        createPrefGroup({ field: 'bundled-extras-ui-themes-group', rows: [uiThemes] }).section,
    );

    page.append(createHeader(goBack), body);
    return page;
}
