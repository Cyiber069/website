# Studio Test Modes

> Pick the Studio test mode that matches the question: solo play for quick logic checks, a local server with multiple clients for replication and security, and the device emulator for layout.

## Modes and what each proves

| Mode | Use it to check | It cannot prove |
| --- | --- | --- |
| Play (solo) | Basic logic, quick iteration | Multiplayer behaviour, real latency |
| Run (no character) | Server-only systems, world simulation | Anything involving a player |
| Local server with 2+ clients | Replication, remotes, exploits, contested resources | Real device performance |
| Device emulator | Layout and touch controls at phone and tablet sizes | Real device speed and memory |
| Published test place on a real phone | Actual performance, feel, load time | Nothing; this is the reference |

Why distinguish: solo play hides whole classes of bugs, because one process can blur the line between server and client. A local server with separate client windows shows what actually replicates.

## Solo play habits

- Keep the Output window open and treat every error and warning as a failure. Why: an error in one script often silently stops later setup.
- Use the server and client view toggle during play to inspect what each side sees. Why: an instance created by a LocalScript exists only on that client.

## Multi-client tests

Start a local server with at least two players from the Test tab. Check:

- Player A's actions appear correctly for player B.
- Player A cannot affect player B's data.
- Firing remotes with bad arguments from a client's command bar is rejected by the server; see [[Server-Authoritative Remotes]].
- Joining late shows the correct current world state.

## Device emulation

Use the device selector to switch among a small phone, a tablet and desktop sizes, and rotate. Touch input and the on-screen thumbstick and jump button are emulated, which makes it the fastest way to check [[Mobile-First HUD Zones]]. Emulation does not slow your computer down to phone speed, so performance still needs a real device or conservative budgets.

## Data and purchases

- Enable Studio access to API services in the experience settings to exercise DataStores. Use a separate store name or place for testing. Why: test runs must not corrupt live player data.
- Test with empty data and with data saved by an older version.
- Stop the server while a player is in the game to exercise the `BindToClose` path from [[DataStore Save Patterns]].
- Purchases in Studio are simulated; use them to exercise [[ProcessReceipt Idempotency]].

## Diagnostics

- Developer Console (F9 during play): logs, memory, network and script performance for client and server.
- MicroProfiler: frame-by-frame timing to see whether physics, rendering or scripts is the bottleneck.
- Lower the streaming radius temporarily to expose streaming assumptions; see [[StreamingEnabled Setup]].

## Check before you hand off

- The change was tested in at least solo play and a two-client local server.
- Interface changes were viewed on a small phone preset.
- Output showed no errors on server or clients from join to leave.
- Data changes were tested with empty and existing data.
- The hand-off names the modes used and what was not tested on a real device.
