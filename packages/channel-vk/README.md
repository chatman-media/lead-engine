# @chatman-media/channel-vk

VK community channel adapter for lead-engine.

MVP support:

- inbound via VK Callback API `message_new`
- outbound text via `messages.send`
- community token validation via VK API

Media, rich keyboards, group-chat semantics, and Long Poll are intentionally
left out until they are tested against the current VK API.
