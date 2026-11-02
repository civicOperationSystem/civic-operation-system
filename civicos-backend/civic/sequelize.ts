import "pg";
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
		return new Sequelize(options.url, {
			dialect: "postgres",
			logging: false,
			...(options.pool ? { pool: options.pool } : {}),
			dialectOptions: { ssl: { rejectUnauthorized: true } }
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
