<div align="center">

# 📱 Android 17 "Cinnamon Bun" — Full Hardware & Anomaly Dump

**Pixel 9 Pro XL · Tensor G4 · `komodo_beta-user` · CP31.260522.006**

`ro.build.version.release_or_codename = CinnamonBun` · SDK 37 · 2026-06-08 build

</div>

---

## 🧬 Identity

| Field | Value |
|---|---|
| **Codename** | `CinnamonBun` (Android 17) |
| **Build ID** | `CP31.260522.006` |
| **Flavor** | `komodo_beta-user` (release-keys) |
| **Fingerprint** | `google/komodo_beta/komodo:CinnamonBun/CP31.260522.006/15591510:user/release-keys` |
| **Incremental** | `15591510` |
| **Build date** | Mon Jun 8 19:15:47 UTC 2026 |
| **Known codenames** | …Baklava, VanillaIceCream, **CANARY**, **CinnamonBun** |
| **min_supported_target_sdk** | 28 |
| **first_api_level** | 34 |

## ⚙️ Silicon

| Field | Value |
|---|---|
| **SoC** | Google **Tensor G4** (`ro.soc.model`) |
| **Board platform** | `zumapro` |
| **Board** | `komodo` |
| **CPU** | 8 cores, arm64-v8a only (no 32-bit abilist) |
| **GPU** | Mali (EGL + Vulkan) |
| **Kernel** | `6.1.162-android14-11-g5e8b0cffebd1-ab15202165` — clang 17.0.2, LTO+PGO+BOLT, SMP PREEMPT |
| **Page size max** | 16384 (16K pages) |
| **Keystore/Gatekeeper** | trusty TEE |
| **Baseband expect** | `g5400c-260428-260430-B-15317676` |
| **Bootloader expect** | `ripcurrentpro-17.0-15332152` |
| **AB OTA partitions** | 31 (abl, bl1, bl2, bl31, boot, dtbo, gcf, gsa, init_boot, ldfw, modem, pbl, pvmfw, system, system_dlkm, system_ext, tzsw, vbmeta, vbmeta_system, vbmeta_vendor, vendor, vendor_boot, vendor_dlkm, vendor_kernel_boot) |

## 💾 Memory & Storage

| Metric | Value | Status |
|---|---|---|
| **RAM total** | 15,957,128 kB (15.2 GB) | |
| **MemAvailable** | **584,516 kB (0.56 GB)** | 🔴 CRITICAL |
| **Swap total** | 7,978,560 kB (7.6 GB) | |
| **Swap free** | **9,436 kB (0.009 GB)** | 🔴 **100% EXHAUSTED** |
| **pswpin** | 57,199,155 | 🔴 57M page-ins |
| **pswpout** | 79,625,200 | 🔴 79M page-outs |
| **Load avg** | **5.67 / 5.80 / 5.39** | 🔴 5.7 on 8 cores |
| **Storage /data** | 229G total, 209G used (92%) | 🟠 nearly full |

## 🧟 The Anomaly — Memory Death Spiral (RECURRED)

```
PID    RSS        NAME
21088  3,551,968  com.google.android.aicore:isolated_service  ← 3.55 GB
1010   3,490,288  vendor.google.edgetpu_app_service@1.0-service ← 3.49 GB
1598     662,324  system_server
17715    501,664  org.mozilla.fenix:sandboxed_tab_…
6613     325,980  com.deepseek.chat
2289     322,356  com.android.systemui
```

**7.04 GB of 15.2 GB RAM** eaten by two Google AI services:

- **AiCore** `26.10.15.7.release.prod_aicore_20261015.00_RC07` — 3.55 GB
- **EdgeTPU** app service — 3.49 GB

With swap at **100%** and 57M/79M page in/out counters, the device is
**thrashing**. This is the same death spiral previously diagnosed
(2026-11-10): AiCore + EdgeTPU consume ~46% of RAM, swap fills, every process
faults to disk, LAN latency balloons, SSH/Terminus sessions stall.

### Symptom chain observed this session

1. `adb forward` to Fennec debugger socket → connect accepted → **zero bytes**
2. `ss -x` → **5× SYN-SENT, no LISTEN** — debugger server starved/killed by
   memory pressure, abstract socket name lingers in the unix namespace
3. Host-side `fuser -k` + forward re-add → **still wedged** (on-device state)
4. `am force-stop` + `am startservice` via rish → **recovered** (new PIDs,
   handshake OK)

### Why the wedge is OS-level on CinnamonBun

- `targetSdk=37` apps see the new SDK's socket lifecycle
- The debugger socket namespace keeps **stale SYN-SENT entries** after the
  server dies under memory pressure — no LISTEN entry, yet the name persists
- Fennec accepts **one** debugger connection; a killed client wedges the slot
  until process restart
- `rish` (Shizuku v13) is the sanctioned elevated lane: `/data/local/tmp/rish`
  with `RISH_APPLICATION_ID=com.termux` (shipped `PKG` placeholder fixed)

### Anomaly ledger

| # | Anomaly | Evidence | Status |
|---|---|---|---|
| A1 | **AiCore 3.55GB + EdgeTPU 3.49GB = 46% RAM** | `ps -A -o RSS` | 🔴 recurring |
| A2 | **Swap 100% exhausted** (9MB free of 7.9GB) | `/proc/meminfo` | 🔴 recurring |
| A3 | **Load 5.67** on 8 cores with idle UI | `/proc/loadavg` | 🔴 |
| A4 | **57M pswpin / 79M pswpout** | `/proc/vmstat` | 🔴 lifetime counters |
| A5 | **Debugger socket wedge** (SYN-SENT, no LISTEN) | `ss -x` via rish | ✅ fixed (force-stop) |
| A6 | **/data 92% full** (20G free) | `df -h /data` | 🟠 |
| A7 | **GPU missed frame count 60** | SurfaceFlinger | 🟠 |

---

## 🔧 Session Fixes (this audit)

1. **rish refs fixed** — `RISH_APPLICATION_ID="PKG"` → `"com.termux"` in
   `/data/local/tmp/rish`; `rish -c 'id'` now works
2. **Fennec RDP recovered** — force-stop + FirebasePushService restart via
   rish; handshake OK; repo opened on-device via RDP eval
3. **RDP protocol ground truth** — length-prefixed both ways, passive hello,
   attach-before-getTarget (reconciled from 3 live impls, `src/rdp.ts`)
4. **LuaJ bridge fixed** — `new()` unwrap bug (LuaValue userdata vs raw Class);
   `LuaJPatch` force-hotpatch shim; 9/9 TDD green
5. **OwnTV lane live** — `:38383` up with patched bridge, force-sync ready

## 📦 Artifacts

- Hardware dump: this file
- RDP client: `pens/fleet/devices/fennec-cdp/src/rdp.ts`
- LuaJ shim: `pens/fleet/devices/android-fleet/products/luaj-dropin/`
- Private gist: `android17-cinnamon-bun-audit-20261110.md`
- **Deep dives:**
  - [AiCore × EdgeTPU modular deep-dive](aicore-edgetpu-deep-dive-20261110.md)
  - [🏆 Bounty-grade discrete finding — memory accounting anomaly](aicore-edgetpu-bounty-finding-20261110.md)

---

<div align="center">

*Cinnamon Bun: Android 17 — where the AI eats the RAM and the debugger eats the socket.*

</div>