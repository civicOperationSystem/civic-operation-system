import { randomUUID } from "node:crypto";
import { Router } from "express";
import { endpoint, rateLimit, portalBySlug, accessToken, platformAccessToken, secured, scope, requireOperations, roleLevel, noteVisibility, canReadNote, readyForPublicTicket, requestFor, photo, photos, publicStatus, publicColumns, syncVersion, staffColumns, contentKinds, type Portal, type Member, type Context, type Reply, type RecordRow, type ChatMessage, type HistoryRow } from "./router-shared";
import { CivicError, Settings, State, Permission, permissions, defaultRoles, defaultSettings, identifier, text, coordinates, trackingReference, safeUrl, calendarDate, validateSettings, fieldCanEnter, publicRequestPhotos } from "./domain";
import { rows, tenantTransaction } from "./database";
export const staffRoutes = Router();

secured(staffRoutes, "get", "/staff/me", null, async (_req, res, context) => {
	res.json({
		user: { id: context.member.id, email: context.member.email, role: context.member.role },
		permissions: context.permissions, portal: context.portal
	});
});
secured(staffRoutes, "get", "/staff/requests", null, async (req, res, context) => {
	requireOperations(context);
	const page = Number(req.query.page || 1);
	if (!Number.isInteger(page) || page < 1 || page > 100000) throw new CivicError(400, "Invalid page");
	res.json(await rows(`SELECT ${staffColumns} FROM civic.records WHERE kind = 'request' AND archived_at IS NULL${scope(context)}
		ORDER BY created_at DESC LIMIT 100 OFFSET :offset`,
		{ actor: context.member.id, offset: (page - 1) * 100 }, context.tx));
});
secured(staffRoutes, "get", "/staff/requests/:id", null, async (req, res, context) => {
	const record = await requestFor(context, req.params.id);
	const [privateData] = await rows("SELECT contact, photo FROM civic.records WHERE id = :id", { id: record.id }, context.tx);
	const history = await rows<HistoryRow>("SELECT id, actor, actor_role, previous_status, new_status, notes, note_visibility, assigned_to, created_at FROM civic.history WHERE request_id = :id ORDER BY created_at, id", { id: record.id }, context.tx);
	res.json({ ...record, ...privateData, history: history.map(event => ({
		...event, notes: canReadNote(event, context) ? event.notes : "", note_visibility: canReadNote(event, context) ? event.note_visibility : null
	})) });
});
secured(staffRoutes, "post", "/staff/requests/:id/transition", "transition", async (req, res, context) => {
	const record = await requestFor(context, req.params.id, true);
	const next = text(req.body.status, "status", 40);
	const notes = text(req.body.notes || "", "notes", 5000, false);
	const visibility = noteVisibility(req.body.note_visibility, context);
	const state = context.portal.settings.states.find(item => item.key === record.status);
	const reversing = context.portal.settings.states.some(item => item.key === next && item.next.includes(record.status || ""));
	if (!state || (!state.next.includes(next) && !reversing)) throw new CivicError(409, "This workflow transition is not allowed");
	const target = context.portal.settings.states.find(item => item.key === next);
	if (!context.permissions.includes("read") && (!target || !fieldCanEnter(target))) {
		throw new CivicError(403, "Field workers cannot enter this workflow state");
	}
	if (next === "assigned" && !record.assigned_to) throw new CivicError(409, "Assign a worker before entering assigned status");
	await rows("UPDATE civic.records SET status = :next, updated_at = now() WHERE id = :id RETURNING id",
		{ id: record.id, next }, context.tx);
	await rows(`INSERT INTO civic.history(id, tenant_id, request_id, actor, actor_role, previous_status, new_status, notes, note_visibility, assigned_to)
		VALUES (:history, :tenant, :id, :actor, :role, :previous, :next, :notes, :visibility, :assigned) RETURNING id`, {
		history: randomUUID(), tenant: context.portal.id, id: record.id, actor: context.member.id,
		role: roleLevel(context), previous: record.status, next, notes, visibility, assigned: record.assigned_to
	}, context.tx);
	res.json({ status: next });
}, undefined, true);
secured(staffRoutes, "post", "/staff/requests/:id/assign", "assign", async (req, res, context) => {
	const record = await requestFor(context, req.params.id, true);
	const assigned = identifier(req.body.assigned_to);
	const [worker] = await rows<Member>("SELECT * FROM civic.members WHERE id = :id AND active", { id: assigned }, context.tx);
	if (!worker) throw new CivicError(400, "Worker not found in this organization");
	const [config] = await rows<{ roles: Record<string, Permission[]> }>("SELECT roles FROM civic.config", {}, context.tx);
	if (!config?.roles[worker.role]?.some(permission => permission === "field" || permission === "read")) {
		throw new CivicError(400, "Account cannot receive work");
	}
	await rows("UPDATE civic.records SET assigned_to = :assigned, updated_at = now() WHERE id = :id RETURNING id", { id: record.id, assigned }, context.tx);
	await rows(`INSERT INTO civic.history(id, tenant_id, request_id, actor, actor_role, previous_status, new_status, notes, note_visibility, assigned_to)
		VALUES (:history, :tenant, :id, :actor, :role, :status, :status, :notes, :visibility, :assigned) RETURNING id`, {
		history: randomUUID(), tenant: context.portal.id, id: record.id, actor: context.member.id,
		role: roleLevel(context), status: record.status, notes: text(req.body.notes || "", "notes", 5000, false),
		visibility: noteVisibility(req.body.note_visibility, context), assigned
	}, context.tx);
	res.json({ assigned_to: assigned });
});
secured(staffRoutes, "post", "/staff/requests/:id/notes", null, async (req, res, context) => {
	const record = await requestFor(context, req.params.id, true);
	const notes = text(req.body.notes, "notes", 5000);
	await rows("UPDATE civic.records SET updated_at = now() WHERE id = :id RETURNING id", { id: record.id }, context.tx);
	await rows(`INSERT INTO civic.history(id, tenant_id, request_id, actor, actor_role, previous_status, new_status, notes, note_visibility, assigned_to)
		VALUES (:history, :tenant, :id, :actor, :role, :status, :status, :notes, :visibility, :assigned) RETURNING id`, {
		history: randomUUID(), tenant: context.portal.id, id: record.id, actor: context.member.id,
		role: roleLevel(context), status: record.status, notes,
		visibility: noteVisibility(req.body.note_visibility, context), assigned: record.assigned_to
	}, context.tx);
	res.status(201).json({ recorded: true });
}, rateLimit, true);
secured(staffRoutes, "post", "/staff/requests/:id/field-photo", null, async (req, res, context) => {
	const record = await requestFor(context, req.params.id, true);
	const fieldPhoto = photo(req.body.photo);
	if (!fieldPhoto) throw new CivicError(400, "Choose a field photo to upload");
	if (record.field_photos.length >= 3) {
		throw new CivicError(400, "A ticket can have no more than three field photos");
	}
	const coordinatesProvided = req.body.longitude !== undefined || req.body.latitude !== undefined;
	const point = coordinatesProvided ? coordinates(req.body.longitude, req.body.latitude) : {
		longitude: record.longitude, latitude: record.latitude
	};
	await rows(`UPDATE civic.records SET field_photo = :fieldPhoto, field_photos = array_append(field_photos, :fieldPhoto),
		longitude = :longitude, latitude = :latitude, updated_at = now()
		WHERE id = :id RETURNING id`, { id: record.id, fieldPhoto, ...point }, context.tx);
	res.status(201).json({ uploaded: true, ...point });
}, rateLimit, true);
secured(staffRoutes, "post", "/staff/requests/:id/location", null, async (req, res, context) => {
	const record = await requestFor(context, req.params.id, true);
	if (record.assigned_to !== context.member.id) throw new CivicError(403, "This ticket is no longer assigned to you");
	const point = coordinates(req.body.longitude, req.body.latitude);
	await rows(`UPDATE civic.records SET longitude = :longitude, latitude = :latitude, updated_at = now()
		WHERE id = :id RETURNING id`, { id: record.id, ...point }, context.tx);
	res.json({ saved: true, ...point });
}, undefined, true);
secured(staffRoutes, "post", "/staff/requests/:id/archive", "read", async (req, res, context) => {
	const record = await requestFor(context, req.params.id, true);
	if (record.assigned_to && !context.permissions.includes("read")) throw new CivicError(403, "Permission denied");
	await rows("UPDATE civic.records SET archived_at = now(), archived_by = :actor, updated_at = now() WHERE id = :id RETURNING id",
		{ id: record.id, actor: context.member.id }, context.tx);
	res.json({ archived: true });
});
secured(staffRoutes, "post", "/staff/requests/:id/visibility", "publish", async (req, res, context) => {
	const record = await requestFor(context, req.params.id);
	if (typeof req.body.published !== "boolean") throw new CivicError(400, "Invalid visibility");
	if (req.body.published && !readyForPublicTicket(record, context.portal.settings.states)) {
		throw new CivicError(409, "Complete this ticket before publishing it to the public portal");
	}
	await rows("UPDATE civic.records SET published = :published WHERE id = :id RETURNING id",
		{ id: record.id, published: req.body.published }, context.tx);
	res.json({ published: req.body.published });
});
secured(staffRoutes, "get", "/staff/members", "read", async (_req, res, context) => {
	res.json(await rows("SELECT id, email, display_name, role, active FROM civic.members ORDER BY lower(display_name), email", {}, context.tx));
});
secured(staffRoutes, "get", "/staff/roles", "manage", async (_req, res, context) => {
	const [config] = await rows("SELECT roles FROM civic.config", {}, context.tx);
	res.json(config);
});
secured(staffRoutes, "put", "/staff/roles", "manage", async (req, res, context) => {
	const roles: unknown = req.body.roles;
	if (!roles || typeof roles !== "object" || Array.isArray(roles) || Object.keys(roles).length > 30) {
		throw new CivicError(400, "Invalid roles");
	}
	for (const [key, allowed] of Object.entries(roles)) {
		if (!/^[a-z_]{2,40}$/.test(key) || !Array.isArray(allowed) ||
			allowed.some(item => !permissions.includes(item))) throw new CivicError(400, "Invalid role permissions");
	}
	const parsed = roles as Record<string, Permission[]>;
	if (!parsed.admin?.includes("manage") || !parsed.admin.includes("read")) throw new CivicError(400, "Admin must retain manage and read");
	await rows("SELECT tenant_id FROM civic.config FOR UPDATE", {}, context.tx);
	const members = await rows<Member>("SELECT role FROM civic.members WHERE active", {}, context.tx);
	if (members.some(member => !parsed[member.role])) throw new CivicError(409, "Cannot remove a role used by an active member");
	await rows("UPDATE civic.config SET roles = CAST(:roles AS jsonb) RETURNING tenant_id",
		{ roles: JSON.stringify(parsed) }, context.tx);
	res.json({ roles: parsed });
});
secured(staffRoutes, "post", "/staff/members", "manage", async (req, res, context) => {
	const email = text(req.body.email, "email", 254).toLowerCase();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CivicError(400, "Invalid email");
	const displayName = text(req.body.display_name, "member name", 100);
	const role = text(req.body.role, "role", 40);
	const [config] = await rows<{ roles: Record<string, Permission[]> }>("SELECT roles FROM civic.config FOR SHARE", {}, context.tx);
	if (!config?.roles[role]) throw new CivicError(400, "Unknown role");
	const result = await rows(`INSERT INTO civic.members(id, tenant_id, email, display_name, role)
		VALUES (:id, :tenant, :email, :displayName, :role) RETURNING id, email, display_name, role, active`, {
		id: randomUUID(), tenant: context.portal.id, email, displayName, role
	}, context.tx);
	res.status(201).json(result[0]);
});
secured(staffRoutes, "put", "/staff/members/:id", "manage", async (req, res, context) => {
	const id = identifier(req.params.id);
	const displayName = text(req.body.display_name, "member name", 100);
	const role = text(req.body.role, "role", 40);
	if (typeof req.body.active !== "boolean") throw new CivicError(400, "Invalid account status");
	if (id === context.member.id && (role !== context.member.role || !req.body.active)) {
		throw new CivicError(400, "Use another administrator to change your own access");
	}
	const [config] = await rows<{ roles: Record<string, Permission[]> }>("SELECT roles FROM civic.config FOR SHARE", {}, context.tx);
	if (!config?.roles[role]) throw new CivicError(400, "Unknown role");
	const result = await rows("UPDATE civic.members SET display_name = :displayName, role = :role, active = :active WHERE id = :id RETURNING id, email, display_name, role, active",
		{ id, displayName, role, active: req.body.active }, context.tx);
	if (!result.length) throw new CivicError(404, "Member not found");
	res.json(result[0]);
});
secured(staffRoutes, "put", "/staff/settings", "manage", async (req, res, context) => {
	const settings = validateSettings(req.body.settings);
	const name = text(req.body.name, "organization name", 100);
	await rows("SELECT id FROM civic.portals WHERE id = :id FOR UPDATE", { id: context.portal.id }, context.tx);
	const used = await rows<{ status: string }>("SELECT DISTINCT status FROM civic.records WHERE kind = 'request'", {}, context.tx);
	const historical = await rows<{ status: string }>(
		"SELECT DISTINCT new_status AS status FROM civic.history", {}, context.tx);
	if ([...used, ...historical].some(record => !settings.states.some(state => state.key === record.status))) {
		throw new CivicError(409, "Cannot remove workflow states used by existing requests");
	}
	await rows("UPDATE civic.portals SET name = :name, settings = CAST(:settings AS jsonb) WHERE id = :id RETURNING id", {
		id: context.portal.id, name, settings: JSON.stringify(settings)
	}, context.tx);
	res.json({ ...context.portal, name, settings });
});
secured(staffRoutes, "get", "/staff/content", "publish", async (_req, res, context) => {
	res.json(await rows(`SELECT ${publicColumns}, published FROM civic.records WHERE kind <> 'request' AND archived_at IS NULL ORDER BY created_at DESC LIMIT 500`, {}, context.tx));
});
secured(staffRoutes, "post", "/staff/content", "publish", async (req, res, context) => {
	const kind = text(req.body.kind, "content type", 40);
	if (!contentKinds.includes(kind)) throw new CivicError(400, "Invalid content type");
	if (typeof req.body.published !== "boolean") throw new CivicError(400, "Invalid publication state");
	const result = await rows(`INSERT INTO civic.records(id, tenant_id, kind, title, description, location, longitude, latitude, published, url, calendar_date)
		VALUES (:id, :tenant, :kind, :title, :description, :location, :longitude, :latitude, :published, :url, CAST(:calendarDate AS date)) RETURNING ${publicColumns}, published`, {
		id: randomUUID(), tenant: context.portal.id, kind, title: text(req.body.title, "title", 150),
		description: text(req.body.description, "description", 10000), location: text(req.body.location || "", "location", 500, false),
		...coordinates(req.body.longitude, req.body.latitude), published: req.body.published, url: safeUrl(req.body.url),
		calendarDate: calendarDate(req.body.calendar_date)
	}, context.tx);
	res.status(201).json(result[0]);
});
secured(staffRoutes, "put", "/staff/content/:id", "publish", async (req, res, context) => {
	if (typeof req.body.published !== "boolean") throw new CivicError(400, "Invalid publication state");
	const editing = req.body.title !== undefined;
	const values = editing ? {
		title: text(req.body.title, "title", 150),
		description: text(req.body.description, "description", 10000),
		location: text(req.body.location || "", "location", 500, false),
		...coordinates(req.body.longitude, req.body.latitude),
		url: safeUrl(req.body.url),
		calendarDate: calendarDate(req.body.calendar_date)
	} : {};
	const result = await rows(`UPDATE civic.records SET published = :published, updated_at = now()
		${editing ? ", title = :title, description = :description, location = :location, longitude = :longitude, latitude = :latitude, url = :url, calendar_date = CAST(:calendarDate AS date)" : ""}
		WHERE id = :id AND kind <> 'request' AND archived_at IS NULL RETURNING ${publicColumns}, published`,
		{ id: identifier(req.params.id), published: req.body.published, ...values }, context.tx);
	if (!result.length) throw new CivicError(404, "Content not found");
	res.json(result[0]);
});
// Archiving only clears the item from staff and field workspaces; published information stays on the public portal.
secured(staffRoutes, "post", "/staff/content/:id/archive", "publish", async (req, res, context) => {
	const result = await rows(`UPDATE civic.records SET archived_at = now(), archived_by = :actor, updated_at = now()
		WHERE id = :id AND kind <> 'request' AND archived_at IS NULL RETURNING id`,
		{ id: identifier(req.params.id), actor: context.member.id }, context.tx);
	if (!result.length) throw new CivicError(404, "Content not found");
	res.json({ archived: true });
});

