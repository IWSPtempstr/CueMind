# CueMind Extended Live Ask Evaluation

- Dataset version: `2026-09-07-video-derived-160q`
- Questions: 160
- Denominator: {"total":160,"failed":0}
- Completion: {"count":160,"p50":5170.470703999978,"p95":8380.299844000023,"p99":10604.408268}
- First event: {"count":160,"p50":4.270710000069812,"p95":9.259701000002678,"p99":22.745434999931604}
- First byte: {"count":154,"p50":5215.708755000029,"p95":8840.588189000031,"p99":10604.388666999992}

## Cache Modes

- cold: {"denominator":{"total":80,"failed":0},"completionMs":{"count":80,"p50":6320.417633999954,"p95":9782.40324000013,"p99":10608.393151000026},"firstEventMs":{"count":80,"p50":3.867941999924369,"p95":10.194250999949872,"p99":22.745434999931604},"firstByteMs":{"count":76,"p50":6381.975275999983,"p95":9977.614229000057,"p99":10608.369446999975},"finalStates":{"answered":76,"degraded":4},"cacheModeMismatches":0}
- hot: {"denominator":{"total":80,"failed":0},"completionMs":{"count":80,"p50":3690.0214760000235,"p95":5667.344331,"p99":7417.865815999918},"firstEventMs":{"count":80,"p50":4.552327000070363,"p95":8.365882999962196,"p99":23.300897000124678},"firstByteMs":{"count":78,"p50":3711.7763999999734,"p95":5910.102400999982,"p99":7417.847215999849},"finalStates":{"answered":78,"degraded":2},"cacheModeMismatches":0}

Only questions supplied by the manifest are measured. The evaluator does not create, expand, or rewrite the dataset and does not clear application caches.
