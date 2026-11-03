/**
 * Skill installation — the seat contract a Creator session reads.
 *
 * The workbench is the one surface the kernel's Creator mode has no opening
 * prompt for, and it is also the only surface whose extension seats are ours.
 * An agent asked to "put a card in the workbench" needs three facts it cannot
 * guess (the two seat names, that a card's `id` and its page's `key` must be the
 * same constant, and that the container owns the frame) plus one fact about
 * lifetime (a card mounted this way is session-scoped). Those live here.
 *
 * WHY A SKILL AND NOT THE PROMPT. The opening prompt is one sentence
 * (`client/create.ts`); the contract is a page. A prompt that tried to carry it
 * would be a second copy of a declaration that moves with the container, and it
 * would drift silently — the prompt would keep sending agents to a seat that
 * changed shape. A skill is versioned with this plugin, discoverable by the
 * agent, and re-installed on every mount.
 *
 * WHY THE BODY REPRODUCES THE DECLARATION, AND MUST NOT POINT AT ONE. A Creator
 * session runs in whatever folder the user opened, which is usually not this
 * repository, and an installed app is built output — no `SlotMap` types on disk
 * anywhere. A body that said "the block is in plugins/…/src/client.ts" sent a
 * measured session looking for a source tree that was not there, into a build
 * artefact and two unrelated repositories, and it reached a card only after
 * fifty tool calls. So the body carries the block itself, and `tests/skill.test.ts`
 * compares it byte-for-byte against the container's copy: a repository path in
 * the BODY is now a defect, because the body has to be self-contained on a
 * machine with no checkout.
 *
 * The kernel exposes no skill-registry seam this plugin can call, so the skill
 * materializes as a `SKILL.md` under `$DSH_HOME/skills/<name>/` — the
 * conventional discovery location — written at plugin mount. The write is
 * content-compared and skipped when unchanged, so repeated boots never touch the
 * file, and `writeFileAtomic` is what makes a crash leave either the old file or
 * the new one, never half of either.
 *
 * A file already sitting at our name whose body is NOT ours is left alone and
 * reported. `dsh-app-workbench-card` is a legal market slug, so a user can
 * install somebody else's skill into the same directory; overwriting it would be
 * data loss on every start. Ownership is judged by the seat names in the body —
 * a directory that names neither of our seats is not this plugin's to replace.
 *
 * @module @dsh-app/plugin-workbench/skill
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { WORKBENCH_SKILL_NAME } from './contract.ts'

/**
 * The skill's directory name under `$DSH_HOME/skills/`.
 *
 * The same value the Creator prompt tells the agent to load — one constant in
 * `contract.ts` rather than a literal here and another in the client half.
 */
export const SKILL_NAME = WORKBENCH_SKILL_NAME

/** What one install pass did. */
export type SkillInstallResult = 'installed' | 'unchanged' | 'kept-foreign'

/**
 * The skill body (English: this half writes no Han characters, and the reader is
 * the model, not the user).
 *
 * Every backtick is escaped — this text is a template literal, so a bare one
 * would end it mid-file and the module would not parse.
 */
