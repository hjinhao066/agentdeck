# Runs on the Windows PC, started over ssh by scripts/perf-e2e-benchmark.js (or by hand):
#   powershell -NoProfile -ExecutionPolicy Bypass -File verify-windows-background.ps1 -Mode snapshot
#   powershell -NoProfile -ExecutionPolicy Bypass -File verify-windows-background.ps1 -Mode sample -Seconds 600 -Interval 3
#
# Why sessions and not windows: an ssh login runs in session 0 and cannot enumerate the
# windows of the user's desktop session (EnumWindows / MainWindowTitle only see its own
# window station), so "no new window" cannot be read from here. What can be proven:
# every E2E process (anything started from %USERPROFILE%\agentdeck-e2e-win) lives in a
# session other than the desktop's, and no new E2E process appears in the desktop session.
# A process in session 0 cannot draw on the desktop of session 1.
param(
  [ValidateSet('snapshot', 'sample')] [string]$Mode = 'snapshot',
  [int]$Seconds = 600,
  [int]$Interval = 3
)
$ErrorActionPreference = 'SilentlyContinue'
$e2eRoot = (Join-Path $env:USERPROFILE 'agentdeck-e2e-win').ToLowerInvariant()
$threads = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors

function Get-E2eProcesses {
  Get-CimInstance Win32_Process | Where-Object {
    ($_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant().StartsWith($e2eRoot)) -or
    ($_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($e2eRoot))
  }
}

if ($Mode -eq 'snapshot') {
  # Desktop session = the session that owns explorer.exe.
  $desktop = (Get-Process explorer | Select-Object -First 1).SessionId
  "desktopSession=$desktop"
  "mySession=$((Get-Process -Id $PID).SessionId)"
  $e2e = @(Get-E2eProcesses)
  "e2eProcesses=$($e2e.Count)"
  "e2eInDesktopSession=$(@($e2e | Where-Object { $_.SessionId -eq $desktop }).Count)"
  "e2eSessions=$((($e2e | ForEach-Object { $_.SessionId } | Sort-Object -Unique) -join ','))"
  # Every process of the desktop session, to diff before/after: P|id|creation|name
  Get-CimInstance Win32_Process | Where-Object { $_.SessionId -eq $desktop } | ForEach-Object {
    "P|$($_.ProcessId)|$($_.CreationDate.ToString('o'))|$($_.Name)"
  }
  exit 0
}

# sample: time,machine cpu %,MsMpEng cpu % of the whole machine,E2E process count,E2E sessions,E2E jobs alive (anyone's; the queue wrapper is not counted)
"time,totalCpuPct,defenderCpuPct,e2eProcs,e2eSessions,jobs"
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  $total = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime
  $def = (Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "Name='MsMpEng'" | Measure-Object -Property PercentProcessorTime -Sum).Sum
  $e2e = @(Get-E2eProcesses)
  $sess = ($e2e | ForEach-Object { $_.SessionId } | Sort-Object -Unique) -join '+'
  $jobs = @($e2e | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*e2e-remote-job.js*' -and $_.CommandLine -notlike '*e2e-queue.js*' }).Count
  "{0},{1},{2},{3},{4},{5}" -f (Get-Date).ToString('o'), $total, [math]::Round(($def / $threads), 1), $e2e.Count, $sess, $jobs
  Start-Sleep -Seconds $Interval
}
