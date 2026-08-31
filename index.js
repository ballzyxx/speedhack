'use strict';

/*
 * speedhack
 * --------------------------------------------------------------------------
 * Server-believed move-speed multiplier for private-server testing.
 *
 * Hooks the server-broadcast packets that carry move speed (S_USER_MOVETYPE
 * and S_PLAYER_STAT_UPDATE), multiplies the speed fields by cfg.multiplier,
 * and forwards them. The client believes the new speed AND the server agreed
 * to it (because we modified what the server told us), so movement is fully
 * authoritative — no rubber-banding.
 *
 * Asura: 2.0x on the client, legal runSpeed steps to the server (wall-clock).
 * Hits snap only if the gap is under 80. Agaia: raw 2.0x, no forge.
 *
 * Features:
 *   - Single global multiplier (1.0 .. 10.0)
 *   - Per-field speed overrides (walk/run/mount/swim)
 *   - AHK hotkey (toggle / hold)
 *   - Item-use trigger
 *   - Auto-disable in combat (opt-in)
 *   - Self-only buff icon indicator
 *   - GUI window (Ctrl+Shift+S)
 *   - Presets: walk / jog / sprint / dash / yeet
 *
 * Commands (typed in /8 toolbox chat):
 *   spd                       → toggle on/off
 *   spd s                     → status line
 *   spd on | off              → explicit on/off
 *   spd mult <number>         → set multiplier (1..10)
 *   spd walk|run|mount|swim <n|off>  → per-field speed override
 *   spd preset <name>         → walk | jog | sprint | dash | yeet
 *   spd combat                → toggle auto-disable in combat
 *   spd ind [id]              → toggle indicator, or set abnormality id
 *   spd item <id>             → set trigger item id (0 disables)
 *   spd hotkey <key>          → set AHK hotkey ("" disables)
 *   spd hotkeymode toggle|hold
 *   spd reloadhk              → restart AHK watcher
 *   spd ui                    → open the GUI (also Ctrl+Shift+S)
 *   spd reload                → re-read config.json from disk
 *   spd safe [auto|on|off]    → Asura location-forge (default auto)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

let electronMod = null;
try { electronMod = require('electron'); } catch (_) { /* unavailable in headless toolbox */ }

const MAX_MULTIPLIER = 10.0;
const MIN_MULTIPLIER = 1.0;
const INT16_MAX = 32767;
const FORGE_SLACK = 1.0;
const FORGE_BUDGET_CAP_MS = 150;
const SKILL_START_PACKETS = [
    'C_START_SKILL',
    'C_START_TARGETED_SKILL',
    'C_START_COMBO_INSTANT_SKILL',
    'C_START_INSTANCE_SKILL',
    'C_START_INSTANCE_SKILL_EX',
];

