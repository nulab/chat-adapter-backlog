# Sample Backlog webhook payloads

One anonymised payload per activity type the adapter recognises, in the shape
a real delivery carries. Generated from the fixtures in
`src/test/fixtures/webhooks.ts`, so this file and the test suite cannot
disagree; regenerate it rather than editing it by hand.

The body is one Activity object as returned by
[Get Recent Updates](https://developer.nulab.com/docs/backlog/api/2/get-recent-updates/).
Backlog publishes no dedicated webhook-payload page, and measured payloads match
the activity shape field for field. Vocabulary throughout: host
`example.backlog.com`, bot `Chatbot` (id 999), users `Alice` (100) and `Bob`
(101), project 500, issue 8001.

Three properties of these payloads decide how a handler must read them:

- **Nothing in the body identifies the space.** `project.projectKey` and the
  numeric ids are not unique across Backlog spaces, so the host comes from the
  request URL the webhook was registered with, never from the payload.
- **Backlog attaches a changelog comment to every field update.** A set
  `content.comment.id` therefore does not mean "no field change" — handlers key
  on `content.changes[]`.
- **`notifications` is always empty** (emptied by Backlog in 2022), so who was
  notified cannot be read from a delivery.

## Type 1 — Issue Created

`<host>:issue:<issueId>:r` — text is `summary` + blank line + `description`

```json
{
  "id": 71828,
  "project": {
    "id": 500,
    "projectKey": "EXAMPLE",
    "name": "Example project",
    "archived": false,
    "displayOrder": 2147483646
  },
  "type": 1,
  "content": {
    "id": 8001,
    "key_id": 42,
    "summary": "Deploy fails on the staging space",
    "description": "Reproduces on every push to main.",
    "assignee": {
      "id": 999,
      "name": "Chatbot"
    }
  },
  "notifications": [],
  "createdUser": {
    "id": 100,
    "userId": "alice",
    "name": "Alice",
    "roleType": 2,
    "lang": "ja",
    "mailAddress": "alice@example.com",
    "nulabAccount": null
  },
  "created": "2026-09-03T04:05:06Z"
}
```

## Type 3 — Issue Commented

`<host>:issue:<issueId>:c<commentId>` — a plain comment carries no changes

```json
{
  "id": 71828,
  "project": {
    "id": 500,
    "projectKey": "EXAMPLE",
    "name": "Example project",
    "archived": false,
    "displayOrder": 2147483646
  },
  "type": 3,
  "content": {
    "id": 8001,
    "key_id": 42,
    "summary": "Deploy fails on the staging space",
    "description": "Reproduces on every push to main.",
    "comment": {
      "id": 3001,
      "content": "Any progress on this?"
    },
    "changes": []
  },
  "notifications": [],
  "createdUser": {
    "id": 100,
    "userId": "alice",
    "name": "Alice",
    "roleType": 2,
    "lang": "ja",
    "mailAddress": "alice@example.com",
    "nulabAccount": null
  },
  "created": "2026-09-03T04:05:06Z"
}
```

## Type 2 — Issue Updated — status only

`…:c<commentId>` with empty text; the change is in `changes[]`

```json
{
  "id": 71828,
  "project": {
    "id": 500,
    "projectKey": "EXAMPLE",
    "name": "Example project",
    "archived": false,
    "displayOrder": 2147483646
  },
  "type": 2,
  "content": {
    "id": 8001,
    "key_id": 42,
    "summary": "Deploy fails on the staging space",
    "description": "Reproduces on every push to main.",
    "comment": {
      "id": 3002,
      "content": null
    },
    "changes": [
      {
        "field": "status",
        "new_value": "4",
        "old_value": "3",
        "field_text": "status",
        "type": "standard"
      }
    ],
    "shared_files": [],
    "external_file_links": []
  },
  "notifications": [],
  "createdUser": {
    "id": 100,
    "userId": "alice",
    "name": "Alice",
    "roleType": 2,
    "lang": "ja",
    "mailAddress": "alice@example.com",
    "nulabAccount": null
  },
  "created": "2026-09-03T04:05:06Z"
}
```

## Type 2 — Issue Updated — assignee

`changes[].field` is `assigner` and `new_value` is a display name

```json
{
  "id": 71828,
  "project": {
    "id": 500,
    "projectKey": "EXAMPLE",
    "name": "Example project",
    "archived": false,
    "displayOrder": 2147483646
  },
  "type": 2,
  "content": {
    "id": 8001,
    "key_id": 42,
    "summary": "Deploy fails on the staging space",
    "description": "Reproduces on every push to main.",
    "comment": {
      "id": 3002,
      "content": null
    },
    "changes": [
      {
        "field": "assigner",
        "new_value": "Chatbot",
        "old_value": "",
        "field_text": "assigner",
        "type": "standard"
      }
    ],
    "shared_files": [],
    "external_file_links": []
  },
  "notifications": [],
  "createdUser": {
    "id": 100,
    "userId": "alice",
    "name": "Alice",
    "roleType": 2,
    "lang": "ja",
    "mailAddress": "alice@example.com",
    "nulabAccount": null
  },
  "created": "2026-09-03T04:05:06Z"
}
```

## Type 2 — Issue Updated — description

`changes[]` carries both complete bodies

```json
{
  "id": 71828,
  "project": {
    "id": 500,
    "projectKey": "EXAMPLE",
    "name": "Example project",
    "archived": false,
    "displayOrder": 2147483646
  },
  "type": 2,
  "content": {
    "id": 8001,
    "key_id": 42,
    "summary": "Deploy fails on the staging space",
    "description": "Reproduces on every push to main.",
    "comment": {
      "id": 3002,
      "content": ""
    },
    "changes": [
      {
        "field": "description",
        "new_value": "Reproduces on every push to main, since 0.4.0.",
        "old_value": "Reproduces on every push to main.",
        "field_text": "description",
        "type": "standard"
      }
    ],
    "shared_files": [],
    "external_file_links": []
  },
  "notifications": [],
  "createdUser": {
    "id": 100,
    "userId": "alice",
    "name": "Alice",
    "roleType": 2,
    "lang": "ja",
    "mailAddress": "alice@example.com",
    "nulabAccount": null
  },
  "created": "2026-09-03T04:05:06Z"
}
```

## Type 2 — Issue Updated — attachment added

a changelog comment; the change is visible only in the comment’s REST `changeLog`

```json
{
  "id": 71828,
  "project": {
    "id": 500,
    "projectKey": "EXAMPLE",
    "name": "Example project",
    "archived": false,
    "displayOrder": 2147483646
  },
  "type": 2,
  "content": {
    "id": 8001,
    "key_id": 42,
    "summary": "Deploy fails on the staging space",
    "description": "Reproduces on every push to main.",
    "comment": {
      "id": 3002,
      "content": null
    },
    "changes": [],
    "shared_files": [],
    "external_file_links": [],
    "attachments": [
      {
        "id": 9001,
        "name": "trace.log",
        "size": 2048
      }
    ]
  },
  "notifications": [],
  "createdUser": {
    "id": 100,
    "userId": "alice",
    "name": "Alice",
    "roleType": 2,
    "lang": "ja",
    "mailAddress": "alice@example.com",
    "nulabAccount": null
  },
  "created": "2026-09-03T04:05:06Z"
}
```

## Type 2 — Issue Updated — comment and status together

one event, not two

```json
{
  "id": 71828,
  "project": {
    "id": 500,
    "projectKey": "EXAMPLE",
    "name": "Example project",
    "archived": false,
    "displayOrder": 2147483646
  },
  "type": 2,
  "content": {
    "id": 8001,
    "key_id": 42,
    "summary": "Deploy fails on the staging space",
    "description": "Reproduces on every push to main.",
    "comment": {
      "id": 3002,
      "content": "Fixed in the latest build."
    },
    "changes": [
      {
        "field": "status",
        "new_value": "4",
        "old_value": "3",
        "field_text": "status",
        "type": "standard"
      }
    ],
    "shared_files": [],
    "external_file_links": []
  },
  "notifications": [],
  "createdUser": {
    "id": 100,
    "userId": "alice",
    "name": "Alice",
    "roleType": 2,
    "lang": "ja",
    "mailAddress": "alice@example.com",
    "nulabAccount": null
  },
  "created": "2026-09-03T04:05:06Z"
}
```

## Type 2 — Issue Updated — no comment id

`<host>:issue:<issueId>:u:<created>`, the rare update-without-comment path

```json
{
  "id": 71828,
  "project": {
    "id": 500,
    "projectKey": "EXAMPLE",
    "name": "Example project",
    "archived": false,
    "displayOrder": 2147483646
  },
  "type": 2,
  "content": {
    "id": 8001,
    "key_id": 42,
    "summary": "Deploy fails on the staging space",
    "description": "Reproduces on every push to main.",
    "changes": [
      {
        "field": "status",
        "new_value": "4",
        "old_value": "3",
        "field_text": "status",
        "type": "standard"
      }
    ]
  },
  "notifications": [],
  "createdUser": {
    "id": 100,
    "userId": "alice",
    "name": "Alice",
    "roleType": 2,
    "lang": "ja",
    "mailAddress": "alice@example.com",
    "nulabAccount": null
  },
  "created": "2026-09-03T04:05:06Z"
}
```

## Type 4 — Issue Deleted

dispatched as `processMessageDeleted` on the root message

```json
{
  "id": 71828,
  "project": {
    "id": 500,
    "projectKey": "EXAMPLE",
    "name": "Example project",
    "archived": false,
    "displayOrder": 2147483646
  },
  "type": 4,
  "content": {
    "id": 8001,
    "key_id": 42
  },
  "notifications": [],
  "createdUser": {
    "id": 100,
    "userId": "alice",
    "name": "Alice",
    "roleType": 2,
    "lang": "ja",
    "mailAddress": "alice@example.com",
    "nulabAccount": null
  },
  "created": "2026-09-03T04:05:06Z"
}
```

## Type 14 — Issue Multi Updated

200 Ignored — no per-issue comment exists

```json
{
  "id": 71828,
  "project": {
    "id": 500,
    "projectKey": "EXAMPLE",
    "name": "Example project",
    "archived": false,
    "displayOrder": 2147483646
  },
  "type": 14,
  "content": {
    "tx_id": "9876",
    "comment": {
      "content": ""
    },
    "link": [
      {
        "id": 8001,
        "key_id": 42,
        "title": "Deploy fails on the staging space",
        "comment": {
          "id": 3003,
          "content": ""
        }
      }
    ],
    "changes": [
      {
        "field": "status",
        "new_value": "4",
        "type": "standard"
      }
    ]
  },
  "notifications": [],
  "createdUser": {
    "id": 100,
    "userId": "alice",
    "name": "Alice",
    "roleType": 2,
    "lang": "ja",
    "mailAddress": "alice@example.com",
    "nulabAccount": null
  },
  "created": "2026-09-03T04:05:06Z"
}
```

## Type 17 — Comment Notification Added

200 Ignored — repeats an existing comment

```json
{
  "id": 71828,
  "project": {
    "id": 500,
    "projectKey": "EXAMPLE",
    "name": "Example project",
    "archived": false,
    "displayOrder": 2147483646
  },
  "type": 17,
  "content": {
    "id": 8001,
    "key_id": 42,
    "comment": {
      "id": 3001,
      "content": "Any progress on this?"
    }
  },
  "notifications": [],
  "createdUser": {
    "id": 100,
    "userId": "alice",
    "name": "Alice",
    "roleType": 2,
    "lang": "ja",
    "mailAddress": "alice@example.com",
    "nulabAccount": null
  },
  "created": "2026-09-03T04:05:06Z"
}
```

