import assert from 'node:assert/strict';
import { settingsPatch, WIDGET_SETTING_KEYS } from '../src/composables/widgetSettings.ts';
import type { Settings } from '../src/types.ts';
const settings = { newsCategories:['paauutiset'], menuSchoolIds:['school-a'], weatherPostalCode:'43500', visibleStudents:['child-a'], visiblePaikkyChildren:null, scheduleLayout:'split', rolloverTime:'15:00', breakfastTime:'08:00', hideMessagePreviews:true, hiddenPanels:[], panelLayout:null, gridOverflow:'scroll', hideNextAlarm:false, nightModeStart:'22:00', nightModeEnd:'06:00', alarms:[{id:'untouched'}] } as unknown as Settings;
assert.deepEqual(settingsPatch(settings,'news'), {newsCategories:['paauutiset']});
assert.deepEqual(settingsPatch(settings,'weather'), {weatherPostalCode:'43500'});
assert.deepEqual(settingsPatch(settings,'menu'), {menuSchoolIds:['school-a']});
assert.deepEqual(settingsPatch(settings,'waste'), {});
const general = settingsPatch(settings);
// Yhden kortin sisältövalinnat eivat nay yleisissa asetuksissa, joten niita ei
// myoskaan saa kirjoittaa sielta paalle.
for(const key of ['newsCategories','menuSchoolIds','scheduleLayout','alarms']) assert.ok(!(key in general),key+' must not be saved by general settings');
// Nama nakyvat yleisissa asetuksissa, koska piilotetulla kortilla ei ole
// hammasratasta jonka takaa ne loytyisivat — siis niiden on myos tallennuttava.
for(const key of ['visibleStudents','visiblePaikkyChildren','rolloverTime','breakfastTime','weatherPostalCode','hideMessagePreviews']) assert.ok(key in general,key+' must be reachable from general settings');
const scheduled = settingsPatch(settings,'schedule');
assert.ok('visibleStudents' in scheduled && 'rolloverTime' in scheduled);
// Aamupala on halytysten ankkuri eika lukujarjestyskortin asetus.
assert.ok(!('breakfastTime' in scheduled));
assert.ok(!('hideMessagePreviews' in scheduled));
assert.deepEqual(Object.keys(WIDGET_SETTING_KEYS).sort(),['menu','messages','news','schedule','waste','weather']);
console.log('PASS: widget settings patches are scoped and cannot overwrite unrelated settings');
