import { CARD_SCRIPT_MARKER_TAG, getCardScriptSnapshot } from './card-script-detection.js';
import {
    DEFAULT_LIMITS,
    POLICY_MODES,
    createDefaultPolicy,
    parseSlashCommandRequest,
} from './card-script-sandbox/allowlist.js';
import { validateSlashRequestMessage } from './card-script-sandbox/messages.js';
import { createRateLimiter } from './card-script-sandbox/rate-limiter.js';
import { buildSandboxDocument } from './card-script-sandbox/wrapper.js';
import { eventSource, event_types } from './events.js';

export const CARD_SCRIPT_CONFIRMATION_STORAGE_KEY = 'card_scripts_confirmed';
export const CARD_SCRIPT_RUN_BUTTON_SELECTOR = '.mes_run_card_scripts';
export const MAX_ACTIVE_CARD_SCRIPT_SANDBOXES = 5;

const activeSandboxes = new Map();
const completedSandboxRuns = new Set();

let runtimeInitialized = false;
let runtimeWindow = null;
let runtimeDocument = null;

const runtimeHandlers = {
    message: event => void handleSandboxMessage(event),
    click: event => void handleRunButtonClick(event),
    settingInput: event => handleSettingInput(event),
    chatChanged: () => {
        destroyAllSandboxes({ clearRunHistory: true });
    },
    messageDeleted: () => {
        destroyAllSandboxes({ clearRunHistory: true });
    },
    messageSwiped: messageId => {
        const normalizedMessageId = normalizeMessageId(messageId);
        if (normalizedMessageId !== null) {
            completedSandboxRuns.delete(normalizedMessageId);
            destroySandbox(normalizedMessageId);
            void syncCardScriptButtonForMessage(normalizedMessageId);
        }
    },
    userMessageRendered: messageId => void syncCardScriptButtonForMessage(messageId),
    characterMessageRendered: messageId => void syncCardScriptButtonForMessage(messageId),
    settingsLoaded: () => void syncAllCardScriptButtons(),
};

const defaultRuntimeDependencies = Object.freeze({
    getDocument: () => globalThis.document,
    getWindow: () => globalThis.window,
    getMutationObserver: () => globalThis.MutationObserver,
    getLocalStorage: () => globalThis.localStorage,
    getPowerUser: async () => {
        const module = await import('./power-user.js');
        return module.power_user;
    },
    getSlashExecutor: async () => {
        const module = await import('./slash-commands.js');
        return module.executeSlashCommandsWithOptions;
    },
    getCardScriptSnapshot,
    buildSandboxDocument,
    createRateLimiter,
    createNonce: createSecureNonce,
    now: () => Date.now(),
    showConfirmation: null,
    toastr: () => globalThis.toastr,
});

let runtimeDependencies = { ...defaultRuntimeDependencies };

export function configureCardScriptRuntime(dependencies = {}) {
    runtimeDependencies = {
        ...runtimeDependencies,
        ...dependencies,
    };
}

export function resetCardScriptRuntimeForTests() {
    teardownCardScriptRuntime();
    destroyAllSandboxes({ clearRunHistory: true });
    runtimeDependencies = { ...defaultRuntimeDependencies };
}

export function initCardScriptRuntime() {
    if (runtimeInitialized) {
        return;
    }

    runtimeWindow = getRuntimeWindow();
    runtimeDocument = getRuntimeDocument();

    runtimeWindow?.addEventListener?.('message', runtimeHandlers.message);
    runtimeDocument?.addEventListener?.('click', runtimeHandlers.click);
    runtimeDocument?.getElementById?.('allow_card_scripts')?.addEventListener?.('input', runtimeHandlers.settingInput);

    eventSource.on(event_types.CHAT_CHANGED, runtimeHandlers.chatChanged);
    eventSource.on(event_types.MESSAGE_DELETED, runtimeHandlers.messageDeleted);
    eventSource.on(event_types.MESSAGE_SWIPED, runtimeHandlers.messageSwiped);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, runtimeHandlers.userMessageRendered);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, runtimeHandlers.characterMessageRendered);
    eventSource.on(event_types.SETTINGS_LOADED_AFTER, runtimeHandlers.settingsLoaded);
    eventSource.on(event_types.APP_READY, runtimeHandlers.settingsLoaded);

    runtimeInitialized = true;
}

