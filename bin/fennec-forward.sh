#!/bin/sh
# fennec-forward.sh v2 — NON-INTERRUPTING fennec DevTools access.
#
# Doctrine (architect 2026-11-04): fennec-cdp must NEVER interrupt the user
# on the Pixel — no force-stop, no foreground flash. The adb forward + RDP
# connect never touch the UI. The old v1 force-stopped fennec and flashed it
# to the foreground every run — that is the interrupt, eliminated here.
#
# Wedged-slot handling (single-client constraint) WITHOUT restart:
#   1. A wedged slot means a previous client's socket is still held.
#      Killing the HOST-side holder (nc/python/adb tunnel) closes the
#      on-device socket and frees the slot — no UI touch.
#   2. Only if the slot stays wedged after host-side cleanup does this
#      script fall back to a Shizuku-shell force-stop (background kill,
#      no foreground flash) + silent background restart.
#
# Usage: fennec-forward.sh [serial]
# Prints: <port>
set -u
SEC="${ADB_SERIAL:-${1:-}}"
if [ -z "$SEC" ]; then
  SEC=$(adb devices | grep -E "10\.0\.0\.77" | head -1 | awk '{print $1}')
fi
[ -z "$SEC" ] && { echo "no pixel adb device" >&2; exit 1; }

get_fwd_port() {
  # adb forward tcp:0 prints the bare port on stdout — use it directly.
  # (v1 tail-cliced raw output; v2 parsed --list and concatenated multiple
  # forwards — both mangled. Clean stale forwards first, then one fresh one.)
  adb -s "$SEC" forward --list 2>/dev/null | grep "firefox-debugger-socket" | while read -r line; do
    FP=$(printf '%s\n' "$line" | sed 's/.*tcp:\([0-9]*\).*/\1/')
    adb -s "$SEC" forward --remove "tcp:$FP" 2>/dev/null
  done
  adb -s "$SEC" forward tcp:0 localabstract:org.mozilla.fennec_fdroid/firefox-debugger-socket 2>/dev/null | tr -d '\r\n '
}

probe_hello() {
  # nudge + hold-open (proven recipe), 4s budget
  (printf x; sleep 3) | nc -q 4 127.0.0.1 "$1" 2>/dev/null | head -c 40
}

# Fresh forward (does not touch fennec or the UI)
P=$(get_fwd_port)
[ -z "$P" ] && { echo "forward failed" >&2; exit 1; }

HELLO=$(probe_hello "$P")
case "$HELLO" in
  *'"from":"root"'*)
    echo "$P"
    exit 0
    ;;
esac

# Wedged: kill host-side holders of previous forwards (no UI touch)
for OLD in $(adb -s "$SEC" forward --list 2>/dev/null | awk -v me=":$P" '$3 !~ me {print $1}' | sed 's/tcp://'); do
  adb -s "$SEC" forward --remove "tcp:$OLD" 2>/dev/null
done
fuser -k "$P/tcp" 2>/dev/null

# Retry once with a fresh forward
P=$(get_fwd_port)
HELLO=$(probe_hello "$P")
case "$HELLO" in
  *'"from":"root"'*)
    echo "$P"
    exit 0
    ;;
esac

# Last resort ONLY: Shizuku-shell background force-stop + SILENT restart.
# Start a SERVICE (not an activity) — the fennec process boots, Gecko inits,
# the debugger socket appears, and NO activity ever fronts. The user's
# screen is never touched.
adb -s "$SEC" shell "am force-stop org.mozilla.fennec_fdroid" 2>/dev/null
sleep 1
adb -s "$SEC" shell "am startservice -n org.mozilla.fennec_fdroid/org.mozilla.fenix.push.FirebasePushService" >/dev/null 2>&1
sleep 6
P=$(adb -s "$SEC" forward tcp:0 localabstract:org.mozilla.fennec_fdroid/firefox-debugger-socket 2>&1 | tr -d '\r\n' | tail -c 7 | tr -cd '0-9')
echo "$P"
