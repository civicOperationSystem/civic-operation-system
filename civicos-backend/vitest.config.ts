const { defineConfig } = require("vitest/config");

module.exports = defineConfig({
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		// Database suites share the civicos_test schema and rotate the civic_app password, so run files one at a time.
		fileParallelism: false
	}
});
