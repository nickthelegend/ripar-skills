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
export { REGISTRY_APP_IDS, ENDPOINTS, CAIP2, USDC_ASSET_ID, USDC_DECIMALS, BOX_PREFIX, JOB_STATUS, jobStatusName, resolveConfig, explorerAddressUrl, explorerAppUrl, explorerTxUrl, } from "./config.js";
export { AGENT_INFO_TYPE, SCORE_TYPE, JOB_TYPE, BID_TYPE, decodeAgentBox, decodeScoreBox, decodeJobBox, decodeBidBox, decodeUint64Box, agentBoxName, domainBoxName, addressBoxName, scoreBoxName, jobBoxName, escrowBoxName, bidBoxName, bidPrefixForJob, bidKeyFromBoxName, idFromBoxName, base32TxIdToBytes, uint64Bytes, toHex, fromHex, } from "./abi.js";
export { RiparRegistry, RiparReadError, microToUsdc, withEscrow, } from "./registry.js";
export { SKILLS, getSkill, skillInputJsonSchema, skillPriceUsdc, skillPriceTable, skillsAsCardSkills, skillsManifest, resolveAgentSkill, reputationReportSkill, settlementAuditSkill, postJobSkill, } from "./skills.js";
export { composeAppCall, composePostJob, composeFundJob, composeReleaseEscrow, composeRefundEscrow, composePlaceBid, composeAcceptBid, composeRotateAddress, hashPitch, suggestedParams, } from "./unsigned.js";
/**
 * The gap between the source tree and the chain, as callable functions.
 *
 * Exported because it is a fact about the deployment that anything building on
 * this package needs — not an internal detail of the compose path.
 */
export { CONTRACT_METHODS, MethodNotDeployedError, isMethodDeployed, assertMethodDeployed, approvalProgram, selectorOf, deploymentReport, clearDeployedCache, } from "./deployed.js";
export { agentHealth, } from "./health.js";
export { quoteEndpoint, callEndpoint, parseChallenge, challengeFromResponse, } from "./x402.js";
export * from "./a2a/index.js";
export * from "./mcp/index.js";
