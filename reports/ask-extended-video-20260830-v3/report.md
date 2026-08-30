# CueMind Extended Live Ask Evaluation

- Dataset version: `2026-08-30-video-derived-40q`
- Questions: 38
- Denominator: {"total":38,"failed":0}
- Completion: {"count":38,"p50":4947.364074000012,"p95":7298.653388999999,"p99":7898.54000399998}
- First event: {"count":38,"p50":592.4657509999961,"p95":729.6070500000001,"p99":1729.9772609999927}
- First byte: {"count":37,"p50":5025.434882000001,"p95":7298.638006999998,"p99":7898.529644999973}

## Cache Modes

- cold: {"denominator":{"total":19,"failed":0},"completionMs":{"count":19,"p50":4386.868317999993,"p95":6755.656485999998,"p99":6755.656485999998},"firstEventMs":{"count":19,"p50":626.9959479999961,"p95":729.6070500000001,"p99":729.6070500000001},"firstByteMs":{"count":19,"p50":4386.857418,"p95":6755.570897,"p99":6755.570897},"finalStates":{"answered":19},"cacheModeMismatches":0}
- hot: {"denominator":{"total":19,"failed":0},"completionMs":{"count":19,"p50":5205.785201999999,"p95":7898.54000399998,"p99":7898.54000399998},"firstEventMs":{"count":19,"p50":592.4657509999961,"p95":1729.9772609999927,"p99":1729.9772609999927},"firstByteMs":{"count":18,"p50":5205.772502000007,"p95":7898.529644999973,"p99":7898.529644999973},"finalStates":{"answered":18,"degraded":1},"cacheModeMismatches":15}

Only questions supplied by the manifest are measured. The evaluator does not create, expand, or rewrite the dataset and does not clear application caches.