export function teardownCardScriptRuntime() {
    if (!runtimeInitialized) {
        return;
    }

    runtimeWindow?.removeEventListener?.('message', runtimeHandlers.message);
    runtimeDocument?.removeEventListener?.('click', runtimeHandlers.click);
    runtimeDocument?.getElementById?.('allow_card_scripts')?.removeEventListener?.('input', runtimeHandlers.settingInput);

    eventSource.removeListener(event_types.CHAT_CHANGED, runtimeHandlers.chatChanged);
    eventSource.removeListener(event_types.MESSAGE_DELETED, runtimeHandlers.messageDeleted);
    eventSource.removeListener(event_types.MESSAGE_SWIPED, runtimeHandlers.messageSwiped);
    eventSource.removeListener(event_types.USER_MESSAGE_RENDERED, runtimeHandlers.userMessageRendered);
    eventSource.removeListener(event_types.CHARACTER_MESSAGE_RENDERED, runtimeHandlers.characterMessageRendered);
    eventSource.removeListener(event_types.SETTINGS_LOADED_AFTER, runtimeHandlers.settingsLoaded);
    eventSource.removeListener(event_types.APP_READY, runtimeHandlers.settingsLoaded);

    runtimeWindow = null;
    runtimeDocument = null;
    runtimeInitialized = false;
}

export async function createSandbox(messageId) {
    const normalizedMessageId = normalizeMessageId(messageId);
    if (normalizedMessageId === null) {
        throw createRuntimeError('Invalid card script message id.', 'bad_message_id');
    }

    const policy = await getCardScriptRuntimePolicy();
    if (policy.mode === POLICY_MODES.DISABLED) {
        throw createRuntimeError('Card script execution is disabled.', 'policy_disabled');
    }

    const documentRef = getRuntimeDocument();
    if (!documentRef?.createElement) {
        throw createRuntimeError('Card script runtime requires a document.', 'missing_document');
    }

    const snapshot = runtimeDependencies.getCardScriptSnapshot(normalizedMessageId);
    if (!snapshot?.html) {
        throw createRuntimeError('No card script snapshot is available for this message.', 'missing_snapshot');
    }

    const messageElement = getMessageElement(normalizedMessageId, documentRef);
    if (!messageElement) {
        throw createRuntimeError('Message element is no longer available.', 'missing_message');
    }

    if (!activeSandboxes.has(normalizedMessageId) && activeSandboxes.size >= MAX_ACTIVE_CARD_SCRIPT_SANDBOXES) {
        throw createRuntimeError('Too many card script sandboxes are already running.', 'too_many_sandboxes');
    }

    destroySandbox(normalizedMessageId);

    const nonce = runtimeDependencies.createNonce();
    const iframeElement = documentRef.createElement('iframe');
    iframeElement.className = 'card-script-sandbox-frame';
    iframeElement.setAttribute('sandbox', 'allow-scripts');
    iframeElement.setAttribute('title', `Card script sandbox for message ${normalizedMessageId}`);
    iframeElement.setAttribute('aria-hidden', 'true');
    iframeElement.tabIndex = -1;
    iframeElement.srcdoc = runtimeDependencies.buildSandboxDocument({
        html: snapshot.html,
        messageId: normalizedMessageId,
        nonce,
    });

    if (iframeElement.style) {
        iframeElement.style.position = 'absolute';
        iframeElement.style.width = '0';
        iframeElement.style.height = '0';
        iframeElement.style.border = '0';
        iframeElement.style.visibility = 'hidden';
        iframeElement.style.pointerEvents = 'none';
    }

    messageElement.appendChild(iframeElement);

    const sandbox = {
        iframeElement,
        iframeWindow: iframeElement.contentWindow,
        messageId: normalizedMessageId,
        nonce,
        createdAt: runtimeDependencies.now(),
        rateLimiter: runtimeDependencies.createRateLimiter(),
        observer: createSandboxRemovalObserver(messageElement, normalizedMessageId, documentRef),
    };

    if (!sandbox.iframeWindow) {
        iframeElement.remove?.();
        sandbox.observer?.disconnect?.();
        sandbox.rateLimiter?.dispose?.();
        throw createRuntimeError('Card script sandbox window could not be created.', 'missing_iframe_window');
    }

    activeSandboxes.set(normalizedMessageId, sandbox);
    completedSandboxRuns.add(normalizedMessageId);
    await syncCardScriptButtonForMessage(normalizedMessageId, { messageElement });

    return sandbox;
}

