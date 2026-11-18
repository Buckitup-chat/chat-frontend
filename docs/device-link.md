# Device-link integration

The cryptographic protocol and threat model are maintained in the
[SDK device-link documentation](https://github.com/Buckitup-chat/pq-library/blob/main/docs/device-link.md).

## Application responsibilities

- `Modal_Link_Device.vue` starts the new-device flow, displays the invite and
  waits for the user to compare the codes before importing.
- `Modal_Link_Approve.vue` is opened explicitly from Account → Add a device.
  It scans or accepts the code and asks for consent before exporting.
- `src/lib/deviceLink/room.ts` transports SDK messages over the Phoenix room.
  Socket/channel failure ends the flow visibly; a stale exchange is not resumed.
- The existing device exports the complete account through `exportBackup`.
  The new device calls `importBackup` from a user action so the browser can
  open the passkey prompt. Missing required account keys are an explicit error.
- Both screens expose the SDK comparison code. Consent and verification taps
  must not be automated away. Invite text is treated as a code, not a route
  that automatically opens the account-export screen.

A successful link makes the same account available on another device. App
login, vault creation, screens and error presentation remain frontend concerns.
