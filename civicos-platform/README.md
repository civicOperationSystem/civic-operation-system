# CivicOS Platform

The [frontend](frontend/) hosts three connected experiences:

- `/` or `/portal/{slug}`: account-free community information, resident reporting and private-reference tracking.
- `/staff`: request review, dispatch, workflows, public information, people, roles and organization settings.
- `/field`: mobile-friendly assigned-work updates using the same authenticated API.

The GIS project is embedded through an origin-checked message channel. Session tokens stay in memory and are sent in API headers, not URL parameters.

Only CivicOS is shipped; the legacy collaboration UI and microservices have been removed.

See the [root README](../README.md) for Docker launch, provisioning, custom domains and testing.
