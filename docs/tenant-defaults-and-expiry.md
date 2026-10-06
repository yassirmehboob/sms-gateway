# Tenant defaults and subscription expiry

Migration 009 adds optional tenant overrides and expiry without changing existing tenant identities, API keys or devices. Existing and newly created tenants inherit the current platform defaults and have no expiry unless one is assigned.

## CMS controls

- **Limits & settings ? Platform defaults:** save the default quotas, cooldown, message lifetime, replay window, confirmation interval and bulk interval. Defaults apply to existing and future tenants for every field they have not overridden.
- **Limits & settings ? Tenant settings:** choose a tenant, check **Override default** beside the fields to customize, and save. Unchecked fields inherit the current default. Uncheck all fields and save to restore full inheritance.
- **Tenants & API keys:** the tenant table shows service status and expiry. Set an optional expiry during tenant creation, or choose an existing tenant in **Subscription expiry** to set, extend or clear it. Blank means no expiry. Dates are entered and displayed in the browser's local timezone and stored as UTC.
- Header navigation wraps onto additional rows on narrow screens; it does not scroll horizontally.

Changing defaults or tenant overrides requires **Limits & settings: Manage** plus **All tenants**. Creating tenants and changing expiry requires **Tenants & API keys: Manage** plus **All tenants**. Super administrators have these rights. Tenant-scoped administrators cannot increase subscription limits or renew themselves. They can view their tenant's effective settings with Settings View permission.

## Enforcement

Database time determines expiry. At or after expiry, tenant API calls, new SMS requests, device claims/authorizations, FCM registration, contact/group writes, bulk submissions and operational provisioning are rejected. This is enforced server-side, independent of CMS button visibility or worker timing. Expired tenant API calls return HTTP 403 with TENANT_EXPIRED.

Tenant-scoped CMS users can still sign in, manage their own account and see subscription status. Expired tenants are removed from operational history/device/client results and their contact/bulk requests are blocked. Other active assigned tenants remain usable. Platform administrators retain historical visibility and renewal controls.

Unattempted queued/claimed messages and unreleased scheduled batch recipients are cancelled during reconciliation or expiry changes. Renewal first reconciles an already elapsed expiry, even if the server was idle, so it cannot release the old backlog. Renewal allows new requests and batches; cancelled work is never restored automatically. Previously authorized attempts cannot be recalled. New authorization validity is capped at the subscription expiry known when authorization is issued.

Signed heartbeat, delivery callbacks and inbound STOP/START records remain available for bookkeeping. Heartbeat reports paused after expiry. STOP/START still records recipient preferences, but generates no confirmation SMS while expired.

## Limits and pacing

Per-tenant overrides affect new message acceptance and confirmation generation. Existing usage reservations, cooldown deadlines and queued message lifetimes are preserved. Recipient suppression, SMS preferences and recipient usage/cooldown protections remain shared across tenants. Client and device budgets remain per client/device.

Bulk release retains one outstanding unattempted bulk job globally. Between tenants, it waits for the greater of the previous tenant's and next tenant's effective intervals, measured from the previous bulk send window. This prevents alternating tenants from shortening the wait. Current overrides/defaults are used for the next release. A delay does not guarantee carrier acceptance.

Expiry is a manually managed service subscription control. Payment collection, automatic invoicing and payment-provider renewal are not included.

## cPanel update

Use the prepared .local/cpanel-tenant-services-update.zip archive. It includes compiled server JavaScript, CMS assets, package manifests and all migration SQL files; no build on the host is needed.

1. Back up the hosted database and application. Extract the archive into the existing Node application root, replacing the included files. Preserve the existing .env, encryption key and credentials.
2. Use Node 24. Install dependencies through cPanel if updating from before the contacts/Excel feature; this tenant update adds no dependencies.
3. In **Run JS Script**, run **migrate** (or run node dist/db/migrate.js from the application root). This uses compiled JavaScript, avoiding the hosting tsx/WebAssembly memory problem. Wait for MariaDB migrations applied.
4. Restart the Node application and any separately running FCM/reconcile workers so every process uses the expiry checks. Reload the CMS. No Android update is needed.
5. Set expiry explicitly for existing paid tenants; migration does not guess their subscription dates. Configure platform defaults, then any tenant exceptions.

The hosted database has not been migrated or deployed by this local update.
