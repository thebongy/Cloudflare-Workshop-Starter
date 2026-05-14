# GitHub MCP Code Mode Workshop Starter

This starter is intentionally split into standalone Wrangler Worker projects. Each folder is a checkpoint you can open, run, and deploy independently while walking through the build.

Each stage has its own Worker API in `src/index.ts` and its own React frontend project in `client/`. Wrangler serves the built React app through an `ASSETS` binding with `not_found_handling = "single-page-application"`, so deep links load the app while `/api/agent/demo/*` stays in the Worker.

## Slides

The exported workshop talk deck is available at [`cloudflare-codemode-github-agent-workshop.pdf`](./cloudflare-codemode-github-agent-workshop.pdf).

## Stages

| Folder | Topic | What changes |
| --- | --- | --- |
| `stage-00-ui-shell` | Worker + UI shell | Serves the React three-panel chat UI and static inspector state. |
| `stage-01-kimi-chat` | Workers AI chat | Adds an `AIChatAgent` session and Kimi K2.5 responses. |
| `stage-02-github-mcp` | GitHub MCP connection | Adds read-only GitHub MCP connect/status/disconnect endpoints. |
| `stage-03-direct-mcp` | Direct MCP baseline | Passes GitHub-style tools directly to the model and records the tool-call timeline. |
| `stage-04-codemode` | Code Mode over GitHub MCP | Wraps GitHub MCP tools with Code Mode and shows generated code, calls, logs, and result. |

## Run A Stage

```sh
cd stage-04-codemode
npm install
npm run check
npm run dev
```

Then open the local URL from Wrangler.

`npm run dev` builds `client/` into `dist/client` and starts `wrangler dev --config wrangler.jsonc` so the React app and Worker API run from the same local Worker.

## Deploy The Final Stage

```sh
cd stage-04-codemode
npm install
npx wrangler secret put GITHUB_MCP_PAT # optional, enables live GitHub MCP
npm run deploy
```

The main workshop path is read-only. Stage 04 sends `X-MCP-Readonly: true` when `GITHUB_MCP_PAT` is configured, and it also includes seeded fallback data so the demo still works when live GitHub MCP auth is not configured.
