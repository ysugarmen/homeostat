---
id: use-design-tokens-for-colors
title: Use design tokens instead of hard-coded colours
area: frontend
scope: ["apps/web/**", "packages/ui/**"]
status: candidate
score: 0
owner: sam
source:
  type: agent-handoff
  author: lee
created: 2026-10-10
lastConfirmed: 2026-10-10
tags: [css, theming]
tokens: 85
---

## Rule
Reference colours through the `--color-*` CSS variables from `@app/ui/tokens.css`. Do not write hex, rgb or named colours in component styles.

## Why
Dark mode and the high-contrast theme work by swapping the token values. A hard-coded colour stays the same in every theme, so text can become unreadable; a session spent most of its time tracking one of these down.
