# History

Documents here are records, not current fact: they explain how a migration, a regression or a
kernel-line move was judged at the time. What the code does now is
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) and [`../agents/`](../agents/).

| Record | What it covers |
|---|---|
| [`kernel-line/`](kernel-line/) | the execution records of each kernel-line move, in order: 0.2.0-rc.1 → 0.2.0-rc.2 → 0.2.1-rc.1 → 0.2.1-rc.3 → 0.2.1-rc.4 → 0.2.1-rc.5. The procedure itself is [`../agents/kernel-line-regression.md`](../agents/kernel-line-regression.md); the next line's pre-adaptation conclusions are a plan in [`../plans/`](../plans/) |
| [`profile-patch-regeneration-regression.md`](profile-patch-regeneration-regression.md) | the defect where the shell's profile rebuild overwrote user settings, plus its review ledger. The fix is current fact in [`../ARCHITECTURE.md`](../ARCHITECTURE.md) §3 (the suite layer) |

New records are appended here; an existing entry is only touched to keep its links — and any statement it
makes about the repository's own layout — correct.
