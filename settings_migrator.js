// Migrates old config.json layouts forward when settingsVersion in module.json
// changes. Toolbox calls this with (oldVersion, oldSettings, newVersion);
// we just merge the user's prior values onto the v1 defaults.
module.exports = function migrate(oldVersion, oldSettings) {
    const defaults = {
        enabled: false,
        multiplier: 2.0,
        fieldMultipliers: {
            walkSpeed:  null,
            runSpeed:   null,
            mountSpeed: null,
            swimSpeed:  null,
        },
        rampMs: 200,
        autoDisableInCombat: false,
        showIndicator: true,
        indicatorAbnormalityId: 4620,
        triggerItemId: 0,
        hotkey: 'xbutton1',
        hotkeyMode: 'hold',
        ahkPath: '%ProgramFiles%\\AutoHotkey\\v2\\AutoHotkey64.exe',
        presets: {
            walk:   1.5,
            jog:    2.5,
            sprint: 4.0,
            dash:   6.0,
            yeet:   10.0,
        },
    };
    const merged = Object.assign({}, defaults, oldSettings || {});
    merged.presets = Object.assign({}, defaults.presets, (oldSettings && oldSettings.presets) || {});
    merged.fieldMultipliers = Object.assign({}, defaults.fieldMultipliers, (oldSettings && oldSettings.fieldMultipliers) || {});
    return merged;
};
