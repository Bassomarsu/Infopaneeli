import { onUnmounted, ref, type Ref } from "vue";

/**
 * Akun varaustaso yläpalkkiin, kun laitteessa sellainen on.
 *
 * Battery Status API on Chromium-selaimissa (Edge, Chrome) muttei Firefoxissa
 * eikä Safarissa, ja se vaatii turvallisen kontekstin. Kioskiselain avaa sivun
 * osoitteesta `http://localhost`, joka lasketaan turvalliseksi, joten
 * seinänäytöllä tämä toimii. Puhelimessa lähiverkon IP-osoitteen kautta
 * rajapintaa ei ole — silloin `supported` jää epätodeksi eikä indikaattoria
 * näytetä lainkaan. Se on tarkoitus: puhelimen oma akku ei kuulu tähän
 * näyttöön.
 */
interface BatteryManagerLike extends EventTarget {
  charging: boolean;
  /** 0–1. */
  level: number;
}

interface NavigatorWithBattery {
  getBattery?: () => Promise<BatteryManagerLike>;
}

export interface BatteryState {
  supported: Ref<boolean>;
  /** 0–100, pyöristettynä. Null kunnes ensimmäinen lukema on saatu. */
  percent: Ref<number | null>;
  charging: Ref<boolean>;
}

export function useBattery(): BatteryState {
  const supported = ref(false);
  const percent = ref<number | null>(null);
  const charging = ref(false);

  let manager: BatteryManagerLike | null = null;
  let disposed = false;

  function read(): void {
    if (!manager) return;
    percent.value = Math.round(manager.level * 100);
    charging.value = manager.charging;
  }

  const getBattery = (navigator as Navigator & NavigatorWithBattery).getBattery;
  if (typeof getBattery === "function") {
    void getBattery
      .call(navigator)
      .then((battery) => {
        // Komponentti on voitu purkaa ennen kuin promise ehti ratketa.
        if (disposed) return;
        manager = battery;
        supported.value = true;
        read();
        // Tapahtumiin kuunteleminen on ainoa tapa pysyä ajan tasalla: näyttö
        // on auki päiviä, eikä arvoa saa jäädä kyselemään ajastimella.
        battery.addEventListener("levelchange", read);
        battery.addEventListener("chargingchange", read);
      })
      .catch(() => {
        // Rajapinta voi olla olemassa mutta estetty (esim. käytäntö tai
        // turvallisuuskonteksti). Indikaattori jää silloin pois — ei virhettä
        // ruudulle, koska tämä on koriste eikä toiminnallisuutta.
        supported.value = false;
      });
  }

  onUnmounted(() => {
    disposed = true;
    if (manager) {
      manager.removeEventListener("levelchange", read);
      manager.removeEventListener("chargingchange", read);
      manager = null;
    }
  });

  return { supported, percent, charging };
}