export const SKILL_MARKDOWN = `---
name: ${SKILL_NAME}
description: Register a card into the DSH APP workbench, with an optional page of its own. Load this before writing a plugin whose surface is a workbench card.
---

# Workbench card contract (${SKILL_NAME})

The DSH APP workbench is a container page: a grid of cards, one per domain, and one page behind each card. A plugin joins it by registering into the container's two seats. Everything else about the container is not yours to change.

THE WHOLE CONTRACT IS IN THIS DOCUMENT. The container declares its two seats, and both declarations are reproduced below in full and verbatim. There is no source tree to open and no file to go and find: this skill is installed beside the application, which ships as built output — searching the disk for these seats returns either nothing or a build artefact. If you need to read a runtime SERVICE, \`cordis_inspect_list\` and \`cordis_inspect_query\` are the tools; they will not have the seats, because the seats are the block below.

WHAT THIS SKILL DOES NOT COVER. Packaging and mounting a dynamic plugin, a plugin's own storage, and its host route are outside this one, and each of the three has a named answer in the section of that name below. Read that section before you go looking for anything else; it is short, and it exists because two measured sessions spent their first forty to fifty tool calls reading build files and unrelated repositories instead of writing the card.

## The two seats

- \`workbench.item\` — the card grid. A list seat, root-scoped, one entry per card.
- \`workbench.view\` — the page behind a card. A keyed seat, root-scoped, rendered only while that card's view is open.

Both are root-scoped: a card exists before any conversation does, so a card must not assume a current session. A card that needs a workspace asks the container for one through the owner props it receives, instead of resolving those services itself — those three props are listed below.

## The declaration, in full — paste it, do not retype it

The seats are DECLARED by the container; a card only fills them. The block below is that declaration, wrapping itself in \`declare module\` so it can be pasted into your plugin's client module as-is. Copy it unchanged:

\`\`\`ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
  // BEGIN workbench-card-slot — a domain card repeats this block VERBATIM.
  // The suite ships no shared package and this plugin publishes no types, so a
  // card has nothing to import: the declaration and the owner-props interface
  // are copied by hand, and a misspelt field would leave both sides compiling
  // while the card disappears into the outlet's error boundary at run time. The
  // markers are what a drift test will compare once the first real card lands.
  interface SlotMap {
    /** One card per domain workbench, ordered by the registration's \`order\`. */
    'workbench.item': {
      kind: 'list'
      scope: 'root'
      owner: WorkbenchCardOwnerProps
    }
    /** A domain's own page, addressed by the card's registered \`id\`. */
    'workbench.view': {
      kind: 'keyed'
      scope: 'root'
    }
  }
  // END workbench-card-slot
}
\`\`\`

## The props the container hands your card

Your card component is handed these three props by the container, and it must declare them by these names (the framework adds the \`t\` seat on top when your registration declares \`locale:\`). Give each one the type your component needs; do not invent a fourth.

- \`openView(viewId)\` — show the view registered under that id; a no-op when nothing registered it, so a card with no page never needs to know.
- \`enterWorkspace(path)\` — register a folder as a workspace and open it, leaving for the Conversation; it never rejects and answers a status token instead.
- \`entryMessage(status)\` — the container's own sentence for a problem token, so a card renders the container's words rather than inventing its own.

## Three things must hold

1. **One constant for both registrations.** The card registers with \`id\`, the page registers with \`key\`, and both must be the SAME string. Nothing in the type system relates a list id to a keyed key, and the container reads only \`key\` when the card is pressed — so a mismatch is silent: the card renders, and pressing it does nothing at all.

2. **\`order\` decides card order.** The grid sorts ascending, and an omitted order counts as 0. Pick a number; do not rely on registration order to place the card.

3. **The container owns the frame.** The card border, its hover lift, the back control, Escape and focus-on-open all belong to the container. A card owns its content; a page owns everything inside the view body. Do not draw a second frame, a second back button, or your own Escape handling.

## What a card must render

ONE root element. The frame is a CSS rule on the seat's children, so a card that renders a fragment or several roots is drawn as several bordered boxes, and a card that renders \`null\` is invisible.

Entry points inside a card must be real \`button\` elements (or carry a role plus their own key handling): the container renders the entries of a seat it does not own, and it gets no per-entry wrapper to hang a handler on.

## How to register

Both registrations go through the client's slot service, which a dynamically mounted plugin receives as \`ctx.slots\`. Add \`locale: <namespace>\` when your copy lives in a dictionary, and register that dictionary first.

\`\`\`js
const CARD_ID = 'my-domain'
ctx.slots.inject('workbench.item', () => ctx.slots.register({
  name: 'workbench.item', id: CARD_ID, order: 10,
}, MyCard))
ctx.slots.inject('workbench.view', () => ctx.slots.register({
  name: 'workbench.view', key: CARD_ID,
}, MyPage))
\`\`\`

Nothing else needs copying: between the declaration above and these two calls, the contract is complete.

## What this skill does not cover

This skill owns THE SEATS, and only the seats. Three things a working card usually needs sit outside it, and each has an answer that does not involve reading a source tree:

- **Packaging and mounting a dynamic plugin** — how the bundle is built, which file declares it, what the loader mounts — belongs to the \`cordis-plugin-development\` skill. Load that one for it, and use \`cordis_inspect_list\` / \`cordis_inspect_query\` for the live picture. Do not reverse-engineer the shape from the running application's own build files.
- **A plugin's own data** goes under \`$DSH_HOME/storages/<plugin-name>/\`: one JSON file per plugin is the usual shape, written atomically — a temporary file in the same directory, then a rename over the target — so a crash leaves the old file or the new one, never half of either.
- **A host route** is registered with \`ctx.connection.fetch.register\` and answers under \`/api/plugins/<your-plugin-id>/<name>\` — choose a stable segment of your own. The carrier reserves only the \`/api\` base; \`dsh-app\` is the installed suite's own scope and is NOT a requirement for you. You do not open a port or run a server of your own: the connection carrier applies the host and origin fence plus browser authentication before your handler runs, and only GET, HEAD and POST are admitted.

## The one example worth reading, and when it exists

The workbench's first domain is the task board, \`plugin-todo\`, and a working card from registration to view is fastest to see there. One command decides whether you may read it. \`$DSH_PROFILE_DIR\` below means the profile directory of the session you are running in — profiles live under \`$DSH_HOME/profiles/<profile-name>/\`, so that entry, not a guess and not a search:

- \`$DSH_PROFILE_DIR/node_modules/@dsh-app/plugin-todo/src\` — if that path exists, it is the version the application is running right now. Read it.
- If it does not exist, this installation is packaged: that package ships its built output and not its sources. There is NOTHING to read on this machine, so stop looking and write the card from this document instead.

## Do not go hunting on disk

A Creator session runs in whatever folder the user opened, which is usually not the application's own repository, and what gets installed is built output. A checkout of this suite, if the machine happens to have one, is a different version — the mounting shape you learn there may not be the one in force, and copying a file out of the profile into your own plugin ships a version nobody chose. Measured twice: sessions spent their first forty to fifty tool calls reading build files, plugin sources, other repositories and profile directories, and reached a first write only after that. The seats are above and complete; the section above is the rest; \`cordis_inspect_list\` and \`cordis_inspect_query\` answer questions about live services. That is the whole search surface.

## Lifetime

The card is registered by a plugin mounted for this session only: it is gone after a restart, and nothing about it is persisted. Do not write state on the assumption that the card outlives the session, and do not tell the user it will. A card that must survive a restart is an installed plugin, which is a different action the user takes explicitly.
`

