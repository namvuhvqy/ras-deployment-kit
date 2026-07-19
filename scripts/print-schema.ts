import { renderSqlMigration } from '../packages/shared/src/dbSchema.js';

process.stdout.write(`${renderSqlMigration()}\n`);
