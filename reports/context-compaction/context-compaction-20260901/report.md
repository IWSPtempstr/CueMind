# Context compaction evaluation

Compared no compaction, token trimming, and structured-history trimming using deterministic local inputs. This does not measure card accuracy, Ask source correctness, latency, or real long-meeting behavior. Original transcript chunks remain immutable; compact summaries are context only and never a source of facts.

Measured fixture: 243 characters / 61 estimated tokens before and after each strategy. The small fixture did not cross the trim budget, so no reduction is claimed. Production thresholds and model/version remain unverified.
