const SERVER_BOOT_ID = `${Date.now().toString(36)}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function getServerBootId() {
    return SERVER_BOOT_ID;
}
