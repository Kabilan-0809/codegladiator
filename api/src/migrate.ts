import { runMigrations } from './db.js';
import { logger } from './logger.js';

runMigrations()
  .then(() => {
    logger.info({ message: 'Migrations completed successfully' });
    process.exit(0);
  })
  .catch((err) => {
    logger.error({ message: 'Migration failed', error: String(err) });
    process.exit(1);
  });
