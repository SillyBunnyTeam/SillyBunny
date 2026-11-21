import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * Minimal stand-in for the jQuery calls updateGroupAvatar() makes. Each node is
 * { classes, attrs, children }; selectors are resolved against a fixed table so
 * the test can tell exactly which rows were swept.
 */
function createFakeDom() {
    const node = (classes, attrs = {}, children = []) => ({ classes, attrs, children });
    const templateRow = node(['group_select'], {}, [node(['avatar'])]);
    const listRow = (id) => node(['group_select'], { 'data-grid': id }, [node(['avatar'])]);
    const rows = [listRow('g1'), listRow('g2')];
    const preview = node([], {}, []);

    const wrap = (nodes) => ({
        nodes,
        each(fn) { nodes.forEach((n) => fn.call(n)); return this; },
        attr(name) { return nodes[0]?.attrs[name]; },
        empty() { nodes.forEach((n) => { n.children = []; }); return this; },
        append(child) { nodes.forEach((n) => n.children.push(child.nodes[0])); return this; },
        children(selector) {
            const wanted = selector.split(',').map((s) => s.trim().replace(/^\./, ''));
            const matches = [];
            for (const parent of nodes) {
                for (const child of parent.children) {
                    if (child.classes.some((c) => wanted.includes(c))) matches.push({ parent, child });
                }
            }
            return {
                first() {
                    return {
                        replaceWith(replacement) {
                            const hit = matches[0];
                            if (!hit) return;
                            const index = hit.parent.children.indexOf(hit.child);
                            hit.parent.children[index] = replacement.nodes[0];
                        },
                    };
                },
            };
        },
    });

    const $ = (selector) => {
        if (typeof selector !== 'string') return wrap([selector]);
        if (selector === '#group_avatar_preview') return wrap([preview]);
        if (selector === '#rm_print_characters_block .group_select') return wrap(rows);
        // The pre-fix selector also reached the hidden template row.
        if (selector === '.group_select') return wrap([templateRow, ...rows]);
        throw new Error(`unexpected selector ${selector}`);
    };

    return { $, templateRow, rows, preview };
}

async function loadUpdateGroupAvatar(dom) {
    const source = await fs.readFile(fileURLToPath(new URL('../public/scripts/group-chats.js', import.meta.url)), 'utf8');
    const start = source.indexOf('function updateGroupAvatar(group)');
    const end = source.indexOf('/**', start);
    const context = vm.createContext({
        $: dom.$,
        favsToHotswap: () => {},
        getGroupAvatar: (group) => ({ nodes: [{ classes: group?.id ? ['avatar', 'avatar_collage'] : ['missing-avatar'], attrs: { for: group?.id ?? null }, children: [] }] }),
    });
    vm.runInContext(`${source.slice(start, end)}\nthis.updateGroupAvatar = updateGroupAvatar;`, context);
    return context.updateGroupAvatar;
}

describe('updateGroupAvatar', () => {
    test('a create-mode draft without an id leaves the list template and rows alone', async () => {
        const dom = createFakeDom();
        const updateGroupAvatar = await loadUpdateGroupAvatar(dom);

        updateGroupAvatar({ id: null, members: [] });

        expect(dom.templateRow.children[0].classes).toEqual(['avatar']);
        expect(dom.rows.map((row) => row.children[0].classes)).toEqual([['avatar'], ['avatar']]);
        expect(dom.preview.children[0].classes).toEqual(['missing-avatar']);
    });

    test('a saved group only replaces its own list row avatar', async () => {
        const dom = createFakeDom();
        const updateGroupAvatar = await loadUpdateGroupAvatar(dom);

        updateGroupAvatar({ id: 'g2', members: [] });

        expect(dom.templateRow.children[0].classes).toEqual(['avatar']);
        expect(dom.rows[0].children[0].classes).toEqual(['avatar']);
        expect(dom.rows[1].children[0].attrs.for).toBe('g2');
    });
});
