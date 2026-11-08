import { Router } from "express";
import { endpoint, rateLimit, portalBySlug, accessToken, platformAccessToken, secured, scope, requireOperations, roleLevel, noteVisibility, canReadNote, readyForPublicTicket, requestFor, photo, photos, publicStatus, publicColumns, syncVersion, staffColumns, contentKinds, type Portal, type Member, type Context, type Reply, type RecordRow, type ChatMessage, type HistoryRow } from "./router-shared";
import { CivicError, Settings, State, Permission, permissions, defaultRoles, defaultSettings, identifier, text, coordinates, trackingReference, safeUrl, calendarDate, validateSettings, fieldCanEnter, publicRequestPhotos } from "./domain";
import { rows, tenantTransaction } from "./database";
import { geojson } from "./map-data";
export const mapRoutes = Router();

mapRoutes.get("/public/:slug/map", endpoint(async (req, res) => {
	const portal = await portalBySlug(req.params.slug);
	const records = await tenantTransaction(portal.id, tx => rows<RecordRow>(
		`SELECT id, kind, title, status, location, longitude, latitude FROM civic.records
		 WHERE longitude IS NOT NULL AND (published OR (kind = 'request' AND status <> 'submitted'))
		 ORDER BY created_at DESC, id LIMIT 5001`, {}, tx));
	res.json(geojson(records, portal.settings.states));
}));
secured(mapRoutes, "get", "/staff/map", null, async (_req, res, context) => {
	requireOperations(context);
	const records = await rows<RecordRow>(
		`SELECT id, kind, title, status, location, longitude, latitude FROM civic.records WHERE longitude IS NOT NULL
		AND (kind = 'request' OR archived_at IS NULL)
		${context.permissions.includes("read") ? "" : "AND ((kind = 'request' AND assigned_to = :actor) OR (kind <> 'request' AND published))"}
		ORDER BY created_at DESC, id LIMIT 5001`, { actor: context.member.id }, context.tx);
	res.json(geojson(records, context.portal.settings.states));
});

