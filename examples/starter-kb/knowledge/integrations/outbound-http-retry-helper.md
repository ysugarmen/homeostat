---
id: outbound-http-retry-helper
title: Use the shared retry helper for outbound HTTP calls
area: integrations
scope: ["services/integrations/**", "packages/http-client/**"]
status: accepted
score: 4
owner: dana
source:
  type: pr-feedback
  url: https://bitbucket.org/acme/integrations-api/pull-requests/812#comment-33
  author: dana
  changedCode: true
created: 2026-09-30
lastConfirmed: 2026-10-07
tags: [http, resilience]
tokens: 144
---

## Rule
Wrap every outbound HTTP call to a partner API in `withRetry()` from `@app/http-client`. Do not hand-roll retry loops or use `axios-retry` directly.

## Why
Partner APIs time out often. The helper adds jittered backoff, a circuit breaker and the request-id header that on-call searches logs by. Hand-rolled loops have skipped the header before, which made incidents unsearchable.

## Example
```ts
// wrong
for (let i = 0; i < 3; i++) { try { return await axios.get(url) } catch {} }
// right
return withRetry(() => axios.get(url), { attempts: 3 })
```
