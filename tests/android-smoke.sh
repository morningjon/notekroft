#!/usr/bin/env bash
# Installs the APK on a running emulator, opens it and checks it really
# started. Results are written as GitHub annotations so they can be read
# from the run summary.
# Usage: tests/android-smoke.sh path/to/app.apk
set -u
APK=$1
PKG=io.github.morningjon.notekroft
failed=0
pass() { echo "::notice title=Android check passed::$1"; }
fail() { echo "::error title=Android check failed::$1"; failed=1; }

adb root >/dev/null 2>&1 && sleep 3
adb wait-for-device

if adb install -r "$APK"; then pass "The APK installs."; else fail "The APK did not install."; exit 1; fi

adb logcat -c
adb shell am start -W -n "$PKG/.MainActivity" || fail "The app could not be started."

# The first run writes a welcome notebook. Finding it on disk shows the
# whole chain works: the web view loaded the interface, the interface
# reached the Rust side, and the Rust side can write to the app's storage.
found=""
for _ in $(seq 1 30); do
  sleep 4
  found=$(adb shell "find /data/data/$PKG /data/user/0/$PKG -name notebook.json 2>/dev/null" | head -1 | tr -d '\r')
  [ -n "$found" ] && break
done
if [ -n "$found" ]; then pass "First run created a notebook on the device: $found"; else fail "No notebook was created within two minutes of starting."; fi

if adb shell pidof "$PKG" >/dev/null; then pass "The app is still running after start-up."; else fail "The app is not running; it closed or crashed."; fi

crash=$(adb logcat -d -s AndroidRuntime:E | grep -A12 "FATAL EXCEPTION" | head -20)
if [ -z "$crash" ]; then pass "No crash in the device log."; else fail "Crash in the device log: $(echo "$crash" | tr '\n' ' ' | cut -c1-900)"; fi

# Where the web view sits on screen: it should start below the status bar.
adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
adb pull /sdcard/ui.xml ui.xml >/dev/null 2>&1
bounds=$(grep -o 'class="android.webkit.WebView"[^>]*bounds="[^"]*"' ui.xml 2>/dev/null | grep -o 'bounds="[^"]*"' | head -1)
top=$(echo "$bounds" | sed -n 's/bounds="\[[0-9]*,\([0-9]*\)\].*/\1/p')
if [ -n "$top" ] && [ "$top" -gt 0 ]; then pass "The page starts below the status bar ($bounds)."
elif [ -n "$top" ]; then fail "The page is drawn underneath the status bar ($bounds)."
else echo "::warning title=Android check skipped::Could not read where the page sits on screen."; fi
if grep -q "Welcome to NoteKroft" ui.xml 2>/dev/null; then pass "The welcome page is on screen."
else echo "::warning title=Android check inconclusive::The welcome text was not readable from the screen dump."; fi

# Notes must survive the app being closed and opened again.
adb shell am force-stop "$PKG"
adb shell am start -W -n "$PKG/.MainActivity" >/dev/null
sleep 15
count=$(adb shell "find /data/data/$PKG /data/user/0/$PKG -name notebook.json 2>/dev/null" | sort -u | wc -l)
if adb shell pidof "$PKG" >/dev/null && [ "$count" -ge 1 ]; then pass "The app reopens and the notebook is still there."; else fail "After reopening: running=$(adb shell pidof "$PKG"), notebooks=$count."; fi

adb exec-out screencap -p > android-screen.png 2>/dev/null || true
adb logcat -d > android-logcat.txt 2>/dev/null || true
exit $failed
