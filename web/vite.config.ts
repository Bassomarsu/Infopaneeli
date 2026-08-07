import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: "dist",
    // Ei tyhjennä käytännössä mitään tässä Viten versiossa — todennettu
    // merkkitiedostolla, joka säilyi käännöksen yli. Kansio tyhjennetään
    // siksi erikseen `build`-skriptissä. Ilman sitä jokainen käännös jättää
    // jälkeensä uuden tiedoston: seinänäytöllä ne kertyvät hiljalleen, ja
    // vanha tiedosto ehti jo kerran johtaa harhaan käännöstä tarkistettaessa.
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // During frontend development the API still comes from the real backend.
    proxy: {
      "/api": "http://localhost:4173",
    },
  },
});
