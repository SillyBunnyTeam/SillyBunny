import { chat, chat_metadata, eventSource, event_types, getRequestHeaders, this_chid, characters } from '../../../script.js';
import { extension_settings } from '../../extensions.js';
import { QuickReplyApi } from './api/QuickReplyApi.js';
import { AutoExecuteHandler } from './src/AutoExecuteHandler.js';
// QuickReply imported lazily inside loadSets to avoid circular TDZ
import { QuickReplyConfig } from './src/QuickReplyConfig.js';
import { QuickReplySet } from './src/QuickReplySet.js';
import { getUniqueQuickReplySetLinksBySetName, getUniqueQuickReplySetsByName } from './src/quick-reply-set-list.js';
import { QuickReplySettings } from './src/QuickReplySettings.js';
import { SlashCommandHandler } from './src/SlashCommandHandler.js';
import { ButtonUi } from './src/ui/ButtonUi.js';
import { SettingsUi } from './src/ui/SettingsUi.js';
import { selected_group } from '../../group-chats.js';
import { debounceAsync, debug, log, warn } from './src/shared.js';
// Re-exported so that any existing `from '.../quick-reply/index.js'` imports
// keep working. Internally the other src/ modules should import from
// './shared.js' directly to avoid a circular back-edge — see shared.js.
export { debounceAsync, debug, log, warn };


const defaultConfig = {
    setList: [{
        set: 'Default',
        isVisible: true,
    }],
};

const defaultSettings = {
    isEnabled: false,
    isCombined: false,
    config: defaultConfig,
};


/** @type {Boolean}*/
let isReady = false;
// SillyBunny divergence: shared in-flight init promise; resets on rejection.
let initPromise = null;
/** @type {Function[]}*/
let executeQueue = [];
/** @type {string}*/
let lastCharId;
/** @type {QuickReplySettings}*/
let settings;
/** @type {SettingsUi} */
let manager;
/** @type {ButtonUi} */
let buttons;
/** @type {AutoExecuteHandler} */
let autoExec;
/** @type {QuickReplyApi} */
export let quickReplyApi;


let consumedInitialSettingsSnapshot = false;

const loadSets = async () => {
    // SillyBunny: reuse the startup /api/settings/get payload exposed by extensions.js instead of firing a duplicate POST at boot.
    const initialSnapshot = !consumedInitialSettingsSnapshot ? globalThis.__sbGetInitialSettingsSnapshot?.() : null;
    consumedInitialSettingsSnapshot = true;

    let settingsData = initialSnapshot;
    if (!settingsData) {
        const response = await fetch('/api/settings/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
        });
        if (!response.ok) {
            return;
        }
        settingsData = await response.json();
    }

    {
        const setList = settingsData.quickReplyPresets ?? [];
        const migratedSets = [];
        for (const set of setList) {
            if (set.version !== 2) {
                // migrate old QR set
                set.version = 2;
                set.disableSend = set.quickActionEnabled ?? false;
                set.placeBeforeInput = set.placeBeforeInputEnabled ?? false;
                set.injectInput = set.AutoInputInject ?? false;
                set.qrList = set.quickReplySlots.map((slot, idx) => {
                    const qr = {};
                    qr.id = idx + 1;
                    qr.label = slot.label ?? '';
                    qr.title = slot.title ?? '';
                    qr.message = slot.mes ?? '';
                    qr.isHidden = slot.hidden ?? false;
                    qr.executeOnStartup = slot.autoExecute_appStartup ?? false;
                    qr.executeOnUser = slot.autoExecute_userMessage ?? false;
                    qr.executeOnAi = slot.autoExecute_botMessage ?? false;
                    qr.executeOnChatChange = slot.autoExecute_chatLoad ?? false;
                    qr.executeOnGroupMemberDraft = slot.autoExecute_groupMemberDraft ?? false;
                    qr.executeOnNewChat = slot.autoExecute_newChat ?? false;
                    qr.executeBeforeGeneration = slot.autoExecute_beforeGeneration ?? false;
                    qr.automationId = slot.automationId ?? '';
                    qr.contextList = (slot.contextMenu ?? []).map(it => ({
                        set: it.preset,
                        isChained: it.chain,
                    }));
                    return qr;
                });
            }
            if (set.version == 2) {
                migratedSets.push(set);
            }
        }
        const uniqueSets = getUniqueQuickReplySetsByName(migratedSets);
        if (uniqueSets.length !== migratedSets.length) {
            warn(`Skipped ${migratedSets.length - uniqueSets.length} duplicate Quick Reply set(s) while loading.`);
        }

        QuickReplySet.list.splice(0, QuickReplySet.list.length, ...uniqueSets.map(set => QuickReplySet.from(JSON.parse(JSON.stringify(set)))));

        // need to load QR lists after all sets are loaded to be able to resolve context menu entries
        const { QuickReply } = await import('./src/QuickReply.js');
        uniqueSets.forEach((set, idx) => {
            QuickReplySet.list[idx].qrList = (set.qrList ?? []).map(it => QuickReply.from(it));
            QuickReplySet.list[idx].init();
        });
        log('sets: ', QuickReplySet.list);
    }
};

