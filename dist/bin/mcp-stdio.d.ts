#!/usr/bin/env node
/**
 * stdio entry point. This is the path that goes in claude_desktop_config.json.
 *
 * stdout carries the MCP protocol, so every diagnostic goes to stderr. A stray
 * console.log here corrupts the JSON-RPC stream and the client reports the
 * server as broken with no hint as to why.
 */
export {};
