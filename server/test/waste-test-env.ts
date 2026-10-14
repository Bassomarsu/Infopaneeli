// Staattiset importit eikä `await import()`: top-level await tekee tästä
// asynkronisen moduulin, jolloin testin sisarmoduulit (config.ts, store.ts)
// evaluoidaan ennen kuin test-env.ts ehtii siivota edellisen ajon kannan.
// Linuxissa siivous poisti silloin jo auki olevan kannan, ja ensimmäinen
// kirjoitus kaatui virheeseen "attempt to write a readonly database".
import './waste-test-vars.ts';
import './test-env.ts';
export {};
