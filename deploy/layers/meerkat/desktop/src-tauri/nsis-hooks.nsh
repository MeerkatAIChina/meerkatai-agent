!macro MEERKAT_KILL_INSTDIR_PROCESSES
  FileOpen $0 "$PLUGINSDIR\meerkat-kill-old.ps1" w
  FileWrite $0 'param($$dir); Get-CimInstance Win32_Process | Where-Object -Property ExecutablePath -Like -Value "$$dir\*" | Invoke-CimMethod -MethodName Terminate$\r$\n'
  FileClose $0
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\meerkat-kill-old.ps1" -dir "$INSTDIR"'
  Sleep 2000
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro MEERKAT_KILL_INSTDIR_PROCESSES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro MEERKAT_KILL_INSTDIR_PROCESSES
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${IfNot} ${FileExists} "$APPDATA\${BUNDLEID}\wsl\ext4.vhdx"
    ${If} ${RunningX64}
      ${DisableX64FSRedirection}
    ${EndIf}
    nsExec::Exec '"$SYSDIR\wsl.exe" --unregister meerkat-sandbox'
    ${If} ${RunningX64}
      ${EnableX64FSRedirection}
    ${EndIf}
  ${EndIf}
!macroend
