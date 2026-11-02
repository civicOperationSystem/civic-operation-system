import { rootCertificates } from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { civicAppPassword, createCivicSequelize } from "../civic/sequelize";

const connectionOptions = {
	database: "civicos",
	username: "civic_app",
	password: "",
	host: "127.0.0.1",
	port: 55432
};

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});
beforeEach(() => {
	vi.stubEnv("CIVIC_DATABASE_SSL_CA", "");
	vi.stubEnv("CIVIC_DATABASE_SSL_REJECT_UNAUTHORIZED", "");
});

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

	it.each(["", "?sslmode=require", "?sslmode=no-verify", "?ssl=false", "?sslrootcert=missing.crt"])(
		"preserves verified TLS and the configured CA with URL options %s",
		async query => {
			const ca = rootCertificates[0]!;
			vi.stubEnv("CIVIC_DATABASE_SSL_CA", ca.replace(/\n/g, "\\n"));
			const connection = createCivicSequelize({
				...connectionOptions, url: `postgresql://civic_app@db.example.org:5432/civicos${query}`
			});
			const stopped = new Error("Stop before opening a database connection");
			connection.addHook("beforeConnect", config => {
				expect(config.dialectOptions).toMatchObject({ ssl: { rejectUnauthorized: true, ca } });
				throw stopped;
			});
			try {
				await expect(connection.authenticate()).rejects.toBe(stopped);
			} finally {
				await connection.close();
			}
		}
	);

	it("keeps verified TLS using default trust when no CA is configured", async () => {
		const connection = createCivicSequelize({
			...connectionOptions, url: "postgresql://civic_app@db.example.org:5432/civicos?sslmode=no-verify"
		});
		const stopped = new Error("Stop before opening a database connection");
		connection.addHook("beforeConnect", config => {
			expect(config.dialectOptions).toMatchObject({ ssl: { rejectUnauthorized: true } });
			throw stopped;
		});
		try {
			await expect(connection.authenticate()).rejects.toBe(stopped);
		} finally {
			await connection.close();
		}
	});

	it.each(["not a certificate", "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----"])(
		"rejects an invalid CA instead of silently falling back: %s",
		ca => {
			vi.stubEnv("CIVIC_DATABASE_SSL_CA", ca);
			expect(() => createCivicSequelize({
				...connectionOptions, url: "postgresql://civic_app@db.example.org:5432/civicos"
			})).toThrow();
		}
	);

	it.each(["true", "false"])("applies explicit certificate verification setting %s without disabling TLS", async value => {
		vi.stubEnv("CIVIC_DATABASE_SSL_REJECT_UNAUTHORIZED", value);
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const connection = createCivicSequelize({
			...connectionOptions, url: "postgresql://civic_app@db.example.org:5432/civicos?sslmode=disable"
		});
		const stopped = new Error("Stop before opening a database connection");
		connection.addHook("beforeConnect", config => {
			expect(config.dialectOptions).toMatchObject({ ssl: { rejectUnauthorized: value === "true" } });
			throw stopped;
		});
		try {
			await expect(connection.authenticate()).rejects.toBe(stopped);
			if (value === "false") {
				expect(warning).toHaveBeenCalledWith(expect.stringContaining("certificate verification is disabled"));
			} else {
				expect(warning).not.toHaveBeenCalled();
			}
		} finally {
			await connection.close();
		}
	});

	it("rejects misspelled certificate verification settings", () => {
		vi.stubEnv("CIVIC_DATABASE_SSL_REJECT_UNAUTHORIZED", "flase");
		expect(() => createCivicSequelize({
			...connectionOptions, url: "postgresql://civic_app@db.example.org:5432/civicos"
		})).toThrow("must be true or false");
	});
});
