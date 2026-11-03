import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { Sequelize } from "sequelize";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultRoles, defaultSettings } from "../civic/domain";
import app from "../index";
import * as database from "../civic/database";

// End-to-end coverage for public information pinned on the community map:
// HTTP request -> Express router -> row-level-secured Postgres -> public portal and map responses.
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
	delete process.env.ENABLE_LEGACY_DEMO;
});

const owner = new Sequelize("civicos_test", "postgres", process.env.CIVIC_TEST_PASSWORD || "civicos-test-local-only", {
	host: "127.0.0.1", port: Number(process.env.CIVIC_DB_PORT), dialect: "postgres", logging: false
});
const town = { id: randomUUID(), slug: `map-town-${randomBytes(5).toString("hex")}` };
const neighbour = { id: randomUUID(), slug: `map-other-${randomBytes(5).toString("hex")}` };
let adminToken: string;
let fieldToken: string;
let neighbourToken: string;

type Feature = { id: string; geometry: { type: string; coordinates: [number, number] }; properties: { kind: string; title: string; location: string | null } };

async function login(slug: string, email: string): Promise<string> {
	const accessToken = `verified-${randomUUID()}`;
	identities.set(accessToken, { id: randomUUID(), email });
	const response = await request(app).post("/api/civic/login").send({ slug, access_token: accessToken });
	expect(response.status).toBe(200);
	return response.body.token as string;
}
const staff = (method: "get" | "post" | "put", path: string, token = adminToken) =>
	request(app)[method](`/api/civic${path}`).set("Authorization", `Bearer ${token}`);
const publicContent = async (slug = town.slug) => (await request(app).get(`/api/civic/public/${slug}/content`)).body as Array<Record<string, unknown>>;
const publicMap = async (slug = town.slug) => {
	const response = await request(app).get(`/api/civic/public/${slug}/map`);
	expect(response.status).toBe(200);
	expect(response.body.type).toBe("FeatureCollection");
	return response.body.features as Feature[];
};
const information = (overrides: Record<string, unknown> = {}) => ({
	kind: "facility", title: "Riverside library", description: "Free Wi-Fi and study rooms",
	location: "12 River Road", longitude: -73.985123, latitude: 40.758456, published: true, url: null, ...overrides
});

