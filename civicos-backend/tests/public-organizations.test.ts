import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../index";
import { rows, verifyCivicDatabase } from "../civic/database";

vi.mock("../civic/database", () => ({
	civicDatabase: { query: vi.fn(), close: vi.fn() },
	verifyCivicDatabase: vi.fn(),
	rows: vi.fn(),
	tenantTransaction: vi.fn()
}));

beforeEach(() => {
	vi.mocked(rows).mockReset();
	vi.mocked(verifyCivicDatabase).mockResolvedValue();
});

describe("Public organization directory", () => {
	it("lists only organization names and slugs without requiring sign-in", async () => {
		const organizations = [
			{ name: "Town A", slug: "town-a" },
			{ name: "Town B", slug: "town-b" }
		];
		vi.mocked(rows).mockResolvedValue(organizations);

		const response = await request(app).get("/api/civic/public/organizations/list");

		expect(response.status).toBe(200);
		expect(response.body).toEqual(organizations);
		expect(response.headers["cache-control"]).toBe("no-store");
		expect(rows).toHaveBeenCalledWith("SELECT name, slug FROM civic.portals WHERE archived_at IS NULL ORDER BY lower(name), slug");
	});

	it("returns an empty list when no organizations exist", async () => {
		vi.mocked(rows).mockResolvedValue([]);

		const response = await request(app).get("/api/civic/public/organizations/list");

		expect(response.status).toBe(200);
		expect(response.body).toEqual([]);
	});
});
