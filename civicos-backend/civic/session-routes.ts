import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { getSupabaseUser } from "./supabase-auth";
import { Router } from "express";
import { endpoint, rateLimit, portalBySlug, accessToken, platformAccessToken, secured, scope, requireOperations, roleLevel, noteVisibility, canReadNote, readyForPublicTicket, requestFor, photo, photos, publicStatus, publicColumns, syncVersion, staffColumns, contentKinds, type Portal, type Member, type Context, type Reply, type RecordRow, type ChatMessage, type HistoryRow } from "./router-shared";
import { CivicError, Settings, State, Permission, permissions, defaultRoles, defaultSettings, identifier, text, coordinates, trackingReference, safeUrl, calendarDate, validateSettings, fieldCanEnter, publicRequestPhotos } from "./domain";
import { rows, tenantTransaction } from "./database";
export const sessionRoutes = Router();

sessionRoutes.post("/login", rateLimit, endpoint(async (req, res) => {
	const secret = process.env.JWT_SECRET;
	if (!secret || secret.length < 32) throw new CivicError(503, "Authentication is not configured");
	const portal = await portalBySlug(req.body.slug);
	const accessToken = text(req.body.access_token, "Supabase access token", 8192);
	const identity = await getSupabaseUser(accessToken);
	if (!identity) throw new CivicError(401, "Invalid or expired email sign-in link");
	const member = await tenantTransaction(portal.id, async tx => {
		const [found] = await rows<Member>(`SELECT id, tenant_id, email, role, active, supabase_user_id
			FROM civic.members WHERE active
			AND (supabase_user_id = :identity OR (supabase_user_id IS NULL AND lower(email) = :email))
			FOR UPDATE`, { identity: identity.id, email: identity.email }, tx);
		if (!found) throw new CivicError(401, "No active organization account matches this email");
		if (!found.supabase_user_id) {
			await rows("UPDATE civic.members SET supabase_user_id = :identity WHERE id = :member RETURNING id",
				{ identity: identity.id, member: found.id }, tx);
		}
		return found;
	});
	const token = jwt.sign({ tenant: portal.id, type: "access" }, secret, {
		subject: member.id, audience: "civicos-operations", issuer: "civicos", expiresIn: "1h", algorithm: "HS256"
	});
	res.setHeader("Cache-Control", "no-store");
	res.json({ token });
}));
sessionRoutes.post("/platform/login", rateLimit, endpoint(async (req, res) => {
	const secret = process.env.JWT_SECRET;
	const configuredEmail = process.env.CIVIC_PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
	if (!secret || secret.length < 32 || !configuredEmail) {
		throw new CivicError(503, "Platform administration is not configured");
	}
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(configuredEmail)) {
		throw new CivicError(503, "Platform owner email is not configured correctly");
	}
	const access = text(req.body.access_token, "Supabase access token", 8192);
	const identity = await getSupabaseUser(access);
	if (!identity || identity.email !== configuredEmail) {
		throw new CivicError(401, "This email is not authorized to administer CivicOS");
	}
	const token = jwt.sign({ type: "platform_admin", email: configuredEmail }, secret, {
		subject: identifier(identity.id), audience: "civicos-operations", issuer: "civicos",
		expiresIn: "1h", algorithm: "HS256"
	});
	res.setHeader("Cache-Control", "no-store");
	res.json({ token });
}));
sessionRoutes.get("/platform/organizations", endpoint(async (req, res) => {
	platformAccessToken(req);
	const organizations = await rows<Pick<Portal, "id" | "slug" | "name" | "domain" | "archived_at">>(
		"SELECT id, slug, name, domain, archived_at FROM civic.portals ORDER BY archived_at NULLS FIRST, name, slug");
	res.setHeader("Cache-Control", "no-store");
	res.json(await Promise.all(organizations.map(async organization => ({
		...organization,
		admins: await tenantTransaction(organization.id, tx => rows(
			"SELECT id, email, display_name, active FROM civic.members WHERE role = 'admin' ORDER BY lower(display_name), email",
			{}, tx
		), undefined, true)
	}))));
}));
sessionRoutes.post("/platform/organizations", rateLimit, endpoint(async (req, res) => {
	platformAccessToken(req);
	const name = text(req.body.name, "organization name", 120);
	const slug = text(req.body.slug, "organization slug", 60).toLowerCase();
	const email = text(req.body.admin_email, "organization admin email", 254).toLowerCase();
	const domain = text(req.body.domain ?? "", "organization domain", 253, false).toLowerCase() || null;
	if (!/^[a-z0-9-]{3,60}$/.test(slug)) throw new CivicError(400, "Organization slug must use 3-60 lowercase letters, numbers or hyphens");
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CivicError(400, "Invalid organization admin email");
	if (domain && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
		throw new CivicError(400, "Organization domain must be a hostname without a scheme");
	}
	const id = randomUUID();
	const adminId = randomUUID();
	await tenantTransaction(id, async tx => {
		await rows("INSERT INTO civic.portals(id, slug, domain, name, settings) VALUES (:id, :slug, :domain, :name, CAST(:settings AS jsonb))",
			{ id, slug, domain, name, settings: JSON.stringify(defaultSettings) }, tx);
		await rows("INSERT INTO civic.config(tenant_id, roles) VALUES (:id, CAST(:roles AS jsonb))",
			{ id, roles: JSON.stringify(defaultRoles) }, tx);
		await rows(`INSERT INTO civic.members(id, tenant_id, email, display_name, role)
			VALUES (:admin, :id, :email, initcap(replace(replace(split_part(:email, '@', 1), '.', ' '), '_', ' ')), 'admin')`,
			{ admin: adminId, id, email }, tx);
		await rows("INSERT INTO civic.chat_channels(id, tenant_id, name, description) VALUES (:channel, :id, 'general', 'Organization-wide staff chat')",
			{ channel: randomUUID(), id }, tx);
	}, undefined, true);
	res.status(201).json({ organization: {
		id, slug, name, domain, archived_at: null, admin_email: email,
		admins: [{ id: adminId, email, display_name: email.split("@")[0], active: true }]
	} });
}));
sessionRoutes.put("/platform/organizations/:organizationId/admins/:memberId/access", endpoint(async (req, res) => {
	platformAccessToken(req);
	const organizationId = identifier(req.params.organizationId);
	const memberId = identifier(req.params.memberId);
	if (typeof req.body.active !== "boolean") throw new CivicError(400, "Invalid account status");
	const [member] = await tenantTransaction(organizationId, async tx => {
		const [existing] = await rows<Member>("SELECT * FROM civic.members WHERE id = :memberId AND role = 'admin' FOR UPDATE",
			{ memberId }, tx);
		if (!existing) throw new CivicError(404, "Organization administrator not found");
		return rows("UPDATE civic.members SET active = :active WHERE id = :memberId RETURNING id, email, display_name, active",
			{ memberId, active: req.body.active }, tx);
	}, undefined, true);
	if (!member) throw new CivicError(404, "Organization administrator not found");
	res.json(member);
}));
sessionRoutes.post("/platform/organizations/:organizationId/admins/:memberId/reassign", endpoint(async (req, res) => {
	platformAccessToken(req);
	const organizationId = identifier(req.params.organizationId);
	const memberId = identifier(req.params.memberId);
	const displayName = text(req.body.display_name, "new administrator name", 100);
	const email = text(req.body.email, "new administrator email", 254).toLowerCase();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CivicError(400, "Invalid new administrator email");
	const result = await tenantTransaction(organizationId, async tx => {
		const [previous] = await rows<Member>("SELECT * FROM civic.members WHERE id = :memberId AND role = 'admin' FOR UPDATE",
			{ memberId }, tx);
		if (!previous) throw new CivicError(404, "Organization administrator not found");
		if (previous.email === email) throw new CivicError(400, "Choose a different administrator email");
		const [existing] = await rows<Member>("SELECT * FROM civic.members WHERE email = :email FOR UPDATE", { email }, tx);
		let administrator: { id: string; email: string; display_name: string; active: boolean } | undefined;
		if (existing) {
			const [updated] = await rows<{ id: string; email: string; display_name: string; active: boolean }>("UPDATE civic.members SET display_name = :displayName, role = 'admin', active = true WHERE id = :id RETURNING id, email, display_name, active",
				{ id: existing.id, displayName }, tx);
			administrator = updated;
		} else {
			const [created] = await rows<{ id: string; email: string; display_name: string; active: boolean }>(`INSERT INTO civic.members(id, tenant_id, email, display_name, role)
				VALUES (:id, :tenant, :email, :displayName, 'admin') RETURNING id, email, display_name, active`,
				{ id: randomUUID(), tenant: organizationId, email, displayName }, tx);
			administrator = created;
		}
		const [deactivated] = await rows<{ id: string; email: string; display_name: string; active: boolean }>("UPDATE civic.members SET active = false WHERE id = :id RETURNING id, email, display_name, active",
			{ id: previous.id }, tx);
		if (!administrator || !deactivated) throw new CivicError(500, "Could not reassign organization administrator");
		return { administrator, previous: deactivated };
	}, undefined, true);
	res.status(201).json(result);
}));
sessionRoutes.put("/platform/organizations/:id/archive", endpoint(async (req, res) => {
	platformAccessToken(req);
	const id = identifier(req.params.id);
	if (typeof req.body.archived !== "boolean") throw new CivicError(400, "Invalid archive status");
	const [organization] = await tenantTransaction(id, tx => rows<Pick<Portal, "id" | "archived_at">>(
		"UPDATE civic.portals SET archived_at = CASE WHEN :archived THEN now() ELSE NULL END WHERE id = :id RETURNING id, archived_at",
		{ id, archived: req.body.archived }, tx
	), undefined, true);
	if (!organization) throw new CivicError(404, "Organization not found");
	res.json(organization);
}));
sessionRoutes.delete("/platform/organizations/:id", endpoint(async (req, res) => {
	platformAccessToken(req);
	const id = identifier(req.params.id);
	await tenantTransaction(id, async tx => {
		const [organization] = await rows<Pick<Portal, "id" | "archived_at">>(
			"SELECT id, archived_at FROM civic.portals WHERE id = :id FOR UPDATE", { id }, tx);
		if (!organization) throw new CivicError(404, "Organization not found");
		if (!organization.archived_at) throw new CivicError(409, "Archive the organization before permanently removing it");
		await rows("DELETE FROM civic.chat_messages WHERE tenant_id = :id", { id }, tx);
		await rows("DELETE FROM civic.chat_direct_threads WHERE tenant_id = :id", { id }, tx);
		await rows("DELETE FROM civic.chat_channels WHERE tenant_id = :id", { id }, tx);
		await rows("DELETE FROM civic.field_operations WHERE tenant_id = :id", { id }, tx);
		await rows("DELETE FROM civic.history WHERE tenant_id = :id", { id }, tx);
		await rows("DELETE FROM civic.records WHERE tenant_id = :id", { id }, tx);
		await rows("DELETE FROM civic.members WHERE tenant_id = :id", { id }, tx);
		await rows("DELETE FROM civic.config WHERE tenant_id = :id", { id }, tx);
		await rows("DELETE FROM civic.portals WHERE id = :id", { id }, tx);
	}, undefined, true);
	res.json({ removed: true });
}));

