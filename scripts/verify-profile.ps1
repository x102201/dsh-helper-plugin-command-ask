# Verify this plugin inside a REAL dsh profile, without touching the user's own
# profile or sessions.
#
#   pwsh -File scripts/verify-profile.ps1 -DshBin "C:\path\to\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js"
#
# What it does, all inside a scratch DSH_HOME (default `.verify/home`, nothing
# outside this checkout is written):
#
#   1. builds a `web` profile whose bundles are base + web-app + this package,
#      resolving the package the way a `link:` install does (a directory link
#      into the profile's `node_modules`);
#   2. `dsh --profile web --dump-config` — proves the bundle patch parsed and the
#      `command-ask` row composed with a name anchored inside the package;
#   3. `dsh --profile web --port 0 --no-open` — proves the whole tree activates
#      (dsh fails loudly on any entry that does not reach the active state).
#
# With -Probe it additionally copies the package, prints an `ASK-PROBE` line from
# `apply()`, and asserts that line appeared — proof that the plugin body ran and
# that the `commands` service it registers `/ask` into was injectable.
#
# The scratch home is left in place for inspection; delete `.verify` when done.

[CmdletBinding()]
param(
    [string]$DshBin = $env:DSH_BIN,
    [string]$DshHome = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path '.verify\home'),
    [int]$BootTimeoutSeconds = 90,
    [switch]$Probe
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$failures = @()

function Write-Step([string]$message) { Write-Host "== $message" }
function Fail([string]$message) { $script:failures += $message; Write-Host "FAIL: $message" -ForegroundColor Red }
function Ok([string]$message) { Write-Host "ok: $message" -ForegroundColor Green }

if (-not $DshBin) {
    throw 'Pass -DshBin <path to @deepseek-ai/dsh/lib/bin.js> (or set DSH_BIN).'
}
if (-not (Test-Path $DshBin)) { throw "dsh entry not found: $DshBin" }

$profileDir = Join-Path $DshHome 'profiles\web'
$modulesDir = Join-Path $profileDir 'node_modules'
$packageName = 'dsh-helper-plugin-command-ask'
$linkPath = Join-Path $modulesDir $packageName
$packageSource = $repo

# ── 1. scratch profile ───────────────────────────────────────────────────────

Write-Step "building the scratch profile at $profileDir"
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
New-Item -ItemType Directory -Force -Path $modulesDir | Out-Null
[System.IO.File]::WriteAllText((Join-Path $profileDir 'cordis.yml'), "[]`n", $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $profileDir 'cordis.patch.yml'), "[]`n", $utf8NoBom)
$manifest = @"
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "$packageName": "link:../../../.."
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "$packageName"
      ],
      "patchReload": "startup"
    }
  }
}
"@
# dsh reads the profile manifest with plain JSON.parse: no BOM, ever.
[System.IO.File]::WriteAllText((Join-Path $profileDir 'package.json'), $manifest, $utf8NoBom)

if ($Probe) {
    # A copy carrying a marker line, wired the same way, so the boot can prove
    # the plugin body executed without changing the checkout.
    $packageSource = Join-Path $DshHome "probe\$packageName"
    if (Test-Path (Split-Path $packageSource -Parent)) { Remove-Item -Recurse -Force (Split-Path $packageSource -Parent) }
    New-Item -ItemType Directory -Force -Path $packageSource | Out-Null
    foreach ($item in @('index.js', 'lib', 'cordis.patch.yml', 'package.json')) {
        Copy-Item -Recurse -Force (Join-Path $repo $item) $packageSource
    }
    $entry = Join-Path $packageSource 'index.js'
    $source = [System.IO.File]::ReadAllText($entry)
    $needle = "export function apply(ctx, rawConfig) {"
    $marker = @"
$needle
  try {
    process.stdout.write('ASK-PROBE apply-ran commands=' + (ctx.get('commands') === undefined ? 'no' : 'yes') + ' tools=' + (ctx.get('tools') === undefined ? 'no' : 'yes') + ' systemPrompt=' + (ctx.get('systemPrompt') === undefined ? 'no' : 'yes') + ' sessionProjections=' + (ctx.get('sessionProjections') === undefined ? 'no' : 'yes') + '\n');
    ctx.inject(['commands'], () => { process.stdout.write('ASK-PROBE commands-service-injected\n'); });
  } catch (error) {
    process.stdout.write('ASK-PROBE probe-failed ' + String(error) + '\n');
  }
"@
    [System.IO.File]::WriteAllText($entry, $source.Replace($needle, $marker), $utf8NoBom)
}