const loadSettings = async () => {
    if (!extension_settings.quickReplyV2) {
        if (!extension_settings.quickReply) {
            extension_settings.quickReplyV2 = defaultSettings;
        } else {
            extension_settings.quickReplyV2 = {
                isEnabled: extension_settings.quickReply.quickReplyEnabled ?? false,
                isCombined: false,
                isPopout: false,
                config: {
                    setList: [{
                        set: extension_settings.quickReply.selectedPreset ?? extension_settings.quickReply.name ?? 'Default',
                        isVisible: true,
                    }],
                },
            };
        }
    }
    try {
        settings = QuickReplySettings.from(extension_settings.quickReplyV2);
        settings.config.scope = 'global';
        settings.config.onUpdate = () => settings.save();
    } catch (ex) {
        settings = QuickReplySettings.from(defaultSettings);
    }
};

const executeIfReadyElseQueue = async (functionToCall, args) => {
    if (isReady) {
        log('calling', { functionToCall, args });
        await functionToCall(...args);
    } else {
        log('queueing', { functionToCall, args });
        executeQueue.push(async () => await functionToCall(...args));
    }
};

const handleCharChange = () => {
    if (lastCharId === this_chid) return;

    // Unload the old character's config and update the character ID cache.
    settings.charConfig = null;
    lastCharId = this_chid;

    // If no character is loaded, there's nothing more to do.
    /** @type {Character} */
    const character = characters[this_chid];
    if (!character || selected_group) {
        return;
    }

    // Get the character-specific config from the local settings storage.
    let charConfig = settings.characterConfigs[character.avatar];

    // If no config exists for this character, create a new one.
    if (!charConfig) {
        charConfig = QuickReplyConfig.from({ setList: [] });
        settings.characterConfigs[character.avatar] = charConfig;
    }

    charConfig.scope = 'character';
    // The main settings save function will handle persistence.
    charConfig.onUpdate = () => settings.save();
    settings.charConfig = charConfig;
};

async function doInit() {
    await loadSets();
    await loadSettings();
    log('settings: ', settings);

    manager = new SettingsUi(settings);
    const qrContainer = document.querySelector('#qr_container');
    const settingsDrawer = await manager.render();
    if (qrContainer && settingsDrawer) {
        // SillyBunny: clear stale settings roots before reattaching Quick Reply.
        qrContainer.querySelectorAll('#qr--settings').forEach(node => {
            if (node !== settingsDrawer) {
                node.remove();
            }
        });
        qrContainer.append(settingsDrawer);
    }

    buttons = new ButtonUi(settings);
    buttons.show();
    settings.onSave = () => buttons.refresh();

    globalThis.executeQuickReplyByName = async (name, args = {}, options = {}) => {
        let qr = [
            ...settings.config.setList,
            ...(settings.chatConfig?.setList ?? []),
            ...(settings.charConfig?.setList ?? []),
        ];
        qr = getUniqueQuickReplySetLinksBySetName(qr)
            .map(it => it.set.qrList)
            .flat()
            .find(it => it.label == name);
        if (!qr) {
            let [setName, ...qrName] = name.split('.');
            qrName = qrName.join('.');
            let qrs = QuickReplySet.get(setName);
            if (qrs) {
                qr = qrs.qrList.find(it => it.label == qrName);
            }
        }
        if (qr && qr.onExecute) {
            return await qr.execute(args, false, true, options);
        } else {
            throw new Error(`No Quick Reply found for "${name}".`);
        }
    };

    quickReplyApi = new QuickReplyApi(settings, manager);
    const slash = new SlashCommandHandler(quickReplyApi);
    slash.init();
    autoExec = new AutoExecuteHandler(settings);

    eventSource.on(event_types.APP_READY, async () => await finalizeInit());

    globalThis.quickReplyApi = quickReplyApi;
}

export function init() {
    if (initPromise) {
        return initPromise;
    }

    initPromise = doInit().catch(err => {
        initPromise = null;
        throw err;
    });
    return initPromise;
}

const finalizeInit = async () => {
    debug('executing startup');
    await autoExec.handleStartup();
    debug('/executing startup');

    debug(`executing queue (${executeQueue.length} items)`);
    while (executeQueue.length > 0) {
        const func = executeQueue.shift();
        await func();
    }
    debug('/executing queue');
    isReady = true;
    debug('READY');
};

