# CloudLinux Passenger startup troubleshooting

If running migrations fails inside `tsx` with `WebAssembly.instantiate(): Out of memory`, use `node dist/db/migrate.js` from the application root. The updated package's `npm run migrate` uses this compiled command and avoids the TypeScript/WebAssembly loader. Select Node 24 to match the project's runtime requirement. See [migration recovery steps](contacts-and-bulk-messaging.md#cpanel-migration-reports-webassembly-out-of-memory).

Upload the updated server source and `app.cjs`, then build with `npm run build`
in the activated cPanel Node environment. Select `app.cjs` as the startup file.

Set these variables in cPanel's application environment (or its server `.env`):

```dotenv
DEPLOYMENT_MODE=passenger
TRUST_PROXY_HOPS=1
HOST=127.0.0.1
APP_BASE_PATH=/sms-gateway
```

Passenger mode opens only the primary HTTP listener, regardless of `CMS_PORT`.
The launcher also detects Passenger. Local execution defaults to the existing
separate CMS listener and no trusted proxy.

`TRUST_PROXY_HOPS=1` assumes every request reaches Node through exactly one
trusted proxy, which overwrites or appends the real client address to
X-Forwarded-For. Confirm the forwarding chain with your host; additional CDN or
proxy layers may require a different configuration. Do not blindly increase the
hop count or enable unrestricted `trust proxy=true`. Restrict direct access to
Node when trusting a proxy.

Restart using cPanel, then check `/healthz` and the new application log entries.
The CMS is localhost-only unless explicitly enabled as described below. The separate FCM
worker still needs a host-supported persistent process.

## Deploying under /sms-gateway

Keep the cPanel application URL at `/sms-gateway` and set `APP_BASE_PATH=/sms-gateway`.
Build locally with `npm.cmd run build` in `server`, upload the full `dist` folder
and `app.cjs`, and restart from cPanel. No cPanel terminal is needed for rebuilding.
The health URL is `https://itsc.usindh.edu.pk/sms-gateway/healthz` and the sending
endpoint is `https://itsc.usindh.edu.pk/sms-gateway/v1/messages`.
Leave APP_BASE_PATH empty for root deployments. Both intact and proxy-stripped
prefixes are supported; the configured public prefix remains in message status
links and signed device requests.

Install the updated Android APK to accept a base URL containing `/sms-gateway`.
For a new identity use `https://itsc.usindh.edu.pk/sms-gateway`. Existing saved
identities remain immutable; installing this update does not move an already
paired phone to a different server URL. Do not clear its data while jobs or
unreported events are pending. Device migration needs a separate controlled
re-enrollment procedure.

## Online CMS without a cPanel terminal

Upload and extract `.local/cpanel-cms-update.zip` into the application root,
replacing `dist`, `public`, and `app.cjs`. Keep the server's existing `.env`,
database, encryption key and Firebase credentials. This is a compiled update,
so no server-side build or dependency installation is required.

In Setup Node.js App set startup file `app.cjs` and these environment variables:

```dotenv
DEPLOYMENT_MODE=passenger
APP_BASE_PATH=/sms-gateway
CMS_PUBLIC_ORIGIN=https://itsc.usindh.edu.pk
HOST=127.0.0.1
TRUST_PROXY_HOPS=1
```

Restart the application and open
`https://itsc.usindh.edu.pk/sms-gateway/admin/`.
CMS_PUBLIC_ORIGIN contains only the HTTPS origin; APP_BASE_PATH supplies the
folder. The app checks the actual Host header and trusted HTTPS forwarding,
requires an exact same-origin Origin header for writes, and scopes secure,
HttpOnly, SameSite cookies to `/sms-gateway/admin`. Password, mandatory TOTP,
CSRF, session expiry and admin/viewer checks remain in effect. There is no new
default password or public registration endpoint. Sign in with an account in
the deployed database. If you imported the local database, retain its original
CONTENT_ENCRYPTION_KEY so authenticator secrets can still be decrypted.

If you see CMS_HTTPS_REQUIRED, ask the host to forward X-Forwarded-Proto: https
from its trusted TLS proxy; do not disable HTTPS enforcement. CMS_HOST_REJECTED
means the actual Host differs from the configured origin. Confirm the proxy
chain before changing TRUST_PROXY_HOPS. Unset CMS_PUBLIC_ORIGIN to restore
localhost-only CMS access. The FCM worker remains separate from the web process.

References:
- https://expressjs.com/en/guide/behind-proxies/
- https://www.phusionpassenger.com/docs/advanced_guides/in_depth/node/reverse_port_binding.html

For tenant defaults and subscription expiry, use the [migration 009 update guide](tenant-defaults-and-expiry.md#cpanel-update). Restart any separate workers as well as the web application.
