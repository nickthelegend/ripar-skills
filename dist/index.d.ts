/**
 * @ripar/skills — Ripar's agent-interoperability layer.
 *
 * Three things in one package, because they are the same thing seen from three
 * angles:
 *
 *   - an **MCP server** so a model can drive Ripar (agent-to-tool),
 *   - an **A2A agent card** so other agents can find Ripar (agent-to-agent),
 *   - **skills**, the named, priced capabilities both of those describe.
 *
 * Everything reads registries that are live on Algorand TestNet. Nothing here
 * signs: writes come back as unsigned transactions.
 */
export { REGISTRY_APP_IDS, ENDPOINTS, CAIP2, USDC_ASSET_ID, USDC_DECIMALS, BOX_PREFIX, JOB_STATUS, jobStatusName, resolveConfig, explorerAddressUrl, explorerAppUrl, explorerTxUrl, type Network, type RiparConfig, type RiparConfigInput, type JobStatus, } from "./config.js";
export { AGENT_INFO_TYPE, SCORE_TYPE, JOB_TYPE, decodeAgentBox, decodeScoreBox, decodeJobBox, decodeUint64Box, agentBoxName, domainBoxName, addressBoxName, scoreBoxName, paidBoxName, jobBoxName, base32TxIdToBytes, uint64Bytes, toHex, fromHex, type Agent, type Score, type Job, } from "./abi.js";
export { RiparRegistry, RiparReadError, microToUsdc, type Settlement } from "./registry.js";
export { SKILLS, getSkill, skillInputJsonSchema, skillPriceUsdc, skillPriceTable, skillsAsCardSkills, skillsManifest, resolveAgentSkill, reputationReportSkill, settlementAuditSkill, postJobSkill, type Skill, type SkillContext, } from "./skills.js";
export { composeAppCall, composePostJob, suggestedParams, type UnsignedTransaction, } from "./unsigned.js";
export { quoteEndpoint, callEndpoint, parseChallenge, type Quote, type CallResult, type PaymentRequirement, type X402Challenge, } from "./x402.js";
export * from "./a2a/index.js";
export * from "./mcp/index.js";
