/**
 * The step runner of the Android smoke (plan §7.1 steps 1-14).
 *
 * Every step runs on its own: it gets its own deadline and timing, a failure or timeout fails only that
 * step, and a step whose prerequisite did not pass is reported as not run with the reason. After every
 * step that ran, pass or fail, the data-safety check (step 14's checksum) runs and fails the step when the
 * seeded `data/` fixture changed. A crash of the app during a step fails that step too, and so does an unhandled
 * promise rejection that came while it ran. Nothing here touches a device; the steps and the checks are injected.
 */

/**
 * The fourteen end-user steps of plan §7.1, in run order. `needs` lists the steps that must pass first.
 * `timeoutMinutes` is the default deadline; step 11 adds its idle wait.
 */
export const STEPS = Object.freeze([
    { id: 1, key: 'first-run', needs: [], timeoutMinutes: 45 },
    { id: 2, key: 'server-webview', needs: [1], timeoutMinutes: 15 },
    { id: 3, key: 'chat', needs: [2], timeoutMinutes: 10 },
    { id: 4, key: 'git-update', needs: [2], timeoutMinutes: 15 },
    { id: 5, key: 'min-app-version', needs: [2], timeoutMinutes: 15 },
    { id: 6, key: 'apk-self-update', needs: [2], timeoutMinutes: 20 },
    { id: 7, key: 'extension', needs: [2], timeoutMinutes: 10 },
    { id: 8, key: 'server-plugin', needs: [2], timeoutMinutes: 15 },
    { id: 9, key: 'token-gate', needs: [2], timeoutMinutes: 15 },
    { id: 10, key: 'crash-policy', needs: [2], timeoutMinutes: 15 },
    { id: 11, key: 'background-survival', needs: [2], timeoutMinutes: 10 },
    { id: 12, key: 'repair', needs: [2], timeoutMinutes: 45 },
    { id: 13, key: 'node-only-runtime', needs: [1], timeoutMinutes: 5 },
    { id: 14, key: 'data-safety', needs: [1], timeoutMinutes: 2 },
].map(step => Object.freeze({ ...step, needs: Object.freeze(step.needs) })));

export const STATUS = Object.freeze({ passed: 'passed', failed: 'failed', notRun: 'not-run' });

/** A step failure with a machine code; `detail` is English for the CI log. */
export class StepError extends Error {
    /**
     * @param {string} code Machine-readable code.
     * @param {string} [detail] What went wrong.
     */
    constructor(code, detail = code) {
        super(detail);
        this.code = code;
    }
}

/** Thrown when a step's deadline passes; the step's signal is aborted at the same time. */
export class StepTimeoutError extends StepError {
    constructor(minutes) {
        super('timeout', `the step did not finish within ${minutes} min`);
    }
}

/**
 * Parses a step selection: `all`, or ids and ranges such as `1-3,9,14`.
 * @param {string|undefined} text Selection.
 * @returns {number[]} Sorted, unique step ids.
 */
export function parseStepSelection(text) {
    const ids = new Set(STEPS.map(step => step.id));
    if (text === undefined || text.trim() === '' || text.trim() === 'all') {
        return [...ids];
    }
    const selected = new Set();
    for (const part of text.split(',').map(item => item.trim())) {
        const match = /^(\d+)(?:-(\d+))?$/.exec(part);
        if (!match) {
            throw new StepError('invalid-steps', `cannot read step selection "${part}"`);
        }
        const first = Number(match[1]);
        const last = match[2] === undefined ? first : Number(match[2]);
        if (last < first) {
            throw new StepError('invalid-steps', `descending range "${part}"`);
        }
        for (let id = first; id <= last; id++) {
            if (!ids.has(id)) {
                throw new StepError('invalid-steps', `there is no step ${id}`);
            }
            selected.add(id);
        }
    }
    return [...selected].sort((left, right) => left - right);
}

