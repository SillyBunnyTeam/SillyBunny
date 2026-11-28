import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from '@jest/globals';
import { parse as parseYaml } from 'yaml';

import {
    buildCommandCheckScript,
    checkRequiredCommands,
    DEFAULT_CONTAINER_PORT,
    EXIT,
    findFatalLogLines,
    findFreePort,
    findMissingDockerfilePackages,
    parseCliArgs,
    parseDockerfileApkPackages,
    REQUIRED_IMAGE_COMMANDS,
    runDockerSmoke,
} from '../scripts/docker-smoke.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dockerfilePath = path.join(repoRoot, 'Dockerfile');
const dockerPublishWorkflowPath = path.join(repoRoot, '.github', 'workflows', 'docker-publish.yml');
const dockerSmokeWorkflowPath = path.join(repoRoot, '.github', 'workflows', 'docker-smoke.yml');
const prChecksWorkflowPath = path.join(repoRoot, '.github', 'workflows', 'pr-checks.yml');

const HEALTHY_STARTUP_LOGS = [
    'Mode: Default (Root)',
    'Resource not found, copying from defaults: config.yaml',
    '\u001b[32mSynchronized missing files: /home/bun/app/public/\u001b[39m',
    'SillyBunny startup on Bun 1.4.4. Environment: production. Server directory: /home/bun/app',
    'Failed to resolve whitelist hostname \u001b[31mhost.docker.internal\u001b[39m: getaddrinfo ENOTFOUND host.docker.internal',
    'Failed to resolve whitelist hostname \u001b[31mgateway.docker.internal\u001b[39m: getaddrinfo ENOTFOUND gateway.docker.internal',
    'Preferring IPv4 for DNS resolution',
    '',
    'SillyBunny v2.0.0-dev',
    'SillyBunny is listening on \u001b[32m IPv4: 0.0.0.0:4444\u001b[39m',
    'To limit connections to internal localhost only ([::1] or 127.0.0.1), change the setting in config.yaml to "listen: false".',
    'Go to: \u001b[34mhttp://127.0.0.1:4444\u001b[39m to open SillyBunny',
].join('\n');

