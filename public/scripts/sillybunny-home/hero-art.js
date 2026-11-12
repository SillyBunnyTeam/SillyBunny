/** Local time. No location is used, so this is the user's clock and not the sun. */
const NIGHT_STARTS_AT_HOUR = 19;
const NIGHT_ENDS_BEFORE_HOUR = 6;

/**
 * The hero art for the time of day: the moon scene from 19:00 to 05:59 local time, the day scene otherwise.
 * Home calls this when it renders, so the hero does not change under the user while Home is shown.
 * @param {Date} now
 * @returns {'hero-duo' | 'hero-duo-night'}
 */
export function chooseHeroArt(now) {
    const hour = now.getHours();
    return hour >= NIGHT_STARTS_AT_HOUR || hour < NIGHT_ENDS_BEFORE_HOUR ? 'hero-duo-night' : 'hero-duo';
}
