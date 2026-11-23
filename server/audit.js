// Append-only audit trail of operator and account-sharing actions (JSON lines), plus the latest entries in memory
// for /admin/audit. Never throws: auditing must not break the action being audited.

const fs = require('fs');
const path = require('path');

const KEEP_IN_MEMORY = 200;

const createAudit = (filePath = null) => {
    const recent = [];
    let dirReady = false;

    const record = (action, details = {}) => {
        const entry = { at: Date.now(), action, ...details };
        recent.push(entry);
        if (recent.length > KEEP_IN_MEMORY) recent.shift();
        if (filePath) {
            try {
                if (!dirReady) {
                    fs.mkdirSync(path.dirname(filePath), { recursive: true });
                    dirReady = true;
                }
                fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 }, (e) => {
                    if (e) console.error('Could not write audit log:', e.message);
                });
            } catch (e) {
                console.error('Could not write audit log:', e.message);
            }
        }
        return entry;
    };

    return { record, recent: () => recent.slice().reverse() };
};

module.exports = { createAudit };
