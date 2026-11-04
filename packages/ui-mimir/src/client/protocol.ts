/**
 * The client's own copy of the wire handshake constants (#250). Deliberately
 * NOT imported from the host package: the handshake only detects drift when
 * each side compares its own built-in version, and the client bundle purity
 * gate forbids runtime cross-package imports. Keep in lockstep with
 * `dsh-mimir/src/protocol.ts` — bump both on any incompatible contract
 * change and deploy host and panel together.
 * @module dsh-client-ui-mimir/src/client/protocol
 */

/** Wire protocol version this panel build speaks. */
export const RESEARCH_PROTOCOL_VERSION = 1

/** The handshake verdict: which side runs the newer protocol, if either does. */
export type ResearchProtocolVerdict = 'compatible' | 'host-ahead' | 'client-ahead'

/**
 * Compare the host's reported protocol version with this client's built-in
 * one. Compatible only when equal; otherwise the verdict names the side that
 * must upgrade (the side running the older version).
 * @param host - the version the host reported over `getProtocolVersion`.
 * @param client - the version this client was built against.
 * @returns the compatibility verdict.
 */
export function protocolVerdict(host: number, client: number): ResearchProtocolVerdict {
  if (host === client) return 'compatible'
  return host > client ? 'host-ahead' : 'client-ahead'
}
