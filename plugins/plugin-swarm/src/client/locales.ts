/**
 * Dictionary of the swarm settings page, in the plugin's own locale namespace.
 *
 * The namespace is declared by the client entry (`src/client.ts`, the
 * `declare module` merge into `LocaleNamespaceMap`); this module owns the
 * keys. zh is the source of truth and stays byte-identical to the pre-i18n
 * page copy; {@link SwarmKey} is its key union, and the English dictionary is
 * typed with it, so a missing or extra key on either side is a compile error.
 * The same union constrains the page's `t` seat (`TranslateNS`), so a key
 * removed from the dictionary cannot be rendered.
 *
 * `swarm.host.*` keys are the sentences for the coded failures the HOST half
 * reports (see `HostText` in `src/wire.ts`): the host sends a code plus the
 * values a sentence interpolates, never prose, and this table is where the
 * sentence lives. Sentences with inline markup would be split into
 * `…before`/`…after` fragments — none of the host codes needs one.
 *
 * @module @dsh-app/plugin-swarm/client/locales
 */

/** Locale namespace owned by this plugin's client half. */
export const NS = 'dsh-app.swarm'

/** Simplified Chinese dictionary — the pre-i18n page copy, verbatim. */
export const zh = {
  'swarm.nav': '并行子代理',
  'swarm.title': '并行子代理（Swarm）',
  'swarm.intro': '将可并行的任务拆分为多个子代理同时执行。调度参数保存后对下一次调用即时生效；启用/禁用需重启应用。 自适应调度开启时，遇到限流会自动降速、恢复后缓慢爬升，并可能在稳定时向上探测网关余量（最高 64）。',
  'swarm.toggle.enabled': '启用并行子代理（{state}）',
  'swarm.toggle.enabled.aria': '启用并行子代理',
  'swarm.toggle.enabled.hint': '禁用后 swarm 工具与 /swarm 命令不再注册，重启应用后生效',
  'swarm.toggle.adaptive': '自适应调度（{state}）',
  'swarm.toggle.adaptive.aria': '自适应调度',
  'swarm.toggle.adaptive.hint': '失败后并发自动减半、恢复后逐步爬升；关闭后并发固定为起始值',
  'swarm.state.pending': '…',
  'swarm.state.enabled': '已启用',
  'swarm.state.disabled': '已禁用',
  'swarm.state.on': '已开启',
  'swarm.state.off': '已关闭',
  'swarm.field.defaultConcurrency': '起始并发',
  'swarm.field.defaultConcurrency.hint': '批次开始时的并行子代理数',
  'swarm.field.maxConcurrency': '并发上限',
  'swarm.field.maxConcurrency.hint': '自适应恢复的稳态上限；未指定并发时池子还会向上探测（最高 64）',
  'swarm.field.maxItems': '单批任务上限',
  'swarm.field.maxItems.hint': '一次 swarm 调用最多拆分的子任务数',
  'swarm.field.startStaggerMs': '启动间隔 (ms)',
  'swarm.field.startStaggerMs.hint': '相邻子代理的启动间隔，平滑网关压力',
  'swarm.field.itemMaxRetries': '失败重试次数',
  'swarm.field.itemMaxRetries.hint': '子任务遇到限流/断流等瞬时错误时的自动重试次数',
  'swarm.field.itemRetryDelayMs': '重试退避 (ms)',
  'swarm.field.itemRetryDelayMs.hint': '首次重试的等待时间，每次翻倍',
  'swarm.field.perItemOutputLimit': '单任务结果截断',
  'swarm.field.perItemOutputLimit.hint': '每个子任务回传结果的最大字符数',
  'swarm.field.tokenBudget': '批次 token 预算',
  'swarm.field.tokenBudget.hint': '0 为不限制；达到预算后停止启动新子任务',
  'swarm.field.custom': '自定义',
  'swarm.field.default': '默认 {value}',
  'swarm.field.unsaved': '（未保存）',
  'swarm.error.notNumber': '「{label}」不是有效数字',
  'swarm.error.generic': '操作失败，请稍后重试',
  // --- Failures the HOST reports. The host sends a code plus its values (see
  // `HostText` in wire.ts); the sentences live here, and a code this build does
  // not know falls back to the host's English diagnostic. ---
  'swarm.host.unknownField': '未知配置项：{field}',
  'swarm.host.notBoolean': '配置项 {field} 的值不合法：必须为布尔值',
  'swarm.host.belowMinimum': '配置项 {field} 的值不合法：必须是不小于 {minimum} 的数字',
  'swarm.host.writeFailed': '写入配置失败，请稍后重试',
  'swarm.host.bodyTooLarge': '请求体过大（上限 8 KiB）',
  'swarm.host.invalidBody': '请求无法解析：{detail}',
  'swarm.action.save': '保存修改',
  'swarm.action.saveCount': '保存修改（{count} 项）',
  'swarm.action.resetAll': '全部恢复默认',
  'swarm.notice.saved': '已保存，下一次并行任务调用即生效',
  'swarm.notice.noOverrides': '当前没有自定义项，全部为默认值',
  'swarm.notice.resetAll': '已恢复默认值',
  'swarm.notice.enabled': '已设为启用，重启应用后生效',
  'swarm.notice.disabled': '已设为禁用，重启应用后生效',
  'swarm.notice.adaptiveOn': '已开启自适应调度，下一次调用即生效',
  'swarm.notice.adaptiveOff': '已关闭自适应调度：并发将固定为起始值，下一次调用即生效',
  'swarm.path': '配置文件：{path}',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<SwarmKey, string> = {
  'swarm.nav': 'Parallel subagents',
  'swarm.title': 'Parallel subagents (Swarm)',
  'swarm.intro': 'Splits parallelizable work across several subagents running at once. Scheduling parameters apply to the next call as soon as they are saved; enabling or disabling needs an app restart. With adaptive scheduling on, rate limiting slows the pool down automatically, recovery climbs back gradually, and a steady pool may probe the gateway for headroom (up to 64).',
  'swarm.toggle.enabled': 'Enable parallel subagents ({state})',
  'swarm.toggle.enabled.aria': 'Enable parallel subagents',
  'swarm.toggle.enabled.hint': 'When disabled, the swarm tool and the /swarm command are no longer registered; takes effect after a restart',
  'swarm.toggle.adaptive': 'Adaptive scheduling ({state})',
  'swarm.toggle.adaptive.aria': 'Adaptive scheduling',
  'swarm.toggle.adaptive.hint': 'Concurrency halves after a failure and climbs back step by step as it recovers; when off, concurrency stays at the starting value',
  'swarm.state.pending': '…',
  'swarm.state.enabled': 'Enabled',
  'swarm.state.disabled': 'Disabled',
  'swarm.state.on': 'On',
  'swarm.state.off': 'Off',
  'swarm.field.defaultConcurrency': 'Starting concurrency',
  'swarm.field.defaultConcurrency.hint': 'Parallel subagents at the start of a batch',
  'swarm.field.maxConcurrency': 'Concurrency ceiling',
  'swarm.field.maxConcurrency.hint': 'The steady-state ceiling adaptive recovery climbs back to; without an explicit concurrency the pool also probes upward (up to 64)',
  'swarm.field.maxItems': 'Items per batch',
  'swarm.field.maxItems.hint': 'The most subtasks one swarm call may split into',
  'swarm.field.startStaggerMs': 'Start stagger (ms)',
  'swarm.field.startStaggerMs.hint': 'Delay between neighbouring subagent starts, which smooths gateway pressure',
  'swarm.field.itemMaxRetries': 'Retries per item',
  'swarm.field.itemMaxRetries.hint': 'Automatic retries when a subtask hits a transient error such as rate limiting or a dropped stream',
  'swarm.field.itemRetryDelayMs': 'Retry backoff (ms)',
  'swarm.field.itemRetryDelayMs.hint': 'Wait before the first retry; doubles each time',
  'swarm.field.perItemOutputLimit': 'Result truncation per item',
  'swarm.field.perItemOutputLimit.hint': 'Maximum characters returned from each subtask',
  'swarm.field.tokenBudget': 'Batch token budget',
  'swarm.field.tokenBudget.hint': '0 means unlimited; once the budget is reached no further subtasks start',
  'swarm.field.custom': 'Custom',
  'swarm.field.default': 'Default {value}',
  'swarm.field.unsaved': ' (unsaved)',
  'swarm.error.notNumber': '"{label}" is not a valid number',
  'swarm.error.generic': 'The operation failed; try again later',
  // --- Failures the HOST reports; see the zh block above for the contract. ---
  'swarm.host.unknownField': 'Unknown configuration field: {field}',
  'swarm.host.notBoolean': 'The value of {field} is invalid: it must be a boolean',
  'swarm.host.belowMinimum': 'The value of {field} is invalid: it must be a number no smaller than {minimum}',
  'swarm.host.writeFailed': 'Could not write the configuration file; try again later',
  'swarm.host.bodyTooLarge': 'The request body is too large (8 KiB cap)',
  'swarm.host.invalidBody': 'The request could not be parsed: {detail}',
  'swarm.action.save': 'Save changes',
  'swarm.action.saveCount': 'Save changes ({count})',
  'swarm.action.resetAll': 'Reset all to defaults',
  'swarm.notice.saved': 'Saved; applies to the next parallel call',
  'swarm.notice.noOverrides': 'Nothing is customized right now — everything is at its default',
  'swarm.notice.resetAll': 'Restored the default values',
  'swarm.notice.enabled': 'Set to enabled; takes effect after an app restart',
  'swarm.notice.disabled': 'Set to disabled; takes effect after an app restart',
  'swarm.notice.adaptiveOn': 'Adaptive scheduling is on; applies to the next call',
  'swarm.notice.adaptiveOff': 'Adaptive scheduling is off: concurrency stays at the starting value and applies to the next call',
  'swarm.path': 'Configuration file: {path}',
}

/** Key domain of the `dsh-app.swarm` namespace (zh is the source of truth). */
export type SwarmKey = keyof typeof zh
