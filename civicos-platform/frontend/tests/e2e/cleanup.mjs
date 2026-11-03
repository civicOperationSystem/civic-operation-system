import { createRequire } from 'node:module';
import { resolve } from 'node:path';

export default async function cleanup() {
  const slug = process.env.E2E_SLUG;
  if (process.env.CIVIC_DATABASE !== 'civicos_test' || !slug?.startsWith('browser-')) {
    throw new Error('Refusing to clean browser fixtures outside the test database');
  }
  const require = createRequire(resolve('../../civicos-backend/package.json'));
  const { Sequelize, QueryTypes } = require('sequelize');
  const db = new Sequelize('civicos_test', 'postgres', process.env.CIVIC_TEST_PASSWORD || 'civicos-test-local-only', {
    host: '127.0.0.1', port: Number(process.env.CIVIC_TEST_PORT || 15433), dialect: 'postgres', logging: false,
  });
  try {
    await db.transaction(async transaction => {
      for (const testSlug of [slug, `managed-${slug}`, `maps-${slug}`]) {
        const [portal] = await db.query('SELECT id FROM civic.portals WHERE slug = :slug', {
          replacements: { slug: testSlug }, type: QueryTypes.SELECT, transaction,
        });
        if (!portal) continue;
        for (const table of ['history', 'records', 'chat_messages', 'chat_direct_threads', 'chat_channels', 'members', 'config']) {
          await db.query(`DELETE FROM civic.${table} WHERE tenant_id = :id`, { replacements: { id: portal.id }, transaction });
        }
        await db.query('DELETE FROM civic.portals WHERE id = :id', { replacements: { id: portal.id }, transaction });
      }
    });
  } finally { await db.close(); }
}
