import { el, markPlaceholder } from './dom.js';
import { nextRenderId } from './render-id.js';

function locationVisual(ctx, entry) {
    if (entry.avatar) {
        const image = document.createElement('img');
        image.className = 'sbca-location-avatar';
        image.src = ctx.getThumbnailUrl('avatar', entry.avatar);
        image.alt = '';
        image.loading = 'lazy';
        image.decoding = 'async';
        return image;
    }
    const icon = el('i', `sbca-location-icon fa-solid ${entry.icon}`);
    icon.setAttribute('aria-hidden', 'true');
    return icon;
}

function locationButton(ctx, entry, current, choose) {
    const control = el('button', 'sbca-location');
    control.type = 'button';
    control.dataset.sbListKey = entry.key;
    control.dataset.sbcaLocation = entry.key;
    control.setAttribute('aria-pressed', String(entry.key === current.key));
    control.tabIndex = entry.key === current.key ? 0 : -1;
    const label = el('span', 'sbca-location-label', entry.label);
    if (entry.placeholder) {
        markPlaceholder(label);
    }
    control.append(locationVisual(ctx, entry), label, el('small', 'sbca-location-count', String(entry.count)));
    if (entry.hint) {
        control.title = entry.hint;
        control.setAttribute('aria-label', `${entry.label}, ${entry.hint}`);
    }
    control.addEventListener('click', () => choose(entry));
    return control;
}

export function renderSidebar(ctx, ui, sidebar, choose) {
    const focused = sidebar.contains(document.activeElement) ? document.activeElement.dataset.sbcaLocation : null;
    const { sections, current } = ui.data.locations;
    const nav = el('div', 'sbca-locations');
    for (const section of sections) {
        const group = el('div', 'sbca-location-group');
        if (section.heading) {
            const heading = el('h3', 'sbca-location-heading', section.heading);
            heading.id = `sbca_location_heading_${nextRenderId()}`;
            if (section.placeholder) {
                markPlaceholder(heading);
            }
            group.setAttribute('role', 'group');
            group.setAttribute('aria-labelledby', heading.id);
            group.append(heading);
        }
        for (const entry of section.entries) {
            group.append(locationButton(ctx, entry, current, choose));
        }
        nav.append(group);
    }
    sidebar.replaceChildren(nav);
    if (focused) {
        [...nav.querySelectorAll('.sbca-location')]
            .find(control => control.dataset.sbcaLocation === focused)
            ?.focus({ preventScroll: true });
    }
}

export function bindLocationKeys(sidebar) {
    sidebar.addEventListener('keydown', event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            return;
        }
        const controls = [...sidebar.querySelectorAll('.sbca-location')];
        const index = controls.indexOf(event.target.closest('.sbca-location'));
        if (index < 0) {
            return;
        }
        event.preventDefault();
        const target = event.key === 'Home'
            ? 0
            : event.key === 'End'
                ? controls.length - 1
                : Math.max(0, Math.min(controls.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
        controls[target].focus();
    });
}
