import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import { findPlaceholders, isExcluded, listCheckedFiles } from '../scripts/check-copy-placeholders.js';

const repoRoot = path.resolve(process.cwd(), '..');

describe('check-copy-placeholders', () => {
    test('checks what the program shows and skips tooling and documentation', () => {
        for (const file of ['public/index.html', 'public/scripts/power-user.js', 'src/server-main.js', 'default/content/index.json', 'NOTICE', 'scripts/bootstrap/install.sh', 'public/scripts/extensions/example/README.md']) {
            expect([file, isExcluded(file)]).toEqual([file, false]);
        }
        for (const file of ['tests/foo.test.js', 'docs/upstream-touch-ledger.md', 'scripts/copy-strings.js', '.github/workflows/release-checks.yml', 'assets-src/branding/README.md', 'AGENTS.md', 'LESSONS.md', 'DESIGN.json']) {
            expect([file, isExcluded(file)]).toEqual([file, true]);
        }
    });

    test('lists the tracked files of the repository without the excluded ones', () => {
        const files = listCheckedFiles(repoRoot);
        expect(files).toContain('public/index.html');
        expect(files.some(file => file.startsWith('src/'))).toBe(true);
        expect(files.some(isExcluded)).toBe(false);
    });

    describe('on a folder of sample files', () => {
        let directory;

        beforeEach(() => {
            directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-copy-placeholders-'));
        });

        afterEach(() => {
            fs.rmSync(directory, { recursive: true, force: true });
        });

        const write = (file, contents) => {
            fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
            fs.writeFileSync(path.join(directory, file), contents);
        };

        test('reports each line with a marker, in any case, with its line number', () => {
            write('public/a.js', 'const a = 1;\nconst title = t`lorum ipsum`;\n');
            write('public/b.html', '<p>\r\n<small>Lorum Ipsum</small>\r\n<span data-sb-copy-placeholder="true">TODO(copy)</span>\r\n</p>\r\n');

            expect(findPlaceholders({ repoRoot: directory, files: ['public/a.js', 'public/b.html'] })).toEqual([
                { file: 'public/a.js', line: 2, text: 'const title = t`lorum ipsum`;' },
                { file: 'public/b.html', line: 2, text: '<small>Lorum Ipsum</small>' },
                { file: 'public/b.html', line: 3, text: '<span data-sb-copy-placeholder="true">TODO(copy)</span>' },
            ]);
        });

        test('leaves upstream sample text, binary files and missing files alone', () => {
            write('public/sample.js', 'const sample = \'Lorem ipsum dolor sit amet\';\n');
            write('public/picture.webp', Buffer.concat([Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00]), Buffer.from('TODO(copy)')]));

            expect(findPlaceholders({ repoRoot: directory, files: ['public/sample.js', 'public/picture.webp', 'public/gone.js'] })).toEqual([]);
        });

        test('keeps only the text around a marker on a long line', () => {
            write('public/lib/vendor.min.js', `${'a'.repeat(5000)}TODO(copy)${'b'.repeat(5000)}`);

            const [finding] = findPlaceholders({ repoRoot: directory, files: ['public/lib/vendor.min.js'] });
            expect(finding.text).toBe(`${'a'.repeat(60)}TODO(copy)${'b'.repeat(60)}`);
        });
    });
});
