import { parseJsonl, recordsToText } from '../core.js';
import { tr } from './dom.js';

export function downloadChat(ctx, row, raw, format, control) {
    if (control.getAttribute('aria-disabled') === 'true') {
        return;
    }
    const copy = control.querySelector('.sbca-button-copy');
    const original = copy.textContent;
    control.setAttribute('aria-disabled', 'true');
    copy.textContent = tr(ctx, 'Preparing...');
    try {
        const content = format === 'txt' ? recordsToText(parseJsonl(raw)) : raw;
        const mime = format === 'txt' ? 'text/plain;charset=utf-8' : 'application/x-ndjson;charset=utf-8';
        downloadBlob(content, mime, `${row.file_id}.${format}`);
        globalThis.toastr?.success(tr(ctx, 'Download started.'));
    } catch (error) {
        console.error('[Chat Archive] export failed:', error);
        globalThis.toastr?.error(tr(ctx, 'Could not prepare this download.'));
    } finally {
        control.removeAttribute('aria-disabled');
        copy.textContent = original;
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
