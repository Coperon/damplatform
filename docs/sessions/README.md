# Session workflow

| File | Role | How to use |
|---|---|---|
| `../STATE.md` | **Now** — current build state, conventions, blockers | Read this at the start of every session. Rewrite it in place at the end. |
| `CHANGELOG.md` | **History** — one paragraph per session | Append-only: prepend a new entry at the top. Never create numbered session files. |
| `archive/` | **Frozen transcripts** | Not read by default. Move any old session-NNN files here; don't delete them. |

---

## The ritual

### Session start
Tell the assistant:
> "Read docs/STATE.md"

That one file is enough to restore full context. No transcript files, no long preambles.

### Session end
Two things only:
1. **Rewrite `STATE.md` in place** — update "what's built", "in progress", any new gotchas or pending decisions. Keep it roughly the same size; it should describe *now*, not accumulate history.
2. **Prepend one paragraph to `CHANGELOG.md`** — date, theme, what shipped. Keep it to 3–5 sentences.

Do **not** create a new `session-NNN.md` file. If a session was particularly complex and you want to preserve the full transcript, move it to `archive/` — but it won't be read automatically.

---

## Why this structure

Per-session transcript files grow without bound and become too large to load. STATE.md stays small because it's rewritten, not appended. The changelog gives a human-readable audit trail without polluting the working context.
