# GW2CC

Guild Wars 2 Character Console is a local-first Electron desktop inspector and account-wide conversational analyst for live Guild Wars 2 account, character, equipment, build, and calculated attribute data.

Phase 2 adds persistent streaming chat, cancellation, OpenRouter, generic OpenAI-compatible, Anthropic, and Ollama providers, plus bounded read-only GW2 tool calls. The application keeps its domain, GW2 client, stat engine, provider orchestration, repository contracts, tools, and transport protocol platform-neutral; Electron supplies only desktop host, SQLite, secure-secret, and IPC adapters.

## Development

Prerequisites: Node.js 22+ and npm.

```bash
npm install
npm run dev:fixture
```

Use `npm run dev` for live mode. Enter a Guild Wars 2 API key with `account`, `characters`, and `builds` permissions for the complete inspector, then configure a provider/model under Settings. `npm run dev:fixture` exercises the same chat/tool path offline with a deterministic fixture provider.

The root test and desktop commands rebuild `better-sqlite3` for their respective Node or Electron runtime, so they are safe to run in any order.

## Quality gates

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
npm audit --audit-level=high
```

See `AGENTS.md` for repository invariants and `docs/GW2CC_DESIGN.md` for the authoritative design.