module.exports = function Speedhack(mod) {
    const cfg = mod.settings;

    // ----- runtime state -----
    let myGameId = 0n;
    let indicatorActive = false;
    let inCombat = false;
    let ahkProc = null;
    let hotkeyHeldOn = false;
    let lastHotkeyAt = 0;
    let uiWindow = null;
    let uiHotkeyRegistered = false;
    let uiSaveTimer = null;
    let uiGeometryReady = false;
    // Cache of the last server-broadcast move-type values, so on disable we
    // can replay them at 1.0x and the server believes our base speed again.
    let lastMoveType = null;
    let lastStatUpdate = null;   // last real S_PLAYER_STAT_UPDATE (full block)
    let liveHp = null;           // latest real current HP (tracked separately)
    let liveMaxHp = null;        // latest real max HP
    // Disk cache is only for toolbox reload mid-session. Never inject those
    // packets until the server has sent a live stat/move packet on THIS
    // connection — a stale S_PLAYER_STAT_UPDATE (null fields, old HP, etc.)
    // crashes the client or drops the socket as soon as you enter the world.
    let statsFromThisConnection = false;
    let lastOutLoc = null;
    let lastForgeType = 0;
    let lastSentWall = 0;
    let moveBudget = 0;
    let budgetAt = 0;
    let lastLocPacket = null;
    let lastSkillAt = 0;
    let isChangingZone = false;
    let lastRealClientPos = null;
    // Set when an S_INSTANT_MOVE correction is intercepted. Used to tell a
    // position-rejection skill cancel from a normal skill ending.
    let lastCorrectionAt = 0;
    let mounted = false;
    let lastMountPacket = null;
    let flying = false;
    let landSpeedRestoreTimer = null;
    let applyingStatReplay = false;
    let replayRetryTimer = null;
    let locomotionRefreshPending = false;
    let serverRunSpeed = 192;
    const forgeStats = {
        packets: 0,
        clamped: 0,
        lastType: 0,
        lastDt: 0,
        lastDxy: 0,
        lastMax: 0,
        lastAllowed: 0,
        maxDxy: 0,
        totalDxy: 0,
        lastSkillGap: 0,
        lastInteractGap: 0,
    };
    const diag = {
        lastReplayAt: 0,
        lastReplayErr: null,
        lastMovePacketAt: 0,
        lastStatPacketAt: 0,
        lastExit: null,
    };

    const log = (s) => mod.command.message(`[spd] ${s}`);
    const RUNTIME_CACHE_PATH = path.join(__dirname, 'runtime-cache.json');
    const FACTORY_RESET_FLAG = path.join(__dirname, '.factory-reset');
    const LOCAL_CACHE_FILES = [
        'runtime-cache.json',
        'last-disconnect.json',
        path.join('ahk', 'hotkey.runtime.ahk'),
        path.join('ahk', 'hotkey.ipc'),
    ];

    function jsonReplacer(_k, v) {
        return typeof v === 'bigint' ? { __bi: v.toString() } : v;
    }
    function jsonReviver(_k, v) {
        return (v && typeof v === 'object' && v.__bi) ? BigInt(v.__bi) : v;
    }

    function grabGameId() {
        try {
            if (mod.game && mod.game.me && mod.game.me.gameId) {
                myGameId = mod.game.me.gameId;
                return true;
            }
        } catch (_) {}
        return false;
    }

    function sameId(a, b) {
        if (a == null || b == null || a === 0n || a === 0) return false;
        try { return BigInt(a) === BigInt(b); } catch (_) { return String(a) === String(b); }
    }

    function saveRuntimeCache() {
        try {
            fs.writeFileSync(RUNTIME_CACHE_PATH, JSON.stringify({
                gameId: myGameId,
                lastMoveType,
                lastStatUpdate,
                liveHp,
                liveMaxHp,
            }, jsonReplacer));
        } catch (_) {}
    }

    let cacheSaveTimer = null;
    function scheduleSaveRuntimeCache() {
        if (cacheSaveTimer) return;
        cacheSaveTimer = mod.setTimeout(() => {
            cacheSaveTimer = null;
            saveRuntimeCache();
        }, 250);
    }

    function loadRuntimeCache() {
        try {
            if (!fs.existsSync(RUNTIME_CACHE_PATH)) return false;
            const parsed = JSON.parse(fs.readFileSync(RUNTIME_CACHE_PATH, 'utf8'), jsonReviver);
            if (!parsed || typeof parsed !== 'object') return false;
            if (parsed.gameId && myGameId && myGameId !== 0n && !sameId(parsed.gameId, myGameId)) return false;
            if (parsed.gameId && (!myGameId || myGameId === 0n)) myGameId = parsed.gameId;
            if (parsed.lastMoveType) lastMoveType = parsed.lastMoveType;
            if (parsed.lastStatUpdate) lastStatUpdate = parsed.lastStatUpdate;
            if (parsed.liveHp != null) liveHp = parsed.liveHp;
            if (parsed.liveMaxHp != null) liveMaxHp = parsed.liveMaxHp;
            return !!(lastMoveType || lastStatUpdate);
        } catch (_) {
            return false;
        }
    }

    function wipeLocalCaches() {
        for (const name of LOCAL_CACHE_FILES) {
            try { fs.unlinkSync(path.join(__dirname, name)); } catch (_) {}
        }
        lastMoveType = null;
        lastStatUpdate = null;
        liveHp = null;
        liveMaxHp = null;
    }

    function applyFactorySettings() {
        const migrate = require('./settings_migrator');
        const fresh = migrate(0, {});
        for (const k of Object.keys(cfg)) delete cfg[k];
        Object.assign(cfg, fresh);
        wipeLocalCaches();
        try { if (typeof mod.saveSettings === 'function') mod.saveSettings(); } catch (_) {}
    }

    try {
        if (fs.existsSync(FACTORY_RESET_FLAG)) {
            applyFactorySettings();
            try { fs.unlinkSync(FACTORY_RESET_FLAG); } catch (_) {}
        }
    } catch (_) {}
    delete cfg.rampMs;
    if (cfg.safeMode !== 'on' && cfg.safeMode !== 'off' && cfg.safeMode !== 'auto') cfg.safeMode = 'auto';
    if (!cfg.hotkey || !String(cfg.hotkey).trim()) cfg.hotkey = '-';
    // Vestigial from an older forge design; nothing reads them.
    delete cfg.forgeBurstMs;
    delete cfg.forgeQuietMs;

    const clampMultiplier = (n) => {
        const v = Number(n);
        if (!Number.isFinite(v)) return MIN_MULTIPLIER;
        return Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, v));
    };

    // Compute the multiplier we apply to a packet right now.
    // Returns 1.0 when off or (optionally) in combat.
    function effectiveMultiplier() {
        if (!cfg.enabled) return 1.0;
        if (cfg.autoDisableInCombat && inCombat) return 1.0;
        return clampMultiplier(cfg.multiplier);
    }

    // ----- speed packet rewriters -----
    // Multiply known speed fields on a packet event. Different patches use
    // slightly different field names; we touch every one we know about, so
    // the mod stays patch-portable.
    //
    // Each field can be in one of three "categories" — walk, run, mount, or
    // swim — and the user can override the multiplier per category. Falls
    // back to the master multiplier when no override.
    const SPEED_FIELD_CATEGORIES = {
        // walk-family
        walkSpeed:        'walkSpeed',
        walkSpeedBonus:   'walkSpeed',
        // run-family (the most common ones)
        speed:            'runSpeed',
        runSpeed:         'runSpeed',
        msSpeed:          'runSpeed',
        baseRunSpeed:     'runSpeed',
        totalRunSpeed:    'runSpeed',
        runSpeedBonus:    'runSpeed',
        // mount-family
        mountSpeed:       'mountSpeed',
        // swim-family (best-guess; some patches don't carry it on these packets)
        swimSpeed:        'swimSpeed',
    };

    // Resolve which multiplier applies to a given field, honoring per-field
    // overrides and falling back to the master.
    function multiplierForField(fieldName) {
        // Respect the master on/off gate FIRST. When the mod is disabled (or
        // suspended in combat), no field is boosted — regardless of any
        // per-field override. Without this, the override path below bypassed
        // cfg.enabled entirely, so walk/run/mount/swim stayed boosted even
        // when the GUI showed "disabled".
        if (!cfg.enabled) return 1.0;
        if (cfg.autoDisableInCombat && inCombat) return 1.0;

        const cat = SPEED_FIELD_CATEGORIES[fieldName];
        const fm = cfg.fieldMultipliers || {};
        const override = (cat && fm[cat] != null) ? Number(fm[cat]) : null;
        const m = (override !== null && Number.isFinite(override) && override >= MIN_MULTIPLIER && override <= MAX_MULTIPLIER)
            ? override
            : effectiveMultiplier();
        return m;
    }

    function multiplySpeedFields(event, fallbackMultiplier) {
        let changed = false;
        for (const f of Object.keys(SPEED_FIELD_CATEGORIES)) {
            if (event[f] === undefined || event[f] === null) continue;
            const raw = typeof event[f] === 'bigint' ? Number(event[f]) : event[f];
            if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) continue;
            const m = (fallbackMultiplier !== undefined)
                ? fallbackMultiplier
                : multiplierForField(f);
            if (m === 1.0) continue;
            const next = Math.max(1, Math.min(INT16_MAX, Math.round(raw * m)));
            if (next === raw) continue;
            event[f] = next;
            changed = true;
        }
        return changed;
    }

    function currentServer() {
        try {
            const id = (mod.serverId != null)
                ? mod.serverId
                : (mod.game && mod.game.me && mod.game.me.serverId);
            const list = mod.serverList
                || (mod.connection && mod.connection.metadata && mod.connection.metadata.serverList)
                || {};
            const entry = (id != null && list[id]) ? list[id] : {};
            return { id, name: String(entry.name || entry.serverName || '') };
        } catch (_) {
            return { id: null, name: '' };
        }
    }

    function isAsuraServer() {
        const s = currentServer();
        if (Number(s.id) === 500) return true;
        return /asura/i.test(s.name);
    }

    function isAgaiaServer() {
        const s = currentServer();
        // ID 2800 alone is not sufficient — private servers often reuse this
        // planet ID and still have a strict speed checker. Require the server
        // name to explicitly identify itself as Agaia before disabling the forge.
        return /agaia|agais/i.test(s.name);
    }

    // ----- ServerConfig.xml discovery + reader -----
    // Reads the game server's real anti-cheat settings off disk. This replaces
    // guessing the server by id/name, which silently disabled the forge on
    // private servers that reuse planet id 2800.
    //
    // The path is discovered automatically, so this works on any number of
    // separate server installs with no per-server setup: ServerConfig.xml always
    // sits beside the server binaries, and the WorldServer/ArbiterServer process
    // that is currently running is by definition the server being played.
    //
    // Resolution order:
    //   1. cfg.serverConfigPath      - explicit override, if set and present
    //   2. running server process    - dirname(exe)/ServerConfig.xml
    //   3. cfg.serverConfigPaths     - explicit list to try in order
    //   4. cfg.serverConfigSearchRoots - bounded scan for the known subpath
    const SRV_PROC_NAMES = ['WorldServer', 'ArbiterServer'];
    const SRVCFG_MARKER = path.join('Server', 'Executable', 'Bin', 'ServerConfig.xml');
    const SRVCFG_SEARCH_DEPTH = 6;
    const SRVCFG_REDISCOVER_MS = 60000;
    const SRVCFG_SKIP_DIRS = /^(windows|winnt|program files|program files \(x86\)|programdata|appdata|\$recycle\.bin|system volume information|node_modules|\.git|temp|tmp)$/i;
    let srvCfgCache = null;      // { path, mtimeMs, data }
    let srvCfgPathCache = null;  // { path, at }

    function configBesideExe(exePath) {
        try {
            const p = path.join(path.dirname(exePath), 'ServerConfig.xml');
            return fs.existsSync(p) ? p : null;
        } catch (_) { return null; }
    }

    // Ask Windows which server process is running and take the config next to
    // it. [Console]::Out.WriteLine is used instead of the pipeline so PowerShell
    // does not wrap long paths at the console width.
    function discoverConfigFromProcess() {
        if (process.platform !== 'win32') return null;
        const filter = SRV_PROC_NAMES.map((n) => `$_.Name -like '${n}*'`).join(' -or ');
        let out = '';
        try {
            const r = spawnSync('powershell', [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
                `Get-CimInstance Win32_Process | Where-Object { ${filter} } | ForEach-Object { [Console]::Out.WriteLine($_.ExecutablePath) }`,
            ], { encoding: 'utf8', timeout: 8000, windowsHide: true });
            if (!r || r.status !== 0) return null;
            out = String(r.stdout || '');
        } catch (_) { return null; }
        for (const line of out.split(/\r?\n/)) {
            const exe = line.trim();
            if (!exe) continue;
            const found = configBesideExe(exe);
            if (found) return found;
        }
        return null;
    }

    // Breadth-first, depth-capped, time-budgeted scan for
    // <root>/**/Server/Executable/Bin/ServerConfig.xml. The budget matters most
    // for UNC roots, where each directory read is a network round trip.
    function discoverConfigBySearch(roots, budgetMs) {
        const deadline = Date.now() + (budgetMs || 5000);
        for (const root of (roots || [])) {
            if (!root) continue;
            const queue = [[root, 0]];
            while (queue.length) {
                if (Date.now() > deadline) return null;
                const [dir, depth] = queue.shift();
                try {
                    const direct = path.join(dir, SRVCFG_MARKER);
                    if (fs.existsSync(direct)) return direct;
                    if (depth >= SRVCFG_SEARCH_DEPTH) continue;
                    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                        if (!e.isDirectory() || SRVCFG_SKIP_DIRS.test(e.name)) continue;
                        queue.push([path.join(dir, e.name), depth + 1]);
                    }
                } catch (_) { /* unreadable dir, skip */ }
            }
        }
        return null;
    }

    // ----- remote server support -----
    // The game server's address, so we can tell a local install from a remote
    // one and build UNC candidates for the remote case.
    function serverHost() {
        try {
            if (mod.serverIp) return String(mod.serverIp).replace(/^::ffff:/, '');
        } catch (_) {}
        return null;
    }

    function localAddresses() {
        const ips = new Set(['127.0.0.1', '::1', 'localhost']);
        try {
            const ifaces = os.networkInterfaces() || {};
            for (const list of Object.values(ifaces)) {
                for (const a of (list || [])) {
                    if (a && a.address) ips.add(String(a.address).replace(/^::ffff:/, ''));
                }
            }
        } catch (_) {}
        return ips;
    }

    function serverIsLocal() {
        const h = serverHost();
        if (!h) return true; // unknown: assume local, process probe is harmless
        return localAddresses().has(h);
    }

    // For a remote server, the config can only be read through a file share.
    // Probe a few likely share names on the server host; each check is a single
    // stat so a miss is cheap. Anything found is used as a search root.
    function uncSearchRoots() {
        const host = serverHost();
        if (!host || serverIsLocal()) return [];
        const shares = (Array.isArray(cfg.serverConfigShares) && cfg.serverConfigShares.length)
            ? cfg.serverConfigShares
            : ['TERA', 'Tera', 'tera', 'Server', 'server', 'Games', 'games', 'C$', 'D$', 'E$'];
        const roots = [];
        for (const s of shares) {
            const r = `\\\\${host}\\${s}\\`;
            try { if (fs.existsSync(r)) roots.push(r); } catch (_) {}
        }
        return roots;
    }

    // Every drive letter that currently resolves, which includes mapped network
    // drives — the usual way a remote server's folder is reachable.
    function drivesRoots() {
        const roots = [];
        if (process.platform !== 'win32') return roots;
        for (let c = 67 /* C */; c <= 90 /* Z */; c++) {
            const r = `${String.fromCharCode(c)}:\\`;
            try { if (fs.existsSync(r)) roots.push(r); } catch (_) {}
        }
        return roots;
    }

    function resolveServerConfigPath() {
        const explicit = cfg.serverConfigPath;
        if (explicit) {
            try { if (fs.existsSync(explicit)) return explicit; } catch (_) {}
        }
        const now = Date.now();
        if (srvCfgPathCache && (now - srvCfgPathCache.at) < SRVCFG_REDISCOVER_MS) {
            try { if (fs.existsSync(srvCfgPathCache.path)) return srvCfgPathCache.path; } catch (_) {}
        }

        let found = null;
        // Local install: the running server process points straight at it.
        if (serverIsLocal()) found = discoverConfigFromProcess();
        // Explicit list next (UNC paths work here).
        if (!found && Array.isArray(cfg.serverConfigPaths)) {
            for (const p of cfg.serverConfigPaths) {
                try { if (p && fs.existsSync(p)) { found = p; break; } } catch (_) {}
            }
        }
        // Then scan: configured roots, else all drives plus any reachable share
        // on the server host. Budgeted so a big or slow disk cannot stall us.
        if (!found) {
            const configured = Array.isArray(cfg.serverConfigSearchRoots) ? cfg.serverConfigSearchRoots.filter(Boolean) : [];
            const roots = configured.length ? configured : drivesRoots().concat(uncSearchRoots());
            found = discoverConfigBySearch(roots, 5000);
        }
        srvCfgPathCache = found ? { path: found, at: now } : null;
        return found;
    }

    function attrOf(tagAttrs, name) {
        if (!tagAttrs) return null;
        const m = tagAttrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'));
        return m ? m[1] : null;
    }
    // Require whitespace after the tag name so <SpeedHack> does not also
    // match <SpeedHackAlt>.
    function tagAttrsOf(xml, tag) {
        const m = xml.match(new RegExp(`<${tag}(\\s[^>]*?)/?>`, 'i'));
        return m ? m[1] : null;
    }
    const isTrue = (v) => String(v).toLowerCase() === 'true';

    function readServerConfig() {
        if (!cfg.useServerConfig) return null;
        const file = resolveServerConfigPath();
        if (!file) return null;
        let stat;
        try { stat = fs.statSync(file); } catch (_) { return null; }
        // Re-parse when the file is edited or when a different server install
        // has been detected.
        if (srvCfgCache && srvCfgCache.path === file && srvCfgCache.mtimeMs === stat.mtimeMs) {
            return srvCfgCache.data;
        }

        let xml;
        try { xml = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }

        const sh    = tagAttrsOf(xml, 'SpeedHack');
        const shAlt = tagAttrsOf(xml, 'SpeedHackAlt');
        const pos   = tagAttrsOf(xml, 'CommonPosCheck');
        const data = {
            speedHackOn:     sh    ? isTrue(attrOf(sh, 'turnOn'))    : null,
            speedHackAltOn:  shAlt ? isTrue(attrOf(shAlt, 'turnOn')) : null,
            disconnAvgSpeed: sh ? Number(attrOf(sh, 'disconnAvgSpeed')) || null : null,
            gapClientServer: pos ? Number(attrOf(pos, 'gapOfClientServer')) || null : null,
        };
        // A parse that finds neither checker means the file layout is not what
        // we expect; treat it as unreadable so we fall back to the safe default.
        if (data.speedHackOn === null && data.speedHackAltOn === null) return null;
        data.path = file;
        srvCfgCache = { path: file, mtimeMs: stat.mtimeMs, data };
        return data;
    }

    // True when any server-side speed checker is enabled, i.e. the forge is
    // required. null when the config could not be read.
    function serverNeedsForge() {
        const c = readServerConfig();
        if (!c) return null;
        return !!(c.speedHackOn || c.speedHackAltOn);
    }

    // ----- learned per-server profiles -----
    // When the config file cannot be reached (server on another machine with no
    // share), the module still has to decide whether to forge. It remembers what
    // each server has actually done: a speed-hack disconnect proves the server
    // checks movement; a long clean stretch with the forge off proves it does
    // not. Keyed by host+serverId so every server is tracked separately.
    const PROFILES_PATH = path.join(__dirname, 'server-profiles.json');
    const PROFILE_CLEAN_MS = 5 * 60 * 1000; // clean boosted time before trusting "no checks"
    let profiles = null;

    function loadProfiles() {
        if (profiles) return profiles;
        try { profiles = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8')); } catch (_) { profiles = {}; }
        if (!profiles || typeof profiles !== 'object') profiles = {};
        return profiles;
    }
    function saveProfiles() {
        try { fs.writeFileSync(PROFILES_PATH, JSON.stringify(loadProfiles(), null, 2)); } catch (_) {}
    }
    function serverKey() {
        const s = currentServer();
        return `${serverHost() || '?'}|${s.id != null && s.id !== '' ? s.id : '?'}`;
    }
    function serverProfile() {
        const all = loadProfiles();
        const k = serverKey();
        if (!all[k]) all[k] = { checks: null, cleanBoostedMs: 0, lastKickAt: 0, updatedAt: 0 };
        return all[k];
    }
    function markServerChecks(value, reason) {
        const prof = serverProfile();
        if (prof.checks === value) return;
        prof.checks = value;
        prof.updatedAt = Date.now();
        if (value) { prof.lastKickAt = Date.now(); prof.cleanBoostedMs = 0; }
        saveProfiles();
        log(`learned: this server ${value ? 'DOES' : 'does not'} check movement (${reason})`);
        refreshServerPolicy();
    }
    // Called periodically while boosted with the forge off. A long clean run is
    // evidence the server is not policing movement.
    function creditCleanTime(ms) {
        const prof = serverProfile();
        if (prof.checks !== null) return;
        prof.cleanBoostedMs = (prof.cleanBoostedMs || 0) + ms;
        if (prof.cleanBoostedMs >= PROFILE_CLEAN_MS) markServerChecks(false, 'no violations while unforged');
    }

    // ----- resolved policy (computed rarely, read often) -----
    // safeModeActive() runs on every movement packet, so the expensive parts
    // (process probe, disk scan, file parse) are done here instead and only on
    // boot, login, or an explicit command.
    let serverPolicy = { forge: true, source: 'default' };
    let policyHost = null;   // host the current policy was resolved for

    // A server you have declared yourself, matched on address. Lets a server
    // you own be identified even when its config file is unreachable.
    function declaredServer() {
        const map = cfg.knownServers;
        if (!map || typeof map !== 'object') return null;
        const host = serverHost();
        if (!host) return null;
        const entry = map[host];
        if (!entry || typeof entry !== 'object' || typeof entry.checks !== 'boolean') return null;
        return entry;
    }

    function refreshServerPolicy() {
        const needed = serverNeedsForge();
        const declared = declaredServer();
        if (needed !== null) {
            serverPolicy = { forge: needed, source: 'ServerConfig.xml' };
        } else if (declared) {
            serverPolicy = { forge: declared.checks, source: `declared${declared.label ? ' (' + declared.label + ')' : ''}` };
        } else {
            const prof = serverProfile();
            if (prof.checks === true)       serverPolicy = { forge: true,  source: 'learned' };
            else if (prof.checks === false) serverPolicy = { forge: false, source: 'learned' };
            else if (isAgaiaServer())       serverPolicy = { forge: false, source: 'name match' };
            else if (isAsuraServer())       serverPolicy = { forge: true,  source: 'name match' };
            else                            serverPolicy = { forge: true,  source: 'safe default' };
        }
        broadcastUiState();
        return serverPolicy;
    }

    function safeModeActive() {
        if (cfg.safeMode === 'on') return true;
        if (cfg.safeMode === 'off') return false;
        return serverPolicy.forge;
    }

    function guiServerInfo() {
        const s = currentServer();
        const kind = serverPolicy.forge ? 'checked' : 'unchecked';
        const name = s.name
            ? (s.id != null && s.id !== '' ? `${s.name} (${s.id})` : s.name)
            : (s.id != null && s.id !== '' ? `Server ${s.id}` : 'Not logged in');
        return {
            name,
            id: s.id == null || s.id === '' ? null : Number(s.id),
            kind,
            forge: safeModeActive(),
            safeMode: cfg.safeMode,
        };
    }

    function cloneLoc(loc) {
        if (!loc) return loc;
        if (typeof loc.clone === 'function') return loc.clone();
        return { x: loc.x, y: loc.y, z: loc.z };
    }

    function currentMeLoc() {
        try {
            if (mod.game && mod.game.me && mod.game.me.loc) return cloneLoc(mod.game.me.loc);
        } catch (_) {}
        return null;
    }

    function dist2d(a, b) {
        if (!a || !b) return 0;
        const dx = Number(a.x) - Number(b.x);
        const dy = Number(a.y) - Number(b.y);
        return Math.sqrt(dx * dx + dy * dy);
    }

    function clampLoc2d(from, to, maxDist) {
        if (!from || !to) return to;
        const d = dist2d(from, to);
        if (d <= maxDist || maxDist <= 0) return to;
        const t = maxDist / d;
        const loc = {
            x: Number(from.x) + (Number(to.x) - Number(from.x)) * t,
            y: Number(from.y) + (Number(to.y) - Number(from.y)) * t,
            z: Number(from.z) + (Number(to.z) - Number(from.z)) * t,
        };
        if (typeof to.clone === 'function' && to.constructor) {
            try {
                const v = to.clone();
                v.x = loc.x; v.y = loc.y; v.z = loc.z;
                return v;
            } catch (_) {}
        }
        return loc;
    }

    function cacheRealRunSpeed(event) {
        // Forge as fast as the server will tolerate, to keep drift minimal.
        // The [Limited] Dist Margin equals the character's total speed and the
        // check window has been observed up to ~1.05s, so the forge must stay
        // at or below total / 1.05 ≈ total × 0.95 or the margin is exceeded.
        // Running the forge this close to the limit minimises how fast the
        // client/server position gap grows, which is what skill packets expose.
        const total = (Number(event.runSpeed) || 0) + (Number(event.runSpeedBonus) || 0);
        const run = Math.floor(total * 0.95);
        if (run > 1) serverRunSpeed = run;
    }

    function realRunSpeed() {
        return Math.max(1, serverRunSpeed || 192);
    }

    function resetForgeState() {
        lastOutLoc = null;
        // Must clear the cached real position too. It is used as the fallback
        // target when redirecting S_INSTANT_MOVE; a stale value from the previous
        // channel/zone would teleport the client into old-channel coordinates.
        lastRealClientPos = null;
        lastForgeType = 0;
        lastSentWall = 0;
        moveBudget = 0;
        budgetAt = 0;
    }

    function seedForgeLoc(loc) {
        const now = Date.now();
        lastOutLoc = loc ? cloneLoc(loc) : null;
        lastSentWall = now;
        moveBudget = 0;
        budgetAt = loc ? now : 0;
    }

    function acceptForgedLoc(event, loc, type, now) {
        event.loc = loc;
        if (event.dest) event.dest = cloneLoc(loc);
        lastOutLoc = cloneLoc(loc);
        lastSentWall = now;
        lastForgeType = type;
    }

    function takeMoveBudget(now) {
        const elapsed = budgetAt ? Math.max(0, now - budgetAt) : 0;
        budgetAt = now;
        const speed = realRunSpeed();
        const cap = speed * FORGE_BUDGET_CAP_MS / 1000;
        moveBudget = Math.min(moveBudget + speed * elapsed / 1000 * FORGE_SLACK, cap);
        forgeStats.lastAllowed = speed;
        return elapsed;
    }

    function rememberLocPacket(event) {
        lastLocPacket = {
            w: event.w,
            lookDirection: event.lookDirection,
            jumpDistance: event.jumpDistance,
            inShuttle: event.inShuttle,
            time: event.time,
        };
    }

    // Track skill timing for the S_INSTANT_MOVE intercept.
    // Do NOT modify skill packets — any loc/dest rewriting corrupts the combo
    // chain validation and causes CR_NOT_CONNECTED_DASHSHOT_SKILL rejections
    // which produce the snap-back the user feels. Instead we let skills pass
    // through unmodified and rely on S_INSTANT_MOVE interception to prevent
    // any server correction from reaching the client as a snap.
    function onOutgoingSkill(event) {
        if (!safeModeActive() || !cfg.enabled || effectiveMultiplier() <= 1.0) return;
        if (!event.loc || !lastOutLoc) return;
        const gap = dist2d(lastOutLoc, event.loc);
        forgeStats.lastSkillGap = Math.round(gap * 10) / 10;
        lastSkillAt = Date.now();
    }

    // The server only gets legal runSpeed distance per real wall-clock
    // time. dest is always pinned to loc so a 2x look-ahead cannot slip
    // through. Jump/fall/stop use the same XY budget.
    function forgeOutgoingLocation(event) {
        const now = Date.now();
        const type = Number(event.type);
        rememberLocPacket(event);
        if (event.loc) lastRealClientPos = cloneLoc(event.loc);

        if (!safeModeActive() || !cfg.enabled || effectiveMultiplier() <= 1.0) {
            seedForgeLoc(event.loc);
            lastForgeType = type;
            return false;
        }


        forgeStats.packets += 1;
        forgeStats.lastType = type;

        if (!lastOutLoc) {
            const from = currentMeLoc();
            if (from) lastOutLoc = from;
        }
        if (!budgetAt) budgetAt = now;

        if (!lastOutLoc) {
            acceptForgedLoc(event, event.loc, type, now);
            return event.dest ? true : undefined;
        }

        const elapsed = takeMoveBudget(now);
        const dxy = dist2d(lastOutLoc, event.loc);
        forgeStats.lastDt = elapsed;
        forgeStats.lastDxy = Math.round(dxy * 10) / 10;
        forgeStats.lastMax = Math.round(moveBudget * 10) / 10;
        if (dxy > forgeStats.maxDxy) forgeStats.maxDxy = Math.round(dxy * 10) / 10;

        let loc = event.loc;
        if (dxy > moveBudget) {
            loc = clampLoc2d(lastOutLoc, event.loc, moveBudget);
            forgeStats.clamped += 1;
            forgeStats.totalDxy += moveBudget;
            moveBudget = 0;
        } else {
            forgeStats.totalDxy += dxy;
            moveBudget -= dxy;
        }

        acceptForgedLoc(event, loc, type, now);
        return true;
    }

    // ----- identity / combat tracking -----
    mod.hook('S_LOGIN', '*', (event) => {
        myGameId = event.gameId;
        inCombat = false;
        resetForgeState();
        mounted = false;
        lastMountPacket = null;
        flying = false;
        locomotionRefreshPending = false;
        if (landSpeedRestoreTimer) {
            try { mod.clearTimeout(landSpeedRestoreTimer); } catch (_) {}
            landSpeedRestoreTimer = null;
        }
        if (replayRetryTimer) {
            try { mod.clearTimeout(replayRetryTimer); } catch (_) {}
            replayRetryTimer = null;
        }
        // Stale packets from the last Toolbox session must not be injected
        // during login — that can crash the client or drop the connection.
        lastMoveType = null;
        lastStatUpdate = null;
        serverRunSpeed = 192;
        liveHp = null;
        liveMaxHp = null;
        statsFromThisConnection = false;
        forgeStats.packets = 0;
        forgeStats.clamped = 0;
        forgeStats.maxDxy = 0;
        forgeStats.totalDxy = 0;
        // Always start off when you enter a character. Turn it on with - / spd.
        if (cfg.enabled) setEnabled(false, 'login');
        // Resolving the policy can run a process probe and a disk scan, so keep
        // it off the packet handler — a slow path here would stall the proxy
        // during login. Until it completes the previous policy applies, and the
        // initial default is forge-on, so nothing is ever left unprotected.
        mod.setTimeout(() => {
            const srv = currentServer();
            const label = srv.name || srv.id || '?';
            const host = serverHost() || '?';
            // Only re-discover when we have moved to a different server box.
            if (policyHost !== host) {
                policyHost = host;
                srvCfgPathCache = null;
                srvCfgCache = null;
            }
            refreshServerPolicy();
            const sc = readServerConfig();
            if (sc) {
                log(`server=${label} @${host} — SpeedHack=${sc.speedHackOn ? 'ON' : 'off'} Alt=${sc.speedHackAltOn ? 'ON' : 'off'} avgSpeed=${sc.disconnAvgSpeed || '?'} gap=${sc.gapClientServer || '?'}`);
            } else {
                log(`server=${label} @${host} — ServerConfig not reachable (${serverIsLocal() ? 'local' : 'remote'}), using ${serverPolicy.source}`);
            }
            log(safeModeActive()
                ? `forge ON (${serverPolicy.source}) — screen fast, legal steps to server`
                : `forge OFF (${serverPolicy.source}) — real positions sent, no drift`);
        }, 0);
        broadcastUiState();
    });

    mod.hook('S_SPAWN_ME', '*', (event) => {
        if (event.gameId) myGameId = event.gameId;
        // Set the zone-change guard here too — channel changes within the same
        // zone only fire S_SPAWN_ME (no S_LOAD_TOPO), so without this the guard
        // is never raised and a pending skill S_INSTANT_MOVE gets wrongly
        // intercepted, corrupting the forge position and causing an instant kick.
        isChangingZone = true;
        // Drop the cached real position: it still points into the previous
        // channel and must not be used as a redirect target.
        lastRealClientPos = null;
        seedForgeLoc(event.loc);
        scheduleStartupIndicator();
        // 3s, not 1s — a channel switch needs time to fully settle and any
        // correction arriving during that window must reach the client intact.
        mod.setTimeout(() => { isChangingZone = false; }, 3000);
    });

    mod.hook('S_USER_STATUS', '*', (event) => {
        if (!myGameId || !sameId(event.gameId, myGameId)) return;
        // status: 0 = idle, 1 = combat (per most patches). Handle the safe
        // boolean too in case the field is named differently.
        const wasCombat = inCombat;
        inCombat = (event.status === 1) || (event.inCombat === true);
        if (cfg.autoDisableInCombat && inCombat && !wasCombat && cfg.enabled) {
            log('combat detected — multiplier suspended (auto-disable-in-combat)');
            // Replay last cached movetype at 1.0x so the server reads our
            // real speed again immediately.
            replayCachedMoveAt(1.0);
            broadcastUiState();
        } else if (cfg.autoDisableInCombat && !inCombat && wasCombat && cfg.enabled) {
            log('combat ended — multiplier resumed');
            replayCachedMoveAt(); // resume per-field
            broadcastUiState();
        }
    });

    try {
        mod.hook('S_EXIT', '*', (event) => {
            diag.lastExit = { category: event.category, code: event.code };
            log(`S_EXIT category=${event.category} code=${event.code} skillGap=${forgeStats.lastSkillGap} maxDxy=${forgeStats.maxDxy} allow=${forgeStats.lastAllowed}`);
            writeDisconnectReport('S_EXIT', diag.lastExit);
        });
    } catch (_) {}
    try {
        mod.hook('S_RETURN_TO_LOBBY', 'event', () => writeDisconnectReport('S_RETURN_TO_LOBBY'));
    } catch (_) {}
    try {
        mod.hook('S_PREPARE_RETURN_TO_LOBBY', 'event', () => writeDisconnectReport('S_PREPARE_RETURN_TO_LOBBY'));
    } catch (_) {}
    try {
        if (mod.game && typeof mod.game.on === 'function') {
            mod.game.on('leave_game', () => writeDisconnectReport('leave_game'));
        }
    } catch (_) {}

    try {
        mod.hook('S_LOAD_TOPO', '*', (event) => {
            isChangingZone = true;
            lastRealClientPos = null;
            if (event && event.loc) seedForgeLoc(event.loc);
            else resetForgeState();
        });
    } catch (_) {}
    try {
        mod.hook('S_MOUNT_VEHICLE', '*', { filter: { fake: false } }, (event) => {
            if (myGameId && sameId(event.gameId, myGameId)) {
                mounted = true;
                lastMountPacket = Object.assign({}, event);
            }
        });
    } catch (_) {}
    try {
        mod.hook('S_UNMOUNT_VEHICLE', '*', { filter: { fake: false } }, (event) => {
            if (myGameId && sameId(event.gameId, myGameId)) {
                mounted = false;
                lastMountPacket = null;
            }
        });
    } catch (_) {}
    // Suppress skill-rejected notifications so the client animation plays through
    // instead of snapping back to the skill start position.
    // S_CANNOT_START_SKILL / S_ACTION_END with type 6 (= position-check cancel)
    // are what the server sends when 비정상 위치 변동 rejects a skill mid-animation.
    // Only suppress a skill cancel that is the fallout of a position rejection,
    // i.e. one arriving right after we intercepted an S_INSTANT_MOVE correction.
    // Dropping these unconditionally also swallows normal skill completion and
    // genuine "cannot use" replies (out of range, no MP, on cooldown), which
    // desyncs the client's skill state.
    const CANCEL_SUPPRESS_MS = 1000;
    function suppressingSkillCancel() {
        if (!safeModeActive() || !cfg.enabled || effectiveMultiplier() <= 1.0) return false;
        return (Date.now() - lastCorrectionAt) < CANCEL_SUPPRESS_MS;
    }
    try {
        mod.hook('S_CANNOT_START_SKILL', '*', { filter: { fake: false } }, () => {
            if (suppressingSkillCancel()) return false;
        });
    } catch (_) {}
    try {
        mod.hook('S_ACTION_END', '*', { filter: { fake: false } }, (event) => {
            if (!myGameId || !sameId(event.gameId, myGameId)) return;
            if (suppressingSkillCancel()) return false;
        });
    } catch (_) {}

    try {
        mod.hook('S_INSTANT_MOVE', '*', { filter: { fake: false } }, (event) => {
            if (!myGameId || !sameId(event.gameId, myGameId) || !event.loc) return;

            // Intercept ALL S_INSTANT_MOVE during active gameplay and redirect
            // the client to its real current position so there is no visible
            // snap-back. The forge stays at the server's destination so the
            // next C_PLAYER_LOCATION clamps correctly from there.
            // Zone-change guard is the only exception.
            if (safeModeActive() && cfg.enabled && effectiveMultiplier() > 1.0 && !isChangingZone) {
                // A very distant instant-move is a real teleport (channel/zone
                // change, dungeon entry, GM warp) — never redirect those, or the
                // client is left behind in the old area and gets kicked.
                const jump = lastOutLoc ? dist2d(lastOutLoc, event.loc) : Infinity;
                if (jump > 2000) {
                    seedForgeLoc(event.loc);
                    return;
                }
                seedForgeLoc(event.loc);
                // currentMeLoc() can be stale or null in some toolbox builds.
                // Fall back to lastRealClientPos (cached from last C_PLAYER_LOCATION).
                // If neither is available, do not redirect — letting the server's
                // position through is far safer than guessing.
                const realPos = currentMeLoc() || lastRealClientPos;
                if (realPos) {
                    event.loc = cloneLoc(realPos);
                    lastCorrectionAt = Date.now();
                    return true;
                }
            }

            seedForgeLoc(event.loc);
        });
    } catch (_) {}

    mod.hook('C_PLAYER_LOCATION', 5, { order: Infinity, filter: { fake: false } }, (event) => {
        return forgeOutgoingLocation(event) ? true : undefined;
    });
    try {
        mod.hook('C_PLAYER_FLYING_LOCATION', '*', { filter: { fake: false } }, () => {
            flying = true;
        });
    } catch (_) {
        try {
            mod.hook('C_PLAYER_FLYING_LOCATION', 4, { filter: { fake: false } }, () => {
                flying = true;
            });
        } catch (__) {}
    }
    // Fly Forever injects a fake STAT with default walk/run/mount. After you
    // land, rebuild locomotion the same way toggle/remount does so 2.0x
    // returns without dismounting.
    mod.hook('C_PLAYER_LOCATION', 5, { order: 10, filter: { fake: false } }, () => {
        if (!flying) return;
        flying = false;
        if (!cfg.enabled) return;
        restoreSpeedAfterLand();
        if (landSpeedRestoreTimer) {
            try { mod.clearTimeout(landSpeedRestoreTimer); } catch (_) {}
        }
        landSpeedRestoreTimer = mod.setTimeout(() => {
            landSpeedRestoreTimer = null;
            restoreSpeedAfterLand();
        }, 50);
    });
    for (const name of SKILL_START_PACKETS) {
        try {
            mod.hook(name, '*', { order: -20, filter: { fake: false } }, onOutgoingSkill);
        } catch (_) {}
    }

    // ----- the actual speed hooks -----
    // S_USER_MOVETYPE is the primary signal: the server broadcasts your move
    // state and the new speed values whenever they change (login, mount,
    // stance change, etc.). We multiply the speed and forward.
    mod.hook('S_USER_MOVETYPE', '*', { filter: { fake: false } }, (event) => {
        if (!myGameId || !sameId(event.gameId, myGameId)) {
            // Not us — leave it alone (other players don't get sped up).
            return;
        }
        // Cache un-modified values so we can restore on disable.
        lastMoveType = Object.assign({}, event);
        statsFromThisConnection = true;
        diag.lastMovePacketAt = Date.now();
        scheduleSaveRuntimeCache();
        const changed = multiplySpeedFields(event); // per-field multipliers
        return changed ? true : undefined;
    });

    // S_PLAYER_STAT_UPDATE carries your full stat block including walk/run
    // speeds AND your curHp/maxHp. We multiply the speed fields in-place so
    // the client UI shows the boosted speed, and we cache the packet so the
    // replay (on enable/disable) can re-apply speed instantly. We also record
    // the real HP here so the replay can stamp the CURRENT HP onto the cached
    // packet instead of a stale value (that stale value was what snapped the
    // HP bar back to full).
    mod.hook('S_PLAYER_STAT_UPDATE', '*', { filter: { fake: false } }, (event) => {
        // No gameId on this packet — it's implicitly "me", so safe to
        // always multiply. fake:false so a toggle replay cannot overwrite
        // lastStatUpdate / serverRunSpeed with already-boosted values.
        lastStatUpdate = Object.assign({}, event);
        cacheRealRunSpeed(event);
        statsFromThisConnection = true;
        diag.lastStatPacketAt = Date.now();
        if (event.hp !== undefined)    liveHp = event.hp;
        if (event.maxHp !== undefined) liveMaxHp = event.maxHp;
        scheduleSaveRuntimeCache();
        const changed = multiplySpeedFields(event); // per-field speed
        if (locomotionRefreshPending) {
            locomotionRefreshPending = false;
            mod.setTimeout(() => refreshClientLocomotion(), 0);
        }
        return changed ? true : undefined;
    });

    // Fly Forever's fake STAT uses the raw server block (1.0x ground speeds)
    // plus boosted flightSpeedMul. Re-apply walk/run/mount here without
    // caching the fake packet as lastStatUpdate.
    mod.hook('S_PLAYER_STAT_UPDATE', '*', { order: 50, filter: { fake: true } }, (event) => {
        if (applyingStatReplay) return;
        if (!cfg.enabled) return;
        const changed = multiplySpeedFields(event);
        return changed ? true : undefined;
    });

    // Track real HP from incoming damage/heal so the replay never resurrects a
    // stale full-HP value. This packet is the authoritative current HP.
    mod.hook('S_CREATURE_CHANGE_HP', '*', (event) => {
        if (!myGameId || event.target !== myGameId) return;
        if (event.curHp !== undefined) liveHp = event.curHp;
        if (event.maxHp !== undefined) liveMaxHp = event.maxHp;
    });

    // Also subtract damage as soon as a hit lands. S_EACH_SKILL_RESULT arrives
    // slightly BEFORE the S_CREATURE_CHANGE_HP that confirms the new HP, so
    // updating liveHp here closes the tiny race window where a toggle between
    // "hit landed" and "hp packet arrived" could replay a stale (too-high) HP.
    mod.hook('S_EACH_SKILL_RESULT', '*', (event) => {
        if (!myGameId || event.target !== myGameId) return;
        if (liveHp === null) return;
        const dmg = Number(event.value) || 0;
        // type 1 = damage. Anything else (heal/other) we leave to the HP packet.
        if (dmg > 0 && (event.type === undefined || event.type === 1)) {
            const next = (typeof liveHp === 'bigint') ? liveHp - BigInt(dmg) : liveHp - dmg;
            liveHp = next > 0 ? next : (typeof liveHp === 'bigint' ? 0n : 0);
        }
    });

    // Replay the most recent cached server packets and resend them as if the
    // server just updated us. Used on enable / disable / combat-state-change
    // to flip speed instantly without waiting for the next natural broadcast.
    //
    // When `forceMultiplier` is provided, every field is multiplied by it
    // (used to force 1.0x on disable / combat / mod unload). When omitted,
    // per-field overrides apply.
    //
    // HP SAFETY (safer variant): S_PLAYER_STAT_UPDATE carries the full stat
    // block including curHp/maxHp. The packet must stay COMPLETE — deleting
    // fields makes the serializer emit null and the server disconnects. So we
    // keep every field and instead stamp the FRESHEST real HP we've tracked
    // (liveHp/liveMaxHp) onto the copy before sending. liveHp is updated from
    // S_PLAYER_STAT_UPDATE, S_CREATURE_CHANGE_HP and S_EACH_SKILL_RESULT, so
    // it's as current as possible and the bar never repaints a stale value.
    function writeDisconnectReport(reason, extra) {
        const report = {
            at: new Date().toISOString(),
            reason,
            extra: extra || null,
            enabled: cfg.enabled,
            multiplier: cfg.multiplier,
            fieldMultipliers: {
                walk: cfg.fieldMultipliers ? cfg.fieldMultipliers.walkSpeed : null,
                run: cfg.fieldMultipliers ? cfg.fieldMultipliers.runSpeed : null,
                mount: cfg.fieldMultipliers ? cfg.fieldMultipliers.mountSpeed : null,
                swim: cfg.fieldMultipliers ? cfg.fieldMultipliers.swimSpeed : null,
            },
            inCombat,
            safeMode: cfg.safeMode,
            safeActive: safeModeActive(),
            lastForgeType,
            serverRunSpeed,
            mounted,
            forgeStats,
            serverPolicy,
            diag,
        };
        try {
            fs.writeFileSync(
                path.join(__dirname, 'last-disconnect.json'),
                JSON.stringify(report, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
            );
        } catch (_) {}
        if (reason === 'S_EXIT') {
            log(`Game exit/kick (category=${extra && extra.category} code=${extra && extra.code}). Report saved.`);
        }
        // A drop while boosted and unforged is the clearest evidence that this
        // server polices movement. Remember it so the forge is on next time even
        // if the config file is unreachable.
        try {
            if (cfg.enabled && effectiveMultiplier() > 1.0 && !safeModeActive()) {
                markServerChecks(true, `disconnect while unforged (${reason})`);
            }
        } catch (_) {}
    }

    function alreadyInWorld() {
        try {
            const g = mod.game;
            if (!g || !g.me || !g.me.gameId) return false;
            if (g.isInLoadingScreen) return false;
            if (g.isIngame === false) return false;
            return true;
        } catch (_) {
            return false;
        }
    }

    function canReplayStats() {
        if (!lastStatUpdate || lastStatUpdate.runSpeed == null) return false;
        if (statsFromThisConnection) return true;
        // Toolbox reload mid-session: cache is this character and we are
        // already in the world. Injecting at construct / login is still blocked.
        if (!myGameId) grabGameId();
        return !!(myGameId && alreadyInWorld());
    }

    function currentHeading() {
        if (lastLocPacket && lastLocPacket.w != null) return lastLocPacket.w;
        if (lastMoveType && lastMoveType.w != null) return lastMoveType.w;
        try {
            if (mod.game && mod.game.me && mod.game.me.w != null) return mod.game.me.w;
        } catch (_) {}
        return 0;
    }

    function currentMoveType() {
        if (lastMoveType && lastMoveType.type != null) return Number(lastMoveType.type);
        if (lastForgeType != null) return Number(lastForgeType);
        return 7;
    }

    function isMountedNow() {
        if (mounted) return true;
        try {
            if (mod.game && mod.game.me && mod.game.me.mounted) return true;
        } catch (_) {}
        return false;
    }

    function syncMountedFromGame() {
        try {
            const me = mod.game && mod.game.me;
            if (!me) return;
            if (me.mounted) mounted = true;
            if (mounted && !lastMountPacket && myGameId && me.mountId) {
                lastMountPacket = {
                    gameId: myGameId,
                    id: me.mountId,
                    skill: me.mountSkill || 0,
                    unk: false,
                };
            }
        } catch (_) {}
    }

    function sendUserMoveType(type) {
        if (!myGameId) return false;
        const pkt = lastMoveType ? Object.assign({}, lastMoveType) : {};
        pkt.gameId = myGameId;
        pkt.w = currentHeading();
        pkt.type = type;
        try {
            mod.send('S_USER_MOVETYPE', '*', pkt);
            return true;
        } catch (_) {
            try {
                mod.send('S_USER_MOVETYPE', 1, pkt);
                return true;
            } catch (e) {
                diag.lastReplayErr = `MOVETYPE: ${e.message}`;
                log(`replay MOVETYPE failed: ${e.message}`);
                return false;
            }
        }
    }

    function sendMountRefresh() {
        if (!myGameId || !lastMountPacket) return false;
        const pkt = Object.assign({}, lastMountPacket, { gameId: myGameId });
        try {
            mod.send('S_MOUNT_VEHICLE', '*', pkt);
            return true;
        } catch (_) {
            try {
                mod.send('S_MOUNT_VEHICLE', 2, pkt);
                return true;
            } catch (e) {
                diag.lastReplayErr = `MOUNT: ${e.message}`;
                return false;
            }
        }
    }

    // The client stores locomotion separately from the character sheet.
    // Replaying STAT alone updates the number; walk/run stay at the old
    // speed until a move-type change (mount/dismount). Do that refresh here
    // so on/off does not require remounting.
    function refreshClientLocomotion() {
        syncMountedFromGame();
        if (isMountedNow() && sendMountRefresh()) return;
        const type = currentMoveType();
        const alt = type === 0 ? 7 : 0;
        sendUserMoveType(alt);
        sendUserMoveType(type);
    }

    function restoreSpeedAfterLand() {
        if (!cfg.enabled) return;
        if (cfg.autoDisableInCombat && inCombat) return;
        replayCachedMoveAt();
    }

    function sendStatReplay(forceMultiplier) {
        if (!lastStatUpdate || lastStatUpdate.runSpeed == null) return false;
        const pkt = Object.assign({}, lastStatUpdate);
        if (liveHp !== null && pkt.hp !== undefined) pkt.hp = liveHp;
        if (liveMaxHp !== null && pkt.maxHp !== undefined) pkt.maxHp = liveMaxHp;
        multiplySpeedFields(pkt, forceMultiplier);
        applyingStatReplay = true;
        try {
            mod.send('S_PLAYER_STAT_UPDATE', '*', pkt);
            return true;
        } catch (e) {
            diag.lastReplayErr = `STAT: ${e.message}`;
            log(`replay STAT failed: ${e.message}`);
            return false;
        } finally {
            applyingStatReplay = false;
        }
    }

    function scheduleReplayRetry(forceMultiplier) {
        if (replayRetryTimer) return;
        replayRetryTimer = mod.setTimeout(() => {
            replayRetryTimer = null;
            if (!lastStatUpdate || lastStatUpdate.runSpeed == null) return;
            replayCachedMoveAt(forceMultiplier);
        }, 400);
    }

    function replayCachedMoveAt(forceMultiplier) {
        diag.lastReplayAt = Date.now();
        diag.lastReplayErr = null;
        grabGameId();
        syncMountedFromGame();
        if (!canReplayStats()) {
            locomotionRefreshPending = true;
            scheduleReplayRetry(forceMultiplier);
            return;
        }
        // STAT first so locomotion rebuilds from the new speeds, not the old ones.
        sendStatReplay(forceMultiplier);
        refreshClientLocomotion();
        sendStatReplay(forceMultiplier);
        locomotionRefreshPending = false;
    }

    // ----- indicator -----
    function scheduleStartupIndicator() {
        if (!cfg.enabled || !cfg.showIndicator || !myGameId) return;
        // Client may not accept fake abnormalities until shortly after spawn.
        indicatorActive = false;
        mod.setTimeout(() => applyIndicator(true), 800);
    }

    function applyIndicator(on) {
        if (!myGameId) return;
        if (on && !cfg.showIndicator) return;
        if (on === indicatorActive) return;
        const beginVersions = [5, 4, '*'];
        const endVersions   = [1, '*'];
        let lastErr = null;
        const versions = on ? beginVersions : endVersions;
        for (const v of versions) {
            try {
                if (on) {
                    mod.send('S_ABNORMALITY_BEGIN', v, {
                        target: myGameId, source: myGameId,
                        id: cfg.indicatorAbnormalityId,
                        duration: 0x7fffffff, unk: 0, stacks: 1,
                    });
                } else {
                    mod.send('S_ABNORMALITY_END', v, {
                        target: myGameId, id: cfg.indicatorAbnormalityId,
                    });
                }
                indicatorActive = on;
                return;
            } catch (e) { lastErr = e; }
        }
        log(`indicator ${on ? 'BEGIN' : 'END'} failed: ${lastErr ? lastErr.message : 'unknown'}`);
    }

    // ----- enable/disable chokepoint -----
    function setEnabled(on, source) {
        const changed = cfg.enabled !== on;
        cfg.enabled = on;
        if (on && !lastOutLoc) seedForgeLoc(currentMeLoc());
        if (source !== 'login') {
            applyIndicator(on);
            locomotionRefreshPending = true;
            // Replay STAT, then force the same locomotion rebuild that
            // mount/dismount does, so on/off is visible without remounting.
            replayCachedMoveAt(on ? undefined : 1.0);
        }
        broadcastUiState();
        if (source && source.startsWith('hotkey/hold')) return;
        if (changed) log(`${on ? 'ON' : 'OFF'} (${source}) multiplier=${cfg.multiplier}`);
    }

    function applyPreset(name) {
        const presets = cfg.presets || {};
        if (!presets[name]) return false;
        cfg.multiplier = clampMultiplier(presets[name]);
        if (cfg.enabled) replayCachedMoveAt();
        broadcastUiState();
        return true;
    }

    // ----- item-use trigger -----
    mod.hook('C_USE_ITEM', '*', (event) => {
        if (!cfg.triggerItemId) return;
        const id = Number(event.id);
        if (id === Number(cfg.triggerItemId)) {
            setEnabled(!cfg.enabled, `item ${id}`);
        }
    });

    // ----- AHK hotkey integration -----
    function hotkeyRuntimePath()  { return path.join(__dirname, 'ahk', 'hotkey.runtime.ahk'); }
    function hotkeyTemplatePath() { return path.join(__dirname, 'ahk', 'hotkey.template.ahk'); }
    function expandPath(p) { return p.replace(/%([^%]+)%/g, (_, n) => process.env[n] || ''); }

    function sleepSync(ms) {
        const end = Date.now() + ms;
        while (Date.now() < end) { /* wait for AHK to release the runtime script */ }
    }

    function normalizeAhkKey(raw) {
        const k = String(raw || '').trim();
        if (!k) return '';
        const aliases = {
            minus: '-', hyphen: '-', dash: '-',
            add: 'NumpadAdd', plus: 'NumpadAdd', numpadadd: 'NumpadAdd', 'numpad+': 'NumpadAdd',
            numpadsub: 'NumpadSub', 'numpad-': 'NumpadSub',
            mouse4: 'XButton1', m4: 'XButton1', xbutton1: 'XButton1',
            mouse5: 'XButton2', m5: 'XButton2', xbutton2: 'XButton2',
        };
        return aliases[k.toLowerCase()] || k;
    }

    // Keyboard minus (`-`) and numpad minus (NumpadSub) are different keys.
    // If the user set either one, bind both so both keys toggle.
    function expandAhkKeys(raw) {
        const key = normalizeAhkKey(raw);
        if (!key) return [];
        if (key === '-' || key === 'NumpadSub') return ['-', 'NumpadSub'];
        if (key === 'NumpadAdd') return ['NumpadAdd'];
        return [key];
    }

    function ahkBindingBlock(key) {
        const k = String(key).replace(/"/g, '');
        return [
            `$~${k}::`,
            `{`,
            `    stdout.Write("down\`n")`,
            `    stdout.Read(0)`,
            `    while GetKeyState("${k}", "P")`,
            `        Sleep 1`,
            `    stdout.Write("up\`n")`,
            `    stdout.Read(0)`,
            `}`,
            ``,
        ].join('\n');
    }

    function stopAhk() {
        if (!ahkProc) return;
        try { ahkProc.kill(); } catch (_) {}
        ahkProc = null;
        hotkeyHeldOn = false;
    }

    function startAhk() {
        stopAhk();
        if (!cfg.hotkey || !cfg.hotkey.trim()) return;

        let template;
        try { template = fs.readFileSync(hotkeyTemplatePath(), 'utf8'); }
        catch (e) { return log(`hotkey: template missing: ${e.message}`); }

        const keys = expandAhkKeys(cfg.hotkey);
        const rendered = template
            .replace(/{{BINDINGS}}/g, keys.map(ahkBindingBlock).join('\n'))
            .replace(/{{TOOLBOX_PID}}/g, String(process.pid));

        sleepSync(80);
        try { fs.writeFileSync(hotkeyRuntimePath(), rendered); }
        catch (e) { return log(`hotkey: write failed: ${e.message}`); }

        const exe = expandPath(cfg.ahkPath || '');
        if (!exe || !fs.existsSync(exe)) {
            return log(`hotkey: AutoHotkey.exe not found at "${exe}". Install AHK v2 or fix ahkPath.`);
        }

        try {
            ahkProc = spawn(exe, [hotkeyRuntimePath()], {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch (e) { return log(`hotkey: spawn failed: ${e.message}`); }

        ahkProc.stdout.setEncoding('utf8');
        ahkProc.stdout.on('data', (chunk) => {
            for (const raw of String(chunk).split(/\r?\n/)) {
                const line = raw.trim().toLowerCase();
                if (line === 'down') onHotkeyDown();
                else if (line === 'up') onHotkeyUp();
            }
        });
        ahkProc.stderr.setEncoding('utf8');
        ahkProc.stderr.on('data', (chunk) => {
            const msg = String(chunk).trim();
            if (msg) log(`hotkey: AHK ${msg}`);
        });
        ahkProc.on('exit', (code) => {
            if (ahkProc) log(`hotkey: AHK watcher exited (${code})`);
            ahkProc = null;
        });
        ahkProc.on('error', (err) => log(`hotkey: AHK error: ${err.message}`));

        log(`hotkey armed: ${keys.join(' + ')} (${cfg.hotkeyMode})`);
    }

    function onHotkeyDown() {
        const now = Date.now();
        if (now - lastHotkeyAt < 80) return;
        lastHotkeyAt = now;
        if ((cfg.hotkeyMode || 'hold') === 'hold') {
            hotkeyHeldOn = true;
            setEnabled(true, 'hotkey/hold');
        } else {
            setEnabled(!cfg.enabled, 'hotkey/toggle');
        }
    }
    function onHotkeyUp() {
        if ((cfg.hotkeyMode || 'hold') === 'hold' && hotkeyHeldOn) {
            hotkeyHeldOn = false;
            setEnabled(false, 'hotkey/hold');
        }
    }

    // ----- chat commands -----
    mod.command.add('spd', (...args) => {
        const sub = (args[0] || '').toLowerCase();

        if (sub === '') { setEnabled(!cfg.enabled, 'cmd/toggle'); return; }
        if (sub === 's') {
            const fm = cfg.fieldMultipliers || {};
            const fmt = (v) => (v === null || v === undefined) ? '(master)' : v;
            const srv = currentServer();
            log(`enabled=${cfg.enabled} multiplier=${cfg.multiplier} combat=${cfg.autoDisableInCombat} ind=${cfg.showIndicator} item=${cfg.triggerItemId} hotkey=${cfg.hotkey || '(none)'} mode=${cfg.hotkeyMode}`);
            log(`movement: walk=${fmt(fm.walkSpeed)} run=${fmt(fm.runSpeed)} mount=${fmt(fm.mountSpeed)} swim=${fmt(fm.swimSpeed)}`);
            log(`safe=${cfg.safeMode} active=${safeModeActive()} forgeType=${lastForgeType} allow=${forgeStats.lastAllowed} skillGap=${forgeStats.lastSkillGap} maxDxy=${forgeStats.maxDxy} clamped=${forgeStats.clamped}/${forgeStats.packets} server=${srv.name || srv.id || '?'}`);
            if (diag.lastReplayErr) log(`last replay error: ${diag.lastReplayErr}`);
            return;
        }
        if (sub === 'on')  return setEnabled(true,  'cmd');
        if (sub === 'off') return setEnabled(false, 'cmd');

        if (sub === 'mult') {
            const v = parseFloat(args[1]);
            if (isNaN(v) || v < MIN_MULTIPLIER || v > MAX_MULTIPLIER) {
                return log(`usage: spd mult <${MIN_MULTIPLIER}..${MAX_MULTIPLIER}>`);
            }
            cfg.multiplier = v;
            if (cfg.enabled) replayCachedMoveAt();
            broadcastUiState();
            return log(`multiplier=${v}`);
        }

        // Per-field overrides: walk, run, mount, swim. Use "off" to clear.
        // Examples: spd walk 1.5 | spd run 4 | spd mount off
        if (sub === 'walk' || sub === 'run' || sub === 'mount' || sub === 'swim') {
            const fieldKey = sub + 'Speed';
            cfg.fieldMultipliers = cfg.fieldMultipliers || {};
            const arg = (args[1] || '').toLowerCase();
            if (arg === 'off' || arg === 'null' || arg === '') {
                cfg.fieldMultipliers[fieldKey] = null;
                if (cfg.enabled) replayCachedMoveAt();
                return log(`${fieldKey}=null (uses master multiplier ${cfg.multiplier})`);
            }
            const v = parseFloat(arg);
            if (isNaN(v) || v < MIN_MULTIPLIER || v > MAX_MULTIPLIER) {
                return log(`usage: spd ${sub} <${MIN_MULTIPLIER}..${MAX_MULTIPLIER}|off>`);
            }
            cfg.fieldMultipliers[fieldKey] = v;
            if (cfg.enabled) replayCachedMoveAt();
            return log(`${fieldKey}=${v}`);
        }

        if (sub === 'preset') {
            const name = (args[1] || '').toLowerCase();
            if (!name) {
                const presets = cfg.presets || {};
                log(`presets: ${Object.entries(presets).map(([k, v]) => `${k}=${v}x`).join(', ') || '(none)'}`);
                return;
            }
            if (!applyPreset(name)) {
                return log(`unknown preset "${name}". try: ${Object.keys(cfg.presets || {}).join(' | ')}`);
            }
            return log(`preset=${name} multiplier=${cfg.multiplier}`);
        }

        if (sub === 'combat') {
            cfg.autoDisableInCombat = !cfg.autoDisableInCombat;
            return log(`autoDisableInCombat=${cfg.autoDisableInCombat}`);
        }

        if (sub === 'ind') {
            const arg = args[1];
            if (arg !== undefined) {
                const id = parseInt(arg, 10);
                if (isNaN(id) || id <= 0) return log('usage: spd ind <abnormality id>');
                cfg.indicatorAbnormalityId = id;
                if (cfg.enabled && cfg.showIndicator) {
                    indicatorActive = false;
                    applyIndicator(true);
                }
                return log(`indicatorAbnormalityId=${id}`);
            }
            cfg.showIndicator = !cfg.showIndicator;
            applyIndicator(cfg.enabled && cfg.showIndicator);
            return log(`showIndicator=${cfg.showIndicator}`);
        }

        if (sub === 'item') {
            const id = parseInt(args[1], 10);
            if (isNaN(id) || id < 0 || id > 999999) return log('usage: spd item <0..999999>');
            cfg.triggerItemId = id;
            return log(`triggerItemId=${id}${id === 0 ? ' (disabled)' : ''}`);
        }

        if (sub === 'hotkey') {
            const key = (args[1] || '').trim();
            cfg.hotkey = key;
            startAhk();
            return log(key ? `hotkey="${key}" (re-armed)` : 'hotkey cleared');
        }
        if (sub === 'hotkeymode') {
            const m = (args[1] || '').toLowerCase();
            if (m !== 'toggle' && m !== 'hold') return log('usage: spd hotkeymode toggle|hold');
            cfg.hotkeyMode = m;
            return log(`hotkeyMode=${m}`);
        }
        if (sub === 'safe') {
            const arg = (args[1] || '').toLowerCase();
            if (!arg) {
                const srv = currentServer();
                return log(`safe=${cfg.safeMode} active=${safeModeActive()} via=${serverPolicy.source} forgeType=${lastForgeType} server=${srv.name || srv.id || '?'}`);
            }
            if (arg === 'auto' || arg === 'on' || arg === 'off') {
                cfg.safeMode = arg;
                refreshServerPolicy();
                return log(`safeMode=${arg} active=${safeModeActive()} (${serverPolicy.source})`);
            }
            if (arg === 'srvcfg' || arg === 'config') {
                srvCfgCache = null;      // force a fresh parse
                srvCfgPathCache = null;  // force a fresh discovery
                const host = serverHost() || '?';
                log(`server host=${host} (${serverIsLocal() ? 'local' : 'remote'}) key=${serverKey()}`);
                const c = readServerConfig();
                if (c) {
                    log(`config: ${c.path}`);
                    log(`SpeedHack=${c.speedHackOn ? 'ON' : 'off'} SpeedHackAlt=${c.speedHackAltOn ? 'ON' : 'off'} avgSpeed=${c.disconnAvgSpeed || '?'} gap=${c.gapClientServer || '?'}`);
                } else {
                    log('config: not reachable');
                    if (!serverIsLocal()) log(`tried shares on \\\\${host}\\ — add serverConfigPaths/"serverConfigShares" if it lives elsewhere`);
                }
                const decl = declaredServer();
                log(`declared: ${decl ? (decl.checks ? 'checks movement' : 'does not check movement') : 'no'}`);
                const prof = serverProfile();
                const learned = prof.checks === null
                    ? `unknown (clean ${Math.round((prof.cleanBoostedMs || 0) / 1000)}s / ${PROFILE_CLEAN_MS / 1000}s)`
                    : (prof.checks ? 'checks movement' : 'does not check movement');
                log(`learned: ${learned}`);
                refreshServerPolicy();
                return log(`=> forge ${safeModeActive() ? 'ON' : 'OFF'} via ${serverPolicy.source} (safeMode=${cfg.safeMode})`);
            }
            if (arg === 'declare') {
                const host = serverHost();
                if (!host) return log('declare: no server address yet — run this while connected');
                const v = (args[2] || '').toLowerCase();
                if (v !== 'on' && v !== 'off' && v !== 'clear') {
                    return log('usage: spd safe declare on|off|clear   (on = this server checks movement)');
                }
                cfg.knownServers = (cfg.knownServers && typeof cfg.knownServers === 'object') ? cfg.knownServers : {};
                if (v === 'clear') {
                    delete cfg.knownServers[host];
                    log(`declaration removed for ${host}`);
                } else {
                    const srv = currentServer();
                    cfg.knownServers[host] = { checks: v === 'on', label: srv.name || String(srv.id || '') };
                    log(`declared ${host} as ${v === 'on' ? 'checking movement (forge on)' : 'not checking movement (forge off)'}`);
                }
                try { if (typeof mod.saveSettings === 'function') mod.saveSettings(); } catch (_) {}
                refreshServerPolicy();
                return log(`=> forge ${safeModeActive() ? 'ON' : 'OFF'} via ${serverPolicy.source}`);
            }
            if (arg === 'forget') {
                const all = loadProfiles();
                delete all[serverKey()];
                saveProfiles();
                refreshServerPolicy();
                return log(`learned profile cleared for ${serverKey()}`);
            }
            return log('usage: spd safe [auto|on|off|srvcfg|declare on|off|clear|forget]');
        }
        if (sub === 'reloadhk') { startAhk(); return; }
        if (sub === 'ui')       { openUi(); return; }
        if (sub === 'reset') {
            applyFactorySettings();
            stopAhk();
            broadcastUiState();
            return log('Settings reset to first-install defaults.');
        }

        if (sub === 'reload') {
            // Re-read config.json from disk without restarting the toolbox.
            try {
                const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
                const parsed = JSON.parse(raw);
                const next = (parsed && parsed.data) ? parsed.data : parsed;
                if (!next || typeof next !== 'object') return log('reload: config.json missing "data" object');
                for (const k of Object.keys(cfg)) delete cfg[k];
                Object.assign(cfg, next);
                if (uiWindow && !uiWindow.isDestroyed()) {
                    uiWindow.webContents.send('spd-config', JSON.parse(JSON.stringify(cfg)));
                }
                if (cfg.enabled) replayCachedMoveAt();
                log(`reload: config.json reloaded (multiplier=${cfg.multiplier})`);
            } catch (e) {
                log(`reload failed: ${e.message}`);
            }
            return;
        }

        log('cmds: spd | s | on | off | mult <n> | walk|run|mount|swim <n|off> | preset <name> | combat | ind [id] | item <id> | hotkey <k> | hotkeymode toggle|hold | safe [auto|on|off] | reloadhk | ui | reload');
    });

    // ===== GUI window =====
    function registerUiHotkey() {
        if (!electronMod || !electronMod.globalShortcut) return;
        try {
            if (electronMod.globalShortcut.isRegistered('Control+Shift+S'))
                electronMod.globalShortcut.unregister('Control+Shift+S');
            uiHotkeyRegistered = electronMod.globalShortcut.register('Control+Shift+S', toggleUi);
        } catch (e) {
            log(`UI hotkey: ${e.message}`);
        }
    }

    function unregisterUiHotkey() {
        if (!electronMod || !electronMod.globalShortcut || !uiHotkeyRegistered) return;
        try { electronMod.globalShortcut.unregister('Control+Shift+S'); } catch (_) {}
        uiHotkeyRegistered = false;
    }

    const UI_MIN_W = 400;
    const UI_MIN_H = 480;
    const UI_DEFAULT_W = 540;
    const UI_DEFAULT_H = 920;

    function persistUiGeometry() {
        if (!uiGeometryReady) return;
        if (!uiWindow || uiWindow.isDestroyed()) return;
        const bounds = uiWindow.getBounds();
        if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return;
        cfg.uiX = bounds.x;
        cfg.uiY = bounds.y;
        if (bounds.width >= UI_MIN_W && bounds.height >= UI_MIN_H) {
            cfg.uiWidth = bounds.width;
            cfg.uiHeight = bounds.height;
        }
        try { if (typeof mod.saveSettings === 'function') mod.saveSettings(); } catch (_) {}
    }

    function schedulePersistUiGeometry() {
        if (!uiGeometryReady) return;
        if (uiSaveTimer) {
            try { mod.clearTimeout(uiSaveTimer); } catch (_) {}
        }
        uiSaveTimer = mod.setTimeout(() => {
            uiSaveTimer = null;
            persistUiGeometry();
        }, 250);
    }

    function savedUiBounds() {
        const bounds = {
            width: Math.max(UI_MIN_W, Number(cfg.uiWidth) || UI_DEFAULT_W),
            height: Math.max(UI_MIN_H, Number(cfg.uiHeight) || UI_DEFAULT_H),
        };
        if (Number.isFinite(cfg.uiX) && Number.isFinite(cfg.uiY)) {
            bounds.x = Math.round(cfg.uiX);
            bounds.y = Math.round(cfg.uiY);
        }
        return bounds;
    }

    function applySavedUiBounds(win) {
        if (!win || win.isDestroyed()) return;
        let bounds = savedUiBounds();
        const screen = electronMod && electronMod.screen;
        if (screen && bounds.x !== undefined) {
            const onScreen = screen.getAllDisplays().some((display) => {
                const area = display.workArea;
                return bounds.x < area.x + area.width - 80
                    && bounds.y < area.y + area.height - 80
                    && bounds.x + bounds.width > area.x + 80
                    && bounds.y + bounds.height > area.y + 80;
            });
            if (!onScreen) {
                bounds = { width: bounds.width, height: bounds.height };
            }
        }
        try { win.setBounds(bounds); } catch (_) {}
    }

    function toggleUi() {
        if (uiWindow && !uiWindow.isDestroyed()) closeUi();
        else openUi();
    }

    function openUi() {
        if (!electronMod || !electronMod.BrowserWindow) {
            log('UI: electron unavailable in this toolbox build');
            return;
        }
        if (uiWindow && !uiWindow.isDestroyed()) { uiWindow.focus(); return; }

        const { BrowserWindow, ipcMain } = electronMod;
        uiGeometryReady = false;
        const saved = savedUiBounds();
        const winOpts = {
            width: saved.width,
            height: saved.height,
            minWidth: UI_MIN_W,
            minHeight: UI_MIN_H,
            resizable: true,
            maximizable: true,
            thickFrame: true,
            show: false,
            alwaysOnTop: true,
            skipTaskbar: false,
            title: 'Speedhack',
            backgroundColor: '#1b1d22',
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                sandbox: false,
            },
        };
        if (saved.x !== undefined) {
            winOpts.x = saved.x;
            winOpts.y = saved.y;
        }
        uiWindow = new BrowserWindow(winOpts);
        try {
            uiWindow.setResizable(true);
            uiWindow.setMaximizable(true);
            uiWindow.setMinimumSize(UI_MIN_W, UI_MIN_H);
        } catch (_) {}
        applySavedUiBounds(uiWindow);
        uiWindow.removeMenu();
        uiWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
        uiWindow.once('ready-to-show', () => {
            applySavedUiBounds(uiWindow);
            uiWindow.show();
            uiGeometryReady = true;
        });

        const onRequest = () => {
            if (uiWindow && !uiWindow.isDestroyed()) {
                uiWindow.webContents.send('spd-config', JSON.parse(JSON.stringify(cfg)));
                broadcastUiState();
            }
        };
        const onSave = (_evt, incoming) => {
            if (!incoming || typeof incoming !== 'object') return;
            const knownKeys = [
                'enabled', 'multiplier', 'autoDisableInCombat',
                'showIndicator', 'indicatorAbnormalityId', 'triggerItemId',
                'hotkey', 'hotkeyMode', 'ahkPath', 'safeMode',
            ];
            for (const k of knownKeys) {
                if (incoming[k] !== undefined && incoming[k] !== cfg[k]) cfg[k] = incoming[k];
            }
            if (incoming.presets && typeof incoming.presets === 'object') {
                cfg.presets = Object.assign({}, cfg.presets || {}, incoming.presets);
            }
            if (incoming.fieldMultipliers && typeof incoming.fieldMultipliers === 'object') {
                cfg.fieldMultipliers = Object.assign({}, cfg.fieldMultipliers || {}, incoming.fieldMultipliers);
                if (cfg.enabled) replayCachedMoveAt();
            }
            try { if (typeof mod.saveSettings === 'function') mod.saveSettings(); } catch (_) {}
            if (incoming.safeMode !== undefined) broadcastUiState();
            if (incoming.hotkey !== undefined || incoming.hotkeyMode !== undefined || incoming.ahkPath !== undefined) {
                startAhk();
            }
        };
        const onToggle = (_evt, on) => setEnabled(!!on, 'ui');
        const onReloadHk = () => startAhk();
        const onPreset = (_evt, name) => {
            if (typeof name !== 'string') return;
            applyPreset(name);
        };
        const onMult = (_evt, v) => {
            const n = clampMultiplier(v);
            cfg.multiplier = n;
            if (cfg.enabled) replayCachedMoveAt();
            broadcastUiState();
        };

        ipcMain.on('spd-request-config', onRequest);
        ipcMain.on('spd-save',            onSave);
        ipcMain.on('spd-toggle',          onToggle);
        ipcMain.on('spd-reloadhk',        onReloadHk);
        ipcMain.on('spd-preset',          onPreset);
        ipcMain.on('spd-mult',            onMult);

        uiWindow.on('move', schedulePersistUiGeometry);
        uiWindow.on('moved', schedulePersistUiGeometry);
        uiWindow.on('resize', schedulePersistUiGeometry);
        uiWindow.on('close', () => persistUiGeometry());
        uiWindow.on('closed', () => {
            if (uiSaveTimer) {
                try { mod.clearTimeout(uiSaveTimer); } catch (_) {}
                uiSaveTimer = null;
            }
            uiGeometryReady = false;
            ipcMain.removeListener('spd-request-config', onRequest);
            ipcMain.removeListener('spd-save',            onSave);
            ipcMain.removeListener('spd-toggle',          onToggle);
            ipcMain.removeListener('spd-reloadhk',        onReloadHk);
            ipcMain.removeListener('spd-preset',          onPreset);
            ipcMain.removeListener('spd-mult',            onMult);
            uiWindow = null;
        });
    }

    function closeUi() {
        if (uiWindow && !uiWindow.isDestroyed()) {
            persistUiGeometry();
            try { uiWindow.close(); } catch (_) {}
        }
        uiWindow = null;
    }

    function broadcastUiState() {
        if (!uiWindow || uiWindow.isDestroyed()) return;
        try {
            uiWindow.webContents.send('spd-state', {
                enabled: cfg.enabled,
                multiplier: cfg.multiplier,
                safeMode: cfg.safeMode,
                server: guiServerInfo(),
            });
        } catch (_) {}
    }

    // ===== boot =====
    refreshServerPolicy();
    // Accrue "clean" time only while actually boosted with the forge off, so a
    // server can earn a "does not check movement" verdict on its own.
    const CLEAN_TICK_MS = 15000;
    const cleanTimer = mod.setInterval(() => {
        try {
            if (cfg.safeMode !== 'auto') return;
            if (!cfg.enabled || effectiveMultiplier() <= 1.0) return;
            if (safeModeActive()) return;          // forged: proves nothing
            if (!alreadyInWorld()) return;
            creditCleanTime(CLEAN_TICK_MS);
        } catch (_) {}
    }, CLEAN_TICK_MS);

    if (cfg.hotkey && cfg.hotkey.trim()) startAhk();
    registerUiHotkey();
    grabGameId();
    loadRuntimeCache();
    syncMountedFromGame();
    // Do not inject cached stat/move packets or fake buffs at construct time
    // during login — a stale STAT_UPDATE drops the client. Mid-session reload
    // is safe: we are already in the world with this character's cache.
    if (alreadyInWorld() && lastStatUpdate && lastStatUpdate.runSpeed != null) {
        statsFromThisConnection = true;
        if (cfg.enabled) {
            mod.setTimeout(() => {
                if (!cfg.enabled) return;
                replayCachedMoveAt();
                applyIndicator(true);
            }, 150);
        }
    }

    this.destructor = () => {
        if (cleanTimer) { try { mod.clearInterval(cleanTimer); } catch (_) {} }
        if (landSpeedRestoreTimer) {
            try { mod.clearTimeout(landSpeedRestoreTimer); } catch (_) {}
            landSpeedRestoreTimer = null;
        }
        if (replayRetryTimer) {
            try { mod.clearTimeout(replayRetryTimer); } catch (_) {}
            replayRetryTimer = null;
        }
        saveRuntimeCache();
        resetForgeState();
        try { if (statsFromThisConnection) applyIndicator(false); } catch (_) {}
        try { replayCachedMoveAt(1.0); } catch (_) {}
        stopAhk();
        unregisterUiHotkey();
        closeUi();
        mod.command.remove('spd');
    };
};
