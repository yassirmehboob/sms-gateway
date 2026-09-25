# FCM outbox worker

The worker sends a data-only wake-up hint through Firebase Admin. Its payload is exactly `deviceId` and `jobAvailable: "true"`. It never includes recipient numbers, SMS text, job content, credentials or send authorization. Android priority is normal, the collapse key is `gateway-work`, and TTL is at most 60 seconds or the remaining job lifetime at dispatch.

## Configuration and startup

Run `npm.cmd run migrate` from `server` to apply migration 004. Run the API normally, then run the worker as a separate process with the same MariaDB URL and content encryption key.

Configure `server/.env`:

```dotenv
FCM_ENABLED=true
FIREBASE_PROJECT_ID=your-firebase-project-id
```

Use Application Default Credentials with an authorized workload identity in production. For local development, `GOOGLE_APPLICATION_CREDENTIALS` can point to a protected service-account JSON file outside the repository. The account needs permission to send FCM messages for the configured project. Never copy service-account credentials into the Android app or commit them.

```powershell
cd server
npm.cmd run worker:fcm
```

After building, the equivalent is `node dist/fcm-worker.js`. By default `FCM_ENABLED=false`; the worker prints that it is disabled and exits without connecting to MariaDB or Firebase. Enabling it requires an enrolled, unpaused device with a signed FCM-token registration and eligible queued work before it can send a hint.

## Dispatch and recovery

The worker polls once per second and leases one eligible outbox entry for two minutes. Multiple worker processes coordinate through MariaDB. Eligibility includes job expiry/state, global/device pause, device enrollment/revocation, tenant/client authorization and recipient consent/suppression. Checks run again immediately before handing the hint to Firebase.

No database lock is held during the network request. Publication acknowledgments and failures must match the current lease token, preventing an old worker from overwriting a newer lease. A crash or lost publication acknowledgment can cause another wake-up after lease expiry. It must never cause another SMS attempt: the phone still uses the signed claim/authorization protocol and its local journal.

A pause cannot recall an in-flight Firebase request. Firebase's internal retries and delivery delays can also outlive the initial eligibility check. Hints are therefore never authority to send. Android must perform periodic reconciliation for missed/collapsed hints and enforce server/local policy, lease expiry and its attempt marker. An entry closed because the job was claimed does not automatically reopen if that unattempted claim later expires; the device's reconciliation sync handles that case.

## Failure handling

Transient failures use durable exponential backoff starting at 60 seconds, with jitter and a 15-minute base cap. A returned `Retry-After` can increase the delay. Large delays are bounded at one day, beyond the current ten-minute job lifetime; expired jobs are closed rather than retried. Unknown errors use the same conservative retry policy.

An invalid/unregistered token is cleared only if it still matches the token used by the failed request. A concurrently registered replacement is preserved. That outbox entry remains eligible for a later attempt after registration and its backoff, subject to job expiry.

Permanent payload/credential errors and token-decryption failures close the affected outbox entry. Inspect and correct the configuration; this increment has no automated replay command for permanently closed hints. The job's SMS state is unchanged and may still be claimed through device synchronization. Worker errors are logged as fixed event names, and stored provider errors are restricted to known codes; raw errors and routing tokens are not logged.

## Observability

`outbox_events` records `published_at` (FCM accepted), `retry_count`, `available_at`, `lease_until`, `abandoned_at` and `last_error`. `published_at` is neither phone receipt nor SMS transmission. The worker never changes `outbound_messages.status`.

Stop with Ctrl+C or SIGTERM. The worker finishes its active dispatch before closing connections. If a supervisor kills it first, the lease expires and another worker may retry the hint. The API reconciliation loop remains responsible for SMS job expiry and UNKNOWN handling.

## Validation

Tests use real MariaDB and a fake FCM transport: concurrency, pause/expiry checks, retries, token rotation, lease recovery and publication-acknowledgment loss are exercised without sending notifications. A live Firebase/device smoke test is still required once the project credentials and Android app are configured.

References: [FCM server environment](https://firebase.google.com/docs/cloud-messaging/server-environment), [FCM error codes](https://firebase.google.com/docs/cloud-messaging/error-codes), [message lifespan](https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-lifespan).
