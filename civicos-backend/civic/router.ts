import { randomUUID } from "node:crypto";
import { Router, Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { Transaction } from "sequelize";
import { rows, tenantTransaction } from "./database";
import {
	CivicError, Settings, State, Permission, permissions, defaultRoles, defaultSettings, identifier, text,
	coordinates, trackingReference, safeUrl, validateSettings, fieldCanEnter
} from "./domain";
import { getSupabaseUser } from "./supabase-auth";
import { logger } from "../utils/logger";

type Portal = { id: string; slug: string; name: string; domain: string | null; settings: Settings; archived_at: string | null };
type Member = { id: string; tenant_id: string; email: string; display_name: string; role: string; active: boolean; supabase_user_id: string | null };
type Context = { member: Member; permissions: Permission[]; portal: Portal; tx: Transaction };
type Reply = { json: (body: unknown) => void; status: (code: number) => Reply };
type RecordRow = {
	id: string; kind: string; title: string; description: string; location: string; category: string | null;
	longitude: number | null; latitude: number | null; published: boolean;
	status: string | null; reference: string | null; assigned_to: string | null;
	photo: string | null;
	field_photo: string | null;
	field_photos: string[];
	created_at: string; updated_at: string;
};
type ChatMessage = {
	id: string; sender_id: string; sender_email: string; sender_name: string; body: string; created_at: string;
};
type HistoryRow = {
	id: string; actor: string | null; actor_role: string | null; previous_status: string | null; new_status: string;
	notes: string; note_visibility: "role_only" | "down_chain"; assigned_to: string | null; created_at: string;
};
const publicColumns = "id, kind, title, description, location, longitude, latitude, url, created_at, updated_at";
const staffColumns = "id, kind, title, description, location, category, longitude, latitude, published, status, reference, assigned_to, archived_at, field_photo, field_photos, created_at, updated_at";
const contentKinds = ["service", "announcement", "event", "project", "facility", "document", "emergency", "infrastructure"];
export const civicRouter = Router();

function endpoint(work: (req: Request, res: Response) => Promise<void>) {
	return (req: Request, res: Response, next: NextFunction) => { void work(req, res).catch(next); };
}
const rateBuckets = new Map<string, { count: number; reset: number }>();
function rateLimit(req: Request, res: Response, next: NextFunction): void {
	const now = Date.now();
	const key = `${req.ip}:${req.path}`;
	if (rateBuckets.size > 10000) {
		for (const [id, bucket] of rateBuckets) if (bucket.reset <= now) rateBuckets.delete(id);
		if (rateBuckets.size > 10000) {
			res.status(503).json({ message: "Please try again later" }); return;
		}
	}
	const existing = rateBuckets.get(key);
	const bucket = existing && existing.reset > now ? existing : { count: 0, reset: now + 60000 };
	rateBuckets.set(key, bucket);
	if (++bucket.count > 20) {
		res.setHeader("Retry-After", "60");
		res.status(429).json({ message: "Too many attempts. Try again in one minute." }); return;
	}
	next();
}

async function portalBySlug(slug: unknown): Promise<Portal> {
	const name = text(slug, "organization slug", 60);
	const [portal] = await rows<Portal>("SELECT * FROM civic.portals WHERE slug = :slug AND archived_at IS NULL", { slug: name });
	if (!portal) throw new CivicError(404, "Organization not found");
	return portal;
}
function accessToken(req: Request): { tenant: string; subject: string } {
	const secret = process.env.JWT_SECRET;
	if (!secret || secret.length < 32) throw new CivicError(503, "Authentication is not configured");
	const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
	if (!token) throw new CivicError(401, "Sign in required");
	try {
		const payload = jwt.verify(token, secret, {
			algorithms: ["HS256"], issuer: "civicos", audience: "civicos-operations"
		});
		if (typeof payload === "string" || payload.type !== "access") throw new Error("Invalid token type");
		return { tenant: identifier(payload.tenant), subject: identifier(payload.sub) };
	} catch { throw new CivicError(401, "Invalid or expired session"); }
}
function platformAccessToken(req: Request): { subject: string; email: string } {
	const secret = process.env.JWT_SECRET;
	const configuredEmail = process.env.CIVIC_PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
	if (!secret || secret.length < 32 || !configuredEmail) throw new CivicError(503, "Platform administration is not configured");
	const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
	if (!token) throw new CivicError(401, "Platform owner sign-in required");
	try {
		const payload = jwt.verify(token, secret, {
			algorithms: ["HS256"], issuer: "civicos", audience: "civicos-operations"
		});
		if (typeof payload === "string" || payload.type !== "platform_admin" ||
			typeof payload.email !== "string" || payload.email !== configuredEmail) {
			throw new Error("Invalid platform owner token");
		}
		return { subject: identifier(payload.sub), email: payload.email };
	} catch { throw new CivicError(401, "Invalid or expired platform owner session"); }
}
function secured(
	method: "get" | "post" | "put",
	path: string,
	permission: Permission | null,
	work: (req: Request, res: Reply, context: Context) => Promise<void>,
	middleware?: (req: Request, res: Response, next: NextFunction) => void
): void {
	civicRouter[method](path, ...(middleware ? [middleware] : []), endpoint(async (req, res) => {
		const session = accessToken(req);
		let body: unknown;
		let status = 200;
		const reply: Reply = {
			json(value) { body = value; },
			status(code) { status = code; return reply; }
		};
		await tenantTransaction(session.tenant, async tx => {
			const [member] = await rows<Member>("SELECT * FROM civic.members WHERE id = :id AND active", { id: session.subject }, tx);
			const [config] = await rows<{ roles: Record<string, Permission[]> }>("SELECT roles FROM civic.config", {}, tx);
			const [portal] = await rows<Portal>("SELECT * FROM civic.portals WHERE id = :id AND archived_at IS NULL", { id: session.tenant }, tx);
			if (!member || !config || !portal) throw new CivicError(401, "Account is no longer active");
			const allowed = config.roles[member.role] || [];
			if (permission && !allowed.includes(permission)) throw new CivicError(403, "Permission denied");
			await work(req, reply, { member, permissions: allowed, portal, tx });
		}, session.subject);
		res.status(status).json(body);
	}));
}
function scope(context: Context): string {
	return context.permissions.includes("read") ? "" : " AND assigned_to = :actor";
}
function requireOperations(context: Context): void {
	if (!context.permissions.includes("read") && !context.permissions.includes("field")) {
		throw new CivicError(403, "Permission denied");
	}
}
	function roleLevel(context: Context): "field" | "staff" | "admin" {
		if (context.permissions.includes("manage")) return "admin";
		return context.permissions.includes("read") ? "staff" : "field";
	}
	function noteVisibility(value: unknown, context: Context): "role_only" | "down_chain" {
		if (roleLevel(context) === "field") return "down_chain";
		if (value === undefined || value === "role_only") return "role_only";
		if (value === "down_chain") return "down_chain";
		throw new CivicError(400, "Invalid note visibility");
	}
	function canReadNote(event: HistoryRow, context: Context): boolean {
		if (!event.notes) return true;
		const viewer = roleLevel(context);
		const author = event.actor_role || "staff";
		if (author === "field") return viewer === "field" || viewer === "staff" || viewer === "admin";
		if (event.note_visibility === "down_chain") {
			return author === "admin" || viewer === author || (author === "staff" && viewer === "field");
		}
		return viewer === author;
	}
function readyForPublicTicket(record: RecordRow, states: State[]): boolean {
	const state = states.find(item => item.key === record.status);
	return !!state && (state.key === "completed" || state.next.length === 0);
}
async function requestFor(context: Context, id: unknown, lock = false): Promise<RecordRow> {
	requireOperations(context);
	const [record] = await rows<RecordRow>(
		`SELECT ${staffColumns} FROM civic.records WHERE id = :id AND kind = 'request'${scope(context)}${lock ? " FOR UPDATE" : ""}`,
		{ id: identifier(id), actor: context.member.id }, context.tx
	);
	if (!record) throw new CivicError(404, "Request not found");
	return record;
}
function photo(value: unknown): string | null {
	if (value == null || value === "") return null;
	if (typeof value !== "string" || value.length > 2800000) throw new CivicError(400, "Photo must be at most 2 MB");
	const match = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/);
	if (!match?.[2]) throw new CivicError(400, "Use a PNG, JPEG or WebP photo");
	const bytes = Buffer.from(match[2], "base64");
	const valid = (match[1] === "png" && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") ||
		(match[1] === "jpeg" && bytes.subarray(0, 3).toString("hex") === "ffd8ff") ||
		(match[1] === "webp" && bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP");
	if (!valid || bytes.length > 2097152) throw new CivicError(400, "Invalid image or image exceeds 2 MB");
	return value;
}
function publicStatus(status: string | null, states: State[]): string {
	return states.find(state => state.key === status)?.label || "Status unavailable";
}

civicRouter.get("/public/organizations/list", endpoint(async (_req, res) => {
	res.json(await rows<{ name: string; slug: string }>(
		"SELECT name, slug FROM civic.portals WHERE archived_at IS NULL ORDER BY lower(name), slug"
	));
}));
civicRouter.get("/public/portal", endpoint(async (req, res) => {
	const domain = text(req.query.domain, "domain", 253).toLowerCase();
	const [portal] = await rows<Portal>("SELECT * FROM civic.portals WHERE domain = :domain AND archived_at IS NULL", { domain });
	if (!portal) throw new CivicError(404, "No portal is configured for this domain");
	res.json(portal);
}));
civicRouter.get("/public/:slug", endpoint(async (req, res) => {
	res.json(await portalBySlug(req.params.slug));
}));
civicRouter.get("/public/:slug/content", endpoint(async (req, res) => {
	const portal = await portalBySlug(req.params.slug);
	const records = await tenantTransaction(portal.id, tx =>
		rows(`SELECT ${publicColumns} FROM civic.records WHERE published AND kind <> 'request' ORDER BY created_at DESC LIMIT 500`, {}, tx));
	res.json(records);
}));
civicRouter.get("/public/:slug/requests/calendar", endpoint(async (req, res) => {
	const portal = await portalBySlug(req.params.slug);
	const records = await tenantTransaction(portal.id, tx =>
		rows<Pick<RecordRow, "id" | "title" | "category" | "status" | "created_at"> & { completed_at: string | null }>(
			`SELECT record.id, record.title, record.category, record.status, record.created_at,
				(SELECT history.created_at FROM civic.history history WHERE history.request_id = record.id
					AND history.new_status = 'completed' ORDER BY history.created_at DESC, history.id DESC LIMIT 1) AS completed_at
			 FROM civic.records record WHERE record.kind = 'request' AND record.status <> 'submitted' AND record.archived_at IS NULL
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
civicRouter.get("/public/:slug/requests/:id", endpoint(async (req, res) => {
	const portal = await portalBySlug(req.params.slug);
	const result = await tenantTransaction(portal.id, async tx => {
		const [record] = await rows<Pick<RecordRow, "id" | "title" | "description" | "category" | "status" | "location" | "longitude" | "latitude" | "photo" | "field_photos" | "published" | "created_at" | "updated_at">>(
			"SELECT id, title, description, category, status, location, longitude, latitude, photo, field_photos, published, created_at, updated_at FROM civic.records WHERE id = :id AND kind = 'request' AND status <> 'submitted' AND archived_at IS NULL",
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
			location: record.published ? record.location : "",
			longitude: record.published ? record.longitude : null,
			latitude: record.published ? record.latitude : null,
			photos: record.published ? [record.photo, ...record.field_photos].filter((value): value is string => !!value) : [],
			created_at: record.created_at,
			updated_at: record.updated_at,
			completed_at: completedAt,
			history: history.map(event => ({ status: publicStatus(event.new_status, portal.settings.states), timestamp: event.created_at }))
		};
	});
	res.setHeader("Cache-Control", "no-store");
	res.json(result);
}));
civicRouter.post("/public/:slug/requests", rateLimit, endpoint(async (req, res) => {
	const portal = await portalBySlug(req.params.slug);
	const category = text(req.body.category, "category", 100);
	if (!portal.settings.categories.includes(category)) throw new CivicError(400, "Unknown category");
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
		id: randomUUID(), tenant: portal.id, reference: trackingReference(), category,
		description: text(req.body.description, "description", 5000),
		location: text(req.body.location, "location", 500),
		...coordinates(req.body.longitude, req.body.latitude),
		contact: JSON.stringify(contact), photo: photo(req.body.photo)
	};
	await tenantTransaction(portal.id, async tx => {
		await rows(`INSERT INTO civic.records (id, tenant_id, kind, title, description, category, location,
			longitude, latitude, status, reference, contact, photo)
			VALUES (:id, :tenant, 'request', :category, :description, :category, :location,
			:longitude, :latitude, 'submitted', :reference, CAST(:contact AS jsonb), :photo) RETURNING id`, values, tx);
		await rows(`INSERT INTO civic.history(id, tenant_id, request_id, new_status)
			VALUES (:history, :tenant, :id, 'submitted') RETURNING id`, { ...values, history: randomUUID() }, tx);
	});
	res.status(201).json({ reference: values.reference, status: publicStatus("submitted", portal.settings.states) });
}));
civicRouter.post("/public/:slug/track", rateLimit, endpoint(async (req, res) => {
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
civicRouter.post("/login", rateLimit, endpoint(async (req, res) => {
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
civicRouter.post("/platform/login", rateLimit, endpoint(async (req, res) => {
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
civicRouter.get("/platform/organizations", endpoint(async (req, res) => {
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
civicRouter.post("/platform/organizations", rateLimit, endpoint(async (req, res) => {
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
civicRouter.put("/platform/organizations/:organizationId/admins/:memberId/access", endpoint(async (req, res) => {
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
civicRouter.post("/platform/organizations/:organizationId/admins/:memberId/reassign", endpoint(async (req, res) => {
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
civicRouter.put("/platform/organizations/:id/archive", endpoint(async (req, res) => {
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
civicRouter.delete("/platform/organizations/:id", endpoint(async (req, res) => {
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
		await rows("DELETE FROM civic.history WHERE tenant_id = :id", { id }, tx);
		await rows("DELETE FROM civic.records WHERE tenant_id = :id", { id }, tx);
		await rows("DELETE FROM civic.members WHERE tenant_id = :id", { id }, tx);
		await rows("DELETE FROM civic.config WHERE tenant_id = :id", { id }, tx);
		await rows("DELETE FROM civic.portals WHERE id = :id", { id }, tx);
	}, undefined, true);
	res.json({ removed: true });
}));
secured("get", "/staff/me", null, async (_req, res, context) => {
	res.json({
		user: { id: context.member.id, email: context.member.email, role: context.member.role },
		permissions: context.permissions, portal: context.portal
	});
});
secured("get", "/staff/requests", null, async (req, res, context) => {
	requireOperations(context);
	const page = Number(req.query.page || 1);
	if (!Number.isInteger(page) || page < 1 || page > 100000) throw new CivicError(400, "Invalid page");
	const archived = req.query.archived === "true";
	const includeArchived = req.query.archived === "all";
	if ((archived || includeArchived) && !context.permissions.includes("manage")) throw new CivicError(403, "Permission denied");
	res.json(await rows(`SELECT ${staffColumns} FROM civic.records WHERE kind = 'request'${includeArchived ? "" : ` AND archived_at IS ${archived ? "NOT " : ""}NULL`}${scope(context)}
		ORDER BY created_at DESC LIMIT 100 OFFSET :offset`,
		{ actor: context.member.id, offset: (page - 1) * 100 }, context.tx));
});
secured("get", "/staff/requests/:id", null, async (req, res, context) => {
	const record = await requestFor(context, req.params.id);
	const [privateData] = await rows("SELECT contact, photo FROM civic.records WHERE id = :id", { id: record.id }, context.tx);
	const history = await rows<HistoryRow>("SELECT id, actor, actor_role, previous_status, new_status, notes, note_visibility, assigned_to, created_at FROM civic.history WHERE request_id = :id ORDER BY created_at, id", { id: record.id }, context.tx);
	res.json({ ...record, ...privateData, history: history.map(event => ({
		...event, notes: canReadNote(event, context) ? event.notes : "", note_visibility: canReadNote(event, context) ? event.note_visibility : null
	})) });
});
secured("post", "/staff/requests/:id/transition", "transition", async (req, res, context) => {
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
});
secured("post", "/staff/requests/:id/assign", "assign", async (req, res, context) => {
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
secured("post", "/staff/requests/:id/notes", null, async (req, res, context) => {
	const record = await requestFor(context, req.params.id, true);
	const notes = text(req.body.notes, "notes", 5000);
	await rows(`INSERT INTO civic.history(id, tenant_id, request_id, actor, actor_role, previous_status, new_status, notes, note_visibility, assigned_to)
		VALUES (:history, :tenant, :id, :actor, :role, :status, :status, :notes, :visibility, :assigned) RETURNING id`, {
		history: randomUUID(), tenant: context.portal.id, id: record.id, actor: context.member.id,
		role: roleLevel(context), status: record.status, notes,
		visibility: noteVisibility(req.body.note_visibility, context), assigned: record.assigned_to
	}, context.tx);
	res.status(201).json({ recorded: true });
}, rateLimit);
secured("post", "/staff/requests/:id/field-photo", null, async (req, res, context) => {
	const record = await requestFor(context, req.params.id, true);
	const fieldPhoto = photo(req.body.photo);
	if (!fieldPhoto) throw new CivicError(400, "Choose a field photo to upload");
	if ((record.photo ? 1 : 0) + record.field_photos.length >= 3) {
		throw new CivicError(400, "A ticket can have no more than three photos");
	}
	const coordinatesProvided = req.body.longitude !== undefined || req.body.latitude !== undefined;
	const point = coordinatesProvided ? coordinates(req.body.longitude, req.body.latitude) : {
		longitude: record.longitude, latitude: record.latitude
	};
	await rows(`UPDATE civic.records SET field_photo = :fieldPhoto, field_photos = array_append(field_photos, :fieldPhoto),
		longitude = :longitude, latitude = :latitude, updated_at = now()
		WHERE id = :id RETURNING id`, { id: record.id, fieldPhoto, ...point }, context.tx);
	res.status(201).json({ uploaded: true, ...point });
}, rateLimit);
secured("post", "/staff/requests/:id/archive", "read", async (req, res, context) => {
	const record = await requestFor(context, req.params.id, true);
	if (record.assigned_to && !context.permissions.includes("read")) throw new CivicError(403, "Permission denied");
	await rows("UPDATE civic.records SET archived_at = now(), archived_by = :actor, updated_at = now() WHERE id = :id RETURNING id",
		{ id: record.id, actor: context.member.id }, context.tx);
	res.json({ archived: true });
});
secured("post", "/staff/requests/:id/restore", "manage", async (req, res, context) => {
	const record = await requestFor(context, req.params.id, true);
	await rows("UPDATE civic.records SET archived_at = NULL, archived_by = NULL, updated_at = now() WHERE id = :id RETURNING id",
		{ id: record.id }, context.tx);
	res.json({ archived: false });
});
secured("post", "/staff/requests/:id/visibility", "publish", async (req, res, context) => {
	const record = await requestFor(context, req.params.id);
	if (typeof req.body.published !== "boolean") throw new CivicError(400, "Invalid visibility");
	if (req.body.published && !readyForPublicTicket(record, context.portal.settings.states)) {
		throw new CivicError(409, "Complete this ticket before publishing it to the public portal");
	}
	await rows("UPDATE civic.records SET published = :published WHERE id = :id RETURNING id",
		{ id: record.id, published: req.body.published }, context.tx);
	res.json({ published: req.body.published });
});
secured("get", "/staff/members", "read", async (_req, res, context) => {
	res.json(await rows("SELECT id, email, display_name, role, active FROM civic.members ORDER BY lower(display_name), email", {}, context.tx));
});
secured("get", "/staff/roles", "manage", async (_req, res, context) => {
	const [config] = await rows("SELECT roles FROM civic.config", {}, context.tx);
	res.json(config);
});
secured("put", "/staff/roles", "manage", async (req, res, context) => {
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
secured("post", "/staff/members", "manage", async (req, res, context) => {
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
secured("put", "/staff/members/:id", "manage", async (req, res, context) => {
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
secured("put", "/staff/settings", "manage", async (req, res, context) => {
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
secured("get", "/staff/content", "publish", async (_req, res, context) => {
	res.json(await rows(`SELECT ${publicColumns}, published FROM civic.records WHERE kind <> 'request' ORDER BY created_at DESC LIMIT 500`, {}, context.tx));
});
secured("post", "/staff/content", "publish", async (req, res, context) => {
	const kind = text(req.body.kind, "content type", 40);
	if (!contentKinds.includes(kind)) throw new CivicError(400, "Invalid content type");
	if (typeof req.body.published !== "boolean") throw new CivicError(400, "Invalid publication state");
	const result = await rows(`INSERT INTO civic.records(id, tenant_id, kind, title, description, location, longitude, latitude, published, url)
		VALUES (:id, :tenant, :kind, :title, :description, :location, :longitude, :latitude, :published, :url) RETURNING ${publicColumns}, published`, {
		id: randomUUID(), tenant: context.portal.id, kind, title: text(req.body.title, "title", 150),
		description: text(req.body.description, "description", 10000), location: text(req.body.location || "", "location", 500, false),
		...coordinates(req.body.longitude, req.body.latitude), published: req.body.published, url: safeUrl(req.body.url)
	}, context.tx);
	res.status(201).json(result[0]);
});
secured("put", "/staff/content/:id", "publish", async (req, res, context) => {
	if (typeof req.body.published !== "boolean") throw new CivicError(400, "Invalid publication state");
	const editing = req.body.title !== undefined;
	const values = editing ? {
		title: text(req.body.title, "title", 150),
		description: text(req.body.description, "description", 10000),
		location: text(req.body.location || "", "location", 500, false),
		...coordinates(req.body.longitude, req.body.latitude),
		url: safeUrl(req.body.url)
	} : {};
	const result = await rows(`UPDATE civic.records SET published = :published, updated_at = now()
		${editing ? ", title = :title, description = :description, location = :location, longitude = :longitude, latitude = :latitude, url = :url" : ""}
		WHERE id = :id AND kind <> 'request' RETURNING ${publicColumns}, published`,
		{ id: identifier(req.params.id), published: req.body.published, ...values }, context.tx);
	if (!result.length) throw new CivicError(404, "Content not found");
	res.json(result[0]);
});
function geojson(records: RecordRow[], states: State[]) {
	return {
		type: "FeatureCollection",
		truncated: records.length > 5000,
		features: records.slice(0, 5000).map(record => ({
			type: "Feature", id: record.id,
			geometry: { type: "Point", coordinates: [record.longitude, record.latitude] },
			properties: {
				id: record.id, kind: record.kind, title: record.title,
				status: record.kind === "request" ? publicStatus(record.status, states) : null,
				location: record.kind === "request" ? null : record.location
			}
		}))
	};
}
function chatCursor(req: Request): { after: string; afterId: string } | null {
	if (req.query.after == null && req.query.after_id == null) return null;
	if (typeof req.query.after !== "string" || typeof req.query.after_id !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(req.query.after) ||
		!Number.isFinite(Date.parse(req.query.after))) {
		throw new CivicError(400, "Invalid chat message cursor");
	}
	return { after: req.query.after, afterId: identifier(req.query.after_id) };
}
async function postChatMessage(
	context: Context, target: { channel?: string; thread?: string }, body: unknown, res: Reply
): Promise<void> {
	const message = text(body, "message", 4000);
	const id = randomUUID();
	const result = await rows<ChatMessage>(`INSERT INTO civic.chat_messages
		(id, tenant_id, channel_id, direct_thread_id, sender_id, body)
		VALUES (:id, :tenant, :channel, :thread, :sender, :body)
		RETURNING id, sender_id, body,
			to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`, {
		id, tenant: context.portal.id, channel: target.channel || null, thread: target.thread || null,
		sender: context.member.id, body: message
	}, context.tx);
	res.status(201).json({
		...result[0],
		sender_email: context.member.email,
		sender_name: context.member.display_name || context.member.email
	});
}
secured("get", "/staff/chat/contacts", "chat", async (_req, res, context) => {
	res.json(await rows(`SELECT member.id, member.email, COALESCE(NULLIF(member.display_name, ''), member.email) AS display_name, member.role FROM civic.members member
		JOIN civic.config tenant_config ON tenant_config.tenant_id = member.tenant_id
		WHERE member.active AND member.id <> :actor
		AND (tenant_config.roles -> member.role) @> '[\"chat\"]'::jsonb
		ORDER BY lower(member.display_name), member.email`, { actor: context.member.id }, context.tx));
});
secured("get", "/staff/chat/channels", "chat", async (_req, res, context) => {
	res.json(await rows("SELECT id, name, description, created_at FROM civic.chat_channels ORDER BY name", {}, context.tx));
});
secured("post", "/staff/chat/channels", "chat", async (req, res, context) => {
	const name = text(req.body.name, "channel name", 40).toLowerCase();
	if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) {
		throw new CivicError(400, "Channel names must use lowercase letters, numbers and hyphens");
	}
	const result = await rows(`INSERT INTO civic.chat_channels(id, tenant_id, name, description, created_by)
		VALUES (:id, :tenant, :name, :description, :actor)
		RETURNING id, name, description, created_at`, {
		id: randomUUID(), tenant: context.portal.id, name,
		description: text(req.body.description || "", "channel description", 240, false),
		actor: context.member.id
	}, context.tx);
	res.status(201).json(result[0]);
}, rateLimit);
secured("get", "/staff/chat/direct", "chat", async (_req, res, context) => {
	res.json(await rows(`SELECT thread.id, counterpart.id AS member_id, counterpart.email AS member_email,
		COALESCE(NULLIF(counterpart.display_name, ''), counterpart.email) AS member_name,
		last_message.body AS last_message, last_message.created_at AS updated_at
		FROM civic.chat_direct_threads thread
		JOIN civic.members counterpart ON counterpart.tenant_id = thread.tenant_id
			AND counterpart.id = CASE WHEN thread.member_low = :actor THEN thread.member_high ELSE thread.member_low END
		LEFT JOIN LATERAL (
			SELECT message.body, message.created_at FROM civic.chat_messages message
			WHERE message.tenant_id = thread.tenant_id AND message.direct_thread_id = thread.id
			ORDER BY message.created_at DESC, message.id DESC LIMIT 1
		) last_message ON true
		WHERE :actor IN (thread.member_low, thread.member_high)
		ORDER BY last_message.created_at DESC NULLS LAST, lower(counterpart.display_name), counterpart.email`, {
		actor: context.member.id
	}, context.tx));
});
secured("post", "/staff/chat/direct", "chat", async (req, res, context) => {
	const other = identifier(req.body.member_id);
	if (other === context.member.id) throw new CivicError(400, "Choose another organization member");
	const [contact] = await rows<{ id: string }>(`SELECT member.id FROM civic.members member
		JOIN civic.config tenant_config ON tenant_config.tenant_id = member.tenant_id
		WHERE member.id = :other AND member.active AND (tenant_config.roles -> member.role) @> '[\"chat\"]'::jsonb`,
		{ other }, context.tx);
	if (!contact) throw new CivicError(404, "Chat member not found");
	const [memberLow, memberHigh] = [context.member.id, other].sort();
	let [thread] = await rows<{ id: string }>(`INSERT INTO civic.chat_direct_threads (id, tenant_id, member_low, member_high)
		VALUES (:id, :tenant, :memberLow, :memberHigh)
		ON CONFLICT (tenant_id, member_low, member_high) DO NOTHING
		RETURNING id`, {
		id: randomUUID(), tenant: context.portal.id, memberLow, memberHigh
	}, context.tx);
	if (!thread) {
		[thread] = await rows<{ id: string }>("SELECT id FROM civic.chat_direct_threads WHERE member_low = :memberLow AND member_high = :memberHigh",
			{ memberLow, memberHigh }, context.tx);
	}
	if (!thread) throw new CivicError(500, "Could not open direct conversation");
	res.status(201).json({ id: thread.id, member_id: other });
}, rateLimit);
async function chatMessages(
	req: Request, context: Context, target: { channel?: string; thread?: string }
): Promise<ChatMessage[]> {
	const cursor = chatCursor(req);
	return rows<ChatMessage>(`SELECT message.id, message.sender_id, sender.email AS sender_email,
			COALESCE(NULLIF(sender.display_name, ''), sender.email) AS sender_name, message.body,
			to_char(message.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
		FROM civic.chat_messages message
		JOIN civic.members sender ON sender.tenant_id = message.tenant_id AND sender.id = message.sender_id
		WHERE message.tenant_id = :tenant AND ${target.channel ? "message.channel_id = :target" : "message.direct_thread_id = :target"}
		${cursor ? "AND (message.created_at, message.id) > (CAST(:after AS timestamptz), CAST(:afterId AS uuid))" : ""}
		ORDER BY message.created_at ${cursor ? "ASC" : "DESC"}, message.id ${cursor ? "ASC" : "DESC"}
		LIMIT 100`, {
		tenant: context.portal.id, target: target.channel || target.thread,
		...(cursor || {})
	}, context.tx).then(messages => cursor ? messages : messages.reverse());
}
secured("get", "/staff/chat/channels/:id/messages", "chat", async (req, res, context) => {
	const id = identifier(req.params.id);
	const [channel] = await rows("SELECT id FROM civic.chat_channels WHERE id = :id", { id }, context.tx);
	if (!channel) throw new CivicError(404, "Chat channel not found");
	res.json(await chatMessages(req, context, { channel: id }));
});
secured("get", "/staff/chat/direct/:id/messages", "chat", async (req, res, context) => {
	const id = identifier(req.params.id);
	const [thread] = await rows("SELECT id FROM civic.chat_direct_threads WHERE id = :id", { id }, context.tx);
	if (!thread) throw new CivicError(404, "Direct conversation not found");
	res.json(await chatMessages(req, context, { thread: id }));
});
secured("post", "/staff/chat/channels/:id/messages", "chat", async (req, res, context) => {
	const channel = identifier(req.params.id);
	const [found] = await rows("SELECT id FROM civic.chat_channels WHERE id = :id", { id: channel }, context.tx);
	if (!found) throw new CivicError(404, "Chat channel not found");
	await postChatMessage(context, { channel }, req.body.body, res);
}, rateLimit);
secured("post", "/staff/chat/direct/:id/messages", "chat", async (req, res, context) => {
	const thread = identifier(req.params.id);
	const [found] = await rows("SELECT id FROM civic.chat_direct_threads WHERE id = :id", { id: thread }, context.tx);
	if (!found) throw new CivicError(404, "Direct conversation not found");
	await postChatMessage(context, { thread }, req.body.body, res);
}, rateLimit);
civicRouter.get("/public/:slug/map", endpoint(async (req, res) => {
	const portal = await portalBySlug(req.params.slug);
	const records = await tenantTransaction(portal.id, tx => rows<RecordRow>(
		`SELECT id, kind, title, status, location, longitude, latitude FROM civic.records
		 WHERE published AND longitude IS NOT NULL ORDER BY created_at DESC, id LIMIT 5001`, {}, tx));
	res.json(geojson(records, portal.settings.states));
}));
secured("get", "/staff/map", null, async (_req, res, context) => {
	requireOperations(context);
	const records = await rows<RecordRow>(
		`SELECT id, kind, title, status, location, longitude, latitude FROM civic.records WHERE longitude IS NOT NULL
		${context.permissions.includes("read") ? "" : "AND ((kind = 'request' AND assigned_to = :actor) OR (kind <> 'request' AND published))"}
		ORDER BY created_at DESC, id LIMIT 5001`, { actor: context.member.id }, context.tx);
	res.json(geojson(records, context.portal.settings.states));
});

export function civicErrorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
	const known = error instanceof CivicError;
	const databaseCode = error && typeof error === "object" && "original" in error ?
		(error.original as { code?: string } | undefined)?.code : undefined;
	const parseStatus = error && typeof error === "object" && "type" in error ?
		error.type === "entity.parse.failed" ? 400 : error.type === "entity.too.large" ? 413 : null : null;
	const status = known ? error.status : parseStatus || (databaseCode === "23505" ? 409 : 500);
	const message = known ? error.message : status === 400 ? "Invalid JSON request body" :
		status === 413 ? "Request exceeds the 3 MB limit" : status === 409 ? "This record already exists" : "CivicOS could not complete this operation";
	logger.error("CivicOS operation failed", {
		status, message,
		...(status === 500 ? { error: error instanceof Error ? error.message : String(error), databaseCode } : {})
	});
	res.status(status).json({ message });
}
