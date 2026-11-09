# Botons site

The static marketing site uses the shared Boton and brand renderers. Edit page copy in `content.ts`.

- Build: `npm run site:build` (Node 24+, no dependencies needed).
- Preview: `node site/build.ts --serve` (optionally add a port).
- Regenerate the social image: `npm run site:og` (requires the development dependencies and Playwright Chromium; set `CHROMIUM_PATH` to use another Chromium executable).

For GitHub Pages, choose Settings → Pages → Source: GitHub Actions. The workflow runs only on the public repository and takes `SITE_URL` from the Pages base URL automatically. Set the custom domain `getbotons.com` in Pages later and configure its DNS.

The Pages workflow runs on pushes that change `site/` or the workflow itself; after changes to `shared/brand.ts`, `shared/boton.ts`, or `shared/look.ts`, run it by hand (Actions → Pages → Run workflow) and regenerate `og.png` with `npm run site:og` if the crew changed.
