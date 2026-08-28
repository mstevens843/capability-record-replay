# Spike code — terminal surface

Working scratch code from `docs/design/spike-terminal-surface.md`. **Not part of the build.** It is
kept because every number and grid dump in that document came out of these files, and `/private/tmp`
does not survive a reboot.

Reproduce (no repo install needed; `@xterm/headless` is the only dependency):

```bash
mkdir -p /tmp/spike && cd /tmp/spike && npm init -y >/dev/null && npm i @xterm/headless
cp <this dir>/*.mjs .
node run-pipe.mjs        # drive it, dump grids per keystroke, write ./grids.json
                         # (the frozen fixtures test-detect.mjs asserts over)
node run-detect.mjs      # grid -> typed UINodes
node test-detect.mjs     # 31 assertions over frozen grids, no child process
node tear.mjs            # shows quiescence is not a sound readiness signal
node bench.mjs           # needs ./paint.bin; see the doc
TENANT=summit node run-tenant.mjs   # second tenant variant
```

`teller.mjs` is the 80x24 green-screen fixture. All data in it is obviously synthetic.
