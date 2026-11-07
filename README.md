# CivicOS

An open community operations platform with three connected experiences on one permission-aware backend.

## Projects

| Project | Responsibility |
| --- | --- |
| [civicos-backend](civicos-backend/) | Express/Sequelize API, authentication, PostgreSQL tenant isolation, content and request workflows |
| [civicos-platform](civicos-platform/) | Next.js public portal, staff operations and mobile-friendly field workspace |
| [civicos-map](civicos-map/) | MapLibre GIS, authorized layers, clustering, filters, location selection and geolocation |

Legacy chat, collaborative documents, task microservices, demo SaaS endpoints, and washroom/Supabase features have been removed. CivicOS does not depend on those services.

## Local launch

Requires Docker Desktop with Compose v2.20+.

```powershell
Copy-Item .env.example .env
```

Edit `.env` before first launch:

```dotenv
POSTGRES_PASSWORD=choose-a-strong-database-owner-password
CIVIC_DB_PASSWORD=choose-a-different-application-database-password
CIVIC_ADMIN_DATABASE_URL=
CIVIC_DATABASE_URL=
JWT_SECRET=replace-with-a-random-secret-at-least-32-characters-long
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-supabase-publishable-or-anon-key
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-publishable-or-anon-key
CIVIC_PLATFORM_ADMIN_EMAIL=you@example.org
CIVIC_ADMIN_EMAIL=admin@example.org
CIVIC_SLUG=town-a
CIVIC_NAME=Town A
```

These are placeholders, not deployment credentials. Keep `.env` private and out of Git. `CIVIC_PLATFORM_ADMIN_EMAIL` is the single platform owner who can create organizations and appoint their first administrators; for local Compose runs it defaults to `CIVIC_ADMIN_EMAIL` if left blank. `CIVIC_ADMIN_EMAIL` is only used when creating the initial organization through the setup command. Both sign in with Supabase magic links, not CivicOS passwords.

```powershell
docker compose up -d postgres
docker compose --profile setup run --build --rm provision
docker compose up -d --build backend frontend map
docker compose ps
```

Stop if provisioning fails. Repeating provisioning for an existing slug preserves its users, settings and request data. Changing `POSTGRES_PASSWORD` in `.env` does **not** change an initialized PostgreSQL password.

| Experience | Address |
| --- | --- |
| Public portal | http://localhost:3100/portal/town-a |
| Staff operations | http://localhost:3100/staff?org=town-a |
| Field workspace | http://localhost:3100/field?org=town-a |
| Community map | http://localhost:3101/civic?org=town-a |

Visit http://localhost:3100/platform to sign in as the configured platform owner and create organizations. That owner appoints one Bottom admin for each organization; Bottom admins sign in at the organization’s staff URL and add/manage only their own staff from **People & roles**. The mobile-friendly portal and staff workspace support limited offline use; field work also supports queued offline updates.

### Supabase email sign-in

Staff and field links on an organization's public portal carry its workspace automatically. The sign-in page displays the resolved organization name in a read-only field; only the email address needs entering. Magic-link callbacks retain the organization slug. Direct sign-in pages without an organization parameter still allow a workspace slug to be entered.

The main public portal at `/` or `/portal` includes organization cards populated by `GET /api/civic/public/organizations/list`. The public directory exposes only organization names and slugs, ordered by name. Search by organization name or workspace address (for example `/portal/village-b`); organization names are suggested through the browser's native autocomplete and cards filter as you type. Choose **Open portal** on a card. Loading, empty, search-no-match and error states are shown explicitly. Direct organization URLs and custom-domain portal lookup remain supported.

The platform owner, staff, and field login screens send one-time email links using Supabase Auth. In the Supabase dashboard, configure the site URL and allowlist `http://localhost:3100/**` for local development. For production, allowlist `https://your-frontend-domain.example/**`; this supports the `/platform` callback and organization-specific staff/field URLs without adding every organization separately. Configure an SMTP provider before production so your organization controls reliable email delivery. Use the same project URL and publishable/anon key in the `SUPABASE_*` and `NEXT_PUBLIC_SUPABASE_*` settings; never put a Supabase service-role key in the frontend.

