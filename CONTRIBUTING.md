# Contributing

Bug reports and pull requests are welcome. Several external contributions have
already landed, so this is not a formality.

## Running it

```
npm install
npm test          # no router required
npm run typecheck
npm run build
```

Tests run against sanitized fixtures captured from a real router. To refresh
them, or to run a read-only smoke test against your own:

```
KEENETIC_HOST=… KEENETIC_PASSWORD=… npm run capture:fixtures
KEENETIC_TEST_HOST=… KEENETIC_TEST_PASSWORD=… npm run smoke
```

A checkout reports its version as `0.0.0-dev`, because there is no version
written down anywhere in the sources. Put `KEENETIC_MCP_VERSION` in a `.env` at
the repository root to say otherwise; the same file can hold `KEENETIC_HOST`
and `KEENETIC_PASSWORD` so you do not have to export them. A real environment
variable always wins over that file, and an installed copy never reads one.

The setup wizard reads a password from the terminal, which no unit test can
reach: piped input takes a different code path entirely. That part is checked
with a script that drives a real pty, so it needs a terminal and cannot run in
CI:

```
KEENETIC_TEST_PASSWORD=… ./scripts/verify-wizard.exp
```

## Releasing

A release is a tag and nothing else. There is no version commit to write,
because there is no version in the repository to change: `package.json` carries
`0.0.0-dev`, the plugin manifests carry none at all, and the release workflow
stamps the tag into `package.json` immediately before publishing without
committing it.

```
git tag v0.2.2 && git push origin v0.2.2
```

The workflow refuses a tag that does not name a version, and a test refuses a
tree that has a version written into it, so the two can never disagree. The
plugins pin `keenetic-mcp@^0`, which tracks the major only and is meant to be
edited once, at 1.0.

A tag with a hyphen, such as `v0.4.0-beta.1`, is a prerelease: it goes to npm
under `next` instead of `latest`, so `npx -y keenetic-mcp@next` installs it and
nobody else gets it, and it stays out of the MCP Registry.

## The README demo

`docs/demo/demo.svg` is a composed Claude Code session, built from
`docs/demo/scene.py` with the renderer next to it. If a tool's name, arguments
or answer change, change the scene too, so the demo keeps showing what the
server really does:

```
python3 docs/demo/scene.py docs/demo/demo.cast
cd docs/demo && python3 make-demo.py demo.json demo.svg   # needs: pip install pyte
```

## The one thing that matters most

**Verify against the router, not against your model of it.**

Keenetic answers a wrong field name with `{}`, HTTP 200, no error, and nothing
changed. It is indistinguishable from success. Two real bugs here passed every
unit test and only surfaced against live hardware, because the tests asserted
what the author assumed the router does.

So: read every write back through whichever view actually exposes the field, and
say in the pull request which model and KeeneticOS version you checked it on.
`src/tools/write.ts` is the pattern. `docs/rci-api.md` collects the traps.

If a change cannot be verified without hardware you do not have, say so. That is
a normal answer here and better than a confident guess.

## Never commit real network data

A test scans the whole repository for anything shaped like a real MAC address, a
private IP or key material, and it will fail your build. It exists because those
have leaked here before, including from a fixture captured off a live router.

Device names and SSIDs have no detectable shape, so nothing catches those.
Read your own diff before pushing it.

## Style

Match the surrounding code. Comments explain why something is the way it is,
especially when it looks wrong: most of them are load-bearing and record a trap
that cost someone an afternoon.

Plain ASCII hyphens, no em dashes, anywhere.

Commit messages say what changed and why it had to change that way.

## Adding another vendor

Please open an issue first. The code is RCI-shaped throughout, and a vendor
boundary with one implementation behind it would be a guess. A separate
repository that borrows the tool shapes, the verified-write pattern and the
skills format is the cheaper start, and the parts worth sharing can be extracted
once there are two working servers to compare.
