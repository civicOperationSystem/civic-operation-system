import { describe, expect, it } from "vitest";
import { publicRequestPhotos } from "../civic/domain";

describe("public request photo visibility", () => {
	it("shows resident photos after review and field photos only while verified", () => {
		const resident = ["resident-1", "resident-2", "resident-3"];
		const field = ["field-1", "field-2", "field-3"];
		for (const state of ["reviewed", "in_progress", "completed", "closed", null]) {
			expect(publicRequestPhotos(state, resident, field)).toEqual(resident);
		}
		expect(publicRequestPhotos("verified", resident, field)).toEqual([...resident, ...field]);
		expect(publicRequestPhotos("in_progress", resident, field)).toEqual(resident);
	});
});
