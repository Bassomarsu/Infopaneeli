// Set isolated paths before test-env or any database/config dependency loads.
process.env.DB_PATH='data/infonaytto-test-household-'+process.pid+'.db';
process.env.LOG_DIR='data/logs-test-household-'+process.pid;
process.env.EDIT_PIN='4242';
process.env.TRUSTED_HOSTS='';
await import('./test-env.ts');
export {};
