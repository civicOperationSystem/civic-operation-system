import "pg";
import { X509Certificate } from "node:crypto";
import { Sequelize } from "sequelize";

type ConnectionOptions = {
	url?: string | undefined;
	database: string;
	username: string;
	password: string;
	host: string;
	port: number;
	pool?: { max: number; min: number; acquire: number; idle: number };
};

export function createCivicSequelize(options: ConnectionOptions): Sequelize {
	if (options.url) {
		const verification = process.env.CIVIC_DATABASE_SSL_REJECT_UNAUTHORIZED?.trim();
		if (verification && verification !== "true" && verification !== "false") {
			throw new Error("CIVIC_DATABASE_SSL_REJECT_UNAUTHORIZED must be true or false");
		}
		const rejectUnauthorized = verification !== "false";
		if (!rejectUnauthorized) {
			console.warn("CivicOS database TLS certificate verification is disabled. Encryption remains enabled, but the server identity is not verified. Re-enable verification before production use.");
		}
		const ca = process.env.CIVIC_DATABASE_SSL_CA?.replace(/\\n/g, "\n").trim();
		if (ca) {
			const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
			if (!certificates) {
				throw new Error("CIVIC_DATABASE_SSL_CA must contain PEM CA certificates");
			}
			for (const certificate of certificates) {
				new X509Certificate(certificate);
			}
		}
		const url = new URL(options.url);
		// URL SSL options would otherwise replace Sequelize's verified TLS configuration.
		for (const key of ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"]) {
			url.searchParams.delete(key);
		}
		return new Sequelize(url.toString(), {
			dialect: "postgres",
			logging: false,
			...(options.pool ? { pool: options.pool } : {}),
			dialectOptions: { ssl: { rejectUnauthorized, ...(ca ? { ca } : {}) } }
		});
	}
	return new Sequelize(options.database, options.username, options.password, {
		host: options.host,
		port: options.port,
		dialect: "postgres",
		logging: false,
		...(options.pool ? { pool: options.pool } : {})
	});
}

export function civicAppPassword(): string {
	if (process.env.CIVIC_DB_PASSWORD) return process.env.CIVIC_DB_PASSWORD;
	const url = process.env.CIVIC_DATABASE_URL || process.env.DATABASE_URL;
	if (!url) return "";
	const password = new URL(url).password;
	if (!password) throw new Error("The runtime database URL must contain the civic_app password");
	try {
		return decodeURIComponent(password);
	} catch {
		throw new Error("The runtime database URL contains an invalid encoded password");
	}
}
