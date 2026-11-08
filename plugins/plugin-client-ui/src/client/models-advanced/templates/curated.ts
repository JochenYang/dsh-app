/**
 * Curated provider presets: the ones the picker shows by default.
 *
 * Ported from dsh-provider-studio v1.3.1 (MIT); directory data from models.dev
 * (https://github.com/sst/models-dev, MIT): names, API roots and protocol
 * mapping (`openai-chat-completions` → `openai-completions`;
 * responses/anthropic unchanged). Providers that need a non-OpenAI-compatible
 * SDK (Google, Bedrock, Azure, …) are excluded: llm-pi-ai only speaks the three
 * protocols above.
 *
 * `label` is the picker text and `displayName` the provider name a template
 * creates; both are English source strings. Entries whose Chinese copy differs
 * carry an `i18n` map pointing at `tpl.<id>.<field>` dictionary keys.
 */

import type { ProviderTemplate } from './types.ts'

const COMMON = 'groupCommon'
const CN = 'groupCn'
const GLOBAL = 'groupGlobal'
const GATEWAY = 'groupGateway'

export const CURATED_TEMPLATES: readonly ProviderTemplate[] = [
  { id: 'deepseek', icon: 'deepseek', label: 'DeepSeek', group: COMMON, displayName: 'DeepSeek', api: 'openai-completions', baseURL: 'https://api.deepseek.com' },
  { id: 'zhipuai', icon: 'bigmodel', label: 'Zhipu BigModel', group: COMMON, displayName: 'Zhipu GLM', api: 'openai-completions', baseURL: 'https://open.bigmodel.cn/api/paas/v4', i18n: { label: 'tpl.zhipuai.label', displayName: 'tpl.zhipuai.displayName' } },
  { id: 'moonshotai', icon: 'moonshot', label: 'Kimi (Moonshot)', group: COMMON, displayName: 'Kimi', api: 'openai-completions', baseURL: 'https://api.moonshot.ai/v1', note: 'Use api.moonshot.cn for the China site', i18n: { label: 'tpl.moonshotai.label', note: 'tpl.moonshotai.note' } },
  { id: 'minimax', icon: 'minimax', label: 'MiniMax', group: COMMON, displayName: 'MiniMax', api: 'anthropic-messages', baseURL: 'https://api.minimax.io/anthropic', note: 'Use api.minimaxi.com/anthropic for the China site', i18n: { note: 'tpl.minimax.note' } },
  { id: 'alibaba-cn', icon: 'alibaba', label: 'Alibaba Cloud Bailian (China)', group: COMMON, displayName: 'Alibaba Cloud Bailian', api: 'openai-completions', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', i18n: { label: 'tpl.alibaba-cn.label', displayName: 'tpl.alibaba-cn.displayName' } },
  { id: 'openai', icon: 'openai', label: 'OpenAI', group: COMMON, displayName: 'OpenAI', api: 'openai-responses', baseURL: 'https://api.openai.com/v1' },
  { id: 'anthropic', icon: 'anthropic', label: 'Anthropic', group: COMMON, displayName: 'Anthropic', api: 'anthropic-messages', baseURL: 'https://api.anthropic.com' },
  { id: 'xai', icon: 'xai', label: 'xAI', group: COMMON, displayName: 'xAI', api: 'openai-responses', baseURL: 'https://api.x.ai/v1' },
  { id: 'openrouter', icon: 'openrouter', label: 'OpenRouter', group: COMMON, displayName: 'OpenRouter', api: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1' },
  { id: 'commandcode', icon: 'commandcode', label: 'Command Code', group: COMMON, displayName: 'Command Code', api: 'openai-completions', baseURL: 'https://api.commandcode.ai/provider/v1' },
  { id: 'opencode', icon: 'opencode', label: 'OpenCode', group: COMMON, displayName: 'OpenCode', api: 'openai-completions', baseURL: 'https://opencode.ai/inference/openai/v1' },
  { id: 'siliconflow-cn', icon: 'siliconflow', label: 'SiliconFlow (China)', group: COMMON, displayName: 'SiliconFlow', api: 'openai-completions', baseURL: 'https://api.siliconflow.cn/v1', i18n: { label: 'tpl.siliconflow-cn.label', displayName: 'tpl.siliconflow-cn.displayName' } },
  { id: 'zai', icon: 'zai', label: 'Z.ai', group: CN, displayName: 'Z.ai', api: 'openai-completions', baseURL: 'https://api.z.ai/api/paas/v4' },
  { id: 'alibaba', icon: 'alibaba', label: 'Alibaba Cloud Bailian (Global)', group: CN, displayName: 'Alibaba Cloud Bailian Global', api: 'openai-completions', baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', i18n: { label: 'tpl.alibaba.label', displayName: 'tpl.alibaba.displayName' } },
  { id: 'siliconflow', icon: 'siliconflow', label: 'SiliconFlow (Global)', group: CN, displayName: 'SiliconFlow Global', api: 'openai-completions', baseURL: 'https://api.siliconflow.com/v1', i18n: { label: 'tpl.siliconflow.label', displayName: 'tpl.siliconflow.displayName' } },
  { id: 'stepfun', icon: 'stepfun', label: 'StepFun', group: CN, displayName: 'StepFun', api: 'openai-completions', baseURL: 'https://api.stepfun.com/v1', i18n: { label: 'tpl.stepfun.label', displayName: 'tpl.stepfun.displayName' } },
  { id: 'sensenova', icon: 'sensenova', label: 'SenseNova', group: CN, displayName: 'SenseNova', api: 'openai-completions', baseURL: 'https://token.sensenova.cn/v1', i18n: { label: 'tpl.sensenova.label', displayName: 'tpl.sensenova.displayName' } },
  { id: 'volcengine', icon: 'volcengine', label: 'Volcengine Ark', group: CN, displayName: 'Volcengine Ark', api: 'openai-completions', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', i18n: { label: 'tpl.volcengine.label', displayName: 'tpl.volcengine.displayName' } },
  { id: 'qiniu-ai', icon: 'qiniu', label: 'Qiniu Cloud', group: CN, displayName: 'Qiniu Cloud', api: 'openai-completions', baseURL: 'https://api.qnaigc.com/v1', i18n: { label: 'tpl.qiniu-ai.label', displayName: 'tpl.qiniu-ai.displayName' } },
  { id: 'modelscope', icon: 'modelscope', label: 'ModelScope', group: CN, displayName: 'ModelScope', api: 'openai-completions', baseURL: 'https://api-inference.modelscope.cn/v1' },
  { id: 'tencent', icon: 'tencent', label: 'Tencent TokenHub (China)', group: CN, displayName: 'Tencent TokenHub', api: 'openai-completions', baseURL: 'https://tokenhub.tencentmaas.com/v1', i18n: { label: 'tpl.tencent.label', displayName: 'tpl.tencent.displayName' } },
  { id: 'tencent-intl', icon: 'tencent', label: 'Tencent TokenHub (Singapore)', group: CN, displayName: 'Tencent TokenHub Global', api: 'openai-completions', baseURL: 'https://tokenhub-intl.tencentmaas.com/v1', i18n: { label: 'tpl.tencent-intl.label', displayName: 'tpl.tencent-intl.displayName' } },
  { id: 'xiaomi-mimo', icon: 'xiaomi', label: 'Xiaomi MiMo', group: CN, displayName: 'MiMo', api: 'anthropic-messages', baseURL: 'https://api.xiaomimimo.com/anthropic' },
  { id: 'mistral', icon: 'mistral', label: 'Mistral', group: GLOBAL, displayName: 'Mistral', api: 'openai-completions', baseURL: 'https://api.mistral.ai/v1' },
  { id: 'groq', icon: 'groq', label: 'Groq', group: GLOBAL, displayName: 'Groq', api: 'openai-completions', baseURL: 'https://api.groq.com/openai/v1' },
  { id: 'cohere', icon: 'cohere', label: 'Cohere', group: GLOBAL, displayName: 'Cohere', api: 'openai-completions', baseURL: 'https://api.cohere.ai/compatibility/v1' },
  { id: 'togetherai', icon: 'together', label: 'Together AI', group: GLOBAL, displayName: 'Together AI', api: 'openai-completions', baseURL: 'https://api.together.xyz/v1' },
  { id: 'deepinfra', icon: 'deepinfra', label: 'DeepInfra', group: GLOBAL, displayName: 'DeepInfra', api: 'openai-completions', baseURL: 'https://api.deepinfra.com/v1/openai' },
  { id: 'fireworks-ai', icon: 'fireworks', label: 'Fireworks AI', group: GLOBAL, displayName: 'Fireworks AI', api: 'openai-completions', baseURL: 'https://api.fireworks.ai/inference/v1/' },
  { id: 'perplexity', icon: 'perplexity', label: 'Perplexity', group: GLOBAL, displayName: 'Perplexity', api: 'openai-completions', baseURL: 'https://api.perplexity.ai' },
  { id: 'cerebras', icon: 'cerebras', label: 'Cerebras', group: GLOBAL, displayName: 'Cerebras', api: 'openai-completions', baseURL: 'https://api.cerebras.ai/v1' },
  { id: 'sambanova', icon: 'sambanova', label: 'SambaNova', group: GLOBAL, displayName: 'SambaNova', api: 'openai-completions', baseURL: 'https://api.sambanova.ai/v1' },
  { id: 'novita-ai', icon: 'novita', label: 'Novita AI', group: GLOBAL, displayName: 'Novita AI', api: 'openai-completions', baseURL: 'https://api.novita.ai/openai' },
  { id: 'nebius', icon: 'nebius', label: 'Nebius', group: GLOBAL, displayName: 'Nebius', api: 'openai-completions', baseURL: 'https://api.tokenfactory.nebius.com/v1' },
  { id: 'huggingface', icon: 'huggingface', label: 'Hugging Face', group: GLOBAL, displayName: 'Hugging Face', api: 'openai-completions', baseURL: 'https://router.huggingface.co/v1' },
  { id: 'nvidia', icon: 'nvidia', label: 'NVIDIA', group: GLOBAL, displayName: 'NVIDIA', api: 'openai-completions', baseURL: 'https://integrate.api.nvidia.com/v1' },
  { id: 'github-copilot', icon: 'copilot', label: 'GitHub Copilot', group: GLOBAL, displayName: 'GitHub Copilot', api: 'openai-completions', baseURL: 'https://api.githubcopilot.com' },
  { id: '302ai', icon: '302ai', label: '302.AI', group: GATEWAY, displayName: '302.AI', api: 'openai-completions', baseURL: 'https://api.302.ai/v1' },
  { id: 'aihubmix', icon: 'aihubmix', label: 'AIHubMix', group: GATEWAY, displayName: 'AIHubMix', api: 'openai-completions', baseURL: 'https://aihubmix.com/v1' },
  { id: 'zenmux', icon: 'zenmux', label: 'ZenMux', group: GATEWAY, displayName: 'ZenMux', api: 'openai-completions', baseURL: 'https://zenmux.ai/api/v1' },
  { id: 'kilo', icon: 'kilo', label: 'Kilo Code', group: GATEWAY, displayName: 'Kilo Code', api: 'openai-completions', baseURL: 'https://api.kilo.ai/api/gateway' },
  { id: 'aimlapi', icon: 'aimlapi', label: 'AI/ML API', group: GATEWAY, displayName: 'AI/ML API', api: 'openai-completions', baseURL: 'https://api.aimlapi.com/v1' },
  { id: 'poe', icon: 'poe', label: 'Poe', group: GATEWAY, displayName: 'Poe', api: 'openai-completions', baseURL: 'https://api.poe.com/v1' },
  { id: 'llmgateway', icon: 'llmgateway', label: 'LLM Gateway', group: GATEWAY, displayName: 'LLM Gateway', api: 'openai-completions', baseURL: 'https://api.llmgateway.io/v1' },
  { id: 'opencode-go', icon: 'opencode', label: 'OpenCode Go', group: GATEWAY, displayName: 'OpenCode Go', api: 'openai-completions', baseURL: 'https://opencode.ai/inference/go/openai/v1' },
]
