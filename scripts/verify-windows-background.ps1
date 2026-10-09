# Verify that E2E tests on Windows run in background without visible windows
# Usage: powershell -ExecutionPolicy Bypass -File scripts/verify-windows-background.ps1

# Get list of visible windows before test
function Get-VisibleWindows {
    Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class WindowHelper {
            [DllImport("user32.dll")]
            public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
            public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

            [DllImport("user32.dll")]
            public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);

            [DllImport("user32.dll")]
            public static extern bool IsWindowVisible(IntPtr hWnd);

            [DllImport("user32.dll")]
            public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
        }
"@

    $windows = @()
    $sb = New-Object System.Text.StringBuilder 256

    [WindowHelper]::EnumWindows({
        param($hWnd, $lParam)
        if ([WindowHelper]::IsWindowVisible($hWnd)) {
            $titleLength = [WindowHelper]::GetWindowText($hWnd, $sb, 256)
            [uint32]$pid = 0
            [void][WindowHelper]::GetWindowThreadProcessId($hWnd, [ref]$pid)
            $title = $sb.ToString()
            if ($title -ne "") {
                $windows += @{
                    Title = $title
                    Pid = $pid
                }
            }
        }
        return $true
    }, [IntPtr]::Zero) | Out-Null

    return $windows
}

function Check-ProcessPriority {
    param([int]$ProcessId)
    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($proc) {
        $wmiProc = Get-WmiObject Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
        if ($wmiProc) {
            $priority = $wmiProc.Priority
            return @{
                Name = $proc.Name
                Priority = $priority
                IsBelowNormal = ($priority -lt 4) # BelowNormal is 3, Normal is 2
            }
        }
    }
    return $null
}

Write-Host "=== Windows Background Execution Verification ===" -ForegroundColor Cyan
Write-Host ""

# Take baseline of visible windows
Write-Host "Recording baseline visible windows..."
$baselineWindows = Get-VisibleWindows
Write-Host "Baseline: $($baselineWindows.Count) visible windows"
$baselineWindows | ForEach-Object { Write-Host "  - $($.Title) (PID $($_.Pid))" }

Write-Host ""
Write-Host "IMPORTANT: Run E2E test on Windows while this script monitors" -ForegroundColor Yellow
Write-Host "Command: node scripts/e2e-remote-win.js HEAD tests/e2e/<spec>.spec.js" -ForegroundColor Yellow
Write-Host ""
Write-Host "The test should run without:"
Write-Host "  - Any new visible windows appearing"
Write-Host "  - PowerShell windows popping up"
Write-Host "  - Node/Electron windows visible on screen"
Write-Host ""

# Monitor process priorities and windows during test
Write-Host "Monitoring for 60 seconds..."
$startTime = Get-Date
$maxDuration = 60

$nodeProcesses = @()
$newWindows = @()

while (((Get-Date) - $startTime).TotalSeconds -lt $maxDuration) {
    # Check for new Node processes running Playwright
    $currentNodeProcs = Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*playwright*" }

    foreach ($proc in $currentNodeProcs) {
        if ($proc.Id -notin $nodeProcesses.Pid) {
            Write-Host "New Node process detected (PID $($proc.Id))"
            $priority = Check-ProcessPriority -ProcessId $proc.Id
            if ($priority) {
                Write-Host "  Priority: $($priority.Priority) (Below Normal: $($priority.IsBelowNormal))"
                if (-not $priority.IsBelowNormal) {
                    Write-Host "  ⚠️  WARNING: Process is NOT running with low priority!" -ForegroundColor Yellow
                }
            }
            $nodeProcesses += $proc
        }
    }

    # Check for new visible windows
    $currentWindows = Get-VisibleWindows
    $unknownWindows = @()
    foreach ($window in $currentWindows) {
        if ($window.Pid -notin $baselineWindows.Pid) {
            # Check if this is from a Node/Playwright process
            $proc = Get-Process -Id $window.Pid -ErrorAction SilentlyContinue
            if ($proc -and ($proc.Name -like "*node*" -or $proc.Name -like "*electron*" -or $proc.Name -like "*powershell*")) {
                $unknownWindows += $window
            }
        }
    }

    if ($unknownWindows.Count -gt 0) {
        foreach ($window in $unknownWindows) {
            Write-Host "⚠️  NEW WINDOW DETECTED: $(window.Title) (PID $($window.Pid))" -ForegroundColor Yellow
            $newWindows += $window
        }
    }

    Start-Sleep -Seconds 2
}

Write-Host ""
Write-Host "=== Monitoring Complete ===" -ForegroundColor Cyan
if ($newWindows.Count -eq 0) {
    Write-Host "✓ No new visible windows created during test" -ForegroundColor Green
} else {
    Write-Host "✗ $($newWindows.Count) new windows were created" -ForegroundColor Red
}

if ($nodeProcesses.Count -eq 0) {
    Write-Host "⚠️  No Node processes were detected - test may not have run" -ForegroundColor Yellow
} else {
    Write-Host "✓ Monitored $($nodeProcesses.Count) Node process(es)" -ForegroundColor Green
}
