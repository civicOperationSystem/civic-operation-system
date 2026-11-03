import { randomBytes } from "node:crypto";

export const permissions = ["manage", "read", "assign", "transition", "publish", "field", "chat"] as const;
export type Permission = typeof permissions[number];
export const defaultRoles: Record<string, Permission[]> = {
	admin: ["manage", "read", "assign", "transition", "publish", "chat"],
	staff: ["read", "assign", "transition", "publish", "chat"],
	field: ["field", "transition", "chat"]
};
export type State = { key: string; label: string; next: string[]; field?: boolean };
export function fieldCanEnter(state: State): boolean {
	return state.field ?? ["in_progress", "completed"].includes(state.key);
}
export function publicRequestPhotos(status: string | null, photos: string[], fieldPhotos: string[]): string[] {
	return status === "verified" ? [...photos, ...fieldPhotos] : [...photos];
}
export type Settings = {
	logo: string; color: string; timezone: string; language: string;
	locations: string[]; departments: string[]; categories: string[];
	services: string[]; anonymous: boolean; contact: string;
	center: [number, number]; zoom?: number; states: State[];
};
export const defaultSettings: Settings = {
	logo: "", color: "#0d9488", timezone: "UTC", language: "en",
	locations: [], departments: ["Public works"], services: ["Community maintenance"],
	categories: ["Pothole", "Streetlight", "Water leak", "Damaged sign", "Trash", "Facility", "Accessibility"],
	anonymous: true, contact: "", center: [0, 0], zoom: 2,
	states: [
		{ key: "submitted", label: "Submitted", next: ["reviewed"] },
		{ key: "reviewed", label: "Reviewed", next: ["assigned"] },
		{ key: "assigned", label: "Crew assigned", next: ["in_progress"] },
		{ key: "in_progress", label: "Work in progress", next: ["completed"], field: true },
		{ key: "completed", label: "Completed", next: ["verified", "in_progress"], field: true },
		{ key: "verified", label: "Verified", next: [] }
	]
};
export class CivicError extends Error {
	constructor(public status: number, message: string) { super(message); }
}
export function text(value: unknown, name: string, max = 1000, required = true): string {
	if (typeof value !== "string" || value.length > max || (required && !value.trim())) {
		throw new CivicError(400, `Invalid ${name}`);
	}
	return value.trim();
}
export function identifier(value: unknown): string {
	const id = text(value, "identifier", 36);
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
		throw new CivicError(400, "Invalid identifier");
	}
	return id;
}
export function coordinates(longitude: unknown, latitude: unknown): { longitude: number | null; latitude: number | null } {
	if (longitude == null && latitude == null) return { longitude: null, latitude: null };
	if (typeof longitude !== "number" || typeof latitude !== "number" ||
		!Number.isFinite(longitude) || !Number.isFinite(latitude) ||
		longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
		throw new CivicError(400, "Invalid map coordinates");
	}
	return { longitude, latitude };
}
export function trackingReference(): string {
	return randomBytes(16).toString("hex").toUpperCase().match(/.{4}/g)!.join("-");
}
export function safeUrl(value: unknown): string | null {
	if (value == null || value === "") return null;
	const url = text(value, "URL", 2048);
	try {
		if (new URL(url).protocol === "https:") return url;
	} catch { /* Invalid URLs receive the same validation error as unsafe protocols. */ }
	throw new CivicError(400, "URLs must use HTTPS");
}
export function calendarDate(value: unknown): string | null {
	if (value == null || value === "") return null;
	if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
		const [year = 0, month = 0, day = 0] = value.split("-").map(Number);
		const date = new Date(Date.UTC(year, month - 1, day));
		if (year >= 1900 && year <= 2200 && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) return value;
	}
	throw new CivicError(400, "Calendar date must be a valid YYYY-MM-DD date");
}
export function validateSettings(value: unknown): Settings {
	if (!value || typeof value !== "object") throw new CivicError(400, "Invalid settings");
	const settings = value as Settings;
	text(settings.contact, "contact", 1000, false);
	text(settings.language, "language", 20);
	text(settings.timezone, "timezone", 100);
	try { new Intl.DateTimeFormat(settings.language, { timeZone: settings.timezone }); }
	catch { throw new CivicError(400, "Invalid timezone or language"); }
	text(settings.logo, "logo", 2048, false);
	safeUrl(settings.logo);
	if (!/^#[0-9a-f]{6}$/i.test(settings.color) || typeof settings.anonymous !== "boolean") {
		throw new CivicError(400, "Invalid branding or anonymous setting");
	}
	for (const key of ["locations", "departments", "categories", "services"] as const) {
		if (!Array.isArray(settings[key]) || settings[key].length > 100) throw new CivicError(400, `Invalid ${key}`);
		settings[key].forEach(item => text(item, key, 100));
	}
	if (!settings.categories.length) throw new CivicError(400, "At least one category is required");
	if (!Array.isArray(settings.center) || settings.center.length !== 2) throw new CivicError(400, "Invalid map center");
	if (typeof settings.center[0] !== "number" || typeof settings.center[1] !== "number") throw new CivicError(400, "Invalid map center");
	coordinates(settings.center[0], settings.center[1]);
	if (settings.zoom !== undefined && (typeof settings.zoom !== "number" ||
		!Number.isFinite(settings.zoom) || settings.zoom < 1 || settings.zoom > 19)) {
		throw new CivicError(400, "Map zoom must be between 1 and 19");
	}
	if (!Array.isArray(settings.states) || settings.states.length < 2 || settings.states.length > 20) {
		throw new CivicError(400, "Workflow must have 2-20 states");
	}
	if (settings.states.some(state => !state || typeof state !== "object" || typeof state.key !== "string")) {
		throw new CivicError(400, "Invalid workflow state");
	}
	const keys = new Set(settings.states.map(state => state.key));
	if (keys.size !== settings.states.length || settings.states[0]?.key !== "submitted") {
		throw new CivicError(400, "Workflow must start with submitted and use unique keys");
	}
	settings.states.forEach(state => {
		if (!/^[a-z_]{2,40}$/.test(state.key) || !Array.isArray(state.next) ||
			state.next.some(next => !keys.has(next) || next === state.key || next === "submitted") ||
			(state.field !== undefined && typeof state.field !== "boolean")) {
			throw new CivicError(400, "Invalid workflow transition");
		}
		text(state.label, "state label", 100);
	});
	const reachable = new Set<string>();
	const visit = (key: string) => {
		if (reachable.has(key)) return;
		reachable.add(key);
		settings.states.find(state => state.key === key)?.next.forEach(visit);
	};
	visit("submitted");
	if (reachable.size !== keys.size || !settings.states.some(state => !state.next.length)) {
		throw new CivicError(400, "Workflow must have a terminal state and all states must be reachable from submitted");
	}
	return {
		logo: settings.logo, color: settings.color, timezone: settings.timezone,
		language: settings.language, locations: settings.locations, departments: settings.departments,
		categories: settings.categories, services: settings.services, anonymous: settings.anonymous,
		contact: settings.contact, center: settings.center, zoom: settings.zoom ?? 12, states: settings.states
	};
}
