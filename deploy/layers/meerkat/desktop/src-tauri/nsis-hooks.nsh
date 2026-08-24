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
