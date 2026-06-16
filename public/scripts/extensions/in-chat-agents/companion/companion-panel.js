import { chat } from '../../../../script.js';
import { hideChatMessageRange } from '../../../chats.js';
import { eventSource, event_types } from '../../../events.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { escapeHtml } from '../../../utils.js';
import {
    areAgentsGloballyEnabled,
    getAgents,
    getCompanionConfig,
    isAgentEnabledForCurrentScope,
    isCompanionAgent,
    saveAgent,
} from '../agent-store.js';
import {
    COMPANION_RESULTS_UPDATED_EVENT,
    getCompanionResults,
    runCompanionAgentOnMessage,
    runCompanionsOnMessage,
} from './companion-runner.js';
import {
    cleanCompanionAgentName,
    editCompanionResult,
    formatCompanionContent,
    insertChoiceIntoMessageInput,
    isSuppressedCompanionResult,
} from './companion-ui.js';
import {
    CHAT_ONLY_INPUT_MAX_CHARS,
    CHATROOM_REPLY_MAX_CHARS,
    MEMORY_SHARD_TEMPLATE_ID,
    PLOT_COMPASS_OBJECTIVE_MAX_CHARS,
    appendChatOnlyUserMessage,
    isAssistantMessage,
    isChatOnlyAgent,
    isChatroomAgent,
    isPlotCompassAgent,
    normalizeChatOnlyInput,
    normalizeChatroomReply,
    normalizePlotCompassObjective,
} from './companion-shared.js';

const PANEL_HISTORY_LIMIT = 5;
// v2: v1 could persist scroll-corrupted positions on iOS (drag hijacked into a page scroll),
// pinning the handle to a screen edge with no way to drag it back. The old key is abandoned.
// The value is either a bare number (legacy: fraction along the right edge) or a JSON
// object { edge, fraction } once the handle has been docked somewhere else.
const HANDLE_POSITION_STORAGE_KEY = 'ica--tracker-panel-handle-top-v2';
const PANEL_LOCK_STORAGE_KEY = 'ica--tracker-panel-locked';
const HANDLE_DRAG_THRESHOLD_PX = 6;
const HANDLE_EDGES = ['right', 'left', 'top', 'bottom'];

let panelInitialized = false;
let panelOpen = false;
let panelLocked = getStoredPanelLocked();
let panelOpenedAt = 0;
let suppressHandleClickUntil = 0;
let handleNode = null;
/** Behavior owned by index.js (the agent editor) arrives through this seam — no import cycle. */
let panelHooks = null;

export function configureCompanionPanel(hooks) {
    panelHooks = hooks;
}

/** Keeps the dragged handle reachable: never closer than 8% to either end of its edge. */
export function clampHandleTopFraction(fraction) {
    const numeric = Number(fraction);
    return Math.min(0.92, Math.max(0.08, Number.isFinite(numeric) ? numeric : 0.5));
}

/** Accepts the legacy bare-number value (right-edge fraction) or the { edge, fraction } JSON. */
export function parseStoredHandlePosition(raw) {
    if (raw === null || raw === undefined || raw === '') {
        return null;
    }

    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
        return { edge: 'right', fraction: clampHandleTopFraction(numeric) };
    }

    try {
        const parsed = JSON.parse(String(raw));
        if (HANDLE_EDGES.includes(parsed?.edge)) {
            return { edge: parsed.edge, fraction: clampHandleTopFraction(parsed.fraction) };
        }
    } catch {
        // Garbage value: fall through to null.
    }

    return null;
}

function getStoredHandlePosition() {
    try {
        return parseStoredHandlePosition(globalThis.localStorage?.getItem?.(HANDLE_POSITION_STORAGE_KEY));
    } catch {
        return null;
    }
}

function storeHandlePosition(edge, fraction) {
    try {
        globalThis.localStorage?.setItem?.(HANDLE_POSITION_STORAGE_KEY, JSON.stringify({
            edge: HANDLE_EDGES.includes(edge) ? edge : 'right',
            fraction: clampHandleTopFraction(fraction),
        }));
    } catch {
        // Private browsing or storage quota: the position just won't persist.
    }
}

