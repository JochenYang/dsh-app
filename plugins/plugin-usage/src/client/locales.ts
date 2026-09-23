/**
 * Dictionary of the 用量统计 page (the first tab of 维护), in the plugin's own
 * locale namespace.
 *
 * The namespace is declared by the client entry (`src/client.ts`, the
 * `declare module` merge into `LocaleNamespaceMap`); this module owns the
 * keys. One namespace per plugin, because a namespace has exactly one owner,
 * and every key carries a surface prefix (`card.`, `balance.`, `cal.`,
 * `trend.`, `models.`) so two surfaces never collide.
 *
 * zh is the source of truth and stays byte-identical to the pre-i18n page
 * copy; {@link UsageKey} is its key union, and the English dictionary is typed
 * with it, so a missing or extra key on either side is a compile error. The
 * same union constrains the page's `t` seat (`PropsLocale`), so a key removed
 * from the dictionary cannot be rendered.
 *
 * Host facts (model names, the balance figures) are NOT here: the host writes
 * those and the page shows them verbatim. A host FAILURE is different: it
 * crosses as a code plus the values a sentence interpolates (see `HostText` in
 * `src/types.ts`), and the `usage.host.*` keys below are its sentences. The
 * rest is the page's own copy — including its empty, loading, disabled and
 * failure wording.
 *
 * @module @dsh-app/plugin-usage/client/locales
 */

/** Locale namespace owned by this plugin's client half. */
export const NS = 'dsh-app.usage'

