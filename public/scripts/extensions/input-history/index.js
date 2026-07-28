import { eventSource, event_types, saveSettingsDebounced } from '../../../script.js';
import { extension_settings } from '../../extensions.js';
import { delay, isTrueBoolean } from '../../utils.js';
import { accountStorage } from '../../util/AccountStorage.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { waitForFrame } from './lib/wait.js';

const INPUT_HISTORY_STORAGE_KEY = 'st--inputHistory';

class Settings {
    /**@type {number}*/ maxHistory = 10;
    /**@type {boolean}*/ showButtons = true;
    /**@type {boolean}*/ showArrowButtons = true;
    /**@type {boolean}*/ showHistoryButton = true;
}
/**@type {Settings}*/
const settings = Object.assign(new Settings, extension_settings.inputHistory ?? {});
extension_settings.inputHistory = settings;

/**@type {HTMLTextAreaElement} */
let ta;
/**@type {string} */
let taValue;
/**@type {HTMLElement} */
let buttonWrap;
/**@type {HTMLElement} */
let arrowsWrap;
/**@type {HTMLElement} */
let btnHistory;
/**@type {HTMLElement} */
let historyMenu;
/**@type {MutationObserver} */
let buttonPlacementObserver;

const placeButtonWrap = () => {
    if (!buttonWrap) return;

    const guidedContainer = document.querySelector('#gg-action-button-container');
    if (guidedContainer) {
        if (buttonWrap.parentElement !== guidedContainer || guidedContainer.firstElementChild !== buttonWrap) {
            guidedContainer.prepend(buttonWrap);
        }
        buttonWrap.classList.remove('stih--standalone');
        return;
    }

    const sendForm = document.querySelector('#send_form');
    const nonQrFormItems = document.querySelector('#nonQRFormItems');
    if (!sendForm || !nonQrFormItems) return;

    if (buttonWrap.parentElement !== sendForm || buttonWrap.nextElementSibling !== nonQrFormItems) {
        sendForm.insertBefore(buttonWrap, nonQrFormItems);
    }
    buttonWrap.classList.add('stih--standalone');
};

const startButtonPlacementObserver = () => {
    if (buttonPlacementObserver) return;

    buttonPlacementObserver = new MutationObserver(() => placeButtonWrap());
    buttonPlacementObserver.observe(document.querySelector('#send_form') ?? document.body, { childList: true, subtree: true });
};


SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name: 'inputhistory-config',
    callback: ({ key, get }, value) => {
        if (!key) {
            toastr.error('Required argument "key" missing for /inputhistory-conf');
            return;
        }
        const keys = Object.keys(settings);
        const types = {
            maxHistory: Number,
            showButtons: isTrueBoolean,
            showArrowButtons: isTrueBoolean,
            showHistoryButton: isTrueBoolean,
        };
        if (!keys.includes(key)) {
            toastr.error(`Invalid "key" argument "${key}" supplied for /inputhistory-conf`);
            return;
        }
        if (isTrueBoolean(get)) {
            toastr.info(`Input History setting ${key} = ${JSON.stringify(settings[key])}`);
            return JSON.stringify(settings[key]);
        }
        settings[key] = types[key](value.trim());
        updateButtons();
        saveSettingsDebounced();
    },
    aliases: ['ih-config'],
    namedArgumentList: [
        SlashCommandNamedArgument.fromProps({ name: 'key',
            description: 'Key of the setting to change or retrieve',
            typeList: [ARGUMENT_TYPE.STRING],
            enumList: Object.keys(settings),
            isRequired: true,
        }),
        SlashCommandNamedArgument.fromProps({ name: 'get',
            description: 'Whether to retrieve the setting\'s current value without changing it.',
            typeList: [ARGUMENT_TYPE.BOOLEAN],
            isRequired: false,
            defaultValue: 'false',
            enumList: ['true', 'false'],
        }),
    ],
    unnamedArgumentList: [
        SlashCommandArgument.fromProps({ description: 'the new config value',
            typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.BOOLEAN],
            isRequired: false,
        }),
    ],
    helpString: 'Change Input History configuration. Use <code>get=true</code> to retrieve the current value.',
}));

SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name: 'inputhistory-add',
    callback: (args, value) => {
        if (value.trim() == '') {
            toastr.error('Required string missing for /inputhistory-add');
            return;
        }
        addToInputHistory(value);
    },
    aliases: ['ih-add'],
    unnamedArgumentList: [
        SlashCommandArgument.fromProps({ description: 'string to add to input history',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: true,
        }),
    ],
    helpString: 'Adds input string to Input History (typically used for Quick Reply macros).',
}));

