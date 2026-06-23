import { REQUEST_CANCELLATION_ABORT_REASON } from './request-cancellation.js';

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

function matchesRequestCancellationError(value) {
    if (!value) {
        return false;
    }

    if (value === REQUEST_CANCELLATION_ABORT_REASON) {
        return true;
    }

    const name = String(value?.name ?? '');
    const type = String(value?.type ?? '');
    const code = String(value?.code ?? '');
    const message = String(value?.message ?? value).toLowerCase();

    return name === 'AbortError' ||
        type === 'aborted' ||
        code === 'ABORT_ERR' ||
        message.includes('client disconnected') ||
        message.includes('operation was aborted');
}

function hasDisconnectedStreamContext({ request = null, response = null } = {}) {
    return Boolean(
        request?.aborted ||
        request?.readableAborted ||
        request?.destroyed ||
        request?.socket?.destroyed ||
        response?.destroyed ||
        response?.writableEnded,
    );
}

export function isBenignStreamAbort(value, context = {}) {
    const values = [
        value,
        value?.cause,
        value?.reason,
    ];

    return values.some(matchesRequestCancellationError) ||
        (hasDisconnectedStreamContext(context) && values.some(matchesStreamingDisconnectError));
}
