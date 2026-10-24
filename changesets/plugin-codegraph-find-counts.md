---
shell: none
plugins: plugin-codegraph
---

`codegraph_find` 的结果现在会标出每个符号被调用多少次，让模型在花时间之前就能选对工具。此前它只能看到「这个符号在这些文件里」，不知道规模：实测一个函数有 7 处文本匹配（用搜索更快，选搜索是对的），另一个有 482 处（用搜索约要 1.5 万 token 且每行都要判断是定义还是调用），而模型两次都用搜索，因为没有任何信息告诉它问题有多大。现在超过 20 处引用会在该行直接标注建议改用 `codegraph_impact`。
`codegraph_find` results now show how many times each symbol is called, so the model can pick the right tool before spending anything. Previously it saw only where a symbol is declared, never how large the question was: measured, one function has 7 text matches (searching is cheaper and choosing it is correct) while another has 482 (searching costs about 15k tokens and a judgement per line), and the model searched both times because nothing said which was which. A symbol past 20 references is now marked on its own row with a pointer to `codegraph_impact`.
