# Contributing

Bug reports and pull requests are welcome. Two external contributions have
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
