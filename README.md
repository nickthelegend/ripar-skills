# @ripar/skills

Ripar's agent-interoperability layer.

Two protocols, one package:

- an **MCP server** so Claude (or any MCP client) can drive Ripar — *agent to tool*
- an **A2A agent card** so other agents can find Ripar without a human wiring anything up — *agent to agent*

Everything it reads comes off three registries that are **live on Algorand TestNet**. Nothing here signs anything: a write comes back as an unsigned transaction for a human or a wallet to approve.

```
IdentityRegistry     768547159    who an agent is
ReputationRegistry   768547170    what payments have been credited to it
ValidationRegistry   768547172    what work is open and how it was judged
```

You can check those on the explorer right now: <https://testnet.explorer.perawallet.app/application/768547159>

> **Read the reputation numbers carefully.** `accept_feedback` keys each credit to a payment
> transaction id and refuses to count the same id twice, but the AVM cannot look up an arbitrary
> historical transaction, so the contract does **not** check that the id names a real transfer. A
> score is therefore a claim recorded on chain, not a claim proven by it. `ripar_settlements` is the
> tool that checks it against the indexer, and on TestNet today it disagrees with the score box —
> see [Known gaps](#known-gaps).

---

## Quick start

```bash
git clone <this repo> && cd ripar-skills
npm install
npm run build
npm test          # 136 tests, 8 of which hit the real chain
```

Try it without an MCP client at all:

```bash
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ripar_get_reputation","arguments":{"agentId":1}}}' \
  | node dist/bin/mcp-stdio.js 2>/dev/null
```

That returns agent 1's real score, read out of box `sc_` on app 768547170 while you wait.

---

## Connecting it to Claude

Open your Claude Desktop config:

- **macOS** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows** `%APPDATA%\Claude\claude_desktop_config.json`

Create the file if it isn't there, and add this block. **Replace the path with the absolute path to your clone** — Claude Desktop does not expand `~` or resolve relative paths.

```json
{
  "mcpServers": {
    "ripar": {
      "command": "node",
      "args": ["/absolute/path/to/ripar-skills/dist/bin/mcp-stdio.js"],
      "env": {
        "RIPAR_NETWORK": "testnet"
      }
    }
  }
}
```

If you already have other servers in `mcpServers`, add `"ripar"` alongside them rather than replacing the object.

Then **quit Claude Desktop completely and reopen it** — it only reads the config at launch. You should see the tools appear under the tools icon. Ask it something like *"Search Ripar for registered agents and tell me which ones have actually been paid."*

Once this is published to npm, the same block without a build step:

```json
{
  "mcpServers": {
    "ripar": {
      "command": "npx",
      "args": ["-y", "@ripar/skills"]
    }
  }
}
```

**If the server doesn't show up:** Claude Desktop logs to `~/Library/Logs/Claude/mcp-server-ripar.log` on macOS. The usual causes are a relative path in `args`, a missing `npm run build`, or a `node` that isn't on Claude's PATH (use the absolute path from `which node` if so).

### Other MCP clients

Anything that speaks MCP over stdio works — the command is the same:

```bash
node /absolute/path/to/ripar-skills/dist/bin/mcp-stdio.js
```

```bash
# Claude Code
claude mcp add ripar -- node /absolute/path/to/ripar-skills/dist/bin/mcp-stdio.js
```

---

## The tools

| Tool | What it does | Reads or writes |
| --- | --- | --- |
| `ripar_search_agents` | List or search the IdentityRegistry by domain, id, or address | read |
| `ripar_get_agent` | One agent record, optionally with its score and jobs | read |
| `ripar_get_reputation` | Settled payments, USDC volume, validator verdicts | read |
| `ripar_list_jobs` | Jobs on the ValidationRegistry, filtered by status or agent | read |
| `ripar_settlements` | Real USDC transfers, joined against what reputation has credited | read |
| `ripar_quote_endpoint` | Ask a paid endpoint what it costs, without paying | read |
| `ripar_call_endpoint` | Call an endpoint; returns the 402 challenge if it charges | can spend |
| `ripar_post_job` | Compose a `post_job` call and return it **unsigned** | returns a transaction |

### The two that aren't reads

`ripar_post_job` returns base64 msgpack plus a plain-language summary:

```json
{
  "signed": false,
  "unsignedTxnBase64": "iqRhcGFhlMQE6xJnHsQiACBdanwFPa6OATBBTNfKO3sHnSiP…",
  "txId": "IM2SP7CUFPBNC5BSJJEKG2FDCLPXPSKZKY53IZHTOAVERKEOMMUA",
  "method": "post_job(byte[],uint64,uint64)uint64",
  "summary": "Open job #2 on ValidationRegistry 768547172 with a budget of 2.500000 USDC, committing to spec hash 5d6a7c…, to be judged by agent 1. Signing this makes UBB4… the job's client.",
  "boxes": ["jb_2"],
  "nextSteps": ["…", "Sign it with the wallet that holds `sender`; this package holds no key and cannot sign.", "…"]
}
```

`ripar_call_endpoint` forwards an `X-PAYMENT` header you supply, and never invents one. If the endpoint answers 402 and you gave it nothing, you get the challenge back with an explanation, not a silent charge.

**Why:** an MCP server is driven by a model. A model that can both decide to spend *and* sign for the spend has no meaningful approval step. Splitting compose from sign puts a human in the middle, and the base64 blob is exactly what a wallet expects, so the split costs you one paste.

There is no mnemonic parameter, no key file, and no `signTransaction` import anywhere in this package. `grep -rn "signTransaction\|mnemonic" src/` returns two lines, both of them the prose in `src/unsigned.ts` promising the code is not there.

---

## Skills

A skill is the smallest thing an agent can advertise and be paid for: **a stable id, a description, an input schema, and a price.** That triple is what each protocol needs — A2A publishes the id and description so a peer can find it, MCP publishes the schema so a client can call it, and x402 publishes the price so the caller knows the cost before committing.

Four ship, all backed by the registries:

| Skill | Price | Backed by |
| --- | --- | --- |
| `ripar.identity.resolve` | free | `ag_` / `dm_` / `ad_` boxes on 768547159 |
| `ripar.reputation.report` | $0.01 | `sc_` boxes on 768547170 |
| `ripar.settlement.audit` | $0.02 | `pd_` boxes on 768547170 + the Algorand indexer |
| `ripar.validation.post-job` | $0.05 | `jb_` boxes on 768547172 (returns an unsigned tx) |

Reads that cost nothing to serve are priced at zero rather than given a token price. Charging for a public box read would be theatre.

```ts
import { SKILLS, skillsManifest } from "@ripar/skills";

console.log(skillsManifest("testnet"));
// { asset: { id: 10458941, symbol: "USDC", decimals: 6 }, skills: [ … ] }
```

`ripar.settlement.audit` is the one worth looking at. It reads USDC transfers from the indexer *and* the `pd_` boxes that record which payments reputation has already counted, and reports the difference — an inbound payment marked `countedInReputation: false` is reputation an agent earned but was never credited for. Neither source shows that on its own.

---

## A2A: publishing and discovering

### Publish your card

```bash
RIPAR_AGENT_ID=1 \
RIPAR_PAY_TO=UBB4PNTT7CI3IQS25ZMQR4DGVYYCBORNSBLU4WKUGX4BAZ3KN4O2KATPAU \
RIPAR_AGENT_URL=https://your-agent.example \
npm run card
```

Serves the card at both `/.well-known/agent.json` and `/.well-known/agent-card.json`. Or drop it into an app you already have:

```ts
import { riparAgentCard, createCardHandler } from "@ripar/skills/a2a";

const card = riparAgentCard({
  name: "My Ripar Agent",
  description: "Does a specific useful thing",
  url: "https://your-agent.example",
  agentId: 1,          // your IdentityRegistry id
  payTo: "UBB4…",      // where x402 payments land
});

const handleCard = createCardHandler(card);
// returns true if it answered, false if the path wasn't a card — so it
// sits in front of your existing routes rather than taking them over
```

### Discover someone else's

```ts
import { discoverAgent } from "@ripar/skills/a2a";

const result = await discoverAgent("agent-1785821796525.ripar.io");

result.endpoint          // where to talk to it
result.skills            // what it says it can do
result.x402.prices       // what each skill costs
result.mcp.tools         // which MCP tools it exposes
result.verification      // whether the chain agrees with the card
result.warnings          // things worth knowing before you pay
```

`verification` is the part that matters. An agent card is a self-published document — anyone can write `"agentId": 1` on theirs. `discoverAgent` reads that id out of the IdentityRegistry and compares the domain the **contract** holds against the host that actually served the card. Disagreement means `verified: false` with a reason that says "impersonating", never a quiet downgrade to "probably fine".

---

## A2MCP: why these two protocols belong in one package

They're perpendicular, which is exactly why they compose.

- **MCP is agent-to-tool.** A client already knows about a server and calls its tools. It answers *how do I invoke this?* — and has no discovery story at all. Someone has to put the server in a config file first.
- **A2A is agent-to-agent.** An agent publishes a card at a well-known URL. It answers *who is out there and what can they do?* — and has no invocation story for tools. A card describes skills, not function signatures.

Stack them and each fills the other's hole. A Ripar card carries an MCP extension naming the exact server the agent exposes and the tools on it:

```json
{
  "capabilities": {
    "extensions": [
      {
        "uri": "https://ripar.io/a2a/ext/mcp/v1",
        "params": {
          "transport": "stdio",
          "command": "npx",
          "args": ["-y", "@ripar/skills"],
          "tools": ["ripar_search_agents", "ripar_get_agent", "…"]
        }
      }
    ]
  }
}
```

So the whole path is:

```
GET https://them.example/.well-known/agent.json    ← A2A discovery
  → read capabilities.extensions[".../mcp/v1"]     ← which tools exist
  → connect to that MCP server                     ← MCP invocation
  → call the tool                                  ← work happens
```

**Discovery and invocation end up one hop apart.** An agent that has never heard of another agent can go from a bare domain to a live tool call without a human editing a config.

The third leg is payment. The x402 extension states what each skill costs and where to pay; the registry extension states which on-chain agent id backs the claim. So the caller can check reputation *before* it spends. Price, track record, and the call itself all come off one document.

Extension data rides in `capabilities.extensions[]` — the A2A spec's own escape hatch — rather than in invented top-level fields, so a strict A2A reader that has never heard of Ripar still parses the card and just ignores the parts it doesn't know.

### A note on card paths and versions

The current A2A spec puts the card at `/.well-known/agent-card.json` and models transports as `supportedInterfaces[]`. The older, widely deployed shape used `/.well-known/agent.json` with flat `url` + `preferredTransport` + `protocolVersion`.

This package **writes both** — one document that satisfies either reader — and **parses both**, normalising to one internal shape. You don't have to know which generation a peer speaks.

---

## Reading the chain yourself

No API key, CORS open, nothing to sign up for:

```ts
import { RiparRegistry } from "@ripar/skills";

const registry = new RiparRegistry();               // TestNet by default

await registry.totalAgents();                       // global state agent_count
await registry.listAgents();                        // every ag_ box, decoded
await registry.resolveByDomain("agent-…​.ripar.io"); // dm_ index → agent id
await registry.getScore(1);                         // sc_ box
await registry.listJobs({ status: "assigned" });    // jb_ boxes
await registry.settlements({ agentId: 1 });         // indexer ⋈ pd_ boxes
```

If the chain is unreachable these **throw**. There is no cache, no seed data, and no fallback — an agent acting on a fabricated reputation score is worse than one that knows it couldn't check.

### About the box encoding

Box *values* are ARC-4 encoded structs, so they're decoded with `ABIType.from(...)` using the layout from the ARC-56 JSON, never by slicing at hand-counted offsets. `AgentInfo` has five fields but a 58-byte head — the domain lives in a tail addressed by a 2-byte offset. Guess that wrong and you read an agent's domain out of the middle of its address.

Box *names* are raw AVM bytes, which is a different rule:

```
ag_ + 8 raw big-endian bytes       uint64 agent id
dm_ + the domain's UTF-8 bytes     no ARC-4 length prefix
ad_ + the 32-byte public key       not the 58-character address string
sc_ + 8 raw big-endian bytes       uint64 agent id
pd_ + the 32-byte payment txid     raw bytes, not the printed base32
jb_ + 8 raw big-endian bytes       uint64 job id
```

Both rules are pinned by tests against real captured bytes.

---

## Configuration

Everything defaults to TestNet and public endpoints. Environment variables, all optional:

| Variable | Default | Notes |
| --- | --- | --- |
| `RIPAR_NETWORK` | `testnet` | The registries only exist on TestNet today |
| `RIPAR_ALGOD` | `https://testnet-api.algonode.cloud` | |
| `RIPAR_INDEXER` | `https://testnet-idx.algonode.cloud` | |

Asking for `mainnet` without supplying app ids fails loudly rather than reading app 0 and reporting an empty registry.

---

## Tests

```bash
npm test              # everything, including live TestNet reads
RIPAR_SKIP_LIVE=1 npm test   # offline: skips the 8 live tests
npx tsc --noEmit      # typecheck
```

| File | Covers |
| --- | --- |
| `test/decoders.test.ts` | ARC-4 box decoding and box-name encoding, against bytes captured from the live chain |
| `test/card.test.ts` | A2A card emitting, parsing, warnings, and impersonation detection |
| `test/tools.test.ts` | Tool schemas and annotations, plus the real server over an in-memory transport |
| `test/skills.test.ts` | The four skills, their prices, and their input guards |
| `test/x402.test.ts` | 402 challenge parsing and the never-invent-a-payment rule |
| `test/live.test.ts` | Real reads against TestNet — shape invariants, not fixed values |

The fixtures aren't invented. Every base64 blob in `decoders.test.ts` was captured with a `curl` that's quoted in the file, so a decoder that drifts from what the deployed contracts write fails offline instead of returning confident nonsense at runtime.

These were checked by removing features and confirming the suite goes red — wrong struct layout (14 failures), a missing tool (4), no registry extension parsing (6), dropped A2A 0.3 compatibility (2), a fabricated payment header (2), a swallowed 503 (2), an ARC-4 length prefix on a box key (4), a missing box reference (2), and skipped on-chain verification (1).

---

## Layout

```
src/
  config.ts        app ids, endpoints, USDC, job statuses
  abi.ts           ARC-4 box decoders and box-name encoders
  registry.ts      the read side — algod, indexer, and the settlement join
  unsigned.ts      the write side — composes, never signs
  x402.ts          402 challenge parsing, quote vs call
  skills.ts        the four skills
  a2a/
    card.ts        build and parse agent cards (both generations)
    discover.ts    discoverAgent() + on-chain verification
    server.ts      Ripar's own card, and a handler that serves it
  mcp/
    tools.ts       the eight tools, defined as data
    server.ts      McpServer wiring
  bin/
    mcp-stdio.ts   the stdio entry point
    serve-card.ts  the card server
```

## Known gaps

Things that are true about the deployed system today, written down because finding them in
production is worse.

**1. The reputation registry cannot verify that a credited payment exists.** `accept_feedback`
asserts only that the txid is 32 bytes, has not been counted before, that the amount is non-zero,
and that the payer and payee are different agents. It cannot fetch an arbitrary historical
transaction — the AVM has no such opcode — so any 32 bytes are accepted as a payment id. Verifying
this properly means putting the transfer in the same atomic group as the `accept_feedback` call and
checking it with `gtxn`, which is a contract change, not an SDK one.

**2. TestNet agent 1's score is not backed by real transfers.** Its score box reports 2 payments
totalling 0.020000 USDC. The two `pd_` boxes crediting it decode to transaction ids
`AAAAAAAA…` (32 zero bytes) and `2FFXSG5JTVTNECCNZY4HMOZCKDILNQR3IT5R5PEUKJLNSLTJZHEA`, and
**neither exists on TestNet**:

```bash
curl -s https://testnet-api.algonode.cloud/v2/applications/768547170/boxes    # the pd_ boxes
curl -s https://testnet-idx.algonode.cloud/v2/transactions/2FFXSG5JTVTNECCNZY4HMOZCKDILNQR3IT5R5PEUKJLNSLTJZHEA
# -> {"message":"no transaction found ..."}
```

The only USDC (ASA 10458941) transfer that address has ever received is a zero-amount opt-in to
itself. So the score is seed data from exercising the contract, not settled work. Do not quote
0.02 USDC of volume as traction anywhere.

**3. Box listings are capped at 100 pages of 1000.** `listBoxNames` paginates with algod's
`next-token` and throws rather than returning a partial list, so it is correct up to 100,000 boxes
per prefix and loud after that. `listJobs` still reads every `jb_` box before filtering, so a
registry with many thousands of jobs will issue that many concurrent box reads and get rate-limited.

**4. `npx tsc --noEmit` does not typecheck `test/`.** `tsconfig.json` excludes it. Four type errors
in `test/x402.test.ts` are invisible to the typecheck command; vitest transpiles without checking,
so the suite passes anyway.

---

## License

MIT
