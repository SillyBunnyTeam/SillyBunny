/* eslint-disable playwright/no-standalone-expect -- Jest contracts for pure functions. */
import { describe, expect, test } from '@jest/globals';
import { chooseHeroArt } from '../../public/scripts/sillybunny-home/hero-art.js';

/** A date in local time, which is the time the hero goes by. */
const at = (hour, minute) => new Date(2026, 9, 30, hour, minute);

describe('the hero of Home by local time', () => {
    test.each([
        ['one minute before the night starts', at(18, 59), 'hero-duo'],
        ['the minute the night starts', at(19, 0), 'hero-duo-night'],
        ['midnight', at(0, 0), 'hero-duo-night'],
        ['the last minute of the night', at(5, 59), 'hero-duo-night'],
        ['the minute the day starts', at(6, 0), 'hero-duo'],
        ['noon', at(12, 0), 'hero-duo'],
    ])('%s', (_, date, expected) => {
        expect(chooseHeroArt(date)).toBe(expected);
    });
});
