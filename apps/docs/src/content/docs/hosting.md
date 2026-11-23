---
title: Hosting this site
description: How to build, verify and deploy the Lumen Timeline documentation site to Cloudflare Workers at lumen-timeline.studiocyf.app, or host it on your own domain.
---

This documentation site is an [Astro Starlight](https://starlight.astro.build) project in `apps/docs`. It deploys as static assets on Cloudflare Workers at `https://lumen-timeline.studiocyf.app`.

| Site          | Address                                | Source      | Workflow                     |
| ------------- | -------------------------------------- | ----------- | ---------------------------- |
| Documentation | `https://lumen-timeline.studiocyf.app` | `apps/docs` | `.github/workflows/docs.yml` |

## Build

```sh
npm run build            # builds the @lumen-timeline/* workspace packages
npm run docs:dev         # http://localhost:4321
npm run docs:build       # writes apps/docs/dist
npm run check:docs       # builds, type-checks and runs unit + browser tests
```

Before `astro dev` or `astro build`, `apps/docs/scripts/generate.ts` generates the pages whose source of truth lives elsewhere in the repository so the site cannot drift from it:

| Pages        | Source                                                                                                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture | `docs/design.md`, `docs/core-architecture.md`, `ROADMAP.md`                                                                                                                                                       |
| Guides       | `docs/headless-editing.md`, `docs/selective-history.md`, `docs/playback-read-api.md`, `docs/media-transports.md`, `docs/incremental-playback.md`, `docs/vanilla-timeline.md`, `docs/waveforms.md`, `docs/sync.md` |
| Frameworks   | `docs/frameworks.md`                                                                                                                                                                                              |
| Packages     | `packages/*/package.json`, `packages/*/api/index.d.ts`                                                                                                                                                            |
| Benchmarks   | `docs/clock-and-wasm.md`, `docs/measurements/*.json`                                                                                                                                                              |

The build also produces `/llms.txt`, `/llms-full.txt`, and `/llms-small.txt`, along with a plain Markdown copy of every English page at the same path with `.md` replacing the trailing slash (for example, `/guides/editing.md` and `/index.md`).

Interactive examples (`studio` and `sync`) run the real workspace packages in isolated frames under `/demo/<name>/`. After `astro build`, `apps/docs/scripts/demo-frames.ts` adds `<link rel="modulepreload">` tags for every imported module and inlines each demo page into its embedding iframe via `srcdoc`, removing the extra round trip on first load.

## Deploy to Cloudflare Workers

`apps/docs/wrangler.jsonc` deploys `apps/docs/dist` as static assets. Because no Worker script runs, requests do not count toward the free plan's daily Worker invocation limit.

To deploy from your machine, build first, install the pinned Wrangler in `tools/deploy`, and run the deploy script. Wrangler uses the account you logged in to with `wrangler login`.

```sh
npm run build && npm run check:docs
npm ci --prefix tools/deploy --ignore-scripts
npm run deploy:docs
```

The workflow in `.github/workflows/docs.yml` does nothing until you configure it:

1. Create a Cloudflare API token as described in [The API token](#the-api-token).
2. In the repository settings, create an environment named `cloudflare`. Under its deployment branches, allow only `main`. Add the token as the environment secret `CLOUDFLARE_API_TOKEN` and your account ID as the environment secret `CLOUDFLARE_ACCOUNT_ID`. Use environment secrets, not repository secrets, so only runs on `main` can read them.
3. Set the repository variable `DOCS_SITE` to `https://lumen-timeline.studiocyf.app`. Canonical links, the sitemap and `llms.txt` are built from this value.
4. Run the **Docs** workflow manually from the Actions tab (`workflow_dispatch`).
5. To deploy automatically on every push to `main`, set the repository variable `DOCS_DEPLOY` to `true`.

### The API token

Cloudflare cannot scope a token to a single Worker. Give the token only the two permissions deployment needs:

| Scope   | Permission            | Resources                                              |
| ------- | --------------------- | ------------------------------------------------------ |
| Account | Workers Scripts: Edit | Only the account that holds the site                   |
| Zone    | Workers Routes: Edit  | Only the zone of the site's hostname (`studiocyf.app`) |

The "Edit Cloudflare Workers" template also works, but adds KV, R2 and Pages permissions that this deployment never uses. Set an expiry date and rotate the token before it expires.

### How the workflow protects the token

The repository is public, so `.github/workflows/docs.yml` assumes anyone can read it and open a pull request:

- The workflow never runs on pull requests, and GitHub never exposes environment secrets to fork pull requests.
- The secrets live in the `cloudflare` environment, restricted to `main`. Changes on other branches cannot read them.
- Building and deploying are separate jobs. The `build` job runs application and dependency code with no secrets. The `deploy` job holds the Cloudflare credentials and runs only Wrangler on the uploaded `docs-site` artifact.
- Wrangler is pinned in `tools/deploy/package.json` and `tools/deploy/package-lock.json` by exact version and SHA-512 integrity hash. The `deploy` job installs it with `npm ci --prefix tools/deploy --ignore-scripts` and `cache: false`, running zero package lifecycle scripts and restoring no cache written by the build job.
- Every GitHub Action in `.github/workflows/docs.yml` is pinned to a full commit SHA. `.github/dependabot.yml` proposes updated commits once a month after a 14-day release cooldown.
- The account ID is stored as a secret so GitHub masks it in logs; `apps/docs/wrangler.jsonc` does not contain `account_id`.

Never commit `.wrangler/` or `.dev.vars`: the first records local Cloudflare account state and the second holds local secrets. Both are in `.gitignore`.

## Use a domain of your own

`apps/docs/wrangler.jsonc` binds the site to `lumen-timeline.studiocyf.app` as a Workers Custom Domain. On deploy, Cloudflare ensures the DNS record and TLS certificate exist.

- The apex zone (`studiocyf.app`) must belong to the same Cloudflare account, and `lumen-timeline.studiocyf.app` must not already have a conflicting CNAME record. Do not create the DNS record manually.
- `workers_dev` and `preview_urls` are both `false`, so the site is published only at its custom domain and never on a `*.workers.dev` subdomain.

In a fork, replace `pattern` in `apps/docs/wrangler.jsonc` with a hostname in your own Cloudflare zone and set `DOCS_SITE` to match. To publish to `*.workers.dev` instead, remove `routes` and set `"workers_dev": true`.

## GitHub Pages instead

You can also serve `apps/docs/dist` on GitHub Pages without Cloudflare DNS. Build with `DOCS_SITE=https://<your-host> npm run docs:build`, upload `apps/docs/dist` with `actions/upload-pages-artifact`, and deploy with `actions/deploy-pages`. Note that GitHub Pages ignores `apps/docs/public/_headers`, so `/*.md` and `/llms.txt` use GitHub's default content types and hashed assets under `/_astro/*` do not receive immutable cache headers.
