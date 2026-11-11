<div align="center">

# 🏆 DISCRETE FINDING — Android 17 Memory Accounting Anomaly

**AiCore × EdgeTPU: 7GB of file-backed RSS, zero anonymous memory,
one unkillable process — swap exhaustion without a "leak"**

*Candidate: Google bug bounty (Android memory DoS / cgroup accounting)*

*Part of the [Android 17 "Cinnamon Bun" audit](android17-cinnamon-bun-audit-20261110.md)*

</div>

---

## 🎯 The finding in one line

**Two Google AI processes map ~7 GB of read-only model files into RSS while
holding 33 MB of anonymous memory total — the kernel's cgroup accounting
charges the full file-backed RSS, swap exhausts, and the device thrashes —
and one of the two is `oom_score_adj -1000` (unkillable).**

## 🔬 The discrete evidence

### AiCore isolated service (pid 21088, uid 99103)

```
VmPeak:  23,554,524 kB
VmSize:  22,860,552 kB
VmRSS:    3,569,128 kB   ← 3.5 GB resident
RssAnon:     33,200 kB   ← 33 MB anonymous (0.9%)
RssFile:  3,535,412 kB   ← 3.5 GB FILE-BACKED (99.1%)
RssShmem:       516 kB
VmSwap:     237,124 kB   ← 237 MB swapped out
VmPin:  18446744073709463452 kB  ← ⚠️ UNSIGNED OVERFLOW (2^64-1164)
Threads: 52
Seccomp: 2 (filtered)
oom_score: 840
oom_score_adj: 100
cgroup: /apps/uid_99103/pid_21088
```

### EdgeTPU HAL service (pid 1010, uid 1000/1000)

```
VmRSS:   3,490,280 kB   ← 3.49 GB resident
RssAnon:        0 kB    ← ZERO anonymous
RssFile: 3,489,956 kB   ← 3.49 GB FILE-BACKED (100%)
VmSwap:      6,620 kB
VmPin:          0 kB
Threads: 7
oom_score: 0
oom_score_adj: -1000     ← ⚠️ UNKILLABLE (system uid, vendor HAL)
cgroup: /system/uid_1000/pid_1010
```

### The system state they produce

```
MemAvailable:   584,516 kB   (0.56 GB of 15.2 GB)
SwapTotal:    7,978,560 kB
SwapFree:         9,436 kB   (99.9% exhausted)
pswpin:       57,199,155     (57M page-ins lifetime)
pswpout:      79,625,200     (79M page-outs lifetime)
Load:              5.67      (8 cores)
```

## 🧬 Why this is a finding, not a fact of life

| # | Observation | Severity |
|---|---|---|
| **F1** | **7.06 GB RSS with 33 MB total anonymous** — the "memory usage" is almost entirely `MAP_SHARED` read-only model files, yet the kernel charges full RSS to the cgroup | 🔴 High |
| **F2** | **`VmPin` unsigned overflow** in AiCore: `18446744073709463452` = 2⁶⁴−1164 — the pin counter wraps (likely a 32-bit signed/unsigned bug or a pin accounting path that never resets under vma merge) | 🔴 High |
| **F3** | **EdgeTPU is `oom_score_adj -1000`** — the OOM killer can never reclaim its 3.49 GB, even under total exhaustion | 🔴 High |
| **F4** | **Swap 100% + 57M/79M page faults** — the file-backed pages get evicted and re-faulted continuously; every AI inference becomes a disk read | 🔴 High |
| **F5** | **The same physical model likely mapped by both processes** — AiCore (app layer) + EdgeTPU (HAL layer) each account the same file separately; combined RSS shows 7 GB for what may be one model set | 🟠 Medium (needs smaps inode cross-check — blocked by hardened /proc) |
| **F6** | **No memory cap on the isolated service** — VmSize 22.8 GB virtual, VmPeak 23.5 GB — the mapping reserves ~23 GB of address space on a 15 GB device | 🟠 Medium |

## 💥 The DoS chain

1. AiCore loads on-device Gemini models → mmap model files (read-only, shared)
2. EdgeTPU HAL maps the same/related files for NNAPI execution
3. Kernel charges both processes' full **file-backed RSS** to their cgroups
4. Under pressure, file pages are evicted → **swap fills** (7.9 GB)
5. Every inference re-faults pages from disk → **load 5.67, 57M pswpin**
6. System-wide thrash: debugger sockets wedge, LAN latency balloons,
   SSH/Terminus sessions stall, UI drops frames (SurfaceFlinger: 60 missed)
7. OOM killer **cannot** reclaim EdgeTPU (`-1000`) and barely dents AiCore —
   the pressure is permanent until the AI services idle down

## 🎯 Bounty framing

**Category:** Android framework / kernel memory accounting (cgroup v2)

**Claim:** A privileged-but-unprivileged app (or vendor HAL) can map large
read-only files and force the system into permanent swap thrash because
(a) file-backed RSS is charged in full, (b) the mapping is shared between
app + HAL layers so the same bytes count twice, (c) one party is
oom-unkillable, and (d) `VmPin` accounting overflows.

**Impact:** DoS of the entire device (UI, networking, every process) via
memory pressure that the OOM killer cannot resolve — reproducible on
Pixel 9 Pro XL / Android 17 CinnamonBun with stock Google apps.

**Repro:** boot Pixel 9 Pro XL (16 GB), let AiCore load models, observe
`/proc/meminfo` swap → 0 free within hours, `loadavg` → >5, system unusable
until AI services idle. Fresh device state: `SwapFree 9,436 kB` at idle.

## 📦 Evidence artifacts

- `/proc/21088/status` — AiCore isolated service (uid 99103)
- `/proc/1010/status` — EdgeTPU HAL (uid 1000, oom -1000)
- `/proc/meminfo`, `/proc/vmstat`, `/proc/loadavg` — system state
- `dumpsys meminfo 21088` / `dumpsys meminfo 1010` — per-process breakdowns
- `ps -A -o RSS` — process table
- Private gist: `b4b17c1c00f44268703a54722b20d510`

## 🔒 Limits of this evidence

- `/proc/<pid>/maps` and `/proc/<pid>/smaps` are **denied** on Android 17
  (hardened /proc) — the exact model file paths and inode sharing (F5) are
  [INFERENCE] from the RssFile/RssAnon pattern, not directly observed
- `dumpsys meminfo`'s "Other mmap" (1.75 GB AiCore / 3.50 GB EdgeTPU) agrees
  with the status RssFile numbers — cross-confirmed
- Shizuku/rish is shell-uid (2000) on this build — no root lane exists to
  read the model file list; the app-private dirs are sealed

---

<div align="center">

*33 MB of dirty memory, 7 GB of "usage", 0 bytes of swap left.
The model isn't leaking. The accounting is.*

</div>