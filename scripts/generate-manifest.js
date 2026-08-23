'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'manifest.json');

// Code friends should receive on Toolbox start.
// Do not list config.json, runtime-cache.json, last-disconnect.json,
// module.config.json, or generated AHK files — those are per-user.
const FILES = [
    'CHANGELOG.md',
    'ahk/hotkey.template.ahk',
    'index.js',
    'module.json',
    'settings_migrator.js',
    'settings_structure.js',
    'ui/index.html',
];

function sha256(filePath) {
    const raw = fs.readFileSync(filePath);
    // GitHub raw serves LF. Hash those bytes so Toolbox auto-update matches.
    const normalized = Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8');
    return crypto.createHash('sha256').update(normalized).digest('hex');
}

const files = {};
for (const rel of FILES) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) {
        throw new Error(`Missing file: ${rel}`);
    }
    files[rel.replace(/\\/g, '/')] = sha256(full);
}

fs.writeFileSync(OUT, JSON.stringify({ files }, null, 4) + '\n');
console.log(`Wrote ${path.relative(process.cwd(), OUT)} (${Object.keys(files).length} files)`);
