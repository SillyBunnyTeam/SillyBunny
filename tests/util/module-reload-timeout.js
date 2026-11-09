// Sized past a cold import of the server modules on a loaded machine. A test or hook that resets the module registry pays for that import inside its own timeout.
export const MODULE_RELOAD_TIMEOUT_MS = 30_000;
