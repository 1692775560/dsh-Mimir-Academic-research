/**
 * The host/client wire handshake (#250): one integer protocol version, bumped
 * on any incompatible Remote contract change, plus the pure verdict both sides
 * compute when the panel mounts. Kept DOM-free and dependency-free so the
 * client bundle can inline it and every boundary rule is unit-testable.
 * @module dsh-mimir/src/protocol
 */

/**
 * The research Remote wire protocol version. The contract is additive within
 * one version; bump this on any incompatible change and deploy host and panel
 * together.
 */
export const RESEARCH_PROTOCOL_VERSION = 1

/** The handshake verdict: which side runs the newer protocol, if either does. */
export type ResearchProtocolVerdict = 'compatible' | 'host-ahead' | 'client-ahead'

/**
 * Compare the host's reported protocol version with the client's built-in one.
 * Compatible only when equal; otherwise the verdict names the side that must
 * upgrade (the side running the older version).
 * @param host - the version the host reported over `getProtocolVersion`.
 * @param client - the version the client was built against.
 * @returns the compatibility verdict.
 */
export function protocolVerdict(host: number, client: number): ResearchProtocolVerdict {
  if (host === client) return 'compatible'
  return host > client ? 'host-ahead' : 'client-ahead'
}
