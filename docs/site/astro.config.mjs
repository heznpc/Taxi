import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://heznpc.github.io",
  base: "/Taxi/docs",
  outDir: "./dist",
  integrations: [
    starlight({
      title: "Taxi Docs",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/heznpc/Taxi",
        },
      ],
      defaultLocale: "en",
      locales: {
        en: { label: "English", lang: "en" },
        ko: { label: "한국어", lang: "ko" },
      },
      sidebar: [
        { label: "Getting Started", items: [{ autogenerate: { directory: "getting-started" } }] },
        { label: "Modules", items: [{ autogenerate: { directory: "modules" } }] },
        { label: "Architecture", items: [{ autogenerate: { directory: "architecture" } }] },
        { label: "Contributing", items: [{ autogenerate: { directory: "contributing" } }] },
      ],
    }),
  ],
});