const hideHistoryMenu = async () => {
    if (!historyMenu) return;
    historyMenu.classList.remove('stih--active');
    await delay(410);
    historyMenu.remove();
    historyMenu = null;
    btnHistory.classList.remove('stih--hasMenu');
};
const showHistoryMenu = async () => {
    if (historyMenu) return hideHistoryMenu();
    btnHistory.classList.add('stih--hasMenu');
    historyMenu = document.createElement('div'); {
        historyMenu.classList.add('stih--history');
        const renderItem = (c) => {
            const item = document.createElement('div'); {
                item.classList.add('stih--item');
                item.title = c;
                const icon = document.createElement('div'); {
                    icon.classList.add('stih--icon');
                    icon.classList.add('fa-solid', 'fa-comment');
                    item.append(icon);
                }
                const label = document.createElement('div'); {
                    label.classList.add('stih--label');
                    const content = document.createElement('div'); {
                        content.classList.add('stih--content');
                        const title = document.createElement('div'); {
                            title.classList.add('stih--title');
                            if (c[0] == '/') title.classList.add('stih--code');
                            title.textContent = c;
                            content.append(title);
                        }
                        label.append(content);
                    }
                    item.append(label);
                }
                item.addEventListener('click', async () => {
                    hideHistoryMenu();
                    ta.value = c;
                    ta.focus({ preventScroll: true });
                });
                historyMenu.append(item);
            }
        };
        for (const c of getInputHistory()) {
            renderItem(c);
        }
        await waitForFrame();
        buttonWrap.append(historyMenu);
        await waitForFrame();
        historyMenu.classList.add('stih--active');
    }
};
const updateButtons = () => {
    if (!ta) return;

    if (!buttonWrap) {
        const wrap = document.createElement('div'); {
            buttonWrap = wrap;
            wrap.classList.add('stih--buttons');
            const arrows = document.createElement('div'); {
                arrowsWrap = arrows;
                arrows.classList.add('stih--arrows');
                const prev = document.createElement('div'); {
                    prev.classList.add('stih--button');
                    prev.classList.add('menu_button');
                    prev.classList.add('menu_button_icon');
                    prev.classList.add('fa-solid');
                    prev.classList.add('fa-chevron-up');
                    prev.title = 'Previous input';
                    prev.addEventListener('click', () => inputHistoryBack());
                    arrows.append(prev);
                }
                const next = document.createElement('div'); {
                    next.classList.add('stih--button');
                    next.classList.add('menu_button');
                    next.classList.add('menu_button_icon');
                    next.classList.add('fa-solid');
                    next.classList.add('fa-chevron-down');
                    next.title = 'Next input';
                    next.addEventListener('click', () => inputHistoryForward());
                    arrows.append(next);
                }
                wrap.append(arrows);
            }
            const his = document.createElement('div'); {
                btnHistory = his;
                his.classList.add('stih--button');
                his.classList.add('menu_button');
                his.classList.add('menu_button_icon');
                his.classList.add('stih--menuTrigger');
                his.classList.add('fa-solid');
                his.classList.add('fa-clock-rotate-left');
                his.title = 'Input History';
                his.addEventListener('click', () => showInputHistory());
                wrap.append(his);
            }
            startButtonPlacementObserver();
        }
    }
    placeButtonWrap();
    buttonWrap.classList[settings.showButtons ? 'remove' : 'add']('stih--hidden');
    arrowsWrap.classList[settings.showArrowButtons ? 'remove' : 'add']('stih--hidden');
    btnHistory.classList[settings.showHistoryButton ? 'remove' : 'add']('stih--hidden');
    if (!settings.showHistoryButton) hideHistoryMenu();
};

eventSource.on(event_types.APP_READY, async () => {
    ta = document.querySelector('#send_textarea');
    if (!ta) {
        console.error('Input History: Textarea #send_textarea not found.');
        return;
    }

    ta.addEventListener('keydown', (evt) => {
        if (evt.altKey) {
            if (evt.key == 'ArrowUp') {
                evt.preventDefault();
                evt.stopPropagation();
                inputHistoryBack();
            } else if (evt.key == 'ArrowDown') {
                evt.preventDefault();
                evt.stopPropagation();
                inputHistoryForward();
            }
        }
    });
    ta.addEventListener('input', () => {
        if (ta.value.trim() != '') taValue = ta.value;
        if (!historyMenu) return;
        const text = ta.value.trim();
        if (text.length == 0) {
            for (const el of historyMenu.children) {
                el.classList.remove('stih--hidden');
            }
        } else {
            const terms = text.split(/\s+/);
            getInputHistory().forEach((c, idx) => {
                if (terms.filter(it => c.toLowerCase().includes(it.toLowerCase())).length == terms.length) {
                    historyMenu.children[idx].classList.remove('stih--hidden');
                } else {
                    historyMenu.children[idx].classList.add('stih--hidden');
                }
            });
        }
    });
    updateButtons();
});
eventSource.on(event_types.GENERATION_STARTED, () => {
    addToInputHistory(taValue);
});


let inputHistoryIdx = -1;
export function getInputHistory() {
    try {
        return JSON.parse(accountStorage.getItem(INPUT_HISTORY_STORAGE_KEY) ?? '[]');
    } catch {
        return [];
    }
}
export function setInputHistory(inputHistory) {
    try {
        accountStorage.setItem(INPUT_HISTORY_STORAGE_KEY, JSON.stringify(inputHistory));
    } catch {
        // Persistence failure does not discard the caller's in-memory history.
    }
}
export function addToInputHistory(text) {
    text = text?.trim();
    if (text?.length) {
        const history = getInputHistory();
        if (history[0] != text) {
            history.unshift(text);
            while (history.length > settings.maxHistory) {
                history.pop();
            }
            setInputHistory(history);
        }
        inputHistoryIdx = -1;
    }
}
export function inputHistoryBack() {
    const history = getInputHistory();
    if (inputHistoryIdx + 1 < history.length) {
        inputHistoryIdx++;
    }
    ta.value = history[inputHistoryIdx];
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}
export function inputHistoryForward() {
    const history = getInputHistory();
    if (inputHistoryIdx >= 0) {
        inputHistoryIdx--;
    }
    if (history.length == 0 || inputHistoryIdx < 0) {
        ta.value = '';
    } else {
        ta.value = history[inputHistoryIdx];
    }
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}
export function showInputHistory() {
    showHistoryMenu();
    ta.focus({ preventScroll: true });
}