beforeAll(async () => {
	await owner.authenticate();
	await owner.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'civic_app') THEN
		CREATE ROLE civic_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF; END $$`);
	await owner.query("ALTER ROLE civic_app PASSWORD :password", { replacements: { password: process.env.CIVIC_DB_PASSWORD } });
	await owner.query(readFileSync(join(process.cwd(), "civic", "schema.sql"), "utf8"));
	for (const tenant of [town, neighbour]) {
		await owner.query(`INSERT INTO civic.portals VALUES (:id, :slug, NULL, :slug, CAST(:settings AS jsonb));
			INSERT INTO civic.config VALUES (:id, CAST(:roles AS jsonb));
			INSERT INTO civic.members(id, tenant_id, email, role) VALUES (:admin, :id, 'admin@example.org', 'admin')`, {
			replacements: { ...tenant, admin: randomUUID(), settings: JSON.stringify(defaultSettings), roles: JSON.stringify(defaultRoles) }
		});
	}
	await owner.query("INSERT INTO civic.members(id, tenant_id, email, role) VALUES (:id, :tenant, 'crew@example.org', 'field')", {
		replacements: { id: randomUUID(), tenant: town.id }
	});
	await database.verifyCivicDatabase();
	adminToken = await login(town.slug, "admin@example.org");
	fieldToken = await login(town.slug, "crew@example.org");
	neighbourToken = await login(neighbour.slug, "admin@example.org");
}, 30000);

afterAll(async () => {
	await database?.civicDatabase.close();
	for (const table of ["history", "records", "chat_messages", "chat_direct_threads", "chat_channels", "members", "config"]) {
		await owner.query(`DELETE FROM civic.${table} WHERE tenant_id IN (:a, :b)`, { replacements: { a: town.id, b: neighbour.id } });
	}
	await owner.query("DELETE FROM civic.portals WHERE id IN (:a, :b)", { replacements: { a: town.id, b: neighbour.id } });
	await owner.close();
});

describe("public information pinned on the community map (e2e)", () => {
	let libraryId: string;

	it("publishes staff information with coordinates to the public portal and public map", async () => {
		const created = await staff("post", "/staff/content").send(information());
		expect(created.status).toBe(201);
		expect(created.body).toMatchObject({ title: "Riverside library", longitude: -73.985123, latitude: 40.758456, published: true });
		libraryId = created.body.id;

		const [item] = await publicContent();
		expect(item).toMatchObject({ id: libraryId, kind: "facility", longitude: -73.985123, latitude: 40.758456, location: "12 River Road" });
		expect(item).not.toHaveProperty("published");

		const features = await publicMap();
		expect(features).toHaveLength(1);
		expect(features[0]).toMatchObject({
			id: libraryId,
			geometry: { type: "Point", coordinates: [-73.985123, 40.758456] },
			properties: { kind: "facility", title: "Riverside library", location: "12 River Road" }
		});
	});

	it("keeps drafts off the public map while showing them on the staff map", async () => {
		const draft = await staff("post", "/staff/content").send(information({ kind: "project", title: "Draft bike lane", longitude: -73.97, latitude: 40.75, published: false }));
		expect(draft.status).toBe(201);
		expect((await publicMap()).map(feature => feature.id)).toEqual([libraryId]);
		expect((await publicContent()).map(item => item.id)).toEqual([libraryId]);

		const staffMap = await staff("get", "/staff/map");
		expect(staffMap.status).toBe(200);
		expect((staffMap.body.features as Feature[]).map(feature => feature.id).sort()).toEqual([libraryId, draft.body.id].sort());

		const fieldMap = await staff("get", "/staff/map", fieldToken);
		expect((fieldMap.body.features as Feature[]).map(feature => feature.id)).toEqual([libraryId]);
	});

	it("moves the public map pin when staff edit the coordinates", async () => {
		const moved = await staff("put", `/staff/content/${libraryId}`).send(information({ longitude: 2.352222, latitude: 48.856613 }));
		expect(moved.status).toBe(200);
		expect(moved.body).toMatchObject({ longitude: 2.352222, latitude: 48.856613 });
		expect((await publicMap())[0]?.geometry.coordinates).toEqual([2.352222, 48.856613]);
		expect((await publicContent())[0]).toMatchObject({ longitude: 2.352222, latitude: 48.856613 });
	});

	it("rejects incomplete, out-of-range and non-numeric coordinates without saving anything", async () => {
		const before = (await staff("get", "/staff/content")).body.length;
		for (const coordinates of [
			{ longitude: -73.98, latitude: null },
			{ longitude: null, latitude: 40.75 },
			{ longitude: 181, latitude: 40.75 },
			{ longitude: -73.98, latitude: -90.5 },
			{ longitude: "-73.98", latitude: "40.75" }
		]) {
			const created = await staff("post", "/staff/content").send(information({ title: "Invalid pin", ...coordinates }));
			expect(created.status, JSON.stringify(coordinates)).toBe(400);
			expect(created.body.message).toBe("Invalid map coordinates");
			const edited = await staff("put", `/staff/content/${libraryId}`).send(information(coordinates));
			expect(edited.status, JSON.stringify(coordinates)).toBe(400);
		}
		expect((await staff("get", "/staff/content")).body).toHaveLength(before);
		expect((await publicMap())[0]?.geometry.coordinates).toEqual([2.352222, 48.856613]);
	});

	it("accepts the coordinate boundaries", async () => {
		const corner = await staff("post", "/staff/content").send(information({ title: "Date line marker", longitude: 180, latitude: -90 }));
		expect(corner.status).toBe(201);
		expect((await publicMap()).find(feature => feature.id === corner.body.id)?.geometry.coordinates).toEqual([180, -90]);
		expect((await staff("put", `/staff/content/${corner.body.id}`).send({ published: false })).status).toBe(200);
	});

	it("removes the pin but keeps the public information when coordinates are cleared", async () => {
		const cleared = await staff("put", `/staff/content/${libraryId}`).send(information({ longitude: null, latitude: null }));
		expect(cleared.status).toBe(200);
		expect(cleared.body).toMatchObject({ longitude: null, latitude: null });
		expect(await publicMap()).toEqual([]);
		expect((await publicContent())[0]).toMatchObject({ id: libraryId, longitude: null, latitude: null });

		expect((await staff("put", `/staff/content/${libraryId}`).send(information({ longitude: -73.985123, latitude: 40.758456 }))).status).toBe(200);
		expect((await publicMap()).map(feature => feature.id)).toEqual([libraryId]);
	});

	it("removes the pin when information is withdrawn and restores it when republished", async () => {
		expect((await staff("put", `/staff/content/${libraryId}`).send({ published: false })).status).toBe(200);
		expect(await publicMap()).toEqual([]);
		expect(await publicContent()).toEqual([]);
		expect((await staff("put", `/staff/content/${libraryId}`).send({ published: true })).status).toBe(200);
		expect((await publicMap())[0]?.geometry.coordinates).toEqual([-73.985123, 40.758456]);
	});

	it("isolates map pins between organizations", async () => {
		expect(await publicMap(neighbour.slug)).toEqual([]);
		expect(await publicContent(neighbour.slug)).toEqual([]);
		expect((await staff("get", "/staff/map", neighbourToken)).body.features).toEqual([]);
		expect((await staff("put", `/staff/content/${libraryId}`, neighbourToken).send(information({ longitude: 0, latitude: 0 }))).status).toBe(404);
		expect((await publicMap())[0]?.geometry.coordinates).toEqual([-73.985123, 40.758456]);
	});

	it("does not let field workers without the publish permission pin information", async () => {
		expect((await staff("post", "/staff/content", fieldToken).send(information({ title: "Unauthorized pin" }))).status).toBe(403);
		expect((await publicMap()).map(feature => feature.properties.title)).not.toContain("Unauthorized pin");
	});
});

describe("public information on the calendar and archiving (e2e)", () => {
	it("stores, edits, validates and clears the optional calendar date", async () => {
		const created = await staff("post", "/staff/content").send(information({ kind: "announcement", title: "Park cleanup", calendar_date: "2031-05-17" }));
		expect(created.status).toBe(201);
		expect(created.body.calendar_date).toBe("2031-05-17");
		expect((await publicContent()).find(item => item.id === created.body.id)).toMatchObject({ calendar_date: "2031-05-17" });

		for (const bad of ["2031-02-30", "17/05/2031", "1800-01-01", 20310517]) {
			expect((await staff("put", `/staff/content/${created.body.id}`).send(information({ title: "Park cleanup", calendar_date: bad }))).status).toBe(400);
		}
		expect((await staff("post", "/staff/content").send(information({ title: "Bad date", calendar_date: "2031-13-01" }))).status).toBe(400);

		const moved = await staff("put", `/staff/content/${created.body.id}`).send(information({ title: "Park cleanup", calendar_date: "2031-05-18" }));
		expect(moved.body.calendar_date).toBe("2031-05-18");
		const cleared = await staff("put", `/staff/content/${created.body.id}`).send(information({ title: "Park cleanup", calendar_date: "" }));
		expect(cleared.body.calendar_date).toBeNull();
		const undated = await staff("post", "/staff/content").send(information({ title: "Undated" }));
		expect(undated.body.calendar_date).toBeNull();
	});

	it("archives information out of staff and field views while keeping it public", async () => {
		const created = await staff("post", "/staff/content").send(information({ kind: "event", title: "Archived festival", calendar_date: "2031-06-01" }));
		const id = created.body.id as string;
		expect((await staff("post", `/staff/content/${id}/archive`, fieldToken)).status).toBe(403);
		expect((await staff("post", `/staff/content/${id}/archive`, neighbourToken)).status).toBe(404);

		const archived = await staff("post", `/staff/content/${id}/archive`);
		expect(archived.status).toBe(200);
		expect(archived.body).toEqual({ archived: true });

		expect(((await staff("get", "/staff/content")).body as Array<{ id: string }>).map(item => item.id)).not.toContain(id);
		expect(((await staff("get", "/staff/map")).body.features as Feature[]).map(feature => feature.id)).not.toContain(id);
		expect(((await staff("get", "/staff/map", fieldToken)).body.features as Feature[]).map(feature => feature.id)).not.toContain(id);
		expect((await publicContent()).find(item => item.id === id)).toMatchObject({ title: "Archived festival", calendar_date: "2031-06-01" });
		expect((await publicMap()).map(feature => feature.id)).toContain(id);

		expect((await staff("put", `/staff/content/${id}`).send({ published: false })).status).toBe(404);
		expect((await staff("post", `/staff/content/${id}/archive`)).status).toBe(404);
	});
});
