import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import { requestLogger } from "./middlewares/logger";
import { civicRouter, civicErrorHandler } from "./civic/router";
import { civicDatabase, verifyCivicDatabase } from "./civic/database";
import { CivicError } from "./civic/domain";

const app = express();

const resolvePort = (): number => {
	const equalArg = process.argv.find((arg) => arg.startsWith("--port="));
	if (equalArg) {
		const value = Number(equalArg.split("=")[1]);
		if (Number.isInteger(value) && value > 0) {
			return value;
		}
	}

	const index = process.argv.indexOf("--port");
	if (index !== -1) {
		const value = Number(process.argv[index + 1]);
		if (Number.isInteger(value) && value > 0) {
			return value;
		}
	}

	const envPort = Number(process.env.PORT);
	if (Number.isInteger(envPort) && envPort > 0) {
		return envPort;
	}

	return 3030;
};

const PORT = resolvePort();

let databaseReady: Promise<void> | null = null;
function verifyDatabaseOnce(): Promise<void> {
	if (!databaseReady) {
		databaseReady = verifyCivicDatabase().catch(error => {
			databaseReady = null;
			throw error;
		});
	}
	return databaseReady;
}

app.use(helmet());
app.use(requestLogger);
app.get("/readyz", async (_req, res) => {
	res.setHeader("Cache-Control", "no-store");
	try {
		await verifyCivicDatabase();
		res.json({ service: "CivicOS", status: "ready" });
	} catch (error) {
		console.error("CivicOS readiness check failed", error);
		res.status(503).json({ service: "CivicOS", status: "not_ready" });
	}
});
app.use(express.json({ limit: "3mb" }));
app.use((_req, res, next) => {
	void verifyDatabaseOnce().then(() => next()).catch(error => {
		console.error("CivicOS database verification failed", error);
		res.status(503).json({ message: "CivicOS database is unavailable or not configured" });
	});
});
app.get("/health", async (_req, res, next) => {
	try {
		await civicDatabase.query("SELECT 1");
		res.json({ service: "CivicOS", status: "ok" });
	} catch (error) { next(error); }
});
app.use("/api/civic", (_req: Request, res: Response, next: NextFunction) => {
	res.setHeader("Cache-Control", "no-store");
	next();
}, (req: Request, _res: Response, next: NextFunction) => {
	if (["POST", "PUT"].includes(req.method) && (!req.body || typeof req.body !== "object" || Array.isArray(req.body))) {
		next(new CivicError(400, "A JSON object request body is required"));
		return;
	}
	next();
}, civicRouter);
app.use((_req, res) => { res.status(404).json({ message: "Endpoint not found" }); });
app.use(civicErrorHandler);

export const startServer = async (): Promise<void> => {
	await verifyDatabaseOnce();
	const server = app.listen(PORT, () => {
		console.log(`Server listening on port ${PORT}`);
	});
	server.on("error", error => { console.error("CivicOS listener failed", error); process.exitCode = 1; });
	const shutdown = () => {
		server.close(() => {
			void civicDatabase.close().catch(error => {
				console.error("CivicOS shutdown failed", error);
				process.exitCode = 1;
			});
		});
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
};

if (require.main === module && process.env.VERCEL !== "1") {
	void startServer().catch((error) => {
		console.error("Failed to start server", error);
		process.exit(1);
	});
}

export default app;
