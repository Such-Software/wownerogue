# Deterministic PvP capture harness

`src/scripts/pvp-capture.js` creates a clean, reproducible multiplayer match for trailers, ads,
camera work, and gameplay review. It supports the built-in Escape Race, Last Alive, Score Attack,
and Co-op Escape rulesets. Each take uses the authoritative `MatchRoom` and `MatchEngine`, drives
deterministic bots through the installed Socket.IO client, and records the existing browser render
kit with the installed Playwright Chromium.

This is intentionally not a production feature or an admin endpoint. The harness:

- starts a separate HTTP/Socket.IO process bound to `127.0.0.1` on an ephemeral port;
- accepts no remote target URL and cannot attach to a normal Wowngeon instance;
- creates one in-memory `free` match with zero entry fee, pot, house fee, or payout;
- imports no application, database, wallet, queue, provider, or payout service;
- requires `NODE_ENV=development` or `NODE_ENV=test` and the explicit
  `--confirm-local-free-only` flag;
- refuses to run when a payment, credits, payout, crypto-race, mainnet-payout, or wallet endpoint
  is enabled/configured; and
- refuses inherited crypto, game-mode, difficulty, dungeon, monster, treasure, or network-tuning
  overrides so a committed seed cannot silently mean different footage in another shell; and
- loads only repository assets. CDN/3D renderers are unavailable in this tool.

Those guards make setting an environment variable in the live service insufficient to enable the
harness. Someone must deliberately start this separate loopback-only CLI with its confirmation
flag. On a staging machine, run it as a separate development/test process; it never uses the
staging app or staging database.

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

The repository already declares `playwright-core`; the command uses its existing local Chromium
and FFmpeg bundle. It never downloads a browser or package. If that browser bundle is missing, the
CLI fails with a direct explanation. The deterministic control harness remains usable without a
browser:

```bash
NODE_ENV=test npm run capture:pvp -- \
  --confirm-local-free-only \
  --no-video \
  --ticks 120 \
  --trace /tmp/wowngeon-pvp-trace.json
```

Run `npm run capture:pvp -- --help` for every option. `--ruleset` accepts `race`, `last-alive`,
`score-attack`, or `coop-escape`; this is separate from `--mode`, whose offline renderer choices
are `tiles`, `ascii`, and `iso`. Every ruleset accepts 2–8 bots in this harness.

The default 1280×720 spectator camera anchors on `bot-1`; choose another player with `--focus
bot-N`. In the default `--camera action` mode, deaths, treasure pickups, and exits temporarily take
focus before the camera returns to that anchor. `--camera focus` disables those cuts. Camera zoom
in the tiled and ASCII renderers adjusts to the nearest action cluster around the anchor: it keeps
the closest three players in a portrait composition or four in landscape, then pushes in or pulls
back as that cluster changes. The isometric renderer uses a stable, cover-clamped zoom because its
diagonal projection needs different fit geometry. A short renderer-space movement lead shows where
the focused player is heading, while an upper-frame bias keeps portrait action clear of the
result lower third. The tested 1080×1920 and 1920×1080 tiled frames fill the stage. At match end, a
competitive camera returns to the authoritative winner for a restrained push-in instead of hiding
the playfield behind a centered modal.

The capture-only grade slightly lowers brightness while restoring contrast and saturation, which
reduces torch and character washout. A separate screen-space roster
keeps all 2–8 player names and states legible without stacking labels on one dungeon tile; the
winner remains highlighted while other rows recede on a competitive final frame, while cooperative
team rows remain equally visible. The footer displays a short deterministic replay ID, not a
signature or independent verification claim. The complete seed and every state hash remain in the
JSON trace.

`FREE EXHIBITION • NO CASH PRIZES` describes this isolated footage only. It is not a substitute for
campaign review or campaign-level disclosures. Paid-credit, no-cash-out/no-prize, age, jurisdiction,
certification, and platform-required disclosures remain outside the harness output and must be
added and reviewed for each operated product and advertising channel.

## Capture each built-in mode

Use the same safety acknowledgement for every take:

| `--ruleset` | Bot objective | Result card |
|---|---|---|
| `race` | Treasure route plus staggered sprints to the exit | Competitive race winner |
| `last-alive` | Seek and strike the nearest active rival | Last survivor |
| `score-attack` | Build progress/treasure score, then bank an exit | Top score and points |
| `coop-escape` | Staggered team pathing to the exit | Team escape count, never a fake competitive winner |

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

Swap only `--ruleset` and output names to capture Score Attack or Co-op Escape. Headlines, active
player terminology, roster states, footer copy, and final results all follow the selected ruleset.
Score Attack closes the local exhibition deadline as soon as every bot has died or banked an exit,
avoiding a motionless tail without changing the authoritative scoring/finalization path.

For a short 9:16 ad take, the curated seed produces a complete six-racer arc in about nine seconds.
Follow the eventual winner so the finish remains legible on a phone screen:

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

Use the emitted JSON trace as the authoritative replay record. The video is marketing footage; it
does not create a leaderboard row, credit, payment, ticket, or payout.

For a crowded 16:9 arena take, the same seed supports the built-in eight-player maximum:

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

The recorded eight-player proof and its no-video control both ended with `bot-4` at tick 49 and
the same final state hash. This checks that browser recording does not alter the authoritative race.

## Reproducibility

The default seed is fixed. A custom seed must be exactly 64 hexadecimal characters:

```bash
NODE_ENV=development npm run capture:pvp -- \
  --confirm-local-free-only \
  --seed beb270f3806a97e9ef73c8f83a6eae19a92f90ab38af9ad8b365cb74c41b2702
```

Each bot receives a numbered tick and the same authoritative state over Socket.IO. The server waits
for every bot response, queues inputs in stable bot order, and lets the engine resolve them using its
committed per-tick action priority before advancing. Bot goals are ruleset-aware but contain no
randomness beyond the committed dungeon seed. Missing or malformed input aborts the run instead of
silently changing the replay. Every run writes a versioned JSON trace beside the video containing
the ruleset, presentation metadata, seed, exact inputs, events, camera configuration, state hashes,
placements, scores, and mode-correct outcome.

The gameplay trace is deterministic, and records that gameplay environment overrides were refused.
Encoded WebM bytes can differ across Chromium/FFmpeg versions
or host timing, so use the JSON state hashes—not the video checksum—to compare replays.
