/**
 * Oma tietokanta ja loki tälle testille. Nimi on eri kuin waste-test-env.ts:llä,
 * jotta kaksi jätehuoltotestiä voi ajaa rinnakkain sotkematta toistensa kantaa.
 *
 * Avaintiedosto poistetaan erikseen: test-env.ts siivoaa vain `DB_PATH`:n, ja
 * edellisen ajon avain samalla PID:llä jäisi muuten viereen. Tyhjä kanta + vanha
 * avain ei riko mitään, mutta testi mittaa nimenomaan avaimen ja salaisuuden
 * suhdetta, joten lähtötilan pitää olla puhdas molempien osalta.
 *
 * Staattiset importit eikä `await import()` — ks. waste-test-env.ts.
 */
import './waste-lockout-vars.ts';
import './test-env.ts';
import fs from 'node:fs';
// unlinkSync eikä rmSync: rmSync on joillain levyillä hiljainen tyhjäkäynti.
try{fs.unlinkSync(process.env.DB_PATH+'.waste-key');}catch{}
export {};
