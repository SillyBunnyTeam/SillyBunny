import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import isDocker from 'is-docker';

import { serverDirectory } from './server-directory.js';

export const INSTALL_TYPE = Object.freeze({
    GIT: 'git',
    DOCKER: 'docker',
    UNSUPPORTED: 'unsupported',
});

// Set by the bundled Dockerfile so Podman and other runtimes without /.dockerenv are still detected.
export const DOCKER_ENV = 'SILLYBUNNY_DOCKER';

export function isDockerInstall({ env = process.env, detectDocker = isDocker } = {}) {
    return env[DOCKER_ENV] === '1' || Boolean(detectDocker());
}

/**
 * Classifies how this copy of SillyBunny was installed.
 * Docker wins over Git because the image is built without `.git`, and a bind-mounted checkout is still managed by the container.
 * @param {{ isRepo?: boolean, directory?: string, env?: NodeJS.ProcessEnv, detectDocker?: () => boolean }} [options]
 * @returns {'git' | 'docker' | 'unsupported'}
 */
export function getInstallType({ isRepo, directory = serverDirectory, env = process.env, detectDocker = isDocker } = {}) {
    if (isDockerInstall({ env, detectDocker })) {
        return INSTALL_TYPE.DOCKER;
    }

    // `.git` is a directory in a normal clone and a file in a worktree; both count.
    const hasGit = typeof isRepo === 'boolean' ? isRepo : fs.existsSync(path.join(directory, '.git'));
    return hasGit ? INSTALL_TYPE.GIT : INSTALL_TYPE.UNSUPPORTED;
}
