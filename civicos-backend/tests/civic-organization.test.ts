import { describe, expect, it } from "vitest";
import {
  identities, owner, tenantA, tenantB, adminA, adminB, fieldA, fieldAnotherA, readOnlyA,
  slugA, slugB, tokenA, tokenB, fieldToken, fieldAnotherToken, readOnlyToken, testState,
  login, api, randomBytes, randomUUID, request, jwt, QueryTypes, database, app,
  defaultRoles, defaultSettings, validateSettings, fieldCanEnter, coordinates, residentPhoto, fieldPhoto,
  registerCivicTestSuite,
} from "./civic-test-setup";
registerCivicTestSuite();

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
		const settings = { ...defaultSettings, anonymous: false, language: "it", timezone: "Europe/Rome", center: [12.49, 41.89], zoom: 13.5 };
		expect((await api("put", "/staff/settings", fieldToken).send({ name: "Town A", settings })).status).toBe(403);
		expect((await api("put", "/staff/settings", readOnlyToken).send({ name: "Town A", settings })).status).toBe(403);
		expect((await api("put", "/staff/settings").send({ name: "Town A", settings })).status).toBe(200);
		expect((await request(app).get(`/api/civic/public/${slugA}`)).body.settings).toMatchObject({
			language: "it", center: [12.49, 41.89], zoom: 13.5
		});
		expect((await api("get", "/staff/me", tokenB)).body.portal.settings.center).toEqual(defaultSettings.center);
		for (const zoom of [0, 20, "12", null]) {
			expect((await api("put", "/staff/settings").send({ name: "Town A", settings: { ...settings, zoom } })).status).toBe(400);
		}
		expect(validateSettings({ ...settings, zoom: undefined }).zoom).toBe(12);
		expect(() => validateSettings({ ...settings, zoom: NaN })).toThrow();
		expect(() => validateSettings({ ...settings, center: [181, 0] })).toThrow();
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
