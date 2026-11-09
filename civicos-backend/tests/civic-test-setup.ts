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

const mockState = vi.hoisted(() => ({
	identities: new Map<string, { id: string; email: string }>()
}));
export const identities = mockState.identities;
vi.mock("../civic/supabase-auth", () => ({
	getSupabaseUser: async (accessToken: string) => mockState.identities.get(accessToken) || null
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
export const owner = new Sequelize("civicos_test", "postgres", process.env.CIVIC_TEST_PASSWORD || "civicos-test-local-only", {
	host: "127.0.0.1", port: Number(process.env.CIVIC_DB_PORT), dialect: "postgres", logging: false
});
export const tenantA = randomUUID();
export const tenantB = randomUUID();
export const adminA = randomUUID();
export const adminB = randomUUID();
export const fieldA = randomUUID();
export const fieldAnotherA = randomUUID();
export const readOnlyA = randomUUID();
export const slugA = `town-${randomBytes(5).toString("hex")}`;
export const slugB = `town-${randomBytes(5).toString("hex")}`;
export let tokenA: string;
export let tokenB: string;
export let fieldToken: string;
export let fieldAnotherToken: string;
export let readOnlyToken: string;
export const testState: { createdPlatformTenant: string | undefined } = { createdPlatformTenant: undefined };
export const residentPhoto = "data:image/png;base64,iVBORw0KGgo=";
export const fieldPhoto = "data:image/jpeg;base64,/9j/";

export async function login(slug: string, email: string): Promise<string> {
	const accessToken = `verified-${randomUUID()}`;
	identities.set(accessToken, { id: randomUUID(), email });
	const response = await request(app).post("/api/civic/login").send({ slug, access_token: accessToken });
	expect(response.status).toBe(200);
	return response.body.token as string;
}

export function registerCivicTestSuite() {
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
	if (testState.createdPlatformTenant) {
		await owner.query("DELETE FROM civic.chat_messages WHERE tenant_id = :tenant", { replacements: { tenant: testState.createdPlatformTenant } });
		await owner.query("DELETE FROM civic.chat_channels WHERE tenant_id = :tenant", { replacements: { tenant: testState.createdPlatformTenant } });
		await owner.query("DELETE FROM civic.history WHERE tenant_id = :tenant", { replacements: { tenant: testState.createdPlatformTenant } });
		await owner.query("DELETE FROM civic.records WHERE tenant_id = :tenant", { replacements: { tenant: testState.createdPlatformTenant } });
		await owner.query("DELETE FROM civic.members WHERE tenant_id = :tenant", { replacements: { tenant: testState.createdPlatformTenant } });
		await owner.query("DELETE FROM civic.config WHERE tenant_id = :tenant", { replacements: { tenant: testState.createdPlatformTenant } });
		await owner.query("DELETE FROM civic.portals WHERE id = :tenant", { replacements: { tenant: testState.createdPlatformTenant } });
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
}
export const api = (method: "get" | "post" | "put", path: string, token = tokenA) =>
	request(app)[method](`/api/civic${path}`).set("Authorization", `Bearer ${token}`);


export { randomBytes, randomUUID, request, jwt, QueryTypes, coordinates, defaultRoles, defaultSettings, validateSettings, fieldCanEnter, app, database };
