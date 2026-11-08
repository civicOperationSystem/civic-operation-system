import { createHash, randomUUID } from "node:crypto";
import { Router, Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { Transaction } from "sequelize";
import { rows, tenantTransaction } from "./database";
import {
	CivicError, Settings, State, Permission, permissions, defaultRoles, defaultSettings, identifier, text,
	coordinates, trackingReference, safeUrl, calendarDate, validateSettings, fieldCanEnter, publicRequestPhotos
} from "./domain";

export type Portal = { id: string; slug: string; name: string; domain: string | null; settings: Settings; archived_at: string | null };
export type Member = { id: string; tenant_id: string; email: string; display_name: string; role: string; active: boolean; supabase_user_id: string | null };
export type Context = { member: Member; permissions: Permission[]; portal: Portal; tx: Transaction };
export type Reply = { json: (body: unknown) => void; status: (code: number) => Reply };
export type RecordRow = {
	id: string; kind: string; title: string; description: string; location: string; category: string | null;
	longitude: number | null; latitude: number | null; published: boolean;
	status: string | null; reference: string | null; assigned_to: string | null;
	photo: string | null;
	photos: string[];
	field_photo: string | null;
	field_photos: string[];
	created_at: string; updated_at: string; sync_version: string;
};
export type ChatMessage = {
	id: string; sender_id: string; sender_email: string; sender_name: string; body: string; created_at: string;
};
export type HistoryRow = {
	id: string; actor: string | null; actor_role: string | null; previous_status: string | null; new_status: string;
	notes: string; note_visibility: "role_only" | "down_chain"; assigned_to: string | null; created_at: string;
};
// calendar_date is formatted in SQL so the driver never shifts the date-only value through a local-time Date.
export const publicColumns = "id, kind, title, description, location, longitude, latitude, url, to_char(calendar_date, 'YYYY-MM-DD') AS calendar_date, created_at, updated_at";
export const syncVersion = `to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export const staffColumns = `id, kind, title, description, location, category, longitude, latitude, published, status, reference, assigned_to, archived_at, photo, photos, field_photo, field_photos, created_at, updated_at, ${syncVersion} AS sync_version`;
export const contentKinds = ["service", "announcement", "event", "project", "facility", "document", "emergency", "infrastructure"];
export function endpoint(work: (req: Request, res: Response) => Promise<void>) {
	return (req: Request, res: Response, next: NextFunction) => { void work(req, res).catch(next); };
}
const rateBuckets = new Map<string, { count: number; reset: number }>();
export function rateLimit(req: Request, res: Response, next: NextFunction): void {
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

export async function portalBySlug(slug: unknown): Promise<Portal> {
	const name = text(slug, "organization slug", 60);
	const [portal] = await rows<Portal>("SELECT * FROM civic.portals WHERE slug = :slug AND archived_at IS NULL", { slug: name });
	if (!portal) throw new CivicError(404, "Organization not found");
	return portal;
}
export function accessToken(req: Request): { tenant: string; subject: string } {
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
export function platformAccessToken(req: Request): { subject: string; email: string } {
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
export function secured(
	router: Router,
	method: "get" | "post" | "put",
	path: string,
	permission: Permission | null,
	work: (req: Request, res: Reply, context: Context) => Promise<void>,
	middleware?: (req: Request, res: Response, next: NextFunction) => void,
	offline = false
): void {
	router[method](path, ...(middleware ? [middleware] : []), endpoint(async (req, res) => {
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
			const context = { member, permissions: allowed, portal, tx };
			const queued = offline && (req.body.client_operation_id !== undefined || req.body.expected_version !== undefined);
			let receipt: { id: string; fingerprint: string; requestId: string } | undefined;
			if (queued) {
				const id = identifier(req.body.client_operation_id);
				const expected = text(req.body.expected_version, "ticket version", 40);
				const record = await requestFor(context, req.params.id, true);
				if (record.assigned_to !== member.id) throw new CivicError(403, "This ticket is no longer assigned to you");
				const fingerprint = createHash("sha256").update(JSON.stringify({ path: req.path, body: req.body })).digest("hex");
				const [saved] = await rows<{ fingerprint: string; response: unknown; response_status: number }>(
					"SELECT fingerprint, response, response_status FROM civic.field_operations WHERE member_id = :member AND id = :id",
					{ member: member.id, id }, tx);
				if (saved) {
					if (saved.fingerprint !== fingerprint) throw new CivicError(409, "This operation ID was already used for a different update");
					body = saved.response; status = saved.response_status; return;
				}
				if (record.sync_version !== expected) throw new CivicError(409, "This ticket changed while offline. Review the latest ticket before resubmitting");
				receipt = { id, fingerprint, requestId: record.id };
			}
			await work(req, reply, context);
			if (receipt) {
				const [updated] = await rows<{ sync_version: string }>(
					`SELECT ${syncVersion} AS sync_version FROM civic.records WHERE id = :id`, { id: receipt.requestId }, tx);
				if (!updated || !body || typeof body !== "object") throw new Error("Missing offline update response");
				body = { ...body, sync_version: updated.sync_version };
				await rows(`INSERT INTO civic.field_operations(id, tenant_id, member_id, request_id, fingerprint, response, response_status)
					VALUES (:id, :tenant, :member, :requestId, :fingerprint, CAST(:response AS jsonb), :status) RETURNING id`, {
					...receipt, tenant: portal.id, member: member.id, response: JSON.stringify(body), status
				}, tx);
			}
		}, session.subject);
		res.status(status).json(body);
	}));
}
export function scope(context: Context): string {
	return context.permissions.includes("read") ? "" : " AND assigned_to = :actor";
}
export function requireOperations(context: Context): void {
	if (!context.permissions.includes("read") && !context.permissions.includes("field")) {
		throw new CivicError(403, "Permission denied");
	}
}
	export function roleLevel(context: Context): "field" | "staff" | "admin" {
		if (context.permissions.includes("manage")) return "admin";
		return context.permissions.includes("read") ? "staff" : "field";
	}
	export function noteVisibility(value: unknown, context: Context): "role_only" | "down_chain" {
		if (roleLevel(context) === "field") return "down_chain";
		if (value === undefined || value === "role_only") return "role_only";
		if (value === "down_chain") return "down_chain";
		throw new CivicError(400, "Invalid note visibility");
	}
	export function canReadNote(event: HistoryRow, context: Context): boolean {
		if (!event.notes) return true;
		const viewer = roleLevel(context);
		const author = event.actor_role || "staff";
		if (author === "field") return viewer === "field" || viewer === "staff" || viewer === "admin";
		if (event.note_visibility === "down_chain") {
			return author === "admin" || viewer === author || (author === "staff" && viewer === "field");
		}
		return viewer === author;
	}
export function readyForPublicTicket(record: RecordRow, states: State[]): boolean {
	const state = states.find(item => item.key === record.status);
	return !!state && (state.key === "completed" || state.next.length === 0);
}
export async function requestFor(context: Context, id: unknown, lock = false): Promise<RecordRow> {
	requireOperations(context);
	const [record] = await rows<RecordRow>(
		`SELECT ${staffColumns} FROM civic.records WHERE id = :id AND kind = 'request' AND archived_at IS NULL${scope(context)}${lock ? " FOR UPDATE" : ""}`,
		{ id: identifier(id), actor: context.member.id }, context.tx
	);
	if (!record) throw new CivicError(404, "Request not found");
	return record;
}
export function photo(value: unknown): string | null {
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
export function photos(value: unknown): string[] {
	const values = value == null ? [] : Array.isArray(value) ? value : [value];
	if (values.length > 3) throw new CivicError(400, "A ticket can have no more than three photos");
	const validated = values.map(photo);
	if (validated.some(image => image === null)) throw new CivicError(400, "Each photo must be a PNG, JPEG or WebP image");
	return validated as string[];
}
export function publicStatus(status: string | null, states: State[]): string {
	return states.find(state => state.key === status)?.label || "Status unavailable";
}
