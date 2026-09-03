# AGENTS.md

Guidance for AI agents working in this repository lives in [CLAUDE.md](CLAUDE.md) — read that first, then [README.md](README.md) for product context. Do not duplicate content here; this file only routes.

Priority order for project context: CLAUDE.md → AGENTS.md (this file) → README.md → `docs/product/cuemind-grilling-decisions.md` (locked decisions) → `docs/plans/` (dated implementation plans).

Additional agent-specific rules:

- Implementation status ≠ decision status. Locked decisions in `cuemind-grilling-decisions.md` are not necessarily implemented; check code and `docs/plans/` before claiming either way.
- The 11-item exclusion list in `docs/plans/2026-08-27-cuemind-demo-design.md` (「暂不纳入」) is binding: excluded capabilities require a new versioned design document before implementation.
- Conclusions first, evidence compact. Write full logs / long stacks to temp files or `reports/`, not into the conversation.
