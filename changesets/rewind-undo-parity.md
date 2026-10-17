---
shell: none
plugins: plugin-rewind
---

消息撤回现在会说明压缩边界：可撤回列表止于最近一次压缩，更早的消息撤回不了，`/rewind` 的列表、越界提示、选择器和确认框都会点明；撤回后的文件回退改成第一个「参与者」，其他套件插件可以通过新服务 `dsh-app-rewind-participants` 在撤回后对账自己的状态，某个参与者失败只记日志、不影响撤回和其他参与者。
Message recall now states the compaction boundary: the recallable list stops at the most recent compaction and older messages cannot be recalled, which the `/rewind` listing, its out-of-range answer, the picker and the confirmation dialog all say; the file revert is now the first participant, another suite plugin reconciles its own state after a recall through the new `dsh-app-rewind-participants` service, and a participant that fails is only logged — the recall and the other participants are unaffected.
