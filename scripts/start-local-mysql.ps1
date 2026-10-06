$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$server = Join-Path $root '.local/mysql-8.4.9-winx64/bin/mysqld.exe'
$config = Join-Path $root '.local/my.ini'

if (-not (Test-Path -LiteralPath $server) -or -not (Test-Path -LiteralPath $config)) {
  throw 'Local MySQL files are missing. See README.md for development setup.'
}

$running = Get-CimInstance Win32_Process -Filter "name='mysqld.exe'" |
  Where-Object { $_.ExecutablePath -eq $server }
if (-not $running) {
  Start-Process -FilePath $server -ArgumentList @("--defaults-file=$config", '--console') `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $root '.local/mysql-stdout.log') `
    -RedirectStandardError (Join-Path $root '.local/mysql-stderr.log') | Out-Null
  Start-Sleep -Seconds 2
}

$open = Test-NetConnection -ComputerName 127.0.0.1 -Port 3307 -InformationLevel Quiet
if (-not $open) { throw 'Local MySQL did not start on 127.0.0.1:3307.' }
Write-Output 'Local development MySQL is ready on 127.0.0.1:3307.'
