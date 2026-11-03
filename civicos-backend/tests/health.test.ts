import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../index";
import { civicDatabase, verifyCivicDatabase } from "../civic/database";

vi.mock("../civic/database", () => ({
	civicDatabase: { query: vi.fn(), close: vi.fn() },
	verifyCivicDatabase: vi.fn(),
	rows: vi.fn(),
	tenantTransaction: vi.fn()
}));

beforeEach(() => {
	vi.mocked(verifyCivicDatabase).mockReset();
	vi.mocked(civicDatabase.query).mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe("CivicOS readiness endpoint", () => {
	it("returns uncached readiness without requiring authentication", async () => {
		vi.mocked(verifyCivicDatabase).mockResolvedValue();

		const response = await request(app).get("/readyz");

		expect(response.status).toBe(200);
		expect(response.body).toEqual({ service: "CivicOS", status: "ready" });
		expect(response.headers["cache-control"]).toBe("no-store");
		expect(verifyCivicDatabase).toHaveBeenCalledOnce();
	});

	it("rechecks every request and recovers after a database failure", async () => {
		const failure = new Error("Private database connection details");
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.mocked(verifyCivicDatabase)
			.mockResolvedValueOnce()
			.mockRejectedValueOnce(failure)
			.mockResolvedValueOnce();

		expect((await request(app).get("/readyz")).status).toBe(200);
		const unavailable = await request(app).get("/readyz");
		expect(unavailable.status).toBe(503);
		expect(unavailable.body).toEqual({ service: "CivicOS", status: "not_ready" });
		expect(unavailable.headers["cache-control"]).toBe("no-store");
		expect(unavailable.text).not.toContain(failure.message);
		expect(log).toHaveBeenCalledWith("CivicOS readiness check failed", failure);
		expect((await request(app).get("/readyz")).status).toBe(200);
		expect(verifyCivicDatabase).toHaveBeenCalledTimes(3);
	});

	it("preserves the existing database-backed health endpoint", async () => {
		vi.mocked(verifyCivicDatabase).mockResolvedValue();

		const response = await request(app).get("/health");

		expect(response.status).toBe(200);
		expect(response.body).toEqual({ service: "CivicOS", status: "ok" });
		expect(civicDatabase.query).toHaveBeenCalledWith("SELECT 1");
	});

	it("allows body-less actions such as archive to reach their route", async () => {
		vi.mocked(verifyCivicDatabase).mockResolvedValue();

		const response = await request(app).post("/api/civic/not-a-route");

		expect(response.status).toBe(404);
		expect(response.body).toEqual({ message: "Endpoint not found" });
	});

	it("rejects a non-JSON request body before routing", async () => {
		vi.mocked(verifyCivicDatabase).mockResolvedValue();

		const response = await request(app).post("/api/civic/not-a-route")
			.set("Content-Type", "text/plain").send("not json");

		expect(response.status).toBe(400);
		expect(response.body).toEqual({ message: "A JSON object request body is required" });
	});
});
