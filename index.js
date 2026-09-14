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
 * authoritative — no rubber-banding. Positions are sent as-is.
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
 *   - Auto-detects the live server (name / id / IP from the Toolbox connection)
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
 *   spd flytest on|off        → flying-loc mode (same as the GUI tick)
 *   spd flytest type <n|auto> → flying packet type (7=descend)
 *   spd loctype <0..8|off>    → rewrite run/walk C_PLAYER_LOCATION type
 *   spd jumptype <0..8|off|hide> → jump packets only (hide = floor as type 2)
 *   spd rl | reload           → reload this module (picks up index.js / GUI edits)
 *   spd reloadcfg             → re-read config.json only (does not load new code)
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let electronMod = null;
try { electronMod = require('electron'); } catch (_) { /* unavailable in headless toolbox */ }

const MAX_MULTIPLIER = 10.0;
const MIN_MULTIPLIER = 1.0;
const INT16_MAX = 32767;

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
    let lastLocPacket = null;
    let mounted = false;
    let lastMountPacket = null;
    let flying = false;
    let injectingFlyLoc = false;
    let lastGroundZ = null;
    let lastClientFlyType = null;
    let lastRewrittenFlyType = null;
    let lastClientLocType = null;
    let lastRewrittenLocType = null;
    let lastLocMounted = null;
    let lastLocTypeLogAt = 0;
    let lastFlyTypeLogAt = 0;
    let lastSentFlyLoc = null;
    let lastSentFlyTime = null;
    let cruiseFlySpeed = 0;
    let plantingGround = false;
    let landSpeedRestoreTimer = null;
    let applyingStatReplay = false;
    let replayRetryTimer = null;
    let replayRetryForce = undefined;
    let lastDisconnectReport = null;
    let locomotionRefreshPending = false;
    let ahkStartTimer = null;
    let ahkStartGen = 0;
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
        'server-profiles.json',
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

    function stripRemovedSettings() {
        delete cfg.rampMs;
        delete cfg.safeMode;
        delete cfg.useServerConfig;
        delete cfg.serverConfigPath;
        delete cfg.serverConfigPaths;
        delete cfg.serverConfigSearchRoots;
        delete cfg.serverConfigShares;
        delete cfg.knownServers;
        delete cfg.forgeBurstMs;
        delete cfg.forgeQuietMs;
        delete cfg.safeScoreLimit;
        delete cfg.safeCooldownMs;
        if (cfg.fieldMultipliers && typeof cfg.fieldMultipliers === 'object') {
            delete cfg.fieldMultipliers.gatherSpeed;
        }
    }

    try {
        if (fs.existsSync(FACTORY_RESET_FLAG)) {
            applyFactorySettings();
            try { fs.unlinkSync(FACTORY_RESET_FLAG); } catch (_) {}
        }
    } catch (_) {}
    stripRemovedSettings();
    if (cfg.hotkey == null) cfg.hotkey = '-';
    else cfg.hotkey = String(cfg.hotkey);
    function currentFlyMode() {
        const m = Number(cfg.flyLocMode);
        if (m === 1 || m === 2 || m === 3 || m === 4) return m;
        if (!cfg.flyLocInject) return 0;
        if (cfg.flyLocFoot7) return 4;
        if (cfg.flyLocFoot3) return 3;
        if (cfg.flyLocFoot8) return 2;
        return 1;
    }
    function syncFlyLocTypeLabel() {
        const m = currentFlyMode();
        cfg.flyLocType = m === 2 ? 8 : (m === 3 ? 3 : (m === 4 ? 7 : 1));
    }
    function setFlyMode(mode) {
        const m = (mode === 1 || mode === 2 || mode === 3 || mode === 4) ? mode : 0;
        cfg.flyLocMode = m;
        cfg.flyLocInject = m !== 0;
        cfg.flyLocFoot8 = m === 2;
        cfg.flyLocFoot3 = m === 3;
        cfg.flyLocFoot7 = m === 4;
        syncFlyLocTypeLabel();
        if (m !== 0) cfg.groundLocType = -1;
    }
    function currentGroundLocType() {
        const n = Number(cfg.groundLocType);
        if (!Number.isFinite(n) || n < 0 || n > 8) return -1;
        return n;
    }
    function groundLocTypeName(n) {
        const names = {
            0: 'run', 1: 'walk', 2: 'fall', 3: 'type3', 4: 'type4',
            5: 'jump', 6: 'type6', 7: 'stop', 8: 'type8',
        };
        return names[n] || String(n);
    }
    function setGroundLocType(type) {
        const n = Number(type);
        const v = (Number.isFinite(n) && n >= 0 && n <= 8) ? n : -1;
        cfg.groundLocType = v;
        if (v >= 0) {
            cfg.flyLocMode = 0;
            cfg.flyLocInject = false;
            cfg.flyLocFoot8 = false;
            cfg.flyLocFoot3 = false;
            cfg.flyLocFoot7 = false;
            syncFlyLocTypeLabel();
        }
    }
    function currentJumpLocType() {
        const n = Number(cfg.jumpLocType);
        if (n === -2) return -2;
        if (!Number.isFinite(n) || n < 0 || n > 8) return -1;
        return n;
    }
    function jumpLocTypeLabel(n) {
        if (n === -2) return 'hide';
        if (n < 0) return 'real';
        return `${n} (${groundLocTypeName(n)})`;
    }
    function setJumpLocType(type) {
        if (type === 'hide' || type === -2 || type === '-2') {
            cfg.jumpLocType = -2;
            return;
        }
        const n = Number(type);
        cfg.jumpLocType = (Number.isFinite(n) && n >= 0 && n <= 8) ? n : -1;
    }
    // Fly modes stay off on boot. Run/walk stay type 2.
    setFlyMode(0);
    setGroundLocType(2);
    if (cfg.jumpLocType == null) cfg.jumpLocType = -2;

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

    function serverHost() {
        try {
            if (mod.serverIp) return String(mod.serverIp).replace(/^::ffff:/, '').split('%')[0];
        } catch (_) {}
        return null;
    }

    function serverListMap() {
        try {
            return mod.serverList
                || (mod.connection && mod.connection.metadata && mod.connection.metadata.serverList)
                || {};
        } catch (_) {
            return {};
        }
    }

    function listEntry(list, id) {
        if (id == null || id === '' || !list) return null;
        if (list[id]) return list[id];
        const asStr = String(id);
        if (list[asStr]) return list[asStr];
        const asNum = Number(id);
        if (Number.isFinite(asNum) && list[asNum]) return list[asNum];
        return null;
    }

    function classifyServer(id, name, host) {
        const n = String(name || '');
        if (Number(id) === 500 || /asura/i.test(n)) return 'asura';
        if (/agaia|agais/i.test(n)) return 'agaia';
        if (id != null && id !== '') return 'private';
        if (host) return 'private';
        return 'unknown';
    }

    function currentServer() {
        let id = null;
        let name = '';
        const host = serverHost();
        try {
            if (mod.serverId != null && mod.serverId !== '') id = mod.serverId;
        } catch (_) {}
        try {
            if ((id == null || id === '') && mod.game && mod.game.me && mod.game.me.serverId != null)
                id = mod.game.me.serverId;
        } catch (_) {}

        const list = serverListMap();
        try {
            const entry = listEntry(list, id);
            if (entry) name = String(entry.name || entry.serverName || '');
            if (!name && host) {
                for (const [sid, e] of Object.entries(list)) {
                    if (!e) continue;
                    const eip = String(e.ip || e.address || e.host || '').replace(/^::ffff:/, '');
                    if (eip && eip === host) {
                        if (id == null || id === '') id = sid;
                        name = String(e.name || e.serverName || '');
                        break;
                    }
                }
            }
        } catch (_) {}

        const kind = classifyServer(id, name, host);
        const idNum = (id == null || id === '') ? null : Number(id);
        const label = name
            || (kind === 'asura' ? 'Asura' : kind === 'agaia' ? 'Agaia' : null)
            || (idNum != null && Number.isFinite(idNum) ? `Server ${idNum}` : '')
            || (host ? host : '');
        return {
            id: (idNum != null && Number.isFinite(idNum)) ? idNum : (id == null || id === '' ? null : id),
            name,
            host,
            kind,
            label,
        };
    }

    function guiServerInfo() {
        const s = currentServer();
        const loggedIn = s.kind !== 'unknown' || s.host != null;
        const name = s.label
            ? (s.id != null ? `${s.label} (${s.id})` : s.label)
            : 'Not logged in';
        return {
            name,
            label: s.label || 'Not logged in',
            id: s.id,
            host: s.host,
            kind: loggedIn ? s.kind : 'unknown',
        };
    }

    let lastAnnouncedServer = '';
    function announceCurrentServer() {
        const s = currentServer();
        const key = `${s.host || '?'}|${s.id != null ? s.id : '?'}|${s.kind}|${s.label}`;
        if (key === lastAnnouncedServer) {
            broadcastUiState();
            return s;
        }
        lastAnnouncedServer = key;
        if (s.kind !== 'unknown' || s.host) {
            const where = s.host ? ` @${s.host}` : '';
            const idBit = s.id != null ? ` id=${s.id}` : '';
            log(`playing ${s.label || s.kind}${idBit}${where}`);
        }
        broadcastUiState();
        return s;
    }

    // ----- identity / combat tracking -----
    mod.hook('S_LOGIN', '*', (event) => {
        myGameId = event.gameId;
        inCombat = false;
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
        replayRetryForce = undefined;
        lastDisconnectReport = null;
        // Stale packets from the last Toolbox session must not be injected
        // during login — that can crash the client or drop the connection.
        lastMoveType = null;
        lastStatUpdate = null;
        lastLocPacket = null;
        lastGroundZ = null;
        lastClientFlyType = null;
        lastRewrittenFlyType = null;
        lastClientLocType = null;
        lastRewrittenLocType = null;
        lastLocMounted = null;
        lastSentFlyLoc = null;
        lastSentFlyTime = null;
        cruiseFlySpeed = 0;
        liveHp = null;
        liveMaxHp = null;
        statsFromThisConnection = false;
        // Always start speedhack off when you enter a character. Turn it on with - / spd.
        // Keep the ground loc type (current test: 2 fall). Only fly modes reset.
        if (cfg.enabled) setEnabled(false, 'login');
        setFlyMode(0);
        try { if (typeof mod.saveSettings === 'function') mod.saveSettings(); } catch (_) {}
        broadcastUiState();
        log(currentGroundLocType() < 0
            ? 'loctype=off'
            : `loctype=${currentGroundLocType()} (${groundLocTypeName(currentGroundLocType())}) jumptype=${jumpLocTypeLabel(currentJumpLocType())}`);
        mod.setTimeout(() => announceCurrentServer(), 0);
    });

    mod.hook('S_SPAWN_ME', '*', (event) => {
        if (event.gameId) myGameId = event.gameId;
        scheduleStartupIndicator();
        announceCurrentServer();
    });
    try {
        mod.hook('S_GET_USER_LIST', '*', () => {
            mod.setTimeout(() => announceCurrentServer(), 0);
        });
    } catch (_) {}

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
            applyIndicator(false);
            broadcastUiState();
        } else if (cfg.autoDisableInCombat && !inCombat && wasCombat && cfg.enabled) {
            log('combat ended — multiplier resumed');
            replayCachedMoveAt(); // resume per-field
            applyIndicator(true);
            broadcastUiState();
        }
    });

    try {
        mod.hook('S_EXIT', '*', (event) => {
            diag.lastExit = { category: event.category, code: event.code };
            log(`S_EXIT category=${event.category} code=${event.code}`);
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

    function headingVec(w) {
        const a = Number(w);
        if (!Number.isFinite(a)) return { x: 1, y: 0, z: 0 };
        return { x: Math.cos(a), y: Math.sin(a), z: 0 };
    }

    function destDir(loc, dest, fallback) {
        if (!loc || !dest) return fallback;
        const dx = dest.x - loc.x;
        const dy = dest.y - loc.y;
        const dz = dest.z - loc.z;
        const len = Math.hypot(dx, dy, dz);
        if (len < 1e-3) return fallback;
        return { x: dx / len, y: dy / len, z: dz / len };
    }

    function vec3(x, y, z) {
        return { x, y, z };
    }

    function copyVec(v) {
        if (!v) return null;
        return { x: Number(v.x), y: Number(v.y), z: Number(v.z) };
    }

    function dist3(a, b) {
        if (!a || !b) return 0;
        return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    }

    function moveToward(from, to, maxDist) {
        if (!to) return copyVec(from);
        if (!from) return copyVec(to);
        const d = dist3(from, to);
        if (d <= maxDist || d < 1e-4) return copyVec(to);
        const t = maxDist / d;
        return vec3(
            from.x + (to.x - from.x) * t,
            from.y + (to.y - from.y) * t,
            from.z + (to.z - from.z) * t
        );
    }

    function flyStepMs(time) {
        const t = Number(time);
        if (!Number.isFinite(t) || lastSentFlyTime == null) return 50;
        const dt = t - lastSentFlyTime;
        if (dt <= 0 || dt > 2000) return 50;
        return Math.max(16, Math.min(dt, 250));
    }

    function rememberSentFly(event) {
        if (event && event.loc) lastSentFlyLoc = copyVec(event.loc);
        if (event && event.time != null) lastSentFlyTime = Number(event.time);
    }

    function learnCruiseFromMove(loc, time) {
        if (!loc || !lastSentFlyLoc) return;
        const dt = flyStepMs(time);
        const spd = dist3(lastSentFlyLoc, loc) / (dt / 1000);
        if (spd > 80 && spd < 2000) {
            cruiseFlySpeed = cruiseFlySpeed > 0
                ? (cruiseFlySpeed * 0.65 + spd * 0.35)
                : spd;
        }
    }

    // Shorten loc/dest so the server never sees a faster step than cruise.
    // force: cap at cruise (mount / boost). Otherwise allow a 1.25x burst.
    function capPacketIfTooFast(packet, force) {
        if (!packet || !packet.loc || !lastSentFlyLoc) return false;
        const dt = flyStepMs(packet.time);
        const cap = cruiseFlySpeed > 80 ? cruiseFlySpeed : 400;
        const maxDist = cap * (dt / 1000);
        const step = dist3(lastSentFlyLoc, packet.loc);
        const over = force ? step > maxDist : step > maxDist * 1.25;
        if (!over || step <= maxDist) return false;
        const origDest = packet.dest ? copyVec(packet.dest) : copyVec(packet.loc);
        const newLoc = moveToward(lastSentFlyLoc, packet.loc, maxDist);
        const dir = destDir(packet.loc, origDest, destDir(lastSentFlyLoc, packet.loc, { x: 1, y: 0, z: 0 }));
        packet.loc = newLoc;
        packet.dest = vec3(
            newLoc.x + dir.x * maxDist,
            newLoc.y + dir.y * maxDist,
            newLoc.z + dir.z * maxDist
        );
        return true;
    }

    function rememberGroundZ(loc) {
        if (!loc) return;
        const z = Number(loc.z);
        if (Number.isFinite(z)) lastGroundZ = z;
    }

    function isAirborneLoc(event) {
        if (lastGroundZ == null || !event) return false;
        const locZ = event.loc ? Number(event.loc.z) : NaN;
        const destZ = event.dest ? Number(event.dest.z) : NaN;
        const slack = 15;
        return (Number.isFinite(locZ) && locZ > lastGroundZ + slack)
            || (Number.isFinite(destZ) && destZ > lastGroundZ + slack);
    }

    function flattenJumpToGround(event) {
        if (!event) return false;
        let changed = false;
        if (event.jumpDistance) {
            event.jumpDistance = 0;
            changed = true;
        }
        if (lastGroundZ == null) return changed;
        if (event.loc && Number(event.loc.z) !== lastGroundZ) {
            event.loc = vec3(event.loc.x, event.loc.y, lastGroundZ);
            changed = true;
        }
        if (event.dest && Number(event.dest.z) !== lastGroundZ) {
            event.dest = vec3(event.dest.x, event.dest.y, lastGroundZ);
            changed = true;
        }
        return changed;
    }

    // Mode 1 foot 1, Mode 2 foot 8, Mode 3 foot 3, Mode 4 foot 7.
    // Mount + real fly: type 7.
    function groundFlyType() {
        if (mounted) return 7;
        const m = currentFlyMode();
        if (m === 2) return 8;
        if (m === 3) return 3;
        if (m === 4) return 7;
        return 1;
    }

    function flatGroundFlyPacket(loc, dest, time, w) {
        const z = Number(loc.z);
        const look = headingVec(w);
        const destFlat = dest
            ? vec3(dest.x, dest.y, z)
            : vec3(loc.x, loc.y, z);
        return {
            type: groundFlyType(),
            loc: vec3(loc.x, loc.y, z),
            dest: destFlat,
            time: time || 0,
            control: look,
            direction: destDir(vec3(loc.x, loc.y, z), destFlat, look),
        };
    }

    function sendGroundHover(loc, dest, time, w) {
        if (!loc) return false;
        rememberGroundZ(loc);
        const packet = flatGroundFlyPacket(loc, dest, time, w);
        // Foot 3.0x type 7 already stays connected. A 3.0x mount is much
        // faster; those injected type-7 steps still trip the 10s average.
        // Learn cruise on foot, cap only while mounted (same as air boost).
        if (!mounted) learnCruiseFromMove(packet.loc, packet.time);
        else capPacketIfTooFast(packet, true);
        rememberSentFly(packet);
        return sendFlyingLocation(packet);
    }

    const SINK_SLACK = 25;
    function liftSunkenZ(event) {
        if (!cfg.flyLocInject || lastGroundZ == null || !event) return false;
        const minZ = lastGroundZ - SINK_SLACK;
        let changed = false;
        if (event.loc && event.loc.z < minZ) {
            event.loc = vec3(event.loc.x, event.loc.y, lastGroundZ);
            changed = true;
        }
        if (event.dest && event.dest.z < minZ) {
            event.dest = vec3(event.dest.x, event.dest.y, lastGroundZ);
            changed = true;
        }
        return changed;
    }

    // Ground C_PLAYER_LOCATION types → flying types (tera-data comments).
    function flyingTypeFromGround(groundType) {
        switch (groundType) {
            case 7:
            case 9:
                return 0; // hover
            case 2:
            case 10:
                return 7; // descend
            case 5:
                return 6; // ascend
            default:
                return 2; // forward
        }
    }

    function resolveFlyLocType(groundType) {
        const raw = cfg.flyLocType;
        if (raw === 'auto' || raw === 'map') return flyingTypeFromGround(groundType);
        const n = parseInt(raw, 10);
        return Number.isFinite(n) ? n : 7;
    }

    function sendFlyingLocation(packet) {
        injectingFlyLoc = true;
        try {
            try {
                mod.send('C_PLAYER_FLYING_LOCATION', '*', packet);
                return true;
            } catch (_) {
                try {
                    mod.send('C_PLAYER_FLYING_LOCATION', 4, packet);
                    return true;
                } catch (err) {
                    log(`flytest send failed: ${err.message}`);
                    return false;
                }
            }
        } finally {
            injectingFlyLoc = false;
        }
    }

    function isFootTravelType(t) {
        return t === 0 || t === 1 || t === 8;
    }

    function isRewritableGroundLocType(t) {
        return t === 0 || t === 1 || t === 8;
    }

    function plantOnGround(event) {
        if (!cfg.flyLocInject) return;
        if (!cfg.enabled || cfg.multiplier <= 1.0) return;
        if (plantingGround) return;
        const loc = event && event.loc;
        if (!loc) return;
        rememberGroundZ(loc);
        const dest = (event.dest && event.dest.x != null) ? event.dest : loc;
        const pkt = {
            loc,
            w: event.w != null ? event.w : (lastLocPacket && lastLocPacket.w) || 0,
            lookDirection: (lastLocPacket && lastLocPacket.lookDirection != null)
                ? lastLocPacket.lookDirection
                : (event.w || 0),
            dest,
            type: 7,
            jumpDistance: 0,
            inShuttle: !!(lastLocPacket && lastLocPacket.inShuttle),
            time: event.time != null ? event.time : (lastLocPacket && lastLocPacket.time) || 0,
        };
        plantingGround = true;
        try {
            mod.send('C_PLAYER_LOCATION', 5, pkt);
        } catch (_) {}
        plantingGround = false;
    }

    // Run/walk → type 2. Jump is separate (real / hide / its own type).
    mod.hook('C_PLAYER_LOCATION', 5, { order: -10, filter: { fake: false } }, (event) => {
        if (plantingGround) return;
        if (cfg.flyLocInject) {
            if (!cfg.enabled || cfg.multiplier <= 1.0) return;
            rememberGroundZ(event.loc);
            if (!isFootTravelType(event.type)) return;
            if (!sendGroundHover(event.loc, event.dest, event.time, event.w)) return;
            return false;
        }
        const incoming = Number(event.type);
        const jumpMode = currentJumpLocType();
        const hideJump = jumpMode === -2;
        const jumpLike = incoming === 5
            || (hideJump && (Number(event.jumpDistance) > 0 || isAirborneLoc(event)));
        if (jumpLike) {
            if (jumpMode === -1) return;
            lastClientLocType = incoming;
            lastLocMounted = isMountedNow();
            let changed = false;
            if (hideJump) {
                const floorType = currentGroundLocType() >= 0 ? currentGroundLocType() : 2;
                if (incoming !== floorType) {
                    event.type = floorType;
                    changed = true;
                }
                if (flattenJumpToGround(event)) changed = true;
                lastRewrittenLocType = floorType;
            } else {
                if (incoming !== jumpMode) {
                    event.type = jumpMode;
                    changed = true;
                }
                lastRewrittenLocType = jumpMode;
            }
            const now = Date.now();
            if (now - lastLocTypeLogAt > 2000) {
                lastLocTypeLogAt = now;
                log(`jumptype ${incoming} -> ${jumpLocTypeLabel(jumpMode)} ${lastLocMounted ? 'mount' : 'foot'}`);
            }
            return changed ? true : undefined;
        }
        const want = currentGroundLocType();
        if (want < 0) return;
        if (!isRewritableGroundLocType(incoming)) return;
        rememberGroundZ(event.loc);
        lastClientLocType = incoming;
        lastLocMounted = isMountedNow();
        if (incoming === want) {
            lastRewrittenLocType = want;
            return;
        }
        event.type = want;
        lastRewrittenLocType = want;
        const now = Date.now();
        if (now - lastLocTypeLogAt > 2000) {
            lastLocTypeLogAt = now;
            log(`loctype ${lastClientLocType} -> ${want} (${groundLocTypeName(want)}) ${lastLocMounted ? 'mount' : 'foot'}`);
        }
        return true;
    });

    mod.hook('C_PLAYER_LOCATION', 5, { order: Infinity, filter: { fake: false } }, (event) => {
        lastLocPacket = {
            w: event.w,
            lookDirection: event.lookDirection,
            jumpDistance: event.jumpDistance,
            inShuttle: event.inShuttle,
            time: event.time,
        };
    });
    // Real fly: keep C_PLAYER_LOCATION type 2 on the ground. Do not turn on
    // Modes 1–4 (those replace type 2). Rewrite C_PLAYER_FLYING_LOCATION to
    // type 7 (Mode 4 air rule). Cap boost; cap harder on a flying mount.
    function rewriteRealFlyingPacket(event) {
        if (injectingFlyLoc) return;
        flying = true;
        lastClientFlyType = event.type;
        if (!currentFlyMode() && currentGroundLocType() < 0) return;

        const incoming = Number(event.type);
        const want = 7;
        let changed = incoming !== want;
        event.type = want;
        lastRewrittenFlyType = want;

        if (incoming !== 4) learnCruiseFromMove(event.loc, event.time);
        const forceCap = incoming === 4 || isMountedNow();
        if (capPacketIfTooFast(event, forceCap)) changed = true;

        rememberSentFly(event);
        const now = Date.now();
        if (now - lastFlyTypeLogAt > 2000) {
            lastFlyTypeLogAt = now;
            log(`flytype ${incoming} -> ${want} ${isMountedNow() ? 'mount' : 'foot'}`);
        }
        return changed ? true : undefined;
    }
    try {
        mod.hook('C_PLAYER_FLYING_LOCATION', '*', { order: -10, filter: { fake: null } }, rewriteRealFlyingPacket);
    } catch (_) {
        try {
            mod.hook('C_PLAYER_FLYING_LOCATION', 4, { order: -10, filter: { fake: null } }, rewriteRealFlyingPacket);
        } catch (__) {}
    }
    // Fly Forever injects a fake STAT with default walk/run/mount. After you
    // land, rebuild locomotion the same way toggle/remount does so 2.0x
    // returns without dismounting.
    mod.hook('C_PLAYER_LOCATION', 5, { order: 10, filter: { fake: false } }, () => {
        if (!flying) return;
        flying = false;
        lastSentFlyLoc = null;
        lastSentFlyTime = null;
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

    // Plant a real ground stop before the skill. Another hover here was
    // burying you: the server snapshotted fly-Z, then the auto put you under.
    function refreshZBeforeSkill(event) {
        plantOnGround(event);
    }
    const skillLocPackets = [
        'C_START_SKILL',
        'C_START_COMBO_INSTANT_SKILL',
        'C_START_INSTANCE_SKILL',
        'C_START_TARGETED_SKILL',
        'C_NOTIFY_LOCATION_IN_ACTION',
        'C_NOTIFY_LOCATION_IN_DASH',
    ];
    for (const name of skillLocPackets) {
        try {
            mod.hook(name, '*', { order: -10, filter: { fake: false } }, refreshZBeforeSkill);
        } catch (_) {}
    }

    // If the server still answers with a sunk Z, keep the client on last ground Z.
    function liftIfMe(event) {
        if (!cfg.flyLocInject) return;
        if (event.gameId != null || event.id != null) {
            if (!myGameId) grabGameId();
            const id = event.gameId != null ? event.gameId : event.id;
            if (!myGameId || id == null || !sameId(id, myGameId)) return;
        }
        return liftSunkenZ(event) ? true : undefined;
    }
    for (const name of ['S_INSTANT_MOVE', 'S_ACTION_STAGE', 'S_ACTION_END', 'S_USER_LOCATION']) {
        try {
            mod.hook(name, '*', { order: 100, filter: { fake: false } }, liftIfMe);
        } catch (_) {}
    }

    // ----- the actual speed hooks -----
    // S_USER_MOVETYPE is the primary signal: the server broadcasts your move
    // state and the new speed values whenever they change (login, mount,
    // stance change, etc.). We multiply the speed and forward.
    mod.hook('S_USER_MOVETYPE', '*', { filter: { fake: false } }, (event) => {
        if (!myGameId) grabGameId();
        const gid = (event.gameId != null) ? event.gameId : event.id;
        if (!myGameId) {
            try {
                if (gid != null && mod.game && mod.game.me && mod.game.me.gameId
                    && sameId(gid, mod.game.me.gameId)) {
                    myGameId = mod.game.me.gameId;
                }
            } catch (_) {}
        }
        if (!myGameId || gid == null || !sameId(gid, myGameId)) return;
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
        // lastStatUpdate with already-boosted values.
        lastStatUpdate = Object.assign({}, event);
        statsFromThisConnection = true;
        diag.lastStatPacketAt = Date.now();
        if (event.hp !== undefined)    liveHp = event.hp;
        if (event.maxHp !== undefined) liveMaxHp = event.maxHp;
        seedMoveTypeFromStat(event);
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
    // sameId(): Toolbox may store gameId as bigint or number; !== misses "me".
    mod.hook('S_CREATURE_CHANGE_HP', '*', (event) => {
        if (!myGameId) grabGameId();
        const id = (event.target != null) ? event.target : event.gameId;
        if (!myGameId || id == null || !sameId(id, myGameId)) return;
        if (event.curHp !== undefined) liveHp = event.curHp;
        if (event.maxHp !== undefined) liveMaxHp = event.maxHp;
    });

    // Also subtract damage as soon as a hit lands. S_EACH_SKILL_RESULT arrives
    // slightly BEFORE the S_CREATURE_CHANGE_HP that confirms the new HP, so
    // updating liveHp here closes the tiny race window where a toggle between
    // "hit landed" and "hp packet arrived" could replay a stale (too-high) HP.
    // Only `target` is the victim — `gameId` on this packet is often the caster.
    mod.hook('S_EACH_SKILL_RESULT', '*', (event) => {
        if (!myGameId) grabGameId();
        if (!myGameId || event.target == null || !sameId(event.target, myGameId)) return;
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
    function disconnectReasonRank(reason) {
        if (reason === 'S_EXIT') return 3;
        if (reason === 'S_RETURN_TO_LOBBY' || reason === 'S_PREPARE_RETURN_TO_LOBBY') return 2;
        return 1;
    }

    function persistDisconnectReport(report) {
        try {
            fs.writeFileSync(
                path.join(__dirname, 'last-disconnect.json'),
                JSON.stringify(report, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
            );
        } catch (_) {}
    }

    function writeDisconnectReport(reason, extra) {
        const now = new Date().toISOString();
        // S_EXIT then leave_game is the usual kick path. Keep the coded exit
        // as the reason so a speed-checker kick is not logged as a logout.
        if (lastDisconnectReport && disconnectReasonRank(reason) < disconnectReasonRank(lastDisconnectReport.reason)) {
            lastDisconnectReport.followUps = lastDisconnectReport.followUps || [];
            lastDisconnectReport.followUps.push({ at: now, reason, extra: extra || null });
            lastDisconnectReport.diag = diag;
            lastDisconnectReport.enabled = cfg.enabled;
            persistDisconnectReport(lastDisconnectReport);
            return;
        }
        const report = {
            at: now,
            reason,
            extra: extra || null,
            followUps: [],
            enabled: cfg.enabled,
            multiplier: cfg.multiplier,
            fieldMultipliers: {
                walk: cfg.fieldMultipliers ? cfg.fieldMultipliers.walkSpeed : null,
                run: cfg.fieldMultipliers ? cfg.fieldMultipliers.runSpeed : null,
                mount: cfg.fieldMultipliers ? cfg.fieldMultipliers.mountSpeed : null,
                swim: cfg.fieldMultipliers ? cfg.fieldMultipliers.swimSpeed : null,
            },
            inCombat,
            mounted,
            flyLocInject: !!cfg.flyLocInject,
            flyLocType: cfg.flyLocType,
            groundLocType: currentGroundLocType(),
            jumpLocType: currentJumpLocType(),
            lastClientFlyType,
            lastRewrittenFlyType,
            lastClientLocType,
            lastRewrittenLocType,
            lastLocMounted,
            diag,
        };
        lastDisconnectReport = report;
        persistDisconnectReport(report);
        if (reason === 'S_EXIT') {
            log(`Game exit/kick (category=${extra && extra.category} code=${extra && extra.code}). Report saved.`);
        }
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
        return 7;
    }

    // Some sessions never send S_USER_MOVETYPE (or it arrives before we know
    // our gameId). Locomotion refresh still needs a move-type packet, so copy
    // speed fields from the live STAT block until a real MOVETYPE arrives.
    function seedMoveTypeFromStat(event) {
        if (lastMoveType || !event) return;
        if (!myGameId) grabGameId();
        const pkt = {
            gameId: myGameId,
            w: currentHeading(),
            type: 7,
        };
        for (const f of Object.keys(SPEED_FIELD_CATEGORIES)) {
            if (event[f] !== undefined && event[f] !== null) pkt[f] = event[f];
        }
        lastMoveType = pkt;
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
        // Always keep the latest on/off intent. A second toggle while the
        // 400ms wait is pending used to be ignored, so enable-then-disable
        // before STAT arrived could still apply 2x.
        replayRetryForce = forceMultiplier;
        if (replayRetryTimer) return;
        replayRetryTimer = mod.setTimeout(() => {
            replayRetryTimer = null;
            const pending = replayRetryForce;
            replayRetryForce = undefined;
            if (!lastStatUpdate || lastStatUpdate.runSpeed == null) return;
            replayCachedMoveAt(pending);
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
        if (source !== 'login') {
            applyIndicator(on && !(cfg.autoDisableInCombat && inCombat));
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
        ahkStartGen += 1;
        if (ahkStartTimer) {
            try { mod.clearTimeout(ahkStartTimer); } catch (_) {}
            ahkStartTimer = null;
        }
        if (!ahkProc) return;
        try { ahkProc.kill(); } catch (_) {}
        ahkProc = null;
        hotkeyHeldOn = false;
    }

    function spawnAhk() {
        if (!cfg.hotkey || !String(cfg.hotkey).trim()) return;

        let template;
        try { template = fs.readFileSync(hotkeyTemplatePath(), 'utf8'); }
        catch (e) { return log(`hotkey: template missing: ${e.message}`); }

        const keys = expandAhkKeys(cfg.hotkey);
        if (!keys.length) return;
        const rendered = template
            .replace(/{{BINDINGS}}/g, keys.map(ahkBindingBlock).join('\n'))
            .replace(/{{TOOLBOX_PID}}/g, String(process.pid));

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

    function startAhk() {
        stopAhk();
        if (!cfg.hotkey || !String(cfg.hotkey).trim()) return;
        // Give the killed watcher time to release hotkey.runtime.ahk without
        // blocking the proxy (the old sleepSync stalled packets for 80ms).
        const gen = ahkStartGen;
        ahkStartTimer = mod.setTimeout(() => {
            ahkStartTimer = null;
            if (gen !== ahkStartGen) return;
            spawnAhk();
        }, 80);
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
    mod.command.add(['spd', 'speedhack'], (...args) => {
        const sub = (args[0] || '').toLowerCase();

        if (sub === '') { setEnabled(!cfg.enabled, 'cmd/toggle'); return; }
        if (sub === 's') {
            const fm = cfg.fieldMultipliers || {};
            const fmt = (v) => (v === null || v === undefined) ? '(master)' : v;
            const srv = currentServer();
            log(`enabled=${cfg.enabled} multiplier=${cfg.multiplier} combat=${cfg.autoDisableInCombat} ind=${cfg.showIndicator} item=${cfg.triggerItemId} hotkey=${cfg.hotkey || '(none)'} mode=${cfg.hotkeyMode} flymode=${currentFlyMode()} flytype=${cfg.flyLocType} loctype=${currentGroundLocType()} jumptype=${jumpLocTypeLabel(currentJumpLocType())} mounted=${isMountedNow()}`);
            log(`movement: walk=${fmt(fm.walkSpeed)} run=${fmt(fm.runSpeed)} mount=${fmt(fm.mountSpeed)} swim=${fmt(fm.swimSpeed)}`);
            log(`server=${srv.label || srv.name || '?'} id=${srv.id != null ? srv.id : '?'} host=${srv.host || '?'} kind=${srv.kind}`);
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
            if (cfg.enabled && inCombat) {
                if (cfg.autoDisableInCombat) {
                    replayCachedMoveAt(1.0);
                    applyIndicator(false);
                } else {
                    replayCachedMoveAt();
                    applyIndicator(true);
                }
            }
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
        if (sub === 'flytest') {
            const persistFlytest = () => {
                try { if (typeof mod.saveSettings === 'function') mod.saveSettings(); } catch (_) {}
                broadcastUiState();
            };
            const arg = (args[1] || '').toLowerCase();
            if (arg === 'on' || arg === 'off') {
                setFlyMode(arg === 'on' ? 1 : 0);
                persistFlytest();
                return log(`mode=${currentFlyMode()} type=${cfg.flyLocType}`);
            }
            if (arg === '1' || arg === 'mode1') {
                setFlyMode(1);
                persistFlytest();
                return log(`mode=1 foot=1 mount=7 fly=7`);
            }
            if (arg === '2' || arg === 'mode2') {
                setFlyMode(2);
                persistFlytest();
                return log(`mode=2 foot=8 mount=7 fly=7`);
            }
            if (arg === '3' || arg === 'mode3') {
                setFlyMode(3);
                persistFlytest();
                return log(`mode=3 foot=3 mount=7 fly=7`);
            }
            if (arg === '4' || arg === 'mode4') {
                setFlyMode(4);
                persistFlytest();
                return log(`mode=4 foot=7 mount=7 fly=7`);
            }
            if (arg === 'foot8') {
                const v = (args[2] || '').toLowerCase();
                if (v !== 'on' && v !== 'off') return log('usage: spd flytest foot8 on|off');
                setFlyMode(v === 'on' ? 2 : 0);
                persistFlytest();
                return log(`mode=${currentFlyMode()} type=${cfg.flyLocType}`);
            }
            if (arg === 'type') {
                const t = (args[2] || '').toLowerCase();
                if (t === 'auto' || t === 'map') {
                    cfg.flyLocType = 'auto';
                } else {
                    const n = parseInt(t, 10);
                    if (!Number.isFinite(n) || n < 0 || n > 8) {
                        return log('usage: spd flytest type <0..8|auto>  (7=descend, 2=forward, 0=hover)');
                    }
                    cfg.flyLocType = n;
                }
                persistFlytest();
                return log(`flytest=${!!cfg.flyLocInject} type=${cfg.flyLocType}`);
            }
            return log(`flytest=${!!cfg.flyLocInject} type=${cfg.flyLocType}  (spd flytest on|off | type <n|auto>)`);
        }
        if (sub === 'loctype') {
            const persistLocType = () => {
                try { if (typeof mod.saveSettings === 'function') mod.saveSettings(); } catch (_) {}
                broadcastUiState();
            };
            const arg = (args[1] || '').toLowerCase();
            if (!arg) {
                const cur = currentGroundLocType();
                return log(cur < 0
                    ? 'loctype=off  (spd loctype 0..8|off)  0=run 1=walk 2=fall 5=jump 7=stop'
                    : `loctype=${cur} (${groundLocTypeName(cur)})`);
            }
            if (arg === 'off' || arg === 'real' || arg === 'none') {
                setGroundLocType(-1);
                persistLocType();
                return log('loctype=off (real C_PLAYER_LOCATION type)');
            }
            const n = parseInt(arg, 10);
            if (!Number.isFinite(n) || n < 0 || n > 8) {
                return log('usage: spd loctype <0..8|off>  (0=run 1=walk 2=fall 5=jump 7=stop)');
            }
            setGroundLocType(n);
            persistLocType();
            return log(`loctype=${n} (${groundLocTypeName(n)})  fly modes off`);
        }
        if (sub === 'jumptype') {
            const persistJump = () => {
                try { if (typeof mod.saveSettings === 'function') mod.saveSettings(); } catch (_) {}
                broadcastUiState();
            };
            const arg = (args[1] || '').toLowerCase();
            if (!arg) {
                return log(`jumptype=${jumpLocTypeLabel(currentJumpLocType())}  (spd jumptype 0..8|off|hide)`);
            }
            if (arg === 'off' || arg === 'real' || arg === 'none') {
                setJumpLocType(-1);
                persistJump();
                return log('jumptype=real (jump packets keep type 5)');
            }
            if (arg === 'hide' || arg === 'flat' || arg === 'ground') {
                setJumpLocType(-2);
                persistJump();
                return log('jumptype=hide (jump sent as type 2 on the floor)');
            }
            const n = parseInt(arg, 10);
            if (!Number.isFinite(n) || n < 0 || n > 8) {
                return log('usage: spd jumptype <0..8|off|hide>');
            }
            setJumpLocType(n);
            persistJump();
            return log(`jumptype=${n} (${groundLocTypeName(n)})  run/walk still loctype ${currentGroundLocType()}`);
        }
        if (sub === 'reloadhk') { startAhk(); return; }
        if (sub === 'ui')       { openUi(); return; }
        if (sub === 'reset') {
            applyFactorySettings();
            startAhk();
            broadcastUiState();
            return log('Settings reset to first-install defaults.');
        }

        if (sub === 'rl' || sub === 'reload') {
            const name = (mod.info && (mod.info.name || mod.info.rawName)) || 'speedhack';
            if (!mod.manager || typeof mod.manager.reload !== 'function') {
                return log('reload: use Toolbox Mods → Speedhack → reload');
            }
            log('reloading module — stay in the world...');
            const mgr = mod.manager;
            mod.setTimeout(() => {
                try { mgr.reload(name); } catch (e) {
                    try { console.error('[spd] module reload failed:', e); } catch (_) {}
                }
            }, 50);
            return;
        }

        if (sub === 'reloadcfg') {
            try {
                const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
                const parsed = JSON.parse(raw);
                const next = (parsed && parsed.data) ? parsed.data : parsed;
                if (!next || typeof next !== 'object') return log('reloadcfg: config.json missing "data" object');
                for (const k of Object.keys(cfg)) delete cfg[k];
                Object.assign(cfg, next);
                stripRemovedSettings();
                if (uiWindow && !uiWindow.isDestroyed()) {
                    uiWindow.webContents.send('spd-config', JSON.parse(JSON.stringify(cfg)));
                }
                if (cfg.enabled) replayCachedMoveAt();
                startAhk();
                log(`reloadcfg: config.json reloaded (multiplier=${cfg.multiplier} hotkey=${cfg.hotkey || '(none)'})`);
            } catch (e) {
                log(`reloadcfg failed: ${e.message}`);
            }
            return;
        }

        log('cmds: spd | s | on | off | mult <n> | walk|run|mount|swim <n|off> | preset <name> | combat | ind [id] | item <id> | hotkey <k> | hotkeymode toggle|hold | flytest on|off | flytest type <n|auto> | loctype <0..8|off> | jumptype <0..8|off|hide> | reloadhk | ui | rl | reload | reloadcfg');
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
            const combatWas = cfg.autoDisableInCombat;
            const flyWas = !!cfg.flyLocInject;
            const knownKeys = [
                'enabled', 'multiplier', 'autoDisableInCombat',
                'showIndicator', 'indicatorAbnormalityId', 'triggerItemId',
                'hotkey', 'hotkeyMode', 'ahkPath',
                'flyLocInject', 'flyLocType', 'flyLocFoot8', 'flyLocFoot3', 'flyLocFoot7', 'flyLocMode',
                'groundLocType', 'jumpLocType',
            ];
            for (const k of knownKeys) {
                if (incoming[k] !== undefined && incoming[k] !== cfg[k]) cfg[k] = incoming[k];
            }
            if (incoming.presets && typeof incoming.presets === 'object') {
                cfg.presets = Object.assign({}, cfg.presets || {}, incoming.presets);
            }
            if (incoming.fieldMultipliers && typeof incoming.fieldMultipliers === 'object') {
                cfg.fieldMultipliers = Object.assign({}, cfg.fieldMultipliers || {}, incoming.fieldMultipliers);
                if (cfg.fieldMultipliers) delete cfg.fieldMultipliers.gatherSpeed;
                if (cfg.enabled) replayCachedMoveAt();
            }
            try { if (typeof mod.saveSettings === 'function') mod.saveSettings(); } catch (_) {}
            if (incoming.hotkey !== undefined || incoming.hotkeyMode !== undefined || incoming.ahkPath !== undefined) {
                startAhk();
            }
            if (incoming.autoDisableInCombat !== undefined && incoming.autoDisableInCombat !== combatWas
                && cfg.enabled && inCombat) {
                if (cfg.autoDisableInCombat) {
                    replayCachedMoveAt(1.0);
                    applyIndicator(false);
                } else {
                    replayCachedMoveAt();
                    applyIndicator(true);
                }
            }
            if (incoming.flyLocMode !== undefined || incoming.flyLocInject !== undefined
                || incoming.flyLocFoot8 !== undefined || incoming.flyLocFoot3 !== undefined
                || incoming.flyLocFoot7 !== undefined) {
                const incomingMode = Number(incoming.flyLocMode);
                if (incomingMode === 0 || incomingMode === 1 || incomingMode === 2
                    || incomingMode === 3 || incomingMode === 4) {
                    setFlyMode(incomingMode);
                } else if (incoming.flyLocFoot7) {
                    setFlyMode(4);
                } else if (incoming.flyLocFoot3) {
                    setFlyMode(3);
                } else if (incoming.flyLocFoot8 && incoming.flyLocInject) {
                    setFlyMode(2);
                } else if (incoming.flyLocInject) {
                    setFlyMode(1);
                } else {
                    setFlyMode(0);
                }
                log(`mode=${currentFlyMode()} type=${cfg.flyLocType}`);
            }
            if (incoming.groundLocType !== undefined) {
                setGroundLocType(incoming.groundLocType);
                log(currentGroundLocType() < 0
                    ? 'loctype=off'
                    : `loctype=${currentGroundLocType()} (${groundLocTypeName(currentGroundLocType())})`);
            }
            if (incoming.jumpLocType !== undefined) {
                setJumpLocType(incoming.jumpLocType);
                log(`jumptype=${jumpLocTypeLabel(currentJumpLocType())}`);
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
                flyLocInject: !!cfg.flyLocInject,
                flyLocFoot8: !!cfg.flyLocFoot8,
                flyLocFoot3: !!cfg.flyLocFoot3,
                flyLocFoot7: !!cfg.flyLocFoot7,
                flyLocMode: currentFlyMode(),
                groundLocType: currentGroundLocType(),
                jumpLocType: currentJumpLocType(),
                server: guiServerInfo(),
            });
        } catch (_) {}
    }

    // ===== boot =====
    if (cfg.hotkey && cfg.hotkey.trim()) startAhk();
    registerUiHotkey();
    grabGameId();
    loadRuntimeCache();
    syncMountedFromGame();
    announceCurrentServer();
    // Do not inject cached stat/move packets or fake buffs at construct time
    // during login — a stale STAT_UPDATE drops the client. Mid-session reload
    // is safe: we are already in the world with this character's cache.
    if (alreadyInWorld() && lastStatUpdate && lastStatUpdate.runSpeed != null) {
        statsFromThisConnection = true;
        if (cfg.enabled) {
            mod.setTimeout(() => {
                if (!cfg.enabled) return;
                replayCachedMoveAt();
                applyIndicator(!(cfg.autoDisableInCombat && inCombat));
            }, 150);
        }
    }

    this.destructor = () => {
        if (landSpeedRestoreTimer) {
            try { mod.clearTimeout(landSpeedRestoreTimer); } catch (_) {}
            landSpeedRestoreTimer = null;
        }
        if (replayRetryTimer) {
            try { mod.clearTimeout(replayRetryTimer); } catch (_) {}
            replayRetryTimer = null;
        }
        replayRetryForce = undefined;
        saveRuntimeCache();
        try { if (statsFromThisConnection) applyIndicator(false); } catch (_) {}
        try { replayCachedMoveAt(1.0); } catch (_) {}
        stopAhk();
        unregisterUiHotkey();
        closeUi();
        mod.command.remove(['spd', 'speedhack']);
    };
};
