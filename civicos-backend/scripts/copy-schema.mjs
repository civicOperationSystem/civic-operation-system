import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

mkdirSync(resolve('dist/civic'), { recursive: true });
copyFileSync(resolve('civic/schema.sql'), resolve('dist/civic/schema.sql'));