Staff email addresses must first be added to that organization's **People & roles** list. Supabase can create the authentication identity when the member follows a link, but CivicOS only grants access after matching the verified email to an active member in the selected organization. A Supabase account alone does not grant access. Residents can still submit public service requests without an account.

### Supabase PostgreSQL

For a Supabase database, set both connection URLs:

- `CIVIC_ADMIN_DATABASE_URL`: a privileged database connection used only by the provisioner for schema migrations and creating/updating the `civic_app` role.
- `CIVIC_DATABASE_URL`: the non-owner `civic_app` connection used by the running API. The provisioner reads its encoded password from this URL unless `CIVIC_DB_PASSWORD` is set separately.

Use the exact URLs from the Supabase project's **Connect** page; percent-encode reserved characters in passwords. For a persistent backend on an IPv4-only network, Supabase's shared **session pooler** is IPv4-compatible. A direct connection is IPv4-compatible only when the project's IPv4 add-on is enabled. The backend requires TLS and verifies the server certificate. The application connection must use `civic_app`, never the database owner or a `BYPASSRLS` role.

If provisioning or the API reports `SELF_SIGNED_CERT_IN_CHAIN`, download the database server's root CA certificate from your Supabase project's **Database settings → SSL**. Set `CIVIC_DATABASE_SSL_CA` to the complete PEM certificate, including the `BEGIN CERTIFICATE` and `END CERTIFICATE` lines. It accepts actual line breaks or literal `\n` sequences. Use the CA that signs your selected database/pooler endpoint; do not download certificates from untrusted sources.

On Vercel, add `CIVIC_DATABASE_SSL_CA` to the **backend project's** environment variables for the target environment, then redeploy. For local migration commands, set `$env:CIVIC_DATABASE_SSL_CA = Get-Content -Raw 'C:\certs\supabase-root.crt'` before running `npm run civic:init`. Compose passes this variable to both the backend and provisioner. Leave it empty when the endpoint already uses a trusted public CA. This applies only to URL-based PostgreSQL connections; local non-URL database configuration is unchanged.

Certificate and hostname verification are enabled by default. URL parameters such as `sslmode`, `sslrootcert`, `sslcert`, `sslkey`, `ssl` and `uselibpqcompat` do not override the application's TLS policy; configure custom database CA trust through `CIVIC_DATABASE_SSL_CA`.

For temporary troubleshooting only, set `CIVIC_DATABASE_SSL_REJECT_UNAUTHORIZED=false` in the backend Vercel project's target environment and redeploy. This preserves database TLS encryption but disables certificate and hostname verification, leaving the connection vulnerable to interception. The backend logs a warning while this bypass is active. Do not use it for production traffic or real community data. To restore verification, configure the correct CA, set this variable to `true` (or remove it), and redeploy. Compose passes the same setting to the backend and provisioner. Never use the process-wide `NODE_TLS_REJECT_UNAUTHORIZED=0` setting.

When using Supabase, leave the local `POSTGRES_PASSWORD` and `CIVIC_DB_PASSWORD` empty if they are not needed, set the two URLs above, then provision and start only the application services:

```powershell
docker compose --profile setup run --build --rm provision
docker compose up -d --build backend frontend map
```

For local PostgreSQL, leave both URL settings empty and follow the local launch commands above.

`compose.yml` includes `docker-compose.civic.yml`, so both `docker compose ...` and `docker compose -f docker-compose.civic.yml ...` work.

### Updating an existing deployment

Back up PostgreSQL first. Do not delete database volumes.

```powershell
docker compose --profile setup run --build --rm -e CIVIC_MIGRATE_ONLY=true provision
docker compose up -d --build backend frontend map
```

This updates the schema without creating or resetting organization records. Source changes are not reflected in already-built containers until they are rebuilt.

### Platform owner and organization administration