// Fire-and-forget init — using top-level await here creates a circular
// top-level-await deadlock on slow boots: init() awaits a dynamic import of
// ./src/QuickReply.js, but that module statically imports from this file via
// `import { log, quickReplyApi, warn } from '../index.js'`. With top-level
// await the module resolver must wait for this file to finish evaluating
// before QuickReply.js can resolve — while this file is waiting on that
// import. The isReady flag + executeQueue pattern below already handles the
// case where event handlers fire before init completes.
init().catch(err => {
    console.error('[QR2] init failed:', err);
    try { toastr?.error(err?.message ?? String(err), 'Quick Reply init failed'); } catch { /* noop */ } // SillyBunny: capitalisation by DESIGN.md
});

const purgeCharacterQuickReplySets = ({ character }) => {
    // Remove the character's Quick Reply Sets from the settings.
    const avatar = character?.avatar;
    if (avatar && avatar in settings.characterConfigs) {
        log(`Purging Quick Reply Sets for character: ${avatar}`);
        delete settings.characterConfigs[avatar];
        settings.save();
    }
};

const updateCharacterQuickReplySets = (oldAvatar, newAvatar) => {
    // Update the character's Quick Reply Sets in the settings.
    if (oldAvatar && newAvatar && oldAvatar !== newAvatar) {
        log(`Updating Quick Reply Sets for character: ${oldAvatar} -> ${newAvatar}`);
        if (settings.characterConfigs[oldAvatar]) {
            settings.characterConfigs[newAvatar] = settings.characterConfigs[oldAvatar];
            delete settings.characterConfigs[oldAvatar];
            settings.save();
        }
    }
};

const onChatChanged = async (chatIdx) => {
    log('CHAT_CHANGED', chatIdx);

    handleCharChange();

    if (chatIdx) {
        const chatConfig = QuickReplyConfig.from(chat_metadata.quickReply ?? {});
        chatConfig.scope = 'chat';
        chatConfig.onUpdate = () => settings.save();
        settings.chatConfig = chatConfig;
    } else {
        settings.chatConfig = null;
    }
    manager.rerender();
    buttons.refresh();

    await autoExec.handleChatChanged();
};
eventSource.on(event_types.CHAT_CHANGED, (...args) => executeIfReadyElseQueue(onChatChanged, args));
eventSource.on(event_types.CHARACTER_DELETED, purgeCharacterQuickReplySets);
eventSource.on(event_types.CHARACTER_RENAMED, updateCharacterQuickReplySets);

const onUserMessage = async () => {
    await autoExec.handleUser();
};
eventSource.makeFirst(event_types.USER_MESSAGE_RENDERED, (...args) => executeIfReadyElseQueue(onUserMessage, args));

const onAiMessage = async (messageId) => {
    if (['...'].includes(chat[messageId]?.mes)) {
        log('QR auto-execution suppressed for swiped message');
        return;
    }

    await autoExec.handleAi();
};
eventSource.makeFirst(event_types.CHARACTER_MESSAGE_RENDERED, (...args) => executeIfReadyElseQueue(onAiMessage, args));

const onGroupMemberDraft = async () => {
    await autoExec.handleGroupMemberDraft();
};
eventSource.on(event_types.GROUP_MEMBER_DRAFTED, (...args) => executeIfReadyElseQueue(onGroupMemberDraft, args));

const onWIActivation = async (entries) => {
    await autoExec.handleWIActivation(entries);
};
eventSource.on(event_types.WORLD_INFO_ACTIVATED, (...args) => executeIfReadyElseQueue(onWIActivation, args));

const onNewChat = async () => {
    await autoExec.handleNewChat();
};
eventSource.on(event_types.CHAT_CREATED, (...args) => executeIfReadyElseQueue(onNewChat, args));
eventSource.on(event_types.GROUP_CHAT_CREATED, (...args) => executeIfReadyElseQueue(onNewChat, args));

const onBeforeGeneration = async (_generationType, _options = {}, isDryRun = false) => {
    if (isDryRun) {
        // SillyBunny: prompt previews and topbar token refreshes legitimately use dry-runs,
        // so keep this at debug level instead of spamming the normal log stream.
        debug('Before-generation hook skipped due to dryRun.');
        return;
    }
    if (selected_group && this_chid === undefined) {
        log('Before-generation hook skipped for event before group wrapper.');
        return;
    }
    await autoExec.handleBeforeGeneration();
};
eventSource.on(event_types.GENERATION_AFTER_COMMANDS, (...args) => executeIfReadyElseQueue(onBeforeGeneration, args));
