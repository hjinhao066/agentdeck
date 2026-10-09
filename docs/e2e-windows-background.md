# E2E Testing: Windows Background Execution & Performance

AgentDeck now supports running E2E tests on Windows as a background executor, keeping Mac available for user work even under high test load.

## Architecture

```
Mac (busy with other tests/work)
  ├─ Mac-only specs → run locally via e2e-queue.js (with per-spec queueing)
  └─ Cross-platform specs → route to Windows if online

Windows (user's main computer)
  └─ Cross-platform specs → run with BelowNormal priority via SSH (isolated session)
```

## Auto-Routing E2E Specs

```bash
# Simple usage: auto-detect and route
node scripts/e2e-auto.js tests/e2e/chat.spec.js

# Multiple specs
node scripts/e2e-auto.js tests/e2e/chat.spec.js tests/e2e/quota-warmup.spec.js

# Check queue status
node scripts/e2e-auto.js --status

# Pass playwright arguments
node scripts/e2e-auto.js tests/e2e/chat.spec.js -- --headed --debug
```

Detection logic:
- **Mac-only**: Specs with `skip: process.platform === 'win32'` or `test.skip(process.platform === 'win32')` always run locally
- **Cross-platform**: Route to Windows if online, otherwise local queue

## Windows Background Execution

### How It Works

1. **Isolated Session**: Tests run via SSH in a separate session, not on user's desktop
2. **Low Priority**: Process priority set to BelowNormal to not block foreground work
3. **No Windows**: Electron tests use headless/offscreen rendering, no visible windows

### Verification

Run this on Windows (PowerShell) to monitor test execution:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify-windows-background.ps1
```

Then start E2E test in another terminal. The verification script will:
- Record baseline visible windows
- Monitor for new windows during test (alert if any appear)
- Check process priorities (confirm BelowNormal)
- Report after 60 seconds

Expected output:
```
✓ No new visible windows created during test
✓ Monitored X Node process(es)
```

## Performance Benchmarking

Compare wall-clock time, concurrent throughput, and CPU impact.

### Run Benchmarks

```bash
node scripts/perf-e2e-benchmark.js tests/e2e/chat.spec.js tests/e2e/quota-warmup.spec.js
```

This will:
1. Run chat.spec.js on Mac (via queue), record time
2. Run quota-warmup.spec.js on Mac (via queue), record time
3. Run chat.spec.js on Windows (background), record time
4. Run quota-warmup.spec.js on Windows (background), record time
5. Generate comparison table

**Total time**: 30-60 minutes (depends on test duration)

### Expected Output Format

```
Spec,Mac (s),Windows (s),Speedup Factor
chat.spec.js,120.5,45.3,2.66x
quota-warmup.spec.js,85.2,32.1,2.65x

Sequential total: Mac 205.7s, Windows 77.4s (2.66x faster)
Estimated throughput with concurrent Windows:
  2 groups: 2.22x faster than sequential Mac
  3 groups: 1.96x faster than sequential Mac
```

### Interpreting Results

- **Single Group Speedup**: Windows time vs Mac time (e.g., 2.5x = tests run 2.5× faster on Windows)
- **Throughput**: Total time to run N tests sequentially on Mac vs running on Windows
- **Concurrent**: Estimated speedup if running 2-3 groups in parallel on Windows

### Hardware Reference

- **Mac**: M1 Pro (8 cores), 16 GB RAM, currently load ~150
- **Windows**: Ryzen 9 8945HX (16 cores, 32 threads), 31 GB RAM

## Configuration

### Mac Queue

- **Slots**: 1 (only one group runs at a time)
- **Concurrency**: Serialized; each spec waits for previous to complete
- **Location**: `/tmp/agentdeck-e2e-queue`

### Windows Remote

- **Concurrency**: Can run multiple groups (test with 1, 2, 3 concurrent runs)
- **Priority**: BelowNormal (doesn't block user foreground)
- **Session**: Separate SSH session (isolated from user's desktop)

## Implementation Details

### Config Changes

- `scripts/e2e-auto.js`: Routes specs to Windows or Mac queue
- `scripts/e2e-remote-job.js`: Runs Windows tests with low priority via PowerShell
- `scripts/e2e-remote-win.js`: SSH dispatcher (unchanged, already background-safe)

### Priority Setting (Windows)

```powershell
Start-Process -NoNewWindow -Wait -FilePath "node.exe" -ArgumentList @(...) -Priority BelowNormal
```

`-NoNewWindow`: Prevents console window from appearing
`-Priority BelowNormal`: Reduces scheduling priority to avoid blocking user work

## Troubleshooting

### Windows test shows visible window

Check that SSH session is properly isolated:
```powershell
# List all visible windows (run on Windows)
powershell -File scripts/verify-windows-background.ps1

# If Electron window is visible, check SSH connection:
ssh winpc "tasklist | findstr node"
```

The SSH session should be in a separate login session (SessionId != user's current SessionId).

### Tests running slowly on Windows

Common causes:
1. **Antivirus scanning**: Add test directories to Windows Defender exclusions (user decides)
2. **Low priority**: By design - can increase if needed, but will affect foreground work
3. **Network latency**: SSH overhead; expected to be <5% for typical tests
4. **Concurrent load**: Each group gets full CPU when others idle; throughput improves with parallelism

### Can't connect to Windows

1. Verify SSH key is configured: `ssh -i ~/.ssh/id_rsa winpc "echo ok"`
2. Check Windows SSH service: `Get-Service -Name sshd`
3. Firewall: Windows Defender should allow sshd (user can verify in Firewall settings)

## Next Steps

1. Run benchmarks with representative specs (chat, quota-warmup, captain)
2. Measure concurrent Windows performance (1, 2, 3 groups)
3. Document recommended concurrent group count based on user's CPU/load tolerance
4. Monitor actual foreground impact (CPU, responsiveness) during tests
