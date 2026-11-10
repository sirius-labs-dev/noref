# NoRef

No Ref. The game is the referee.

A wagered physics arena on NEAR where nobody decides the winner: no server,
no referee, no opponent. Matches run off-chain at full speed; if a result is
disputed, the contract replays the whole match (all 1080 ticks, about 18 Tgas)
from the input log the opponent signed, with the same game code, then pays
the real winner.

Built for the NEAR Hackathon (Nov 2026), games track.

## Play it locally

Needs Rust (with the `wasm32-unknown-unknown` target) and Node 23.6+. No npm install.

```
./scripts/build-engine.sh        # rules crate -> app/web/engine.wasm
cd app && npm start              # http://localhost:8787
```

Pick a name, challenge a fighter, drag back from your orange ball to aim.
Tick "NPC lies about the result" to watch a false claim get overturned by a
full replay, or press "Claim I won anyway" after a loss to watch the NPC
prove you wrong with your own signature. "Fast-forward a week" runs the NPC
ladder so the economy moves.

## Play it on NEAR testnet

**Hosted demo:** https://noref.63-183-239-145.sslip.io:80/ (HTTPS served on
port 80; the `:80` is part of the link).

The same app, with every stake, claim, dispute and payout a real transaction
on the NoRef contract (`noref.testnet`):

```
cd app && CHAIN=testnet PORT=8789 DATA=./data/testnet node server/main.ts
```

- Logging in creates `<name>.noref.testnet`. Its full-access key is generated
  in the browser and never leaves it; the server only sees the public key and
  never adds a key to an account it did not just create.
- The player signs `create` (locking the stake), `claim`, `confirm` and
  `dispute` in the browser. The server relays RPC traffic (`/api/rpc`) but
  cannot change a signed transaction.
- NPC fighters are real accounts (`npc-<id>.noref.testnet`). They `join`,
  claim, confirm and dispute with their own keys; the house account only
  creates accounts, tops NPCs up, and calls `finalize` (open to anyone) when
  a dispute window closes.
- Every chain event in the match record links to the transaction on
  testnet.nearblocks.io.

Headless check of the whole flow against testnet (costs a little test NEAR,
the test account is deleted afterwards and its balance returned):

```
node scripts-testnet-e2e.mjs pip --liar        # NPC lies, player disputes
node scripts-testnet-e2e.mjs dot --human-lies  # player lies, NPC disputes
```

Without `CHAIN=testnet` the app settles on `app/server/chain-local.ts`, a
local mirror of `contracts/noref` (same checks, same replay code), so it runs
with no network at all.

## What is real, and what we don't claim

Real, and checkable on testnet.nearblocks.io:

- In the testnet build every stake, claim, confirm, dispute and payout is a
  transaction on `noref.testnet`; each line of the match record links to it.
- A dispute makes the contract replay the whole match from the input log the
  opponent signed with its session key, and pay whoever the replay says won.
  The server is not asked.
- Player keys are made in the browser. The server relays signed
  transactions and cannot change them.
- The rules are one Rust crate (Q32.32 fixed point, no floats) compiled into
  the contract and, as wasm, into the browser and server.
  `spikes/wasm-determinism` checks that native and wasm32 builds stay
  bit-identical.

Not claimed:

- Testnet only. Test NEAR has no value. No mainnet deployment, no audit.
- The NPC fighters are bots run by our server, which holds their keys and
  funds them from the house account. The contract guarantees that an NPC
  cannot win a match it lost; it does not make the NPCs independent players.
- The NPC economy (bankrolls, ratings, asking prices, the NPC-vs-NPC ladder,
  fast-forward) is game logic on our server. Only matches a player takes
  part in, sponsorships and cash-outs touch the chain.
- The server is a matchmaker and relay: it cannot change a result, but it
  can be offline or refuse to match you. If nobody claims, `refund` returns
  both stakes 10 minutes after the match should have ended.
- The demo dispute window is 15 seconds so matches finish fast; the contract
  accepts 10 seconds to 24 hours.
- The demo faucet gives each new account 0.8 test NEAR and is rate limited
  (3 new accounts per network and 15 in total per day).

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
- `app/` - server, NPC fighters, economy, testnet adapter, browser signing,
  the game client
- `scripts/`, `spikes/` - wasm build, determinism and replay-gas checks

Diff: https://github.com/sirius-labs-dev/noref/compare/pre-hackathon...hackathon-submission

Libraries: `near-sdk`, `sha2`, `base64`, `ed25519-dalek` (tests),
`near-workspaces` (tests). The web app and server use no npm packages.
AI assistance: much of the code was written with Claude Code, directed and
reviewed by the team.

## License

Apache-2.0, see `LICENSE`.

## Layout

- `crates/tick-core` - no_std deterministic tick primitives: Q32.32 fixed
  point, xorshift64* rng, the `TickLogic` trait
- `crates/merkle` - chunked sha256 merkle tree over game state
- `games/arena` - the table: flick-and-park physics with elastic collisions
- `crates/rules` - match rules, input log, input chain, full-match replay
- `contracts/noref` - NEAR contract: stakes, claims, disputes by replay
- `crates/engine-wasm` - the rules for JavaScript (browser + server)
- `app/shared/economy.js` - every economy rule, in one file
- `app/shared/npc.js` - NPC brains
- `app/shared/client.js` - the player's side of the protocol
- `spikes/wasm-determinism` - checks native and wasm32 builds stay bit-identical

## Check

```
cargo test -p tick-core -p tick-merkle -p arena -p noref-rules
cd contracts/noref && cargo near build non-reproducible-wasm --no-abi && cargo test --test flow
cd app && npm test
```
