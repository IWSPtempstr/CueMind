# llama.cpp timing report

- Status: complete
- Success/failed: 8/0
- First upstream token P50/P95: 71.79527700000017/927.989348 ms
- Completion P50/P95: 656.3354410000002/1970.5448190000002 ms
- tok/s timing samples: 8
- Evidence: Real llama.cpp SSE timing for a fixed prompt set; firstToken is upstream SSE content when exposed, while buffered application answer bytes are not TTFT.
