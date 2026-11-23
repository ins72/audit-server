// Tiny JSON file persistence: loads once, writes atomically.
//
// - A missing file starts empty.
// - A corrupt file is moved aside (never overwritten) and the server starts empty, loudly.
// - Any other read error (permissions, ...) throws, so we never silently replace data we could not read.
// - save() is debounced; flush() writes immediately, returns whether it worked, and is what mutations
//   that must not be lost use.

const fs = require('fs');
const path = require('path');

const BACKUPS_KEPT = 7;
const SAVE_DELAY_MS = 3000; // batches heartbeat-driven writes; mutations that must not be lost call flush()

const load = (filePath, initial) => {
    if (!filePath) return initial();
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') return initial();
        throw e;
    }
    try {
        return { ...initial(), ...JSON.parse(raw) };
    } catch (_e) {
        const backup = `${filePath}.corrupt-${Date.now()}`;
        fs.renameSync(filePath, backup);
        console.error(`${filePath} is not valid JSON. Moved it to ${backup} and starting empty.`);
        return initial();
    }
};

// One copy of the file per day (taken at startup, before anything is changed), newest 7 kept: protection against
// a bad deploy or a corrupted volume. Never fatal.
const backupDaily = (filePath) => {
    if (!filePath || !fs.existsSync(filePath)) return;
    try {
        const stamp = new Date().toISOString().slice(0, 10);
        const target = `${filePath}.bak-${stamp}`;
        if (!fs.existsSync(target)) fs.copyFileSync(filePath, target, fs.constants.COPYFILE_EXCL);
        const dir = path.dirname(filePath);
        const prefix = `${path.basename(filePath)}.bak-`;
        const old = fs.readdirSync(dir).filter((name) => name.startsWith(prefix)).sort().slice(0, -BACKUPS_KEPT);
        old.forEach((name) => fs.rmSync(path.join(dir, name), { force: true }));
    } catch (e) {
        console.error(`Could not back up ${filePath}:`, e.message);
    }
};

const createJsonFile = (filePath, initial, { saveDelayMs = SAVE_DELAY_MS } = {}) => {
    const data = load(filePath, initial);
    backupDaily(filePath);
    let timer = null;
    let healthy = true; // false after a failed write until the next successful one

    // Returns true when the data is on disk (or there is no file to write), false when the write failed.
    // Callers that acknowledge something irreversible (a Stripe webhook) must check it.
    const flush = () => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        if (!filePath) return true;
        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            const tmp = `${filePath}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
            fs.renameSync(tmp, filePath);
            healthy = true;
            return true;
        } catch (e) {
            console.error(`Failed to persist ${filePath}:`, e.message);
            healthy = false;
            return false;
        }
    };

    const save = () => {
        if (timer === null) {
            timer = setTimeout(flush, saveDelayMs);
            timer.unref();
        }
    };

    return { data, save, flush, isHealthy: () => healthy };
};

module.exports = { createJsonFile };
