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
 * Features:
 *   - Single global multiplier (1.0 .. 10.0)
 *   - Per-field speed overrides (walk/run/mount/swim)
 *   - Smooth ramp 1.0 → multiplier on enable
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
 *   spd ramp <0..5000>        → smooth ramp duration
 *   spd combat                → toggle auto-disable in combat
 *   spd ind [id]              → toggle indicator, or set abnormality id
 *   spd item <id>             → set trigger item id (0 disables)
 *   spd hotkey <key>          → set AHK hotkey ("" disables)
 *   spd hotkeymode toggle|hold
 *   spd reloadhk              → restart AHK watcher
 *   spd ui                    → open the GUI (also Ctrl+Shift+S)
 *   spd reload                → re-read config.json from disk
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
    let rampStartedAt = 0;
    let uiWindow = null;
    let uiHotkeyRegistered = false;
    // Cache of the last server-broadcast move-type values, so on disable we
    // can replay them at 1.0x and the server believes our base speed again.
    let lastMoveType = null;
    let lastStatUpdate = null;   // last real S_PLAYER_STAT_UPDATE (full block)
    let liveHp = null;           // latest real current HP (tracked separately)
    let liveMaxHp = null;        // latest real max HP
    const diag = {
        lastReplayAt: 0,
        lastReplayErr: null,
        lastMovePacketAt: 0,
        lastStatPacketAt: 0,
        lastExit: null,
    };

    const log = (s) => mod.command.message(`[spd] ${s}`);
    const RUNTIME_CACHE_PATH = path.join(__dirname, 'runtime-cache.json');

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

    const clampMultiplier = (n) => {
        const v = Number(n);
        if (!Number.isFinite(v)) return MIN_MULTIPLIER;
        return Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, v));
    };

    // ----- multiplier resolution -----
    // Compute the multiplier we apply to a packet right now. Honors the ramp
    // and the auto-disable-in-combat safety. Returns 1.0 when off.
    function effectiveMultiplier() {
        if (!cfg.enabled) return 1.0;
        if (cfg.autoDisableInCombat && inCombat) return 1.0;

        const target = clampMultiplier(cfg.multiplier);
        const rampMs = Number(cfg.rampMs) || 0;
        if (rampMs > 0 && rampStartedAt > 0) {
            const elapsed = Date.now() - rampStartedAt;
            if (elapsed < rampMs) {
                const t = elapsed / rampMs;
                return 1.0 + (target - 1.0) * t;
            }
        }
        return target;
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

    // ----- identity / combat tracking -----
    mod.hook('S_LOGIN', '*', (event) => {
        myGameId = event.gameId;
        inCombat = false;
        // Always start off when you enter a character. Turn it on with - / spd.
        if (cfg.enabled) setEnabled(false, 'login');
    });

    mod.hook('S_SPAWN_ME', '*', (event) => {
        if (event.gameId) myGameId = event.gameId;
        scheduleStartupIndicator();
    });

    mod.hook('S_USER_STATUS', '*', (event) => {
        if (!myGameId || event.gameId !== myGameId) return;
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

    // ----- the actual speed hooks -----
    // S_USER_MOVETYPE is the primary signal: the server broadcasts your move
    // state and the new speed values whenever they change (login, mount,
    // stance change, etc.). We multiply the speed and forward.
    mod.hook('S_USER_MOVETYPE', '*', (event) => {
        if (!myGameId || event.gameId !== myGameId) {
            // Not us — leave it alone (other players don't get sped up).
            return;
        }
        // Cache un-modified values so we can restore on disable.
        lastMoveType = Object.assign({}, event);
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
    mod.hook('S_PLAYER_STAT_UPDATE', '*', (event) => {
        // No gameId on this packet — it's implicitly "me", so safe to
        // always multiply.
        lastStatUpdate = Object.assign({}, event);
        diag.lastStatPacketAt = Date.now();
        if (event.hp !== undefined)    liveHp = event.hp;
        if (event.maxHp !== undefined) liveMaxHp = event.maxHp;
        scheduleSaveRuntimeCache();
        const changed = multiplySpeedFields(event); // per-field speed
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

    function replayCachedMoveAt(forceMultiplier) {
        diag.lastReplayAt = Date.now();
        diag.lastReplayErr = null;
        if (lastMoveType) {
            const pkt = Object.assign({}, lastMoveType);
            multiplySpeedFields(pkt, forceMultiplier);
            try { mod.send('S_USER_MOVETYPE', '*', pkt); } catch (e) {
                diag.lastReplayErr = `MOVETYPE: ${e.message}`;
                log(`replay MOVETYPE failed: ${e.message}`);
            }
        }
        if (lastStatUpdate) {
            const pkt = Object.assign({}, lastStatUpdate);
            if (liveHp !== null && pkt.hp !== undefined) pkt.hp = liveHp;
            if (liveMaxHp !== null && pkt.maxHp !== undefined) pkt.maxHp = liveMaxHp;
            multiplySpeedFields(pkt, forceMultiplier);
            try { mod.send('S_PLAYER_STAT_UPDATE', '*', pkt); } catch (e) {
                diag.lastReplayErr = `STAT: ${e.message}`;
                log(`replay STAT failed: ${e.message}`);
            }
        }
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
        if (cfg.enabled === on) { applyIndicator(on); return; }
        cfg.enabled = on;
        applyIndicator(on);
        rampStartedAt = on ? Date.now() : 0;
        // Replay cached move so the server picks up the new multiplier
        // immediately instead of waiting for natural broadcast.
        replayCachedMoveAt(on ? undefined : 1.0);
        broadcastUiState();
        if (source && source.startsWith('hotkey/hold')) return;
        log(`${on ? 'ON' : 'OFF'} (${source}) multiplier=${cfg.multiplier}`);
    }

    function applyPreset(name) {
        const presets = cfg.presets || {};
        if (!presets[name]) return false;
        cfg.multiplier = clampMultiplier(presets[name]);
        rampStartedAt = Date.now();
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
            log(`enabled=${cfg.enabled} multiplier=${cfg.multiplier} ramp=${cfg.rampMs}ms combat=${cfg.autoDisableInCombat} ind=${cfg.showIndicator} item=${cfg.triggerItemId} hotkey=${cfg.hotkey || '(none)'} mode=${cfg.hotkeyMode}`);
            log(`movement: walk=${fmt(fm.walkSpeed)} run=${fmt(fm.runSpeed)} mount=${fmt(fm.mountSpeed)} swim=${fmt(fm.swimSpeed)}`);
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
            rampStartedAt = Date.now();
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

        if (sub === 'ramp') {
            const ms = parseInt(args[1], 10);
            if (isNaN(ms) || ms < 0 || ms > 5000) return log('usage: spd ramp <0..5000>');
            cfg.rampMs = ms;
            return log(`rampMs=${ms}`);
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
        if (sub === 'reloadhk') { startAhk(); return; }
        if (sub === 'ui')       { openUi(); return; }

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

        log('cmds: spd | s | on | off | mult <n> | walk|run|mount|swim <n|off> | preset <name> | ramp <ms> | combat | ind [id] | item <id> | hotkey <k> | hotkeymode toggle|hold | reloadhk | ui | reload');
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
        uiWindow = new BrowserWindow({
            width: 540,
            height: 920,
            useContentSize: true,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
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
        });
        uiWindow.removeMenu();
        uiWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
        uiWindow.once('ready-to-show', () => uiWindow.show());

        const onRequest = () => {
            if (uiWindow && !uiWindow.isDestroyed()) {
                uiWindow.webContents.send('spd-config', JSON.parse(JSON.stringify(cfg)));
            }
        };
        const onSave = (_evt, incoming) => {
            if (!incoming || typeof incoming !== 'object') return;
            const knownKeys = [
                'enabled', 'multiplier', 'rampMs', 'autoDisableInCombat',
                'showIndicator', 'indicatorAbnormalityId', 'triggerItemId',
                'hotkey', 'hotkeyMode', 'ahkPath',
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
            rampStartedAt = Date.now();
            if (cfg.enabled) replayCachedMoveAt();
            broadcastUiState();
        };

        ipcMain.on('spd-request-config', onRequest);
        ipcMain.on('spd-save',            onSave);
        ipcMain.on('spd-toggle',          onToggle);
        ipcMain.on('spd-reloadhk',        onReloadHk);
        ipcMain.on('spd-preset',          onPreset);
        ipcMain.on('spd-mult',            onMult);

        uiWindow.on('closed', () => {
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
            try { uiWindow.close(); } catch (_) {}
        }
        uiWindow = null;
    }

    function broadcastUiState() {
        if (!uiWindow || uiWindow.isDestroyed()) return;
        try { uiWindow.webContents.send('spd-state', { enabled: cfg.enabled, multiplier: cfg.multiplier }); }
        catch (_) {}
    }

    // ===== boot =====
    if (cfg.hotkey && cfg.hotkey.trim()) startAhk();
    registerUiHotkey();
    grabGameId();
    loadRuntimeCache();
    if (cfg.enabled) {
        try { replayCachedMoveAt(); } catch (_) {}
        if (myGameId && cfg.showIndicator) {
            applyIndicator(true);
            mod.setTimeout(() => applyIndicator(true), 800);
        } else if (cfg.showIndicator) {
            scheduleStartupIndicator();
        }
    }

    this.destructor = () => {
        saveRuntimeCache();
        try { applyIndicator(false); } catch (_) {}
        try { replayCachedMoveAt(1.0); } catch (_) {}
        stopAhk();
        unregisterUiHotkey();
        closeUi();
        mod.command.remove('spd');
    };
};
