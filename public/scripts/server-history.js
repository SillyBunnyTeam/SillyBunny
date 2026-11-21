import { saveSettingsDebounced } from '../script.js';
import { power_user } from './power-user.js';
import { isValidUrl } from './utils.js';

// SillyBunny: Text Completion and Chat Completion KoboldCpp share the "koboldcpp" history label, so inputs and
// connect buttons are matched within their own API panel.
const API_PANELS = '#kobold_api, #novel_api, #textgenerationwebui_api, #openai_api';

/**
 * @param {Element} element Server URL input or connect button
 * @returns {JQuery} API panel that holds the element, or the whole document when it sits outside one
 */
function getApiPanel(element) {
    const panel = $(element).closest(API_PANELS);
    return panel.length ? panel : $(document);
}

/**
 * @param {{ term: string; }} request
 * @param {function} resolve
 * @param {string} serverLabel
 */
function findServers(request, resolve, serverLabel) {
    if (!power_user.servers) {
        power_user.servers = [];
    }

    const needle = request.term.toLowerCase();
    const result = power_user.servers.filter(x => x.label == serverLabel).sort((a, b) => b.lastConnection - a.lastConnection).map(x => x.url).slice(0, 5);
    const hasExactMatch = result.findIndex(x => x.toLowerCase() == needle) !== -1;

    if (request.term && !hasExactMatch) {
        result.unshift(request.term);
    }

    resolve(result);
}

function selectServer(event, ui, serverLabel) {
    // unfocus the input
    $(event.target).val(ui.item.value).trigger('input').trigger('blur');

    // SillyBunny: only connect from the API panel that holds this input.
    getApiPanel(event.target).find('[data-server-connect]').each(function () {
        const serverLabels = String($(this).data('server-connect')).split(',');

        if (serverLabels.includes(serverLabel)) {
            $(this).trigger('click');
        }
    });
}

function createServerAutocomplete() {
    const inputElement = $(this);
    if (inputElement.autocomplete('instance')) return;
    const serverLabel = inputElement.data('server-history');

    inputElement
        .autocomplete({
            source: (i, o) => findServers(i, o, serverLabel),
            select: (e, u) => selectServer(e, u, serverLabel),
            minLength: 0,
        })
        .on('focus', onInputFocus); // <== show tag list on click
}

function onInputFocus() {
    $(this).autocomplete('search', $(this).val());
}

// SillyBunny: exported for a connect button whose own click handler stops the click before the document sees it.
export function onServerConnectClick() {
    const serverLabels = String($(this).data('server-connect')).split(',');
    // SillyBunny: save the URL from the API panel that holds this button.
    const panel = getApiPanel(this);

    serverLabels.forEach(serverLabel => {
        if (!power_user.servers) {
            power_user.servers = [];
        }

        const value = String(panel.find(`[data-server-history="${serverLabel}"]`).val()).toLowerCase().trim();

        // Don't save empty values or invalid URLs
        if (!value || !isValidUrl(value)) {
            return;
        }

        const server = power_user.servers.find(x => x.url === value && x.label === serverLabel);

        if (!server) {
            power_user.servers.push({ label: serverLabel, url: value, lastConnection: Date.now() });
        } else {
            server.lastConnection = Date.now();
        }

        saveSettingsDebounced();
    });
}

export function initServerHistory() {
    // SillyBunny: inactive provider inputs do not need autocomplete menus at startup.
    $(document).on('focusin', '[data-server-history]', function () {
        if ($(this).autocomplete('instance')) return;
        createServerAutocomplete.call(this);
        onInputFocus.call(this);
    });
    $(document).on('click', '[data-server-connect]', onServerConnectClick);
}
