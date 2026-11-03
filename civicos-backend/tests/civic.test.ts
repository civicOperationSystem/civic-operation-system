import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import jwt from "jsonwebtoken";
import { QueryTypes, Sequelize } from "sequelize";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { coordinates, defaultRoles, defaultSettings, validateSettings, fieldCanEnter } from "../civic/domain";
import app from "../index";
import * as database from "../civic/database";

const { identities } = vi.hoisted(() => ({
	identities: new Map<string, { id: string; email: string }>()
}));
vi.mock("../civic/supabase-auth", () => ({
	getSupabaseUser: async (accessToken: string) => identities.get(accessToken) || null
}));
vi.hoisted(() => {
	process.env.CIVIC_DB_HOST = "127.0.0.1";
	process.env.CIVIC_DB_PORT = process.env.CIVIC_TEST_PORT || "15433";
	process.env.CIVIC_DATABASE = "civicos_test";
	process.env.CIVIC_DB_USER = "civic_app";
	process.env.CIVIC_DB_PASSWORD = process.env.CIVIC_TEST_APP_PASSWORD || `${crypto.randomUUID()}${crypto.randomUUID()}`;
	process.env.CIVIC_DATABASE_URL = "";
	process.env.DATABASE_URL = "";
	process.env.CIVIC_ADMIN_DATABASE_URL = "";
	process.env.JWT_SECRET = `${crypto.randomUUID()}${crypto.randomUUID()}`;
	process.env.SUPABASE_URL = "https://auth.example.test";
	process.env.SUPABASE_ANON_KEY = "test-anon-key";
	process.env.CIVIC_PLATFORM_ADMIN_EMAIL = "owner@example.org";
	delete process.env.ENABLE_LEGACY_DEMO;
});
const owner = new Sequelize("civicos_test", "postgres", process.env.CIVIC_TEST_PASSWORD || "civicos-test-local-only", {
	host: "127.0.0.1", port: Number(process.env.CIVIC_DB_PORT), dialect: "postgres", logging: false
});
const tenantA = randomUUID();
const tenantB = randomUUID();
const adminA = randomUUID();
const adminB = randomUUID();
const fieldA = randomUUID();
const fieldAnotherA = randomUUID();
const readOnlyA = randomUUID();
const slugA = `town-${randomBytes(5).toString("hex")}`;
const slugB = `town-${randomBytes(5).toString("hex")}`;
let tokenA: string;
let tokenB: string;
let fieldToken: string;
let fieldAnotherToken: string;
let readOnlyToken: string;
let reference: string;
let requestId: string;
let createdPlatformTenant: string | undefined;
const residentPhoto = "data:image/png;base64,iVBORw0KGgo=";
const fieldPhoto = "data:image/jpeg;base64,/9j/";

async function login(slug: string, email: string): Promise<string> {
	const accessToken = `verified-${randomUUID()}`;
	identities.set(accessToken, { id: randomUUID(), email });
	const response = await request(app).post("/api/civic/login").send({ slug, access_token: accessToken });
	expect(response.status).toBe(200);
	return response.body.token as string;
}

