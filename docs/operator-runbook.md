# Local operator CLI

Run from `server`: `npm.cmd run operator -- operator-command.json`.

This is a trusted host utility using `DATABASE_URL`, not an API endpoint. Restrict host access and database credentials to authorized operators. `actorId` records attribution and does not authenticate the person; the local CMS now provides authenticated password/TOTP sessions and admin/viewer roles. Keep command files private because consent commands contain recipient numbers. The ignored `operator-command*.json` naming convention helps prevent accidental commits.

Every command requires an operator UUID and a ticket/reference containing only letters, digits, `_ . : / -`. References must identify an external approval/consent record; do not put SMS bodies or personal details in audit references.

```json
{
  "actorId": "00000000-0000-4000-8000-000000000099",
  "reasonReference": "CHANGE-123",
  "command": { "action": "global-pause", "paused": true }
}
```

Replace `command` with one of the following shapes. UUIDs are identifiers, and the device/SIM and recipient must be verified by the operator.

| Action | Additional command fields |
|---|---|
| `global-pause` | `paused`: boolean |
| `device-create` | `tenantId`, `deviceId`, `simId`: nonnegative integer |
| `device-enrollment` | `tenantId`, `deviceId`, `publicKey`: approved P-256 SPKI PEM; returns a sensitive one-time enrollment token |
| `device-pause` | `tenantId`, `deviceId`, `paused`: boolean |
| `device-revoke` | `tenantId`, `deviceId` |
| `consent-grant` | `tenantId`, `number`, `purpose`: `transactional_notification`, `evidenceReference` |
| `consent-revoke` | `tenantId`, `number`, `purpose`: `transactional_notification` |
| `client-revoke` | `tenantId`, `clientId` |

For development, `seed:dev` creates tenant `00000000-0000-4000-8000-000000000001` and client `00000000-0000-4000-8000-000000000002`. Device creation starts paused and only creates a server-side assignment record; it does not pair or authenticate a phone. Grant actual documented consent, explicitly resume the intended device, then resume the global gateway to exercise queue acceptance. This increment still has no SMS transport.

Pause and revocation cancel QUEUED/CLAIMED work without an attempt marker. Reservations, cooldowns and attempted/UNKNOWN states are retained. Resuming does not revive cancelled jobs. A revoked device cannot be resumed. Consent renewal does not clear suppression; there is no suppression-bypass command.

Each command takes the same InnoDB policy lock as message submission and commits its audit entry with the mutation. If the audit write fails, the policy change rolls back. Audit data includes actor, action, tenant, resource, reason reference and a recipient hash when applicable. Hashes are pseudonymous identifiers, not anonymization.

After `device-create`, use `device-enrollment` to approve the phone's public key and issue a ten-minute challenge. The CLI output contains a sensitive token; transfer it privately and avoid terminal/session logs that retain secrets. Enrollment does not resume the device. See the [signed protocol](device-protocol.md) for the exact phone-side exchange and lost-response handling.
