import { afterAll, beforeEach, describe, expect, test } from '@jest/globals';

import { DEFAULT_USER } from '../src/constants.js';
import { MEMBER, readReply, startAccountServer } from './util/user-account-harness.js';

const harness = await startAccountServer({ config: { enableDiscreetLogin: true } });

beforeEach(() => harness.reset());

afterAll(() => harness.close());

describe('with enableDiscreetLogin on', () => {
    test('POST /api/users/list answers 204 with an empty body', async () => {
        const reply = await readReply(await harness.client().post('/api/users/list'));

        expect(reply).toEqual({ status: 204, body: '' });
    });

    test('an account can still log in by handle', async () => {
        const client = harness.client();

        const login = await readReply(await client.login(MEMBER.handle, MEMBER.password));

        expect(login).toEqual({ status: 200, body: { handle: MEMBER.handle } });
    });

    test('an admin can still list the accounts', async () => {
        const admin = await harness.loginAs(DEFAULT_USER);

        const { status, body } = await readReply(await admin.post('/api/users/get'));

        expect(status).toBe(200);
        expect(body.map(user => user.handle)).toContain(MEMBER.handle);
    });
});