/**
 * Runs a promise-returning function against a deadline. On timeout the controller is aborted, so the
 * work can stop its child processes, and the returned promise rejects with {@link StepTimeoutError}.
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} work Work.
 * @param {number} timeoutMs Deadline.
 * @param {number} minutes Deadline in minutes, for the message.
 * @returns {Promise<T>} Result.
 */
export async function withDeadline(work, timeoutMs, minutes = timeoutMs / 60_000) {
    const controller = new AbortController();
    let timer = null;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const error = new StepTimeoutError(minutes);
            controller.abort(error);
            reject(error);
        }, timeoutMs);
    });
    try {
        return await Promise.race([Promise.resolve().then(() => work(controller.signal)), deadline]);
    } finally {
        clearTimeout(timer);
    }
}

function describeError(error) {
    // fetch says only "fetch failed"; its cause tells a refused connection from a closed one.
    const cause = error?.cause ? [error.cause.code, error.cause.message].filter(Boolean).join(': ') : '';
    return {
        code: typeof error?.code === 'string' && error.code ? error.code : 'failed',
        error: `${String(error?.message ?? error)}${cause ? ` (${cause})` : ''}`,
    };
}

function redactErrors(record, redact) {
    for (const holder of [record, record.checksum]) {
        if (typeof holder?.error === 'string') {
            holder.error = redact(holder.error);
        }
    }
    if (typeof record.crashCheck === 'string') {
        record.crashCheck = redact(record.crashCheck);
    }
    if (Array.isArray(record.rejections)) {
        record.rejections = record.rejections.map(text => redact(text));
    }
}

/** Fails a passing step for the unhandled rejections that came while it ran, or names them in a failed step's error. */
function noteRejections(record, rejections) {
    if (rejections.length === 0) {
        return;
    }
    record.rejections = rejections;
    const what = `unhandled rejection: ${rejections.join('; ')}`;
    if (record.status === STATUS.passed) {
        Object.assign(record, { status: STATUS.failed, code: 'unhandled-rejection', error: what });
    } else {
        record.error = `${record.error} (${what})`;
    }
}

/** Names the app's crashes in the step's record; a step whose own checks passed fails with code app-crash. */
async function noteCrashes(record, newCrashes) {
    let crashes;
    try {
        crashes = await newCrashes();
    } catch (error) {
        // Without the crash log the step's own checks decide.
        record.crashCheck = describeError(error).error;
        return;
    }
    if (crashes.length === 0) {
        return;
    }
    record.crashes = crashes;
    const what = `the app crashed: ${crashes.map(crash => crash.summary).join('; ')}`;
    if (record.status === STATUS.passed) {
        Object.assign(record, { status: STATUS.failed, code: 'app-crash', error: what });
    } else {
        record.error = `${record.error} (${what})`;
    }
}

/**
 * Runs the selected steps in order.
 * @param {object} options Options.
 * @param {Array<{id: number, key: string, needs: readonly number[], timeoutMinutes: number,
 *     run: (context: object, signal: AbortSignal) => Promise<object|void>}>} options.steps Step implementations.
 * @param {number[]} options.selected Selected step ids.
 * @param {object} options.context Shared context handed to every step (the steps keep their state in it).
 * @param {(step: object, record: object) => Promise<{ok: boolean}|null>} [options.afterStep] The data-safety
 *     check; null means nothing to check yet (no baseline).
 * @param {() => Promise<Array<{summary: string}>>} [options.newCrashes] The app's crashes since the previous call;
 *     called after every step that ran, before the data-safety check.
 * @param {() => string[]} [options.newRejections] The messages of the unhandled promise rejections since the previous
 *     call; called after every step that ran, before the crash check.
 * @param {(text: string) => string} [options.redact] Applied to every error text a record keeps.
 * @param {(record: object) => void} [options.onRecord] Called with each finished record.
 * @param {() => number} [options.now] Clock.
 * @returns {Promise<object[]>} One record per step, in step order.
 */
