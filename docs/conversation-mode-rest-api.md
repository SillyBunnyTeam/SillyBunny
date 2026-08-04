# Conversation Mode REST API

The Conversation Mode REST API provides JSON endpoints for reading and modifying Conversation Mode stores, groups, threads, and messages. It can also generate and save a character reply through SillyBunny’s existing chat-completion or text-completion backends.

The browser interface does not use this router as its primary Conversation Mode driver. Features such as proactive messages, schedules, reminders, notifications, image generation, and text-to-speech remain browser-side behavior.

## What and Who Is This For?

The Conversation Mode REST API lets other apps, scripts, and bots read or update Conversation Mode without using the SillyBunny interface directly. It is mainly for developers who want to build integrations, external chat clients, import or export tools, or automated workflows. Regular users do not need this API to use Conversation Mode.

> [!NOTE]
> This API is part of an in-development feature.

## Base Path

Primary path:

```text
/api/sillybunny-conversation
```

Supported alias:

```text
/api/sillybunny/conversation
```

For a default local installation:

```text
http://127.0.0.1:4444/api/sillybunny-conversation
```

All endpoints use `POST`, including read-only operations.

## Endpoints

| Endpoint          | Purpose                                                    |
| ----------------- | ---------------------------------------------------------- |
| `/info`           | Returns API capabilities and limitations.                  |
| `/store/get`      | Reads the complete Conversation Mode store.                |
| `/store/save`     | Replaces the complete Conversation Mode store.             |
| `/group/list`     | Lists Conversation-owned group DMs.                        |
| `/group/create`   | Creates a Conversation-owned group DM.                     |
| `/thread/get`     | Reads or initializes a solo or group thread.               |
| `/thread/save`    | Replaces the active branch’s messages.                     |
| `/message/append` | Appends one message without generating a reply.            |
| `/message/send`   | Appends a user message, generates a reply, and saves both. |

## Authentication and CSRF

The router uses SillyBunny’s normal private-endpoint authentication. Requests must use a valid browser session, Basic Authentication, or session-auth Bearer token, depending on the server configuration.

When CSRF protection is enabled, retrieve a token and preserve the session cookie:

```bash
BASE_URL="http://127.0.0.1:4444"
COOKIE_JAR="./sillybunny.cookies"

CSRF_TOKEN="$(
  curl -fsS \
    -c "$COOKIE_JAR" \
    "$BASE_URL/csrf-token" |
    jq -r '.token'
)"
```

Include both in later requests:

```bash
curl -fsS \
  -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $CSRF_TOKEN" \
  -X POST \
  "$BASE_URL/api/sillybunny-conversation/info" \
  --data '{}'
```

## Settings Version

Every request requires the current SillyBunny settings version.

Read operations return a top-level `version`:

```json
{
  "version": 4
}
```

Send that value with the next mutation:

```json
{
  "avatar": "nova.png",
  "text": "Hello",
  "version": 4
}
```

A successful request returns the new version. An older version returns:

```json
{
  "error": "settings_conflict",
  "version": 5
}
```

Update before retrying.

The following operations require `version`:

* `/store/save`
* `/group/create`
* `/thread/save`
* `/message/append`
* `/message/send`
* `/thread/get` when `create` is `true`

## Conversation Scope

Thread and message requests use the following fields.

### `avatar`

The character avatar filename:

```json
{
  "avatar": "nova.png"
}
```

This field is required for thread and message operations.

### `personaId`

Optional persona-specific storage:

```json
{
  "avatar": "nova.png",
  "personaId": "riley.png"
}
```

Without `personaId`, the API uses the Conversation namespace without any specific scope.

### `groupId`

Include this for group DMs:

```json
{
  "avatar": "nova.png",
  "groupId": "conversation_1785816000000_abcd1234",
  "personaId": "riley.png"
}
```

The selected avatar must be an included  member of the group.

## Message Format

Messages are normalized into the following structure:

