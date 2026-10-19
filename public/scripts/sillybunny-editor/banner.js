export function createBanner({ title, actionLabel, onActivate }) {
    const element = document.createElement('div');
    element.className = 'sb-banner';
    element.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = title;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu_button';
    button.textContent = actionLabel;
    const activate = () => onActivate();
    button.addEventListener('click', activate);
    element.append(text, button);
    return {
        element,
        setRevealed(revealed) { element.hidden = !revealed; },
        destroy() { button.removeEventListener('click', activate); element.remove(); },
    };
}
