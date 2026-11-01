import { afterEach, describe, expect, it, vi } from "vitest";
import { civicAppPassword, createCivicSequelize } from "../civic/sequelize";

const connectionOptions = {
	database: "civicos",
	username: "civic_app",
	password: "",
	host: "127.0.0.1",
	port: 55432
};

afterEach(() => vi.unstubAllEnvs());

describe("CivicOS database connection configuration", () => {
	it("prefers an explicitly configured runtime password", () => {
		vi.stubEnv("CIVIC_DB_PASSWORD", "configured-password");
		vi.stubEnv("CIVIC_DATABASE_URL", "not a valid URL");

		expect(civicAppPassword()).toBe("configured-password");
	});

	it("decodes the runtime role password from a Supabase-compatible URL", () => {
		vi.stubEnv("CIVIC_DB_PASSWORD", "");
		vi.stubEnv("CIVIC_DATABASE_URL", "postgresql://civic_app:p%40ss%3Aword@db.example.org:5432/civicos");
		vi.stubEnv("DATABASE_URL", "");

		expect(civicAppPassword()).toBe("p@ss:word");
	});

	it("uses DATABASE_URL as a fallback and rejects URLs without a password", () => {
		vi.stubEnv("CIVIC_DB_PASSWORD", "");
		vi.stubEnv("CIVIC_DATABASE_URL", "");
		vi.stubEnv("DATABASE_URL", "postgresql://civic_app:app-secret@db.example.org:5432/civicos");
		expect(civicAppPassword()).toBe("app-secret");

		vi.stubEnv("DATABASE_URL", "postgresql://civic_app@db.example.org:5432/civicos");
		expect(() => civicAppPassword()).toThrow("must contain the civic_app password");
	});

	it("creates PostgreSQL connections from URL-based configuration", () => {
		const connection = createCivicSequelize({
			...connectionOptions,
			url: "postgresql://civic_app:app-secret@db.example.org:5432/civicos"
		});

		expect(connection.getDialect()).toBe("postgres");
		return connection.close();
	});
});
