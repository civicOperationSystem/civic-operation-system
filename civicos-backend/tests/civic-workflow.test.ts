import { describe, expect, it } from "vitest";
import {
  identities, owner, tenantA, tenantB, adminA, adminB, fieldA, fieldAnotherA, readOnlyA,
  slugA, slugB, tokenA, tokenB, fieldToken, fieldAnotherToken, readOnlyToken, testState,
  login, api, randomBytes, randomUUID, request, jwt, QueryTypes, database, app,
  defaultRoles, defaultSettings, validateSettings, fieldCanEnter, coordinates, residentPhoto, fieldPhoto,
  registerCivicTestSuite,
} from "./civic-test-setup";
registerCivicTestSuite();

let reference: string;
let requestId: string;

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
	it("retries offline public reports idempotently", async () => {
		const clientOperationId = randomUUID();
		const report = {
			client_operation_id: clientOperationId, category: "Pothole", description: "Offline report",
			location: "Community park", anonymous: true, photos: []
		};
		try {
			const first = await request(app).post(`/api/civic/public/${slugA}/requests`).send(report);
			const retry = await request(app).post(`/api/civic/public/${slugA}/requests`).send(report);
			expect(first.status).toBe(201);
			expect(retry.status).toBe(201);
			expect(retry.body.reference).toBe(first.body.reference);
			const conflictingRetry = await request(app).post(`/api/civic/public/${slugA}/requests`)
				.send({ ...report, description: "Different report" });
			expect(conflictingRetry.status).toBe(409);
			const history = await database.tenantTransaction(tenantA, tx =>
				database.rows<{ count: number }>("SELECT count(*)::int AS count FROM civic.history WHERE request_id = :id", { id: clientOperationId }, tx));
			expect(history[0]?.count).toBe(1);
		} finally {
			await owner.transaction(async transaction => {
				const replacements = { tenant: tenantA, id: clientOperationId };
				await owner.query("DELETE FROM civic.history WHERE tenant_id = :tenant AND request_id = :id", { replacements, transaction });
				await owner.query("DELETE FROM civic.records WHERE tenant_id = :tenant AND id = :id", { replacements, transaction });
			});
		}
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
