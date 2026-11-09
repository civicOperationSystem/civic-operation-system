import { describe, expect, it } from "vitest";
import {
  identities, owner, tenantA, tenantB, adminA, adminB, fieldA, fieldAnotherA, readOnlyA,
  slugA, slugB, tokenA, tokenB, fieldToken, fieldAnotherToken, readOnlyToken, testState,
  login, api, randomBytes, randomUUID, request, jwt, QueryTypes, database, app,
  defaultRoles, defaultSettings, validateSettings, fieldCanEnter, coordinates, residentPhoto, fieldPhoto,
  registerCivicTestSuite,
} from "./civic-test-setup";
registerCivicTestSuite();

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
