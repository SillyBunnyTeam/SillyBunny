import { parseJsonl, recordsToText } from '../core.js';
import { setStatus, tr } from './dom.js';

export function downloadChat(ctx, ui, row, raw, format) {
    setStatus(ui, tr(ctx, 'Preparing...'));
    try {
        const content = format === 'txt' ? recordsToText(parseJsonl(raw)) : raw;
        const mime = format === 'txt' ? 'text/plain;charset=utf-8' : 'application/x-ndjson;charset=utf-8';
        downloadBlob(content, mime, `${row.file_id}.${format}`);
        setStatus(ui, tr(ctx, 'Download started.'));
        globalThis.toastr?.success(tr(ctx, 'Download started.'));
    } catch (error) {
        console.error('[Chat Archive] export failed:', error);
        setStatus(ui, tr(ctx, 'Could not prepare this download.'));
        globalThis.toastr?.error(tr(ctx, 'Could not prepare this download.'));
    }
}

export function downloadBlob(content, type, filename) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}
