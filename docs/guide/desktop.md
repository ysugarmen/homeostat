# Desktop app

The dashboard as a Mac app. It runs the same local dashboard as `homeostat dashboard`, against your own KB checkout, and keeps that checkout current from origin, so it shows what your team has pushed without anyone setting up CI, tokens or a server.

## Install

Download `Homeostat-<version>-arm64.dmg` (Apple silicon) or `Homeostat-<version>.dmg` (Intel) from the [releases](https://github.com/ysugarmen/homeostat/releases), open it, and drag Homeostat to Applications.

The app is not signed with an Apple Developer ID yet, so macOS asks once before the first launch:
- **macOS 15 and later:** open it, choose *Done* at the warning, then go to System Settings > Privacy & Security, scroll to Homeostat and choose *Open Anyway*.
- **macOS 14 and earlier:** right-click the app, choose *Open*, and confirm.

## First launch

Choose your team's KB checkout: the folder with `homeostat.yaml`, the same one the Claude Code plugin uses. No checkout yet? Paste the KB repo's clone URL and the app clones it into `~/Documents/Homeostat/`, with the git credentials you already use for that repo. The app remembers the folder; *Homeostat > Open Knowledge Base…* switches to another.

## How current it is

The app fetches from origin when it opens, when its window comes to the front (at most every 30 seconds), and on *View > Refresh* (⌘R). It fetches the base branch, the daily run's `homeostat/state` and teammates' `candidates/*`, the same branches `homeostat sync` reads, and fast-forwards your checkout only when it is on the base branch with no local changes. Otherwise it leaves the checkout alone and the title bar says how many commits behind it is, and why.

*View > Refresh Every Minute While Open* adds a fetch every minute for as long as the window is open. It is off by default; nothing runs when the app is closed.

The title bar shows when the view last updated, or *offline* when origin could not be reached (it then shows the checkout as it is).

## What it never does

It never pushes, commits or deletes, and makes no network calls other than git fetches to your KB's origin. Your event data (Impact, Desire paths, Events) is this machine's own, as in `homeostat dashboard`. Settings forms write `homeostat.yaml` in your checkout, as they do there; commit the change on a branch and open a PR.

## Building it

```sh
node scripts/package-desktop.mjs    # packages/desktop/release/*.dmg
cd packages/desktop && pnpm start   # run from source
```

The release workflow builds both .dmg files on a macOS runner and attaches them to each GitHub release.