The configured `CIVIC_PLATFORM_ADMIN_EMAIL` is the initial global platform owner. Only a verified Supabase identity matching that backend environment value can sign in at `/platform`, list organization names/slugs/domains, and create organization workspaces. When creating an organization, the platform owner appoints its first Bottom admin by email. Organization data is created under PostgreSQL row-level security in one transaction. Each Bottom admin can add, activate, deactivate, and assign roles to other members only inside their own organization; tenant administrators cannot use platform-owner endpoints. The platform owner can archive an organization from `/platform`, which immediately removes it from public discovery and prevents staff access, then restore it if needed. Permanent removal is available only after archive confirmation and deletes that organization's data.

For local development, the first Compose setup may still create a starter organization using `CIVIC_ADMIN_EMAIL` and `CIVIC_SLUG`; afterward, the platform owner can create further organizations from `/platform`. For Vercel, run the schema-only setup once from a trusted environment before deploying:

```powershell
docker compose --profile setup run --build --rm `
  -e CIVIC_MIGRATE_ONLY=true `
  provision
```

Provide `CIVIC_ADMIN_DATABASE_URL` and `CIVIC_DATABASE_URL` through the trusted environment for this migration; the runtime password is read from the URL unless `CIVIC_DB_PASSWORD` is set separately. The admin URL is needed only for this setup task, not as a Vercel runtime variable.

### Request board, archival and private notes

Staff and field workspaces display service requests in workflow-status columns and a searchable request calendar. Search matches request details, category, location, tracking reference, and status. Requests can move forward to configured next states or back one directly configured workflow step; they cannot jump to arbitrary states. Staff and administrators can archive a request; archived requests leave the active board. Administrators can enable **Show archived requests** and restore them; the calendar includes archived requests with an archived label.

Private notes are retained in the request audit trail but are never public. They default to **Only my role level**. The author can choose **Share down the operational chain** for a staff/admin note; this makes staff notes available to field workers and admin notes available to staff and field workers. Field notes are always visible to field workers, staff, and administrators.

After deploying this version, run the schema-only provisioning command above once so the archive and note-visibility columns exist before using the request board.

### Deploying on Vercel

No Supabase Edge Functions are required. Supabase provides PostgreSQL and Auth; CivicOS keeps its permission checks and API in the Express backend. Vercel runs that backend as a serverless Express function. Deploy the three experiences as separate Vercel projects from this repository:

| Vercel project | Root directory | Purpose |
| --- | --- | --- |
| CivicOS frontend | `civicos-platform/frontend` | Public portal, platform-owner console, staff operations, field app |
| CivicOS API | `civicos-backend` | Express API and tenant-aware backend |
| CivicOS map | `civicos-map` | Interactive MapLibre application |

Set these project environment variables:

- **CivicOS API:** `CIVIC_DATABASE_URL` (Supabase `civic_app` runtime role), `JWT_SECRET` (random, at least 32 characters), `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `CIVIC_PLATFORM_ADMIN_EMAIL`.
- **CivicOS frontend:** `CIVIC_API_URL` (the API deployment origin, without a path), `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `NEXT_PUBLIC_CIVIC_MAP_URL` (the map deployment URL ending in `/civic`).
- **CivicOS map:** `CIVIC_API_URL` (same API deployment origin) and `NEXT_PUBLIC_CIVIC_PARENT_ORIGINS` (the frontend’s production origin).

| Variable | Project / stage | Production configuration |
| --- | --- | --- |
| `CIVIC_DATABASE_URL` | API runtime | PostgreSQL URL for the non-owner `civic_app` role; use the Supabase session pooler for serverless deployments. |
| `CIVIC_DATABASE_SSL_CA` | API runtime and migration, if needed | PEM root CA for the selected database endpoint when it is not trusted by the runtime. Keep certificate verification enabled. |
| `JWT_SECRET` | API runtime | Private, randomly generated secret of at least 32 characters. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | API runtime | Supabase project URL and publishable/anon key used to verify sign-in identities. |
| `CIVIC_PLATFORM_ADMIN_EMAIL` | API runtime | Verified email address of the platform owner. |
| `CIVIC_API_URL` | Frontend and map runtime | HTTPS origin of the API deployment, without a trailing path. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Frontend build | Same Supabase project URL and publishable/anon key; these are public client settings, not service-role credentials. |
| `NEXT_PUBLIC_CIVIC_MAP_URL` | Frontend build | HTTPS map deployment URL ending in `/civic`. |
| `NEXT_PUBLIC_CIVIC_PARENT_ORIGINS` | Map build | Comma-separated, exact HTTPS origins allowed to embed the map; include the production frontend origin. |
| `CIVIC_ADMIN_DATABASE_URL` | Trusted migration only | Privileged database URL for schema migration and provisioning. Never configure it on a deployed API runtime. |

