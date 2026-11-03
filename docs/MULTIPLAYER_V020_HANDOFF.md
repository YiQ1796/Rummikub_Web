# Rummikub V0.2.0 Multiplayer QA / Handoff

Repository: `YiQ1796/Rummikub_Web` — independent from `game-center`.
Baseline: `635958b71c7624538259c865fb445f9804c294c0`. Safe rollback branch: `safe-rollback-v012-before-multiplayer-20261103`.

## Delivered
- WebRTC six-digit room code (public PeerJS signaling), host creates lobby; real players fill seats, AI takes unoccupied seats on start.
- Host-authoritative turn commits. Guest can edit their own local draft; only submitted canonical tile IDs are sent to the host; all game rules re-validated there.
- Per-seat game snapshots: each player sees own rack, other players' remaining counts, public board; no full pool or opponent hands.
- Reconnection by saved client token, host persistence in localStorage, room and AI takeover for disconnected guests.
- Existing one-player-vs-AI play retained. Existing Joker art, phone numeric sort and timed-free turns retained.

## Verification Gate
- `node --test tests/*.test.mjs`: 34/34 pass locally.
- `node scripts/verify-pages.mjs`: pass locally.
- `node --check` source modules: pass locally.
- No independent live iPhone/Android/cellular NAT UAT run. Cross-network connectivity remains UNKNOWN.
- Headless browser smoke test was blocked by tool environment (ERR_BLOCKED_BY_ADMINISTRATOR for localhost); not counted as PASS.

## Known limitations
- Public PeerJS signaling without a TURN fallback; some networks block P2P.
- No arbitrary new players after a match starts. Reconnect token is required.
- Host device must stay online; no automatic host migration.
- Missing full Joker exchange rules inherited from base version.
- No real-time turn timer per user decision.

## Security
- Guest never receives authoritative deck/pool or another user's tile IDs.
- The host validates seat, revision, canonical tile membership and legal melds before accepting a turn.
- Six-digit room code is not a security secret; do not use with sensitive personal data or payment.
