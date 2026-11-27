import { afterEach, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoots = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

/**
 * Finds unescaped parentheses that break cmd.exe compound blocks inside a .bat script.
 * In cmd.exe, a bare `)` inside an `if (...)` / `else (...)` block closes the enclosing
 * block immediately unless it is inside double quotes or escaped with `^`.
 * @param {string} source
 * @returns {{ errors: string[], finalDepth: number }}
 */
function inspectBatchBlockParentheses(source) {
    const lines = source.split(/\r?\n/);
    const errors = [];
    let depth = 0;

    for (let index = 0; index < lines.length; index++) {
        const lineNumber = index + 1;
        const rawLine = lines[index];
        const trimmed = rawLine.trim();

        if (!trimmed || /^::/.test(trimmed)) {
            continue;
        }

        // At top level, REM lines are comments and cannot alter block nesting.
        // Inside a parenthesized block, cmd.exe still parses unescaped `)` on REM lines.
        if (depth === 0 && /^rem(?:\s|$)/i.test(trimmed)) {
            continue;
        }

        let inQuotes = false;
        let escaped = false;
        let seenNonWhitespace = false;

        for (let i = 0; i < rawLine.length; i++) {
            const ch = rawLine[i];

            if (escaped) {
                escaped = false;
                continue;
            }

            if (ch === '^' && !inQuotes) {
                escaped = true;
                continue;
            }

            if (ch === '"') {
                inQuotes = !inQuotes;
                seenNonWhitespace = true;
                continue;
            }

            if (!inQuotes && ch === '(') {
                // Only treat `(` as opening a compound block when it ends the line (if/else/for blocks).
                const rest = rawLine.slice(i + 1).trim();
                if (rest === '') {
                    depth++;
                    break;
                }
                if (depth > 0) {
                    errors.push(`line ${lineNumber}: unescaped "(" inside parenthesized block: ${trimmed}`);
                }
            } else if (!inQuotes && ch === ')') {
                if (depth === 0) {
                    if (!seenNonWhitespace) {
                        errors.push(`line ${lineNumber}: unmatched ")": ${trimmed}`);
                    }
                } else {
                    const after = rawLine.slice(i + 1).trim();
                    const isBlockCloser = !seenNonWhitespace && (after === '' || /^else\b/i.test(after));
                    if (!isBlockCloser) {
                        errors.push(`line ${lineNumber}: unescaped ")" inside parenthesized block prematurely closes block: ${trimmed}`);
                    }
                    depth--;
                    if (isBlockCloser && /^else\b/i.test(after)) {
                        // Continue scanning the rest of the `) else (` / `) else if ... (` line.
                        seenNonWhitespace = true;
                        continue;
                    }
                }
            }

            if (!/\s/.test(ch)) {
                seenNonWhitespace = true;
            }
        }
    }

    if (depth !== 0) {
        errors.push(`unbalanced parenthesized blocks at EOF (depth=${depth})`);
    }

    return { errors, finalDepth: depth };
}

describe('Windows batch launcher parenthesized block syntax (#672)', () => {
    test.each(['Start-Node.bat', 'Start.bat', 'Start-Bun.bat'])(
        '%s escapes parentheses inside parenthesized if/else blocks',
        (fileName) => {
            const source = fs.readFileSync(path.join(repoRoot, fileName), 'utf8');
            const result = inspectBatchBlockParentheses(source);

            expect(result.errors).toEqual([]);
            expect(result.finalDepth).toBe(0);
        },
    );
});

const describeWin32 = process.platform === 'win32' ? describe : describe.skip;

describeWin32('Start-Node.bat runtime execution under cmd.exe (#672)', () => {
    function runStartNodeBat({ developmentProfile = false } = {}) {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-start-node-bat-'));
        temporaryRoots.push(tempRoot);

        const appDir = path.join(tempRoot, 'app');
        const binDir = path.join(tempRoot, 'bin');
        fs.mkdirSync(path.join(appDir, 'scripts'), { recursive: true });
        fs.mkdirSync(binDir, { recursive: true });

        fs.copyFileSync(path.join(repoRoot, 'Start-Node.bat'), path.join(appDir, 'Start-Node.bat'));
        fs.writeFileSync(path.join(appDir, 'package-lock.json'), '{}\n', 'utf8');

        if (developmentProfile) {
            fs.mkdirSync(path.join(appDir, 'node_modules', 'eslint'), { recursive: true });
            fs.writeFileSync(path.join(appDir, 'node_modules', 'eslint', 'package.json'), '{}\n', 'utf8');
        }

        // Real node.exe executes these tiny JS stubs so Start-Node.bat enters the
        // `if !errorlevel! neq 0 (...)` block where the unescaped parentheses bug lived.
        fs.writeFileSync(path.join(appDir, 'scripts', 'dependency-state.js'), [
            'const action = process.argv[2];',
            'if (action === \'check\') process.exit(1);',
            'if (action === \'mark\') console.log(\'STUB_NODE_MARK \' + (process.argv[3] || \'\'));',
            '',
        ].join('\n'), 'utf8');

        fs.writeFileSync(path.join(appDir, 'server.js'), 'console.log(\'STUB_SERVER_LAUNCHED\');\n', 'utf8');

        fs.writeFileSync(path.join(binDir, 'npm.cmd'), [
            '@echo off',
            'echo STUB_NPM %*',
            'exit /b 0',
            '',
        ].join('\r\n'), 'utf8');

        const systemRoot = process.env.SystemRoot || 'C:\\Windows';
        const nodeDir = path.dirname(process.execPath);
        const env = {
            ComSpec: process.env.ComSpec || path.join(systemRoot, 'System32', 'cmd.exe'),
            SystemRoot: systemRoot,
            PATH: `${binDir};${nodeDir};${path.join(systemRoot, 'System32')}`,
            ProgramFiles: path.join(tempRoot, 'empty-pf'),
            'ProgramFiles(x86)': path.join(tempRoot, 'empty-pf86'),
            APPDATA: path.join(tempRoot, 'empty-appdata'),
            LocalAppData: path.join(tempRoot, 'empty-localappdata'),
            USERPROFILE: path.join(tempRoot, 'empty-profile'),
        };

        return spawnSync(env.ComSpec, ['/d', '/c', path.join(appDir, 'Start-Node.bat')], {
            cwd: appDir,
            env,
            input: '\r\n',
            encoding: 'utf8',
            timeout: 15_000,
        });
    }

    test('executes the dependency-install block in production mode without cmd.exe syntax errors', () => {
        const result = runStartNodeBat({ developmentProfile: false });

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stderr).not.toMatch(/was unexpected at this time/i);
        expect(result.stdout).toContain('Installing packages via npm (Node.js mode)...');
        expect(result.stdout).toContain('STUB_NPM ci --no-audit --no-fund --omit=dev --loglevel=error');
        expect(result.stdout).toContain('STUB_SERVER_LAUNCHED');
    });

    test('executes the dependency-install block in development mode without cmd.exe syntax errors', () => {
        const result = runStartNodeBat({ developmentProfile: true });

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stderr).not.toMatch(/was unexpected at this time/i);
        expect(result.stdout).toContain('Installing packages via npm including development tooling (Node.js mode)...');
        expect(result.stdout).toContain('STUB_NPM ci --no-audit --no-fund --loglevel=error');
        expect(result.stdout).toContain('STUB_SERVER_LAUNCHED');
    });
});
