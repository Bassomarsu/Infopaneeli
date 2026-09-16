import './test-env.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { namesForDate, getNamedays } from '../src/core/namedays.ts';
const table=JSON.parse(fs.readFileSync(new URL('../src/data/namedays-2000.json',import.meta.url),'utf8')) as Record<string,string[]>;
assert.equal(Object.keys(table).length,362);
assert.equal(Object.values(table).flat().length,751);
for(const [key,names] of Object.entries(table)){assert.equal(new Date('2000-'+key).toISOString().slice(5,10),key);assert(names.every(n=>typeof n==='string'&&n.trim().length>0));}
assert.deepEqual(namesForDate('2026-11-30'),['Antero','Antti','Atte']);
assert.deepEqual(namesForDate('2026-12-25'),[]);
// Lähteessä 15.7. on "Rauna, Rauni, Rauni". Kaksoiskappale siivotaan
// LUKUVAIHEESSA, koska datatiedosto on todennettu lähdettä vasten SHA-256:lla
// eikä sitä saa muokata. Nimien järjestys ei saa muuttua siivouksessa.
assert.deepEqual(namesForDate('2026-07-15'),['Rauna','Rauni']);
assert.deepEqual(table['07-15'],['Rauna','Rauni','Rauni'],'datatiedostoa ei ole muokattu');
for(const key of Object.keys(table)){const names=namesForDate('2026-'+key);assert.equal(new Set(names).size,names.length,key+' sisältää kaksoiskappaleen');}
assert.doesNotThrow(()=>namesForDate('2028-02-29'));
assert.throws(()=>namesForDate('2026-02-29'),/päivämäärä/);
assert.throws(()=>namesForDate('nonsense'),/päivämäärä/);
const result=getNamedays(new Date('2026-12-31T21:59:59Z'));
assert.equal(result.today.date,'2026-12-31');assert.equal(result.tomorrow.date,'2027-01-01');assert.equal(result.calendarYear,2000);
assert.equal(getNamedays(new Date('2026-12-31T22:00:00Z')).today.date,'2027-01-01');
assert.equal(getNamedays(new Date('2026-03-28T22:30:00Z')).tomorrow.date,'2026-03-30');
const copy=namesForDate('2026-11-30');copy.push('not persisted');assert(!namesForDate('2026-11-30').includes('not persisted'));
console.log('Namedays: historical dataset, known dates, empty day, source duplicate removed on read, leap day, Helsinki midnight, DST and independent arrays passed');
