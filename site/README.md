# Homeostat website

The landing page and the guides from [`docs/`](../docs), built with [Astro](https://astro.build) and
[Starlight](https://starlight.astro.build). It is its own small project: never published to npm and not
part of the CLI's workspace.

- `src/pages/index.astro`: the landing page; `src/components/Loop.astro` is the hero.
- `scripts/sync-docs.mjs` copies `../docs` into `src/content/docs/docs/` at every build (that folder is
  generated and ignored): each page's first heading becomes its title, and links become site routes.
  Edit the guides in `docs/`, never here.
- The install command shows the version in `packages/core/src/version.ts`.
- Fonts are self-hosted (`public/fonts`); the site loads nothing from third parties.

```sh
cd site
pnpm install
pnpm dev      # http://localhost:4321
pnpm build    # static output in dist/
```

## Deploying on Cloudflare Workers

`wrangler.jsonc` serves `dist/` as static assets. In the Cloudflare dashboard (Workers & Pages >
Create > Import a repository), pick the repository and set:

| Setting | Value |
| --- | --- |
| Project name | `homeostat` |
| Build command | `cd site && pnpm install --frozen-lockfile && pnpm build` |
| Deploy command | `cd site && npx wrangler deploy` |

The site is then at `homeostat.<your-subdomain>.workers.dev`; add a custom domain under the Worker's
Settings > Domains & Routes.

## Or on Cloudflare Pages

Connect the repository once in the Cloudflare dashboard (Workers & Pages > Create > Pages > Connect to
Git), with:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root directory | `site` |
| Build command | `pnpm install --frozen-lockfile && pnpm build` |
| Build output directory | `dist` |
| Environment variable | `NODE_VERSION` = `22` |

Every push to `main` then rebuilds the site, and pull requests get preview URLs. No token is stored in
the repository. If the project is not named `homeostat`, update `site` in `astro.config.mjs` to its
`*.pages.dev` address or your domain.
