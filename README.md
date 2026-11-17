# Dad's Claude

A small personal chat site for Claude that runs entirely in the browser.

- Pick any current Claude model (Fable 5.2, Opus 5.5, Sonnet 5.5, Haiku 5.5) and see its price.
- Each device pastes its own Claude API key once; the key is stored only in that browser and sent only to `api.anthropic.com`. No key or other secret is in this repository.
- Chats are kept on the device (IndexedDB) and can be deleted from Settings.
