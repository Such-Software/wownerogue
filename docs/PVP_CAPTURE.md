# Deterministic PvP capture harness

`src/scripts/pvp-capture.js` produces a clean, reproducible multiplayer match for trailers, ads,
camera work, and gameplay review. It supports the built-in Escape Race, Last Alive, Score Attack,
and Co-op Escape rulesets. Each take runs the authoritative `MatchRoom` and `MatchEngine`, drives
deterministic bots over Socket.IO, and records the browser render kit with the locally installed
Playwright Chromium.

This is a development tool, not a production feature or an admin endpoint. The harness:

- starts a separate HTTP/Socket.IO process bound to `127.0.0.1` on an ephemeral port, and rejects
  any request whose `Host` header is not loopback;
- accepts no remote target URL, so it cannot attach to a running Wowngeon instance;
- creates one in-memory `free` match with zero entry fee, pot, house fee, and house fee percent,
  and re-checks that invariant at room creation, at match start, and after finalization;
- imports no application, database, wallet, queue, provider, or payout service. Its only game
  imports are `MatchRoom`, `MatchEngine`, and the ruleset registry;
- requires `NODE_ENV=development` or `NODE_ENV=test` plus the explicit
  `--confirm-local-free-only` flag;
- refuses to run when a payments, credits, payout, match-payout, crypto-race, mainnet-payout, or
  wallet-endpoint variable is enabled or configured;
- refuses inherited crypto, game-mode, difficulty, dungeon, monster, treasure, or network-tuning
  overrides, so a committed seed cannot silently mean different footage in another shell;
- serves only repository assets and forces the CDN renderer flag off, so the 3D renderer is
  unavailable here.

Setting an environment variable on a live service is therefore not enough to enable the harness.
Someone must deliberately start this separate loopback-only CLI with its confirmation flag. On a
staging machine, run it as its own development or test process; it never uses the staging app or
staging database.

## Record a video

From `src/`:

```bash
NODE_ENV=development npm run capture:pvp -- \
  --confirm-local-free-only \
  --ruleset race \
  --players 4 \
  --mode tiles \
  --output /tmp/wowngeon-pvp-capture.webm \
  --screenshot /tmp/wowngeon-pvp-final.png
```

`playwright-core` is a declared devDependency. The command uses its existing local Chromium and
FFmpeg bundle and never downloads a browser or a package. If that bundle is missing, the CLI stops
with a direct explanation. The deterministic control harness remains usable without a browser:

```bash
NODE_ENV=test npm run capture:pvp -- \
  --confirm-local-free-only \
  --no-video \
  --ticks 120 \
  --trace /tmp/wowngeon-pvp-trace.json
```

## Options

Run `npm run capture:pvp -- --help` for the same list at the terminal.

| Flag | Accepted values | Default |
|---|---|---|
| `--confirm-local-free-only` | required safety acknowledgement | none |
| `--seed HEX64` | exactly 64 hexadecimal characters | fixed curated seed |
| `--players N` | 2 through 8, within the ruleset's own limit | 4 |
| `--ticks N` | 1 through 2000 hard capture limit | 180 |
| `--tick-ms N` | 50 through 1000 real-time frame step | 180 |
| `--ruleset ID` | `race`, `last-alive`, `score-attack`, `coop-escape` | `race` |
| `--mode MODE` | `tiles`, `ascii`, `iso` | `tiles` |
| `--focus BOT_ID` | `bot-1` through `bot-N` for the configured bot count | `bot-1` |
| `--camera MODE` | `action` or `focus` | `action` |
| `--viewport WxH` | 640x360 through 3840x2160 | 1280x720 |
| `--output FILE.webm` | video destination | `wowngeon-pvp-capture.webm` in the temp dir |
| `--trace FILE.json` | trace destination | the output path with a `.json` extension |
| `--screenshot FILE.png` | optional final-frame screenshot | none |
| `--headed` | show the capture browser while recording | off |
| `--no-video` | run bot control and write only the trace | off |

`--ruleset` selects gameplay and is independent of `--mode`, which selects an offline renderer.
Network-loaded renderers are rejected. All four capture rulesets accept 2 through 8 bots here: the
harness raises Score Attack's own minimum of 1 to 2, because a capture needs a field.

## Camera and presentation

The spectator camera anchors on `--focus`, default `bot-1`. In `--camera action`, deaths, treasure
pickups, and exits briefly take focus before the camera returns to that anchor; `--camera focus`
disables those cuts.

In the tiled and ASCII renderers, zoom tracks the action cluster around the anchor: it fits the
closest three players in a portrait composition or four in landscape, then pushes in or pulls back
as that cluster changes. The isometric renderer uses a stable, cover-clamped zoom because its
diagonal projection needs different fit geometry. Every zoom is clamped to at least stage cover, so
the playfield fills the frame at both 1080x1920 and 1920x1080. A short renderer-space movement lead
shows where the focused player is heading, and an upper-frame bias keeps portrait action clear of
the result card in the lower third. At match end, a competitive camera returns to the authoritative
winner for a restrained push-in rather than covering the playfield with a centered modal.

