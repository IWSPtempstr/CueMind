# CueMind Extended Live Ask Evaluation

- Dataset version: `2026-09-07-video-derived-160q`
- Questions: 160
- Denominator: {"total":160,"failed":0}
- Completion: {"count":160,"p50":3587.207948000054,"p95":5524.869594999938,"p99":6535.631155999959}
- First event: {"count":160,"p50":3.9263540000101784,"p95":7.2227300000377,"p99":15.887705000001006}
- First byte: {"count":160,"p50":3587.189798000036,"p95":5524.850056999945,"p99":6535.6184730000095}

## Cache Modes

- cold: {"denominator":{"total":80,"failed":0},"completionMs":{"count":80,"p50":4584.538177999959,"p95":5820.283930999998,"p99":6833.482609999948},"firstEventMs":{"count":80,"p50":3.8223950000246987,"p95":5.968799999998737,"p99":15.068648999999994},"firstByteMs":{"count":80,"p50":4584.523236999987,"p95":5820.26943,"p99":6833.457018999965},"finalStates":{"answered":80},"cacheModeMismatches":0}
- hot: {"denominator":{"total":80,"failed":0},"completionMs":{"count":80,"p50":2456.9707500000077,"p95":3950.310219999985,"p99":4538.787646000041},"firstEventMs":{"count":80,"p50":4.060442000045441,"p95":7.2227300000377,"p99":18.848957999958657},"firstByteMs":{"count":80,"p50":2456.9522100000177,"p95":3950.297385999991,"p99":4538.77394600003},"finalStates":{"answered":80},"cacheModeMismatches":0}

Only questions supplied by the manifest are measured. The evaluator does not create, expand, or rewrite the dataset and does not clear application caches.
