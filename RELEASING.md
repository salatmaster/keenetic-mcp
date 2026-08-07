# Releasing

Releases publish through **npm trusted publishing**, so there is no `NPM_TOKEN`
in this repository and nothing to rotate. The workflow exchanges a short-lived
OIDC token for publish rights on each run.

That matters because npm now caps write-enabled granular tokens at 90 days, with
a 7-day default, and classic tokens were revoked entirely in November 2025. A
stored token would need rotating four times a year; this needs none.

## One-time bootstrap

npm will not let you configure a trusted publisher for a package that does not
exist yet, so the first version has to be published by hand. This needs no token
either: a local `npm publish` authenticates interactively with 2FA.

```bash
npm login                 # browser, with 2FA
npm run typecheck && npm test && npm run build
npm publish --access public
```

Then on <https://www.npmjs.com/package/keenetic-mcp/access>, add a trusted
publisher:

| Field | Value |
|---|---|
| Provider | GitHub Actions |
| Organization or user | `salatmaster` |
| Repository | `keenetic-mcp` |
| Workflow filename | `release.yml` |
| Environment | leave empty |

## Every release after that

```bash
# 1. Bump the version. The workflow refuses a tag that disagrees with it.
npm version patch      # or minor, or major

# 2. Push the commit and the tag.
git push --follow-tags
```

The tag push triggers `.github/workflows/release.yml`, which typechecks, tests,
builds, verifies the tag matches `package.json`, and publishes with provenance.

## If a publish fails with a 404 or ENEEDAUTH

npm reports trusted-publishing misconfiguration as a misleading 404 or
`ENEEDAUTH`. Check, in this order:

1. The trusted publisher on npmjs.com names this exact repository **and**
   workflow filename.
2. The job has `id-token: write`.
3. `actions/setup-node` has **no** `registry-url`. It writes an `.npmrc` that
   conflicts with OIDC.
4. The npm CLI is recent enough; the workflow upgrades it explicitly for this
   reason.

## Checklist before tagging

- `npm test` green
- `npm run typecheck` clean
- `npm audit` clean
- `README.md` install instructions still match reality
- the plugin version in `plugins/keenetic/.claude-plugin/plugin.json` and
  `.claude-plugin/marketplace.json` matches `package.json`
