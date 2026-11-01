import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryTypes } from "sequelize";
import { civicAppPassword, createCivicSequelize } from "../civic/sequelize";
import { defaultRoles, defaultSettings } from "../civic/domain";

async function main(): Promise<void> {
	const password = civicAppPassword();
	const email = process.env.CIVIC_ADMIN_EMAIL;
	const slug = process.env.CIVIC_SLUG;
	const migrateOnly = process.env.CIVIC_MIGRATE_ONLY === "true";
	if (!password || (!migrateOnly && (!email || !slug || !/^[a-z0-9-]{3,60}$/.test(slug)))) {
		throw new Error("Set CIVIC_DB_PASSWORD, CIVIC_ADMIN_EMAIL and CIVIC_SLUG");
	}
	if (!migrateOnly && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email!)) throw new Error("Invalid CIVIC_ADMIN_EMAIL");
	const db = createCivicSequelize({
		url: process.env.CIVIC_ADMIN_DATABASE_URL,
		database: process.env.CIVIC_DATABASE || "civicos",
		username: process.env.POSTGRES_USER || "postgres",
		password: process.env.POSTGRES_PASSWORD || "",
		host: process.env.CIVIC_DB_HOST || "127.0.0.1",
		port: Number(process.env.CIVIC_DB_PORT || 55432)
	});
	try {
		await db.transaction(async transaction => {
			await db.query(`DO $$ BEGIN
				IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'civic_app') THEN
					CREATE ROLE civic_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
				END IF;
			END $$`, { transaction });
			await db.query("ALTER ROLE civic_app PASSWORD :password", { replacements: { password }, transaction });
			await db.query(readFileSync(join(__dirname, "..", "civic", "schema.sql"), "utf8"), { transaction });
			if (migrateOnly) return;
			const existing = await db.query("SELECT id FROM civic.portals WHERE slug = :slug", {
				replacements: { slug }, type: QueryTypes.SELECT, transaction
			});
			if (existing.length) {
				console.log(`Organization ${slug} already exists; its settings, users and data were preserved.`);
				return;
			}
			const id = randomUUID();
			const domain = process.env.CIVIC_DOMAIN || null;
			if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) throw new Error("CIVIC_DOMAIN must be a verified hostname");
			const settings = { ...defaultSettings, contact: process.env.CIVIC_CONTACT || "" };
			await db.query(`INSERT INTO civic.portals(id, slug, domain, name, settings)
				VALUES (:id, :slug, :domain, :name, CAST(:settings AS jsonb))`, {
				replacements: { id, slug, domain, name: process.env.CIVIC_NAME || slug, settings: JSON.stringify(settings) }, transaction
			});
			await db.query("INSERT INTO civic.config VALUES (:id, CAST(:roles AS jsonb))", {
				replacements: { id, roles: JSON.stringify(defaultRoles) }, transaction
			});
			await db.query(`INSERT INTO civic.members(id, tenant_id, email, role)
				VALUES (:member, :id, :email, 'admin')`, {
				replacements: { member: randomUUID(), id, email: email!.toLowerCase() }, transaction
			});
		});
		console.log(migrateOnly ? "CivicOS database schema updated without changing organization data." : `CivicOS organization ready: ${slug}`);
	} finally { await db.close(); }
}
void main().catch(error => { console.error("CivicOS provisioning failed", error); process.exitCode = 1; });
