---
id: redact-before-logging
title: Pass request and response bodies through redact() before logging
area: core
scope: ["**"]
status: accepted
score: 2
owner: dana
approvedBy: dana
source:
  type: manual
  author: lee
created: 2026-10-02
lastConfirmed: 2026-10-02
tags: [logging, privacy]
tokens: 132
---

## Rule
Never log a raw request or response body. Pass it through `redact()` from `@app/logging` first, which masks emails, phone numbers, tokens and card numbers.

## Why
Logs are shipped to a third-party service and kept for 30 days, so anything logged raw is a data leak waiting to happen. `redact()` is tested against the field names our APIs actually use; ad-hoc masking misses nested fields.

## Example
```ts
// wrong
logger.info("partner response", { body: res.data })
// right
logger.info("partner response", { body: redact(res.data) })
```
