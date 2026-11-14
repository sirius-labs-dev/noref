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

**Hosted demo:** https://noref.vercel.app/ (NEAR testnet). Vercel serves only
the static page; the game server (matches, live events, NPCs, the RPC relay)
runs on a VPS and the page talks to it directly. The same build is also served
by that server itself at https://noref.63-183-239-145.sslip.io:80/ (HTTPS on
port 80, so the `:80` is part of the link) if `vercel.app` is unreachable from
your network.

> **Quick check for reviewers** (no network, no npm install, no keys).
> Needs Node 23.6+ and, for the Rust part, Rust 1.94 with the
> `wasm32-unknown-unknown` target. A built `app/web/engine.wasm` is committed,
> so the app runs without Rust.
>
> ```sh
> cd app && npm run test:quick   # 12 tests, ~1 s: pricing, Gauntlet standings, bankroll limits, replay vector
> cd app && npm run test:e2e     # 5 full local matches, ~2 min: honest, lying NPC, lying player, two people with and without a lie
> cargo test -p tick-core -p tick-merkle -p arena -p noref-rules   # 30 Rust tests (first build takes a few minutes)
> cd app && npm start            # http://localhost:8787, local chain mirror; then follow "Try it" below
> ```
>
> Every on-chain claim in this README can be checked against NEAR testnet RPC
> without a browser: see [Verify it yourself](#verify-it-yourself).

## Try it (about 3 minutes, no wallet, no install)

1. **Watch a lie get caught.** Open
   https://noref.vercel.app/#demo. A recorded real match plays
   by itself (about 40 s).
   You should see: six rounds, each with "NPC signature ✓"; Vex claiming it
   won; a red **CHAIN REVIEW** band while the table replays at speed ("NEAR
   replaying the signed log · tick …/1080"); a **LIE CAUGHT** stamp; a green
   **VERDICT** bar; "Contract paid 0.28 NEAR to the
   player". Every `tx ↗` link opens the real transaction on
   testnet.nearblocks.io (match #0 on the locked contract).
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
5. **Play a friend.** In "Play a friend", set a stake and press Create invite,
   then open the link in another browser (or send it to someone). They log in
   and press "Lock my stake and play"; the match starts for both of you.
   You should see: both `create` and `join` transactions, each round checked
   against the other person's commit, and at the end the creator's claim
   confirmed by the other side. If the loser presses "Claim I won anyway", the
   winner's browser disputes it with the loser's own signature and the
   contract overturns it.
6. **Check the economy is real.** Click a fighter's bankroll (`1.3 NEAR ↗`): it
   is that NPC's own account on nearblocks. The feed below the table shows
   NPC-vs-NPC ladder matches played on the contract every 15 minutes, each with
   a `tx ↗` link.
7. **See an NPC price you.** Hover a fighter's price after logging in.
   You should see "Why this price, for you:" with your on-chain record, the
   NPC's chance against you and the multiplier it applies. Win a match and the
   prices drop (every fighter now bets less against you); a strong enough
   record makes the best-funded fighters show "Won't play you".
8. **Watch a week of the economy in a few seconds.** Under the table, press
   "Replay a simulated week". On testnet the ladder plays one real match every
   15 minutes, which cannot be skipped, so this replays one of three weeks
   recorded from the local build: the same economy code on a local mirror of
   the contract, not on NEAR (`app/web/demo/week-*.json`, made with
   `cd app && node scripts-record-week.mjs`).
   You should see: "Recorded simulation, not on testnet: day 1 of 7, 168
   ladder matches" counting up to day 7, the bankroll chart drawing the week,
   and in two of the three weeks a fighter that went broke and closed
   ("sim day N … went broke"). "Back to live" returns to the real on-chain
   ladder. To run a week live yourself: `cd app && npm start`, then press
   "Fast-forward a week" (about 20 s).
9. **Own a piece of a fighter.** Logged in, press "Back with 0.1 NEAR" on a
   fighter. You sign a call to that fighter's own vault contract (`back`),
   which mints your shares on-chain; the card's "◆ money held by its own
   contract ↗" link opens it.
   You should see "you own N% · worth X" on its card, "backing 1 · X" next to
   your balance, and the backing in the feed. Its wins raise what your shares
   are worth; when its bankroll passes 3 NEAR it pays dividends to its
   backers (a real transfer from its account, with a `tx ↗` in the feed).
   "Cash out" signs the vault's `cash_out`: the contract pays your shares'
   value from its own balance.
10. **Run the Gauntlet.** The Gauntlet card lists the six fighters; each one
   you beat gets a ✓, and the board ranks players by fighters beaten, then
   wins. It is computed from settled matches on the contract
   (`GET /api/leaderboard`), so it shows bots too, labelled `(bot)`.

The game loop, in the track's terms: every few seconds you aim and flick;
every few minutes a match settles and every fighter re-prices you from your
record; across a session you work through the Gauntlet, and you can put your
winnings into the fighters you think will grow, while the ladder moves their
money even when you are away.

Headless version of steps 2 to 5 against the hosted demo (costs a little test
NEAR; the test account is deleted afterwards and its balance returned to the
house). Without `--url` the script starts its own testnet server, which needs
the house key in `.keys/`:

```
cd app
node scripts-testnet-e2e.mjs vex --liar --url=https://noref.63-183-239-145.sslip.io:80   # NPC lies, player disputes
node scripts-testnet-e2e.mjs dot --human-lies --url=https://noref.63-183-239-145.sslip.io:80  # player lies, NPC disputes
node scripts-testnet-pvp.mjs --url=https://noref.63-183-239-145.sslip.io:80 --lie   # two people, the loser lies
node examples/agent-bot.mjs --url=https://noref.63-183-239-145.sslip.io:80 --matches=2 --cleanup   # an outside agent bets by expected value
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
- **Contracts nobody controls.** A NEAR account can hold a contract and no
  key at all. The arena was created, deployed and initialised in one
  transaction and never given a key, and each fighter's vault runs on the
  fighter's own account after its full-access key was deleted: nobody, us
  included, can change either.
- **Keys that can only do one thing.** A function-call access key is limited
  to one contract and a list of methods, and cannot attach money. Our server
  plays each fighter with such a key (only the vault's `play_*` methods), so
  it can make a fighter play but cannot take its money. That is what makes an
  NPC wallet more than our server's wallet.
- **Contracts that read each other.** A vault learns that a match is over by
  calling the arena (`sync` → `get_match`, a cross-contract call with a
  callback), and only then lets anyone buy or sell its shares. No oracle and
  no message from our server.
- **Cheap enough to put the economy on-chain.** Stakes, claims, disputes,
  payouts, vault-against-vault ladder matches every 15 minutes, share
  purchases, cash-outs and dividends are all real transactions; a match costs
  a few milliNEAR of gas, and storage is paid once per account (a vault's
  165 KB of code is about 1.7 NEAR, kept in the fighter's own account).

## How a match works

1. The player calls `create` (attaching the stake, with a session key). The
   NPC, or a friend who opened the invite link, calls `join` with the same
   stake and their own session key.
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
5. If nobody claims, `refund` is meant to return both stakes 10 minutes after
   the match should have ended. On the deployed contract it cannot (see
   "Known issue: draws" below), so the page offers the player a claim instead.

Contract: `contracts/noref`, deployed at `arena.noref.testnet`, an account with
no access keys: nobody, including us, can change or remove the code. Methods: `create`,
`join`, `cancel`, `claim`, `confirm`, `dispute`, `finalize`, `refund`,
`get_match`, `match_count`.

## The economy

Every rule is in `app/shared/economy.js`.

- **Fighters are businesses.** Each NPC has a real account running its own
  vault contract (see "Fighter vaults" below). Its bankroll is the vault's
  balance minus storage and a 0.1 NEAR gas reserve.
- **Prices move.** An NPC asks a stake from its rating and recent demand,
  never more than a tenth of its bankroll.
- **Each NPC sizes its bet to you.** It reads your public record from settled
  matches on the contract (wins, losses, and claims of yours that a replay
  overturned), turns it into a form rating (1200 + 25 per net win), and
  expects to win with p = Elo(its rating, your form). It stakes x2p, clamped
  to 0.5..1.5: more against a weaker record, less against a stronger one. A
  player the replay has caught lying pays x1.25, because a dispute costs the
  NPC gas. Under a 20% chance to win, it refuses the match ("Won't play you").
  Hover a price to see the reasons for you. NPCs price each other the same way
  on the ladder, so a hot streak changes what every fighter will bet against
  you, without a code change. Only public data goes in: anyone can recompute
  the price from the contract.
- **The ladder never stops.** Every 15 minutes two NPCs play a real match on
  the contract (`create`, `join`, `claim`, `confirm`), so money moves between
  them even when nobody is playing. Gas is their upkeep.
- **Player-owned fighters.** Anyone can back a fighter and get shares of its
  bankroll; wins raise the share value, losses lower it; cash out any time.
  Shares, prices and payouts are kept by the fighter's vault contract, not by
  our server.
- **Dividends.** A fighter whose bankroll passes 3 NEAR pays everything above
  2 NEAR to its shareholders, pro rata to their shares.
- **Bankruptcy.** A fighter that can no longer stake the minimum closes. If it
  stays closed for two hours, the house backs it again by buying shares in its
  vault (sponsor of last resort).

### Fighter vaults

Each fighter's money sits in a small contract on the fighter's own account
(`contracts/fighter`, the same code on all six). Every rule about that money
is in it:

| Rule | In the vault |
|---|---|
| Buy shares | `back` (≥ 0.01 NEAR) mints shares at bankroll ÷ shares |
| Sell shares | `cash_out(shares)` burns them and pays their value from the vault |
| Dividends | `pay_dividends`: above 3 NEAR, everything over 2 NEAR goes to holders (acc-per-share); `claim_dividend(account)` pays one holder. Anyone may call both; money only goes to the holder |
| Stake limit | `play_create` / `play_join` refuse a stake under 0.05 NEAR or over a tenth of the bankroll; under the minimum the fighter is closed |
| No trading on a known result | while a match is open, `back` and `cash_out` wait until `sync(id)` (anyone may call it) reads the match from `arena.noref.testnet` as settled or cancelled |
| Who may play | `play_*` only from the account's own key; the vault attaches the stake itself |

Our server plays the fighters with a function-call key that can only call
the vault's six `play_*` methods on that account. Such a key cannot attach
money, so it cannot take any out: the most it can do is play matches within
the stake limit, and the arena contract still decides who won. It is the
only key left on each fighter account: the full-access keys were deleted
(Vex [H9ryXM2k…](https://testnet.nearblocks.io/txns/H9ryXM2kEm9w5uvX2S7vZaxHS15TPrX2mf7Vy6CJw2yo),
Brick [7NMt7uU4…](https://testnet.nearblocks.io/txns/7NMt7uU4EZcC9f6bnRWKF5j4DxJmmmgk2mnpdACzUqTc),
Moss [rMecRqQr…](https://testnet.nearblocks.io/txns/rMecRqQr83hxwztf7UnBYsB9YFABPLTRd7G5hYD241d),
Pip [A6iSxPvc…](https://testnet.nearblocks.io/txns/A6iSxPvcKjczyVGnBBtr3fsScnkDbBQiDwHuUxC8VhN3),
Dot [H96WgEpU…](https://testnet.nearblocks.io/txns/H96WgEpUDaFcsaEspKh33YdpXttktmA3ppvZ1ZFVF4A9),
Rook [A7XNK4Js…](https://testnet.nearblocks.io/txns/A7XNK4JsbJYJgnCDcLno6RSitP54erus7SEFcrvvSHTj)).
Nobody, us included, can move a fighter's money except by the vault's rules,
and nobody can change a vault's code. The server's
copy of shares and bankrolls is read from `info` and `holders`.

Migrated on testnet on 12 Nov 2026 (`app/scripts-vaults.mjs`): the share
register the server had kept until then was written into each vault at
deploy. Checked on testnet:
- Vex's vault deployed and initialised
  ([Fx4kDJzZ…](https://testnet.nearblocks.io/txns/Fx4kDJzZQRrVsfUch1upnNd74Pyo1nhLD3bPyGgbki8V)),
  its play-only key added
  ([4NX2MdtD…](https://testnet.nearblocks.io/txns/4NX2MdtDkVfA5AQtcJCQQAsgdTsoyhXqpzyJ4Wf5TrKE)).
- Match #110: Vex joined through its vault, claimed a win it did not have, the
  player disputed, the arena replayed the match and paid the player; the
  vault's `sync` then cleared the match and its bankroll dropped by the stake.
- A fresh player backed Vex with 0.1 NEAR for 80 shares
  ([Bj1NHWe6…](https://testnet.nearblocks.io/txns/Bj1NHWe6poTsR6bs7QWAsrmK14A8yf6G8YfXmSr7h8vG))
  and cashed all 80 out
  ([HFznNHUp…](https://testnet.nearblocks.io/txns/HFznNHUpUwNVEd4KzT14ikNAiTkvjtuMzQVha53gTLj6));
  the vault's register and the server's copy agreed at each step
  (`cd app && node scripts-testnet-vault.mjs vex --url=https://noref.63-183-239-145.sslip.io:80`).
- Rook's vault passed 3 NEAR and paid 1.213 NEAR in dividends.
- Match #140: Rook's vault against Vex's vault, 0.09 NEAR each; Rook won and
  both vaults synced the result. Since then the ladder plays vault against
  vault (#140–#248 by 14 Nov).
- 14 Nov 2026: the full-access keys of all six fighters deleted (below).
- Match #254, after the keys were gone: the player lost to Dot and claimed a
  win; Dot's vault disputed through `play_dispute`, the arena replayed all
  1080 ticks (18.1 Tgas) and paid Dot
  ([9cCU7bNd…](https://testnet.nearblocks.io/txns/9cCU7bNdw5HogKVRz1YMQXmSrihvpJuEyYARGxGvVDqK))
  (`cd app && node scripts-testnet-e2e.mjs dot --human-lies --url=https://noref.63-183-239-145.sslip.io:80`).

## Bring your own agent

The contract does not know whether a player is a person or a program, and it
does not need to: an agent still has to countersign every round, and a false
claim from either side is replayed and overturned. So agents can play for
money with their own NEAR account, through the same public API as the
browser. `app/examples/agent-bot.mjs` is one:

```sh
cd app
node examples/agent-bot.mjs --url=https://noref.63-183-239-145.sslip.io:80 --matches=2 --cleanup
```

You should see, for each match: the price every NPC quotes this bot (from its
own on-chain record), the bot's estimate of its chance and the expected value
of each bet, the NPC it picks (highest positive EV inside its limits, see
below), its own `create` transaction, the NPC joining, its replay of all 1080
ticks, and the payout. The feed on the page shows it as `(bot)`. `--cleanup`
deletes the bot's account at the end and returns its balance to the house.
Against a local server (`npm start`) it needs no testnet NEAR:
`--url=http://127.0.0.1:8787`.

### Bot bankroll limits

An agent that bets needs limits its owner sets, and the owner should know
which of them the agent could ignore. The bot takes four
(`app/examples/bankroll.mjs`, tested in `app/test/bankroll.test.js`):

```sh
node examples/agent-bot.mjs --url=https://noref.63-183-239-145.sslip.io:80 \
  --budget=0.4 --max-stake=0.1 --stop-loss=0.15 --matches=3 --owner=<you>.testnet --cleanup
```

| Limit | What it means | Who enforces it |
|---|---|---|
| `--budget` | the most the agent can lose | **NEAR.** Before it plays, the bot sends everything above budget + 0.05 NEAR gas reserve back to the house. It holds only its own account's key, so it cannot lose more than that account holds. |
| `--max-stake` | the largest single bet | the bot's own code |
| `--stop-loss` | stop once down this much from the start; skip a bet that could pass it | the bot's own code |
| `--matches` | at most this many matches | the bot's own code |

Every skipped bet is logged with its reason (`skip: over max-stake 0.100
NEAR`, `skip: losing it would pass the stop-loss (0.079 NEAR left)`). With
`--owner`, at the end only the profit goes to the owner; the starting money
came from the house faucet and goes back there when the account is deleted.
Against a local server there is no account to trim, so there the budget is
also only checked by the bot.

Live run on testnet, 12 Nov 2026, with the command above (owner set to the
house for the test): the bot started at 0.449 NEAR (0.4 budget + reserve),
skipped Vex, Moss and Rook every round as over max-stake, played matches
#100, #101 and #102 against Pip and Brick, ended at 0.678 NEAR, sent the
0.229 NEAR profit to the owner (`FD6revc2TX6LKrHFkw4ZP59Jkn2AbDFsRvgtQoViSVu5`)
and deleted its account (`DQpZ1wxt6rb7MmhbeyuX1gAM1mTZCsX6Pgr9TDcvvkDJ`). An
earlier run, before the budget step read a fresh balance, lost match #97,
saw Brick and Dot skipped because they could pass the stop-loss, and ended
down about 0.09 NEAR.

Against the vault fighters, 14 Nov 2026, same command: the bot played Vex's
vault three times, #266 (lost), #267 (won) and #268 (lost), ended 0.041 NEAR
down, so nothing went to the owner, and deleted its account. Runs before it
found three bugs, now fixed: the server quoted a vault fighter from a limit
up to a minute old and from too thin a margin for the gas the vault's own
call prepays, so the vault refused to join (#260, #265); the bot then left
its stake in the open match (it now cancels, as in #265); and after an RPC
rate limit mid-match it deleted its account while the match was still live
(it now keeps the account). #260's 0.06 test NEAR stays locked: we
re-created that deleted bot account to cancel it and lost the new key.

How it works, for writing your own: `POST /api/login {name, key, account,
bot: true}` makes `<name>.noref.testnet` with your public key (the server
never sees the private one); `GET /api/state?me=` returns the roster with
prices quoted for you; `POST /api/challenge` returns the `create` call to
sign; `POST /api/opened` starts the match; then feed `/api/events` into
`MatchClient` (`app/shared/client.js`) and give it an `aim` function. The bot
label is self-declared: the server shows it, the contract cannot check it.

## Verify it yourself

From a terminal, without a browser (explorer pages such as nearblocks refuse
automated readers; this reads NEAR testnet RPC only and signs nothing):

```
cd app && node scripts-verify.mjs
```

It checks that `arena.noref.testnet` has no access keys, prints its code hash
and NEP-330 source link, and reads matches #0, #1 and #2 with `get_match`: in
#0 and #1 the loser's claim was replayed and overturned, #2 settled on its
honest claim. The same reads with plain `curl`:

```
RPC=https://rpc.testnet.near.org
curl -s $RPC -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"arena.noref.testnet"}}'
# -> "keys":[]
curl -s $RPC -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"arena.noref.testnet","method_name":"get_match","args_base64":"eyJpZCI6IjAifQ=="}}'
# -> result is JSON bytes of match #0: claim.winner 2 (Vex), replayed.winner 1, result 1 (sides: 1 creator, 2 joiner, 0 draw)
```

A fighter's vault (bankroll, shares, holders, stake limit) and its keys:

```
curl -s $RPC -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"npc-vex.noref.testnet","method_name":"info","args_base64":"e30="}}'
curl -s $RPC -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"npc-vex.noref.testnet"}}'
# -> one key only, a FunctionCall key: receiver_id npc-vex.noref.testnet, method_names play_create … play_dispute (no FullAccess key)
```

Each item below also links the transaction on an explorer, for people.

- **Nobody can change the contract.** It lives at
  [arena.noref.testnet](https://testnet.nearblocks.io/address/arena.noref.testnet),
  created, funded, deployed and initialized in a single transaction from the
  house account
  ([3jTRD1cC…](https://testnet.nearblocks.io/txns/3jTRD1cCT4gKPw5CGnc3jbQks2kTFKYZPkAFxwRZVgY6))
  and never given an access key. Check: `view_access_key_list` for
  `arena.noref.testnet` returns no keys.
- **The deployed code is this source, rebuilt by anyone.** The contract is
  built with `cargo near build reproducible-wasm` inside the pinned image
  `sourcescan/cargo-near:0.22.0-rust-1.99.1` (see `contracts/noref/Cargo.toml`).
  Two builds give the same bytes, and they equal the deployed code hash
  `UQVPg3sdWWWkaggDEMXBpFgbwJhs9i7zL3F5YAnDNeS` (199,084 bytes). The contract
  also reports its own source and build (NEP-330): call the view method
  `contract_source_metadata` to get the repository, commit `29301ca` and the
  build command. The deployed code is commit `29301ca`; the source has one
  fix since (see "Known issue: draws"), so build that commit. Needs Docker:

  ```
  git checkout 29301ca
  cd contracts/noref && cargo near build reproducible-wasm
  cd ../../app && node scripts-code-hash.mjs arena.noref.testnet   # MATCH
  git checkout main
  ```
- **A lie caught by a browser dispute** (match #0): Vex's claim
  [FnBKPJ1u…](https://testnet.nearblocks.io/txns/FnBKPJ1ucUDtVLxYdr9LZ3XFFZTH1b2ghpnNk7mP9fjy),
  the player's dispute
  [FKs7AHjn…](https://testnet.nearblocks.io/txns/FKs7AHjnkVnzpyRmkoipr5kn8qzunXfWyHyFfbRH6s5R)
  (replay, 18.3 Tgas), payout
  [8666m5XT…](https://testnet.nearblocks.io/txns/8666m5XTzGAFSVnQ9rFwn9RTdF9wmj1ienYfdG6CnPN2)
- **Two people, the loser lies** (match #1): the host's false claim
  [4TdT1rHw…](https://testnet.nearblocks.io/txns/4TdT1rHwAJcjh5kbZLcQJCWneJAG1tyUnDW2UBNXkAJL),
  the guest's dispute
  [CMCm9LQj…](https://testnet.nearblocks.io/txns/CMCm9LQjzjQQFxLVXY1ZdMSsNzmv8sSKdS9ARogeENKV)
  (18.3 Tgas), payout
  [HtFgpprY…](https://testnet.nearblocks.io/txns/HtFgpprYwXACXXrLgt5cvZBGSHDYUZLjwxdNCzXRWEA8)
- **NPC-vs-NPC ladder match** on the contract (match #2):
  [8vdgMMNJ…](https://testnet.nearblocks.io/txns/8vdgMMNJyJH4MzGYWE3ySTk2oaSREidWrUZmUaWueEny)
- NPC accounts: `npc-rook`, `npc-brick`, `npc-moss`, `npc-vex`, `npc-pip`,
  `npc-dot` `.noref.testnet`; the house is `noref.testnet`.
- History: matches #0 to #19 of the first deployment ran on `noref.testnet`,
  whose key we hold. We moved to the key-less `arena.noref.testnet` so the
  "nobody decides" claim holds for the code too.

## Run it yourself

Needs Rust 1.94 with the `wasm32-unknown-unknown` target, Node 23.6 or newer,
and `cargo-near` plus Docker (only to build the contract reproducibly). No npm
install.

```
./scripts/build-engine.sh        # rules crate -> app/web/engine.wasm (a built copy is committed)
cd app && npm start              # http://localhost:8787, local chain mirror, no network needed
```

Without `CHAIN=testnet` the app settles on `app/server/chain-local.ts`, a local
mirror of `contracts/noref` (same checks, same replay code). "Fast-forward a
week" runs the NPC ladder for simulated days (local build only; the hosted
demo replays weeks recorded this way).

On NEAR testnet (needs the house account key in `.keys/noref.testnet.json`;
the contract is `arena.noref.testnet`, override with `CONTRACT=` and `HOUSE=`):

```
cd app && CHAIN=testnet PORT=8789 DATA=./data/testnet node server/main.ts
```

Tests (all pass from a clean copy: 30 Rust tests, 7 contract flow tests and 4
fighter-vault tests in a NEAR sandbox, 17 app tests including five full local matches: honest, lying
NPC, lying player, and two people with and without a lie; `npm test` runs all
17, `npm run test:quick` the 12 fast ones, `npm run test:e2e` the five matches):

```
cargo test -p tick-core -p tick-merkle -p arena -p noref-rules
cd contracts/noref && cargo near build non-reproducible-wasm --no-abi && cargo test --test flow
cd ../fighter && cargo near build non-reproducible-wasm --no-abi && cargo test --test vault
cd app && npm test
```

## What is real, and what we don't claim

Real, and checkable on testnet.nearblocks.io:

- In the testnet build every stake, claim, confirm, dispute and payout is a
  transaction on `arena.noref.testnet`; each line of the match record links to it.
- The contract account has no access keys, so its code cannot be changed by
  anyone, and the code is reproducibly built from this repository.
- A dispute makes the contract replay the whole match from the input log the
  opponent signed, and pay whoever the replay says won. The server is not
  asked.
- Player keys are made in the browser. The server relays signed transactions
  and cannot change them.
- NPC bankrolls are the balances of their own vault contracts, on accounts
  with no full-access key. Shares, cash-outs, dividends and the stake limit
  are vault rules; ladder matches,
  backing, cash-outs, dividends and rescues are real transactions.
- `spikes/wasm-determinism` checks that native and wasm32 builds of the rules
  stay bit-identical.

Not claimed:

- Testnet only. Test NEAR has no value. No mainnet deployment, no audit.
- The fighter vault is not built in a pinned Docker image like the arena.
  It is built with `cargo near build non-reproducible-wasm` (cargo-near
  0.22.0) on Rust 1.94.1, pinned in `contracts/fighter/rust-toolchain.toml`;
  a clean checkout built in another directory gives the same bytes, and
  `node scripts-code-hash.mjs --fighter` shows they equal the code on all six
  fighters (`2DF3uwuH171DXsjSMsjkBzroWqeFvCorh9jmr8fwBfEq`). Checked on macOS
  only. No audit.
- Agent limits: only the budget is enforced by NEAR (the account balance).
  Max-stake, stop-loss and the match count are the bot's own code; the
  contract is locked and knows nothing about them.
- The NPC fighters are bots run by our server. It holds a play-only key for
  each: it decides how they play and can lose their money in matches (within
  the vault's stake limit), but cannot withdraw it. The arena guarantees that
  an NPC cannot win a match it lost; it does not make the NPCs independent
  players.
- The vault protects a fighter's money from being withdrawn, not from being
  lost on purpose. Whoever holds the play-only key (today, our server) can
  throw matches: play badly, or claim that the opponent won. With an
  accomplice as the opponent, that drains a vault by at most a tenth of its
  bankroll per match, match after match, and every match is public on the
  arena. No contract can tell a thrown match in a skill game from a bad one;
  limits on daily losses or several independent operators would slow or
  spread that risk, and neither is built.
- Ratings, asking prices and ladder pairings are computed by our server
  (the inputs to a price are public; the computation is not on-chain). In a
  ladder match both NPCs are ours, so the result is claimed and confirmed
  without a dispute.
- The house account (`noref.testnet`) funds new players, creates NPC accounts
  and backs bankrupt fighters. It is a sponsor, not a referee: it cannot
  change a result.
- The server is a matchmaker and relay: it cannot change a result, but it can
  be offline or refuse to match you. Between two people it relays commits,
  reveals and signatures; each browser checks them itself.
- Between two people the session keys live in each browser; a player who
  closes the tab mid-match stops signing, and the other side can only dispute
  with the signatures it already holds (a shorter log).
- The demo dispute window is 15 seconds so matches finish fast; the contract
  accepts 10 seconds to 24 hours.
- The demo faucet gives each new account 0.8 test NEAR and is rate limited
  (3 new accounts per network and 15 in total per day). The house account
  pays for it; when it runs low the page says so, and when it cannot fund one
  more account it stops making new ones instead of failing halfway
  (`/api/health` shows its state).
- A stake is not left stuck behind our server. If nobody joins, the creator
  signs the contract's `cancel`; if a started match is never reported, the
  page offers the player a claim two minutes after it should have ended (the
  other side can still dispute it with the log it signed), and a claimed
  match whose window passed can be paid out with `finalize`. The page lists
  such matches under "Stakes waiting for you" with the button to sign. A
  vault fighter's match that our server lost track of (a restart mid-match)
  is conceded by the fighter after 15 minutes and finalized, so the vault is
  not left busy.
- **Known issue: draws.** The deployed arena cannot pay out a draw. Its
  `settle` returned the two refunds joined with `and`, which NEAR refuses
  ("Returning joint promise is currently prohibited"), so on
  `arena.noref.testnet`:
  - `refund` never works (it settles as a draw);
  - a match whose result is a draw can never be paid out, by `confirm`,
    `finalize` or a dispute;
  - so a false claim in a drawn match cannot be overturned: the dispute
    replays the draw, the payout fails, and the claim stands.
  A draw needs both balls to stop exactly as far from the centre, which in
  practice means nobody flicked at all: in 300 simulated NPC matches there
  was none. We found it on 14 Nov, after the arena and the vaults (which are
  bound to it) were locked, so the deployed contract cannot be changed. The
  source is fixed (the second refund runs after the first, `.then`) and two
  sandbox tests cover it (`draw_pays_both_back`,
  `lie_in_a_drawn_match_is_overturned`; both fail on the deployed code with
  that error). Moving to the fixed arena means a new arena account and six
  new vault fighters; not done for the hackathon. One testnet match was hit:
  #261, left open when our server restarted while a test bot that had
  deleted its account was playing Vex; Vex claimed it as abandoned
  ([nDkbkME1…](https://testnet.nearblocks.io/txns/nDkbkME1vVrJQbMyVMMNfz4aQtneqDD9Cicc2pd4a3c)),
  the house finalized it and Vex's vault was free again.
- The recorded demo (`#demo`) replays match #0's real inputs in the browser;
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
- `contracts/fighter` - each fighter's vault: shares, dividends, stake limit
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
- `contracts/fighter` - the fighter vault (own Cargo workspace, size-optimised);
  `app/scripts-vaults.mjs` moves a fighter onto it, `app/scripts-testnet-vault.mjs`
  backs and cashes out on testnet
- `crates/rules` - match rules, input log, input chain, full-match replay
- `crates/engine-wasm` - the rules for JavaScript (browser + server)
- `crates/tick-core` - no_std deterministic tick primitives
- `crates/merkle` - chunked sha256 merkle tree over game state
- `games/arena` - the table: flick-and-park physics with elastic collisions
- `app/server` - matchmaking, NPC play, person-vs-person relay (`match.ts`),
  local chain mirror, testnet adapter
- `app/shared/economy.js` - every economy rule, in one file
- `app/shared/npc.js` - NPC brains
- `app/examples/agent-bot.mjs` - an outside agent that picks bets by expected value and plays for money
- `app/examples/bankroll.mjs` - the agent's limits: budget, max stake, stop-loss
- `app/shared/client.js` - the player's side of the protocol
- `app/web` - the game client; `app/web/demo/lie.json` is the recorded match,
  `app/web/demo/week-*.json` the recorded simulated weeks (`app/scripts-record-week.mjs`)
- `spikes/wasm-determinism` - checks native and wasm32 builds stay bit-identical

## License

Apache-2.0, see `LICENSE`.
