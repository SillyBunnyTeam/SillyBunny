import { createEditorSession } from '../../../sillybunny-editor/session.js';
import { createEditorDraftStore } from '../../../sillybunny-editor/drafts.js';
import { createAgentEditorState, serializeAgentEditorState, validateAgentEditorState } from './agent-editor-model.js';

export function agentEditorDraftKey(userHandle, entryKey) {
    return `sb-agent-editor-draft-${userHandle || 'default'}-${encodeURIComponent(entryKey)}`;
}

export function createAgentEditorController({
    agent,
    mode = 'edit',
    template = null,
    materialiseTemplateId = null,
    userHandle,
    storage,
    services,
    offerDraft = () => {},
    onStateChange = () => {},
}) {
    let original = structuredClone(agent);
    let state = createAgentEditorState(agent);
    let errors = [];
    let session;
    let controller;
    const drafts = createEditorDraftStore({
        storage,
        keyFor: key => agentEditorDraftKey(userHandle, key),
    });
    const notify = () => {
        if (session) onStateChange(controller.getState());
    };
    session = createEditorSession({
        drafts,
        offerDraft,
        onStateChange: notify,
        captureSnapshot: () => structuredClone(state),
        restoreSnapshot: snapshot => {
            state = structuredClone(snapshot);
            errors = [];
        },
        persist: async receipt => {
            errors = validateAgentEditorState(receipt.snapshot);
            if (errors.length) {
                notify();
                return;
            }
            const candidate = serializeAgentEditorState(original, receipt.snapshot, { template });
            let saved;
            try {
                saved = materialiseTemplateId
                    ? await services.materialise(materialiseTemplateId, { edits: candidate })
                    : await services.saveAgent(candidate);
            } catch (error) {
                errors = [{
                    field: 'save',
                    code: 'save-failed',
                    detail: String(error.message),
                }];
                notify();
                return;
            }
            if (!receipt.isCurrent()) return;
            const unchanged = JSON.stringify(state) === JSON.stringify(receipt.snapshot);
            const savedState = {
                fields: structuredClone(saved),
                trackerBuilder: structuredClone(receipt.snapshot.trackerBuilder),
            };
            if (unchanged) state = structuredClone(savedState);
            else state.fields.id = saved.id;
            original = structuredClone(saved);
            materialiseTemplateId = null;
            receipt.markSaved({
                entityId: `agent:${saved.id}`,
                mode: 'edit',
            }, savedState);
            // Persistence is committed: refresh failures must not trigger a second materialisation.
            try {
                if (saved.execution === 'companion') {
                    const changed = await services.syncCompanionChatHistoryConfig(saved);
                    if (changed > 0) services.saveChatDebounced({ deferBackup: false });
                }
                services.refreshRegexSnapshotsForAgent(saved.id);
                services.refreshList(saved, receipt.context.entityId);
                services.updateCompanionButtonVisibility();
            } catch (error) {
                errors = [{
                    field: 'save',
                    code: 'refresh-failed',
                    detail: String(error.message),
                }];
                notify();
            }
        },
    });
    controller = {
        getState: () => ({
            ...structuredClone(state),
            ...session.getState(),
            key: session.context?.entityId ?? null,
            errors: structuredClone(errors),
        }),
        update(path, value) {
            if (!session.isOpen()) return;
            const keys = path.split('.');
            const target = keys[0] === 'trackerBuilder' ? state : state.fields;
            const key = keys.pop();
            const parent = keys.reduce((object, part) => object[part] ??= {}, target);
            parent[key] = structuredClone(value);
            if (state.fields.category === 'companion') state.fields.execution = 'companion';
            errors = [];
            session.changed({ immediate: true });
        },
        isOpen: session.isOpen,
        isDirty: session.isDirty,
        save: session.save,
        discard() {
            errors = [];
            session.discard();
        },
        flushDraft: session.flushDraft,
        async requestLeave({
            reason,
            proceed,
        }) {
            if (!await services.confirmLeave({ session: controller }, reason)) return false;
            await proceed();
            return true;
        },
        destroy({ keepDraft = false } = {}) {
            if (keepDraft) session.flushDraft();
            else if (session.context) drafts.remove(session.context.entityId);
            session.close();
        },
    };
    session.open({
        mode: materialiseTemplateId ? 'create' : mode,
        entityId: materialiseTemplateId ? `agent-template:${materialiseTemplateId}` : mode === 'create' ? 'new-agent' : `agent:${agent.id}`,
    });
    return controller;
}
