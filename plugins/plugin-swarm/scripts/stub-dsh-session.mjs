/**
 * Test stub for @deepseek-ai/dsh-session: the orchestrator's only runtime
 * import from it is the `SessionId` brand, which is an identity function in
 * the real kernel. The real package pulls transitive deps (dsh-scope) that
 * are not installed at the repo root, so the test bundle aliases to this.
 */
export const SessionId = (id) => id
