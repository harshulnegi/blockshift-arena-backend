# BlockShift Arena Backend

Public deploy package for the BlockShift Arena authoritative multiplayer server.

## Render Free Web Service

Use these settings:

```text
Runtime: Node
Build Command: npm ci --omit=dev
Start Command: npm run start:render
Health Check Path: /health
```

Required environment variables:

```text
NODE_ENV=production
CLIENT_ORIGIN=*
DATABASE_URL=<Neon pooled Postgres URL with sslmode=require>
DATABASE_SSL=true
REDIS_URL=<Upstash rediss:// URL>
JWT_SECRET=<long random secret>
GOOGLE_WEB_CLIENT_ID=<optional Google web client id>
ALLOW_DEV_GOOGLE_AUTH=false
EXPOSE_DEV_OTP=false
AVATAR_STORAGE=database
```

The server runs SQL migrations on startup, stores ranked stats in Neon, uses Upstash Redis for matchmaking and Socket.IO scaling, and keeps profile photos as small database-backed JPEG data URLs for Render's ephemeral filesystem.

## TURN Relay Verification

To prove cellular TURN fallback, temporarily set `P2P_RELAY_ONLY=true` on the backend. New matches will advertise `relayOnly=true`, `iceTransportPolicy=relay`, and `relayMode=turn-only`; Android will force WebRTC to use TURN relay candidates only. Turn it back to `false` after testing so direct/STUN P2P stays faster and cheaper.
