import fetch from 'node-fetch';
import urlJoin from 'url-join';
import { setAdditionalHeadersByType } from '../additional-headers.js';
import { TEXTGEN_TYPES } from '../constants.js';
import { trimV1 } from '../util.js';
import { createSingleVectorFn, extractOpenAIEmbeddings } from './common.js';

/**
 * Gets the vector for the given text from LlamaCpp
 * @param {string[]} texts - The array of texts to get the vectors for
 * @param {string} apiUrl - The API URL
 * @param {string} model - The model to use (required by a router-mode server, optional otherwise)
 * @param {import('../users.js').UserDirectoryList} directories - The directories object for the user
 * @returns {Promise<number[][]>} - The array of vectors for the texts
 */
// SillyBunny: accept optional model ID for llama.cpp router-mode embeddings (ST #6171).
export async function getLlamaCppBatchVector(texts, apiUrl, model, directories) {
    const url = new URL(urlJoin(trimV1(apiUrl), '/v1/embeddings'));

    const headers = {};
    setAdditionalHeadersByType(headers, TEXTGEN_TYPES.LLAMACPP, apiUrl, directories);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...headers,
        },
        // SillyBunny: omit model key when empty so single-model llama.cpp servers stay unchanged (ST #6171).
        body: JSON.stringify({ input: texts, model: model || undefined }),
    });

    if (!response.ok) {
        const responseText = await response.text();
        throw new Error(`LlamaCpp: Failed to get vector for text: ${response.statusText} ${responseText}`);
    }

    /** @type {any} */
    const data = await response.json();
    return extractOpenAIEmbeddings(data, 'LlamaCpp');
}

/**
 * Gets the vector for the given text from LlamaCpp
 * @param {string} text - The text to get the vector for
 * @param {string} apiUrl - The API URL
 * @param {string} model - The model to use (required by a router-mode server, optional otherwise)
 * @param {import('../users.js').UserDirectoryList} directories - The directories object for the user
 * @returns {Promise<number[]>} - The vector for the text
 */
export const getLlamaCppVector = createSingleVectorFn(getLlamaCppBatchVector);

