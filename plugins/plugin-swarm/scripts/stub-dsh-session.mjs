/**
 * Test stub for @deepseek-ai/dsh-session: the orchestrator's only runtime
 * import from it is the `SessionId` brand, which is an identity function in
 * the real kernel. The real package pulls transitive deps (dsh-scope) that
 * are not installed at the repo root, so the test bundle aliases to this.
 *
 * The class exports satisfy transitive value imports from the installed
 * kernel packages (dsh-subagent/dsh-tools/dsh-llm); no test constructs them.
 */
export const SessionId = (id) => id

export class Session {}

export class SessionLogOffset {}

export class SessionSeq {}
