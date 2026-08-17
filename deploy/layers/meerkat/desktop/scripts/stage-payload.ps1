$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..\..")
$Desktop = Join-Path $Root "deploy\layers\meerkat\desktop"
$Payload = Join-Path $Desktop "payload"
$Cache = Join-Path $Desktop ".node-cache"
$NodeVersion = if ($env:NODE_VERSION) { $env:NODE_VERSION } else { "v24.15.0" }

if (Test-Path $Payload) { Remove-Item -Recurse -Force $Payload }
New-Item -ItemType Directory -Force -Path "$Payload\node", "$Payload\config\seeds", $Cache | Out-Null

$NodeDist = "node-$NodeVersion-win-x64"
if (-not (Test-Path (Join-Path $Cache $NodeDist))) {
  $zip = Join-Path $Cache "$NodeDist.zip"
  Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/$NodeDist.zip" -OutFile $zip
  Expand-Archive -Force $zip $Cache
}
Copy-Item (Join-Path $Cache "$NodeDist\node.exe") "$Payload\node\"

node (Join-Path $Desktop "scripts\bundle.mjs")
New-Item -ItemType Directory -Force -Path "$Payload\core\dist\protocols" | Out-Null
Copy-Item "$Root\src\resolution\protocols\*.md" "$Payload\core\dist\protocols\"

Push-Location (Join-Path $Root "plugins\web-ui")
npm run build
Pop-Location
Copy-Item -Recurse (Join-Path $Root "plugins\web-ui\dist-web") "$Payload\web-ui\dist-web"
New-Item -ItemType Directory -Force -Path "$Payload\web-ui\server" | Out-Null
Copy-Item (Join-Path $Root "plugins\web-ui\server\setup.html") "$Payload\web-ui\server\"
Copy-Item (Join-Path $Root "plugins\web-ui\server\locks.html") "$Payload\web-ui\server\"

$StageCls = Join-Path $env:TEMP ("meerkat-cls-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $StageCls | Out-Null
Copy-Item (Join-Path $Root "deploy\layers\meerkat\classifier\package.json"), (Join-Path $Root "deploy\layers\meerkat\classifier\package-lock.json") $StageCls
Push-Location $StageCls
npm ci --omit=dev --omit=optional --ignore-scripts
Pop-Location
Copy-Item -Recurse (Join-Path $Root "deploy\layers\meerkat\classifier\src") "$Payload\classifier\src"
Copy-Item (Join-Path $Root "deploy\layers\meerkat\classifier\package.json") "$Payload\classifier\"
Copy-Item -Recurse (Join-Path $StageCls "node_modules") "$Payload\classifier\node_modules"
Remove-Item -Recurse -Force $StageCls

Copy-Item -Recurse (Join-Path $Desktop "seeds\*") "$Payload\config\seeds\"

$rootfs = Join-Path $Desktop "payload-sandbox\rootfs.tar.gz"
if (Test-Path $rootfs) {
  New-Item -ItemType Directory -Force -Path "$Payload\sandbox" | Out-Null
  Copy-Item $rootfs "$Payload\sandbox\"
  Copy-Item (Join-Path $Desktop "payload-sandbox\fingerprint.txt") "$Payload\sandbox\"
} else {
  Write-Host "warn: payload-sandbox/rootfs.tar.gz missing — run scripts/build-rootfs.sh first (Windows sandbox will ship disabled)"
}

Get-ChildItem $Payload | ForEach-Object {
  $size = (Get-ChildItem $_.FullName -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
  "{0,8:N1} MB  {1}" -f $size, $_.Name
}
