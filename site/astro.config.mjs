import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

const REPO = "https://github.com/ysugarmen/homeostat";
// The same site is published twice: at the root of the Cloudflare worker, and under /homeostat on
// GitHub Pages (a second network, for when Cloudflare's addresses are blocked). The Pages build sets
// SITE_URL and SITE_BASE.
const SITE = process.env.SITE_URL ?? "https://homeostat-site.sugaryoni3.workers.dev";
const BASE = process.env.SITE_BASE ?? "/";
const OG = `${SITE}${BASE.replace(/\/$/, "")}/og.png`;

export default defineConfig({
  site: SITE,
  base: BASE,
  integrations: [
    starlight({
      // Shared doc links get the same preview card as the landing page.
      head: [
        { tag: "meta", attrs: { property: "og:image", content: OG } },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        { tag: "meta", attrs: { name: "twitter:image", content: OG } },
      ],
      title: "Homeostat",
      description: "A team knowledge base for coding agents that keeps itself current. Runs on your repos, CI and tokens.",
      logo: { src: "./src/assets/mark.svg", replacesTitle: false },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: REPO }],
      editLink: { baseUrl: `${REPO}/edit/main/docs/` },
      customCss: ["./src/styles/fonts.css", "./src/styles/docs.css"],
      sidebar: [
        {
          label: "Start",
          items: [
            { label: "Overview", link: "/docs/" },
            { label: "Quickstart", link: "/docs/guide/quickstart/" },
            { label: "Guided setup", link: "/docs/guide/setup/" },
            { label: "How a team uses it", link: "/docs/guide/team/" },
            { label: "Setup", link: "/docs/guide/setup/" },
            { label: "A first base", link: "/docs/guide/bootstrap/" },
            { label: "Moving to 0.2", link: "/docs/guide/migrating/" },
          ],
        },
        {
          label: "Guide",
          items: [
            { label: "Rules and documents", link: "/docs/guide/entries/" },
            { label: "Configuration", link: "/docs/guide/config/" },
            { label: "The agents", link: "/docs/guide/agents/" },
            { label: "Using it from your tools", link: "/docs/guide/clients/" },
            { label: "Dashboard", link: "/docs/guide/dashboard/" },
            { label: "Measuring selection", link: "/docs/guide/eval/" },
            { label: "Before and after", link: "/docs/guide/bench/" },
          ],
        },
        {
          label: "Trust",
          items: [
            { label: "Data handling", link: "/docs/data-handling/" },
            { label: "Security model", link: "/docs/security/" },
            { label: "Runtimes", link: "/docs/runtimes/" },
            { label: "Releasing", link: "/docs/releasing/" },
          ],
        },
        {
          label: "Project",
          collapsed: true,
          items: [
            { label: "Architecture", link: "/docs/architecture/" },
            { label: "End-to-end demo", link: "/docs/demo/" },
          ],
        },
      ],
    }),
  ],
});
