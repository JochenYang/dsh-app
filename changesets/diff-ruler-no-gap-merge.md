---
shell: none
plugins: plugin-sidebar
---

Git 面板的变更标尺不再把两段改动之间的未改动行算进色块长度。原来相距不足 4 行的两段改动会合并成一个色块，把中间的空白也涂成「已改动」——一段三行的修改看起来和一大段一样长。现在每段连续改动各画一个色块，中间的空白如实留空。
The Git panel's change ruler no longer counts the unchanged lines between two edits into a mark's length. Two runs closer than four lines used to merge into one mark, painting the gap as changed, so a three-line edit looked as long as a whole block; each contiguous run now gets its own mark and the gaps stay empty.
