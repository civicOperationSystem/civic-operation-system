import { randomUUID } from "node:crypto";
import { Router } from "express";
import { endpoint, rateLimit, portalBySlug, accessToken, platformAccessToken, secured, scope, requireOperations, roleLevel, noteVisibility, canReadNote, readyForPublicTicket, requestFor, photo, photos, publicStatus, publicColumns, syncVersion, staffColumns, contentKinds, type Portal, type Member, type Context, type Reply, type RecordRow, type ChatMessage, type HistoryRow } from "./router-shared";
import { CivicError, Settings, State, Permission, permissions, defaultRoles, defaultSettings, identifier, text, coordinates, trackingReference, safeUrl, calendarDate, validateSettings, fieldCanEnter, publicRequestPhotos } from "./domain";
import { rows, tenantTransaction } from "./database";
export const publicRoutes = Router();

publicRoutes.get("/public/organizations/list", endpoint(async (_req, res) => {
	res.json(await rows<{ name: string; slug: string }>(
		"SELECT name, slug FROM civic.portals WHERE archived_at IS NULL ORDER BY lower(name), slug"
	));
}));
publicRoutes.get("/public/portal", endpoint(async (req, res) => {
	const domain = text(req.query.domain, "domain", 253).toLowerCase();
	const [portal] = await rows<Portal>("SELECT * FROM civic.portals WHERE domain = :domain AND archived_at IS NULL", { domain });
	if (!portal) throw new CivicError(404, "No portal is configured for this domain");
	res.json(portal);
}));
publicRoutes.get("/public/:slug", endpoint(async (req, res) => {
	res.json(await portalBySlug(req.params.slug));
}));
publicRoutes.get("/public/:slug/content", endpoint(async (req, res) => {
	const portal = await portalBySlug(req.params.slug);
	const records = await tenantTransaction(portal.id, tx =>
		rows(`SELECT ${publicColumns} FROM civic.records WHERE published AND kind <> 'request' ORDER BY created_at DESC LIMIT 500`, {}, tx));
	res.json(records);
}));
publicRoutes.get("/public/:slug/requests/calendar", endpoint(async (req, res) => {
	const portal = await portalBySlug(req.params.slug);
	const records = await tenantTransaction(portal.id, tx =>
		rows<Pick<RecordRow, "id" | "title" | "category" | "status" | "created_at"> & { completed_at: string | null }>(
			`SELECT record.id, record.title, record.category, record.status, record.created_at,
				(SELECT history.created_at FROM civic.history history WHERE history.request_id = record.id
					AND history.new_status = 'completed' ORDER BY history.created_at DESC, history.id DESC LIMIT 1) AS completed_at
			 FROM civic.records record WHERE record.kind = 'request' AND record.status <> 'submitted'
			 ORDER BY record.created_at DESC LIMIT 500`,
			{}, tx));
	res.json(records.map(record => ({
		id: record.id,
		title: record.title,
		category: record.category,
		status: publicStatus(record.status, portal.settings.states),
		created_at: record.created_at,
		completed_at: record.completed_at
	})));
}));
publicRoutes.get("/public/:slug/requests/:id", endpoint(async (req, res) => {
	const portal = await portalBySlug(req.params.slug);
	const result = await tenantTransaction(portal.id, async tx => {
		const [record] = await rows<Pick<RecordRow, "id" | "title" | "description" | "category" | "status" | "location" | "longitude" | "latitude" | "photos" | "field_photos" | "published" | "created_at" | "updated_at">>(
			"SELECT id, title, description, category, status, location, longitude, latitude, photos, field_photos, published, created_at, updated_at FROM civic.records WHERE id = :id AND kind = 'request' AND status <> 'submitted'",
			{ id: identifier(req.params.id) }, tx);
		if (!record) throw new CivicError(404, "Public request not found");
		const history = await rows<{ new_status: string; created_at: string }>(
			"SELECT new_status, created_at FROM civic.history WHERE request_id = :id ORDER BY created_at, id", { id: record.id }, tx);
		const completedAt = [...history].reverse().find(event => event.new_status === "completed")?.created_at || null;
		return {
			id: record.id,
			title: record.title,
			category: record.category,
			status: publicStatus(record.status, portal.settings.states),
			description: record.published ? record.description : "",
			location: record.location,
			longitude: record.longitude,
			latitude: record.latitude,
			photos: publicRequestPhotos(record.status, record.photos, record.field_photos),
			created_at: record.created_at,
			updated_at: record.updated_at,
			completed_at: completedAt,
			history: history.map(event => ({ status: publicStatus(event.new_status, portal.settings.states), timestamp: event.created_at }))
		};
	});
	res.setHeader("Cache-Control", "no-store");
	res.json(result);
}));
publicRoutes.post("/public/:slug/requests", rateLimit, endpoint(async (req, res) => {
	const portal = await portalBySlug(req.params.slug);
	const category = text(req.body.category, "category", 100);
	if (!portal.settings.categories.includes(category)) throw new CivicError(400, "Unknown category");
	const requestId = req.body.client_operation_id === undefined ? randomUUID() : identifier(req.body.client_operation_id);
	const anonymous = req.body.anonymous;
	if (typeof anonymous !== "boolean" || (anonymous && !portal.settings.anonymous)) {
		throw new CivicError(400, "Anonymous reporting is not available");
	}
	const contact = anonymous ? null : {
		name: text(req.body.contact?.name, "contact name", 100),
		email: text(req.body.contact?.email, "contact email", 254),
		phone: text(req.body.contact?.phone || "", "phone", 50, false)
	};
	if (contact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) throw new CivicError(400, "Invalid contact email");
	const values = {
		id: requestId, tenant: portal.id, reference: trackingReference(), category,
		description: text(req.body.description, "description", 5000),
		location: text(req.body.location, "location", 500),
		...coordinates(req.body.longitude, req.body.latitude),
		contact: JSON.stringify(contact), photos: photos(req.body.photos === undefined ? req.body.photo : req.body.photos)
	};
	let result: { reference: string; status: string };
	await tenantTransaction(portal.id, async tx => {
		const [inserted] = await rows<{ id: string }>(`INSERT INTO civic.records (id, tenant_id, kind, title, description, category, location,
			longitude, latitude, status, reference, contact, photo, photos)
			VALUES (:id, :tenant, 'request', :category, :description, :category, :location,
			:longitude, :latitude, 'submitted', :reference, CAST(:contact AS jsonb), :firstPhoto,
			ARRAY(SELECT jsonb_array_elements_text(CAST(:photos AS jsonb))))
			ON CONFLICT (id) DO NOTHING RETURNING id`,
			{ ...values, firstPhoto: values.photos[0] || null, photos: JSON.stringify(values.photos) }, tx);
		if (inserted) {
			await rows(`INSERT INTO civic.history(id, tenant_id, request_id, new_status)
				VALUES (:history, :tenant, :id, 'submitted') RETURNING id`, { ...values, history: randomUUID() }, tx);
			result = { reference: values.reference, status: publicStatus("submitted", portal.settings.states) };
			return;
		}
		const [existing] = await rows<{
			reference: string; status: string; category: string; description: string; location: string;
			longitude: number | null; latitude: number | null; contact: unknown; photos: string[];
		}>(`SELECT reference, status, category, description, location, longitude, latitude, contact, photos
			FROM civic.records WHERE id = :id AND tenant_id = :tenant AND kind = 'request'`, values, tx);
		const savedContact = typeof existing?.contact === "string" ? JSON.parse(existing.contact) : existing?.contact;
		const sameContact = contact === null ? savedContact == null :
			!!savedContact && savedContact.name === contact.name && savedContact.email === contact.email && savedContact.phone === contact.phone;
		const samePhotos = !!existing && existing.photos.length === values.photos.length &&
			existing.photos.every((photo, index) => photo === values.photos[index]);
		// Coordinates can be corrected later by field staff, so they are not part of retry identity.
		if (!existing || existing.category !== values.category || existing.description !== values.description ||
			existing.location !== values.location || !sameContact || !samePhotos) {
			throw new CivicError(409, "This report ID was already used for a different request");
		}
		result = { reference: existing.reference, status: publicStatus(existing.status, portal.settings.states) };
	});
	res.status(201).json(result!);
}));
publicRoutes.post("/public/:slug/track", rateLimit, endpoint(async (req, res) => {
	const portal = await portalBySlug(req.params.slug);
	const reference = text(req.body.reference, "tracking reference", 39).toUpperCase();
	if (!/^[A-F0-9]{4}(?:-[A-F0-9]{4}){7}$/.test(reference)) throw new CivicError(404, "Request not found");
	const result = await tenantTransaction(portal.id, async tx => {
		const [record] = await rows<RecordRow>(`SELECT id, title, category, status, created_at, updated_at FROM civic.records
			WHERE reference = :reference AND kind = 'request'`, { reference }, tx);
		if (!record) throw new CivicError(404, "Request not found");
		const history = await rows<{ new_status: string; created_at: string }>(
			"SELECT new_status, created_at FROM civic.history WHERE request_id = :id ORDER BY created_at, id", { id: record.id }, tx);
		return {
			reference, title: record.title, category: record.category, status: publicStatus(record.status, portal.settings.states),
			reported: record.created_at, updated: record.updated_at,
			history: history.map(event => ({ status: publicStatus(event.new_status, portal.settings.states), timestamp: event.created_at }))
		};
	});
	res.setHeader("Cache-Control", "no-store");
	res.json(result);
}));
