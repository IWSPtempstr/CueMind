# CueMind Extended Live Ask Evaluation

- Dataset version: `2026-09-07-video-derived-160q`
- Questions: 160
- Denominator: {"total":160,"failed":0}
- Completion: {"count":160,"p50":3739.8962159999937,"p95":5958.205485000042,"p99":6535.889467999994}
- First event: {"count":160,"p50":4.052700000000186,"p95":7.418401000000813,"p99":15.365807000000018}
- First byte: {"count":159,"p50":3743.4481010000163,"p95":6095.6109679999645,"p99":6535.863668000005}

## Cache Modes

- cold: {"denominator":{"total":80,"failed":0},"completionMs":{"count":80,"p50":4185.774556999968,"p95":6317.740362999961,"p99":7239.256914999918},"firstEventMs":{"count":80,"p50":3.5309000000124797,"p95":8.49130200000036,"p99":20.21319699997548},"firstByteMs":{"count":80,"p50":4185.7612569999765,"p95":6317.722462999984,"p99":7239.237114999909},"finalStates":{"answered":80},"cacheModeMismatches":0}
- hot: {"denominator":{"total":80,"failed":0},"completionMs":{"count":80,"p50":2781.759729000012,"p95":4372.516599000082,"p99":4928.790127999993},"firstEventMs":{"count":80,"p50":4.301399999996647,"p95":7.0446000000229105,"p99":9.740399000002071},"firstByteMs":{"count":79,"p50":2781.8231080000405,"p95":4458.098047999956,"p99":4928.776328},"finalStates":{"answered":79,"degraded":1},"cacheModeMismatches":0}

Only questions supplied by the manifest are measured. The evaluator does not create, expand, or rewrite the dataset and does not clear application caches.
