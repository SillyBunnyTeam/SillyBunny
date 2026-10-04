import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import { DOCKER_ENV, getInstallType, INSTALL_TYPE, isDockerInstall } from '../src/install-type.js';

describe('install type detection', () => {
    let directory;
    const notDocker = () => false;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-install-type-'));
    });

    afterEach(() => {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    test('treats a folder without .git as unsupported', () => {
        expect(getInstallType({ directory, env: {}, detectDocker: notDocker })).toBe(INSTALL_TYPE.UNSUPPORTED);
    });

    test('treats a .git directory or worktree .git file as a Git install', () => {
        fs.mkdirSync(path.join(directory, '.git'));
        expect(getInstallType({ directory, env: {}, detectDocker: notDocker })).toBe(INSTALL_TYPE.GIT);

        fs.rmSync(path.join(directory, '.git'), { recursive: true });
        fs.writeFileSync(path.join(directory, '.git'), 'gitdir: /elsewhere\n');
        expect(getInstallType({ directory, env: {}, detectDocker: notDocker })).toBe(INSTALL_TYPE.GIT);
    });

    test('ignores a parent Git repository around a non-Git copy', () => {
        const nested = path.join(directory, 'SillyBunny');
        fs.mkdirSync(path.join(directory, '.git'));
        fs.mkdirSync(nested);
        expect(getInstallType({ directory: nested, env: {}, detectDocker: notDocker })).toBe(INSTALL_TYPE.UNSUPPORTED);
    });

    test('reports Docker from the image env marker or runtime detection, even with .git present', () => {
        fs.mkdirSync(path.join(directory, '.git'));
        expect(getInstallType({ directory, env: { [DOCKER_ENV]: '1' }, detectDocker: notDocker })).toBe(INSTALL_TYPE.DOCKER);
        expect(getInstallType({ directory, env: {}, detectDocker: () => true })).toBe(INSTALL_TYPE.DOCKER);
        expect(isDockerInstall({ env: { [DOCKER_ENV]: '0' }, detectDocker: notDocker })).toBe(false);
    });

    test('the bundled Dockerfile sets the Docker env marker', () => {
        const dockerfile = fs.readFileSync(path.resolve(process.cwd(), '..', 'Dockerfile'), 'utf8');
        expect(dockerfile).toContain(`ENV ${DOCKER_ENV}=1`);
    });
});
