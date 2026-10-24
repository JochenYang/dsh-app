/**
 * The two install rules BOTH the injected section and every install tool state.
 *
 * Kept as one constant because they are behaviour-sensitive (each prevents a
 * specific failure: installing something the user never asked for, and telling the
 * user an install took effect when it needs a restart) and they used to be spelled
 * twice, hand-maintained, nearly word for word:
 *
 *   section: "A successful plugin install takes effect after a restart; ... Say so in
 *             one short sentence"
 *   tool:    "A successful install needs a restart to take effect; say so in one
 *             short sentence"
 *
 * Two copies of a consent rule is exactly where a reword turns into a different
 * rule. A surface may say MORE around these (the tool explains its arguments, the
 * section explains the catalog); none may say them differently.
 *
 * @module @dsh-app/plugin-market/install-consent
 */

/** The user decides, and must have named the package before a tool is called. */
export const INSTALL_CONSENT_RULE =
  'Installing is the user\'s decision, never yours: act only after they have named what to install, '
  + 'and name the exact package in your reply first.'

/**
 * What to tell the user after a successful install.
 *
 * A plugin needs a restart; a skill is picked up on the next scan. Saying a restart
 * is needed when it is not (or not saying it when it is) is the failure this sentence
 * exists to prevent.
 */
export const INSTALL_RESTART_RULE =
  'A successful plugin install takes effect after a restart, and a skill is picked up on the next scan. '
  + 'Say so in one short sentence, and never print install commands.'
