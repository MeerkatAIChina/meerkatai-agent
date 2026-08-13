@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" -arch=x64 -no_logo
if errorlevel 1 exit /b 1
where cargo.exe >nul 2>nul
if %errorlevel%==0 (
  cargo.exe %*
) else (
  "%USERPROFILE%\.cargo\bin\cargo.exe" %*
)
