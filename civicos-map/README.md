# CivicOS GIS

MapLibre and OpenFreeMap display authorized service requests, facilities and infrastructure from the shared CivicOS API. There is no separate Supabase database or washroom application.

- `/` and `/civic` open the community map.
- `?org={slug}` selects a public organization when opening the map directly.
- The platform supplies authenticated staff context through an origin-checked iframe message channel.
- Requests remain private unless explicitly published by authorized staff.
- Clustering, layer/status filters, search, fit-to-locations, geolocation and resident pin selection are supported.
- Clicking the map places a pin and shows longitude and latitude in read-only input boxes, rounded to six decimal places. In the resident report form, the selected coordinates also populate the editable report inputs.
- An accessible location list remains available when map resources fail.

Configure `CIVIC_API_URL`, `NEXT_PUBLIC_CIVIC_PARENT_ORIGINS` and the platform's `NEXT_PUBLIC_CIVIC_MAP_URL` for deployment. Map tiles require internet access. Public clients cannot request private layers without a valid organization session.

See the [root README](../README.md) for launch and validation commands.
