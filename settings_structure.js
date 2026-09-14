// Settings GUI schema. The toolbox auto-renders these fields in the
// per-mod Settings panel; values are read/written directly to config.json
// via mod.settings.
//
// Note: nested config (cfg.presets.*) isn't directly renderable by the
// toolbox's auto-form, so the preset slots are exposed via /8 spd chat
// commands and the custom Electron UI (Ctrl+Shift+S).
module.exports = [
    { key: 'enabled',                name: 'Enabled (spd on/off)',                                type: 'bool' },
    { key: 'multiplier',             name: 'Speed multiplier (1.0 = off, max 10.0)',               type: 'number', min: 1, max: 10, step: 0.1 },
    { key: 'autoDisableInCombat',    name: 'Auto-disable in combat',                               type: 'bool' },
    { key: 'showIndicator',          name: 'Show buff icon when active',                           type: 'bool' },
    { key: 'indicatorAbnormalityId', name: 'Abnormality ID for the indicator',                     type: 'number', min: 1,    max: 9999999, step: 1 },
    { key: 'triggerItemId',          name: 'Trigger item ID (use item to toggle, 0 = disabled)',   type: 'number', min: 0,    max: 999999, step: 1 },
    { key: 'hotkey',                 name: 'Hotkey (e.g. xbutton1, F11, -). Blank = disabled',     type: 'string' },
    { key: 'hotkeyMode',             name: 'Hotkey behavior: "toggle" or "hold"',                  type: 'string' },
    { key: 'ahkPath',                name: 'AutoHotkey.exe path (only used if hotkey is set)',     type: 'string' },
    { key: 'flyLocInject',           name: 'Mode 1 (foot 1, mount/fly 7)',                         type: 'bool' },
    { key: 'flyLocFoot8',            name: 'Mode 2 (foot 8, mount/fly 7)',                         type: 'bool' },
    { key: 'flyLocFoot3',            name: 'Mode 3 (foot 3, mount/fly 7)',                         type: 'bool' },
    { key: 'flyLocFoot7',            name: 'Mode 4 (foot 7, mount/fly 7)',                         type: 'bool' },
    { key: 'flyLocType',             name: 'Movement type label',                                  type: 'string' },
    { key: 'groundLocType',          name: 'C_PLAYER_LOCATION type (2 = run/walk)',                type: 'number', min: -1, max: 8, step: 1 },
    { key: 'jumpLocType',            name: 'Jump type (-2 = hide, -1 = real, 0..8)',               type: 'number', min: -2, max: 8, step: 1 },
];
