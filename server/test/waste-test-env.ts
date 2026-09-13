process.env.DB_PATH='data/infonaytto-test-waste-'+process.pid+'.db';
process.env.LOG_DIR='data/logs-test-waste-'+process.pid;
process.env.TRUSTED_HOSTS='';
process.env.EDIT_PIN='4242';
process.env.FULL_PIN='654321';
await import('./test-env.ts');
export {};