if (Test-Path $linkPath) { (Get-Item $linkPath).Delete() }
New-Item -ItemType Junction -Path $linkPath -Target $packageSource | Out-Null
Ok "profile composed over a directory link to $packageSource"

$env:DSH_HOME = $DshHome

# ── 2. dump-config ───────────────────────────────────────────────────────────

Write-Step 'dsh --profile web --dump-config'
$dump = & node $DshBin --profile web --dump-config 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { Fail "dump-config exited $LASTEXITCODE`n$dump" }
elseif ($dump -notmatch 'id:\s*command-ask') { Fail 'the composed tree has no command-ask row' }
elseif ($dump -notmatch "$packageName/index\.js") { Fail 'the command-ask row does not resolve inside the package' }
else { Ok 'the bundle patch composed a command-ask row anchored inside the package' }

# ── 3. real boot ─────────────────────────────────────────────────────────────

Write-Step 'dsh --profile web --port 0 --no-open (real activation, scratch home)'
$stdout = Join-Path $DshHome 'boot.out.txt'
$stderr = Join-Path $DshHome 'boot.err.txt'
$proc = Start-Process -FilePath 'node' -ArgumentList @($DshBin, '--profile', 'web', '--port', '0', '--no-open') `
    -PassThru -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr
$url = $null
$deadline = (Get-Date).AddSeconds($BootTimeoutSeconds)
while ((Get-Date) -lt $deadline -and -not $proc.HasExited) {
    Start-Sleep -Milliseconds 500
    $text = (Get-Content $stdout -Raw -ErrorAction SilentlyContinue) + (Get-Content $stderr -Raw -ErrorAction SilentlyContinue)
    if ($text -match 'https?://127\.0\.0\.1:\d+') { $url = $Matches[0]; break }
    if ($text -match 'fatal load failure|did not activate|plugin\(s\) failed to load') { break }
}
$output = ((Get-Content $stdout -Raw -ErrorAction SilentlyContinue) + (Get-Content $stderr -Raw -ErrorAction SilentlyContinue))
if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force; $proc.WaitForExit() }

if ($output -match 'fatal load failure|did not activate|plugin\(s\) failed to load') {
    Fail "the tree did not activate:`n$output"
} elseif ($null -eq $url) {
    Fail "no URL line within $BootTimeoutSeconds s:`n$output"
} else {
    Ok "the web profile activated and served $url"
    if ($Probe -and $output -notmatch 'ASK-PROBE apply-ran commands=yes tools=yes systemPrompt=yes sessionProjections=yes') {
        Fail "the plugin body did not report a clean apply:`n$output"
    } elseif ($Probe -and $output -notmatch 'ASK-PROBE commands-service-injected') {
        Fail "the command registration path did not run:`n$output"
    } elseif ($Probe) {
        Ok 'apply() ran in the real tree with every service resolved, and the /ask registration path executed'
    }
}

# ── 4. result ────────────────────────────────────────────────────────────────

Write-Host "scratch home: $DshHome (delete it when you are done inspecting)"
if ($failures.Count -gt 0) {
    Write-Host "`n$($failures.Count) check(s) failed" -ForegroundColor Red
    exit 1
}
Write-Host "`nall checks passed" -ForegroundColor Green
exit 0
