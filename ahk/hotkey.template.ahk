; Hotkey watcher template. Bindings and Toolbox PID are filled in at runtime.
; Requires AutoHotkey v2.
#Requires AutoHotkey v2.0
#SingleInstance Force
#NoTrayIcon
Persistent

stdout := FileOpen("*", "w `n")

{{BINDINGS}}

SetTimer CheckParent, 1000
CheckParent() {
    if !ProcessExist({{TOOLBOX_PID}})
        ExitApp
}
