param([Parameter(Mandatory = $true)][string]$TransactionFile)

$ErrorActionPreference = 'Stop'
$tx = Get-Content -LiteralPath $TransactionFile -Raw -Encoding UTF8 | ConvertFrom-Json
$script:launchedPid = 0

function Save-Result([bool]$ok, [string]$message) {
  $temporary = "$($tx.result).tmp"
  $result = @{ ok = $ok; version = $tx.version; message = $message; appPid = $script:launchedPid } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($temporary, $result, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $tx.result -Force
}

try {
  [System.IO.File]::WriteAllText($tx.started, 'ready')
  for ($i = 0; $i -lt 300; $i++) {
    $oldApp = Get-Process -Id $tx.parentPid -ErrorAction SilentlyContinue
    if (-not $oldApp) { break }
    Start-Sleep -Milliseconds 100
  }
  if (Get-Process -Id $tx.parentPid -ErrorAction SilentlyContinue) {
    throw 'The old app did not exit.'
  }

  $file = Get-Item -LiteralPath $tx.installer
  if ($file.Length -ne $tx.size) { throw 'Installer size changed.' }
  $hash = (Get-FileHash -LiteralPath $tx.installer -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $tx.sha256) { throw 'Installer hash changed.' }

  # NSIS reuses the registered per-user installation directory.
  $installed = Start-Process -FilePath $tx.installer -ArgumentList '/S' -PassThru -Wait -WindowStyle Hidden
  if ($installed.ExitCode -ne 0) { throw "NSIS failed: $($installed.ExitCode)" }
  if (-not (Test-Path -LiteralPath $tx.target)) { throw 'Updated app is missing.' }

  $previous = $env:CORNER_UPDATE_TOKEN
  $env:CORNER_UPDATE_TOKEN = $tx.token
  # Tests use a new CDP port so the restarted app never races the old port's
  # shutdown. Normal installed apps do not set this transaction field.
  if ($tx.restartDebugPort -and $tx.restartDebugPort -match '^\d{2,5}$') {
    $env:CORNER_TEST_DEBUG_PORT = $tx.restartDebugPort
  }
  try {
    if ($tx.restartDebugPort -and $tx.restartDebugPort -match '^\d{2,5}$') {
      $debugArguments = "--remote-debugging-port=$($tx.restartDebugPort) --remote-debugging-address=127.0.0.1"
      $newApp = Start-Process -FilePath $tx.target -ArgumentList $debugArguments -PassThru
    } else {
      $newApp = Start-Process -FilePath $tx.target -PassThru
    }
    $script:launchedPid = $newApp.Id
  }
  finally { $env:CORNER_UPDATE_TOKEN = $previous }
  for ($i = 0; $i -lt 600; $i++) {
    if (Test-Path -LiteralPath $tx.ack) {
      $ack = Get-Content -LiteralPath $tx.ack -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($ack.version -eq $tx.version -and $ack.token -eq $tx.token) {
        Save-Result $true "$($tx.version) update applied."
        Remove-Item -LiteralPath $tx.ack -Force -ErrorAction SilentlyContinue
        exit 0
      }
    }
    if ($newApp.HasExited) { break }
    Start-Sleep -Milliseconds 100
  }
  throw 'The updated app did not acknowledge startup.'
}
catch {
  Save-Result $false $_.Exception.Message
  exit 1
}
