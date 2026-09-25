# STOP/START and background gateway

## Upgrade

1. Stop the Node API and FCM worker. From `server`, run `npm.cmd run migrate` to apply `005_sms_controls`, then `npm.cmd run build` if running compiled code. Restart both processes. Existing tenant, device and consent records remain in place.
2. Install the new debug APK over the existing app, using the same signing key. Do not uninstall or clear storage: Room migrates the journal from version 1 to 2 while preserving permanent attempt markers.
3. Open the app and tap **Grant SMS, reply and notification permissions**. Allow RECEIVE_SMS as well as SEND_SMS and phone state. The app still does not request READ_SMS or import an inbox.
4. Confirm the selected SIM if needed, then tap **Resume gateway**. Look for the ongoing **SMS gateway running** notification, with its Pause action. Resume does not override backend pause.
5. Open **Open app settings / battery settings** and select unrestricted battery/background activity if available on the phone. Enable the manufacturer's auto-start setting if required. Keep this dedicated gateway phone charged and connected to the backend network.

## API option

```json
{
  "to": "+923001234567",
  "body": "Your order is ready for collection.",
  "includeOptOut": true
}
```

The server appends `Reply STOP to unsubscribe` on a new line. Final text, including this suffix, must fit one SMS segment. The option is optional and defaults to no suffix for custom text. STOP is honored for known recipients regardless of whether the suffix was included. Template messages already contain STOP instructions.

## What replies do

- The recipient replies to the gateway SIM's phone number with exactly **STOP** or **START** (case-insensitive; surrounding whitespace is accepted). Other text, alphanumeric senders, invalid/mobile-external numbers and messages with absent or wrong receiving-SIM metadata are ignored. The backend recognizes only recipients previously queued a normal message through that enrolled phone.
- STOP sets a global SMS opt-out for that number and cancels all unattempted normal jobs for it, including existing claims. New API requests return `403 RECIPIENT_OPTED_OUT`. A phone-local block is recorded before command upload, and checked again immediately before sending. No software can recall an SMS already submitted to the modem.
- The system queues a fixed STOP confirmation: `Your STOP request was received. Messages are stopped. Reply START to resume.` This is the only STOP-related reply; repeated STOP messages do not create repeated confirmations.
- START clears the SMS opt-out. It does not clear operator/API suppression, create/revive consent, reset quotas/cooldown, or revive cancelled jobs. If eligible, a fixed START confirmation is queued. Submit a new normal API request after normal policy permits it.
- Confirmations use the same signed claim, one-time authorization and callback flow. They can bypass only the SMS opt-out/recipient consent/cooldown checks needed for the fixed reply. They still require an enabled tenant/client, authorized scope, non-revoked device, selected SIM, global/device/local resume, no manual suppression and remaining device budget. At most one confirmation per state transition and per number/keyword within the CMS-configured interval (five minutes by default). STOP and START use separate intervals, so a first START can confirm immediately after STOP. They expire after ten minutes and do not retry uncertain attempts.
- Device request signatures, event IDs and sender timestamps protect upload integrity and suppress duplicate/older event processing. These verify the enrolled phone's report, not cryptographic ownership of the cellular sender number; SMS sender spoofing is a carrier-level limitation.

Only command metadata and an encrypted sender address are queued on the phone. Unrelated SMS content is not retained or uploaded. Acknowledged encrypted payloads are cleared while event tombstones remain. The server retains event hashes/results for deduplication; retention cleanup is a future operation. Failed commands remain visible in the pending/rejected count and keep the local recipient blocked for review. Offline replies reconcile before the phone claims new messages. A newer local STOP cannot be cleared by an older START acknowledgment.

## Background behavior

Resume starts a user-visible foreground service for this private dedicated-phone deployment. It polls directly every 30 seconds after the previous sync finishes, sharing the same synchronization/send locks with WorkManager. A bounded, renewed CPU wake lock keeps polling active while enabled; this consumes battery. FCM and the 15-minute WorkManager schedule remain additional triggers. The service requests a sticky restart after process reclamation and resumes on boot/app update when previously enabled. A foreground notification Pause action stops it.

Checking enrollment no longer resets an already enabled phone to paused. Recipient-specific API rejections do not pause the entire phone. Claims invalidated by policy are cancelled instead of permanently blocking the head of the queue. Authentication failures and SIM mismatch still pause locally.

Swiping the activity away is supported; the foreground service is not tied to the task. **Force stop**, the Android active-app Stop action, OEM process restrictions, loss of permissions, Doze/network restrictions and loss of PC connectivity can still interrupt service. Open the app again after Force stop; do not expect an app to override Android's user stop controls. Thirty seconds is a polling interval, not a delivery-time guarantee. Foreground service `specialUse` is declared for the dedicated SMS gateway; public store distribution would require its own policy review. See [Android foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types) and [background-start restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start).

## Acceptance test on the actual phone

1. Send a short test message with `includeOptOut:true` to a consenting second phone. Keep the gateway screen closed and confirm delivery without pressing Sync.
2. Reply STOP from that second phone. Confirm receipt of the fixed reply and API rejection for that number. Ensure queued normal messages were cancelled.
3. Repeat STOP: no extra confirmation should be queued. Reply START to observe its separate confirmation. Send a new, different message once quotas/cooldown allow.
4. Test screen-off, swipe-away, reboot, offline STOP then reconnect, dual-SIM reception and permission revocation. A STOP on another SIM must not affect this gateway. Check that a forced stop requires manual reopening.
5. Review server message status, the app's pending/rejected command count and the ongoing service notification. Automated build/integration tests do not prove real carrier or OEM background behavior.