The capture-only grade lowers brightness slightly while restoring contrast and saturation, which
reduces torch and character washout. A screen-space roster keeps all 2 to 8 player names and states
legible without stacking labels on one dungeon tile; world-space player labels are suppressed for
the same reason. On a competitive final frame the winner row stays highlighted while other rows
recede; cooperative rulesets have no winner row, so team rows remain equally visible. The footer
shows a short deterministic replay ID derived from the seed hash. It is an identifier, not a
signature or an independent verification claim. The complete seed and every state hash live in the
JSON trace.

`FREE EXHIBITION • NO CASH PRIZES` describes this isolated footage only. It is not a substitute for
campaign review or campaign-level disclosures. Paid-credit, no-cash-out, no-prize, age,
jurisdiction, certification, and platform-required disclosures sit outside the harness output and
must be added and reviewed for each operated product and advertising channel. See
[PRODUCTION_DISCLOSURES.md](PRODUCTION_DISCLOSURES.md).

## Capture each built-in mode

Use the same safety acknowledgement for every take:

| `--ruleset` | Bot objective | Result card |
|---|---|---|
| `race` | Treasure route plus staggered sprints to the exit | Competitive race winner |
| `last-alive` | Seek and strike the nearest active rival | Last survivor |
| `score-attack` | Build progress and treasure score, then bank an exit | Top score and points |
| `coop-escape` | Staggered team pathing to the exit | Team escape count, never a competitive winner |

For example, record a Last Alive take:

```bash
NODE_ENV=development npm run capture:pvp -- \
  --confirm-local-free-only \
  --ruleset last-alive \
  --players 6 \
  --camera action \
  --viewport 1920x1080 \
  --output /tmp/wowngeon-last-alive-ad.webm \
  --trace /tmp/wowngeon-last-alive-ad.json
```

Swap only `--ruleset` and the output names to capture Score Attack or Co-op Escape. Headlines,
active-player terminology, roster states, footer copy, and final results all follow the selected
ruleset. Score Attack normally runs to its deadline; once every bot is dead or has banked an exit
there are no legal inputs left, so this isolated exhibition closes its local deadline immediately
instead of recording a long motionless tail. The authoritative scoring and finalization path is
unchanged.

For a short 9:16 ad take, the default seed with six racers produces a complete arc in roughly nine
seconds and `bot-4` wins. Follow that bot so the finish stays legible on a phone screen:

```bash
NODE_ENV=development npm run capture:pvp -- \
  --confirm-local-free-only \
  --ruleset race \
  --players 6 \
  --focus bot-4 \
  --viewport 1080x1920 \
  --output /tmp/wowngeon-pvp-ad-vertical.webm \
  --screenshot /tmp/wowngeon-pvp-ad-vertical.png
```

The same seed supports the eight-player maximum for a crowded 16:9 arena take:

```bash
NODE_ENV=development npm run capture:pvp -- \
  --confirm-local-free-only \
  --ruleset race \
  --players 8 \
  --focus bot-4 \
  --viewport 1920x1080 \
  --output /tmp/wowngeon-pvp-ad-8player.webm \
  --screenshot /tmp/wowngeon-pvp-ad-8player.png \
  --trace /tmp/wowngeon-pvp-ad-8player.json
```

The emitted JSON trace is the authoritative replay record. The video is marketing footage; it
creates no leaderboard row, credit, payment, ticket, or payout.

## Reproducibility

The default seed is fixed. A custom seed must be exactly 64 hexadecimal characters:

```bash
NODE_ENV=development npm run capture:pvp -- \
  --confirm-local-free-only \
  --seed beb270f3806a97e9ef73c8f83a6eae19a92f90ab38af9ad8b365cb74c41b2702
```

Each bot receives a numbered tick and the same authoritative state over Socket.IO. The server waits
for every bot response, queues inputs in stable bot order, and lets the engine resolve them with its
committed per-tick action priority before advancing. Bot goals are ruleset-aware and contain no
randomness beyond the committed dungeon seed; bots after the first move on staggered cadences so a
crowded field stays readable and deterministic head-on swaps cannot loop forever. Missing or
malformed input aborts the run instead of silently changing the replay.

Every run writes a versioned JSON trace, owner-readable only, beside the video. It records the
ruleset, presentation metadata, seed and seed hash, exact per-tick inputs, engine events, camera
configuration, per-tick state hashes, placements, scores, the mode-correct outcome, and the fact
that gameplay environment overrides were refused.

To confirm that browser recording does not perturb the simulation, run the same command twice, once
with `--no-video`, and compare `result.finalStateHash` in the two traces. Encoded WebM bytes can
differ across Chromium and FFmpeg versions or with host timing, so compare replays with the JSON
state hashes rather than a video checksum.