```json
{
  "id": "external-message-001",
  "role": "user",
  "name": "Riley",
  "mes": "Hello from the API",
  "send_date": "2026-08-04T01:00:00.000Z",
  "created_at": 1785805200000,
  "extra": {}
}
```

Supported roles are:

```text
user
character
assistant
partner
system
```

`text` can be used as an alias for `mes`. Missing IDs and timestamps are generated automatically. Caller-supplied IDs must start with a letter or number and may contain letters, numbers, `.`, `_`, `:`, and `-`. Attachments are stored in `extra.media` or `extra.files`:

```json
{
  "role": "user",
  "mes": "",
  "extra": {
    "media": [
      {
        "url": "/user/images/example.png",
        "type": "image"
      }
    ]
  }
}
```

## Store Operations

### Read the Store

```bash
curl -fsS \
  -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $CSRF_TOKEN" \
  -X POST \
  "$BASE_URL/api/sillybunny-conversation/store/get" \
  --data '{}'
```

Example response:

```json
{
  "store": {
    "version": 1,
    "localStorageMigrated": false,
    "settings": {},
    "characters": {},
    "groups": [],
    "reminders": []
  },
  "version": 0,
  "settingsMissing": false
}
```

### Replace the Store

```json
{
  "version": 4,
  "store": {
    "version": 1,
    "localStorageMigrated": true,
    "settings": {},
    "characters": {},
    "groups": [],
    "reminders": []
  }
}
```

`/store/save` replaces the complete Conversation store. You would likely prefer to use the group, thread, and message endpoints for ordinary integrations.

## Groups

### List Groups

```json
{
  "personaId": "riley.png"
}
```

### Create a Group

```json
{
  "personaId": "riley.png",
  "name": "Nova and Echo",
  "members": [
    "nova.png",
    "echo.png"
  ],
  "version": 4
}
```

At least two unique member avatars are required. The response includes the generated group record and the new settings version.

## Threads

### Read a Thread

```json
{
  "avatar": "nova.png",
  "personaId": "riley.png"
}
```

The response includes:

```json
{
  "threadKey": "persona:riley.png:nova.png",
  "thread": {},
  "branch": {},
  "messages": [],
  "version": 4
}
```

Treat `threadKey` as a server-generated identifier.

### Initialize a Missing Thread

```json
{
  "avatar": "nova.png",
  "personaId": "riley.png",
  "create": true,
  "version": 4
}
```

### Replace Active-Branch Messages

```json
{
  "avatar": "nova.png",
  "personaId": "riley.png",
  "messages": [
    {
      "role": "user",
      "name": "Riley",
      "mes": "Imported message"
    },
    {
      "role": "character",
      "name": "Nova",
      "mes": "Imported reply"
    }
  ],
  "version": 4
}
```

`/thread/save` replaces only the active branch’s messages.

## Append a Message

`/message/append` saves a message without generating a reply.

```json
{
  "avatar": "nova.png",
  "personaId": "riley.png",
  "message": {
    "id": "external-message-001",
    "role": "user",
    "name": "Riley",
    "mes": "Hello from an integration"
  },
  "version": 4
}
```

A shorter top-level form is also accepted:

```json
{
  "avatar": "nova.png",
  "text": "Hello from curl",
  "userName": "Riley",
  "version": 4
}
```

The response contains the saved message, active branch, messages, thread key, and new version.

## Generate a Reply

`/message/send` appends a user message, generates one character response, and saves both messages atomically.

The caller selects the responding character through `avatar`. In a group DM, the API does not automatically choose several speakers.

### Chat Completion

```json
{
  "avatar": "nova.png",
  "personaId": "riley.png",
  "text": "How has your day been?",
  "userName": "Riley",
  "version": 4,
  "generation": {
    "backend": "chat",
    "payload": {
      "chat_completion_source": "openai_responses",
      "reverse_proxy": "https://example.com/v1/",
      "proxy_password": "API_KEY",
      "model": "your-model",
      "temperature": 0.8,
      "max_tokens": 512
    }
  }
}
```

Chat generation requires:

