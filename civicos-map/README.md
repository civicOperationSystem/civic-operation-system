# CivicOS GIS

MapLibre and OpenFreeMap display authorized service requests, facilities and infrastructure from the shared CivicOS API. There is no separate Supabase database or washroom application.

- `/` and `/civic` open the community map.
- `?org={slug}` selects a public organization when opening the map directly.
- The platform supplies authenticated staff context through an origin-checked iframe message channel.
- Requests remain private unless explicitly published by authorized staff.
- Clustering, layer/status filters, search, fit-to-locations, geolocation and resident pin selection are supported.
- Clicking the map places a pin and shows longitude and latitude in read-only input boxes, rounded to six decimal places. In the resident report form, the selected coordinates also populate the editable report inputs.
- An accessible location list remains available when map resources fail.

## Configuration and deployment

- `CIVIC_API_URL` is the server-side API origin used by the map's `/api/civic` rewrite. Set it to the CivicOS API origin in each deployment environment.
- `NEXT_PUBLIC_CIVIC_PARENT_ORIGINS` is a comma-separated allowlist of exact origins permitted to embed the map. Include the production platform origin (for example, `https://portal.example.org`), not a wildcard or URL path. This public setting is included at image build time.
- Set the platform's `NEXT_PUBLIC_CIVIC_MAP_URL` to the public map URL ending in `/civic`. Use HTTPS for all production origins.

Build and run with `npm run build` and `npm start`; `npm test` runs the map unit tests. The repository CI type-checks, tests and builds this app and builds its Docker image. Browser-level map coverage is in `civicos-platform/frontend/tests/e2e/map.spec.mjs` and is run by the root Playwright validation instructions.

Map tiles require internet access. Public clients cannot request private layers without a valid organization session. See the [root README](../README.md) for production deployment, environment configuration, provisioning and the full test/CI workflow.
