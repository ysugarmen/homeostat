# Releasing

Every release pins one exact version everywhere: the packages, the plugin manifest, core's `VERSION` (which `homeostat init` writes into CI files), and each `homeostat@x.y.z` in the skills and docs. `packages/cli/test/versions.test.ts` fails if any of them drift or a floating range such as `homeostat@0` comes back.

## Cutting a release

```sh
node scripts/version.mjs 0.2.0
pnpm install
pnpm check
git commit -am "chore: release 0.2.0"
git tag v0.2.0
git push && git push --tags
```

The tag starts `.github/workflows/release.yml`, which:

1. checks that the tag matches the version, then runs the full check and `pnpm audit`
2. packs `@homeostat/core`, `@homeostat/mcp`, `@homeostat/dashboard` and `homeostat`; the published packages run the compiled `dist/`, because Node does not strip types inside `node_modules`
3. builds a CycloneDX SBOM from a clean install of those tarballs
4. publishes each one with `npm publish --provenance` through npm trusted publishing (OIDC), so no npm token is stored anywhere
5. creates a GitHub release with the tarballs and the SBOM attached

## One-time setup

1. **Make the repository public.** npm only issues provenance for packages built from public repositories.
2. **Reserve the names**: the `homeostat` package and the `@homeostat` scope on npm. Turn on 2FA for the npm and GitHub owner accounts.
3. **Add a trusted publisher** for each of the four packages on npmjs.com (package settings → Trusted publisher → GitHub Actions): repository `ysugarmen/homeostat`, workflow `release.yml`, environment `npm`. If npm will not add one before a package exists, publish the first version of that package by hand from the packed tarball (`npm publish <tgz> --access public`), then add the publisher and release through tags from then on.
4. **Create the `npm` environment** in the GitHub repository settings, with a required reviewer, so a pushed tag alone cannot publish.
5. **Install Renovate** on the repository. `renovate.json` waits three days before proposing a new version, and `pnpm-workspace.yaml` refuses to install anything newer than three days (`minimumReleaseAge`).

## Checking a release

- `npm view homeostat@<version> --json | jq .dist.attestations` shows the provenance attestation, and the npm package page shows a "Built and signed on GitHub Actions" badge.
- `npm audit signatures` in any project that installs it verifies the registry signatures and attestations.
