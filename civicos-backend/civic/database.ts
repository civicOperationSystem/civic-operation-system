import { QueryTypes, Transaction } from "sequelize";
import { createCivicSequelize } from "./sequelize";

export const civicDatabase = createCivicSequelize({
	url: process.env.CIVIC_DATABASE_URL || process.env.DATABASE_URL,
	database: process.env.CIVIC_DATABASE || "civicos",
	username: process.env.CIVIC_DB_USER || "civic_app",
	password: process.env.CIVIC_DB_PASSWORD || "",
	host: process.env.CIVIC_DB_HOST || "127.0.0.1",
	port: Number(process.env.CIVIC_DB_PORT || 55432),
	pool: { max: 2, min: 0, acquire: 10000, idle: 10000 }
});

export async function verifyCivicDatabase(): Promise<void> {
	if ((!process.env.CIVIC_DATABASE_URL && !process.env.DATABASE_URL && !process.env.CIVIC_DB_PASSWORD) ||
		!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 ||
		!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
		throw new Error("Configure the database, Supabase Auth, and a JWT_SECRET of at least 32 characters");
	}
	const [role] = await civicDatabase.query<{ unsafe: boolean }>(
		`SELECT (rolsuper OR rolbypassrls OR EXISTS (
			SELECT 1 FROM pg_tables WHERE schemaname = 'civic' AND tableowner = current_user
		)) AS unsafe FROM pg_roles WHERE rolname = current_user`,
		{ type: QueryTypes.SELECT }
	);
	if (!role || role.unsafe) throw new Error("CivicOS runtime must use a non-owner, non-superuser, non-BYPASSRLS role");
	await civicDatabase.query("SELECT id FROM civic.portals LIMIT 1");
}

export async function tenantTransaction<T>(
	tenant: string,
	work: (transaction: Transaction) => Promise<T>,
	member?: string,
	platformAdmin = false
): Promise<T> {
	return civicDatabase.transaction(async transaction => {
		await civicDatabase.query(
			"SELECT set_config('civic.tenant', :tenant, true), set_config('civic.member', :member, true), set_config('civic.platform_admin', :platformAdmin, true)",
			{ replacements: { tenant, member: member || "", platformAdmin: platformAdmin ? "true" : "false" }, transaction }
		);
		return work(transaction);
	});
}

export function rows<T extends object>(
	sql: string,
	values: Record<string, unknown> = {},
	transaction?: Transaction
): Promise<T[]> {
	return civicDatabase.query<T>(sql, {
		replacements: values, type: QueryTypes.SELECT,
		...(transaction ? { transaction } : {})
	});
}
