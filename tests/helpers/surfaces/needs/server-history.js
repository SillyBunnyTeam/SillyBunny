/**
 * Three server addresses that the text completion connection remembers (`power_user.servers`), so that the address field
 * has a list to complete from. They live in the account settings, so this need is settings only. See `index.js` for the
 * shape of a need module.
 */

export const fixture = Object.freeze({
    label: 'ooba_blocking',
    urls: Object.freeze(['http://127.0.0.1:5000', 'http://127.0.0.1:5001', 'http://localhost:11434']),
});

export default {
    settings(settings) {
        const others = (settings.power_user.servers ?? []).filter(server => server.label !== fixture.label);
        settings.power_user.servers = [
            ...others,
            ...fixture.urls.map((url, index) => ({ label: fixture.label, url, lastConnection: 1767268800000 - index * 3600000 })),
        ];
    },
};