The frontend’s Next.js rewrite proxies `/api/civic` to the backend, so browser API requests remain same-origin and the API does not need public CORS access. Use HTTPS Vercel and Supabase URLs in production. Keep `CIVIC_ADMIN_DATABASE_URL` out of Vercel runtime variables; use it only in the trusted, one-time schema migration/provisioning environment. Set the Supabase Auth site URL to your frontend domain and allowlist `https://your-frontend-domain.example/**`. Add the production frontend domain to the map’s allowed parent origins.

Vercel serverless functions can scale out, so the API uses a small per-instance PostgreSQL pool. Choose a Supabase connection/pooler URL appropriate for serverless deployments, and do not expose the database owner connection to the API.

#### Production deployment sequence

1. Create the Supabase project, configure Auth email delivery and the HTTPS frontend redirect allowlist, and create the runtime `civic_app` database role through the trusted provisioning process.
2. Set `CIVIC_ADMIN_DATABASE_URL` and `CIVIC_DATABASE_URL` only in a trusted migration environment, then run the schema-only provisioning command in [Platform owner and organization administration](#platform-owner-and-organization-administration). Do not point the migration at production until its backup and recovery process is in place.
3. Configure the environment variables above in the matching Vercel projects. Add `CIVIC_DATABASE_SSL_CA` to the API project only if the database endpoint needs a custom CA; keep certificate and hostname verification enabled.
4. Deploy the API, frontend, and map projects. Confirm the frontend and map use the production HTTPS API and that the map’s allowed parent origins contain the exact frontend origin.
5. Check API readiness with the command below, then sign in as the configured platform owner and create an organization. Verify public portal access and organization-scoped staff access before inviting users.

Vercel builds the public `NEXT_PUBLIC_*` settings into the frontend/map bundles. Update those settings and rebuild the corresponding project after changing domains or Supabase projects.

### Post-deployment readiness

After deploying the backend, manually call `GET /readyz` on the **API deployment domain**, not the frontend:

```powershell
curl.exe --fail-with-body --show-error https://YOUR-API-DOMAIN/readyz
```

The endpoint is unauthenticated and disables caching. Each request verifies required runtime configuration, database connectivity, safe runtime database role and schema access. It returns `200` with `{"service":"CivicOS","status":"ready"}` on success, or `503` with `{"service":"CivicOS","status":"not_ready"}` on failure. Failure details are logged server-side, not exposed in the response. It does not check SMTP delivery or contact Supabase Auth. The existing `/health` endpoint is unchanged; no automatic post-deployment trigger is configured.

For a custom domain:

1. Verify ownership and configure DNS through your domain provider.
2. Set `CIVIC_DOMAIN` to the verified hostname when provisioning a new organization.
3. Put a trusted HTTPS reverse proxy in front of the platform. The portal resolves the organization's registered hostname without requiring a resident account.
4. Set `NEXT_PUBLIC_CIVIC_MAP_URL` to the HTTPS map address and add all authorized platform origins to `NEXT_PUBLIC_CIVIC_PARENT_ORIGINS` (comma-separated), then rebuild the frontend and map.

Domain registration and TLS certificate issuance are deployment responsibilities, not automatic application features. Ports bind to loopback by default; PostgreSQL is not exposed externally.

## Features

- Organization name, logo, branding, timezone, locale, locations, departments, services, categories, users and configurable roles.
- Supabase one-time email sign-in for staff and field workers, with verified identities linked to organization-scoped CivicOS memberships.
- Account-free published services, announcements, events, projects, facilities, HTTPS document links, emergency notices and contact information.
- Public portal Refresh reloads community information, public requests and the community map without clearing an unfinished report or changing the selected tab.
- Resident requests with descriptions, locations, coordinates, up to three optional PNG/JPEG/WebP photos (2 MiB each), contact details, and organization-controlled anonymous reporting. Field workers can add up to three photos (5 MiB each). Resident photos are public after review; field photos appear publicly only while the request is in the `verified` state.
- Existing deployments must run the schema migration in [Updating an existing deployment](#updating-an-existing-deployment) before deploying the six-photo limit; otherwise the previous three-photo database constraint remains in effect.
- Archiving removes a request permanently from staff and field workspaces while retaining its public ticket, map marker, and status history.
- Cryptographically random 128-bit tracking references. Tracking uses a POST body and exposes only category, public status and dates; not staff names, notes, contacts, assignments or photos.
- Configurable workflow states and allowed transitions. Every submission, assignment and transition stores an immutable actor/status/timestamp/notes record. Tenant sessions cannot update or delete audit history; only permanent organization removal by the platform owner deletes it.
- Assigned field workers can enter only field-enabled states. Staff alone perform review and verification by default. Disabled accounts lose access on their next API request.
- Field assignments and their details can be reopened offline. Notes, workflow updates, completion photos and coordinate corrections are queued durably on the device and synchronized automatically when the field workspace is open and connected, or with **Sync pending updates**.
- Publishing and editing community information, member role changes, activation/deactivation and explicit public request-map visibility.
- Authorized GIS layers, clustered points, search, status/type filters, zoom-to-results, resident pin selection and an accessible location list.

Locale configuration controls document language and date/time formatting. Interface copy is currently English. Map data is capped at the latest 5,000 authorized locations with an explicit notice; the location list shows the first 200 matches. Request lists are paginated in batches of 100.

The bottom administrator sets the community map in **Staff portal → Organization settings**. Pan and zoom the preview, choose **Use current map view**, then **Save organization settings**. Longitude, latitude and default zoom can also be entered directly. The saved view applies to public, staff and field maps, location pickers and the standalone community map; opening a specific pinned item still focuses on that item. New communities start with a world view rather than New York. Existing communities retain their saved center (and zoom 12 when no zoom was previously saved) until the administrator changes it.

### Offline field work

Run the database migration before deploying offline support: it adds `civic.field_operations`, which records successful operations so lost acknowledgements and retries do not duplicate photos or audit entries. The API also supplies exact ticket versions for conflict detection.

1. Use a current browser over HTTPS (localhost also works). Sign in to `/field?org=your-workspace` online and wait for assignments to finish loading. All assigned tickets and details are cached, including private notes and photos; refresh online before leaving for the field.
2. The field shell is cached by a service worker. After its first successful installation, the workspace can reopen without a connection, using this device's last field identity even if its online session has expired. This is local device access, not authorization to write to the server.
3. Offline changes appear as pending, not server-confirmed. Coordinate corrections can be typed and saved without the map. The three-photo limit includes pending photos. Maps/tiles and chat are not available offline; resident reports can be queued from the public portal as described below.
4. Reconnect and keep the workspace open to synchronize (also retried every 30 seconds), or press **Sync pending updates**. The server checks the current account, permissions, assignment and ticket version on every write. If a ticket changed or access was removed, its queued chain stops and stays visible for review. Copy needed notes, discard that ticket's pending updates, refresh online and resubmit against the current assignment; conflicts never silently overwrite dispatch changes.
5. Use trusted, individually secured devices: cached data is private browser storage, not encrypted by CivicOS. Signing out of the field workspace clears that identity's cached assignments and queued work across its workspaces on the device; a confirmation warns before clearing. Synchronize before signing out. Browser storage eviction, clearing site data, private browsing and device loss can remove unsent changes. First-time sign-in and server authorization always require a connection; expired sessions may require signing in again.

Synchronization runs in the open workspace, not while the browser is closed. Storage/quota failures are surfaced explicitly and an update is never reported as queued until its local transaction commits.

### Offline portal and staff access

Use a current browser over HTTPS (localhost also works) and visit the portal and staff workspace online first. The service worker saves the app shell and static assets for the home, portal, staff and field routes; it does not cache API responses or authentication callbacks.

- The portal saves its public organization settings, published information, public request calendar and public request details that have been opened. Previously saved public information can be read offline. The interactive map and external links need a connection.
- Residents can save a report while offline. It appears as waiting on this device and is submitted automatically after reconnection while the portal is open. Reports use a stable operation ID so retries after a lost response do not create duplicate tickets. Validation failures remain visible for retry; submitted reports retain only their tracking reference in the offline queue.
- Staff who have signed in and loaded their workspace online before can reopen a cached snapshot when offline. This is read-only and includes the most recently loaded request list and organization information, not request details, member management, chat or maps. New sign-in links and all updates require internet; reconnect to re-verify current permissions before making changes.
- Portal reports awaiting submission may include resident contact details and photos; cached staff snapshots may include request descriptions and locations. Browser storage is not encrypted by CivicOS. Use individually secured devices, avoid sensitive details in public reports, and sign out of staff access to clear its cached workspace. Browser storage eviction or clearing site data can remove saved data and unsent reports.

## Validation

Use Node.js 24 and an **isolated test database**, never the deployment database.

```powershell
docker run --detach --name civicos-tests -p 127.0.0.1:15433:5432 -e POSTGRES_DB=civicos_test -e POSTGRES_PASSWORD=civicos-test-local-only postgres:15
docker exec civicos-tests pg_isready -U postgres
```

Wait until PostgreSQL accepts connections. Each project has `build` and `test` scripts:

```powershell
Set-Location .\civicos-backend
npm ci
npm run build
npm test
Set-Location ..\civicos-platform\frontend
npm ci
npm test
npx playwright install chromium
npm run test:e2e
npm run test:e2e:integration
npm run build
Set-Location ..\..\civicos-map
npm ci
npm test
npm run build
```

`npm run test:e2e` in `civicos-platform/frontend` runs frontend-only Playwright scripts with mocked CivicOS and Supabase API responses. It starts only the frontend and map apps on ports 3310 and 3311; no backend, authentication server, or database is started or required. These tests cover directory navigation, report submission, staff sign-in feedback and platform organization creation. Service workers are blocked so requests cannot bypass the mocks; offline/service-worker behavior is covered by the integration suite instead.

`npm run test:e2e:integration` runs the original database-backed browser suite. It starts temporary servers on ports 3330, 3331, 3310 and 3311, creates a disposable organization in `civicos_test`, exercises resident reporting, staff dispatch, mobile field completion, verification, organization settings, private-safe tracking and the map, then removes its fixture data. Run backend and integration browser tests sequentially because they rotate the test-only database role's password.

`npm test` in `civicos-backend` includes the API end-to-end suite (`tests/*.e2e.test.ts`); run it alone with `npm run test:e2e`. The browser suite `tests/e2e/map.spec.mjs` covers map pins on public information, calendar dates and archiving, and needs internet access for map tiles.

The backend tests include explicit cross-organization checks: `civic.test.ts` verifies tenant isolation for list and direct request access, assignment, tracking, unscoped SQL and forged tenant inserts. It also checks platform-owner and organization-role boundaries, unauthorized workflow transitions, field permissions, and chat visibility. `public-content-map.e2e.test.ts` checks that map content stays within its organization and that users without publish permission cannot publish map pins. These suites exercise representative API routes and database row-level security; they are not a substitute for reviewing authorization when adding or changing routes.

### Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on pushes and pull requests to `main`: type-check, unit tests and builds for each project, the backend Vitest suites and the Playwright browser suite against a `postgres:15` service, and a build-only check of each `Dockerfile.civic`. It does not deploy. Failed browser runs upload traces as the `playwright-results` artifact.

The backend CI job runs the same permission and tenant-isolation tests described above. Keep new route authorization and cross-tenant access cases in the backend Vitest suites so they run on every pull request to `main`.

```powershell
docker stop civicos-tests
docker rm civicos-tests
```

Before public deployment, configure HTTPS, backups, monitoring and deployment-scale rate limiting. Never run the application using the PostgreSQL owner, a superuser, or a `BYPASSRLS` role; the backend refuses those roles.