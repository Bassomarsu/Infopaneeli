<script setup lang="ts">
/**
 * Näkymätön painike kioskitilasta poistumiseen — ei mitään visuaalista
 * vihjettä, ks. tiimin vaatimus. PIN kysytään vasta App.vuen avaamassa
 * KioskExitDialogissa, tämä komponentti vain tunnistaa eleen.
 *
 * SIJAINTI: yläpalkin päivämäärän perässä (App.vuen topbar__date-wrap), EI
 * ruudun nurkassa. Käyttäjän oma tarkennus alkuperäiseen nurkka-ehdotukseen:
 * ruudun reuna on juuri se kohta johon osutaan vahingossa pöytää
 * pyyhittäessä tai näyttöä siirrettäessä, kun taas päivämäärän vieressä
 * oleva rajattu alue vaatii tietoisemman kosketuksen. Tämä komponentti
 * OLETTAA olevansa upotettu position:relative-elementtiin joka on kooltaan
 * juuri päivämäärätekstin kokoinen (ks. App.vuen topbar__date-wrap) — se
 * ankkuroituu sen OIKEAAN reunaan (left: 100%), ei mihinkään kiinteään
 * pikselikoordinaattiin, koska dateLabel vaihtaa pituutta päivästä toiseen.
 *
 * Ele on silti PITKÄ PAINALLUS (ks. HOLD_MS), ei yksi napautus eikä useampi
 * nopea napautus — paikka on turvallisempi kuin nurkka, mutta näkymätön
 * painike joka laukeaisi yhdestä kosketuksesta laukeaisi silti joskus
 * vahingossa (esim. sormi liukuu kellosta päivämäärän yli), ja seurauksena
 * olisi kioskin sulkeutuminen kesken päivän:
 *  - Yksi napautus tai useampi nopea napautus samaan kohtaan ei erota
 *    tarkoituksellista kosketusta ohimenevästä.
 *  - Pitkä, PAIKALLAAN pysyvä painallus ei laukea kummastakaan: liike
 *    peruuntuu MOVE_TOLERANCE_PX:n ylityksestä (ks. useLongPress.ts) eikä
 *    ohimenevä kosketus kestä koko HOLD_MS:ää. Sama peruste jolla esim.
 *    puhelinten piilotetut kehittäjävalikot käyttävät pitkää painallusta
 *    eivätkä napautusta.
 *
 * Kosketusalue ulottuu päivämäärätekstin oman rivikorkeuden yli (ks. tyylin
 * top/bottom-arvot) käytettävyyden vuoksi — position:absolute pitää sen
 * silti kokonaan pois dokumentin virtauksesta, joten se ei voi työntää
 * kelloa/päivämäärää sivuun eikä muuttaa yläpalkin rivin korkeutta.
 */
import { createLongPressTracker } from "../composables/useLongPress.ts";

const emit = defineEmits<{ trigger: [] }>();

const HOLD_MS = 3000;
const MOVE_TOLERANCE_PX = 24;

const tracker = createLongPressTracker(HOLD_MS, MOVE_TOLERANCE_PX, () => emit("trigger"));
</script>

<template>
  <div
    class="hotspot"
    aria-hidden="true"
    @pointerdown="tracker.onPointerDown"
    @pointermove="tracker.onPointerMove"
    @pointerup="tracker.onPointerUp"
    @pointercancel="tracker.onPointerCancel"
  ></div>
</template>

<style scoped>
.hotspot {
  position: absolute;
  left: 100%;
  top: -0.9rem;
  bottom: -0.9rem;
  width: 3.5rem;
  z-index: 50;
  background: transparent;
  touch-action: none;
}
</style>