beforeAll(async () => {
	await owner.authenticate();
	await owner.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'civic_app') THEN
		CREATE ROLE civic_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF; END $$`);
	await owner.query("ALTER ROLE civic_app PASSWORD :password", { replacements: { password: process.env.CIVIC_DB_PASSWORD } });
	await owner.query(readFileSync(join(process.cwd(), "civic", "schema.sql"), "utf8"));
	for (const [id, slug, member] of [[tenantA, slugA, adminA], [tenantB, slugB, adminB]]) {
		const legacyRoles = Object.fromEntries(Object.entries(defaultRoles).map(([role, allowed]) =>
			[role, allowed.filter(permission => permission !== "chat")]));
		const roles = id === tenantA ? { ...legacyRoles, observer: ["read"] } : legacyRoles;
		await owner.query(`INSERT INTO civic.portals VALUES (:id, :slug, NULL, :name, CAST(:settings AS jsonb));
			INSERT INTO civic.config VALUES (:id, CAST(:roles AS jsonb));
			INSERT INTO civic.members(id, tenant_id, email, role) VALUES (:member, :id, 'admin@example.org', 'admin')`, {
			replacements: { id, slug, member, name: slug, settings: JSON.stringify(defaultSettings),
				roles: JSON.stringify(roles) }
		});
	}
	await owner.query(`INSERT INTO civic.members(id, tenant_id, email, role)
		VALUES (:id, :tenant, 'worker@example.org', 'field')`, {
		replacements: { id: fieldA, tenant: tenantA }
	});
	await owner.query(`INSERT INTO civic.members(id, tenant_id, email, role) VALUES
		(:another, :tenant, 'another-worker@example.org', 'field'),
		(:readOnly, :tenant, 'read-only@example.org', 'observer')`, {
		replacements: { another: fieldAnotherA, readOnly: readOnlyA, tenant: tenantA }
	});
	await owner.query(readFileSync(join(process.cwd(), "civic", "schema.sql"), "utf8"));
	await database.verifyCivicDatabase();
	tokenA = await login(slugA, "admin@example.org");
	tokenB = await login(slugB, "admin@example.org");
	fieldToken = await login(slugA, "worker@example.org");
	fieldAnotherToken = await login(slugA, "another-worker@example.org");
	readOnlyToken = await login(slugA, "read-only@example.org");
}, 30000);
afterAll(async () => {
	await database?.civicDatabase.close();
	if (createdPlatformTenant) {
		await owner.query("DELETE FROM civic.chat_messages WHERE tenant_id = :tenant", { replacements: { tenant: createdPlatformTenant } });
		await owner.query("DELETE FROM civic.chat_channels WHERE tenant_id = :tenant", { replacements: { tenant: createdPlatformTenant } });
		await owner.query("DELETE FROM civic.history WHERE tenant_id = :tenant", { replacements: { tenant: createdPlatformTenant } });
		await owner.query("DELETE FROM civic.records WHERE tenant_id = :tenant", { replacements: { tenant: createdPlatformTenant } });
		await owner.query("DELETE FROM civic.members WHERE tenant_id = :tenant", { replacements: { tenant: createdPlatformTenant } });
		await owner.query("DELETE FROM civic.config WHERE tenant_id = :tenant", { replacements: { tenant: createdPlatformTenant } });
		await owner.query("DELETE FROM civic.portals WHERE id = :tenant", { replacements: { tenant: createdPlatformTenant } });
	}
	await owner.query("DELETE FROM civic.chat_messages WHERE tenant_id IN (:a, :b)", { replacements: { a: tenantA, b: tenantB } });
	await owner.query("DELETE FROM civic.chat_direct_threads WHERE tenant_id IN (:a, :b)", { replacements: { a: tenantA, b: tenantB } });
	await owner.query("DELETE FROM civic.chat_channels WHERE tenant_id IN (:a, :b)", { replacements: { a: tenantA, b: tenantB } });
	await owner.query("DELETE FROM civic.field_operations WHERE tenant_id IN (:a, :b)", { replacements: { a: tenantA, b: tenantB } });
	await owner.query("DELETE FROM civic.history WHERE tenant_id IN (:a, :b)", { replacements: { a: tenantA, b: tenantB } });
	await owner.query("DELETE FROM civic.records WHERE tenant_id IN (:a, :b)", { replacements: { a: tenantA, b: tenantB } });
	await owner.query("DELETE FROM civic.members WHERE tenant_id IN (:a, :b)", { replacements: { a: tenantA, b: tenantB } });
	await owner.query("DELETE FROM civic.config WHERE tenant_id IN (:a, :b)", { replacements: { a: tenantA, b: tenantB } });
	await owner.query("DELETE FROM civic.portals WHERE id IN (:a, :b)", { replacements: { a: tenantA, b: tenantB } });
	await owner.close();
});
const api = (method: "get" | "post" | "put", path: string, token = tokenA) =>
	request(app)[method](`/api/civic${path}`).set("Authorization", `Bearer ${token}`);

describe("CivicOS identity and database isolation", () => {
	it("allows only the configured platform owner to create isolated organizations and bottom admins", async () => {
		const ownerAccess = `verified-${randomUUID()}`;
		identities.set(ownerAccess, { id: randomUUID(), email: "owner@example.org" });
		const ownerLogin = await request(app).post("/api/civic/platform/login").send({ access_token: ownerAccess });
		expect(ownerLogin.status).toBe(200);
		const ownerToken = ownerLogin.body.token as string;
		const organizationSlug = `org-${randomBytes(6).toString("hex")}`;
		const created = await request(app).post("/api/civic/platform/organizations")
			.set("Authorization", `Bearer ${ownerToken}`)
			.send({ name: "Managed Organization", slug: organizationSlug, admin_email: "bottom@example.org" });
		expect(created.status).toBe(201);
		expect(created.body.organization).toMatchObject({
			name: "Managed Organization", slug: organizationSlug, admin_email: "bottom@example.org", domain: null
		});
		createdPlatformTenant = created.body.organization.id;

		const [membership] = await owner.query<{ role: string; email: string }>(
			"SELECT role, email FROM civic.members WHERE tenant_id = :tenant",
			{ replacements: { tenant: createdPlatformTenant }, type: QueryTypes.SELECT });
		expect(membership).toEqual({ role: "admin", email: "bottom@example.org" });

		const bottomToken = await login(organizationSlug, "bottom@example.org");
		expect((await api("get", "/staff/me", bottomToken)).body.portal.slug).toBe(organizationSlug);
		const addStaff = await api("post", "/staff/members", bottomToken)
			.send({ email: "worker@managed.example.org", display_name: "Managed Worker", role: "field" });
		expect(addStaff.status).toBe(201);
		expect(addStaff.body.role).toBe("field");
		const [worker] = await owner.query<{ tenant_id: string }>(
			"SELECT tenant_id FROM civic.members WHERE email = 'worker@managed.example.org'",
			{ type: QueryTypes.SELECT });
		expect(worker?.tenant_id).toBe(createdPlatformTenant);
		expect((await request(app).get("/api/civic/platform/organizations")
			.set("Authorization", `Bearer ${bottomToken}`)).status).toBe(401);
		expect((await request(app).post("/api/civic/platform/organizations")
			.set("Authorization", `Bearer ${tokenA}`)
			.send({ name: "Not allowed", slug: `other-${randomBytes(4).toString("hex")}`, admin_email: "staff@example.org" })).status).toBe(401);

		const unauthorizedAccess = `verified-${randomUUID()}`;
		identities.set(unauthorizedAccess, { id: randomUUID(), email: "not-owner@example.org" });
		expect((await request(app).post("/api/civic/platform/login").send({ access_token: unauthorizedAccess })).status).toBe(401);
	});

	it("allows only the platform owner to purge audit history when removing an archived organization", async () => {
		const id = createdPlatformTenant;
		if (!id) throw new Error("Managed organization fixture is missing");
		const [organization] = await database.rows<{ slug: string }>(
			"SELECT slug FROM civic.portals WHERE id = :id", { id });
		if (!organization) throw new Error("Managed organization fixture is missing");
		const submitted = await request(app).post(`/api/civic/public/${organization.slug}/requests`).send({
			category: "Pothole", description: "Road repair", location: "Managed town library", anonymous: true
		});
		expect(submitted.status).toBe(201);
		const historyBefore = await database.tenantTransaction(id, tx =>
			database.rows("SELECT id FROM civic.history", {}, tx));
		expect(historyBefore).toHaveLength(1);

		expect((await request(app).delete(`/api/civic/platform/organizations/${id}`)).status).toBe(401);
		expect((await request(app).delete(`/api/civic/platform/organizations/${id}`)
			.set("Authorization", `Bearer ${tokenA}`)).status).toBe(401);

		const accessToken = `verified-${randomUUID()}`;
		identities.set(accessToken, { id: randomUUID(), email: "owner@example.org" });
		const ownerLogin = await request(app).post("/api/civic/platform/login").send({ access_token: accessToken });
		expect(ownerLogin.status).toBe(200);
		const authorization = `Bearer ${ownerLogin.body.token}`;
		expect((await request(app).delete(`/api/civic/platform/organizations/${id}`)
			.set("Authorization", authorization)).status).toBe(409);
		const archived = await request(app).put(`/api/civic/platform/organizations/${id}/archive`)
			.set("Authorization", authorization).send({ archived: true });
		expect(archived.status).toBe(200);
		const removed = await request(app).delete(`/api/civic/platform/organizations/${id}`)
			.set("Authorization", authorization);
		expect(removed.status).toBe(200);
		expect(removed.body).toEqual({ removed: true });
		expect(await database.rows("SELECT id FROM civic.portals WHERE id = :id", { id })).toEqual([]);
		expect(await database.tenantTransaction(id, tx =>
			database.rows("SELECT id FROM civic.history", {}, tx))).toEqual([]);
		expect((await api("get", "/staff/me")).status).toBe(200);
		createdPlatformTenant = undefined;
	});

	it("does not expose legacy token, users, tenants or GraphQL endpoints", async () => {
		for (const path of ["/auth/token", "/users", "/tenants", "/graphql"]) {
			expect((await request(app).post(path).send({ userId: adminA })).status).toBe(404);
		}
		expect((await request(app).get("/health")).status).toBe(200);
	});
	it("returns JSON validation errors for malformed or oversized bodies", async () => {
		const invalid = await request(app).post("/api/civic/login").set("Content-Type", "application/json").send("{");
		expect(invalid.status).toBe(400);
		expect(invalid.body.message).toBe("Invalid JSON request body");
		const oversized = await request(app).post("/api/civic/login").send({ description: "x".repeat(3200000) });
		expect(oversized.status).toBe(413);
	});
	it("rejects unsigned sessions, legacy passwords and identities outside an organization", async () => {
		expect((await api("get", "/staff/me", jwt.sign({ sub: adminA }, process.env.JWT_SECRET!))).status).toBe(401);
		const refresh = jwt.sign({ tenant: tenantA, type: "refresh" }, process.env.JWT_SECRET!, {
			subject: adminA, issuer: "civicos", audience: "civicos-operations"
		});
		expect((await api("get", "/staff/me", refresh)).status).toBe(401);
		expect((await request(app).post("/api/civic/login").send({
			slug: slugA, email: "admin@example.org", password: "legacy-password"
		})).status).toBe(400);
		const unprovisioned = `verified-${randomUUID()}`;
		identities.set(unprovisioned, { id: randomUUID(), email: "uninvited@example.org" });
		expect((await request(app).post("/api/civic/login").send({ slug: slugA, access_token: unprovisioned })).status).toBe(401);
		const crossTenant = `verified-${randomUUID()}`;
		identities.set(crossTenant, { id: randomUUID(), email: "worker@example.org" });
		expect((await request(app).post("/api/civic/login").send({ slug: slugB, access_token: crossTenant })).status).toBe(401);
		expect((await request(app).get("/api/civic/staff/me")).status).toBe(401);
	});
	it("returns only safe account and organization configuration", async () => {
		const response = await api("get", "/staff/me");
		expect(response.status).toBe(200);
		expect(response.body.portal.id).toBe(tenantA);
		expect(response.body.user).not.toHaveProperty("password_hash");
		expect((await request(app).get(`/api/civic/public/${slugA}`)).status).toBe(200);
	});
	it("enforces tenant isolation even for unscoped SQL and forged tenant inserts", async () => {
		const members = await database.tenantTransaction(tenantA, tx =>
			database.rows<{ tenant_id: string }>("SELECT tenant_id FROM civic.members", {}, tx));
		expect(members.length).toBe(4);
		expect(members.every(member => member.tenant_id === tenantA)).toBe(true);
		expect(await database.rows("SELECT * FROM civic.members")).toEqual([]);
		await expect(database.tenantTransaction(tenantA, tx =>
			database.rows("INSERT INTO civic.config VALUES (:tenant, '{}'::jsonb) RETURNING tenant_id", { tenant: randomUUID() }, tx)
		)).rejects.toThrow();
	});
});
describe("CivicOS end-to-end workflow and private-safe tracking", () => {
	it("submits an anonymous report with a 128-bit tracking capability", async () => {
		const response = await request(app).post(`/api/civic/public/${slugA}/requests`).send({
			category: "Pothole", description: "Road damage outside the library", location: "Library entrance",
			longitude: -73.98, latitude: 40.75, anonymous: true, photos: [residentPhoto, residentPhoto, residentPhoto]
		});
		expect(response.status).toBe(201);
		reference = response.body.reference;
		expect(reference).toMatch(/^[A-F0-9]{4}(?:-[A-F0-9]{4}){7}$/);
		const list = await api("get", "/staff/requests");
		expect(list.status).toBe(200);
		requestId = list.body[0].id;
		expect(list.body[0].reference).toBe(reference);
	});
	it("rejects invalid category, coordinates, contact and image payloads", async () => {
		const base = { category: "Pothole", description: "Damage", location: "Library", anonymous: true };
		for (const extra of [
			{ category: "Nonexistent" }, { longitude: 181, latitude: 40 },
			{ anonymous: false }, { photo: "data:image/svg+xml;base64,PHN2Zz4=" },
			{ photos: [residentPhoto, residentPhoto, residentPhoto, residentPhoto] }
		]) {
			expect((await request(app).post(`/api/civic/public/${slugA}/requests`).send({ ...base, ...extra })).status).toBe(400);
		}
	});
	it("isolates list, direct access, assignment and tracking between organizations", async () => {
		expect((await api("get", "/staff/requests", tokenB)).body).toEqual([]);
		expect((await api("get", `/staff/requests/${requestId}`, tokenB)).status).toBe(404);
		expect((await api("post", `/staff/requests/${requestId}/assign`).send({ assigned_to: adminB })).status).toBe(400);
		expect((await request(app).post(`/api/civic/public/${slugB}/track`).send({ reference })).status).toBe(404);
		expect((await api("get", "/staff/requests", fieldToken)).body).toEqual([]);
		expect((await api("get", `/staff/requests/${requestId}`, fieldToken)).status).toBe(404);
	});
	it("rejects skipped workflow states and unauthorized field transitions", async () => {
		expect((await api("post", `/staff/requests/${requestId}/transition`).send({ status: "completed" })).status).toBe(409);
		expect((await api("post", `/staff/requests/${requestId}/transition`, fieldToken).send({ status: "reviewed" })).status).toBe(404);
	});
	it("reviews and assigns with immutable audit history", async () => {
		expect((await api("post", `/staff/requests/${requestId}/transition`).send({ status: "reviewed", notes: "Internal private note" })).status).toBe(200);
		expect((await api("post", `/staff/requests/${requestId}/transition`).send({ status: "assigned" })).status).toBe(409);
		expect((await api("post", `/staff/requests/${requestId}/assign`).send({ assigned_to: fieldA, notes: "Private dispatch" })).status).toBe(200);
		expect((await api("post", `/staff/requests/${requestId}/transition`).send({ status: "assigned" })).status).toBe(200);
		expect((await api("get", "/staff/requests", fieldToken)).body.length).toBe(1);
		const detail = await api("get", `/staff/requests/${requestId}`, fieldToken);
		expect(detail.status).toBe(200);
		expect(detail.body.history.length).toBe(4);
		expect(detail.body.history[1].actor).toBe(adminA);
		await expect(database.tenantTransaction(tenantA, tx =>
			database.rows("UPDATE civic.history SET notes = 'tampered' RETURNING id", {}, tx))).rejects.toThrow();
		expect(await database.tenantTransaction(tenantA, tx =>
			database.rows("DELETE FROM civic.history RETURNING id", {}, tx))).toEqual([]);
		expect(await database.tenantTransaction(tenantB, tx =>
			database.rows("DELETE FROM civic.history RETURNING id", {}, tx), undefined, true)).toEqual([]);
		const preserved = await api("get", `/staff/requests/${requestId}`, fieldToken);
		expect(preserved.body.history).toEqual(detail.body.history);
	});
	it("allows field start/completion and three field photos while exposing only resident photos", async () => {
		for (const status of ["in_progress", "completed"]) {
			expect((await api("post", `/staff/requests/${requestId}/transition`, fieldToken).send({ status, notes: "Work update" })).status).toBe(200);
			const publicDetail = await request(app).get(`/api/civic/public/${slugA}/requests/${requestId}`);
			expect(publicDetail.body.photos).toEqual([residentPhoto, residentPhoto, residentPhoto]);
		}
		expect((await api("post", `/staff/requests/${requestId}/transition`, fieldToken).send({ status: "verified" })).status).toBe(403);
		for (let index = 0; index < 3; index += 1) {
			expect((await api("post", `/staff/requests/${requestId}/field-photo`, fieldToken).send({ photo: fieldPhoto })).status).toBe(201);
		}
		const rejected = await api("post", `/staff/requests/${requestId}/field-photo`, fieldToken).send({ photo: fieldPhoto });
		expect(rejected.status).toBe(400);
		expect(rejected.body.message).toBe("A ticket can have no more than three field photos");
		const detail = await api("get", `/staff/requests/${requestId}`, fieldToken);
		expect(detail.body.photos).toHaveLength(3);
		expect(detail.body.field_photos).toHaveLength(3);
		const beforeVerification = await request(app).get(`/api/civic/public/${slugA}/requests/${requestId}`);
		expect(beforeVerification.body.photos).toEqual([residentPhoto, residentPhoto, residentPhoto]);
		expect((await api("post", `/staff/requests/${requestId}/transition`).send({ status: "verified" })).status).toBe(200);
		const verified = await request(app).get(`/api/civic/public/${slugA}/requests/${requestId}`);
		expect(verified.body.photos).toEqual([residentPhoto, residentPhoto, residentPhoto, fieldPhoto, fieldPhoto, fieldPhoto]);
	});
	it("tracks safely without names, notes, coordinates, contact, assignments or photos", async () => {
		const tracked = await request(app).post(`/api/civic/public/${slugA}/track`).send({ reference });
		expect(tracked.status).toBe(200);
		expect(tracked.body.status).toBe("Verified");
		expect(Object.keys(tracked.body).sort()).toEqual(["category", "history", "reference", "reported", "status", "title", "updated"]);
		for (const event of tracked.body.history) expect(Object.keys(event).sort()).toEqual(["status", "timestamp"]);
		expect(JSON.stringify(tracked.body)).not.toContain("Private");
		expect(tracked.headers["cache-control"]).toBe("no-store");
	});
	it("shows reviewed requests with safe map properties and requires approval for descriptions", async () => {
		const beforeApproval = await request(app).get(`/api/civic/public/${slugA}/map`);
		expect(beforeApproval.status).toBe(200);
		expect(beforeApproval.body.features).toHaveLength(1);
		expect(beforeApproval.body.features[0]).toMatchObject({
			id: requestId, properties: { kind: "request", location: null, status: "Verified" }
		});
		expect(Object.keys(beforeApproval.body.features[0].properties).sort()).toEqual(["id", "kind", "location", "status", "title"]);
		const privateDetail = await request(app).get(`/api/civic/public/${slugA}/requests/${requestId}`);
		expect(privateDetail.body.description).toBe("");
		expect((await api("get", "/staff/map")).body.features.length).toBe(1);
		expect((await api("get", "/staff/map", tokenB)).body.features).toEqual([]);
		expect((await api("post", `/staff/requests/${requestId}/visibility`).send({ published: true })).status).toBe(200);
		const map = await request(app).get(`/api/civic/public/${slugA}/map`);
		expect(map.status).toBe(200);
		expect(map.body.type).toBe("FeatureCollection");
		expect(Object.keys(map.body.features[0].properties).sort()).toEqual(["id", "kind", "location", "status", "title"]);
		expect(map.body.features[0].properties.location).toBeNull();
		const approvedDetail = await request(app).get(`/api/civic/public/${slugA}/requests/${requestId}`);
		expect(approvedDetail.body.description).not.toBe("");
	});
	it("keeps an archived ticket public while removing it from staff and field access", async () => {
		expect((await api("post", `/staff/requests/${requestId}/archive`)).status).toBe(200);
		expect((await api("get", "/staff/requests")).body).toEqual([]);
		expect((await api("get", "/staff/requests", fieldToken)).body).toEqual([]);
		expect((await api("get", `/staff/requests/${requestId}`)).status).toBe(404);
		expect((await api("post", `/staff/requests/${requestId}/restore`)).status).toBe(404);

		const calendar = await request(app).get(`/api/civic/public/${slugA}/requests/calendar`);
		expect(calendar.body.some((record: { id: string }) => record.id === requestId)).toBe(true);
		const detail = await request(app).get(`/api/civic/public/${slugA}/requests/${requestId}`);
		expect(detail.status).toBe(200);
		expect(detail.body.photos).toHaveLength(6);
		const map = await request(app).get(`/api/civic/public/${slugA}/map`);
		expect(map.body.features.some((feature: { id: string }) => feature.id === requestId)).toBe(true);
	});
});
describe("Offline field synchronization", () => {
	async function assignment() {
		const id = randomUUID();
		await owner.query(`INSERT INTO civic.records(id, tenant_id, kind, title, description, status, assigned_to)
			VALUES (:id, :tenant, 'request', 'Offline assignment', 'Repair', 'assigned', :worker)`,
			{ replacements: { id, tenant: tenantA, worker: fieldA } });
		const detail = await api("get", `/staff/requests/${id}`, fieldToken);
		expect(detail.status).toBe(200);
		return { id, version: detail.body.sync_version as string };
	}

	it("replays notes, photos, transitions and locations exactly once, including concurrent retries", async () => {
		const { id, version } = await assignment();
		const note = { client_operation_id: randomUUID(), expected_version: version, notes: "Offline repair note" };
		const first = await api("post", `/staff/requests/${id}/notes`, fieldToken).send(note);
		expect(first.status).toBe(201);
		const repeated = await api("post", `/staff/requests/${id}/notes`, fieldToken).send(note);
		expect(repeated.body).toEqual(first.body);
		expect((await api("post", `/staff/requests/${id}/notes`, fieldToken).send({ ...note, notes: "Different note" })).status).toBe(409);

		const photo = { client_operation_id: randomUUID(), expected_version: first.body.sync_version, photo: fieldPhoto };
		const uploads = await Promise.all([0, 1].map(() => api("post", `/staff/requests/${id}/field-photo`, fieldToken).send(photo)));
		expect(uploads.map(item => item.status)).toEqual([201, 201]);
		expect(uploads[0]?.body).toEqual(uploads[1]?.body);
		const transition = { client_operation_id: randomUUID(), expected_version: uploads[0]?.body.sync_version, status: "in_progress", notes: "Started offline" };
		const moved = await api("post", `/staff/requests/${id}/transition`, fieldToken).send(transition);
		expect(moved.status).toBe(200);
		expect((await api("post", `/staff/requests/${id}/transition`, fieldToken).send(transition)).body).toEqual(moved.body);
		const location = { client_operation_id: randomUUID(), expected_version: moved.body.sync_version, longitude: 0, latitude: 0 };
		const located = await api("post", `/staff/requests/${id}/location`, fieldToken).send(location);
		expect(located.status).toBe(200);
		expect((await api("post", `/staff/requests/${id}/location`, fieldToken).send(location)).body).toEqual(located.body);
		const detail = await api("get", `/staff/requests/${id}`, fieldToken);
		expect(detail.body).toMatchObject({ status: "in_progress", longitude: 0, latitude: 0, field_photos: [fieldPhoto] });
		expect(detail.body.history).toHaveLength(2);
		expect(detail.body.history.map((item: { notes: string }) => item.notes)).toEqual(["Offline repair note", "Started offline"]);
	});

	it("rejects stale updates, reassigned work, missing authentication and other tenants without changing data", async () => {
		const { id, version } = await assignment();
		const update = { client_operation_id: randomUUID(), expected_version: version, notes: "Pending offline" };
		expect((await api("post", `/staff/requests/${id}/notes`).send({ notes: "Dispatch changed this ticket" })).status).toBe(201);
		expect((await api("post", `/staff/requests/${id}/notes`, fieldToken).send(update)).status).toBe(409);
		expect((await request(app).post(`/api/civic/staff/requests/${id}/notes`).send(update)).status).toBe(401);
		expect((await api("post", `/staff/requests/${id}/notes`, tokenB).send(update)).status).toBe(404);
		expect((await api("post", `/staff/requests/${id}/assign`).send({ assigned_to: fieldAnotherA })).status).toBe(200);
		expect((await api("post", `/staff/requests/${id}/notes`, fieldToken).send(update)).status).toBe(404);
		const detail = await api("get", `/staff/requests/${id}`);
		expect(detail.body.history.map((item: { notes: string }) => item.notes)).not.toContain("Pending offline");
		expect(await database.tenantTransaction(tenantB, tx =>
			database.rows("SELECT id FROM civic.field_operations", {}, tx), adminB)).toEqual([]);
	});
});
describe("Organization administration and public content", () => {
	it("migrates organization chat permissions, provides a shared channel and enforces tenant isolation", async () => {
		const [config] = await owner.query<{ roles: Record<string, string[]> }>(
			"SELECT roles FROM civic.config WHERE tenant_id = :tenant",
			{ replacements: { tenant: tenantA }, type: QueryTypes.SELECT });
		if (!config) throw new Error("Chat migration removed organization configuration");
		expect(config.roles.admin).toContain("chat");
		expect(config.roles.staff).toContain("chat");
		expect(config.roles.field).toContain("chat");
		const existingChannels = await api("get", "/staff/chat/channels");
		expect(existingChannels.status).toBe(200);
		const general = existingChannels.body.find((item: { name: string }) => item.name === "general");
		expect(general).toBeTruthy();
		const created = await api("post", "/staff/chat/channels").send({ name: "street-maintenance", description: "Team dispatch" });
		expect(created.status).toBe(201);
		const channel = created.body;
		const sent = await api("post", `/staff/chat/channels/${channel.id}/messages`).send({ body: "Road crew starts at 8 AM." });
		expect(sent.status).toBe(201);
		expect(sent.body.sender_email).toBe("admin@example.org");
		expect(sent.body.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
		expect((await api("get", `/staff/chat/channels/${channel.id}/messages?after=${encodeURIComponent(sent.body.created_at)}&after_id=${sent.body.id}`)).body).toEqual([]);
		const reply = await api("post", `/staff/chat/channels/${channel.id}/messages`, fieldToken).send({ body: "Acknowledged." });
		expect(reply.status).toBe(201);
		const polled = await api("get", `/staff/chat/channels/${channel.id}/messages?after=${encodeURIComponent(sent.body.created_at)}&after_id=${sent.body.id}`, fieldToken);
		expect(polled.status).toBe(200);
		expect(polled.body.map((message: { body: string }) => message.body)).toEqual(["Acknowledged."]);
		const messages = await api("get", `/staff/chat/channels/${channel.id}/messages`, fieldToken);
		expect(messages.status).toBe(200);
		expect(messages.body.map((message: { body: string }) => message.body)).toEqual(["Road crew starts at 8 AM.", "Acknowledged."]);
		expect(messages.body[1].sender_email).toBe("worker@example.org");
		expect((await api("get", `/staff/chat/channels/${channel.id}/messages`, tokenB)).status).toBe(404);
		expect((await api("get", "/staff/chat/channels", readOnlyToken)).status).toBe(403);
		expect((await api("post", `/staff/chat/channels/${channel.id}/messages`, readOnlyToken).send({ body: "Unauthorized" })).status).toBe(403);
		expect((await api("post", `/staff/chat/channels/${channel.id}/messages`).send({ body: "  " })).status).toBe(400);
		expect((await api("post", "/staff/chat/channels").send({ name: "Invalid Channel Name" })).status).toBe(400);
	});
	it("keeps direct messages visible only to the two authorized organization members", async () => {
		const contacts = await api("get", "/staff/chat/contacts");
		expect(contacts.body.map((member: { email: string }) => member.email)).toContain("worker@example.org");
		expect(contacts.body.map((member: { email: string }) => member.email)).not.toContain("admin@example.org");
		const direct = await api("post", "/staff/chat/direct").send({ member_id: fieldA });
		expect(direct.status).toBe(201);
		const sent = await api("post", `/staff/chat/direct/${direct.body.id}/messages`).send({ body: "Private dispatch details." });
		expect(sent.status).toBe(201);
		expect((await api("get", `/staff/chat/direct/${direct.body.id}/messages`, fieldToken)).body[0].body).toBe("Private dispatch details.");
		expect((await api("get", `/staff/chat/direct/${direct.body.id}/messages`, fieldAnotherToken)).status).toBe(404);
		expect((await api("get", `/staff/chat/direct/${direct.body.id}/messages`, tokenB)).status).toBe(404);
		expect((await api("post", "/staff/chat/direct").send({ member_id: adminB })).status).toBe(404);
		expect((await api("post", "/staff/chat/direct").send({ member_id: adminA })).status).toBe(400);
		expect((await api("get", "/staff/chat/direct", fieldToken)).body[0].member_email).toBe("admin@example.org");
		const privateRows = await database.tenantTransaction(tenantA, tx =>
			database.rows("SELECT id FROM civic.chat_direct_threads", {}, tx), fieldAnotherA);
		expect(privateRows).toEqual([]);
	});
	it("publishes content, facilities and infrastructure and supports withdrawal", async () => {
		const added = await api("post", "/staff/content").send({
			kind: "facility", title: "Community library", description: "Open weekdays", location: "Main Street",
			longitude: -73.99, latitude: 40.76, published: true, url: "https://example.org/library"
		});
		expect(added.status).toBe(201);
		expect((await request(app).get(`/api/civic/public/${slugA}/content`)).body.length).toBe(1);
		expect((await api("get", "/staff/content")).status).toBe(200);
		const edited = await api("put", `/staff/content/${added.body.id}`).send({
			title: "Updated library hours", description: "Now open Saturdays", location: "Main Street",
			longitude: -73.99, latitude: 40.76, published: true, url: "https://example.org/library"
		});
		expect(edited.status).toBe(200);
		expect((await request(app).get(`/api/civic/public/${slugA}/content`)).body[0].title).toBe("Updated library hours");
		expect((await api("put", `/staff/content/${added.body.id}`, tokenB).send({ published: false })).status).toBe(404);
		expect((await api("put", `/staff/content/${added.body.id}`).send({ published: false })).status).toBe(200);
		expect((await request(app).get(`/api/civic/public/${slugA}/content`)).body).toEqual([]);
		expect((await api("post", "/staff/content", fieldToken).send({})).status).toBe(403);
	});
	it("supports custom roles and member provisioning without accepting tenant IDs", async () => {
		const roles = { ...defaultRoles, observer: ["read"] };
		expect((await api("get", "/staff/roles")).status).toBe(200);
		expect((await api("put", "/staff/roles").send({ roles })).status).toBe(200);
		const member = await api("post", "/staff/members").send({
			email: "observer@example.org", display_name: "Town Observer", role: "observer", tenant_id: tenantB
		});
		expect(member.status).toBe(201);
		expect((await api("get", "/staff/members", tokenB)).body.some((item: { id: string }) => item.id === member.body.id)).toBe(false);
		expect((await api("put", `/staff/members/${member.body.id}`).send({ display_name: "Town Observer", active: false, role: "observer" })).status).toBe(200);
		expect((await api("put", "/staff/roles", fieldToken).send({ roles })).status).toBe(403);
	});
	it("updates branding, localization, categories and workflow while preserving used states", async () => {
		const settings = { ...defaultSettings, anonymous: false, language: "it", timezone: "Europe/Rome" };
		expect((await api("put", "/staff/settings").send({ name: "Town A", settings })).status).toBe(200);
		expect((await request(app).get(`/api/civic/public/${slugA}`)).body.settings.language).toBe("it");
		expect((await request(app).post(`/api/civic/public/${slugA}/requests`).send({
			category: "Pothole", description: "Damage", location: "Street", anonymous: true
		})).status).toBe(400);
		const removed = { ...settings, states: settings.states.filter(state => state.key !== "verified") };
		expect((await api("put", "/staff/settings").send({ name: "Town A", settings: removed })).status).toBe(400);
		const removedHistory = {
			...settings,
			states: settings.states.filter(state => state.key !== "reviewed").map(state =>
				state.key === "submitted" ? { ...state, next: ["assigned"] } : state)
		};
		expect((await api("put", "/staff/settings").send({ name: "Town A", settings: removedHistory })).status).toBe(409);
		expect(() => validateSettings({ ...settings, timezone: "not-a-timezone" })).toThrow();
		expect(() => coordinates(NaN, 0)).toThrow();
	});
	it("executes a custom workflow through the same field permission checks", async () => {
		const settings = {
			...defaultSettings,
			states: [
				{ key: "submitted", label: "Submitted", next: ["dispatched"], field: false },
				{ key: "dispatched", label: "Dispatched", next: ["repairing"], field: false },
				{ key: "repairing", label: "Repairing", next: ["done"], field: true },
				{ key: "done", label: "Done", next: [], field: true }
			]
		};
		expect((await api("put", "/staff/settings", tokenB).send({ name: "Town B", settings })).status).toBe(200);
		const worker = await api("post", "/staff/members", tokenB).send({ email: "crew@example.org", display_name: "Repair Crew", role: "field" });
		expect(worker.status).toBe(201);
		expect((await request(app).post(`/api/civic/public/${slugB}/requests`).send({
			category: "Pothole", description: "Road repair", location: "Town B library", anonymous: true
		})).status).toBe(201);
		const record = (await api("get", "/staff/requests", tokenB)).body[0];
		const crewToken = await login(slugB, "crew@example.org");
		expect((await api("post", `/staff/requests/${record.id}/assign`, tokenB).send({ assigned_to: worker.body.id })).status).toBe(200);
		expect((await api("post", `/staff/requests/${record.id}/transition`, crewToken).send({ status: "dispatched" })).status).toBe(403);
		expect((await api("post", `/staff/requests/${record.id}/transition`, tokenB).send({ status: "dispatched" })).status).toBe(200);
		for (const status of ["repairing", "done"]) {
			expect((await api("post", `/staff/requests/${record.id}/transition`, crewToken).send({ status })).status).toBe(200);
		}
		expect((await api("put", `/staff/members/${worker.body.id}`, tokenB).send({ display_name: "Repair Crew", role: "field", active: false })).status).toBe(200);
		expect((await api("get", "/staff/me", crewToken)).status).toBe(401);
	});
	it("supports reasonable custom field workflow states without hard-coded state names", () => {
		const custom = {
			...defaultSettings,
			states: [
				{ key: "submitted", label: "Reported", next: ["dispatched"], field: false },
				{ key: "dispatched", label: "Dispatched", next: ["repairing"], field: false },
				{ key: "repairing", label: "Repairing", next: ["done"], field: true },
				{ key: "done", label: "Finished", next: [], field: true }
			]
		};
		expect(validateSettings(custom).states.length).toBe(4);
		expect(fieldCanEnter(custom.states[2]!)).toBe(true);
		expect(fieldCanEnter(custom.states[1]!)).toBe(false);
		expect(fieldCanEnter({ key: "in_progress", label: "Working", next: [] })).toBe(true);
		expect(() => validateSettings({ ...custom, states: [...custom.states, { key: "orphan", label: "Unreachable", next: [] }] })).toThrow(/reachable/);
		expect(() => validateSettings({ ...custom, states: custom.states.map(state => ({ ...state, next: state.key === "done" ? ["repairing"] : state.next })) })).toThrow(/terminal/);
	});
});
