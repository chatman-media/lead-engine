# @chatman-media/channel-max

MAX messenger bot channel adapter for lead-engine.

MVP support:

- inbound via MAX Bot API Webhook `message_created`
- outbound text via `POST /messages`
- bot token validation via `GET /me`
- webhook secret validation by `X-Max-Bot-Api-Secret` in the API route

Media, rich keyboards, callback buttons, mini-app events, and Long Polling are
intentionally left out until they are tested against the current MAX API.
