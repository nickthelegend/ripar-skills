/**
 * MCP prompts: the three flows that are easy to get wrong.
 *
 * A prompt here is not a personality or a system message. It is a procedure a
 * user can pick from a menu — "vet this agent before paying it" — that expands
 * into the ORDER the tools have to be called in, and the reasons an answer
 * should be no. That order is the part a model does not get from the tool
 * descriptions: any one tool can say what it returns, but nothing in
 * `ripar_get_reputation` says "check the settlements before you believe this",
 * and nothing in `ripar_post_job` says "your budget is not money until you
 * fund it".
 *
 * Two rules hold for everything in this file:
 *
 *   1. Every tool named in a prompt exists. A prompt that references a tool the
 *      server does not register sends the model looking for something that
 *      cannot be found, and it will improvise instead — which, for a question
 *      about whether an agent has been paid, means inventing a track record.
 *      `PROMPTS_REFERENCE_TOOLS` is asserted against `TOOL_NAMES` in the tests.
 *   2. Nothing here tells the model to sign anything. The compose tools return
 *      unsigned transactions and the prompts say so, because a flow that ends
 *      "and then submit it" would be describing a capability this server does
 *      not have.
 */
import { z } from "zod";
export const PROMPTS = [
    {
        name: "vet_agent",
        title: "Vet an agent before paying it",
        description: "Check an agent's on-chain identity, whether anyone has actually paid it, whether those " +
            "payments are real, and what it charges — in that order, ending in a recommendation that is " +
            "allowed to be 'no'.",
        argsShape: {
            agent: z
                .string()
                .describe("Agent id, domain, or Algorand address — whatever you were given"),
            endpoint: z
                .string()
                .optional()
                .describe("A paid URL you are considering calling, if you have one"),
        },
        tools: [
            "ripar_get_agent",
            "ripar_get_reputation",
            "ripar_settlements",
            "ripar_quote_endpoint",
            "ripar_list_jobs",
        ],
        render: (a) => `Vet the Ripar agent "${a.agent}" before I pay it anything. Work in this order and
show me what each step returned.

1. ripar_get_agent — resolve "${a.agent}" to a registry record. If nothing resolves, stop: an
   unregistered domain is a claim with nothing behind it, and everything below would be about a
   stranger. Note the controlling address; that is the account any payment would go to.

2. ripar_get_reputation — read its score. What matters is jobs_paid and volume, and the difference
   between a score of null and a score of zero: null means it has never been paid at all. Also read
   validated and disputed — those are validator verdicts written by the ValidationRegistry, and a
   disputed count above zero is the most informative number on the record.

3. ripar_settlements — cross-check that score against real USDC transfers on the indexer. The score
   is a record the contract keeps; the transfers are money that demonstrably moved. If the score
   claims volume that no transfer supports, say so plainly, and treat that as disqualifying rather
   than as a discrepancy to be explained away.

4. ripar_list_jobs with this agent's id — look at the work itself. For each job compare BUDGET
   against ESCROW: budget is what a client said the work was worth, escrow is what they actually
   handed over. A history of unfunded jobs tells you something different from a history of funded
   ones. Note any job that ended 'disputed'.
${a.endpoint
            ? `
5. ripar_quote_endpoint on ${a.endpoint} — find out what it charges before committing. Check that
   the payee in the 402 challenge is the SAME address the registry gave you in step 1. If it is
   not, stop there and tell me: a card can be written by anyone, but the registry entry is signed
   by the account being paid.
`
            : `
5. If you are given an endpoint later, quote it with ripar_quote_endpoint and check that the payee
   in the challenge matches the address from step 1 before paying anything.
`}
Then give me a recommendation in three lines: what this agent has actually been paid for, what is
unproven, and whether I should pay it. "Not enough evidence" is a real answer — prefer it to a
confident one you cannot support from the reads above. Do not fill any gap with a plausible number.`,
    },
    {
        name: "post_and_fund_job",
        title: "Post a job and actually fund it",
        description: "Compose the post_job transaction and then the two-transaction funding group, explaining at " +
            "each step what signing would commit and why a budget alone commits nothing.",
        argsShape: {
            sender: z.string().describe("The address that will sign — it becomes the job's client"),
            specHash: z.string().describe("Hex of the 32-byte sha256 digest of the job spec"),
            budgetUsdc: z.string().describe("Budget in whole USDC, e.g. 2.50"),
            validatorAgentId: z
                .string()
                .optional()
                .describe("Registry id of the agent that will judge the result, if you have picked one"),
        },
        tools: ["ripar_post_job", "ripar_list_jobs", "ripar_fund_job", "ripar_get_agent"],
        render: (a) => `Post a Ripar job for me and then fund it. I will sign; you compose.

Budget: ${a.budgetUsdc} USDC. Spec hash: ${a.specHash}. Client: ${a.sender}.
${a.validatorAgentId
            ? `Validator: agent ${a.validatorAgentId} — resolve it with ripar_get_agent first and tell me who
it is, because that agent alone will decide whether the work passed.`
            : `No validator named, which means I judge the work myself. Say so explicitly when you compose.`}

1. ripar_post_job — compose it. Convert the budget to base units yourself (six decimals, so 2.50 is
   2500000) and show me that conversion. Read back the summary and the expected job id. Do not
   submit anything: what comes back is an unsigned transaction for me to sign in a wallet, and this
   server holds no key.

2. Tell me plainly that posting commits NO money. The budget is a number in a box; until it is
   funded the escrow is 0 and any agent looking at the job can see that.

3. Once I tell you the job id it actually got, use ripar_list_jobs with that jobId to confirm it
   exists, is 'open', and shows escrow 0.

4. ripar_fund_job — compose the funding group for that job id and the same amount. Explain that it
   is TWO transactions sharing one group id: the asset transfer to the registry's app account, and
   the fund_job call that reads the amount off that transfer instead of trusting an argument. Both
   must be signed and submitted together, in order.

5. Tell me what happens to the money afterwards: it sits in the contract's account until the work
   is judged. On a pass it goes to the assignee, on a failure or a cancellation it comes back to me.
   Neither happens automatically — somebody has to compose that call too.`,
    },
    {
        name: "settle_job_escrow",
        title: "Settle a job's escrow",
        description: "Work out whether a job's escrow should be released to the assignee or refunded to the " +
            "client, who is allowed to do it right now, and compose the unsigned call.",
        argsShape: {
            jobId: z.string().describe("The job whose escrow should move"),
            sender: z.string().describe("The address that will sign and pay the fee"),
        },
        tools: ["ripar_list_jobs", "ripar_settle_escrow", "ripar_get_agent"],
        render: (a) => `Help me settle the escrow on Ripar job ${a.jobId}. I will sign; you compose.

1. ripar_list_jobs with jobId ${a.jobId} — read its status and its escrow. If escrow is 0 there is
   nothing to settle: either it was never funded, or it was already paid out, because the contract
   deletes the record before it sends. Say which is more likely from the status and stop.

2. Decide the direction from the status, and tell me the rule you used:
     validated -> release, which pays the assigned agent
     disputed or cancelled -> refund, which returns the money to the client
     anything else -> neither is legal yet; say what the job is waiting for and stop.

3. If it is a release, use ripar_get_agent on the job's server agent id and tell me who is about to
   be paid, by domain and address. Money leaving an escrow should never be described only as an id.

4. ripar_settle_escrow with jobId ${a.jobId}, sender ${a.sender}, and the action from step 2. Read
   back who may sign it and when. For a release that matters: the client may sign immediately, and
   anyone at all may sign once the dispute window has passed since the verdict — that second path
   exists so a validator who never comes back cannot freeze the worker's money for good. The tool
   reports the exact time that window closes; give it to me.

5. Remind me this is unsigned and nothing has been submitted. If the response says I am not the
   client and the window has not closed yet, tell me to wait rather than to sign — signing early
   burns a fee for a transaction the contract will reject.`,
    },
    {
        name: "recover_compromised_key",
        title: "Recover an agent whose key is compromised",
        description: "Move an agent identity to a new controlling address before whoever has the old key uses it " +
            "— and then check that the old address really has stopped resolving, which is the part that " +
            "makes the rotation worth anything.",
        argsShape: {
            agent: z.string().describe("The agent whose key is at risk — id, domain, or address"),
            newAddress: z
                .string()
                .optional()
                .describe("The address taking control, if you have already generated one"),
        },
        tools: ["ripar_get_agent", "ripar_rotate_address", "ripar_agent_health", "ripar_search_agents"],
        render: (a) => `Agent "${a.agent}" may have a compromised key. Walk me through moving it, and be
blunt about what is at stake at each step. I will sign; you compose.

FIRST, the thing that decides everything else: rotation is a RACE. Only the current address may sign
a rotation, and whoever holds a stolen key holds that same power — they can rotate to themselves, or
deregister the agent outright, and either way the identity is gone. So the order below is "act, then
verify", not "investigate, then act". If I hesitate, say this again.

1. ripar_get_agent on "${a.agent}" — confirm the id, the domain, and the address the registry
   currently holds. That address is the key we are retiring. If nothing resolves, stop: there is no
   on-chain identity to move and everything below would be about a stranger.

2. Check I have a destination. ${a.newAddress
            ? `I said ${a.newAddress}. Before composing anything, run ripar_search_agents on that address:
   the registry allows one identity per address, so if it already controls an agent the rotation is
   refused. Tell me if it does.`
            : `I have not given you one. Tell me to generate a fresh Algorand account in a wallet I
   control and paste the address — and tell me NOT to reuse an address that already controls an
   agent, because the registry holds one identity per address and the contract refuses it.`} Say plainly that this new key is now the only thing between me and losing the identity, so it
   should not live where the old one did.

3. ripar_rotate_address — compose it: sender is the CURRENT address, agentId from step 1, newAddress
   from step 2. Read the summary back and make sure I have understood two things:

     - The agent id, the domain, and every reputation score and job referencing that id are
       PRESERVED. Reputation follows the identity, not the key. That is why rotating beats
       deregistering and re-registering, which strands all of it.
     - THE OLD ADDRESS STOPS RESOLVING. The reverse index moves with the identity, so the old
       address resolves to nothing the moment this confirms, and anyone checking "does the payee
       match the registry" gets a miss on the old key from then on. That is the entire point: if the
       old address kept resolving, the rotation would have secured nothing.

   This may come back REFUSED, saying rotate_address is not in the deployed IdentityRegistry's
   approval program. That is a true answer about the live chain, not a bug — the method exists in
   ripar-contracts and compiles, but the deployed registry predates it. If it happens, give me the
   refusal verbatim and then the real position: the deployed contract has deregister_agent, which
   frees the domain and address boxes so a NEW id can be registered from a new address — at the cost
   of the id and everything attached to it. Do not dress that up as equivalent. And tell me the
   compromised key can call deregister too, so it is still a race.

4. Remind me this is unsigned. It has to be signed by the OLD key, the one I am retiring, because
   that is the only key the contract accepts — and this server holds no key and submits nothing.

5. After I tell you it confirmed, verify rather than assume. Two reads with ripar_get_agent:
     - the NEW address must resolve to the same agent id;
     - the OLD address must resolve to NOTHING. If it still resolves, the rotation did not land and
       I should assume the old key is still live.

6. ripar_agent_health on the agent — this is the step people skip. The registry now says one thing
   and the agent card served at the domain still says another: its x402 payTo names the OLD address
   until somebody edits the card. Until then, a caller who checks the card against the registry sees
   a mismatch, and a caller who does not check pays the compromised key. The health report flags
   exactly that. Tell me to update the card and what to change it to.

Finish with what is still exposed: the old key can no longer act as this agent, but anything else it
controls — funds, other identities — is untouched by this, and I have to move those separately.`,
    },
];
/** Every tool name any prompt tells the model to call. Asserted against TOOL_NAMES. */
export const PROMPTS_REFERENCE_TOOLS = [...new Set(PROMPTS.flatMap((p) => p.tools))];
export function getPrompt(name) {
    return PROMPTS.find((p) => p.name === name);
}
export function registerRiparPrompts(server) {
    for (const prompt of PROMPTS) {
        server.registerPrompt(prompt.name, { title: prompt.title, description: prompt.description, argsSchema: prompt.argsShape }, (args) => ({
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        // MCP declares prompts/get arguments as a map of strings in the
                        // protocol schema itself, so this is the wire type rather than an
                        // assumption about what a client will send.
                        text: prompt.render(args),
                    },
                },
            ],
        }));
    }
}
