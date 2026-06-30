# setup-autosync.ps1 — one-time setup of mecflow auto-sync on THIS PC.
# Safe to re-run. Clones the repo if missing, installs the sync worker + a scheduled task
# that pulls+commits+pushes every 15 minutes while you are logged on.
$ErrorActionPreference = "Stop"
$repoUrl  = "https://github.com/apapafragas-prog/mecflow.git"
$repo     = Join-Path $HOME "mecflow"
$worker   = Join-Path $HOME "mecflow-autosync.ps1"
$log      = Join-Path $HOME "mecflow-autosync.log"
$taskName = "mecflow-autosync"

Write-Host "=== mecflow auto-sync setup ===" -ForegroundColor Cyan
Write-Host "PC: $env:COMPUTERNAME   User: $env:USERNAME"
Write-Host "Folder: $repo`n"

# 0) git installed?
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host "ERROR: Git is not installed. Install it from https://git-scm.com/download/win then re-run." -ForegroundColor Red
  Read-Host "Press Enter to exit"; exit 1
}

# 1) clone if missing (first time a GitHub login window may appear - approve it once)
if (-not (Test-Path (Join-Path $repo ".git"))) {
  Write-Host "Cloning mecflow ... (log in to GitHub once if asked)" -ForegroundColor Yellow
  git clone $repoUrl $repo
  if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: clone failed (GitHub login/access?)." -ForegroundColor Red; Read-Host "Press Enter to exit"; exit 1 }
} else {
  Write-Host "Repo already present - good." -ForegroundColor Green
}

# 2) write the sync worker (this PC's paths baked in)
$tpl = @'
$repo = "__REPO__"
$log  = "__LOG__"
function L($m){ "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" | Out-File -Append -Encoding utf8 $log }
function RunGit([string]$a){ cmd /c "git $a 2>&1" | Out-File -Append -Encoding utf8 $log; return $LASTEXITCODE }
if (-not (Test-Path "$repo\.git")) { L "ERROR: repo missing"; exit 1 }
Set-Location $repo
L "----- autosync run -----"
$rc = RunGit "pull --rebase --autostash"
if ($rc -ne 0) { $null = RunGit "rebase --abort"; L "WARN: pull conflict aborted; pushing local only" }
$null = RunGit "add -A"
cmd /c "git diff --cached --quiet"
if ($LASTEXITCODE -ne 0) { $stamp = "auto-sync_" + (Get-Date -Format 'yyyy-MM-dd_HH-mm'); $null = RunGit "commit -m $stamp"; L "committed local changes" } else { L "no local changes" }
$null = RunGit "push"
L "----- done -----"
'@
$tpl = $tpl.Replace("__REPO__", $repo).Replace("__LOG__", $log)
$tpl | Out-File -Encoding utf8 $worker
Write-Host "Installed sync worker: $worker" -ForegroundColor Green

# 3) register scheduled task (every 15 min, runs in your session, no stored password)
try {
  $a = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $worker)
  $t = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(2)) -RepetitionInterval (New-TimeSpan -Minutes 15)
  $p = New-ScheduledTaskPrincipal -UserId ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME) -LogonType Interactive
  $s = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
  Register-ScheduledTask -TaskName $taskName -Action $a -Trigger $t -Principal $p -Settings $s -Description "Auto pull/commit/push mecflow to GitHub every 15 min" -Force | Out-Null
  Write-Host "Scheduled task '$taskName' registered (every 15 min)." -ForegroundColor Green
} catch {
  Write-Host "ERROR registering task: $_" -ForegroundColor Red
  Write-Host "Tip: right-click this file -> Run with PowerShell, or run PowerShell as Administrator." -ForegroundColor Yellow
  Read-Host "Press Enter to exit"; exit 1
}

# 4) test once + show result
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $worker
Write-Host "`nLast log lines:" -ForegroundColor Cyan
Get-Content $log -Tail 5
Write-Host "`nDONE - auto-sync active. Your mecflow work syncs to GitHub every 15 min." -ForegroundColor Green
Read-Host "Press Enter to close"
