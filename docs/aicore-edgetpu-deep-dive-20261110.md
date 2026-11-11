<div align="center">

# 🧠 AiCore × EdgeTPU — Modular Deep Dive

**The 7GB memory death spiral, dissected**

*Part of the [Android 17 "Cinnamon Bun" audit](android17-cinnamon-bun-audit-20261110.md) → Anomaly A1/A2*

</div>

---

## 📊 The headline numbers

| Process | RSS | PSS | Private Dirty | SwapPss | `Other mmap` RSS |
|---|---|---|---|---|---|
| `com.google.android.aicore:isolated_service` (AiCoreIsolatedService) | **3,556,576 KB** | 1,974,475 | **92 KB** | 226,284 | **1,747,188 KB** |
| `vendor.google.edgetpu_app_service@1.0-service` | **3,501,744 KB** | 1,754,263 | **92 KB** | 6,460 | **3,498,128 KB** |
| **Combined** | **7.06 GB** | 3.73 GB | 184 KB | 232 MB | **5.25 GB** |

## 🔍 The insight: it's not a leak, it's a mapping

The classic diagnosis would say "AiCore leaks 3.5GB". The meminfo says
otherwise:

- **Private Dirty: 92 KB** — the process has almost NO writable private memory
- **`Other mmap`: 1.75–3.50 GB RSS with 0 Private Dirty** — read-only shared
  mapping
- **PSS (1.97 GB) ≪ RSS (3.56 GB)** — the pages are shared across processes

This is the **model-file mapping pattern**: the TPU/NPU model weights are
mmap'd read-only (MAP_SHARED | MAP_NORESERVE) so the kernel can evict and
re-fault them. It's *efficient* by design — until the cgroup accounting still
charges the full RSS against the device's memory limit.

## 🧬 AiCore profile

| Field | Value |
|---|---|
| **Package** | `com.google.android.aicore` |
| **Version** | `26.10.15.7.release.prod_aicore_20261015.00_RC07` (v545237) |
| **minSdk/targetSdk** | 34 / 36 |
| **Installed** | 2026-01-08 |
| **Last update** | 2026-11-10 20:12 (updated TODAY) |
| **Processes** | `com.google.android.aicore` (85 MB) + `:isolated_service:AiCoreIsolatedService` (3.55 GB) |
| **Threads** | 53 (isolated service) |
| **Native heap** | 220 MB alloc of 255 MB (legit, not the 3.5GB) |
| **Role** | On-device Gemini/AI model runtime (LLM + embeddings) |

## 🧬 EdgeTPU profile

| Field | Value |
|---|---|
| **Service** | `vendor.google.edgetpu_app_service@1.0-service` |
| **Version** | v395592 (minSdk 33, targetSdk 37) |
| **HAL** | `android.hardware.neuralnetworks.IDevice/google-edgetpu` |
| **AIDL** | `com.google.edgetpu.IEdgeTpuAppService/default` |
| **Threads** | 8 |
| **Role** | Tensor processing unit driver — serves NNAPI accelerations to any app |

## 🔗 The shared-memory hypothesis

`Other mmap` of 1.75 GB (AiCore) + 3.50 GB (EdgeTPU) with **0 private dirty**
in both strongly suggests **the same underlying model buffer is mapped into
both** (AiCore loads the model; EdgeTPU's HAL maps the same file for
execution). The kernel's cgroup charges each mapping's RSS, so the *same
physical model* can appear as 5+ GB of "used" memory across two processes.

[INFERENCE] — to prove: compare `/proc/<pid>/smaps` for the largest mapping
and check if the file paths (or inode numbers) match between the two PIDs.

## 💥 Why it kills the device

1. **Swap 100% exhausted** (9 MB free of 7.9 GB) — the cgroup pushes the
   model pages out under pressure
2. **57M pswpin / 79M pswpout** — every AI inference re-faults the model from
   disk
3. **Load 5.67** on 8 cores — page-fault storms + compaction
4. **Debugger sockets wedge** (SYN-SENT, no LISTEN) — Gecko's debugger server
   starved/killed, abstract socket name lingers
5. **LAN latency balloons, SSH stalls** — the whole device thrashes

## 🛠️ Mitigation ladder (doctrine: read-only device, no kills)

| Step | Action | Risk |
|---|---|---|
| 1 | Monitor: `dumpsys meminfo <pid>` + `/proc/vmstat` deltas | none |
| 2 | Check `smaps` for shared inode between the two PIDs | none (read) |
| 3 | `cmd thermalservice` / `dumpsys battery` for thermal throttling | none |
| 4 | Disable AiCore's on-device models via `pm disable-user` | **REQUIRES USER OK** |
| 5 | Clear AiCore cache (`pm clear com.google.android.aicore`) | loses model cache, **REQUIRES USER OK** |
| 6 | Force-stop (user-sanctioned lane only) | temporary |

**Pixel is read-only per doctrine** — diagnostics only unless the user
explicitly authorizes a mutation.

## 📦 Artifacts

- Full audit: `docs/android17-cinnamon-bun-audit-20261110.md`
- Private gist: `b4b17c1c00f44268703a54722b20d510`
- Live probes: `dumpsys meminfo 21088` / `dumpsys meminfo 1010` (2026-11-10)

---

<div align="center">

*7 GB of "used" RAM, 184 KB of dirty. The model is mapped, not leaked.*

</div>