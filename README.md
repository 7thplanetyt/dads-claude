# Dad's Claude

A small personal Claude chat site: every current model (Fable 5.2, Opus 5.5, Sonnet 5.5, Haiku 5.5) with its price, a spend meter, photos, and chat history. Works on phones and laptops.

## How it works

- `public/` is the site. It never holds a Claude API key.
- `src/worker.js` is a Cloudflare Worker that serves the site and relays chat requests to the Claude API, adding the API key server-side. It only accepts requests carrying a valid invite token, and only plain chat with the four listed models.
- Each person gets a private invite link (`https://<worker>/?invite=<token>`). Opening it once sets up that device.

## Deploy

```
npm install
npx wrangler deploy
npx wrangler secret put ANTHROPIC_API_KEY   # a Claude API key, ideally in its own workspace with a spend limit
npx wrangler secret put ACCESS_TOKENS       # comma-separated invite tokens; remove one to revoke that link
```
