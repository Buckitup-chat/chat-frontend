# Optical Handshake Sync Bug Fix Report

**Date:** May 26, 2026
**Project:** `chat-frontend`

## Issue Description
A bug was reported regarding the device-to-device QR optical handshake. During the process, the device that finished the handshake first would immediately hide its QR code. This left the partner device scanning a blank screen, preventing it from completing its side of the synchronization.

## Analysis
The handshake implementation is located in `chat-frontend/src/components/engines/QRScannerEngine.vue`.
When a device successfully verifies the peer, it triggers the `finishHandshake()` function. This function calls `qrScanner.stop()` and sets `scanning.value = false`. 

Because the visibility of the QR code wrapper was strictly bound to the `scanning` state (`v-show="scanning"` and `:class="{ _hidden: !scanning }"`), the final QR code (State C) disappeared instantly before the other device could read it.

## Implemented Solution
Instead of adding an arbitrary timer delay, we implemented a superior UX alternative:
When the handshake completes on a device, it turns off the camera but leaves the final QR code visible on the screen. The UI naturally replaces the camera view with the "Add Contact" interface. This provides the peer with an indefinite amount of time to complete their scan while allowing the first user to proceed.

## Code Changes
**File:** `chat-frontend/src/components/engines/QRScannerEngine.vue`

We modified the Vue template to keep the QR code visible if the internal state is marked as `completed`.

**Original Code:**
```vue
<div class="_qrh">
  <div class="_qrh_wrapper" v-show="scanning" :class="{ _hidden: !scanning }">
    <div class="_qrh_container">
      <canvas ref="qrCodeRef"></canvas>
    </div>
  </div>
  ...
```

**Updated Code:**
```vue
<div class="_qrh">
  <div class="_qrh_wrapper" v-show="scanning || state.completed" :class="{ _hidden: !scanning && !state.completed }">
    <div class="_qrh_container">
      <canvas ref="qrCodeRef"></canvas>
    </div>
  </div>
  ...
```

### Behavior Details:
1. **QR Visibility:** The `_qrh_wrapper` now remains visible if `state.completed` is `true`, even though `scanning` is `false`.
2. **Camera Stop:** The camera (`_qrh_scanner`) still correctly disappears because its visibility remains tied only to `scanning`.
3. **Reset:** When a user clicks "Scan again" (triggering `toggleScanner()`), the state is reset via `getInitialState()`, which sets `state.completed = false`. This cleanly clears the old QR code before starting the new scan.