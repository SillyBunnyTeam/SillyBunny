import express from 'express';
import fetch from 'node-fetch';

import { readSecret, SECRET_KEYS } from './secrets.js';
import { getGoogleApiConfig } from './google.js';
import { getGoogleImageModels, getOpenAIImageModels, getXAIImageModels } from '../../public/scripts/image-model-catalogs.js';

class ModelCatalogError extends Error {
    constructor(message, status = 502, code = 'MODEL_DISCOVERY_FAILED') {
        super(message);
        this.status = status;
        this.code = code;
    }
}

async function fetchCatalog(url, headers) {
    let result;
    try {
        result = await fetch(url, { headers, redirect: 'error' });
    } catch {
        throw new ModelCatalogError('Could not contact the model catalog.');
    }
    if (!result.ok) {
        const status = [401, 403, 429].includes(result.status) ? result.status : 502;
        throw new ModelCatalogError(`Model catalog request failed (HTTP ${result.status}).`, status);
    }
    try {
        return await result.json();
    } catch {
        throw new ModelCatalogError('The model catalog returned invalid JSON.');
    }
}

function requireKey(request, secretKey) {
    const key = readSecret(request.user.directories, secretKey);
    if (!key) throw new ModelCatalogError('API key is required for model discovery.', 400);
    return key;
}

function sendCatalog(response, models) {
    if (!models.length) {
        throw new ModelCatalogError('No compatible image or video models were returned by the provider.', 502, 'NO_COMPATIBLE_MODELS');
    }
    return response.json(models);
}

function sendError(response, error) {
    // Do not log provider responses or auth exceptions, which may contain credentials.
    return response.status(error instanceof ModelCatalogError ? error.status : 502).json({
        error: error instanceof ModelCatalogError ? error.message : 'The model catalog response is invalid.',
        code: error instanceof ModelCatalogError ? error.code : 'MODEL_DISCOVERY_FAILED',
    });
}

export const router = express.Router();

router.post('/openai/models', async (request, response) => {
    try {
        const key = requireKey(request, SECRET_KEYS.OPENAI);
        const data = await fetchCatalog('https://api.openai.com/v1/models', { Authorization: `Bearer ${key}` });
        return sendCatalog(response, getOpenAIImageModels(data));
    } catch (error) {
        return sendError(response, error);
    }
});

router.post('/xai/models', async (request, response) => {
    try {
        const key = requireKey(request, SECRET_KEYS.XAI);
        const data = await fetchCatalog('https://api.x.ai/v1/image-generation-models', { Authorization: `Bearer ${key}` });
        return sendCatalog(response, getXAIImageModels(data));
    } catch (error) {
        return sendError(response, error);
    }
});

router.post('/google/models', async (request, response) => {
    try {
        const { api = 'makersuite', vertexai_auth_mode = 'express', vertexai_region = 'us-central1', vertexai_express_project_id } = request.body ?? {};
        if (!['makersuite', 'vertexai'].includes(api)) {
            throw new ModelCatalogError('Invalid Google API selection.', 400);
        }
        const vertex = api === 'vertexai';
        if (vertex && vertexai_auth_mode === 'express') {
            throw new ModelCatalogError('Vertex AI Express does not expose a supported model catalog.', 501, 'MODEL_DISCOVERY_UNSUPPORTED');
        }
        if (vertex && (vertexai_auth_mode !== 'full' || !/^[a-z0-9-]+$/.test(vertexai_region))) {
            throw new ModelCatalogError('Invalid Vertex AI authentication mode or region.', 400);
        }
        requireKey(request, vertex ? SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT : SECRET_KEYS.MAKERSUITE);
        let config;
        try {
            // Discovery uses the same server credentials as generation, never Conversations proxy settings.
            config = await getGoogleApiConfig({
                user: request.user,
                body: { api, vertexai_auth_mode, vertexai_region, vertexai_express_project_id },
            }, '', 'predict');
        } catch {
            throw new ModelCatalogError('Google model catalog authentication failed.', 401);
        }
        const url = new URL(vertex
            ? `${config.baseUrl.replace(/\/v1$/, '/v1beta1')}/publishers/google/models`
            : `${config.baseUrl}/models`);
        url.searchParams.set('pageSize', vertex ? '100' : '1000');
        if (vertex) url.searchParams.set('listAllVersions', 'true');

        const models = new Map();
        const pageTokens = new Set();
        while (true) {
            const data = await fetchCatalog(url, config.headers);
            for (const model of getGoogleImageModels(data, { vertex })) models.set(model.value, model);
            const nextPageToken = data.nextPageToken;
            if (nextPageToken === undefined || nextPageToken === '') break;
            if (typeof nextPageToken !== 'string' || pageTokens.has(nextPageToken)) {
                throw new ModelCatalogError('The model catalog returned invalid pagination.');
            }
            pageTokens.add(nextPageToken);
            url.searchParams.set('pageToken', nextPageToken);
        }
        return sendCatalog(response, [...models.values()]);
    } catch (error) {
        return sendError(response, error);
    }
});
