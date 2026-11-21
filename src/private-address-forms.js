import ipMatch from 'ip-matching';

const IPV4_MAPPED_PREFIX = Object.freeze([0, 0, 0, 0, 0, 0xffff]);

/**
 * Gives the IPv4 address that an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) names.
 * The operating system connects such an address to the IPv4 host, so a range check must read it as that host.
 * @param {string} address IP address
 * @returns {string} The dotted IPv4 address for an IPv4-mapped address, or the address as given
 */
export function unmapIpv4Address(address) {
    let ip;
    try {
        ip = ipMatch.getIP(address);
    } catch {
        return address;
    }

    if (!(ip instanceof ipMatch.IPv6) || !IPV4_MAPPED_PREFIX.every((part, index) => ip.parts[index] === part)) {
        return address;
    }

    const [high, low] = ip.parts.slice(6);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}