export async function handleSandboxMessage(event) {
    const sandbox = getSandboxBySource(event?.source);
    if (!sandbox) {
        return rejectSandboxMessage('unknown_source');
    }

    const policy = await getCardScriptRuntimePolicy();
    const schema = validateSlashRequestMessage(event?.data, {
        maxCommandLength: policy.limits?.maxCommandLength ?? DEFAULT_LIMITS.maxCommandLength,
    });

    if (!schema.ok) {
        return rejectSandboxMessage(schema.reason, sandbox);
    }

    const message = schema.value;

    if (message.nonce !== sandbox.nonce) {
        return rejectSandboxMessage('bad_nonce', sandbox);
    }

    if (message.messageId !== sandbox.messageId) {
        return rejectSandboxMessage('bad_message_id', sandbox);
    }

    const rateLimit = sandbox.rateLimiter.tryAcquire();
    if (!rateLimit.ok) {
        return rejectSandboxMessage(rateLimit.reason, sandbox);
    }

    const parsed = parseSlashCommandRequest(message.command, policy);
    if (!parsed.ok) {
        return rejectSandboxMessage(parsed.reason, sandbox);
    }

    return executeSandboxCommand(parsed.command, sandbox.messageId, { alreadyValidated: true });
}

export async function executeSandboxCommand(command, messageId, { alreadyValidated = false } = {}) {
    const normalizedMessageId = normalizeMessageId(messageId);
    if (normalizedMessageId === null) {
        return { ok: false, reason: 'bad_message_id' };
    }

    if (!activeSandboxes.has(normalizedMessageId)) {
        return { ok: false, reason: 'sandbox_not_found' };
    }

    let commandToExecute = command;
    if (!alreadyValidated) {
        const policy = await getCardScriptRuntimePolicy();
        const parsed = parseSlashCommandRequest(command, policy);
        if (!parsed.ok) {
            return { ok: false, reason: parsed.reason };
        }
        commandToExecute = parsed.command;
    }

    const executeSlashCommandsWithOptions = await getSlashExecutor();
    if (typeof executeSlashCommandsWithOptions !== 'function') {
        return { ok: false, reason: 'missing_slash_executor' };
    }

    try {
        await executeSlashCommandsWithOptions(commandToExecute, {
            handleParserErrors: false,
            handleExecutionErrors: true,
            source: `card-script-sandbox:${normalizedMessageId}`,
        });
        return { ok: true };
    } catch (error) {
        console.warn('Card script sandbox command failed.', error);
        return { ok: false, reason: 'execution_failed' };
    }
}

export function destroySandbox(messageId) {
    const normalizedMessageId = normalizeMessageId(messageId);
    if (normalizedMessageId === null) {
        return false;
    }

    const sandbox = activeSandboxes.get(normalizedMessageId);
    if (!sandbox) {
        return false;
    }

    const messageElement = sandbox.iframeElement?.parentElement ?? getMessageElement(normalizedMessageId);
    activeSandboxes.delete(normalizedMessageId);
    sandbox.observer?.disconnect?.();
    sandbox.rateLimiter?.dispose?.();
    sandbox.iframeElement?.remove?.();
    syncDestroyedButtonState(messageElement);

    sandbox.iframeElement = null;
    sandbox.iframeWindow = null;
    sandbox.rateLimiter = null;
    sandbox.observer = null;

    void syncCardScriptButtonForMessage(normalizedMessageId);
    return true;
}

export function destroyAllSandboxes({ clearRunHistory = false } = {}) {
    const messageIds = [...activeSandboxes.keys()];
    for (const messageId of messageIds) {
        destroySandbox(messageId);
    }

    if (clearRunHistory) {
        completedSandboxRuns.clear();
    }
}

export function isSandboxActive(messageId) {
    const normalizedMessageId = normalizeMessageId(messageId);
    return normalizedMessageId !== null && activeSandboxes.has(normalizedMessageId);
}

export function getActiveSandboxCount() {
    return activeSandboxes.size;
}

export function getActiveSandbox(messageId) {
    const normalizedMessageId = normalizeMessageId(messageId);
    return normalizedMessageId === null ? null : activeSandboxes.get(normalizedMessageId) ?? null;
}