export async function runSteps({ steps, selected, context, afterStep, newCrashes, newRejections, redact, onRecord = () => {}, now = Date.now }) {
    const wanted = new Set(selected);
    const records = [];
    const byId = new Map();
    for (const step of [...steps].sort((left, right) => left.id - right.id)) {
        const base = { id: step.id, key: step.key };
        let record;
        if (!wanted.has(step.id)) {
            record = { ...base, status: STATUS.notRun, reason: 'not-selected' };
        } else {
            const blocker = step.needs.find(need => byId.get(need)?.status !== STATUS.passed);
            if (blocker !== undefined) {
                const why = byId.get(blocker);
                const reason = why === undefined || why.reason === 'not-selected' ? `needs-step-${blocker}-selected` : `needs-step-${blocker}`;
                record = { ...base, status: STATUS.notRun, reason };
            } else {
                const started = now();
                record = { ...base, startedAt: new Date(started).toISOString() };
                try {
                    const details = await withDeadline(signal => step.run(context, signal), step.timeoutMinutes * 60_000, step.timeoutMinutes);
                    record.status = STATUS.passed;
                    if (details && typeof details === 'object' && Object.keys(details).length > 0) {
                        record.details = details;
                    }
                } catch (error) {
                    record.status = STATUS.failed;
                    Object.assign(record, describeError(error));
                }
                record.durationMs = now() - started;
                if (newRejections) {
                    noteRejections(record, newRejections());
                }
                if (newCrashes) {
                    await noteCrashes(record, newCrashes);
                }
                if (afterStep) {
                    try {
                        const check = await afterStep(step, record);
                        if (check) {
                            record.checksum = check;
                            if (!check.ok && record.status === STATUS.passed) {
                                record.status = STATUS.failed;
                                record.code = 'data-safety';
                                record.error = 'the seeded data/ fixture changed';
                            }
                        }
                    } catch (error) {
                        record.checksum = { ok: false, ...describeError(error) };
                        if (record.status === STATUS.passed) {
                            record.status = STATUS.failed;
                            record.code = 'data-safety';
                            record.error = `the data-safety check failed: ${record.checksum.error}`;
                        }
                    }
                }
            }
        }
        if (redact) {
            redactErrors(record, redact);
        }
        records.push(record);
        byId.set(step.id, record);
        onRecord(record);
    }
    return records;
}

/**
 * Step 14's own verdict: every data-safety check that ran after the other steps passed.
 * @param {object[]} records Records so far.
 * @returns {{checked: number[], failed: number[]}} Steps checked and steps whose check failed.
 */
export function dataSafetyVerdict(records) {
    const checked = records.filter(record => record.checksum && record.id !== 14);
    return {
        checked: checked.map(record => record.id),
        failed: checked.filter(record => !record.checksum.ok).map(record => record.id),
    };
}

/**
 * Overall result: passed only when every selected step passed.
 * @param {object[]} records Records.
 * @param {number[]} selected Selected step ids.
 * @returns {{ok: boolean, passed: number[], failed: number[], notRun: number[]}} Summary.
 */
export function summarize(records, selected) {
    const wanted = new Set(selected);
    const pick = status => records.filter(record => wanted.has(record.id) && record.status === status).map(record => record.id);
    const passed = pick(STATUS.passed);
    return { ok: passed.length === wanted.size, passed, failed: pick(STATUS.failed), notRun: pick(STATUS.notRun) };
}

/**
 * The per-step Markdown table for the job summary and the local report.
 * @param {object[]} records Records.
 * @returns {string[]} Lines.
 */
export function summaryTable(records) {
    const cell = text => String(text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 200);
    const lines = ['| step | key | result | seconds | detail |', '| --- | --- | --- | --- | --- |'];
    for (const record of records) {
        const seconds = record.durationMs === undefined ? '' : (record.durationMs / 1000).toFixed(1);
        const detail = record.status === STATUS.notRun ? record.reason : record.status === STATUS.failed ? `${record.code}: ${record.error}` : '';
        lines.push(`| ${record.id} | ${record.key} | ${record.status} | ${seconds} | ${cell(detail)} |`);
    }
    return lines;
}
