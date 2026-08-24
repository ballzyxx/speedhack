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
const path = require('path');
const { spawn } = require('child_process');

let electronMod = null;
try { electronMod = require('electron'); } catch (_) { /* unavailable in headless toolbox */ }

const MAX_MULTIPLIER = 10.0;
const MIN_MULTIPLIER = 1.0;
const INT16_MAX = 32767;
const DEFAULT_FORGE_BURST_MS = 1800;
const DEFAULT_FORGE_QUIET_MS = 2200;
const FORGE_SLACK = 1.0;
const FORGE_BUDGET_CAP_MS = 150;
const SKILL_CATCHUP_COOLDOWN_MS = 500;
const SKILL_SNAP_MAX = 80;
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
    let lastSkillCatchupAt = 0;
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
    cfg.forgeBurstMs = DEFAULT_FORGE_BURST_MS;
    cfg.forgeQuietMs = DEFAULT_FORGE_QUIET_MS;

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
        if (Number(s.id) === 2800) return true;
        return /agaia|agais/i.test(s.name);
    }

    function safeModeActive() {
        if (cfg.safeMode === 'on') return true;
        if (cfg.safeMode === 'off') return false;
        if (isAgaiaServer()) return false;
        if (isAsuraServer()) return true;
        // Unknown server: keep Asura measures so a missed name does not send raw 2x.
        return true;
    }

    function guiServerInfo() {
        const s = currentServer();
        let kind = 'unknown';
        if (isAgaiaServer()) kind = 'agaia';
        else if (isAsuraServer()) kind = 'asura';
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
        const run = (Number(event.runSpeed) || 0) + (Number(event.runSpeedBonus) || 0);
        if (run > 1) serverRunSpeed = run;
    }

    function realRunSpeed() {
        return Math.max(1, serverRunSpeed || 192);
    }

    function resetForgeState() {
        lastOutLoc = null;
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

    // Instant hits: snap only if the gap is under 80. A bigger snap is a
    // teleport and Asura kicks. Do not rewrite the skill backward.
    function onOutgoingSkill(event) {
        if (!safeModeActive() || !cfg.enabled || effectiveMultiplier() <= 1.0) return;
        if (!event.loc) return;
        if (!lastOutLoc) {
            seedForgeLoc(event.loc);
            return;
        }
        const gap = dist2d(lastOutLoc, event.loc);
        forgeStats.lastSkillGap = Math.round(gap * 10) / 10;
        if (gap < 20) return;
        if (gap > SKILL_SNAP_MAX) {
            log(`skip hit snap ${forgeStats.lastSkillGap} (would kick)`);
            return;
        }
        const now = Date.now();
        if (now - lastSkillCatchupAt < SKILL_CATCHUP_COOLDOWN_MS) return;
        lastSkillCatchupAt = now;
        const prev = lastLocPacket || {};
        try {
            mod.send('C_PLAYER_LOCATION', 5, {
                loc: event.loc,
                w: event.w != null ? event.w : (prev.w || 0),
                lookDirection: prev.lookDirection || 0,
                dest: cloneLoc(event.loc),
                type: 7,
                jumpDistance: 0,
                inShuttle: !!prev.inShuttle,
                time: prev.time ? prev.time + Math.max(1, now - (lastSentWall || now)) : now,
            });
        } catch (_) {}
        seedForgeLoc(event.loc);
    }

    // The server only gets legal runSpeed distance per real wall-clock
    // time. dest is always pinned to loc so a 2x look-ahead cannot slip
    // through. Jump/fall/stop use the same XY budget.
    function forgeOutgoingLocation(event) {
        const now = Date.now();
        const type = Number(event.type);
        rememberLocPacket(event);

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
        const srv = currentServer();
        const label = srv.name || srv.id || '?';
        if (safeModeActive()) {
            log(`server=${label} — Asura 2.0x screen / 1.0x loc (wall clock)`);
        } else {
            log(`server=${label} — Agaia 2.0x, no location-forge`);
        }
        broadcastUiState();
    });

    mod.hook('S_SPAWN_ME', '*', (event) => {
        if (event.gameId) myGameId = event.gameId;
        seedForgeLoc(event.loc);
        scheduleStartupIndicator();
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
    try {
        mod.hook('S_INSTANT_MOVE', '*', { filter: { fake: false } }, (event) => {
            if (!myGameId || !sameId(event.gameId, myGameId) || !event.loc) return;
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
            forgeBurstMs: cfg.forgeBurstMs,
            forgeQuietMs: cfg.forgeQuietMs,
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
                return log(`safe=${cfg.safeMode} active=${safeModeActive()} forgeType=${lastForgeType} burst=${cfg.forgeBurstMs} quiet=${cfg.forgeQuietMs} server=${srv.name || srv.id || '?'}`);
            }
            if (arg === 'auto' || arg === 'on' || arg === 'off') {
                cfg.safeMode = arg;
                broadcastUiState();
                return log(`safeMode=${arg} active=${safeModeActive()}`);
            }
            if (arg === 'burst') {
                const n = parseInt(args[2], 10);
                if (!Number.isFinite(n) || n < 800 || n > 15000) return log('usage: spd safe burst <800..15000>');
                cfg.forgeBurstMs = n;
                return log(`forgeBurstMs=${n}`);
            }
            if (arg === 'quiet') {
                const n = parseInt(args[2], 10);
                if (!Number.isFinite(n) || n < 400 || n > 5000) return log('usage: spd safe quiet <400..5000>');
                cfg.forgeQuietMs = n;
                return log(`forgeQuietMs=${n}`);
            }
            return log('usage: spd safe [auto|on|off|burst <ms>|quiet <ms>]');
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
