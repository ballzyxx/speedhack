# Speedhack — Changelog

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
