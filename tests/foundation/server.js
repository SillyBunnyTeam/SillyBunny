import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import YAML from 'yaml';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ui-foundation-'));
const config = YAML.parse(fs.readFileSync(path.join(root, 'default/config.yaml'), 'utf8'));
config.dataRoot = path.join(temporaryRoot, 'data');
config.listen = false;
config.browserLaunch.enabled = false;
config.extensions.autoUpdate = false;
config.extensions.models.autoDownload = false;
config.enableDownloadableTokenizers = false;
config.enableServerPlugins = false;
config.port = Number(process.env.SB_UI_TEST_PORT || 4459);
const configPath = path.join(temporaryRoot, 'config.yaml');
fs.writeFileSync(configPath, YAML.stringify(config));
const userRoot = path.join(config.dataRoot, 'default-user');
fs.mkdirSync(userRoot, { recursive: true });
const settings = JSON.parse(fs.readFileSync(path.join(root, 'default/content/settings.json'), 'utf8'));
settings.firstRun = false;
settings.extension_settings = {
    ...(settings.extension_settings || {}),
    'quick-image-gen': {
        ...(settings.extension_settings?.['quick-image-gen'] || {}),
        setupWizardSeen: true,
        starterPresetsSeeded: true,
    },
};
fs.writeFileSync(path.join(userRoot, 'settings.json'), JSON.stringify(settings));

const server = spawn(process.env.SB_UI_TEST_RUNTIME || process.execPath, ['server.js', '--configPath', configPath], {
    cwd: root,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
});
const stop = () => {
    if (server.exitCode !== null) return;
    if (process.platform === 'win32') server.kill('SIGTERM');
    else process.kill(-server.pid, 'SIGTERM');
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
server.on('error', error => {
    console.error(error);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    process.exitCode = 1;
});
server.on('exit', code => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    process.exitCode = code ?? 0;
});
