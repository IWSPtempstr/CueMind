# llama.cpp timing report

- Status: complete
- Success/failed: 24/0
- First upstream token P50/P95: 34.76870599999984/137.31074400000034 ms
- Completion P50/P95: 710.3562980000006/893.3551809999999 ms
- tok/s timing samples: 24
- Evidence: Real llama.cpp SSE timing for a fixed prompt set; firstToken is upstream SSE content when exposed, while buffered application answer bytes are not TTFT.
