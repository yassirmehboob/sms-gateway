# Contacts, groups and scheduled SMS

The CMS now includes **Contacts & groups** and **Bulk messaging**. Existing API submissions and Android single-segment sending remain supported. No Android rebuild is required for these features.

## Address book

Choose the tenant, then add a contact using Name and Mobile_no. Address and Email address are optional. Pakistan mobile formats such as `03001234567`, `923001234567` and `+923001234567` resolve to the same contact within a tenant. Saving the same number manually updates its details. Contacts may belong to multiple groups.

Use **Download Excel template** for a ready-to-fill `.xlsx` workbook. Headers in the first worksheet are:

| Name | Mobile_no | Address | Email address |
| --- | --- | --- | --- |
| Example parent | 03001234567 | Hyderabad | parent@example.org |

Name and Mobile_no are required. Optional columns can be omitted. Imports accept up to 1,000 rows, 20 columns and a 2 MB workbook. Legacy `.xls`, password-protected workbooks and formula/date/error cells are unsupported. Save mobile numbers as text to preserve leading zeros; numeric Pakistani mobile numbers that lost their initial zero are also normalized.

**Preview import** displays valid rows, invalid-row explanations, duplicates in the file and the number already saved. Only valid contacts are imported when you press **Import valid contacts**. The first occurrence of a repeated number wins. Existing contacts keep their saved details; optional group membership is added without removing any other memberships. Repeating the import does not duplicate contacts or memberships. The import writes atomically.

Select contacts using the checkboxes, or select a page, then add them to or remove them from a group. Selection persists across search filters and pages, up to 1,000 contacts; changing tenants clears the selection.

Importing alone does not grant consent. An optional evidence reference records permission already collected for all the supplied contacts. It creates missing transactional consent records without restoring revoked consent or clearing STOP/manual suppression. An existing consent reference is retained. The action and reference are audited. Existing recipient consent controls remain available in **Recipients**.

## Sending a batch

1. Select individual contacts in the address book and choose **Message selected contacts**, or open **Bulk messaging** and choose groups.
2. Choose an enabled sending API client for the tenant, provide a batch name and message, and optionally append the opt-out footer.
3. Optionally choose a future start time. The form names your browser's timezone; times are converted to UTC for storage. Leave it blank to start now.
4. Review the confirmation and create the batch. Groups and individual selections are combined and deduplicated, with at most 1,000 recipients.

The recipient list and message are snapshotted when the batch is created. Later contact or group edits do not alter a scheduled batch. Consent, opt-out, suppression, tenant/client/device status, quotas, cooldown and duplicate-content checks are rechecked when each job is released. Sending authorization also rechecks the existing send policies.

Only one SMS segment is supported: 160 GSM units or 70 Unicode UTF-16 units, including an optional footer. The composer displays the budget. Emoji and GSM extension characters can use multiple units. The backend and Android also validate length.

Under **Limits & settings**, configure **Bulk message interval / seconds** (1–86,400; default 60). Use limits approved by your carrier. Pacing does not guarantee carrier acceptance and does not replace existing quotas.

The dispatcher keeps at most one unattempted bulk job queued globally, across campaigns, tenants and devices. The next bulk job waits for the previous authorization's permitted send window to close, then for the configured interval. Polling and processing may add delay. This avoids a batch accumulating on an offline phone and being sent in a burst on reconnection. This setting applies to CMS batches; direct API messages and STOP/START confirmations retain their existing controls. Changing the interval affects future releases, including existing pending batches. It cannot recall an issued authorization.

The start time is the earliest release time, not a promised delivery time. A batch can be scheduled up to a year ahead; unreleased recipients expire seven days after its scheduled start. Ordinary per-message expiry starts when a recipient's job is actually queued, not when the batch is created.

## Progress, pausing and failure handling

**Recipient results** shows each recipient's current status and the reason for a skip or delay. Use Refresh to update progress.

- Quotas, recipient cooldown, gateway pause and unavailable devices delay pending recipients rather than bypassing policy.
- Missing/revoked consent, STOP, manual suppression, revoked clients and content replay cause recipients to be skipped. Correcting a policy later does not automatically resend skipped recipients.
- Pause holds future releases and prevents new authorization for this batch. Already queued jobs retain their normal expiry; pausing for too long may expire that recipient's job. A paused batch can temporarily hold the single global bulk queue slot until its queued job expires.
- Cancel cancels pending recipients and unattempted queued jobs. An already authorized cellular send cannot be recalled.
- Global gateway pause retains unreleased campaign recipients, but existing global-pause behavior still cancels unattempted outbound jobs. Resume does not recreate cancelled jobs.
- COMPLETED means batch processing finished, not that every SMS was delivered. Delivery callbacks can still update recipient results later. EXPIRED, FAILED_DEFINITE and UNKNOWN are visible and never automatically resent.

The batch, recipient linkage, message reservation, idempotency record, outbox event and pacing timestamp are persisted transactionally. Concurrent workers and restarts cannot release the same recipient twice. Pending scheduling state lives in MariaDB rather than browser timers.

## Deployment

This update requires **migration 007** and the new **ExcelJS** dependency. The existing encryption key and database must be retained.

From the server directory:

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run migrate
npm.cmd start
```

On Linux/cPanel use `npm` instead of `npm.cmd`. Upload the updated `package.json`, `package-lock.json`, `dist`, `public`, `src/db/migrations`, and `app.cjs`. Install dependencies using cPanel's **Run NPM Install** or `npm ci`. Run `node dist/db/migrate.js` from the application root using the hosting terminal or an administrator-managed command, then restart the Node application. Do not just upload the previous dependency-free CMS update archive: it lacks the new dependency and schema.

Migration 007 is additive and the migration runner checks previous migration checksums. Keep backups according to your normal deployment process. Do not upload local `.env`, test databases, credentials or `.local` contents.

The running API checks campaigns every five seconds. An authenticated Android heartbeat also runs a dispatcher check, supporting hosts that idle the web process. Accurate release timing requires the backend and database to be available and the gateway phone to poll; an idle/sleeping host or offline phone can delay messages. A continuously running Node process provides the most predictable schedule. No browser tab needs to stay open. The optional FCM worker remains separate.

### cPanel migration reports WebAssembly out of memory

If the log names `tsx/dist` and reports `WebAssembly.instantiate(): Out of memory`, the TypeScript runner failed before reaching the database migration. Run the compiled migration instead:

```sh
node dist/db/migrate.js
```

The updated `package.json` makes `npm run migrate` execute that same compiled command, so it also works through cPanel's **Run JS script** control by choosing the `migrate` script. Upload the updated `package.json` to the application root first. The compiled deployment archive already includes `dist/db/migrate.js`, its dependencies under `dist`, and SQL files under `src/db/migrations`. No TypeScript build is needed on the hosting server. Keep the existing `.env` and database credentials.

Use Node 24 in cPanel to match this project's declared runtime; the reported failing environment used Node 22. After changing runtime, run cPanel's dependency installation again. Once migration reports `MariaDB migrations applied`, restart the application. `migrate:dev` remains available for local TypeScript development. A source checkout must be built before using `migrate`.

Excel workbook parsing uses [ExcelJS](https://github.com/exceljs/exceljs). The dependency lock pins the installed packages, with a patched UUID dependency override.