function extractActionRefs(workflowSource) {
    return [...workflowSource.matchAll(/^\s*(?:- )?uses:\s*([^\s#]+)/gm)].map(match => match[1]);
}

function makeResponse(status, body = '') {
    return {
        status,
        text: async () => body,
    };
}

describe('docker smoke CLI argument parsing', () => {
    test('parses image and numeric overrides', () => {
        expect(parseCliArgs([
            'sillybunny:smoke',
            '--timeout-ms', '45000',
            '--stabilize-ms', '0',
            '--poll-interval-ms', '250',
            '--container-port', '8080',
        ])).toEqual({
            help: false,
            image: 'sillybunny:smoke',
            startupTimeoutMs: 45000,
            stabilizeMs: 0,
            pollIntervalMs: 250,
            containerPort: 8080,
        });
    });

    test('recognizes help flags without requiring an image', () => {
        expect(parseCliArgs(['--help']).help).toBe(true);
        expect(parseCliArgs(['-h']).help).toBe(true);
    });

    test('rejects missing image, unknown options, and invalid numeric flags', () => {
        expect(() => parseCliArgs([])).toThrow('Missing required <image> argument.');
        expect(() => parseCliArgs(['img:1', 'extra'])).toThrow('Unexpected extra positional argument: extra');
        expect(() => parseCliArgs(['img:1', '--bogus'])).toThrow('Unknown option: --bogus');
        expect(() => parseCliArgs(['img:1', '--timeout-ms', '0'])).toThrow('--timeout-ms must be at least 1');
        expect(() => parseCliArgs(['img:1', '--poll-interval-ms', 'abc'])).toThrow('--poll-interval-ms requires an integer');
        expect(() => parseCliArgs(['img:1', '--container-port', '70000'])).toThrow('--container-port must be between 1 and 65535');
    });

    test('CLI exits 0 on --help and 2 on invalid usage', () => {
        const scriptPath = path.join(repoRoot, 'scripts', 'docker-smoke.js');
        const helpOutput = execFileSync(process.execPath, [scriptPath, '--help'], { encoding: 'utf8' });
        expect(helpOutput).toContain('Usage: node scripts/docker-smoke.js <image>');

        let failure = null;
        try {
            execFileSync(process.execPath, [scriptPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
            failure = error;
        }
        expect(failure).not.toBeNull();
        expect(failure.status).toBe(EXIT.usage);
        expect(failure.stderr).toContain('Missing required <image> argument.');
    });
});

describe('findFatalLogLines', () => {
    test('allows normal fresh Docker startup logs', () => {
        expect(findFatalLogLines(HEALTHY_STARTUP_LOGS)).toEqual([]);
    });

    test('flags uncaught exceptions, unhandled rejections, and runtime errors', () => {
        const logs = [
            'SillyBunny startup on Bun 1.4.4.',
            '\u001b[31mUncaught exception: Error: boom\u001b[39m',
            'Unhandled rejection: Error: failed',
            'UnhandledPromiseRejection: rejected',
            'TypeError: mime.lookup is not a function',
            'ERR_MODULE_NOT_FOUND: Cannot find package "express"',
            'A critical error has occurred while starting the server: Error: bad config',
            'FATAL: Could not write default file: /home/bun/app/config.yaml',
            '[SillyBunny] Server crashed (exit code 1). Restarting in 1 s...',
            'Deferred startup maintenance failed.',
            'Bun has crashed. This indicates a bug in Bun, not your code.',
        ].join('\n');

        const matches = findFatalLogLines(logs);
        expect(matches.map(entry => entry.lineNumber)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    });

    test('flags missing binaries, ENOENT, permission errors, and bind conflicts', () => {
        const logs = [
            '/bin/sh: 1: git: not found',
            'bash: git-lfs: command not found',
            'Error: spawn git ENOENT',
            'EACCES: permission denied, mkdir \'/home/bun/app/data\'',
            'cp: can\'t create \'config/config.yaml\': Read-only file system',
            'Warning: Could not create data',
            'listen EADDRINUSE: address already in use 0.0.0.0:4444',
        ].join('\n');

        const matches = findFatalLogLines(logs);
        expect(matches.map(entry => entry.lineNumber)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });
});

describe('required command inventory checks', () => {
    test('builds a POSIX command-v check script and rejects unsafe names', () => {
        const script = buildCommandCheckScript();
        for (const entry of REQUIRED_IMAGE_COMMANDS) {
            expect(script).toContain(entry.command);
        }
        expect(script).toContain('command -v "$cmd"');
        expect(() => buildCommandCheckScript([{ command: 'git; rm -rf /' }])).toThrow('Invalid command name');
    });

    test('checkRequiredCommands passes when docker exits 0 with no missing commands', async () => {
        const calls = [];
        const runDocker = async (args) => {
            calls.push(args);
            return { status: 0, stdout: '', stderr: '', error: null };
        };

        const result = await checkRequiredCommands('sillybunny:smoke', { runDocker });
        expect(result.ok).toBe(true);
        expect(result.checked).toEqual(REQUIRED_IMAGE_COMMANDS.map(entry => entry.command));
        expect(calls).toHaveLength(1);
        expect(calls[0].slice(0, 6)).toEqual(['run', '--rm', '--entrypoint', 'sh', 'sillybunny:smoke', '-c']);
    });

    test('checkRequiredCommands reports every missing command from stdout', async () => {
        const runDocker = async () => ({
            status: 1,
            stdout: 'MISSING:git\nMISSING:git-lfs\n',
            stderr: '',
            error: new Error('exit 1'),
        });

        await expect(checkRequiredCommands('sillybunny:smoke', { runDocker }))
            .rejects
            .toThrow('Required commands missing from image "sillybunny:smoke": git, git-lfs.');
    });

    test('checkRequiredCommands reports docker failure when no MISSING lines are emitted', async () => {
        const runDocker = async () => ({
            status: 125,
            stdout: '',
            stderr: 'Unable to find image \'missing:tag\' locally',
            error: new Error('exit 125'),
        });

        await expect(checkRequiredCommands('missing:tag', { runDocker }))
            .rejects
            .toThrow('Command inventory check failed for image "missing:tag" (exit 125): Unable to find image');
    });
});

describe('runDockerSmoke orchestration', () => {
    test('runs commands, starts container, polls readiness, verifies logs, and cleans up', async () => {
        const dockerCalls = [];
        const fetchedUrls = [];
        const sleeps = [];
        let clock = 1000;
        let indexProbeCount = 0;

        const runDocker = async (args) => {
            dockerCalls.push(args);
            if (args[0] === 'run' && args.includes('--entrypoint')) {
                return { status: 0, stdout: '', stderr: '', error: null };
            }
            if (args[0] === 'run' && args[1] === '-d') {
                return { status: 0, stdout: 'container-id-123\n', stderr: '', error: null };
            }
            if (args[0] === 'inspect') {
                return { status: 0, stdout: 'true|running|0|false|0\n', stderr: '', error: null };
            }
            if (args[0] === 'logs') {
                return { status: 0, stdout: HEALTHY_STARTUP_LOGS, stderr: '', error: null };
            }
            if (args[0] === 'rm') {
                return { status: 0, stdout: 'sb-test\n', stderr: '', error: null };
            }
            throw new Error(`Unexpected docker args: ${args.join(' ')}`);
        };

        const fetchFn = async (url) => {
            fetchedUrls.push(url);
            if (url.endsWith('/')) {
                indexProbeCount++;
                if (indexProbeCount === 1) {
                    throw new Error('connect ECONNREFUSED 127.0.0.1:45123');
                }
                return makeResponse(200, '<!doctype html><title>SillyBunny</title>');
            }
            if (url.endsWith('/csrf-token')) {
                return makeResponse(200, JSON.stringify({ token: 'abc123' }));
            }
            return makeResponse(404, 'Not Found');
        };

        const result = await runDockerSmoke('sillybunny:smoke', {
            containerName: 'sb-test',
            startupTimeoutMs: 10_000,
            stabilizeMs: 250,
            pollIntervalMs: 100,
            allocatePort: async () => 45123,
            runDocker,
            fetchFn,
            sleep: async (ms) => {
                sleeps.push(ms);
                clock += ms;
            },
            now: () => clock,
            log: () => {},
        });

        expect(result.hostPort).toBe(45123);
        expect(result.containerName).toBe('sb-test');
        expect(dockerCalls[1]).toEqual([
            'run', '-d', '--name', 'sb-test', '-p', `127.0.0.1:45123:${DEFAULT_CONTAINER_PORT}`, 'sillybunny:smoke',
        ]);
        expect(fetchedUrls).toEqual([
            'http://127.0.0.1:45123/',
            'http://127.0.0.1:45123/',
            'http://127.0.0.1:45123/csrf-token',
            'http://127.0.0.1:45123/csrf-token',
        ]);
        expect(sleeps).toEqual([100, 250]);
        expect(dockerCalls.at(-1)).toEqual(['rm', '-f', 'sb-test']);
    });

    test('fails fast when the container exits before becoming ready and still removes it', async () => {
        const dockerCalls = [];
        let sleepCalls = 0;

        const runDocker = async (args) => {
            dockerCalls.push(args);
            if (args[0] === 'run') {
                return { status: 0, stdout: 'cid\n', stderr: '', error: null };
            }
            if (args[0] === 'inspect') {
                return { status: 0, stdout: 'false|exited|1|false|0\n', stderr: '', error: null };
            }
            if (args[0] === 'logs') {
                return { status: 0, stdout: '', stderr: 'A critical error has occurred while starting the server', error: null };
            }
            if (args[0] === 'rm') {
                return { status: 0, stdout: '', stderr: '', error: null };
            }
            throw new Error(`Unexpected docker args: ${args.join(' ')}`);
        };

        await expect(runDockerSmoke('sillybunny:broken', {
            containerName: 'sb-exit',
            startupTimeoutMs: 60_000,
            allocatePort: async () => 45124,
            runDocker,
            fetchFn: async () => {
                throw new Error('should not be called');
            },
            sleep: async () => {
                sleepCalls++;
            },
            log: () => {},
        })).rejects.toThrow('Container "sb-exit" exited before becoming ready (status: exited, exitCode: 1, oomKilled: false)');

        expect(sleepCalls).toBe(0);
        expect(dockerCalls.at(-1)).toEqual(['rm', '-f', 'sb-exit']);
    });

    test('fails on readiness timeout when HTTP never returns 200 and cleans up', async () => {
        const dockerCalls = [];
        let clock = 0;

        const runDocker = async (args) => {
            dockerCalls.push(args);
            if (args[0] === 'run') {
                return { status: 0, stdout: 'cid\n', stderr: '', error: null };
            }
            if (args[0] === 'inspect') {
                return { status: 0, stdout: 'true|running|0|false|0\n', stderr: '', error: null };
            }
            if (args[0] === 'logs') {
                return { status: 0, stdout: 'Still starting...', stderr: '', error: null };
            }
            if (args[0] === 'rm') {
                return { status: 0, stdout: '', stderr: '', error: null };
            }
            throw new Error(`Unexpected docker args: ${args.join(' ')}`);
        };

        await expect(runDockerSmoke('sillybunny:slow', {
            containerName: 'sb-timeout',
            startupTimeoutMs: 300,
            pollIntervalMs: 150,
            allocatePort: async () => 45125,
            runDocker,
            fetchFn: async () => makeResponse(503, 'Starting'),
            sleep: async (ms) => {
                clock += ms;
            },
            now: () => clock,
            log: () => {},
        })).rejects.toThrow('did not become ready at http://127.0.0.1:45125 within 300 ms (last probe: GET / returned HTTP 503)');

        expect(dockerCalls.at(-1)).toEqual(['rm', '-f', 'sb-timeout']);
    });

    test('fails when container crashes during stabilization and cleans up', async () => {
        const dockerCalls = [];
        let inspectCount = 0;

        const runDocker = async (args) => {
            dockerCalls.push(args);
            if (args[0] === 'run') {
                return { status: 0, stdout: 'cid\n', stderr: '', error: null };
            }
            if (args[0] === 'inspect') {
                inspectCount++;
                const state = inspectCount === 1
                    ? 'true|running|0|false|0\n'
                    : 'false|exited|137|true|0\n';
                return { status: 0, stdout: state, stderr: '', error: null };
            }
            if (args[0] === 'logs') {
                return { status: 0, stdout: 'Killed', stderr: '', error: null };
            }
            if (args[0] === 'rm') {
                return { status: 0, stdout: '', stderr: '', error: null };
            }
            throw new Error(`Unexpected docker args: ${args.join(' ')}`);
        };

        const fetchFn = async (url) => (
            url.endsWith('/csrf-token')
                ? makeResponse(200, JSON.stringify({ token: 'tok' }))
                : makeResponse(200, '<html></html>')
        );

        await expect(runDockerSmoke('sillybunny:crash', {
            containerName: 'sb-crash',
            stabilizeMs: 100,
            allocatePort: async () => 45126,
            runDocker,
            fetchFn,
            sleep: async () => {},
            log: () => {},
        })).rejects.toThrow('Container "sb-crash" was not stable after startup (running: false, status: exited, exitCode: 137, restartCount: 0)');

        expect(dockerCalls.at(-1)).toEqual(['rm', '-f', 'sb-crash']);
    });

    test('fails when fatal errors appear in container logs and still removes container even if cleanup fails', async () => {
        const dockerCalls = [];

        const runDocker = async (args) => {
            dockerCalls.push(args);
            if (args[0] === 'run') {
                return { status: 0, stdout: 'cid\n', stderr: '', error: null };
            }
            if (args[0] === 'inspect') {
                return { status: 0, stdout: 'true|running|0|false|0\n', stderr: '', error: null };
            }
            if (args[0] === 'logs') {
                return {
                    status: 0,
                    stdout: `${HEALTHY_STARTUP_LOGS}\nDeferred startup maintenance failed.`,
                    stderr: '',
                    error: null,
                };
            }
            if (args[0] === 'rm') {
                throw new Error('daemon busy');
            }
            throw new Error(`Unexpected docker args: ${args.join(' ')}`);
        };

        const fetchFn = async (url) => (
            url.endsWith('/csrf-token')
                ? makeResponse(200, JSON.stringify({ token: 'tok' }))
                : makeResponse(200, '<html></html>')
        );

        await expect(runDockerSmoke('sillybunny:logerr', {
            containerName: 'sb-logerr',
            stabilizeMs: 0,
            allocatePort: async () => 45127,
            runDocker,
            fetchFn,
            sleep: async () => {},
            log: () => {},
        })).rejects.toThrow('Found 1 fatal error line(s) in container logs');

        expect(dockerCalls.at(-1)).toEqual(['rm', '-f', 'sb-logerr']);
    });

    test('allocates an ephemeral loopback port cleanly', async () => {
        const port = await findFreePort('127.0.0.1');
        expect(Number.isInteger(port)).toBe(true);
        expect(port).toBeGreaterThan(0);
        expect(port).toBeLessThanOrEqual(65535);
    });

    test('default sleep keeps top-level await alive across readiness retries and stabilization', async () => {
        let indexCalls = 0;
        const runDocker = async (args) => {
            if (args[0] === 'inspect') {
                return { status: 0, stdout: 'true|running|0|false|0\n', stderr: '', error: null };
            }
            if (args[0] === 'logs') {
                return { status: 0, stdout: HEALTHY_STARTUP_LOGS, stderr: '', error: null };
            }
            return { status: 0, stdout: 'ok\n', stderr: '', error: null };
        };
        const fetchFn = async (url) => {
            if (url.endsWith('/')) {
                indexCalls++;
                if (indexCalls === 1) {
                    throw new Error('connect ECONNREFUSED');
                }
                return makeResponse(200, '<html></html>');
            }
            return makeResponse(200, JSON.stringify({ token: 'tok' }));
        };

        const inProcess = await runDockerSmoke('sillybunny:smoke', {
            containerName: 'sb-default-sleep',
            startupTimeoutMs: 5_000,
            pollIntervalMs: 10,
            stabilizeMs: 10,
            runDocker,
            fetchFn,
            log: () => {},
        });
        expect(inProcess.containerName).toBe('sb-default-sleep');
        expect(indexCalls).toBe(2);

        // Run through a fresh ESM process with top-level await; unref'd sleep/port handles would exit 13.
        const moduleUrl = new URL('../scripts/docker-smoke.js', import.meta.url).href;
        const childScript = `
            import { runDockerSmoke } from ${JSON.stringify(moduleUrl)};
            let tries = 0;
            const runDocker = async (args) => {
                if (args[0] === 'inspect') return { status: 0, stdout: 'true|running|0|false|0\\n', stderr: '', error: null };
                if (args[0] === 'logs') return { status: 0, stdout: 'SillyBunny is listening', stderr: '', error: null };
                return { status: 0, stdout: 'ok\\n', stderr: '', error: null };
            };
            const fetchFn = async (url) => {
                if (url.endsWith('/')) {
                    tries++;
                    if (tries === 1) throw new Error('ECONNREFUSED');
                    return { status: 200, text: async () => '<html></html>' };
                }
                return { status: 200, text: async () => JSON.stringify({ token: 'ok' }) };
            };
            const res = await runDockerSmoke('sillybunny:smoke', {
                containerName: 'sb-tla-check',
                startupTimeoutMs: 5000,
                pollIntervalMs: 20,
                stabilizeMs: 20,
                runDocker,
                fetchFn,
                log: () => {},
            });
            console.log(JSON.stringify({ containerName: res.containerName, tries }));
        `;
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', childScript], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        expect(JSON.parse(output.trim())).toEqual({ containerName: 'sb-tla-check', tries: 2 });
    });
});

describe('Dockerfile command inventory alignment', () => {
    test('parseDockerfileApkPackages handles flags, line continuations, and virtual groups', () => {
        const sample = [
            'FROM oven/bun:1.4.4-alpine',
            'RUN apk add --no-cache \\',
            '    -t .build-deps \\',
            '    git=2.45.0 \\',
            '    nodejs npm && echo ok',
        ].join('\n');

        const packages = parseDockerfileApkPackages(sample);
        expect(packages.has('git')).toBe(true);
        expect(packages.has('nodejs')).toBe(true);
        expect(packages.has('npm')).toBe(true);
        expect(packages.has('.build-deps')).toBe(false);
        expect(packages.has('echo')).toBe(false);
    });

    test('findMissingDockerfilePackages flags removed packages', () => {
        const stripped = 'FROM oven/bun:1.4.4-alpine\nRUN apk add --no-cache tini git\n';
        const missing = findMissingDockerfilePackages(stripped);
        expect(missing.map(item => item.command)).toEqual(
            expect.arrayContaining(['node', 'npm', 'git-lfs', 'su-exec', 'usermod', 'groupmod']),
        );
        expect(missing.map(item => item.command)).not.toContain('git');
        expect(missing.map(item => item.command)).not.toContain('tini');
    });

    test('Dockerfile installs every command listed in REQUIRED_IMAGE_COMMANDS', () => {
        const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
        expect(dockerfile).toMatch(/^FROM oven\/bun:[^\s]+-alpine$/m);
        expect(findMissingDockerfilePackages(dockerfile)).toEqual([]);
        expect(dockerfile).toContain(`EXPOSE ${DEFAULT_CONTAINER_PORT}`);
        expect(dockerfile).toContain('ENTRYPOINT ["tini", "--", "./docker-entrypoint.sh"]');
    });
});

describe('Docker smoke CI workflow contracts', () => {
    test('docker-publish.yml gates both publish-release and publish-staging behind smoke', () => {
        const source = fs.readFileSync(dockerPublishWorkflowPath, 'utf8');
        const workflow = parseYaml(source);

        expect(workflow.jobs.smoke).toBeDefined();
        expect(workflow.jobs.smoke.environment).toBeUndefined();
        expect(workflow.jobs.smoke.permissions).toEqual({ contents: 'read' });

        const checkoutStep = workflow.jobs.smoke.steps.find(step => step.uses?.startsWith('actions/checkout@'));
        expect(checkoutStep.with.ref).toContain('github.event.release.tag_name');
        expect(checkoutStep.with.ref).toContain('github.sha');

        const buildStep = workflow.jobs.smoke.steps.find(step => step.uses?.startsWith('docker/build-push-action@'));
        expect(buildStep.with.platforms).toBe('linux/amd64');
        expect(buildStep.with.load).toBe(true);
        expect(buildStep.with.push).toBe(false);
        expect(buildStep.with.tags).toBe('sillybunny:smoke');

        const smokeStep = workflow.jobs.smoke.steps.find(step => step.run?.includes('scripts/docker-smoke.js'));
        expect(smokeStep.run).toBe('node scripts/docker-smoke.js sillybunny:smoke');

        expect(workflow.jobs['publish-release'].needs).toEqual(['smoke']);
        expect(workflow.jobs['publish-staging'].needs).toEqual(['smoke']);

        const uses = extractActionRefs(source);
        expect(uses.length).toBeGreaterThan(0);
        for (const reference of uses) {
            expect(reference).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
        }
    });

    test('docker-smoke.yml triggers on pull requests touching Docker files and pins every action SHA', () => {
        const smokeSource = fs.readFileSync(dockerSmokeWorkflowPath, 'utf8');
        const publishSource = fs.readFileSync(dockerPublishWorkflowPath, 'utf8');
        const prChecksSource = fs.readFileSync(prChecksWorkflowPath, 'utf8');
        const workflow = parseYaml(smokeSource);

        expect(workflow.permissions).toEqual({ contents: 'read' });
        expect(workflow.on.pull_request.paths).toEqual(expect.arrayContaining([
            'Dockerfile',
            '.dockerignore',
            'docker/**',
            'package.json',
            'bun.lock',
            'server.js',
            'src/server-*.js',
            'scripts/docker-smoke*',
            '.github/workflows/docker-smoke.yml',
            '.github/workflows/docker-publish.yml',
        ]));

        const job = workflow.jobs['docker-smoke'];
        expect(job).toBeDefined();

        const buildStep = job.steps.find(step => step.uses?.startsWith('docker/build-push-action@'));
        expect(buildStep.with.platforms).toBe('linux/amd64');
        expect(buildStep.with.load).toBe(true);
        expect(buildStep.with.push).toBe(false);
        expect(buildStep.with.tags).toBe('sillybunny:smoke');

        const smokeStep = job.steps.find(step => step.run?.includes('scripts/docker-smoke.js'));
        expect(smokeStep.run).toBe('node scripts/docker-smoke.js sillybunny:smoke');

        const knownRefs = new Set([
            ...extractActionRefs(publishSource),
            ...extractActionRefs(prChecksSource),
        ]);
        const smokeRefs = extractActionRefs(smokeSource);
        expect(smokeRefs.length).toBeGreaterThan(0);
        for (const reference of smokeRefs) {
            expect(reference).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
            expect(knownRefs.has(reference)).toBe(true);
        }
    });
});