* `generation.payload.model`
* `generation.payload.chat_completion_source`

The remaining fields use SillyBunny’s existing chat-completion payload format.

### Text Completion

```json
{
  "avatar": "nova.png",
  "text": "Use the text backend",
  "version": 4,
  "generation": {
    "backend": "text",
    "payload": {
      "api_type": "generic",
      "api_server": "http://127.0.0.1:5000/v1/",
      "max_tokens": 512
    }
  }
}
```

Text generation requires:

* `generation.payload.api_type`
* `generation.payload.api_server`

Streaming is disabled for both backend types.

### Optional Character Override

The server normally loads the character card associated with `avatar`. Character data can instead be supplied directly:

```json
{
  "character": {
    "data": {
      "name": "Nova",
      "description": "A friendly character.",
      "personality": "Warm and concise.",
      "scenario": "Talking through private messages."
    }
  }
}
```

### Optional Settings

Request-specific Conversation settings can be supplied without permanently modifying the thread:

```json
{
  "settings": {
    "reply_max_tokens": 2048,
    "selfie_command_enabled": true,
    "grounded_dialogue_rules_enabled": true
  }
}
```

### Response

```json
{
  "threadKey": "persona:riley.png:nova.png",
  "userMessage": {
    "role": "user",
    "name": "Riley",
    "mes": "How has your day been?"
  },
  "replyMessage": {
    "role": "character",
    "name": "Nova",
    "mes": "Pretty quiet, honestly.",
    "extra": {
      "conversation_reply_to": {},
      "conversation_commands": {
        "selfieRequests": [],
        "scheduleUpdates": [],
        "reminders": []
      }
    }
  },
  "messages": [],
  "version": 5
}
```

Set `includePrompt` or `includeGeneration` to return debugging information:

```json
{
  "includePrompt": true,
  "includeGeneration": true
}
```

These responses may contain private Conversation context or provider metadata.

## Model Commands

`/message/send` extracts supported bracket commands from the generated text:

```text
[selfie]
[schedule_update: status="idle", activity="working"]
[reminder: 2h | check the oven]
```

The commands are removed from the visible reply and stored under:

```json
{
  "replyMessage": {
    "extra": {
      "conversation_commands": {
        "selfieRequests": [],
        "scheduleUpdates": [],
        "reminders": []
      }
    }
  }
}
```

The REST API does not execute image generation, schedule updates, or reminder timers. External clients must process those commands themselves.

## Status Codes

| Status | Meaning                                              |
| -----: | ---------------------------------------------------- |
|  `200` | Request completed successfully.                      |
|  `400` | Invalid request or payload.                          |
|  `401` | Authentication is required or invalid.               |
|  `403` | CSRF or another security check rejected the request. |
|  `409` | The supplied settings version is stale.              |
|  `429` | Too many generation requests.                        |
|  `500` | Settings could not be read or saved.                 |
|  `502` | Model generation failed or returned unusable output. |

## Limits

Important limits include:

| Item                       |          Limit |
| -------------------------- | -------------: |
| Normal request payload     |         24 MiB |
| Full store replacement     |        128 MiB |
| Message text               |        256 KiB |
| Thread messages per branch |            250 |
| Character override field   |          8 KiB |
| Directive                  |        256 KiB |
| Group name                 | 512 characters |

`/message/send` is rate-limited. The default limit is 20 requests per user during a 60-second period, unless changed in the server configuration.

## REST API Scope

The REST API supports:

* Reading and replacing Conversation stores.
* Creating Conversation-owned groups.
* Reading and replacing active thread branches.
* Appending messages.
* Generating one selected character reply.
* Building external clients, bots, bridges, and import/export tools.

The REST API does not support running these automatically:

* Proactive or idle messages.
* Scheduled messages.
* Reminder timers.
* Automatic group-speaker selection.
* Character-to-character conversations.
* Notifications.
* Image generation.
* Text-to-speech.
* Roleplay-triggered private reactions.

Clients that need those features must implement their own scheduling and sidecar handling.