function getStoredPanelLocked() {
    try {
        return globalThis.localStorage?.getItem?.(PANEL_LOCK_STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

function storePanelLocked(locked) {
    try {
        globalThis.localStorage?.setItem?.(PANEL_LOCK_STORAGE_KEY, locked ? 'true' : 'false');
    } catch {
        // Private browsing or storage quota: the lock still applies for this session.
    }
}

function getViewportWidth() {
    return globalThis.visualViewport?.width || globalThis.innerWidth || 1;
}

function getViewportHeight() {
    return globalThis.visualViewport?.height || globalThis.innerHeight || 1;
}

/** Picks the dock for a release point: nearest viewport edge plus the fraction along it. */
export function resolveHandleDock(centerX, centerY, viewportWidth, viewportHeight) {
    const distances = {
        left: centerX,
        right: viewportWidth - centerX,
        top: centerY,
        bottom: viewportHeight - centerY,
    };
    const edge = HANDLE_EDGES.reduce((best, candidate) => (distances[candidate] < distances[best] ? candidate : best), 'right');
    const fraction = edge === 'left' || edge === 'right'
        ? centerY / (viewportHeight || 1)
        : centerX / (viewportWidth || 1);

    return { edge, fraction: clampHandleTopFraction(fraction) };
}

/**
 * Positions in pixels via inline style: percentages on position:fixed elements resolve
 * against whatever containing block the page creates (mobile shells included), which can
 * pin the handle to the top edge. Pixels measured from the viewport cannot.
 */
function placeDockedHandle() {
    if (!handleNode?.getBoundingClientRect) {
        return;
    }

    const { edge, fraction } = getStoredHandlePosition() ?? { edge: 'right', fraction: 0.5 };
    handleNode.setAttribute('data-edge', edge);

    const rect = handleNode.getBoundingClientRect();
    const width = rect.width || 40;
    const height = rect.height || 110;
    const viewportWidth = getViewportWidth();
    const viewportHeight = getViewportHeight();

    let left;
    let top;
    if (edge === 'left' || edge === 'right') {
        left = edge === 'left' ? 0 : viewportWidth - width;
        top = clampHandleTopFraction(fraction) * viewportHeight - height / 2;
    } else {
        top = edge === 'top' ? 0 : viewportHeight - height;
        left = clampHandleTopFraction(fraction) * viewportWidth - width / 2;
    }

    handleNode.style.left = `${Math.round(Math.min(Math.max(left, 0), viewportWidth - width))}px`;
    handleNode.style.top = `${Math.round(Math.min(Math.max(top, 0), viewportHeight - height))}px`;
}

function requestHandlePlacement() {
    if (!handleNode) {
        return;
    }

    if (typeof globalThis.requestAnimationFrame === 'function') {
        globalThis.requestAnimationFrame(placeDockedHandle);
    } else {
        placeDockedHandle();
    }
}

/**
 * Touch drives touch, pointer events drive only mouse/pen. iOS WebKit's pointer events are
 * unreliable for touch drags on position:fixed elements (touch-action ignored, scroll
 * takeover firing pointercancel, spotty pointermove delivery after capture) — raw touch
 * events with a non-passive preventDefault have none of those problems.
 */
function bindHandleDrag(handleElement) {
    if (!handleElement?.addEventListener) {
        return;
    }

    handleNode = handleElement;
    placeDockedHandle();
    globalThis.addEventListener?.('resize', requestHandlePlacement);
    globalThis.visualViewport?.addEventListener?.('resize', requestHandlePlacement);

    let activeMode = null;
    let activePointerId = null;
    let startClientX = 0;
    let startClientY = 0;
    let startCenterX = 0;
    let startCenterY = 0;
    let dragging = false;

    const beginDrag = (clientX, clientY) => {
        startClientX = clientX;
        startClientY = clientY;
        const rect = handleElement.getBoundingClientRect();
        startCenterX = rect.left + rect.width / 2;
        startCenterY = rect.top + rect.height / 2;
        dragging = false;
    };

    const moveDrag = (clientX, clientY) => {
        const deltaX = clientX - startClientX;
        const deltaY = clientY - startClientY;
        if (!dragging && Math.max(Math.abs(deltaX), Math.abs(deltaY)) < HANDLE_DRAG_THRESHOLD_PX) {
            return;
        }

        dragging = true;
        const rect = handleElement.getBoundingClientRect();
        handleElement.style.left = `${Math.round(startCenterX + deltaX - rect.width / 2)}px`;
        handleElement.style.top = `${Math.round(startCenterY + deltaY - rect.height / 2)}px`;
    };

    const finishDrag = cancelled => {
        const wasDragging = dragging;
        dragging = false;
        activeMode = null;

        if (!wasDragging) {
            return;
        }

        // The click that follows the gesture would toggle the panel; swallow it.
        suppressHandleClickUntil = Date.now() + 350;

        if (!cancelled) {
            // Snap to the nearest viewport edge and remember the dock.
            const rect = handleElement.getBoundingClientRect();
            const dock = resolveHandleDock(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
                getViewportWidth(),
                getViewportHeight(),
            );
            storeHandlePosition(dock.edge, dock.fraction);
        }

        // Cancelled drags re-place from storage; completed ones apply the new dock.
        placeDockedHandle();
    };

    handleElement.addEventListener('touchstart', event => {
        if (activeMode || !event.touches?.length) {
            return;
        }
        activeMode = 'touch';
        beginDrag(event.touches[0].clientX, event.touches[0].clientY);
    }, { passive: true });

    handleElement.addEventListener('touchmove', event => {
        if (activeMode !== 'touch' || !event.touches?.length) {
            return;
        }
        // Non-passive: the gesture must never become a page scroll, even where iOS
        // ignores touch-action on fixed elements.
        if (event.cancelable) {
            event.preventDefault();
        }
        moveDrag(event.touches[0].clientX, event.touches[0].clientY);
    }, { passive: false });

    const touchEnd = event => {
        if (activeMode !== 'touch') {
            return;
        }
        finishDrag(event.type === 'touchcancel');
    };
    handleElement.addEventListener('touchend', touchEnd);
    handleElement.addEventListener('touchcancel', touchEnd);

    handleElement.addEventListener('pointerdown', event => {
        if (activeMode || event.pointerType === 'touch') {
            return;
        }
        activeMode = 'pointer';
        activePointerId = event.pointerId;
        handleElement.setPointerCapture?.(event.pointerId);
        beginDrag(event.clientX, event.clientY);
    });

    handleElement.addEventListener('pointermove', event => {
        if (activeMode !== 'pointer' || event.pointerId !== activePointerId) {
            return;
        }
        event.preventDefault();
        moveDrag(event.clientX, event.clientY);
    });

    const pointerEnd = (event, cancelled) => {
        if (activeMode !== 'pointer' || event.pointerId !== activePointerId) {
            return;
        }
        handleElement.releasePointerCapture?.(event.pointerId);
        activePointerId = null;
        finishDrag(cancelled);
    };
    handleElement.addEventListener('pointerup', event => pointerEnd(event, false));
    handleElement.addEventListener('pointercancel', event => pointerEnd(event, true));
}

function getPanelAgents() {
    return getAgents().filter(agent => isCompanionAgent(agent) && agent.category !== 'tool');
}

// SillyBunny: the slide-out tracker panel is the home for 'panel'-mode companion state only.
// 'card' renders inline under the reply (handled by isHiddenCompanionResult in companion-ui),
// and 'hidden' is feedback-only and renders nowhere. When a live agent exists we trust its
// current editor config so flipping the Display dropdown takes effect on the next render; for
// orphaned results (deleted agent) we fall back to the mode stored on the result, defaulting to
// the product default ('panel') when absent.
function isPanelDisplayMode(agent, result = {}) {
    if (agent) {
        return getCompanionConfig(agent).displayMode === 'panel';
    }

    return (result.displayMode ?? 'panel') === 'panel';
}

function getLatestAssistantIndex() {
    return chat.findLastIndex(isAssistantMessage);
}

async function savePlotCompassObjective(agent, objective) {
    if (!agent || !isPlotCompassAgent(agent)) {
        return;
    }

    agent.settings = agent.settings && typeof agent.settings === 'object' && !Array.isArray(agent.settings)
        ? { ...agent.settings }
        : {};
    agent.settings.plotCompassObjective = normalizePlotCompassObjective(objective);
    await saveAgent(agent);
}

/**
 * Collects the latest stored result (and a short history) per companion agent by walking
 * the chat backwards. Enabled agents without any stored state are included so the panel
 * can explain that they have not run yet.
 */
export function collectPanelAgentStates() {
    const byAgentId = new Map();

    for (const agent of getPanelAgents()) {
        // SillyBunny: only 'panel'-mode companions belong in the tracker panel; 'card' and 'hidden' are excluded.
        if (isAgentEnabledForCurrentScope(agent) && isPanelDisplayMode(agent)) {
            byAgentId.set(agent.id, { agentId: agent.id, agent, latest: null, history: [] });
        }
    }

    for (let messageIndex = chat.length - 1; messageIndex >= 0; messageIndex--) {
        const message = chat[messageIndex];
        if (!isAssistantMessage(message)) {
            continue;
        }

        for (const [agentId, result] of Object.entries(getCompanionResults(message))) {
            if (!result || typeof result !== 'object') {
                continue;
            }

            if (isSuppressedCompanionResult(agentId, result)) {
                continue;
            }

            // SillyBunny: resolve the agent up front so we can filter by display mode before
            // creating any panel state. 'card' and 'hidden' results stay out of the panel;
            // orphaned results fall back to the mode stored on the result itself.
            const existingState = byAgentId.get(agentId);
            const agent = existingState?.agent ?? getPanelAgents().find(candidate => candidate.id === agentId) ?? null;
            if (!isPanelDisplayMode(agent, result)) {
                continue;
            }

            let state = existingState;
            if (!state) {
                state = { agentId, agent, latest: null, history: [] };
                byAgentId.set(agentId, state);
            }

            const entry = { messageIndex, result };
            if (!state.latest) {
                state.latest = entry;
            } else if (state.history.length < PANEL_HISTORY_LIMIT) {
                state.history.push(entry);
            }
        }
    }

    // Mirror the agents page: order by injection.order; orphaned results sink to the bottom.
    // Enabled companions stay visible even before their first runnable turn so users can
    // see what is on and open settings from the panel.
    const orderOf = state => (state.agent ? Number(state.agent.injection?.order ?? 0) : Number.MAX_SAFE_INTEGER);
    return [...byAgentId.values()]
        .sort((a, b) => orderOf(a) - orderOf(b));
}

export function shouldShowCompanionPanelHandle() {
    if (!areAgentsGloballyEnabled()) {
        return false;
    }

    return collectPanelAgentStates().some(state => state.latest || state.agent);
}

function getStateDisplayName(state) {
    return cleanCompanionAgentName(state.agent?.name ?? state.latest?.result?.agentName);
}

function getStateIcon(state) {
    const icon = String(state.agent?.icon ?? state.latest?.result?.icon ?? '').trim();
    return icon || 'fa-user-astronaut';
}

function buildPanelEntryBody(agentId, entry) {
    const status = String(entry.result.status ?? 'done');
    if (status === 'pending') {
        return '<div class="ica--companion-pending"><i class="fa-solid fa-spinner fa-spin"></i><span>Updating…</span></div>';
    }

    if (status === 'error') {
        return `<div class="ica--companion-error">${escapeHtml(entry.result.error || 'Companion run failed.')}</div>`;
    }

    return formatCompanionContent(agentId, entry.result, chat[entry.messageIndex]);
}

function buildChatOnlyComposer(state) {
    if (!isChatOnlyAgent(state.agent)) {
        return '';
    }

    return `
        <div class="ica--chatonly-composer ica--tpanel-chatonly-composer">
            <label>
                <span class="ica--chatonly-live ica--tpanel-chatonly-live"><i class="fa-solid fa-circle"></i><span>Private side chat</span></span>
                <input type="text" class="text_pole ica--chatonly-input ica--tpanel-chatonly-input" data-role="chat-only-input" maxlength="${CHAT_ONLY_INPUT_MAX_CHARS}" placeholder="Type an aside..." aria-label="Private side chat">
            </label>
            <button type="button" class="menu_button menu_button_icon ica--chatonly-send ica--tpanel-chatonly-send" data-action="panel-chat-only-send" title="Send this aside to Chat Only" aria-label="Send aside">
                <i class="fa-solid fa-paper-plane"></i>
            </button>
        </div>
    `;
}

function buildPlotCompassObjectiveComposer(state) {
    if (!isPlotCompassAgent(state.agent)) {
        return '';
    }

    const objective = normalizePlotCompassObjective(state.agent?.settings?.plotCompassObjective);
    return `
        <div class="ica--plot-objective-composer ica--tpanel-plot-objective">
            <label>
                <span>Plot Objective</span>
                <input type="text" class="text_pole ica--plot-objective-input" data-role="plot-compass-objective" maxlength="${PLOT_COMPASS_OBJECTIVE_MAX_CHARS}" placeholder="Where should the story go?" value="${escapeHtml(objective)}" aria-label="Plot Objective">
            </label>
            <button type="button" class="menu_button menu_button_icon ica--plot-objective-save" data-action="panel-plot-compass-save" title="Save objective and rerun Plot Compass" aria-label="Save Plot Objective">
                <i class="fa-solid fa-compass"></i>
            </button>
        </div>
    `;
}

function buildChatroomReplyComposer(state) {
    if (!isChatroomAgent(state.agent)) {
        return '';
    }

    return `
        <div class="ica--chatonly-composer ica--tpanel-chatroom-reply">
            <label>
                <span class="ica--chatonly-live ica--tpanel-chatonly-live"><i class="fa-solid fa-comment"></i><span>Respond to the chatroom</span></span>
                <input type="text" class="text_pole ica--chatonly-input ica--tpanel-chatroom-reply-input" data-role="chatroom-reply-input" maxlength="${CHATROOM_REPLY_MAX_CHARS}" placeholder="Respond to the chatroom..." aria-label="Respond to the chatroom">
            </label>
            <button type="button" class="menu_button menu_button_icon ica--chatonly-send ica--tpanel-chatroom-reply-send" data-action="panel-chatroom-reply-send" title="Send your reply to the chatroom" aria-label="Send reply">
                <i class="fa-solid fa-paper-plane"></i>
            </button>
        </div>
    `;
}

function buildPanelEntryControls(state) {
    return [
        buildPlotCompassObjectiveComposer(state),
        buildChatOnlyComposer(state),
        buildChatroomReplyComposer(state),
    ].filter(Boolean).join('');
}

function buildPanelAgentSection(state) {
    const agentId = state.agentId ?? state.agent?.id ?? '';
    const latest = state.latest;
    const name = getStateDisplayName(state);
    const icon = getStateIcon(state);

    const settingsButton = state.agent
        ? '<button type="button" class="ica--cdash-action" data-action="panel-edit" title="Open this companion\'s agent settings" aria-label="Agent settings"><i class="fa-solid fa-gear"></i></button>'
        : '';
    const runLatestButton = state.agent
        ? '<button type="button" class="ica--cdash-action" data-action="panel-run-latest" title="Run this companion on the latest assistant reply" aria-label="Run companion"><i class="fa-solid fa-play"></i></button>'
        : '';

    if (!latest) {
        return `
            <section class="ica--tpanel-agent" data-agent-id="${escapeHtml(agentId)}">
                <div class="ica--tpanel-agent-head">
                    <span class="ica--tpanel-agent-name"><i class="fa-solid ${escapeHtml(icon)}"></i><span>${escapeHtml(name)}</span></span>
                    <span class="ica--tpanel-agent-actions">${runLatestButton}${settingsButton}</span>
                </div>
                <div class="ica--cdash-empty">No state yet. It will appear after the next reply${getCompanionConfig(state.agent).trigger === 'manual' ? ' you run it on' : ''}.</div>
                ${buildPanelEntryControls(state)}
            </section>
        `;
    }

    const historyHtml = state.history.length > 0
        ? `
            <details class="ica--tpanel-history">
                <summary>Previous states (${state.history.length})</summary>
                ${state.history.map(entry => `
                    <div class="ica--tpanel-history-entry" data-message-index="${entry.messageIndex}">
                        <div class="ica--tpanel-history-head">
                            <span>Message #${entry.messageIndex}</span>
                            <button type="button" class="ica--cdash-action" data-action="panel-edit-note" title="Edit this state's text" aria-label="Edit history entry"><i class="fa-solid fa-pen-to-square"></i></button>
                        </div>
                        <div class="ica--tpanel-agent-body">${buildPanelEntryBody(agentId, entry)}</div>
                    </div>
                `).join('')}
            </details>
        `
        : '';

    return `
        <section class="ica--tpanel-agent" data-agent-id="${escapeHtml(agentId)}" data-message-index="${latest.messageIndex}">
            <div class="ica--tpanel-agent-head">
                <span class="ica--tpanel-agent-name"><i class="fa-solid ${escapeHtml(icon)}"></i><span>${escapeHtml(name)}</span></span>
                <span class="ica--tpanel-agent-when">#${latest.messageIndex}</span>
                <span class="ica--tpanel-agent-actions">
                    <button type="button" class="ica--cdash-action" data-action="panel-regenerate" title="Regenerate this state" aria-label="Regenerate state"><i class="fa-solid fa-rotate-right"></i></button>
                    <button type="button" class="ica--cdash-action" data-action="panel-fix" title="Fix: re-run with strict output enforcement (use when the model wrote roleplay instead)" aria-label="Fix state"><i class="fa-solid fa-wrench"></i></button>
                    <button type="button" class="ica--cdash-action" data-action="panel-edit-note" title="Edit this state's text by hand (e.g. type your Plot Compass objective)" aria-label="Edit state text"><i class="fa-solid fa-pen-to-square"></i></button>
                    ${settingsButton}
                    <button type="button" class="ica--cdash-action" data-action="panel-jump" title="Scroll to the source message" aria-label="Scroll to source message"><i class="fa-solid fa-comment-dots"></i></button>
                </span>
            </div>
            <div class="ica--tpanel-agent-body">${buildPanelEntryBody(agentId, latest)}</div>
            ${buildPanelEntryControls(state)}
            ${buildCompactionButton(state)}
            ${historyHtml}
        </section>
    `;
}

/** The memory shard can replace the history it summarizes: offer hiding everything above it. */
function buildCompactionButton(state) {
    const isMemoryShard = state.agent?.sourceTemplateId === MEMORY_SHARD_TEMPLATE_ID
        || /memory shard/i.test(String(state.agent?.name ?? state.latest?.result?.agentName ?? ''));
    if (!isMemoryShard || !state.latest || state.latest.messageIndex < 1 || state.latest.result?.status !== 'done') {
        return '';
    }

    return `
        <button type="button" class="menu_button menu_button_icon ica--tpanel-compact" data-action="panel-hide-before" title="Exclude every message above this shard from prompts — the shard carries the history from here on">
            <i class="fa-solid fa-broom"></i>
            <span>Hide story above this shard</span>
        </button>
    `;
}

export function buildPanelHtml() {
    const states = collectPanelAgentStates();
    const body = states.length > 0
        ? states.map(buildPanelAgentSection).join('')
        : '<div class="ica--cdash-empty">No companion agents are enabled and no tracked state is stored in this chat yet. Convert a tracker to companion execution or enable a companion to see its state here.</div>';

    return `
        <div class="ica--tpanel-header">
            <span class="ica--tpanel-title"><i class="fa-solid fa-user-astronaut"></i> Companions</span>
            <span class="ica--tpanel-agent-actions">
                <button type="button" class="ica--cdash-action${panelLocked ? ' is-active' : ''}" data-action="panel-lock" title="${panelLocked ? 'Unlock panel auto-close' : 'Keep panel open until unlocked'}" aria-label="${panelLocked ? 'Unlock panel' : 'Lock panel'}" aria-pressed="${panelLocked}"><i class="fa-solid ${panelLocked ? 'fa-lock' : 'fa-lock-open'}"></i></button>
                <button type="button" class="ica--cdash-action" data-action="panel-regenerate-all" title="Regenerate every companion on the last reply" aria-label="Regenerate all companions"><i class="fa-solid fa-rotate-right"></i></button>
                <button type="button" class="ica--cdash-action" data-action="panel-close" title="Close panel" aria-label="Close panel"><i class="fa-solid fa-xmark"></i></button>
            </span>
        </div>
        <div class="ica--tpanel-body">${body}</div>
    `;
}

function renderPanel() {
    const panelElement = $('#ica--tracker-panel');
    panelElement.html(buildPanelHtml());
}

export function updateCompanionPanelHandleVisibility() {
    const shouldShow = shouldShowCompanionPanelHandle();
    $('#ica--tracker-panel-handle').toggle(shouldShow);
    if (shouldShow) {
        // Sizes are only measurable once visible; (re)place on the next frame.
        requestHandlePlacement();
    }
}

export function openCompanionPanel() {
    panelOpen = true;
    panelOpenedAt = Date.now();
    renderPanel();
    const { edge } = getStoredHandlePosition() ?? { edge: 'right' };
    $('#ica--tracker-panel').attr('data-edge', edge).addClass('is-open').attr('aria-hidden', 'false');
}

export function closeCompanionPanel() {
    panelOpen = false;
    $('#ica--tracker-panel').removeClass('is-open').attr('aria-hidden', 'true');
}

export function isCompanionPanelLocked() {
    return panelLocked;
}

export function setCompanionPanelLocked(locked) {
    panelLocked = Boolean(locked);
    storePanelLocked(panelLocked);
    if (panelOpen) {
        renderPanel();
    }
    return panelLocked;
}

export function toggleCompanionPanel() {
    if (panelOpen) {
        closeCompanionPanel();
    } else {
        openCompanionPanel();
    }
}

async function handlePanelAction(event) {
    event.preventDefault();
    event.stopPropagation();

    const button = $(event.currentTarget);
    const action = button.attr('data-action');

    if (action === 'panel-close') {
        closeCompanionPanel();
        return;
    }

    if (action === 'panel-lock') {
        setCompanionPanelLocked(!panelLocked);
        return;
    }

    if (action === 'panel-regenerate-all') {
        const lastAssistantIndex = getLatestAssistantIndex();
        if (lastAssistantIndex < 0) {
            toastr.warning('No assistant reply yet to run companions on.');
            return;
        }
        button.prop('disabled', true);
        try {
            await runCompanionsOnMessage(lastAssistantIndex);
        } finally {
            button.prop('disabled', false);
            if (panelOpen) {
                renderPanel();
            }
        }
        return;
    }

    const section = button.closest('.ica--tpanel-agent');
    const agentId = section.attr('data-agent-id') || '';
    const messageIndex = Number(button.closest('[data-message-index]').attr('data-message-index'));

    if (action === 'panel-run-latest') {
        if (!agentId) {
            toastr.warning('No companion selected.');
            return;
        }
        const lastAssistantIndex = getLatestAssistantIndex();
        if (lastAssistantIndex < 0) {
            toastr.warning('No assistant reply yet to run this companion on.');
            return;
        }
        button.prop('disabled', true);
        try {
            await runCompanionAgentOnMessage(agentId, lastAssistantIndex);
        } finally {
            button.prop('disabled', false);
            if (panelOpen) {
                renderPanel();
            }
        }
        return;
    }

    if (action === 'panel-chat-only-send') {
        const agent = getPanelAgents().find(candidate => candidate.id === agentId);
        if (!agent || !isChatOnlyAgent(agent)) {
            toastr.warning('Chat Only is not available.');
            return;
        }

        const inputField = section.find('[data-role="chat-only-input"]');
        const userInput = normalizeChatOnlyInput(inputField.val());
        if (!userInput) {
            toastr.warning('Type an aside first.');
            return;
        }

        const lastAssistantIndex = getLatestAssistantIndex();
        if (lastAssistantIndex < 0) {
            toastr.warning('No assistant reply yet to chat beside.');
            return;
        }

        const state = collectPanelAgentStates().find(candidate => candidate.agentId === agentId || candidate.agent?.id === agentId);
        const transcript = appendChatOnlyUserMessage(state?.latest?.result?.content ?? '', userInput);
        button.prop('disabled', true);
        inputField.prop('disabled', true);
        try {
            await runCompanionAgentOnMessage(agentId, lastAssistantIndex, {
                pendingContent: transcript,
                extraContextSections: [{
                    title: 'Chat Only side chat',
                    content: transcript,
                }],
            });
        } finally {
            button.prop('disabled', false);
            inputField.prop('disabled', false).val('');
            if (panelOpen) {
                renderPanel();
            }
        }
        return;
    }

    if (action === 'panel-chatroom-reply-send') {
        const agent = getPanelAgents().find(candidate => candidate.id === agentId);
        if (!agent || !isChatroomAgent(agent)) {
            toastr.warning('Chatroom reply is not available.');
            return;
        }

        const inputField = section.find('[data-role="chatroom-reply-input"]');
        const userInput = normalizeChatroomReply(inputField.val());
        if (!userInput) {
            toastr.warning('Type a reply first.');
            return;
        }

        const lastAssistantIndex = getLatestAssistantIndex();
        if (lastAssistantIndex < 0) {
            toastr.warning('No assistant reply yet to respond to.');
            return;
        }

        button.prop('disabled', true);
        inputField.prop('disabled', true);
        try {
            await runCompanionAgentOnMessage(agentId, lastAssistantIndex, {
                extraContextSections: [{
                    title: 'Viewer reply',
                    content: userInput,
                }],
            });
        } finally {
            button.prop('disabled', false);
            inputField.prop('disabled', false).val('');
            if (panelOpen) {
                renderPanel();
            }
        }
        return;
    }

    if (action === 'panel-plot-compass-save') {
        const agent = getPanelAgents().find(candidate => candidate.id === agentId);
        if (!agent || !isPlotCompassAgent(agent)) {
            toastr.warning('Plot Compass is not available.');
            return;
        }

        const inputField = section.find('[data-role="plot-compass-objective"]');
        const objective = normalizePlotCompassObjective(inputField.val());
        const runIndex = Number.isInteger(messageIndex) ? messageIndex : getLatestAssistantIndex();
        if (runIndex < 0) {
            toastr.warning('No assistant reply yet to plan from.');
            return;
        }

        button.prop('disabled', true);
        inputField.prop('disabled', true);
        try {
            await savePlotCompassObjective(agent, objective);
            await runCompanionAgentOnMessage(agentId, runIndex);
            toastr.success(objective ? 'Plot Objective saved.' : 'Plot Objective cleared.');
        } finally {
            button.prop('disabled', false);
            inputField.prop('disabled', false);
            if (panelOpen) {
                renderPanel();
            }
        }
        return;
    }

    if (action === 'panel-hide-before' && Number.isInteger(messageIndex) && messageIndex > 0) {
        const result = await new Popup(
            `Exclude messages #0–#${messageIndex - 1} from prompts? The shard carries that history from here on; messages stay visible in the chat and can be unhidden later.`,
            POPUP_TYPE.CONFIRM,
        ).show();
        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        await hideChatMessageRange(0, messageIndex - 1, false);
        toastr.success(`Hid ${messageIndex} message(s) from prompts.`);
        if (panelOpen) {
            renderPanel();
        }
        return;
    }

    if (action === 'panel-edit-note' && agentId && Number.isInteger(messageIndex)) {
        const message = chat[messageIndex];
        const result = getCompanionResults(message)[agentId];
        if (!result) {
            toastr.warning('No stored state to edit.');
            return;
        }
        await editCompanionResult(messageIndex, agentId, message, result);
        if (panelOpen) {
            renderPanel();
        }
        return;
    }

    if (action === 'panel-edit') {
        if (!agentId || typeof panelHooks?.openEditor !== 'function') {
            toastr.warning('The agent editor is not available.');
            return;
        }
        // The editor is its own popup; close the panel so they do not overlap on sheet edges.
        closeCompanionPanel();
        panelHooks.openEditor(agentId);
        return;
    }

    if (action === 'panel-jump') {
        closeCompanionPanel();
        const messageElement = document.querySelector(`.mes[mesid="${messageIndex}"]`);
        if (messageElement) {
            messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
            toastr.info('That message is above the rendered window. Scroll up in the chat to load it.');
        }
        return;
    }

    if ((action === 'panel-regenerate' || action === 'panel-fix') && agentId && Number.isInteger(messageIndex)) {
        button.prop('disabled', true);
        try {
            await runCompanionAgentOnMessage(agentId, messageIndex, { repair: action === 'panel-fix' });
        } finally {
            button.prop('disabled', false);
            if (panelOpen) {
                renderPanel();
            }
        }
    }
}

export function initCompanionPanel() {
    if (panelInitialized) {
        return;
    }

    panelInitialized = true;
    $(document.body).append('<div id="ica--tracker-panel" class="ica--tpanel" data-edge="right" aria-hidden="true"></div>');
    $(document.body).append(`
        <button type="button" id="ica--tracker-panel-handle" class="ica--tpanel-handle" data-edge="right" title="Open the companion panel" aria-label="Open the companion panel" style="display:none">
            <i class="fa-solid fa-user-astronaut"></i>
            <span>Companion</span>
        </button>
    `);

    $('#ica--tracker-panel').on('click', '[data-action]', handlePanelAction);
    $('#ica--tracker-panel').on('click', '.ica--tpanel-agent-body .ica--choice-line', function (event) {
        event.preventDefault();
        event.stopPropagation();
        const inserted = insertChoiceIntoMessageInput(this.textContent);
        if (inserted && !panelLocked) {
            closeCompanionPanel();
        }
    });
    $('#ica--tracker-panel-handle').on('click', () => {
        if (Date.now() < suppressHandleClickUntil) {
            return;
        }
        toggleCompanionPanel();
    });
    bindHandleDrag($('#ica--tracker-panel-handle')[0]);

    if (!$('#ica_tracker_panel_wand_item').length) {
        const menuItem = $(`
            <div id="ica_tracker_panel_wand_item" class="list-group-item flex-container flexGap5 interactable" title="Open the companion panel" tabindex="0">
                <div class="fa-solid fa-user-astronaut extensionsMenuExtensionButton"></div>
                <span>Companion Panel</span>
            </div>
        `);
        menuItem.on('click', () => openCompanionPanel());
        $('#extensionsMenu').append(menuItem);
    }

    // Tapping anywhere outside the panel closes it unless the user locks it open.
    // The grace window keeps the click that opened the panel from immediately closing it.
    $(document).on('click', event => {
        if (!panelOpen || panelLocked || Date.now() - panelOpenedAt < 250) {
            return;
        }
        if (event.target?.closest?.('#ica--tracker-panel, #ica--tracker-panel-handle')) {
            return;
        }
        closeCompanionPanel();
    });

    eventSource.on(COMPANION_RESULTS_UPDATED_EVENT, () => {
        if (panelOpen) {
            renderPanel();
        }
        updateCompanionPanelHandleVisibility();
    });

    const refreshEvents = [event_types.CHAT_CHANGED, event_types.MESSAGE_DELETED, event_types.MESSAGE_SWIPED].filter(Boolean);
    for (const eventName of refreshEvents) {
        eventSource.on(eventName, () => {
            if (panelOpen) {
                renderPanel();
            }
            updateCompanionPanelHandleVisibility();
        });
    }

    updateCompanionPanelHandleVisibility();
}
