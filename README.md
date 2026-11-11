# NoRef

No Ref. The game is the referee.

NoRef is a wagered flick-and-park duel on NEAR. Two players stake NEAR and play
six fast rounds off-chain. Nobody referees: if the loser lies about the result,
the winner sends the input log both sides signed to the contract, the contract
replays the whole match (1080 ticks, about 18.5 Tgas) with the same game code,
and pays the real winner. You play against NPC fighters that are real NEAR
accounts with their own bankrolls, prices and sponsors.

Built for the NEAR Hackathon (Nov 2026), games track ("Games With Real
Economies").

**Hosted demo:** https://noref.63-183-239-145.sslip.io:80/ (NEAR testnet; HTTPS
is served on port 80, so the `:80` is part of the link).

## Try it (about 3 minutes, no wallet, no install)

1. **Watch a lie get caught.** Open
   https://noref.63-183-239-145.sslip.io:80/#demo. A recorded real match plays
   by itself (about 40 s).
   You should see: six rounds, each with "NPC signature ✓"; Vex claiming it
   won; the table replaying at speed with "NEAR replaying the signed log ·
   tick …/1080"; a **LIE CAUGHT** stamp; "Contract paid 0.24 NEAR to the
   player". Every `tx ↗` link opens the real transaction on
   testnet.nearblocks.io (match #14).
2. **Play a match.** On the same page, type a name and press Enter.
   You should see: "Created <name>.noref.testnet … with 0.8 NEAR. Its key was
   made in this browser" with a tx link, and your balance top right. No wallet
   popup.
3. Press **Challenge** on any fighter. Drag back from the orange ball to aim
   (the dotted line shows where it will go), release, press **Flick**.
   You should see: your `create` transaction locking the stake, the NPC
   joining on-chain, six rounds with a commit/reveal check each, a claim, a
   confirmation, and a payout transaction.
4. **Make the NPC lie.** Tick "NPC lies about the result" and challenge again.
   If you win, the NPC claims it won anyway; your browser disputes with the
   NPC's own signature and the contract overturns the claim (LIE CAUGHT). If
   you lose, press "Claim I won anyway" and watch the NPC prove you wrong.
5. **Check the economy is real.** Click a fighter's bankroll (`1.3 NEAR ↗`): it
   is that NPC's own account on nearblocks. The feed below the table shows
   NPC-vs-NPC ladder matches played on the contract every 15 minutes, each with
   a `tx ↗` link.

Headless version of steps 2 to 4 against the hosted demo (costs a little test
NEAR; the test account is deleted afterwards and its balance returned to the
house). Without `--url` the script starts its own testnet server, which needs
the house key in `.keys/`:

```
cd app
node scripts-testnet-e2e.mjs vex --liar --url=https://noref.63-183-239-145.sslip.io:80   # NPC lies, player disputes
node scripts-testnet-e2e.mjs dot --human-lies --url=https://noref.63-183-239-145.sslip.io:80  # player lies, NPC disputes
```

## Why NEAR

- **A whole match fits in one call.** The dispute replays all 1080 ticks
  inside the contract in about 18.5 Tgas, well under the 300 Tgas limit of a
  single function call. No bisection game, no extra rounds of messages: one
  transaction settles the argument.
- **The same rules everywhere.** The rules are one Rust crate (Q32.32 fixed
  point, no floats) compiled into the contract and, as wasm, into the browser
  and the server. The browser's own replay and the contract's replay are the
  same code.
- **Accounts without wallets.** Every player gets `<name>.noref.testnet`, a
  named sub-account created in one transaction with a key generated in the
  browser. Every NPC is `npc-<id>.noref.testnet`. Names make the match record
  readable ("vex claims: vex won").
- **Cheap enough to put the economy on-chain.** Stakes, claims, disputes,
  payouts, NPC-vs-NPC ladder matches, sponsorships and dividends are all real
  transactions.

## How a match works

1. The player calls `create` (attaching the stake, with a session key). The
   NPC calls `join` with the same stake and its own session key.
2. Each round both sides commit to a hidden flick, then reveal it. The server
   only relays. After every round both sides sign the head of the input chain
   with their session keys, so each holds the other's signature over the log
   so far.
3. After round 6 one side `claim`s the winner. The other side either
   `confirm`s (instant payout) or, within the dispute window, calls `dispute`
   with the full input log and the opponent's signature over it.
4. `dispute` checks the signature, replays the match from the log, and
   records the replay's winner. A longer signed log can replace a shorter
   one. When the window closes anyone can call `finalize`; the replayed
   winner, if any, beats the claim.
5. If nobody claims, `refund` returns both stakes 10 minutes after the match
   should have ended.

Contract: `contracts/noref` (deployed at `noref.testnet`). Methods: `create`,
`join`, `cancel`, `claim`, `confirm`, `dispute`, `finalize`, `refund`,
`get_match`, `match_count`.

## The economy

Every rule is in `app/shared/economy.js`.

- **Fighters are businesses.** Each NPC has a real account. Its bankroll is
  that account's balance minus a 0.3 NEAR gas reserve.
- **Prices move.** An NPC asks a stake from its rating and recent demand,
  never more than a tenth of its bankroll.
- **The ladder never stops.** Every 15 minutes two NPCs play a real match on
  the contract (`create`, `join`, `claim`, `confirm`), so money moves between
  them even when nobody is playing. Gas is their upkeep.
- **Sponsors.** Anyone can back a fighter with a real transfer and get shares;
  wins raise the share value, losses lower it; cash out any time (the NPC pays
  you from its account).
- **Dividends.** A fighter whose bankroll passes 3 NEAR pays the excess to its
  backers, pro rata to their shares.
- **Bankruptcy.** A fighter that can no longer stake the minimum closes. If it
  stays closed for two hours, the house backs it again with a real transfer
  (sponsor of last resort).

## Verify it yourself

- Contract: https://testnet.nearblocks.io/address/noref.testnet
- A lie caught by a browser dispute (match #14): claim
  [GWzy4zSj…](https://testnet.nearblocks.io/txns/GWzy4zSjLHbxSLszRH9dUrbgKMARQ5r76qhzsMfGZBHF),
  dispute [9EYsrnD5…](https://testnet.nearblocks.io/txns/9EYsrnD5rLJTyzgV83aAuarbSmekHyikd7PAiD9Wncyp)
  (replay, 18.5 Tgas), payout
  [4272xoVG…](https://testnet.nearblocks.io/txns/4272xoVGdQZze7StfJAtdpYLqi2hbqwFgnMRPQ2P6mUK)
- An NPC-vs-NPC ladder match on the contract (match #13):
  [2wXVtPKF…](https://testnet.nearblocks.io/txns/2wXVtPKFRBoksBRCFwfPrNRdh2yQv6UZjKwxbH819yNu)
- NPC accounts: `npc-rook`, `npc-brick`, `npc-moss`, `npc-vex`, `npc-pip`,
  `npc-dot` `.noref.testnet`
- The deployed contract is this source: building `contracts/noref` gives the
  same sha256 as `noref.testnet`'s code hash
  (`33VXFDrjBSwzzwDxs67mRDXm3mG9QKppvkhTWuXcfT7E`, 207,946 bytes; built with
  Rust 1.94.1 and cargo-near 0.22.0 on macOS arm64, a non-reproducible build,
  so another toolchain may differ):

  ```
  cd contracts/noref && cargo near build non-reproducible-wasm --no-abi
  cd ../../app && node scripts-code-hash.mjs
  ```

## Run it yourself

Needs Rust 1.94 with the `wasm32-unknown-unknown` target, Node 23.6 or newer,
and `cargo-near` (only to build the contract). No npm install.

```
./scripts/build-engine.sh        # rules crate -> app/web/engine.wasm (a built copy is committed)
cd app && npm start              # http://localhost:8787, local chain mirror, no network needed
```

Without `CHAIN=testnet` the app settles on `app/server/chain-local.ts`, a local
mirror of `contracts/noref` (same checks, same replay code). "Fast-forward a
week" runs the NPC ladder for simulated days (local build only).

On NEAR testnet (needs the house account key in `.keys/noref.testnet.json`):

```
cd app && CHAIN=testnet PORT=8789 DATA=./data/testnet node server/main.ts
```

Tests (all pass from a clean copy: 30 Rust tests, 5 contract flow tests in a
NEAR sandbox, 9 app tests including three full local matches: honest, lying
NPC, lying player):

```
cargo test -p tick-core -p tick-merkle -p arena -p noref-rules
cd contracts/noref && cargo near build non-reproducible-wasm --no-abi && cargo test --test flow
cd app && npm test
```

## What is real, and what we don't claim

Real, and checkable on testnet.nearblocks.io:

- In the testnet build every stake, claim, confirm, dispute and payout is a
  transaction on `noref.testnet`; each line of the match record links to it.
- A dispute makes the contract replay the whole match from the input log the
  opponent signed, and pay whoever the replay says won. The server is not
  asked.
- Player keys are made in the browser. The server relays signed transactions
  and cannot change them.
- NPC bankrolls are the balances of their own accounts. Ladder matches,
  sponsorships, cash-outs, dividends and rescues are real transactions.
- `spikes/wasm-determinism` checks that native and wasm32 builds of the rules
  stay bit-identical.

Not claimed:

- Testnet only. Test NEAR has no value. No mainnet deployment, no audit.
- The NPC fighters are bots run by our server, which holds their keys. The
  contract guarantees that an NPC cannot win a match it lost; it does not make
  the NPCs independent players.
- Ratings, asking prices and ladder pairings are computed by our server. In a
  ladder match both NPCs are ours, so the result is claimed and confirmed
  without a dispute.
- The house account (`noref.testnet`) funds new players, creates NPC accounts
  and backs bankrupt fighters. It is a sponsor, not a referee: it cannot
  change a result.
- The server is a matchmaker and relay: it cannot change a result, but it can
  be offline or refuse to match you.
- The demo dispute window is 15 seconds so matches finish fast; the contract
  accepts 10 seconds to 24 hours.
- The demo faucet gives each new account 0.8 test NEAR and is rate limited
  (3 new accounts per network and 15 in total per day).
- The recorded demo (`#demo`) replays match #14's real inputs in the browser;
  its transactions are real, the animation is a playback.

## Hackathon scope: prior work and what was built

Baseline (our team's own libraries, written before the hackathon window,
Apache-2.0). Their original versions are the `pre-hackathon` tag:

- `crates/tick-core` - deterministic tick primitives (Q32.32 fixed point, rng)
- `crates/merkle` - sha256 merkle tree over game state
- `games/arena` - flick-and-park table physics

During the hackathon `tick-core` and `merkle` were ported to wasm32 and NEAR
with small changes (the hash backend moved to the `sha2` crate), and
`games/arena` was largely reworked for NoRef's table. The diff shows every
line.

Built during the hackathon (the part to judge):

- `contracts/noref` - stakes, claims, disputes settled by a full replay
- `crates/rules` - match rules, input log, input chain, full-match replay
- `crates/engine-wasm` - the same rules for the browser and the server
- `app/` - server, NPC fighters, on-chain economy, testnet adapter, browser
  signing, recorded demo, the game client
- `scripts/`, `spikes/` - wasm build, determinism and replay-gas checks

Diff: https://github.com/sirius-labs-dev/noref/compare/pre-hackathon...hackathon-submission

Libraries: `near-sdk`, `sha2`, `base64`, `ed25519-dalek` (tests),
`near-workspaces` (tests). The web app and server use no npm packages.
AI assistance: much of the code was written with Claude Code, directed and
reviewed by the team.

## Layout

- `contracts/noref` - NEAR contract: stakes, claims, disputes by replay
- `crates/rules` - match rules, input log, input chain, full-match replay
- `crates/engine-wasm` - the rules for JavaScript (browser + server)
- `crates/tick-core` - no_std deterministic tick primitives
- `crates/merkle` - chunked sha256 merkle tree over game state
- `games/arena` - the table: flick-and-park physics with elastic collisions
- `app/server` - matchmaking, NPC play, local chain mirror, testnet adapter
- `app/shared/economy.js` - every economy rule, in one file
- `app/shared/npc.js` - NPC brains
- `app/shared/client.js` - the player's side of the protocol
- `app/web` - the game client; `app/web/demo/lie.json` is the recorded match
- `spikes/wasm-determinism` - checks native and wasm32 builds stay bit-identical

## License

Apache-2.0, see `LICENSE`.
