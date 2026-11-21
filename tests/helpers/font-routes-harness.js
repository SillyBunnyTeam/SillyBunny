/**
 * Runs the real upload, delete and file-serving routes on a throwaway data root, with a fake login that picks the account from
 * the `x-test-account` header. Started by `font-routes.test.js` under Node.js and under Bun, so the same code is checked on both.
 * Usage: `<runtime> font-routes-harness.js <data root>`; prints `PORT <n>` once it listens.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(process.argv[2]);
const repository = fileURLToPath(new URL('../..', import.meta.url));

fs.mkdirSync(root, { recursive: true });
fs.copyFileSync(path.join(repository, 'default/config.yaml'), path.join(root, 'config.yaml'));
const { setConfigFilePath } = await import('../../src/util.js');
setConfigFilePath(path.join(root, 'config.yaml'));

const { default: express } = await import('express');
const { router: files } = await import('../../src/endpoints/files.js');
const { router: served } = await import('../../src/users.js');

const accountOf = handle => {
    const base = path.join(root, handle);
    const directories = { root: base, files: path.join(base, 'user/files'), userImages: path.join(base, 'user/images'), backgrounds: path.join(base, 'backgrounds'), characters: path.join(base, 'characters'), avatars: path.join(base, 'User Avatars'), assets: path.join(base, 'assets'), extensions: path.join(base, 'extensions') };
    for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
    return { profile: { handle }, directories };
};

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use((request, _response, next) => {
    request.user = accountOf(String(request.get('x-test-account') || 'account-a'));
    next();
});
app.use('/api/files', files);
app.use(served);
const server = app.listen(0, '127.0.0.1', () => {
    console.log(`PORT ${server.address().port}`);
});
