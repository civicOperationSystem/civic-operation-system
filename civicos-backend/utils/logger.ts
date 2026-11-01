export const logger = {
	info: (message: string, data?: Record<string, unknown>) => {
		console.log(`[INFO] ${message}`, data ? JSON.stringify(data) : "");
	},
	error: (message: string, data?: Record<string, unknown>) => {
		console.error(`[ERROR] ${message}`, data ? JSON.stringify(data) : "");
	},
	debug: (message: string, data?: Record<string, unknown>) => {
		console.log(`[DEBUG] ${message}`, data ? JSON.stringify(data) : "");
	}
};
