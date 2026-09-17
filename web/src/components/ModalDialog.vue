<script setup lang="ts">
/**
 * Modaalikehys kaikille dialogeille: natiivi `<dialog showModal>`, joka
 * piirretään selaimen TOP LAYERiin.
 *
 * KEHYS ON NATIIVI `<dialog>`, EI OMA `position: fixed` -OVERLAY — ÄLÄ
 * PALAUTA OVERLAYTÄ. Syitä on kaksi, ja molemmat on mitattu:
 *
 * 1. YÖTILA + VIERITYS. `.app.night { filter: brightness(...) }` (style.css)
 *    tekee `.app`ista sijoitussäiliön myös `position: fixed`ille. Silloin
 *    overlay asemoituu dokumenttiin eikä näkymään, ja mitä kauemmas sivu on
 *    vieritetty, sitä kauemmas dialogi liukuu. Mitattu kehyksen yläreunan
 *    poikkeama (oikea arvo 0), yö + vieritystila + sivu pohjaan vieritettynä:
 *      390 px −1478 · 800 px −2237 · 901 px −511 · 1280 px −711 ·
 *      1920 px −991 · 2736 px −1735
 *    Osassa tapauksista selain vieritti itse dialogiin (jolloin poikkeama
 *    luki 0 mutta paneeli oli silti osittain ruudun ulkopuolella) EIKÄ
 *    palauttanut vieritystä sulkemisen jälkeen — kioskiruutu jäi väärään
 *    kohtaan.
 *
 * 2. TARTTUVA YLÄPALKKI. Overlayn `z-index: 60` oli sama kuin App.vuen
 *    `.topbar__meta`illa, joten vieritystilassa yläpalkki maalautui dialogin
 *    PÄÄLLE: "Sulje"-painikkeen kohdalla kosketuksen otti vastaan yläpalkki
 *    (mitattu 390–1920 px, sekä yöllä ETTÄ päivällä), ja pahimmillaan
 *    kalenteria sulkeva painallus avasi hälytyspaneelin. Top layer on jokaisen
 *    z-indexin yläpuolella, joten sitä ei voi peittää.
 *
 * Top layerissa sekä sijainti, kirkkaus että pinojärjestys tulevat näkymästä
 * eivätkä `.app`ista. Kirkkaus on siksi annettava erikseen, ks. `dim`.
 */
import { onMounted, onBeforeUnmount, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    label: string;
    /**
     * Himmeneekö dialogi yötilan mukana.
     *
     * Top layer ei peri `.app.night`in suodatinta, joten himmennys on
     * annettava eksplisiittisesti — ja se on sisältökohtainen valinta, ei
     * yhtenäistettävä yksityiskohta:
     *  - PASSIIVINEN TIETO himmenee (kalenteri, tuntisää, viesti). Ne ovat
     *    samaa yöllä katsottavaa pintaa kuin kortit niiden takana, ja
     *    himmentämättöminä ne olisivat pimeässä keittiössä ruudun kirkkain
     *    laikku — juuri se minkä yötilan on määrä poistaa.
     *  - TOIMINTAKEHOTTEET JA SÄÄTÖNÄKYMÄT eivät himmene (poistumisdialogi,
     *    PIN, asetukset, hälytysten hallinta, hälytysilmoitus). Niissä
     *    syötetään koodi tai kellonaika, ja brightness(0.42) vie pienen
     *    tekstin ja kenttien rajat lukukelvottomiksi. Ne ovat myös näkyvissä
     *    vain sen hetken kun joku seisoo näytön edessä.
     */
    dim?: boolean;
    /**
     * Saako dialogin sulkea taustaa painamalla tai Escapella. Epätosi vain
     * silloin kun sulkemiseen on pakko olla oma painike (hälytysilmoitus:
     * ääni jatkuu kunnes se kuitataan).
     */
    dismissible?: boolean;
  }>(),
  { dim: false, dismissible: true },
);

/**
 * `reason` erottaa Escapen taustan painalluksesta. CalendarMonthDialog
 * tarvitsee eron: Escape palaa päivänäkymästä kuukauteen, taustan painallus
 * sulkee koko dialogin. Muut jättävät argumentin huomiotta.
 */
const emit = defineEmits<{ close: [reason: 'cancel' | 'backdrop'] }>();

const dialog = ref<HTMLDialogElement | null>(null);
let previousOverflow = '';
onMounted(() => {
  previousOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = 'hidden';
  dialog.value?.showModal();
});
onBeforeUnmount(() => {
  dialog.value?.close();
  document.documentElement.style.overflow = previousOverflow;
});
</script>
<template>
  <dialog
    ref="dialog"
    class="modal"
    :class="{ 'modal--dim': dim }"
    :aria-label="label"
    @cancel.prevent="props.dismissible && emit('close', 'cancel')"
    @click.self="props.dismissible && emit('close', 'backdrop')"
  >
    <slot />
  </dialog>
</template>
<style scoped>
.modal { border: 0; padding: 1.5rem; margin: 0; inset: 0; width: 100%; height: 100dvh; max-width: none; max-height: none; box-sizing: border-box; color: var(--text); background: transparent; transition: filter 4s ease; }
.modal[open] { display: flex; align-items: center; justify-content: center; }
.modal::backdrop { background: rgba(4, 6, 10, .78); backdrop-filter: blur(6px); }

/*
 * Yöhimmennys uudestaan tässä: top layer EI ole `.app.night`in suodattimen
 * alainen (juuri siksi tämä kehys on olemassa, ks. yllä). Valitsin toimii
 * silti, koska `<dialog>` on yhä `.app`:n JÄLKELÄINEN DOM-puussa — vain
 * maalaus siirtyy top layeriin, ei elementin paikka puussa.
 *
 * LUKU ON SAMA kuin style.css:n `.app.night` eikä sitä saa erkaannuttaa:
 * himmennetyn dialogin ja sen takana olevan ruudun on oltava samalla
 * kirkkaudella, muuten dialogi erottuu laikkuna. web/test/modal-dialog-dim.ts
 * lukee molemmat tiedostot ja kaatuu jos arvot eroavat.
 */
.app.night .modal--dim { filter: brightness(0.42) saturate(0.85); }

@media (max-width: 600px) { .modal { padding: .6rem; } }
</style>
