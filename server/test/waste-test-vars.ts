// Ympäristömuuttujat waste-test-env.ts:lle. Omassa moduulissaan, koska
// staattiset importit nousevat tiedoston alkuun: asetukset ehtivät voimaan
// ennen test-env.ts:ää vain jos ne evaluoidaan ennen sitä erillisenä moduulina.
process.env.DB_PATH='data/infonaytto-test-waste-'+process.pid+'.db';
process.env.LOG_DIR='data/logs-test-waste-'+process.pid;
process.env.TRUSTED_HOSTS='';
process.env.EDIT_PIN='4242';
process.env.FULL_PIN='654321';
export {};