/** Where the skill file lands under the harness home. */
export function skillFilePath(dshHome: string): string {
  return join(dshHome, 'skills', SKILL_NAME, 'SKILL.md')
}

/**
 * Text only this plugin's own body carries.
 *
 * The two seat names are the body's own subject: a directory whose `SKILL.md`
 * names neither of them is somebody else's skill that happens to share the
 * slug. The install path judges ownership by content for that reason instead of
 * "a file sits at our name, so overwrite it".
 */
const OWN_SKILL_MARKERS = ['workbench.item', 'workbench.view'] as const

/**
 * Whether a `SKILL.md` body was written by this plugin.
 * @param body - the file's text.
 */
function isOwnSkillBody(body: string): boolean {
  return OWN_SKILL_MARKERS.some((marker) => body.includes(marker))
}

/**
 * Install (or refresh) the skill file.
 *
 * Content-compared, so an unchanged boot does not rewrite it and two applies in
 * one process cannot produce a second file or a half-written one. A file at our
 * name whose body is NOT ours is left untouched and reported.
 *
 * @param dshHome - the harness home the skill lands under.
 * @returns what happened.
 */
export async function installSkill(dshHome: string): Promise<SkillInstallResult> {
  const file = skillFilePath(dshHome)
  let current: string | undefined
  try {
    current = await readFile(file, 'utf8')
  } catch {
    // Absent or unreadable → treat as a fresh install. The write either
    // succeeds or throws; there is no degraded path that leaves a stub.
  }
  if (current === SKILL_MARKDOWN) return 'unchanged'
  if (current !== undefined && !isOwnSkillBody(current)) return 'kept-foreign'
  // mkdir is implied by writeFileAtomic's parent creation.
  await writeFileAtomic(file, SKILL_MARKDOWN, { mode: 0o644 })
  return 'installed'
}
