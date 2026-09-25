; DSH APP installer hooks (wired through `nsis.include` in electron-builder.yml).
;
; Three hooks live here:
;
;   1. `customInstall` — pre-extract the bundled kernel at install time, so the
;      app's first launch adopts the staged tree instead of unpacking ~13k
;      files behind the splash.
;   2. `customCheckAppRunning` — exact-match replacement for the stock
;      app-running check.
;   3. `customUnInstallCheck` / `customUnInstallCheckCurrentUser` — fallback
;      when the previous version's uninstaller fails on the update path.
;
; Why (2) is not the stock one: the stock `FIND_PROCESS` matches EVERY process
; whose executable path merely STARTS WITH `$INSTDIR`. That is wrong the moment
; the install directory is a shared one — a Program Files root, or any folder
; the user points at that other applications also run from: the installer then
; finds those unrelated processes, tries to close them (killing the user's
; other software), and lands in the "cannot be closed" retry loop when they
; survive or restart. Measured on this project: installing into
; `D:\Program Files (x86)` (the parent of the app's own folder) matched eight
; unrelated dictionary processes and produced exactly that dialog. This matcher
; looks for THIS application's executable — `$INSTDIR\<app>.exe` — and nothing
; else, so a shared directory can never disturb a neighbour.
;
; Why (3) exists: on the update path the previous version's uninstaller renames
; every installed file into $PLUGINSDIR (TEMP) before deleting, and NSIS's
; Rename cannot cross volumes — an install on D: with TEMP on C: aborts on the
; first file and exits 2, which the stock installer treats as fatal. See the
; comment above the hook for the full reasoning.
;
; PowerShell is used directly (it ships with every Windows this app supports);
; the command shape mirrors the stock macro's, backtick-quoted so the nested
; double quotes survive.

; ---------------------------------------------------------------- (1) extract

!macro customInstall
  CreateDirectory "$INSTDIR\resources\kernel-staged"
  nsExec::ExecToLog `"$SYSDIR\tar.exe" -xzf "$INSTDIR\resources\kernel\kernel.tgz" -C "$INSTDIR\resources\kernel-staged"`
  Pop $0
  ${If} $0 != 0
    DetailPrint "warning: bundled kernel pre-extraction failed (tar exit $0); the app will extract it on first launch"
  ${Else}
    DetailPrint "bundled kernel extracted for the first launch"
  ${EndIf}
!macroend

; ------------------------------------------------------- (2) app-running check

!macro customCheckAppRunning
  Var /GLOBAL AppExePath
  StrCpy $AppExePath "$INSTDIR\${APP_EXECUTABLE_FILENAME}"

  # Find: exit 0 = this app's executable is running (exact, case-insensitive).
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -C "if ((Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.Equals('$AppExePath', 'CurrentCultureIgnoreCase')}).Count -gt 0) { exit 0 } else { exit 1 }"`
  Pop $R0
  ${if} $R0 == 0
    ${if} ${isUpdated}
      # The in-app updater already asked the app to quit; give it a moment and
      # close whatever is left without prompting.
      Sleep 1000
    ${else}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK doStopProcess
      Quit

      doStopProcess:
    ${endIf}

    DetailPrint "$(appClosing)"

    StrCpy $R1 0

    loop:
      IntOp $R1 $R1 + 1

      # Graceful close first; force only from the second round on.
      ${if} $R1 > 1
        nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -C "Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.Equals('$AppExePath', 'CurrentCultureIgnoreCase')} | % { Stop-Process -Id $$_.ProcessId -Force }"`
      ${else}
        nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -C "Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.Equals('$AppExePath', 'CurrentCultureIgnoreCase')} | % { Stop-Process -Id $$_.ProcessId }"`
      ${endIf}
      Sleep 1000

      nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -C "if ((Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.Equals('$AppExePath', 'CurrentCultureIgnoreCase')}).Count -gt 0) { exit 0 } else { exit 1 }"`
      Pop $R0
      ${if} $R0 != 0
        Goto not_running
      ${endIf}

      # Still there after a graceful and a forced close: ask the user rather
      # than looping forever against a process that will not die.
      ${if} $R1 > 2
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY loop
        Quit
      ${endIf}
      Goto loop

    not_running:
  ${endIf}
!macroend

; ------------------------------------------------- (3) old-uninstall fallback

# electron-builder runs the PREVIOUS version's uninstaller before installing
# over it and treats any non-zero exit as fatal ("Failed to uninstall old
# application files"). That uninstaller ships on the user's machine already, so
# it cannot be fixed retroactively — and it has a hard failure mode: on the
# update path (--updated) it renames every installed file into $PLUGINSDIR (the
# TEMP directory) before deleting, and NSIS's Rename cannot cross volumes. An
# install on D: with TEMP on C: therefore fails on the very first file, aborts,
# and exits 2 — measured, both directions. Every in-app update from a
# non-system drive hits this.
#
# These hooks replace the stock failure handling: when the old uninstaller
# fails or cannot be launched, remove the previous install ourselves — RMDir /r
# deletes file by file, so it is volume-agnostic — and let the install
# continue. User data is never in scope: the paths touched here are $INSTDIR
# (app binaries and the staged kernel), shortcuts, and registry keys; $DSH_HOME
# (~/.dsh) and the Electron userData live outside all of them, and the update
# path passes --updated, which suppresses app-data deletion even when an
# uninstaller would otherwise offer it.

!macro dshRemovePreviousInstall
  ${if} ${errors}
    ClearErrors
    DetailPrint "old uninstaller could not be launched; removing the previous install directory directly"
  ${elseIf} $R0 != 0
    DetailPrint "old uninstaller exited with code $R0; removing the previous install directory directly"
  ${else}
    Return
  ${endIf}

  RMDir /r $INSTDIR

  DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
  DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY}"
  DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"
  DeleteRegKey HKLM "${INSTALL_REGISTRY_KEY}"
!macroend

!macro customUnInstallCheck
  !insertmacro dshRemovePreviousInstall
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro dshRemovePreviousInstall
!macroend
