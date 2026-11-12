import fs from 'node:fs';

import { describe, expect, test } from '@jest/globals';

const source = fs.readFileSync(new URL('../src/server-main.js', import.meta.url), 'utf8');

describe('launch-token server wiring', () => {
    test('mounts only the enabled gate immediately after helmet and before other request middleware', () => {
        expect(source).toMatch(/import createLaunchTokenMiddleware, \{ LAUNCH_COOKIE_NAME \} from '\.\/middleware\/launchToken\.js';/);
        expect(source).toMatch(/app\.use\(helmet\(\{[\s\S]*?\}\)\);\s*\/\/[^\n]*\nconst launchTokenMiddleware = createLaunchTokenMiddleware\(\);\s*if \(launchTokenMiddleware\) \{\s*app\.use\(launchTokenMiddleware\);\s*\}\s*app\.use\(getResponseCompressionMiddleware\(\)\);/);
        const mount = source.indexOf('app.use(launchTokenMiddleware);');
        for (const following of [
            'app.use(responseTime());',
            'app.use(express.json(',
            'app.use(cors(corsOptions));',
            'app.use(cookieSession(',
            'app.use(basicAuthMiddleware);',
            'app.use(whitelistMiddleware);',
            'app.use(setUserDataMiddleware);',
            'app.use(express.static(',
        ]) {
            expect(source.indexOf(following)).toBeGreaterThan(mount);
        }
    });

    test('protects only the launch-cookie name, before any expiration, only while the gate is enabled', () => {
        const clearRoute = source.slice(source.indexOf('app.post(\'/api/cookies/clear\''), source.indexOf('// CSRF Protection //'));
        const protection = 'if (launchTokenMiddleware) {\n        cookieNames.delete(LAUNCH_COOKIE_NAME);\n    }';

        expect(clearRoute).toContain(protection);
        expect(clearRoute.indexOf(protection)).toBeGreaterThan(clearRoute.indexOf('const cookieNames = new Set(['));
        expect(clearRoute.indexOf(protection)).toBeLessThan(clearRoute.indexOf('for (const name of cookieNames)'));
        expect(clearRoute).toContain('request.session = null;');
        expect(clearRoute).toContain('response.cookie(name, \'\', options);');
        expect(clearRoute.match(/cookieNames\.delete\(/g)).toHaveLength(1);
    });
});
