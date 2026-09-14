// Migrates old config.json layouts forward when settingsVersion in module.json
// changes. Toolbox calls this with (oldVersion, oldSettings, newVersion);
// we just merge the user's prior values onto the v1 defaults.
module.exports = function migrate(oldVersion, oldSettings) {
    const defaults = {
        enabled: false,
        multiplier: 1.0,
        fieldMultipliers: {
            walkSpeed:  null,
            runSpeed:   null,
            mountSpeed: null,
            swimSpeed:  null,
        },
        autoDisableInCombat: false,
        showIndicator: true,
        indicatorAbnormalityId: 4620,
        triggerItemId: 0,
        hotkey: '-',
        hotkeyMode: 'toggle',
        ahkPath: '%ProgramFiles%\\AutoHotkey\\v2\\AutoHotkey64.exe',
        uiX: null,
        uiY: null,
        uiWidth: 540,
        uiHeight: 920,
        presets: {
            walk:   1.5,
            jog:    2.5,
            sprint: 4.0,
            dash:   6.0,
            yeet:   10.0,
        },
        // Opt-in only: rewrite ground loc as flying loc (GUI tick / spd flytest).
        flyLocInject: false,
        flyLocFoot8: false,
        flyLocFoot3: false,
        flyLocFoot7: false,
        flyLocMode: 0,
        flyLocType: 1,
        groundLocType: 2,
        jumpLocType: -2,
    };
    const merged = Object.assign({}, defaults, oldSettings || {});
    // v6 defaulted the fly-loc experiment on. Restore normal movement unless
    // the user ticks it again after this version.
    if (oldVersion < 7) {
        merged.flyLocInject = false;
        merged.flyLocType = 7;
    }
    if (oldVersion < 8) {
        merged.flyLocMode = 0;
        merged.flyLocInject = false;
        merged.flyLocFoot8 = false;
        merged.flyLocFoot3 = false;
    }
    if (oldVersion < 9) {
        merged.groundLocType = 2;
    }
    if (oldVersion < 10) {
        merged.jumpLocType = -2;
    }
    delete merged.rampMs;
    delete merged.safeScoreLimit;
    delete merged.safeCooldownMs;
    delete merged.forgeBurstMs;
    delete merged.forgeQuietMs;
    delete merged.safeMode;
    delete merged.useServerConfig;
    delete merged.serverConfigPath;
    delete merged.serverConfigPaths;
    delete merged.serverConfigSearchRoots;
    delete merged.serverConfigShares;
    delete merged.knownServers;
    merged.presets = Object.assign({}, defaults.presets, (oldSettings && oldSettings.presets) || {});
    merged.fieldMultipliers = Object.assign({}, defaults.fieldMultipliers, (oldSettings && oldSettings.fieldMultipliers) || {});
    if (merged.fieldMultipliers) delete merged.fieldMultipliers.gatherSpeed;
    return merged;
};
