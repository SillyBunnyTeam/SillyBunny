import { afterAll, beforeEach, expect, test } from '@jest/globals';

import { OPEN_MEMBER, startAccountServer } from './util/user-account-harness.js';

const harness = await startAccountServer();

const NO_ANSWER_AFTER_MS = 2000;

beforeEach(() => harness.reset());

afterAll(() => harness.close());

function statusOrNoAnswer(request) {
    let timer;
    const noAnswer = new Promise(resolve => {
        timer = setTimeout(() => resolve('no answer'), NO_ANSWER_AFTER_MS);
    });
    return Promise.race([request.then(response => response.status), noAnswer]).finally(() => clearTimeout(timer));
}

test('a request with a session answers 500 when its user record cannot be read, and the next request answers 200', async () => {
    const client = await harness.loginAs(OPEN_MEMBER);
    harness.failStorageOnce('getItem');

    const failed = await statusOrNoAnswer(client.get('/api/users/me'));
    const next = await statusOrNoAnswer(client.get('/api/users/me'));

    expect(failed).toBe(500);
    expect(next).toBe(200);
});
