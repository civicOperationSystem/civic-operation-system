# CivicOS Platform

The [frontend](frontend/) hosts three connected experiences:

- `/` or `/portal/{slug}`: account-free community information, resident reporting and private-reference tracking.
- `/staff`: request review, dispatch, workflows, public information, people, roles and organization settings.
- `/field`: mobile-friendly assigned-work updates and the interactive Community map using the same authenticated API. Select an authorized request on the map or in its location list to open its work record.

The GIS project is embedded through an origin-checked message channel. Session tokens stay in memory and are sent in API headers, not URL parameters.

Residents can submit up to three photos, each up to 2 MiB. Field workers can add up to three more, each up to 5 MiB. Photos over 512 KiB are compressed to JPEG in the browser before upload. Resident photos are public after review; field photos become public when the current request state is `verified`. Reopening a request hides field photos until it is verified again. Private tracking remains photo-free.

Open an assigned ticket in the field workspace to add completion photos. The photo picker appears above the location map and indicates when all three field photo slots are filled.

Archiving removes a request permanently from staff and field workspaces while preserving its public ticket, map marker, and status history in the public portal.

Only CivicOS is shipped; the legacy collaboration UI and microservices have been removed.

See the [root README](../README.md) for Docker launch, provisioning, custom domains and testing.
