# Speedhack — Changelog

## 2.37 (2026-08-24)

### Changed
- Reverted the Asura faster NPC catch-up after a late kick. Clamp is legal 1.0x again. Agaia is unchanged.

---
## 2.36 (2026-08-24)

### Changed
- Asura NPC wait is shorter after you stop: one small 80-unit catch-up, then 1.5x walk-up. Running stays legal 1.0x so it does not send the 2.0x that kicked. Agaia is unchanged.

---
## 2.35 (2026-08-24)

### Changed
- Reverted the Asura no-delay test after it kicked. Auto on Asura clamps again. Agaia is unchanged.

---
## 2.34 (2026-08-24)

### Changed
- Asura-only no-delay test: auto no longer clamps locations, so NPC/hits match 2.0x. Agaia is unchanged. `/8 spd safe on` puts the clamp back.

---
## 2.33 (2026-08-24)

### Changed
- GUI shows the server you are on (Asura / Agaia) and whether the clamp is active.
- Safe movement keeps Auto on both servers; the GUI now shows the live ON/OFF so Agaia does not look like Asura clamp is on.

---
## 2.32 (2026-08-24)

### Changed
- Auto server split: Asura keeps 2.0x + instant-hit catch-up. Agaia gets raw 2.0x with no clamp and no catch-up.

---
## 2.31 (2026-08-24)

### Fixed
- On/off now applies walk/run immediately. The client was keeping the old locomotion until mount/dismount; toggle now refreshes that the same way remount does.

---
## 2.30 (2026-08-23)

### Fixed
- Removed the movement-match that dropped you to 1.0x. Instant hits are unchanged. 2.0x is back.

---
## 2.29 (2026-08-23)

### Fixed
- Instant hits are unchanged. A long 2.0x run was opening a ~1000-unit gap, then the swing jumped that far and Asura kicked. Movement now matches Asura if that gap starts to open, so the same instant hit is a small step.

---
## 2.28 (2026-08-23)

### Fixed
- Instant hits restored: the swing again tells Asura you are fully on the mob. The 90-unit cap is gone. Movement clamp is unchanged.

---
## 2.27 (2026-08-23)

### Fixed
- Removed the lead tug that flickered you back and forth. Swing catch-up stays capped at 90 so it is not a 1067-unit teleport.

---
## 2.26 (2026-08-23)

### Fixed
- Movement kick was a 1067-unit swing teleport. Catch-up is capped at 90, and the client is kept from getting more than ~100 ahead of Asura so hits stay instant without that jump.

---
## 2.25 (2026-08-23)

### Changed
- Instant hits again: the first swing tells Asura you are at the mob. The skill is not held or rewritten.
- Small self rubberbands are hidden so 2.0x is not yanked back to 1x. Run packets stay clamped.

---
## 2.24 (2026-08-23)

### Fixed
- Skills are no longer held or dropped. That is why casts felt broken after a 2.0x run. Movement is still clamped; spells go through as normal.

---
## 2.23 (2026-08-23)

### Fixed
- First location packet after a reload could go out unclamped (1372 units). That packet is now clamped from your real loc.
- Skill logic no longer injects extra move packets. Toolbox had also cleared the `-` hotkey and set safeMode to auto; both are restored.

---
## 2.22 (2026-08-23)

### Fixed
- The swing no longer teleports you onto the mob (that 489–700 unit jump was the movement kick). The hit is held and Asura is walked there at real runSpeed, then the skill is sent.
- If the walk-in takes more than 4s, the held swing is dropped instead of firing from the far 2.0x loc.

---
## 2.21 (2026-08-23)

### Fixed
- After a 2.0x run, the first swing tells Asura you are at the mob (forward only). The skill loc is not rewritten, so you should not snap back.

---
## 2.20 (2026-08-23)

### Fixed
- Casting a skill no longer rewrites the swing back to the server position. That was the snap-back. Skills are left alone again.

---
## 2.19 (2026-08-23)

