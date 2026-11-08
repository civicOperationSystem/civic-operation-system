import { randomUUID } from "node:crypto";
import { Request } from "express";
import { Router } from "express";
import { endpoint, rateLimit, portalBySlug, accessToken, platformAccessToken, secured, scope, requireOperations, roleLevel, noteVisibility, canReadNote, readyForPublicTicket, requestFor, photo, photos, publicStatus, publicColumns, syncVersion, staffColumns, contentKinds, type Portal, type Member, type Context, type Reply, type RecordRow, type ChatMessage, type HistoryRow } from "./router-shared";
import { CivicError, Settings, State, Permission, permissions, defaultRoles, defaultSettings, identifier, text, coordinates, trackingReference, safeUrl, calendarDate, validateSettings, fieldCanEnter, publicRequestPhotos } from "./domain";
import { rows, tenantTransaction } from "./database";
export const chatRoutes = Router();

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
secured(chatRoutes, "get", "/staff/chat/contacts", "chat", async (_req, res, context) => {
	res.json(await rows(`SELECT member.id, member.email, COALESCE(NULLIF(member.display_name, ''), member.email) AS display_name, member.role FROM civic.members member
		JOIN civic.config tenant_config ON tenant_config.tenant_id = member.tenant_id
		WHERE member.active AND member.id <> :actor
		AND (tenant_config.roles -> member.role) @> '[\"chat\"]'::jsonb
		ORDER BY lower(member.display_name), member.email`, { actor: context.member.id }, context.tx));
});
secured(chatRoutes, "get", "/staff/chat/channels", "chat", async (_req, res, context) => {
	res.json(await rows("SELECT id, name, description, created_at FROM civic.chat_channels ORDER BY name", {}, context.tx));
});
secured(chatRoutes, "post", "/staff/chat/channels", "chat", async (req, res, context) => {
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
secured(chatRoutes, "get", "/staff/chat/direct", "chat", async (_req, res, context) => {
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
secured(chatRoutes, "post", "/staff/chat/direct", "chat", async (req, res, context) => {
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
secured(chatRoutes, "get", "/staff/chat/channels/:id/messages", "chat", async (req, res, context) => {
	const id = identifier(req.params.id);
	const [channel] = await rows("SELECT id FROM civic.chat_channels WHERE id = :id", { id }, context.tx);
	if (!channel) throw new CivicError(404, "Chat channel not found");
	res.json(await chatMessages(req, context, { channel: id }));
});
secured(chatRoutes, "get", "/staff/chat/direct/:id/messages", "chat", async (req, res, context) => {
	const id = identifier(req.params.id);
	const [thread] = await rows("SELECT id FROM civic.chat_direct_threads WHERE id = :id", { id }, context.tx);
	if (!thread) throw new CivicError(404, "Direct conversation not found");
	res.json(await chatMessages(req, context, { thread: id }));
});
secured(chatRoutes, "post", "/staff/chat/channels/:id/messages", "chat", async (req, res, context) => {
	const channel = identifier(req.params.id);
	const [found] = await rows("SELECT id FROM civic.chat_channels WHERE id = :id", { id: channel }, context.tx);
	if (!found) throw new CivicError(404, "Chat channel not found");
	await postChatMessage(context, { channel }, req.body.body, res);
}, rateLimit);
secured(chatRoutes, "post", "/staff/chat/direct/:id/messages", "chat", async (req, res, context) => {
	const thread = identifier(req.params.id);
	const [found] = await rows("SELECT id FROM civic.chat_direct_threads WHERE id = :id", { id: thread }, context.tx);
	if (!found) throw new CivicError(404, "Direct conversation not found");
	await postChatMessage(context, { thread }, req.body.body, res);
}, rateLimit);
