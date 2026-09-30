# Gateway management console

By default, open **http://127.0.0.1:3001/admin/** on the backend PC while the Node API is running. The CMS listener is separate from the LAN API address used by Android. `CMS_PORT` defaults to 3001 and can be changed in `server/.env`. The default CMS accepts only loopback connections with a localhost/IP Host header. To enable HTTPS access on your deployed domain, configure `CMS_PUBLIC_ORIGIN` and follow [the cPanel deployment instructions](cpanel.md#online-cms-without-a-cpanel-terminal).

## Login

Migration `006_admin_cms` creates the CMS and configurable policy fields. For a new installation, run from `server`:

```bat
npm.cmd run migrate
npm.cmd run build
npm.cmd run admin:create -- admin
npm.cmd start
```

For this workspace the migration and initial `admin` creation have already completed. The generated password is in `.local/cms-admin-login.txt`; it is not a shared/default password. Existing users are never overwritten by `admin:create`.

1. Sign in with the username and password in that file. Leave the authenticator field empty on the first login.
2. Select **Generate setup key**. Add a time-based entry to your authenticator app with that key, six digits and a 30-second interval. Enter the current code and verify.
3. Open **Account** to change your password (minimum 12 characters). Changing it invalidates all sessions. Store the new password securely and delete the bootstrap credentials file when no longer needed.
4. Subsequent logins require password and a current authenticator code. A code already used for login cannot be reused. After repeated failures, wait 15 minutes for the account/IP login limit to expire.

Additional trusted administrators or read-only viewers can be provisioned from the host with `npm.cmd run admin:create -- another-admin admin` or `npm.cmd run admin:create -- reviewer viewer`. Each receives a separate local credentials file and must enroll an authenticator. If an administrator loses access, a trusted host operator can create a separate recovery administrator; no unauthenticated password/MFA reset endpoint exists. External identity-provider integration and a user-lifecycle management screen remain future work.

## Screens

| Screen | Controls |
|---|---|
| Overview | Global pause/resume, device count, recent status counts, non-secret connection configuration |
| Limits & settings | Recipient quota per rolling 24 hours, destination cooldown seconds, client quota per hour, device quota per 24 hours, message lifetime, duplicate-content window, per-keyword confirmation interval |
| Recipients | Search/pagination, SMS START/STOP, separate manual suppression, consent grant/revocation, usage and next-allowed timestamp |
| Devices | Generate a new UUID, approve a copied public key, issue a ten-minute enrollment token, pause/resume, change approved SIM (pauses device), revoke |
| Tenants & API keys | Create tenants, generate/rotate/revoke client credentials; new keys are displayed once |
| Messages | Paginated delivery-state history without SMS bodies; no automatic resend for UNKNOWN |
| Audit log | Latest 100 attributed actions and change references |
| Account | Change the logged-in user's password and invalidate existing sessions |

A change reference is required for operational changes. Supply a ticket or consent reference using letters, numbers, underscores, dots, slashes, colons or hyphens. Do not enter message text or personal details in references.

Quota windows remain rolling 24 hours (recipient/device) and one hour (client). Limits are positive bounded integers. Cooldown can be set to zero; other controls still apply. New values take effect on the next acceptance without restarting Node. Existing cooldown deadlines, job expirations, idempotency entries and usage reservations are not reset. Lowering a quota below current usage blocks future requests until usage ages out.

START clears only the SMS preference. To restore delivery, existing consent must remain active and any manual suppression must also be cleared separately with an audit reference. STOP cancels unattempted jobs; START does not revive them or send an unsolicited confirmation. Older queued SMS control reports are fenced by the CMS change timestamp. The latest Android APK reconciles a previously acknowledged local STOP when it receives a fresh server-approved job; an unacknowledged/rejected STOP is never silently cleared.

Database/Firebase secrets, encryption keys and network binding stay in `.env`; the CMS shows only configuration status. Optional remote access uses an explicitly configured HTTPS origin behind the hosting TLS proxy. External identity-provider integration and general inbound-message viewing are not implemented.

## Updated SMS wording

`includeOptOut:true` appends exactly `Reply STOP to unsubscribe` on a new line. The existing template uses the same phrase.

- STOP confirmation: `Your STOP request was received. Messages are stopped. Reply START to resume.`
- START confirmation: `Your START request is received. Messages are resumed`

STOP and START now have separate confirmation intervals, so a first START after STOP can be acknowledged immediately. Repeated identical commands still do not create repeated replies; manual suppression, device quota, pause and uncertain-attempt rules still apply.

## Security and verification

Passwords use salted scrypt; authenticator secrets are AES-GCM encrypted. Server-side sessions store token hashes, expire after eight hours (15 minutes before MFA), use HttpOnly/SameSite cookies and rotate after authenticator setup. Mutations require a session-bound CSRF token, JSON and same-origin request checks. Viewer/admin authorization is checked server-side; policy changes recheck admin/session validity within the shared policy transaction. Writes and audit entries commit together, and policy edits retain before/after settings in the audit database. Raw credentials, SMS bodies and Firebase tokens are not returned by overview/status endpoints.

The implementation follows [OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) and uses [RFC 6238 TOTP](https://datatracker.ietf.org/doc/html/rfc6238). Local password/MFA authentication is implemented; this is not an external identity-provider integration or a production security certification.
