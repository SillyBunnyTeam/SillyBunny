import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

// Gemini 4 can write one reply across several requests, called hops, and each hop after the first carries a token from the one before:
// https://ai.google.dev/gemini-api/docs/generate-content/long-decode

// The longest reply Google allows (1,048,576 tokens) takes this many requests at the smallest per-request cap.
// A server that keeps issuing new tokens or a connection that keeps dropping stops here instead of billing without end.
const MAX_REQUESTS = 32;
// How many times a request goes out again when it stopped with nothing new, the same limit as MAX_STREAM_RECONNECTS_WITHOUT_PROGRESS in Google's js-genai SDK.
const MAX_RETRIES = 3;
const NON_STREAMING_OUTPUT_CAP = 32768;

// The client reads these as a cut-off reply, the same as when Google reports one.
const GENERATE_CONTENT_CUT_OFF = `data: ${JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: 'CONTINUATION' }] })}\n\n`;

const exceedsRequestCap = (model, maxOutputTokens) => /^gemini-4/.test(model) && maxOutputTokens > NON_STREAMING_OUTPUT_CAP;

// Fetch errors can quote the request URL, and AI Studio URLs hold the API key.
const describeError = error => error?.code ?? error?.name ?? 'unknown error';

// A part with only a signature shows nothing, so a resume cannot repeat it.
const showsContent = part => Boolean(part.text) || Object.keys(part).some(key => !['text', 'thought', 'thoughtSignature'].includes(key));

/**
 * Google documents a 400 for a non-streaming limit above the per-request cap when the request has no token.
 * The next request sends the full limit with the token, which is the documented way past MAX_TOKENS.
 * @param {any} body generateContent request body
 * @param {string} model Model name
 * @param {boolean} stream Whether the request streams
 * @returns {any} The body for the first request, which is the same object when no cap applies
 */
export function capFirstGenerateContentBody(body, model, stream) {
    if (stream || !exceedsRequestCap(model, body.generationConfig?.maxOutputTokens)) {
        return body;
    }
    return { ...body, generationConfig: { ...body.generationConfig, maxOutputTokens: NON_STREAMING_OUTPUT_CAP } };
}

/**
 * Requests the rest of a reply until a response has no new token. A failed request ends the loop,
 * so the hops so far stay the reply and the last one's unfinished status makes the client warn.
 * @param {any} firstHop First response
 * @param {(hop: any, requests: number) => string|undefined} getNextToken Reads the token to continue with
 * @param {(token: string) => Promise<any>} sendHop Sends the same request with a token
 * @param {AbortSignal} signal Aborts when the client cancels, and an abort rethrows
 * @returns {Promise<any[]>} Every response, in order
 */
async function collectHops(firstHop, getNextToken, sendHop, signal) {
    const hops = [firstHop];
    let sentToken;
    while (hops.length < MAX_REQUESTS) {
        const token = getNextToken(hops.at(-1), hops.length);
        if (!token || token === sentToken) {
            break;
        }
        sentToken = token;

        const requestNumber = hops.length + 1;
        console.info(`Gemini long decode: sending request ${requestNumber}`);
        try {
            const response = await sendHop(token);
            if (!response.ok) {
                console.warn(`Gemini long decode: request ${requestNumber} failed with status ${response.status}:`, await response.text());
                break;
            }
            hops.push(await response.json());
        } catch (error) {
            if (signal.aborted) {
                throw error;
            }
            console.warn(`Gemini long decode: request ${requestNumber} failed:`, describeError(error));
            break;
        }
    }
    return hops;
}

/**
 * @param {any} firstHop First generateContent response
 * @param {(token: string) => Promise<any>} sendHop Sends the same request with a token
 * @param {AbortSignal} signal Aborts when the client cancels
 * @param {boolean} firstWasCapped Whether the first request went out with a lowered limit
 * @returns {Promise<any[]>} Every response, in order
 */
export function collectGenerateContentHops(firstHop, sendHop, signal, firstWasCapped) {
    return collectHops(firstHop, (hop, requests) => {
        const candidate = hop?.candidates?.[0];
        // MAX_TOKENS is a real stop unless this code lowered the limit that caused it.
        const hitLoweredLimit = firstWasCapped && requests === 1 && candidate?.finishReason === 'MAX_TOKENS';
        return candidate?.finishReason === 'CONTINUATION' || hitLoweredLimit ? candidate.continuationToken : undefined;
    }, sendHop, signal);
}

