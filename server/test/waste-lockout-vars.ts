// Ympäristömuuttujat waste-lockout-env.ts:lle, ks. waste-test-env.ts.
process.env.DB_PATH='data/infonaytto-test-lockout-'+process.pid+'.db';
process.env.LOG_DIR='data/logs-test-lockout-'+process.pid;
process.env.TRUSTED_HOSTS='';
process.env.EDIT_PIN='4242';
process.env.FULL_PIN='654321';
export {};