export async function syncAllCardScriptButtons() {
    const documentRef = getRuntimeDocument();
    const buttons = Array.from(documentRef?.querySelectorAll?.(CARD_SCRIPT_RUN_BUTTON_SELECTOR) ?? []);

    await Promise.all(buttons.map(button => {
        const messageElement = button.closest?.('.mes');
        const messageId = normalizeMessageId(messageElement?.getAttribute?.('mesid'));
        return syncCardScriptButtonForMessage(messageId, { messageElement });
    }));
}

export async function syncCardScriptButtonForMessage(messageId, { messageElement = null } = {}) {
    const normalizedMessageId = normalizeMessageId(messageId);
    if (normalizedMessageId === null) {
        return false;
    }

    const documentRef = getRuntimeDocument();
    const resolvedMessageElement = messageElement ?? getMessageElement(normalizedMessageId, documentRef);
    const button = resolvedMessageElement?.querySelector?.(CARD_SCRIPT_RUN_BUTTON_SELECTOR);

    if (!button) {
        return false;
    }

    const enabled = await isCardScriptRuntimeEnabled();
    const hasScriptMarker = messageHasCardScriptMarker(resolvedMessageElement, normalizedMessageId);
    const hasSnapshot = Boolean(runtimeDependencies.getCardScriptSnapshot(normalizedMessageId));
    const shouldShow = enabled && hasScriptMarker && hasSnapshot;
    const isActive = activeSandboxes.has(normalizedMessageId);
    const hasRun = completedSandboxRuns.has(normalizedMessageId);

    button.style.display = shouldShow ? '' : 'none';
    button.classList.toggle('script-running', shouldShow && isActive);
    button.classList.toggle('script-ran', shouldShow && hasRun && !isActive);
    button.classList.toggle('fa-play', !isActive);
    button.classList.toggle('fa-stop', isActive);
    button.setAttribute('title', isActive ? 'Stop card scripts' : 'Run card scripts');
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');

    return shouldShow;
}

export function messageHasCardScriptMarker(messageElement, messageId) {
    const normalizedMessageId = normalizeMessageId(messageId);
    if (!messageElement?.querySelectorAll || normalizedMessageId === null) {
        return false;
    }

    const markers = Array.from(messageElement.querySelectorAll(CARD_SCRIPT_MARKER_TAG));
    return markers.some(marker => Number(marker?.dataset?.msgId) === normalizedMessageId);
}

export async function isCardScriptRuntimeEnabled() {
    const powerUser = await getPowerUserSettings();
    return Boolean(powerUser?.allow_card_scripts);
}

export async function getCardScriptRuntimePolicy() {
    const enabled = await isCardScriptRuntimeEnabled();
    return createDefaultPolicy({
        mode: enabled ? POLICY_MODES.ALLOWLIST : POLICY_MODES.DISABLED,
    });
}

export function normalizeMessageId(messageId) {
    if (messageId === null || messageId === undefined || messageId === '') {
        return null;
    }

    const normalized = Number(messageId);
    return Number.isInteger(normalized) && normalized >= 0 ? normalized : null;
}

async function handleRunButtonClick(event) {
    const button = event?.target?.closest?.(CARD_SCRIPT_RUN_BUTTON_SELECTOR);
    if (!button) {
        return;
    }

    event.preventDefault?.();
    event.stopPropagation?.();

    const messageElement = button.closest?.('.mes');
    const messageId = normalizeMessageId(messageElement?.getAttribute?.('mesid'));
    if (messageId === null) {
        return;
    }

    if (activeSandboxes.has(messageId)) {
        destroySandbox(messageId);
        return;
    }

    if (!await confirmCardScriptExecution()) {
        return;
    }

    button.classList.add('script-running');

    try {
        await createSandbox(messageId);
    } catch (error) {
        button.classList.remove('script-running');
        console.warn('Could not start card script sandbox.', error);
        runtimeDependencies.toastr?.()?.warning?.('Could not start card scripts for this message.', 'Card scripts blocked', {
            timeOut: 6000,
            preventDuplicates: true,
        });
        await syncCardScriptButtonForMessage(messageId, { messageElement });
    }
}

function handleSettingInput(event) {
    if (!event?.currentTarget?.checked) {
        destroyAllSandboxes({ clearRunHistory: true });
    }

    getRuntimeWindow()?.setTimeout?.(() => void syncAllCardScriptButtons(), 0);
}

