; Extract the bundled kernel at install time.
;
; Why: the first launch used to unpack ~13k files (~96 MiB tgz, ~290 MiB on
; disk) behind the splash before the UI could appear. The installer already
; carries the tarball (electron-builder extraResources), so the extraction
; moves here — installers are expected to take minutes, apps are expected to
; open. The app's first launch then activates the staged tree directly.
;
; Failure is a slower first launch, never a broken install: the shell
; verifies the tarball's sha512 against its sidecar before it touches the
; staged tree, and a missing or unusable stage falls back to the app's own
; extraction path.
;
; tar.exe is Windows 10 1803+'s bundled libarchive binary (Electron 44
; requires Windows 10 regardless), and nsExec keeps the work console-free —
; a console child would flash a terminal onto the user's desktop.

!macro customInstall
  CreateDirectory "$INSTDIR\resources\kernel-staged"
  nsExec::ExecToLog '"$SYSDIR\tar.exe" -xzf "$INSTDIR\resources\kernel\kernel.tgz" -C "$INSTDIR\resources\kernel-staged"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "warning: bundled kernel pre-extraction failed (tar exit $0); the app will extract it on first launch"
  ${Else}
    DetailPrint "bundled kernel extracted for the first launch"
  ${EndIf}
!macroend
