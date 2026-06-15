import { spawn } from 'node:child_process';
import { once } from 'node:events';
import process from 'node:process';

export const RESTART_EXIT_CODE = 75;
export const SUPERVISED_ENV = 'SILLYBUNNY_SUPERVISED';
export const LAUNCHER_ENV = 'SILLYBUNNY_LAUNCHER';

/**
 * Whether this process should act as a supervisor instead of booting the server.
 * Launcher scripts (Start.bat, start.sh) already loop on the restart exit code,
 * and a supervised child must not supervise again.
 * @param {NodeJS.ProcessEnv} env Environment to inspect
 * @returns {boolean} True when a supervisor loop should run
 */
export function shouldSupervise(env = process.env) {
    return env[SUPERVISED_ENV] !== '1' && env[LAUNCHER_ENV] !== '1';
}

/**
 * Runs the server as a supervised child and relaunches it whenever it exits
 * with the restart exit code. This makes the in-app "Restart server" action
 * work regardless of how the process was started (bun server.js, node
 * server.js, Docker, systemd) without relying on platform-specific detached
 * relaunch helpers.
 * @param {object} [options] Dependency injection for tests
 * @param {string[]} [options.argv] Command line of this process
 * @param {string[]} [options.execArgv] Runtime flags to forward to the child
 * @param {typeof spawn} [options.spawnFn] Spawn implementation
 * @param {(code: number) => never} [options.exitFn] Exit implementation
 * @returns {Promise<never>} Never resolves; exits the process instead
 */
export async function runSupervisor({
    argv = process.argv,
    execArgv = process.execArgv ?? [],
    spawnFn = spawn,
    exitFn = process.exit,
} = {}) {
    let child = null;
    let shuttingDown = false;

    const forwardSignal = (signal) => {
        shuttingDown = true;
        if (child && child.exitCode === null) {
            child.kill(signal);
        }
    };

    process.on('SIGINT', () => forwardSignal('SIGINT'));
    process.on('SIGTERM', () => forwardSignal('SIGTERM'));

    let isFirstLaunch = true;
    for (;;) {
        const env = { ...process.env, [SUPERVISED_ENV]: '1' };
        if (!isFirstLaunch) {
            env.SILLYBUNNY_SKIP_BROWSER_AUTO_LAUNCH = '1';
        }

        try {
            child = spawnFn(argv[0], [...execArgv, ...argv.slice(1)], { stdio: 'inherit', env });
            const [code, signal] = await once(child, 'exit');

            if (code === RESTART_EXIT_CODE && !shuttingDown) {
                console.info('[SillyBunny] Restarting server...');
                isFirstLaunch = false;
                continue;
            }

            return exitFn(signal ? 1 : (code ?? 0));
        } catch (error) {
            console.error('[SillyBunny] Supervisor failed to launch the server.', error);
            return exitFn(1);
        }
    }
}
