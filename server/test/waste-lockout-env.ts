/**
 * Oma tietokanta ja loki tälle testille. Nimi on eri kuin waste-test-env.ts:llä,
 * jotta kaksi jätehuoltotestiä voi ajaa rinnakkain sotkematta toistensa kantaa.
 *
 * Avaintiedosto poistetaan erikseen: test-env.ts siivoaa vain `DB_PATH`:n, ja
 * edellisen ajon avain samalla PID:llä jäisi muuten viereen. Tyhjä kanta + vanha
 * avain ei riko mitään, mutta testi mittaa nimenomaan avaimen ja salaisuuden
 * suhdetta, joten lähtötilan pitää olla puhdas molempien osalta.
 */
process.env.DB_PATH='data/infonaytto-test-lockout-'+process.pid+'.db';
process.env.LOG_DIR='data/logs-test-lockout-'+process.pid;
process.env.TRUSTED_HOSTS='';
process.env.EDIT_PIN='4242';
process.env.FULL_PIN='654321';
await import('./test-env.ts');
const fs=await import('node:fs');
fs.default.rmSync(process.env.DB_PATH+'.waste-key',{force:true});
export {};
