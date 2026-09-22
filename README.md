# PolyGrid Backend

REST API for **PolyGrid**, a civil engineering, construction marketplace and
talent ecosystem, built by **Hephaestus Craft**. Node.js, Express, MongoDB
(replica set), written in TypeScript.

See [docs/](docs/) for the product overview and the technical plan this
codebase is being built against — read those before adding a new pillar or
touching the subscription/auth model.

## env

```
NODE_ENV=development
PORT=4000
MONGO_URI=
BASE_URL=
JWT_SECRET=
JWT_EMAIL_SECRET=
FILE_SIGNING_SECRET=
APP_NAME=PolyGrid
FRONTEND_URL=
GOOGLE_CLIENT_ID=
APPLE_CLIENT_ID=
STORAGE_ROOT=
```

Copy `.env.example` to `.env` and fill in real values.

## Getting started

```bash
npm install
npm run serve      # dev server, restarts on change (nodemon + ts-node)
npm run build      # compile src/ -> dist/
npm run production # run the compiled build (node dist/server.js)
npm run typecheck  # tsc --noEmit
```

## Tests

```bash
npm test                 # everything
npm run test:unit        # pure logic, no DB
npm run test:integration # real HTTP requests against a real MongoDB
```

See [tests/README.md](tests/README.md) for how the test DB is provisioned and
what's covered.
