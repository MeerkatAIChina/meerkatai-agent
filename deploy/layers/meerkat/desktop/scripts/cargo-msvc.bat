@echo off
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo vswhere.exe not found: no Visual Studio installation detected 1>&2
  exit /b 1
)
set "VSINSTALL="
set "VSTMP=%TEMP%\cargo-msvc-vswhere.txt"
"%VSWHERE%" -latest -products * -requiresAny -requires Microsoft.VisualStudio.Component.VC.Tools Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath > "%VSTMP%"
set /p "VSINSTALL=" < "%VSTMP%"
del "%VSTMP%" >nul 2>nul
if not defined VSINSTALL (
  echo no Visual Studio instance with the C++ workload found 1>&2
  exit /b 1
)
call "%VSINSTALL%\Common7\Tools\VsDevCmd.bat" -arch=x64 -no_logo
if errorlevel 1 exit /b 1
where cargo.exe >nul 2>nul
if %errorlevel%==0 (
  cargo.exe %*
) else (
  "%USERPROFILE%\.cargo\bin\cargo.exe" %*
)
