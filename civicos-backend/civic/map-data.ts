import { State } from "./domain";
import { RecordRow, publicStatus } from "./router-shared";

export function geojson(records: RecordRow[], states: State[]) {
	return {
		type: "FeatureCollection",
		truncated: records.length > 5000,
		features: records.slice(0, 5000).map(record => ({
			type: "Feature", id: record.id,
			geometry: { type: "Point", coordinates: [record.longitude, record.latitude] },
			properties: {
				id: record.id, kind: record.kind, title: record.title,
				status: record.kind === "request" ? publicStatus(record.status, states) : null,
				location: record.kind === "request" ? null : record.location
			}
		}))
	};
}
