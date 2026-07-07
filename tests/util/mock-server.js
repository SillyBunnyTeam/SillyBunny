import http from 'node:http';
import { readAllChunks, tryParse } from '../../src/util.js';

export class MockServer {
    /** @type {string} */
    host;
    /** @type {number} */
    port;
    /** @type {import('http').Server} */
    server;

    /**
     * Creates an instance of MockServer.
     * @param {object} [param] Options object.
     * @param {string} [param.host] The hostname or IP address to bind the server to.
     * @param {number} [param.port] The port number to listen on.
     */
    constructor({ host, port } = {}) {
        this.host = host ?? '127.0.0.1';
        this.port = port ?? 3000;
    }

    /**
     * Handles models endpoint requests.
     * @returns {{data: {id: string}[]}} Mock response object.
     */
    handleModels() {
        return {
            data: [
                { id: 'gpt-4o-mini' },
                { id: 'gpt-5.4' },
            ],
        };
    }

    /**
     * Handles Responses API requests.
     * @param {object} jsonBody The parsed JSON body from the request.
     * @returns {object} Mock response object.
     */
    handleResponses(jsonBody) {
        const input = Array.isArray(jsonBody?.input) ? jsonBody.input : [];
        const lastItem = input[input.length - 1];
        const userText = typeof lastItem?.content === 'string'
            ? lastItem.content
            : lastItem?.content?.find?.(part => part?.type === 'input_text')?.text;

        return {
            id: 'resp-test-1',
            model: jsonBody?.model,
            status: 'completed',
            output: [
                {
                    type: 'reasoning',
                    content: [
                        {
                            type: 'reasoning_text',
                            text: `${jsonBody?.model}\n${input.length}\n${jsonBody?.max_output_tokens}`,
                        },
                    ],
                },
                {
                    type: 'message',
                    content: [
                        {
                            type: 'output_text',
                            text: String(userText ?? 'No prompt messages.'),
                        },
                    ],
                },
            ],
            usage: {
                input_tokens: 12,
                output_tokens: 5,
            },
        };
    }

    /**
     * Writes a Responses API SSE stream.
     * @param {object} jsonBody The parsed JSON body from the request.
     * @param {import('node:http').ServerResponse} res The HTTP response.
     */
    handleResponsesStream(jsonBody, res) {
        const responseId = 'resp-stream-1';
        const writeEvent = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
        const writeDone = () => {
            res.write('data: [DONE]\n\n');
            res.end();
        };

        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        writeEvent({
            type: 'response.reasoning_summary_text.delta',
            response_id: responseId,
            delta: `${jsonBody?.model} stream`,
        });

        if (jsonBody?.model === 'gpt-5.4-slow') {
            const timeout = setTimeout(() => {
                if (res.destroyed) {
                    return;
                }

                writeEvent({ type: 'response.output_text.delta', response_id: responseId, delta: 'Slow stream.' });
                writeDone();
            }, 250);

            res.on('close', () => clearTimeout(timeout));
            return;
        }

        writeEvent({ type: 'response.output_text.delta', response_id: responseId, delta: 'Hello from Responses.' });
        writeDone();
    }

    /**
     * Handles Chat Completions requests.
     * @param {object} jsonBody The parsed JSON body from the request.
     * @returns {object} Mock response object.
     */
    handleChatCompletions(jsonBody) {
        const messages = jsonBody?.messages;
        const lastMessage = messages?.[messages.length - 1];
        const mockResponse = {
            choices: [
                {
                    finish_reason: 'stop',
                    index: 0,
                    message: {
                        role: 'assistant',
                        reasoning_content: `${jsonBody?.model}\n${messages?.length}\n${jsonBody?.max_tokens}`,
                        content: String(lastMessage?.content ?? 'No prompt messages.'),
                    },
                },
            ],
            created: 0,
            model: jsonBody?.model,
        };
        return mockResponse;
    }

    /**
     * Starts the mock server.
     * @returns {Promise<void>}
     */
    async start() {
        return new Promise((resolve, reject) => {
            this.server = http.createServer(async (req, res) => {
                try {
                    const body = await readAllChunks(req);
                    const jsonBody = tryParse(body.toString());
                    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
                        const mockResponse = this.handleChatCompletions(jsonBody);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(mockResponse));
                    } else if (req.method === 'GET' && req.url === '/v1/models') {
                        const mockResponse = this.handleModels();
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(mockResponse));
                    } else if (req.method === 'POST' && req.url === '/v1/responses') {
                        if (jsonBody?.stream) {
                            this.handleResponsesStream(jsonBody, res);
                            return;
                        }

                        const mockResponse = this.handleResponses(jsonBody);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(mockResponse));
                    } else {
                        res.writeHead(404);
                        res.end();
                    }
                } catch (error) {
                    res.writeHead(500);
                    res.end();
                }
            });

            this.server.on('error', (err) => {
                reject(err);
            });

            this.server.listen(this.port, this.host, () => {
                const address = this.server.address();
                if (address && typeof address === 'object') {
                    this.port = address.port;
                }
                resolve();
            });
        });
    }

    /**
     * Stops the mock server.
     * @returns {Promise<void>}
     */
    async stop() {
        return new Promise((resolve, reject) => {
            if (!this.server) {
                return reject(new Error('Server is not running.'));
            }
            this.server.closeAllConnections();
            this.server.close(( /** @type {NodeJS.ErrnoException|undefined} */ err) => {
                if (err && (err?.code !== 'ERR_SERVER_NOT_RUNNING')) {
                    return reject(err);
                }
                resolve();
            });
        });
    }
}
