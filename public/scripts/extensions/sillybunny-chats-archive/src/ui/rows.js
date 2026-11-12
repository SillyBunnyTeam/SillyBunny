import { tr } from './dom.js';

export function allRows(state) {
    return [...state.rows, ...state.orphanRows];
}

function orphanLabel(ctx, type) {
    const labels = {
        'missing-character': 'Missing character',
        'missing-group': 'Missing group',
        'unlinked-group': 'Unlinked group',
        root: 'Root file',
    };
    return tr(ctx, labels[type] ?? 'Orphaned');
}

export function ownerLabel(ctx, row) {
    if (row.ownerName) {
        return row.ownerName;
    }
    return row.orphanType === 'unlinked-group' ? tr(ctx, 'Unlinked group') : tr(ctx, 'Unknown owner');
}

export function ownerOrReason(ctx, row) {
    return row.kind === 'orphan' ? orphanLabel(ctx, row.orphanType) : ownerLabel(ctx, row);
}

export function messageCount(ctx, count) {
    return tr(ctx, count === 1 ? '{count} message' : '{count} messages', { count });
}
