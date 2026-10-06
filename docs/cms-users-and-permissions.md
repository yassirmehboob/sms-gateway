# CMS users, tenant assignments and permissions

Migration **008_cms_access** adds **CMS users** to the management console. Existing administrator accounts become super administrators, preserving access. Existing viewers retain their previous all-tenant read access without gaining user management. New accounts default to no section or tenant access until explicitly assigned.

## Create an account

Sign in as a super administrator and open **CMS users**. Enter a username, choose the account type, select tenants and choose the rights for each section. Save with a change reference.

- **Super administrator:** full access to every tenant and section, including CMS user management.
- **Delegated administrator:** one or more selected tenants, or explicitly all tenants, with individual section permissions.
- **Read-only viewer:** selected/all tenants with view-only section access.

The generated password is displayed once. Share it securely with the account owner. Their first login requires authenticator enrollment before opening the console. They can change their password under **Account**. Passwords are stored as salted hashes, never returned by the user list or written into audit details.

**All tenants** includes future tenants. An explicit selection only grants the tenants checked. An account with no tenant assignments cannot access tenant data. Up to 200 tenant assignments are supported per account.

## Section rights

Each section can be denied, viewed, or managed where actions exist. Manage includes View. Account/password controls remain available to every signed-in user.

| Section | View | Manage |
| --- | --- | --- |
| Overview | Aggregate status for assigned tenants | Global gateway pause/resume, requiring all-tenant access |
| Limits & settings | Read gateway settings | Change global quotas, cooldowns and bulk interval, requiring all-tenant access |
| Recipients & consent | Known recipients, preferences and usage within assigned tenants | Grant/revoke consent within assigned tenants; shared STOP and manual suppression controls additionally require all-tenant access |
| Contacts & groups | Browse assigned tenants' contacts and groups | Create/update/import contacts and manage groups/memberships |
| Bulk messaging | Batch history and recipient results within assigned tenants | Create, schedule, pause, resume and cancel batches |
| Devices | Assigned tenants' gateway devices | Register, enroll, pause/resume, revoke and change approved SIM |
| Tenants & API keys | Assigned tenants and client metadata | Issue/rotate/revoke their API keys; creating a new tenant additionally requires all-tenant access |
| Message history | Assigned tenants' messages and status | No additional write actions |
| Audit log | Assigned tenants' audit entries; all-tenant users can also see global entries | No additional write actions |
| CMS users | Super administrators only | Create accounts, edit assignments/rights, disable accounts and reset passwords |

The bulk composer can list group names/member counts and its sending API clients even without contact or client-management rights. Individual contact selection additionally needs contact view access. Recording consent during contact entry/import requires both Contacts Manage and Recipients Manage.

Platform defaults now support tenant overrides; see [Tenant defaults and expiry](tenant-defaults-and-expiry.md). Recipient STOP/suppression and recipient usage/cooldown protections remain shared across tenants. Assigned-tenant administrators can manage their own consent records but cannot alter shared suppression/preferences through the CMS. Section rights apply uniformly to all tenants assigned to an account.

CMS permissions control console access. Existing API credentials remain independent: removing a CMS user's access does not revoke API keys they previously issued. API-key management includes the ability to issue sending credentials for assigned tenants. Revoke an API client separately when its credentials should stop working.

## Change or revoke access

Use **Edit access** to change assignments, rights or enabled status. Saving invalidates all sessions belonging to that account, so it must sign in again. A disabled account cannot log in. Every write rechecks the user's current session and permission inside the policy transaction; hiding menu buttons is not the enforcement mechanism.

When an account loses Bulk Manage, is disabled, becomes a viewer or loses a tenant assignment, its unattempted scheduled work for affected tenants is cancelled. Already authorized SMS attempts cannot be recalled. The dispatcher and device send policy also check the creator's current access. Restoring rights does not recreate cancelled batches.

**Reset password** generates a new password and signs the user out. It preserves the enrolled authenticator and does not enable a disabled account. Existing passwords and authenticator secrets cannot be viewed in the console.

A super administrator cannot change their own access or reset their own password through this screen. Use Account for a personal password change, and another super administrator for access changes. The backend also guards against removing the last enabled, MFA-enrolled super administrator. User changes and audit entries commit together; failed writes do not partially change access.

Host operators retain the existing bootstrap path. After building/migrating, `node dist/admin-create.js recovery-admin admin` creates a new super administrator; the `viewer` option creates an all-tenant viewer. Existing usernames are never overwritten. The command writes generated credentials to the existing ignored local credentials directory.

## cPanel deployment

Use `.local/cpanel-cms-users-update.zip`. It contains compiled JavaScript, static CMS files, package manifests and all migration SQL files. Keep the deployment's existing `.env`, encryption key and database credentials.

1. Upload/extract the archive into the Node application's root, replacing `dist`, `public`, `src/db/migrations`, `app.cjs`, and the package manifests.
2. Use Node 24 as declared by the project. This increment adds no dependency beyond the prior contact/Excel update; if upgrading from an earlier installation, run the cPanel dependency installation.
3. Run the **migrate** script using cPanel's **Run JS Script**, or execute `node dist/db/migrate.js` from the application root. The script uses compiled JavaScript and does not load `tsx` or its WebAssembly parser.
4. After `MariaDB migrations applied`, restart the application and reload the CMS. Existing administrators should see **CMS users**.

For a source checkout, run `npm ci`, `npm run build`, `npm run migrate`, then start/restart Node. Migration 008 is additive and preserves previous migration checksums. No Android rebuild or FCM worker change is needed. This update does not automatically deploy or migrate the hosted database.
