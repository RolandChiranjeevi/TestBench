# Load Test Heuristics

## What to measure

- Response time (p50, p95, p99)
- Error rate (4xx, 5xx)
- Throughput (requests per second)
- Obvious degradation (slowness, timeouts, errors)

## How to run

- Start with a small VU count (e.g. 10)
- Ramp up gradually if needed
- Keep duration short (1-2 minutes)
- Stop immediately if error rate rises sharply

## What to report

- VU count, duration, ramp-up
- Response time percentiles
- Error rate
- Any degradation observed
- Recommendation (pass / warning / fail)

## Safety rules

- Never run against production or shared infrastructure
- Never use destructive actions
- Never exceed agreed VU count or duration
- Stop immediately if environment becomes unstable