# Andrea Alexa Voice Integration

This guide shows how to add Alexa as a voice front door to Andrea.
Andrea stays the assistant identity. Alexa is only the transport.

Treat Alexa as an optional operator-enabled ingress, not part of Andrea's default public surface, until it has been validated end to end in the current environment.

## 1) What You Get

With Alexa enabled:

- users can speak requests instead of typing
- requests route into the same Andrea runtime
- response formatting still stays Andrea-first
- internal helper machinery stays hidden

## 2) Required Inputs

Minimum env value:

```bash
ALEXA_SKILL_ID=amzn1.ask.skill.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

Recommended secure private rollout:

```bash
ALEXA_HOST=127.0.0.1
ALEXA_PORT=4300
ALEXA_PATH=/alexa
ALEXA_VERIFY_SIGNATURE=true
ALEXA_ALLOWED_USER_IDS=amzn1.ask.account.your-account-id
ALEXA_TARGET_GROUP_FOLDER=main
```

Optional:

```bash
ALEXA_REQUIRE_ACCOUNT_LINKING=true
```

## 3) Meaning Of Each Setting

- `ALEXA_SKILL_ID`: required skill identifier from Alexa developer console.
- `ALEXA_HOST`: bind interface (default `127.0.0.1`).
- `ALEXA_PORT`: bind port (default `4300`).
- `ALEXA_PATH`: HTTP path for Alexa requests (default `/alexa`).
- `ALEXA_VERIFY_SIGNATURE`: validates ASK request signatures; keep this `true` in real environments.
- `ALEXA_ALLOWED_USER_IDS`: comma-separated allowlist for account/person IDs.
- `ALEXA_REQUIRE_ACCOUNT_LINKING`: rejects requests until skill account is linked.
- `ALEXA_TARGET_GROUP_FOLDER`: routes voice requests into a specific group context (`main` recommended).

## 4) Build The Alexa Skill

In Alexa Developer Console:

1. Create a new **Custom** skill.
2. Set invocation name (for example `andrea assistant`).
3. Import interaction model from:
   - `docs/alexa/interaction-model.en-US.json`
4. Configure endpoint URL (HTTPS) to:
   - `https://<your-public-host>/alexa` (or your configured `ALEXA_PATH`)
5. Use the same `ALEXA_SKILL_ID` in `.env`.

## 5) HTTPS Requirement

Alexa custom skills require HTTPS endpoints.

Common patterns:

- reverse proxy on your own host
- Cloudflare Tunnel
- ngrok

Local runtime address can stay HTTP internally:

- `http://127.0.0.1:4300/alexa`

Expose that through HTTPS for Alexa console configuration.

## 6) Start And Verify

Start runtime:

```bash
npm run services:restart
```

Run verification:

```bash
npm run setup -- --step verify
```

In Telegram main control chat:

```text
/alexa_status
```

Expected status traits:

- enabled
- listening
- signature verification on
- correct target group folder

## 7) Voice Test Script

In Alexa test console (or real device), try:

- `Open Andrea assistant`
- `Ask Andrea assistant to remind me tomorrow at 8am to call Sam`
- `Ask Andrea assistant to research the best standing desks for small apartments`

If this works, voice ingress is live for that environment.

## 8) Security Hardening Checklist

Keep these on for production:

- `ALEXA_VERIFY_SIGNATURE=true`
- `ALEXA_ALLOWED_USER_IDS` populated
- `ALEXA_TARGET_GROUP_FOLDER=main` (or another intentional folder)

Add account linking when needed:

- set `ALEXA_REQUIRE_ACCOUNT_LINKING=true`

Avoid:

- public endpoint without signature verification
- empty allowlist for personal/private skills
- changing target group folder without documenting behavior impact

## 9) Troubleshooting

If `/alexa_status` says disabled:

- missing or wrong `ALEXA_SKILL_ID`

If status says configured but not started:

- runtime not started, or listener failed to bind host/port

If Alexa says endpoint failure:

- HTTPS endpoint mismatch
- wrong path (`ALEXA_PATH` vs console endpoint path)
- signature verification failing due to proxy/path rewriting

If requests are denied:

- `ALEXA_ALLOWED_USER_IDS` does not include caller identity
- `ALEXA_REQUIRE_ACCOUNT_LINKING=true` but skill not linked

## 10) Operational Notes

- Alexa is additive. Telegram remains the primary operator control surface and the safer default front door.
- For incidents, use:
  - `/alexa_status`
  - `npm run setup -- --step verify`
  - `logs/nanoclaw.log`
- Keep this guide aligned with any future Alexa intent-model changes.