/**
 * Joins the responses into one model turn, because the client reads thought signatures and tool calls from the parts.
 * @param {any[]} hops Every generateContent response, in order
 * @returns {any} One response with the last usable hop's finish reason
 */
export function mergeGenerateContentHops(hops) {
    const usable = hops.filter(hop => hop?.candidates?.length);
    if (usable.length < 2) {
        return usable[0] ?? hops[0];
    }

    const last = usable.at(-1);
    const candidate = last.candidates[0];
    return {
        ...last,
        candidates: [{
            ...candidate,
            content: { ...candidate.content, parts: usable.flatMap(hop => hop.candidates[0].content?.parts ?? []) },
        }],
    };
}

/**
 * Parts inside one response are separate blocks, but a request boundary can fall inside a word, so only parts get a separator.
 * @param {any[]} hops Every generateContent response, in order
 * @returns {string} The visible reply text
 */
export function getGenerateContentText(hops) {
    return hops.map((hop) => {
        const content = hop?.candidates?.[0]?.content ?? hop?.candidates?.[0]?.output;
        return typeof content === 'string' ? content : content?.parts?.filter(part => !part.thought && part.text)?.map(part => part.text)?.join('\n\n');
    }).join('');
}

/**
 * @param {AsyncIterable<any>} body Response body
 * @returns {AsyncGenerator<string>} Raw events, each with its separator
 */
async function* readRawEvents(body) {
    const decoder = new StringDecoder('utf8');
    const separator = /\r?\n\r?\n/g;
    // An inline image can span many chunks, and a regex copies a joined string each time it reads one.
    // So the event waits in pieces, and only the tail that can hold part of a separator is read again.
    let pieces = [];
    let tail = '';
    for await (const chunk of body) {
        const text = tail + decoder.write(chunk);
        let start = 0;
        separator.lastIndex = 0;
        let match;
        while ((match = separator.exec(text))) {
            const end = match.index + match[0].length;
            pieces.push(text.slice(start, end));
            yield pieces.join('');
            pieces = [];
            start = end;
        }
        const tailStart = Math.max(start, text.length - 3);
        pieces.push(text.slice(start, tailStart));
        tail = text.slice(tailStart);
    }

    const rest = pieces.join('') + tail + decoder.end();
    if (rest) {
        // The next request's first event follows this text, so it needs its own separator.
        yield `${rest}\n\n`;
    }
}

/**
 * @param {string} event Raw event
 * @returns {any} The parsed data, or null when the event has none
 */
function parseEventData(event) {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    try {
        return data ? JSON.parse(data) : null;
    } catch {
        return null;
    }
}

/**
 * Tracks one request of a stream.
 * @param {string|undefined} startToken The token this request was sent with
 * @param {number} requests How many requests the stream has sent, this one included
 * @param {number} retries How many requests in a row ended with no new token
 * @returns {any} Hop state
 */
function createHop(startToken, requests, retries) {
    const hop = {
        token: startToken,
        contentSinceToken: false,
        blocked: false,
        noRetry: false,
        finished: false,
        resume: false,
        failed: false,
        // A finish that asks for the next request needs a new token, because the same token again means no progress.
        canContinue: () => Boolean(hop.token) && !hop.blocked && hop.token !== startToken && requests < MAX_REQUESTS,
        // A stream that stopped with no finish repeats everything after its token, and the client cannot take back content it already got.
        canResume: () => Boolean(hop.token) && !hop.blocked && !hop.contentSinceToken && requests < MAX_REQUESTS && (hop.token !== startToken || (retries < MAX_RETRIES && !hop.noRetry)),
    };
    return hop;
}

/**
 * Reads the requests of one reply as a single stream.
 * @param {any} firstResponse First response
 * @param {(token: string) => Promise<any>} sendHop Sends the same request with a token
 * @param {AbortSignal} signal Aborts when the client cancels
 * @param {(event: string, hop: any) => string|null} readEvent Updates the hop and returns the text to forward
 * @param {string} cutOffEvent Tells the client the reply stopped early
 * @returns {AsyncGenerator<string>} The events to forward
 */
