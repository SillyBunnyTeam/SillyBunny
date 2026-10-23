import { isConversationModeActive } from './companion-panel.js';

let openOverview = () => false;

export function configureCompanionDashboard(hooks) {
    openOverview = hooks.openOverview;
}

// SillyBunny: preserve the public entry point, but never recreate the retired dashboard modal.
export async function openCompanionDashboard() {
    return openOverview();
}

export function initCompanionWandMenuItem() {
    if ($('#ica_companions_wand_item').length) return;
    const menuItem = $(`
        <div id="ica_companions_wand_item" class="list-group-item flex-container flexGap5 interactable" title="Open the Companion Agents dashboard" tabindex="0">
            <div class="fa-solid fa-user-astronaut extensionsMenuExtensionButton"></div>
            <span>Companion Agents</span>
        </div>
    `);
    menuItem.on('click', () => openCompanionDashboard());
    menuItem.toggle?.(!isConversationModeActive());
    $('#extensionsMenu').append(menuItem);
}
