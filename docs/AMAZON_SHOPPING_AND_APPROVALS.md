# Andrea Amazon Shopping And Approvals

Andrea can now search Amazon Business products, prepare a tracked purchase request, ask for explicit approval, and only then submit the order flow.

That last part matters.
Andrea is helpful.
Andrea is quirky.
Andrea is not allowed to improvise with your credit card.

Treat this as an operator-enabled surface for the registered main control chat, not a default public capability.

## What This Feature Actually Does

Current v1 behavior:

- search Amazon Business products from chat
- prepare a purchase request for one specific ASIN + offer
- generate a short-lived approval code
- require the user to approve the exact request with that code
- submit the Amazon Business order flow only after approval
- default to `trial` mode so you can validate the full flow without placing a real order

This is intentionally different from "just let the bot click Buy Now on consumer Amazon."

## Why Amazon Business First

Andrea uses Amazon Business APIs because they provide an official path for:

- product search
- offer lookup
- order submission
- trial-mode validation

That gives us a cleaner and more auditable foundation than consumer checkout automation.

The tradeoff is simple:

- Amazon Business is the supported first-party path for search + ordering
- consumer Amazon checkout automation is a future optional path, likely through a separate human-in-the-loop browser microservice

## Security Model

The wallet-protection rules are strict on purpose:

- Amazon credentials stay on the host, not inside the container helper
- the helper only talks through a narrow shopping RPC boundary
- Andrea remains the only public assistant identity
- purchase requests are stored in SQLite for auditability
- approval codes are hashed, not stored in plaintext
- approval commands are intercepted before chat history storage, so the raw code is not written into the normal message transcript
- a purchase request can expire, fail, or be cancelled
- if the offer price changes before approval, Andrea blocks the purchase and asks for a fresh request

Default safe posture:

- `AMAZON_BUSINESS_ORDER_MODE=trial`

In trial mode, Andrea validates the ordering flow but does not submit a real order.

## Required Setup

Copy `.env.example` to `.env`, then add the Amazon Business values you actually use.

Minimum search configuration:

```bash
AMAZON_BUSINESS_API_BASE_URL=https://na.business-api.amazon.com
AMAZON_BUSINESS_AWS_REGION=us-east-1
AMAZON_BUSINESS_LWA_CLIENT_ID=...
AMAZON_BUSINESS_LWA_CLIENT_SECRET=...
AMAZON_BUSINESS_LWA_REFRESH_TOKEN=...
AMAZON_BUSINESS_AWS_ACCESS_KEY_ID=...
AMAZON_BUSINESS_AWS_SECRET_ACCESS_KEY=...
AMAZON_BUSINESS_USER_EMAIL=buyer@example.com
AMAZON_BUSINESS_ORDER_MODE=trial
AMAZON_PURCHASE_APPROVAL_TTL_MINUTES=30
```

Required for purchase submission or trial-mode order validation:

```bash
AMAZON_BUSINESS_SHIPPING_FULL_NAME=Andrea Buyer
AMAZON_BUSINESS_SHIPPING_PHONE_NUMBER=555-123-4567
AMAZON_BUSINESS_SHIPPING_ADDRESS_LINE1=123 Main St
AMAZON_BUSINESS_SHIPPING_CITY=Chicago
AMAZON_BUSINESS_SHIPPING_STATE_OR_REGION=IL
AMAZON_BUSINESS_SHIPPING_POSTAL_CODE=60601
AMAZON_BUSINESS_SHIPPING_COUNTRY_CODE=US
```

Optional refinements:

```bash
AMAZON_BUSINESS_GROUP_TAG=eng
AMAZON_BUSINESS_PRODUCT_REGION=US
AMAZON_BUSINESS_LOCALE=en_US
AMAZON_BUSINESS_TIMEOUT_MS=20000
```

## Telegram Commands

Andrea exposes these shopping commands in Telegram for operators in the main control chat:

- `/amazon-status`
- `/amazon-search <keywords>`
- `/purchase-request <asin> <offer_id> [quantity]`
- `/purchase-requests`
- `/purchase-approve <request_id> <approval_code>`
- `/purchase-cancel <request_id>`

## Typical Flow

1. Check readiness:

```text
/amazon-status
```

2. Search for something:

```text
/amazon-search ergonomic keyboard
```

3. Pick the specific result and prepare an approval request:

```text
/purchase-request B012345678 OFFER123 1
```

4. Andrea replies with:

- the tracked request id
- the expected total
- the approval code
- the expiry time

5. Approve it explicitly:

```text
/purchase-approve purchase-abc123 CODE1234
```

6. Or cancel it:

```text
/purchase-cancel purchase-abc123
```

## How Andrea Behaves In Natural Language

Andrea can also use the internal shopping helper when the user says something like:

- "Find me a desk lamp on Amazon."
- "Look for a good ergonomic keyboard and prepare a purchase request."
- "Approve that Amazon purchase request."

Important behavior:

- search and request creation are treated as protected assistant tasks
- approval and cancellation are treated as control-plane actions
- code-generation or repo work does not get shopping tools by default
- the explicit slash-command surface is main-control-chat only

That keeps shopping out of engineering workflows and keeps engineering workflows out of shopping.

## Data Stored

Purchase requests are stored in the local SQLite database with:

- product title
- ASIN
- offer id
- quantity
- merchant name
- expected unit and total price
- approval expiry
- current status
- order mode
- submitted order id when available

The approval code itself is not stored in plaintext.

## Failure Modes To Expect

Andrea will refuse or block the purchase flow when:

- Amazon Business credentials are missing or invalid
- shipping address details are incomplete
- the offer no longer exists
- the price changes before approval
- the approval code is wrong
- the approval window expires

That is not Andrea being difficult.
That is Andrea doing fraud prevention cosplay, and in this case the cosplay is useful.

## Research Notes And Future Path

This implementation is based on the Amazon Business path rather than consumer Amazon browser automation.

Official references used:

- Amazon Business Ordering API
- Amazon Business Product Search API
- Amazon Login with Amazon authorization flow
- Amazon trial-mode order validation docs
- Product Advertising API docs for broader Amazon ecosystem context

Practical product note:

- Andrea can use OpenAI-backed models for product research, comparison, and recommendation
- this repo does not rely on an OpenAI-native checkout API
- actual order execution in this codebase stays on the guarded Amazon Business approval path

Open-source repos reviewed while shaping this:

- `aws/nova-act`
- `highsidelabs/amazon-business-api`
- `truffle-ai/dexto`

Likely future expansion:

- a separate browser-automation microservice for consumer Amazon checkout
- stronger human-in-the-loop confirmation with screenshots or cart snapshots
- order refresh or reprice before final approval
- vendor preference rules
- budget and policy controls

## Recommendation

Start with:

```bash
AMAZON_BUSINESS_ORDER_MODE=trial
```

Run real searches.
Create real approval requests.
Approve them in trial mode first.

Once that feels boring and reliable, then consider live mode.
Boring is good when money is involved.
