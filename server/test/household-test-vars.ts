// Ympäristömuuttujat household-test-env.ts:lle, ks. waste-test-env.ts.
process.env.DB_PATH='data/infonaytto-test-household-'+process.pid+'.db';
process.env.LOG_DIR='data/logs-test-household-'+process.pid;
process.env.EDIT_PIN='4242';
process.env.TRUSTED_HOSTS='';
export {};