async function* stitchHops(firstResponse, sendHop, signal, readEvent, cutOffEvent) {
    let startToken;
    let retries = 0;
    for (let requests = 1; ; requests++) {
        const hop = createHop(startToken, requests, retries);
        try {
            let response = firstResponse;
            if (requests > 1) {
                console.info(`Gemini long decode: sending request ${requests}`);
                response = await sendHop(startToken);
            }
            if (!response.ok) {
                console.warn(`Gemini long decode: request ${requests} failed with status ${response.status}:`, await response.text());
                yield cutOffEvent;
                return;
            }
            for await (const event of readRawEvents(response.body)) {
                const forwarded = readEvent(event, hop);
                if (forwarded) {
                    yield forwarded;
                }
                if (hop.resume) {
                    break;
                }
            }
        } catch (error) {
            if (signal.aborted) {
                return;
            }
            console.warn(`Gemini long decode: request ${requests} dropped:`, describeError(error));
            hop.failed = true;
        }

        // Google closes a long stream on a timer and connections can drop, and a checkpoint token recovers both.
        hop.resume ||= !hop.finished && hop.canResume();
        if (!hop.resume) {
            // A stream that never saw a token and closes cleanly stays silent, because relays can leave out the finish reason.
            if (!hop.finished && (hop.failed || hop.token)) {
                yield cutOffEvent;
            }
            return;
        }

        retries = hop.token === startToken ? retries + 1 : 0;
        startToken = hop.token;
    }
}

/**
 * @param {string} event Raw event
 * @param {any} hop Hop state
 * @returns {string} The text to forward
 */
function readGenerateContentEvent(event, hop) {
    const data = parseEventData(event);
    const candidate = data?.candidates?.[0];
    if (!candidate) {
        // A blocked prompt is final, so another request could only bill the same block.
        hop.blocked ||= Boolean(data?.promptFeedback?.blockReason);
        // Google's SDK raises an error from a request with no new token instead of sending that token again, and each retry would also show the error again.
        hop.noRetry ||= Boolean(data?.error);
        return event;
    }

    const hasToken = Boolean(candidate.continuationToken);
    // A token this request already has marks nothing new, so the content beside it would repeat on a resume.
    if (hasToken && candidate.continuationToken !== hop.token) {
        hop.token = candidate.continuationToken;
        hop.contentSinceToken = false;
    } else if (candidate.content?.parts?.some(showsContent)) {
        hop.contentSinceToken = true;
    }

    if (candidate.finishReason === 'CONTINUATION' && hop.canContinue()) {
        hop.resume = true;
    } else if (candidate.finishReason) {
        hop.finished = true;
    }

    if (!hasToken && !hop.resume) {
        return event;
    }

    // The client reads any CONTINUATION as a cut-off reply. It never reads tokens, and a resumable generation buffers every forwarded byte.
    delete candidate.continuationToken;
    if (hop.resume) {
        delete candidate.finishReason;
    }
    return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * @param {any} firstResponse First response
 * @param {(token: string) => Promise<any>} sendHop Sends the same request with a token
 * @param {AbortSignal} signal Aborts when the client cancels
 * @param {(event: string, hop: any) => string|null} readEvent Updates the hop and returns the text to forward
 * @param {string} cutOffEvent Tells the client the reply stopped early
 * @returns {any} A response whose body holds every request's stream, or the first response when it failed
 */
function continueStream(firstResponse, sendHop, signal, readEvent, cutOffEvent) {
    if (!firstResponse.ok || !firstResponse.body) {
        return firstResponse;
    }
    return {
        ok: true,
        status: firstResponse.status,
        statusText: firstResponse.statusText,
        body: Readable.from(stitchHops(firstResponse, sendHop, signal, readEvent, cutOffEvent), { objectMode: false }),
    };
}

/**
 * @param {any} firstResponse First streamGenerateContent response
 * @param {(token: string) => Promise<any>} sendHop Sends the same request with a token
 * @param {AbortSignal} signal Aborts when the client cancels
 * @returns {any} A response for forwardFetchResponse
 */
export function continueGenerateContentStream(firstResponse, sendHop, signal) {
    return continueStream(firstResponse, sendHop, signal, readGenerateContentEvent, GENERATE_CONTENT_CUT_OFF);
}
