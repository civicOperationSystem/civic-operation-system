import { Router, Request, Response, NextFunction } from "express";
import { CivicError } from "./domain";
import { logger } from "../utils/logger";
import { publicRoutes } from "./public-routes";
import { sessionRoutes } from "./session-routes";
import { staffRoutes } from "./staff-routes";
import { chatRoutes } from "./chat-routes";
import { mapRoutes } from "./map-routes";

export const civicRouter = Router();
civicRouter.use(publicRoutes, sessionRoutes, staffRoutes, chatRoutes, mapRoutes);

export function civicErrorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
	const known = error instanceof CivicError;
	const databaseError = error && typeof error === "object" && "original" in error ?
		(error.original as { code?: string; constraint?: string } | undefined) : undefined;
	const databaseCode = databaseError?.code;
	const photoLimitMigrationRequired = databaseCode === "23514" && databaseError?.constraint === "records_photo_limit_check";
	const parseStatus = error && typeof error === "object" && "type" in error ?
		error.type === "entity.parse.failed" ? 400 : error.type === "entity.too.large" ? 413 : null : null;
	const status = known ? error.status : parseStatus || (databaseCode === "23505" || photoLimitMigrationRequired ? 409 : 500);
	const message = known ? error.message : status === 400 ? "Invalid JSON request body" :
		status === 413 ? "Request exceeds the 3 MB limit" :
			photoLimitMigrationRequired ? "The database must be migrated before resident and field photos can be stored separately" :
				status === 409 ? "This record already exists" : "CivicOS could not complete this operation";
	logger.error("CivicOS operation failed", {
		status, message,
		...(status === 500 ? { error: error instanceof Error ? error.message : String(error), databaseCode } : {})
	});
	res.status(status).json({ message });
}
