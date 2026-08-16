/**
 * Pitkän painalluksen tunnistus — pelkkä pointer-eventtien tulkinta, ei mitään
 * Vue-riippuvuutta, jotta se on testattavissa ilman DOMia (ks.
 * web/test/kiosk-exit-hotspot.ts). Käyttäjä: KioskExitHotspot.vue, joka
 * tarvitsee eleen joka EI voi laueta vahingossa kun joku pyyhkii ruutua tai
 * nojaa siihen ohimennen — ks. kyseisen komponentin kommentti perusteluineen.
 */

/** Riittävän suuri osajoukko PointerEventistä — testit antavat pelkän olion, ei oikeaa DOM-tapahtumaa. */
export interface PointerLike {
  pointerId: number;
  clientX: number;
  clientY: number;
}

export interface LongPressTracker {
  onPointerDown(event: PointerLike): void;
  onPointerMove(event: PointerLike): void;
  onPointerUp(event: PointerLike): void;
  onPointerCancel(event: PointerLike): void;
}

/**
 * `holdMs`: kuinka kauan sormen pitää pysyä paikallaan ennen laukeamista.
 * `moveTolerancePx`: kuinka paljon sormi saa liikkua ilman että ele
 * peruuntuu — pyyhkäisy ylittää tämän heti, vahingossa syntyvä pieni
 * tärähdys ei.
 */
export function createLongPressTracker(holdMs: number, moveTolerancePx: number, onTrigger: () => void): LongPressTracker {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activePointerId: number | null = null;
  let originX = 0;
  let originY = 0;

  function reset(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    activePointerId = null;
  }

  return {
    onPointerDown(event) {
      // Toinen sormi jo painettuna: ei aloiteta uutta ajastinta sen päälle
      // eikä anneta jälkimmäisen sormen nostaa/peruuttaa ensimmäisen
      // seurantaa (ks. onPointerUp/onPointerMoven pointerId-vertailu).
      if (activePointerId !== null) return;
      activePointerId = event.pointerId;
      originX = event.clientX;
      originY = event.clientY;
      timer = setTimeout(() => {
        reset();
        onTrigger();
      }, holdMs);
    },
    onPointerMove(event) {
      if (activePointerId !== event.pointerId) return;
      const dx = event.clientX - originX;
      const dy = event.clientY - originY;
      if (Math.hypot(dx, dy) > moveTolerancePx) reset();
    },
    onPointerUp(event) {
      if (activePointerId === event.pointerId) reset();
    },
    onPointerCancel(event) {
      if (activePointerId === event.pointerId) reset();
    },
  };
}
