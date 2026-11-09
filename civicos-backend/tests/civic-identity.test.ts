import { describe, expect, it } from "vitest";
import {
  identities, owner, tenantA, tenantB, adminA, adminB, fieldA, fieldAnotherA, readOnlyA,
  slugA, slugB, tokenA, tokenB, fieldToken, fieldAnotherToken, readOnlyToken, testState,
  login, api, randomBytes, randomUUID, request, jwt, QueryTypes, database, app,
  defaultRoles, defaultSettings, validateSettings, fieldCanEnter, coordinates, residentPhoto, fieldPhoto,
  registerCivicTestSuite,
} from "./civic-test-setup";
registerCivicTestSuite();

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
		testState.createdPlatformTenant = created.body.organization.id;

		const [membership] = await owner.query<{ role: string; email: string }>(
			"SELECT role, email FROM civic.members WHERE tenant_id = :tenant",
			{ replacements: { tenant: testState.createdPlatformTenant }, type: QueryTypes.SELECT });
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
		expect(worker?.tenant_id).toBe(testState.createdPlatformTenant);
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
		const id = testState.createdPlatformTenant;
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
		testState.createdPlatformTenant = undefined;
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