/** Simplified Chinese dictionary — the pre-i18n page copy, verbatim. */
export const zh = {
  'usage.title': '用量统计',
  'usage.tabs.aria': '统计区间',
  'usage.tabs.days': '{days}天',
  'usage.refresh': '刷新',
  'usage.autoRefresh': '自动刷新',
  'usage.loading': '加载中…',
  'usage.loadFailed': '加载失败：{message}',
  'usage.empty': '暂无用量数据',
  'usage.disabled': '内置用量统计已在插件配置中停用（enabled=false）。该值保存在当前 profile 的 cordis.patch.yml 里 id: usage 那一行；把该行的 enabled 改为 true（或删除该行）后重启即可恢复。',
  'usage.error.unknown': '未知错误',
  // --- Failures the HOST reports. The host sends a code plus its values (see
  // `HostText` in types.ts); the sentences live here, and a code this build
  // does not know falls back to the host's English diagnostic. ---
  'usage.host.disabled': '内置用量统计已在插件配置中停用',
  'usage.host.balanceMissingCredential': '未配置 DeepSeek API Key，请先在设置 → 模型页配置',
  'usage.host.balanceInvalidCredential': 'DeepSeek API Key 无效，请检查设置 → 模型页的配置',
  'usage.host.balanceUpstream': '查询余额失败，请稍后重试',
  'usage.host.balanceUpstreamHttp': '查询 DeepSeek 余额失败（HTTP {status}），请稍后重试',
  'usage.host.balanceUpstreamTimeout': '查询 DeepSeek 余额失败（请求超时），请稍后重试',
  'usage.host.balanceUpstreamNetwork': '查询 DeepSeek 余额失败（网络错误），请稍后重试',

  'usage.card.requests': '请求数',
  'usage.card.totalTokens': '总 tokens',
  'usage.card.totalTokensHint': '输入+输出+缓存读写',
  'usage.card.inputTokens': '输入 tokens（未命中缓存）',
  'usage.card.outputTokens': '输出 tokens',
  'usage.card.cacheHitRate': '缓存命中率',
  'usage.card.cacheHint': '{read} 读 / {miss} 未命中',
  'usage.card.cacheReadTokens': '缓存读 tokens',
  'usage.card.cacheWriteTokens': '缓存写 tokens',
  'usage.card.reasoningTokens': '推理 tokens',
  'usage.card.cost': '估算成本',
  'usage.card.costHintPriced': '仅 DeepSeek 官方 API · 分时价估算',
  'usage.card.costHintUnpriced': '未配置定价',

  'usage.balance.label': 'API 余额',
  'usage.balance.querying': '查询中…',
  'usage.balance.failed': '查询失败',
  'usage.balance.detail': '赠金 {granted} · 充值 {toppedUp}',
  'usage.balance.idle': '点击查询 DeepSeek 官方账户',
  'usage.balance.queriedAt': ' · {time} 查询',
  'usage.balance.aria': '查询 DeepSeek 官方账户余额',

  'usage.cal.m.1': '1月',
  'usage.cal.m.2': '2月',
  'usage.cal.m.3': '3月',
  'usage.cal.m.4': '4月',
  'usage.cal.m.5': '5月',
  'usage.cal.m.6': '6月',
  'usage.cal.m.7': '7月',
  'usage.cal.m.8': '8月',
  'usage.cal.m.9': '9月',
  'usage.cal.m.10': '10月',
  'usage.cal.m.11': '11月',
  'usage.cal.m.12': '12月',
  'usage.cal.title': 'Token 活动（最近 {weeks} 周{range}）',
  'usage.cal.titleRange': ' · {since} ~ {until}',
  'usage.cal.colorBy': '着色依据：{metric}',
  'usage.cal.total': '窗口合计 {tokens}',
  'usage.cal.modeAria': '热力图粒度',
  'usage.cal.modeDay': '每日',
  'usage.cal.modeWeek': '每周',
  'usage.cal.modeCumulative': '累计',
  'usage.cal.activeDays': '活跃天数',
  'usage.cal.days': '{count} 天',
  'usage.cal.bestDay': '单日最高',
  'usage.cal.less': '少',
  'usage.cal.more': '多',
  'usage.cal.tipRequests': '请求 {requests} · 总 tokens {tokens}',
  'usage.cal.tipHitRate': '缓存命中率 {rate}',
  'usage.cal.tipWeekTotal': '本周合计 {tokens}',
  'usage.cal.tipCumulative': '累计 {tokens}',

  'usage.trend.title': '每日趋势（近 {days} 天{weekly}）',
  'usage.trend.weekly': '，按周聚合',
  'usage.trend.aria': '每日用量趋势',
  'usage.metric.aria': '趋势指标',
  'usage.metric.tokens': 'Tokens',
  'usage.metric.requests': '请求数',
  'usage.metric.cost': '成本',
  'usage.seg.cacheRead': '缓存读',
  'usage.seg.input': '输入',
  'usage.seg.cacheWrite': '缓存写',
  'usage.seg.output': '输出',
  'usage.tip.requestsHit': '请求 {requests} · 命中率 {rate}',
  'usage.tip.inputCacheRead': '输入 {input} · 缓存读 {cacheRead}',
  'usage.tip.cacheWriteOutput': '缓存写 {cacheWrite} · 输出 {output}',
  'usage.tip.cost': '成本 {cost}',
  'usage.tip.requests': '请求 {requests}',
  'usage.tip.hitRate': '命中率 {rate}',

  'usage.models.title': '按模型用量（近 {days} 天）',
  'usage.models.empty': '暂无数据',
  'usage.col.model': '模型',
  'usage.col.requests': '请求',
  'usage.col.input': '输入',
  'usage.col.output': '输出',
  'usage.col.cacheRead': '缓存读',
  'usage.col.cacheWrite': '缓存写',
  'usage.col.hitRate': '命中率',
  'usage.col.cost': '成本',
  'usage.col.share': '占比',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<UsageKey, string> = {
  'usage.title': 'Usage statistics',
  'usage.tabs.aria': 'Statistics range',
  'usage.tabs.days': '{days}d',
  'usage.refresh': 'Refresh',
  'usage.autoRefresh': 'Auto-refresh',
  'usage.loading': 'Loading…',
  'usage.loadFailed': 'Load failed: {message}',
  'usage.empty': 'No usage data',
  'usage.disabled': 'The built-in usage statistics are switched off in the plugin configuration (enabled=false). The value lives in the current profile\'s cordis.patch.yml, in the id: usage row; set its enabled to true (or remove the row) and restart to restore collection.',
  'usage.error.unknown': 'unknown error',
  // --- Failures the HOST reports; see the zh block above for the contract. ---
  'usage.host.disabled': 'The built-in usage statistics are switched off in the plugin configuration',
  'usage.host.balanceMissingCredential': 'No DeepSeek API key is configured; set one on the Models settings page first',
  'usage.host.balanceInvalidCredential': 'The DeepSeek API key is invalid; check the configuration on the Models settings page',
  'usage.host.balanceUpstream': 'Could not query the balance; try again later',
  'usage.host.balanceUpstreamHttp': 'Could not query the DeepSeek balance (HTTP {status}); try again later',
  'usage.host.balanceUpstreamTimeout': 'Could not query the DeepSeek balance (the request timed out); try again later',
  'usage.host.balanceUpstreamNetwork': 'Could not query the DeepSeek balance (network error); try again later',

  'usage.card.requests': 'Requests',
  'usage.card.totalTokens': 'Total tokens',
  'usage.card.totalTokensHint': 'input + output + cache read/write',
  'usage.card.inputTokens': 'Input tokens (cache miss)',
  'usage.card.outputTokens': 'Output tokens',
  'usage.card.cacheHitRate': 'Cache hit rate',
  'usage.card.cacheHint': '{read} read / {miss} miss',
  'usage.card.cacheReadTokens': 'Cache-read tokens',
  'usage.card.cacheWriteTokens': 'Cache-write tokens',
  'usage.card.reasoningTokens': 'Reasoning tokens',
  'usage.card.cost': 'Estimated cost',
  'usage.card.costHintPriced': 'DeepSeek official API only · time-of-day pricing estimate',
  'usage.card.costHintUnpriced': 'No pricing configured',

  'usage.balance.label': 'API balance',
  'usage.balance.querying': 'Querying…',
  'usage.balance.failed': 'Query failed',
  'usage.balance.detail': 'Granted {granted} · topped up {toppedUp}',
  'usage.balance.idle': 'Click to query the DeepSeek account',
  'usage.balance.queriedAt': ' · queried {time}',
  'usage.balance.aria': 'Query the DeepSeek account balance',

  'usage.cal.m.1': 'Jan',
  'usage.cal.m.2': 'Feb',
  'usage.cal.m.3': 'Mar',
  'usage.cal.m.4': 'Apr',
  'usage.cal.m.5': 'May',
  'usage.cal.m.6': 'Jun',
  'usage.cal.m.7': 'Jul',
  'usage.cal.m.8': 'Aug',
  'usage.cal.m.9': 'Sep',
  'usage.cal.m.10': 'Oct',
  'usage.cal.m.11': 'Nov',
  'usage.cal.m.12': 'Dec',
  'usage.cal.title': 'Token activity (last {weeks} weeks{range})',
  'usage.cal.titleRange': ' · {since} ~ {until}',
  'usage.cal.colorBy': 'Colored by: {metric}',
  'usage.cal.total': 'Window total {tokens}',
  'usage.cal.modeAria': 'Heatmap granularity',
  'usage.cal.modeDay': 'Daily',
  'usage.cal.modeWeek': 'Weekly',
  'usage.cal.modeCumulative': 'Cumulative',
  'usage.cal.activeDays': 'Active days',
  'usage.cal.days': '{count} days',
  'usage.cal.bestDay': 'Busiest day',
  'usage.cal.less': 'Less',
  'usage.cal.more': 'More',
  'usage.cal.tipRequests': 'Requests {requests} · total tokens {tokens}',
  'usage.cal.tipHitRate': 'Cache hit rate {rate}',
  'usage.cal.tipWeekTotal': 'Week total {tokens}',
  'usage.cal.tipCumulative': 'Cumulative {tokens}',

  'usage.trend.title': 'Daily trend (last {days} days{weekly})',
  'usage.trend.weekly': ', aggregated by week',
  'usage.trend.aria': 'Daily usage trend',
  'usage.metric.aria': 'Trend metric',
  'usage.metric.tokens': 'Tokens',
  'usage.metric.requests': 'Requests',
  'usage.metric.cost': 'Cost',
  'usage.seg.cacheRead': 'Cache read',
  'usage.seg.input': 'Input',
  'usage.seg.cacheWrite': 'Cache write',
  'usage.seg.output': 'Output',
  'usage.tip.requestsHit': 'Requests {requests} · hit rate {rate}',
  'usage.tip.inputCacheRead': 'Input {input} · cache read {cacheRead}',
  'usage.tip.cacheWriteOutput': 'Cache write {cacheWrite} · output {output}',
  'usage.tip.cost': 'Cost {cost}',
  'usage.tip.requests': 'Requests {requests}',
  'usage.tip.hitRate': 'Hit rate {rate}',

  'usage.models.title': 'Usage by model (last {days} days)',
  'usage.models.empty': 'No data',
  'usage.col.model': 'Model',
  'usage.col.requests': 'Requests',
  'usage.col.input': 'Input',
  'usage.col.output': 'Output',
  'usage.col.cacheRead': 'Cache read',
  'usage.col.cacheWrite': 'Cache write',
  'usage.col.hitRate': 'Hit rate',
  'usage.col.cost': 'Cost',
  'usage.col.share': 'Share',
}

/** Key domain of the `dsh-app.usage` namespace (zh is the source of truth). */
export type UsageKey = keyof typeof zh
