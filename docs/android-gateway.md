# Android gateway

The first Android implementation targets a dedicated, privately distributed phone running Android 10/API 29 or later. It supports the backend's single-segment outbound templates and custom text. STOP/START replies are processed on the selected SIM. General inbound collection, a default-SMS messaging UI, public Play distribution and multipart sending are not implemented.

## Build

Use JDK 17, Gradle 8.13, Android SDK platform 36 and build-tools 35.0.0. Open `android` in Android Studio or run:

```powershell
cd android
.\gradlew.bat testDebugUnitTest assembleDebug lintDebug
```

Set `JAVA_HOME` to JDK 17 and configure the Android SDK using `ANDROID_HOME` or `android/local.properties`. The generated debug APK is `android/app/build/outputs/apk/debug/app-debug.apk`. Debug builds are for controlled testing; production signing and release approval are separate tasks.

For FCM, register the application ID `com.example.smsgateway` in the same Firebase project used by the backend and place its Android `google-services.json` in `android/app`. The ignored file is optional for builds: manual and periodic synchronization work without it. Never put a service-account key in the APK.

Run the current backend before connecting the phone. The authorization response now includes `validForMs`, a server-relative lifetime required by this Android client; the field is additive and requires no database migration.

## Pair and activate

### Local HTTP testing with the debug APK

Debug builds accept HTTP origins with private IPv4 addresses (10.x.x.x, 172.16–31.x.x, or 192.168.x.x). Release builds require HTTPS. HTTP exposes message content on the network; use it only for development on a trusted LAN.

1. Connect the phone and PC to the same LAN. Run `ipconfig` on the PC and find its active Wi-Fi/Ethernet IPv4 address.
2. In `server/.env`, set `HOST` to that address, for example `HOST=192.168.1.10`, and `PORT=3000`. Restart the backend with `npm.cmd run dev` (or build and start). The default HOST remains loopback.
3. Allow inbound TCP port 3000 on the Windows private network if the firewall blocks the phone.
4. Install the updated debug APK over the existing app. Enter `http://192.168.1.10:3000` as the origin, substituting the actual PC address, with no `/api` path. Enter the backend-created UUID and save.
5. Continue with SIM confirmation and enrollment below. An already saved identity remains fixed. Do not clear an active gateway's storage to switch addresses; revoke and reprovision it with a new device identity.

1. Install the app on the dedicated test phone. It starts paused. Configure a reachable **HTTPS origin** (or local HTTP for debug testing as above) and the device UUID created by the backend operator. Origin paths and embedded credentials are rejected. Android localhost is the phone, not your development PC.
2. Copy the public key using the app button. The operator verifies the physical device/key and issues `device-enrollment` using that public key. The private key stays in Android Keystore.
3. Grant SEND_SMS, RECEIVE_SMS and READ_PHONE_STATE through the system prompt, plus notifications for background mode. Select the operator-approved SIM; the displayed subscription ID must match the backend device assignment.
4. Enter the one-time challenge and enroll. If the response was lost, use **Recover enrollment / check server**. Successful enrollment remains paused. The challenge is not persisted.
5. Provision actual recipient consent and resume the device/global gateway on the backend. Press **Resume gateway** locally. Only approved server jobs can be sent; the app has no arbitrary-recipient composer or force-send control.
6. Press **Sync now** to test. The ongoing foreground gateway service polls every 30 seconds while enabled. FCM hints and a WorkManager job with a 15-minute minimum interval also trigger synchronization. Android background scheduling is best-effort; a ten-minute server job can expire before periodic work runs.

The saved server/device identity is fixed for that installation. Reprovisioning requires revoking the old identity and explicitly clearing/reinstalling with a new identity; never restore or copy an attempt journal or signing key to another phone. Backup and device-transfer exclusions protect local state.

## Send safety

Room inserts a permanent job-ID tombstone before the authorization request. Duplicate claims, new leases, process restarts and failed/lost responses cannot remove it or permit another automatic attempt. Outbound recipient numbers and SMS text exist only in memory; the attempt journal retains job/lease IDs, content hash, subscription and callback correlation. Pending STOP/START records additionally retain an encrypted sender address until acknowledgment. Settings and FCM tokens are encrypted with an Android Keystore AES-GCM key.

The app verifies the content hash, selected subscription, slot/carrier metadata, one-segment limit, local pause/permissions and deadlines. Authorization is not automatically retried by the HTTP client; redirects are also disabled. The server-relative lifetime is measured from the beginning of the authorization request using Android's monotonic clock, with a five-second safety margin and twenty-second maximum request-to-send interval. Wall-clock deadlines are an additional conservative check.

The short final send check shares a local lock with the Pause button. Pause cannot recall a cellular transmission already invoked. Subscription IDs and carrier/slot metadata are checks, not cryptographic SIM identity; the operator must verify the physical SIM, particularly after SIM replacement.

Sent callbacks use immutable explicit PendingIntents. Delivery callbacks require the OS to fill in the delivery PDU, so they use a mutable **explicit** PendingIntent to a non-exported receiver, bound to a persisted random callback ID. Only a successful delivery status is reported as DELIVERED. This is a deliberate exception to the plan's general immutable-PendingIntent preference. Generic send errors are UNKNOWN, rather than claiming a definite failure without sufficient evidence.

Callbacks are durably queued with stable event IDs. Upload retries use new request signatures but the same event ID. Rejected events are retained as blocked records for operator review, with a count on the status screen. The server handles missing callbacks by marking stale attempts UNKNOWN; neither side requeues them automatically.

## Required device validation

Before a real rollout, test permission denial/revocation, SIM removal/replacement, dual-SIM selection, app kill before/after authorization, duplicate FCM, lost authorization response, offline callbacks, reboot, Doze and expired leases on the intended phone. Check actual SEND_SMS eligibility for the chosen distribution and Android version. The app requests RECEIVE_SMS only for selected-SIM STOP/START handling; it does not request READ_SMS or collect an inbox.

The Room restart instrumentation test can run with `connectedDebugAndroidTest` on an emulator/device and sends no SMS. Real cellular tests require a dedicated phone, approved SIM and authorized recipient. See verification.md for tests actually executed; code/build completion is not a real-SIM acceptance result.

References: [Android SMS APIs](https://developer.android.com/reference/android/telephony/SmsManager), [Android Keystore](https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec), [WorkManager](https://developer.android.com/jetpack/androidx/releases/work), [AGP compatibility](https://developer.android.com/build/releases/agp-8-13-0-release-notes).
