/**
 * Who answers a message in a group conversation. Nothing here reads the page: the caller says who the members are, how
 * talkative each card is, who was named, and who wrote each message of the chat, and the function answers up to
 * `maxSpeakers` members in the order that they speak. The rules are R5-20 of the rework plan:
 *
 * 1. A member that is named speaks, whatever its card says.
 * 2. When nobody is named, the member who spoke last answers with the chance `min(1, 2t)`.
 * 3. Otherwise a member is drawn, with the weight `(1 + messages since it spoke) * 2t`.
 * 4. A second speaker is drawn the same way and joins with the chance `0.6 t` of that member.
 */

import { GROUP_MAX_CONCURRENT_SPEAKERS } from './constants.js';
import { getFollowUpChance, getSecondSpeakerChance, getSpeakerWeightFactor } from './talkativeness-utils.js';

const BROAD_ADDRESS_PATTERN = /\b(everyone|everybody|anyone|someone|you\s+all|you\s+guys|y['’]?all|yall|both\s+of\s+you|all\s+of\s+you)\b/i;

/** A message to the whole group names nobody, so no member counts as the one that was talked to. */
export function isBroadGroupAddress(text) {
    return BROAD_ADDRESS_PATTERN.test(String(text || ''));
}

function getSilenceWeight(avatar, speakers) {
    const lastIndex = speakers.lastIndexOf(avatar);
    const messagesSinceSpeaking = lastIndex < 0 ? speakers.length + 1 : Math.max(1, speakers.length - lastIndex);
    return 1 + messagesSinceSpeaking;
}

function drawWeighted(pool, random) {
    const total = pool.reduce((sum, candidate) => sum + candidate.weight, 0);
    if (total <= 0) {
        return null;
    }

    let roll = random() * total;
    for (const candidate of pool) {
        roll -= candidate.weight;
        if (roll <= 0) {
            return candidate;
        }
    }
    return pool[pool.length - 1];
}

function getLastSpeaker(pool, speakers) {
    for (let index = speakers.length - 1; index >= 0; index--) {
        const candidate = pool.find(item => item.avatar === speakers[index]);
        if (candidate) {
            return candidate;
        }
    }
    return null;
}

/**
 * @param {object} input
 * @param {{ avatar: string, talkativeness: number, mentioned: boolean }[]} input.members The members that may answer.
 * `talkativeness` is the card's value from 0 to 1.
 * @param {string[]} input.speakers The avatar that wrote each message of the chat, oldest first; an empty string for a
 * message that no member wrote.
 * @param {string} input.latestUserText What the user wrote, and the context of its attachments.
 * @param {number} [input.maxSpeakers]
 * @param {() => number} [input.random] A number from 0 up to, not including, 1.
 * @returns {{ avatar: string, talkativeness: number, mentioned: boolean }[]} The members that answer, in the order of their replies.
 */
export function chooseGroupSpeakers({ members, speakers, latestUserText, maxSpeakers = GROUP_MAX_CONCURRENT_SPEAKERS, random = Math.random }) {
    if (!members.length) {
        return [];
    }

    const pool = members.map(member => ({ ...member, weight: getSilenceWeight(member.avatar, speakers) * getSpeakerWeightFactor(member.talkativeness) }));
    const selected = pool.filter(member => member.mentioned).slice(0, maxSpeakers);
    const remaining = () => pool.filter(member => !selected.includes(member));

    if (!selected.length && String(latestUserText || '').trim() && !isBroadGroupAddress(latestUserText)) {
        const lastSpeaker = getLastSpeaker(pool, speakers);
        const chance = lastSpeaker ? getFollowUpChance(lastSpeaker.talkativeness) : 0;
        // A card at the default value answers every time, so the roll is only made when it can fail.
        if (lastSpeaker && (chance >= 1 || random() < chance)) {
            selected.push(lastSpeaker);
        }
    }

    if (!selected.length) {
        // Every member at 0 and nobody named: someone still answers, as in a roleplay group, because the user waits for a reply.
        const first = drawWeighted(pool, random) ?? pool[Math.floor(random() * pool.length)];
        selected.push(first);
    }

    if (selected.length < maxSpeakers) {
        const second = drawWeighted(remaining(), random);
        if (second && random() < getSecondSpeakerChance(second.talkativeness)) {
            selected.push(second);
        }
    }

    return selected.map(({ weight, ...member }) => member);
}
