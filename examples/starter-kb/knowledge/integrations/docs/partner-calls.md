---
title: Partner API calls
area: integrations
owner: dana
scope:
  - services/integrations/**
updated: 2026-10-12
---

How the integrations services talk to partner APIs. Read the section you need; each one says where it came from.

## The shared HTTP client {#http-client}
<!-- homeostat: source=pr-feedback url=https://bitbucket.org/acme/integrations-api/pull-requests/790#comment-41 updated=2026-10-12 confidence=high -->
Every outbound call goes through `withRetry()` from `@acme/http-client`. It retries 5xx and timeouts three times with backoff and sets the `x-request-id` header that partner support asks for.

## Timeouts {#timeouts}
<!-- homeostat: source=manual updated=2026-09-30 confidence=medium -->
Partner calls time out after 10 seconds. Booking confirmation is the exception: it waits up to 30 seconds, because two partners confirm synchronously.
