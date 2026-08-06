import { isRequestCancellationError } from './request-cancellation.js';

const STREAMING_DISCONNECT_ERROR_CODES = new Set(['ECONNRESET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED']);
const STREAMING_DISCONNECT_ERROR_MESSAGES = [
    'broken pipe',
    'client disconnected',
    'connection reset',
    'socket hang up',
    'stream was destroyed',
    'write after end',
];

function matchesStreamingDisconnectError(value) {
    if (!value) {
        return false;
    }

    const code = String(value?.code ?? '');
    const message = String(value?.message ?? value).toLowerCase();

    return STREAMING_DISCONNECT_ERROR_CODES.has(code) ||
        STREAMING_DISCONNECT_ERROR_MESSAGES.some(pattern => message.includes(pattern));
}

export function isBenignStreamAbort(value) {
    return matchesStreamingDisconnectError(value) || isRequestCancellationError(value);
}
