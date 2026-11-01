import { CivicError } from "./domain";

export type SupabaseUser = { id: string; email: string };

export async function getSupabaseUser(accessToken: string): Promise<SupabaseUser | null> {
	const baseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
	const apiKey = process.env.SUPABASE_ANON_KEY;
	if (!baseUrl || !apiKey) throw new CivicError(503, "Supabase authentication is not configured");

	let response: Response;
	try {
		response = await fetch(`${baseUrl}/auth/v1/user`, {
			headers: { apikey: apiKey, Authorization: `Bearer ${accessToken}` },
			signal: AbortSignal.timeout(8000)
		});
	} catch {
		throw new CivicError(503, "Supabase authentication is unavailable");
	}
	if (response.status === 401 || response.status === 403) return null;
	if (!response.ok) throw new CivicError(503, "Supabase authentication is unavailable");

	let user: {
		id?: unknown;
		email?: unknown;
		email_confirmed_at?: unknown;
		confirmed_at?: unknown;
	};
	try {
		user = await response.json() as typeof user;
	} catch {
		throw new CivicError(503, "Supabase returned an invalid authentication response");
	}
	if (typeof user.id !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id) ||
		typeof user.email !== "string" ||
		!(typeof user.email_confirmed_at === "string" || typeof user.confirmed_at === "string")) {
		return null;
	}
	return { id: user.id, email: user.email.toLowerCase() };
}