async function confirmCardScriptExecution() {
    // Security boundary: consent stays device-local and never syncs through account settings.
    const storage = runtimeDependencies.getLocalStorage?.();

    try {
        if (storage?.getItem?.(CARD_SCRIPT_CONFIRMATION_STORAGE_KEY) === 'true') {
            return true;
        }
    } catch {
        // Storage can be unavailable in hardened browser modes; fall through to confirmation.
    }

    const confirmed = await showCardScriptConfirmation();
    if (!confirmed) {
        return false;
    }

    try {
        storage?.setItem?.(CARD_SCRIPT_CONFIRMATION_STORAGE_KEY, 'true');
    } catch {
        // Confirmation remains valid for this click even if it cannot be persisted.
    }

    return true;
}

async function showCardScriptConfirmation() {
    if (typeof runtimeDependencies.showConfirmation === 'function') {
        return Boolean(await runtimeDependencies.showConfirmation());
    }

    const { callGenericPopup, POPUP_RESULT, POPUP_TYPE } = await import('./popup.js');
    const content = `
        <h3>Run card scripts?</h3>
        <p>This will run scripts embedded in this card inside a sandboxed iframe. Only a narrow allowlist of slash commands can cross back into SillyBunny.</p>
        <p>Do not run card scripts from cards you do not trust.</p>
    `;
    const result = await callGenericPopup(content, POPUP_TYPE.CONFIRM, null, {
        okButton: 'Run Scripts',
        cancelButton: 'Cancel',
        wide: false,
        large: false,
    });

    return result === POPUP_RESULT.AFFIRMATIVE;
}

async function getPowerUserSettings() {
    const powerUser = runtimeDependencies.getPowerUser?.();
    return powerUser instanceof Promise ? await powerUser : powerUser;
}

async function getSlashExecutor() {
    if (typeof runtimeDependencies.executeSlashCommandsWithOptions === 'function') {
        return runtimeDependencies.executeSlashCommandsWithOptions;
    }

    const executor = runtimeDependencies.getSlashExecutor?.();
    return executor instanceof Promise ? await executor : executor;
}

function getSandboxBySource(source) {
    for (const sandbox of activeSandboxes.values()) {
        if (sandbox.iframeWindow === source) {
            return sandbox;
        }
    }

    return null;
}

function rejectSandboxMessage(reason, sandbox = null) {
    if (reason !== 'unknown_source') {
        console.debug('Rejected card script sandbox message.', {
            reason,
            messageId: sandbox?.messageId,
        });
    }

    return { ok: false, reason };
}

function getMessageElement(messageId, documentRef = getRuntimeDocument()) {
    return documentRef?.querySelector?.(`#chat .mes[mesid="${messageId}"]`)
        ?? documentRef?.querySelector?.(`.mes[mesid="${messageId}"]`)
        ?? null;
}

function createSandboxRemovalObserver(messageElement, messageId, documentRef) {
    const MutationObserverCtor = runtimeDependencies.getMutationObserver?.();
    const chatContainer = documentRef?.querySelector?.('#chat') ?? messageElement?.parentElement;

    if (!MutationObserverCtor || !chatContainer) {
        return null;
    }

    const observer = new MutationObserverCtor((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.removedNodes ?? []) {
                if (node === messageElement || node?.contains?.(messageElement)) {
                    completedSandboxRuns.delete(messageId);
                    destroySandbox(messageId);
                    return;
                }
            }
        }
    });

    observer.observe(chatContainer, { childList: true, subtree: true });
    return observer;
}

function syncDestroyedButtonState(messageElement) {
    const button = messageElement?.querySelector?.(CARD_SCRIPT_RUN_BUTTON_SELECTOR);
    if (!button) {
        return;
    }

    button.classList.remove('script-running');
    button.classList.add('script-ran');
    button.classList.add('fa-play');
    button.classList.remove('fa-stop');
    button.setAttribute('title', 'Run card scripts');
    button.setAttribute('aria-pressed', 'false');
}

function getRuntimeDocument() {
    return runtimeDependencies.getDocument?.();
}

function getRuntimeWindow() {
    return runtimeDependencies.getWindow?.();
}

function createSecureNonce() {
    const cryptoRef = globalThis.crypto;

    if (typeof cryptoRef?.randomUUID === 'function') {
        return cryptoRef.randomUUID();
    }

    if (typeof cryptoRef?.getRandomValues === 'function') {
        const bytes = new Uint8Array(16);
        cryptoRef.getRandomValues(bytes);
        return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }

    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function createRuntimeError(message, reason) {
    const error = new Error(message);
    error.reason = reason;
    return error;
}
