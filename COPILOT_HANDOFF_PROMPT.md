# Copilot handoff prompt (new PC)

Use this as your first prompt in a fresh Copilot session for this repo:

```text
You are in repository skauting/local-weather-app on branch main.

Please first read these files for context:
- README.md
- server.js
- public/app.js
- public/index.html
- public/styles.css
- supabase/migrations/20260813033000_chat_history.sql

Current app behavior to keep in mind:
1) Chat is for authenticated users only.
2) Chat conversation has a max of 10 stored messages (user+assistant total), then backend rotates to a new conversation.
3) UI shows chat counter X/10 and a system notice when a new conversation starts.
4) Login errors are mapped to specific messages (invalid credentials vs unconfirmed email vs rate limit).
5) Chat timeout strategy: backend 60s, frontend 70s, with a UI progress notice after 15s.
6) If DeepSeek is blocked (for example by VPN), user message may be stored without assistant reply.

When making changes:
- Keep behavior consistent with current auth/chat logic.
- Do not remove the conversation-rotation signal in API responses.
- Do not change unrelated files.
```

Environment checklist for the new PC:
- Copy `.env.example` to `.env` and fill all keys.
- Use `APP_ORIGIN=http://localhost:3000` for local run.
- Start with `npm install`, then `npm run start:local`.