### Fixed
- Hits were late again after the combat teleport was removed. A swing now takes at most an 80-unit legal step (the 278-unit snap is what kicked Asura), then walks the leftover gap at real runSpeed.

---
## 2.18 (2026-08-23)

### Fixed
- The combat catch-up was a 200+ unit teleport (`lastSkillGap` 278). Asura treats that as a speedhack. Skills keep their real hit loc; movement packets stay on the 1x path.

---
## 2.17 (2026-08-23)

### Fixed
- Attacks felt late on Asura because the server still had you a few steps behind the 2.0x client. Skill start now snaps that last gap, and skill-move packets are no longer clamped.

---
## 2.16 (2026-08-23)

### Fixed
- Asura lasted ~2 minutes then kicked because fast location packets still credited 50ms each and `dest` could stay 2x ahead. Movement is now a real wall-clock budget, and `dest` is pinned to the legal loc.

---
## 2.15 (2026-08-23)

### Fixed
- Asura clamp was using the boosted runSpeed after toggle replay, so the server still saw a 2x sprint. Clamp now uses only the real server speed from live `S_PLAYER_STAT_UPDATE`.

---
## 2.14 (2026-08-23)

### Fixed
- Enabling on Asura no longer freezes ground movement. Stop-updates and dropped location packets were blocking walk/run; mount still worked because it refreshes move state. Toggle now applies speed again, and foot movement keeps type 0/1.

---
## 2.13 (2026-08-23)

### Changed
- Asura forge now clamps every stop-update to real runSpeed. No 2.0x steps are sent to the server. Client still runs at 2.0x. Self rubberband (`S_INSTANT_MOVE`) is blocked.

---
## 2.12 (2026-08-23)

### Fixed
- Do not inject a big catch-up `C_PLAYER_LOCATION` after the quiet gap. That snap was still kicking Asura. Resume on the next real packet, clamped to legal distance.

---
## 2.11 (2026-08-23)

### Changed
- Asura location-forge: type-7 stop updates plus a short server-side quiet window so the leftover kick counter can decay. Client stays at 2.0x.
- Auto-update disabled so Toolbox cannot overwrite this local fix with GitHub 2.7.

---
## 2.7 (2026-08-23)

Version label set to 2.7.

---
## 2.2 (2026-08-23)

### Fixed
- Do not inject last session's `S_PLAYER_STAT_UPDATE` / move packets (or fake buffs) when the mod loads or when it turns itself off on login. That was dropping the client about a second after entering the world.

---

## 2.1 (2026-08-23)

### Changed
- First-install default multiplier is **1.0** (no speed boost until you raise it)

---

## 2.0 (2026-08-23)

Version label set to 2.0.

---

## 2.1 (2026-08-23)

GitHub username is now ballzyxx. Auto-update URLs follow that.

---

## 2.0 (2026-08-23)

Current release.

---

## 2.2 (2026-08-23)

### Fixed
- Auto-update now downloads from jsDelivr so GitHub's stale `/main/` cache cannot break the hash check

---

## 2.1 (2026-08-23)

### Fixed
- Auto-update hash mismatch on `module.json` (Windows line endings vs GitHub)

---

## 2.0 (2026-08-23)

Renumbered to 2.0.

---

## 1.2 (2026-08-23)

### Removed
- Speed ramp — multiplier applies instantly when you turn it on

### Added
- GUI remembers the last window position and size
- GUI can be resized

---

## 1.1 (2026-08-23)

### Changed
- No hotkey is bound on first install — set one in the GUI or with `spd hotkey <key>`

---

## 1.0 (2026-08-23)

### Added
- GUI (Ctrl+Shift+S / `spd ui`)
- Optional AHK v2 hotkey (toggle or hold); keyboard `-` also binds numpad minus if you choose that key
- Per-field walk / run / mount / swim overrides
- Instant reload: restores last speed after `toolbox reload speedhack`
- Starts **off** when you join a character; turn on with your hotkey or `spd`
- Disconnect report written to `last-disconnect.json` (local only)
