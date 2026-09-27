# Sample Backlog webhook payloads

One anonymised payload per activity type the adapter recognises, in the shape
a real delivery carries. Generated from the fixtures in
`src/test/fixtures/webhooks.ts` by `src/test/sample-messages.test.ts`;
regenerate it with `pnpm exec vitest run src/test/sample-messages.test.ts -u`
rather than editing it by hand. What Backlog delivers, and where a delivery
differs from the activities API, is recorded with its measurements in
`.claude/rules/backlog-webhook-facts.md` and
`.claude/rules/backlog-pull-request-facts.md`.

Vocabulary throughout: host `example.backlog.com`, bot `Chatbot` (id 999),
users `Alice` (100) and `Bob` (101), project 500, issue 8001, repository 700
(`example-repo`), pull request 12.

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

## Type 3 — Issue Commented — recipients chosen in the notification field

the text carries no `@` at all; `notifications[]` is the only record that the comment was addressed to the bot, and only a webhook carries it (`reason: 2`, Issue Commented)

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
      "content": "Please take a look when you get a chance."
    },
    "changes": []
  },
  "notifications": [
    {
      "id": 4100,
      "alreadyRead": false,
      "reason": 2,
      "user": {
        "id": 999,
        "userId": "chatbot",
        "name": "Chatbot",
        "roleType": 2,
        "lang": "ja",
        "mailAddress": "chatbot@example.com",
        "nulabAccount": null
      },
      "resourceAlreadyRead": false
    }
  ],
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

`…:c<commentId>` with empty text; the change is in `changes[]`. `status` is one of the three issue fields — with `priority` and `resolution` — whose `new_value` is an id string; every other field arrives as a display name, a full text or a bare date (`.claude/rules/backlog-webhook-facts.md`)

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

one delivery, one message per `content.link[]` entry: the thread id comes from `link[].id` (a decimal **string** here) and the message id from `link[].comment.id`, the comment the batch really wrote on that issue. `content.comment` repeats the text with no id, `changes[]` describes the whole batch and carries no `old_value`, and a `status` change is a status **id**.

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
      "content": "Moving these to done."
    },
    "link": [
      {
        "id": "8001",
        "key_id": "42",
        "title": "Deploy fails on the staging space",
        "comment": {
          "id": 3101,
          "content": "Moving these to done."
        }
      },
      {
        "id": "8002",
        "key_id": "43",
        "title": "Retry the failed deploy",
        "comment": {
          "id": 3102,
          "content": "Moving these to done."
        }
      }
    ],
    "individual_update": false,
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

## Type 14 — Issue Multi Updated — one issue

a bulk update of a **single** issue is a type 14 too, with a one-entry `link[]`. The screen decides the activity type, not the number of issues: the same field changed on the issue’s own page arrives as a type 2. `notifications` is empty here because the batch changed no assignee; a batch that changed one carries a reason-1 entry per issue, none of which says which issue it belongs to.

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
        "id": "8001",
        "key_id": "42",
        "title": "Deploy fails on the staging space",
        "comment": {
          "id": 3101,
          "content": ""
        }
      }
    ],
    "individual_update": false,
    "changes": [
      {
        "field": "status",
        "new_value": "3",
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

200 Ignored — `POST /issues/:id/comments/:commentId/notifications` added recipients to a comment that already exists, so `content.comment` is that **original** comment — no new comment exists and nothing changed — and the message id repeats one already dispatched. Choosing recipients while posting a comment emits a plain type 3 instead.

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

## Type 18 — Pull Request Added

`<host>:pr:<repositoryId>:<number>:r` — the thread id comes from `content.repository.id` and `content.number`, never from `content.id`, which addresses no endpoint. The `summary` keeps mention notation raw while a description or comment carries it rewritten. `content.assignee` is the account the pull request was opened for, and opening one for the bot is a mention; on a 19 or a 20 the same key is the standing assignee and means nothing.

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
  "type": 18,
  "content": {
    "id": 90001,
    "number": 12,
    "summary": "Retry the deploy step <@U999>",
    "description": "Fixes the flaky staging deploy.",
    "base": "main",
    "branch": "fix/deploy-retry",
    "diff": null,
    "assignee": {
      "id": 999,
      "userId": "chatbot",
      "name": "Chatbot",
      "roleType": 94,
      "lang": "ja"
    },
    "comment": null,
    "changes": [],
    "issue": null,
    "repository": {
      "id": 700,
      "name": "example-repo",
      "description": null
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

## Type 20 — Comment Added on Pull Request

`…:c<commentId>` — pull-request comment ids come from a different sequence than issue comment ids

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
  "type": 20,
  "content": {
    "id": 90001,
    "number": 12,
    "summary": "Retry the deploy step on a 5xx",
    "description": "Fixes the flaky staging deploy.",
    "base": "main",
    "branch": "fix/deploy-retry",
    "diff": null,
    "assignee": null,
    "comment": {
      "id": 7000001,
      "content": "Looks good, one question about the timeout."
    },
    "changes": [],
    "issue": null,
    "repository": {
      "id": 700,
      "name": "example-repo",
      "description": null
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

## Type 20 — Comment Added on Pull Request — with an attachment

`changes[].field` is `attachment` and names the file with **no id**; the id is resolved lazily from `GET …/pullRequests/:number/attachments`

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
  "type": 20,
  "content": {
    "id": 90001,
    "number": 12,
    "summary": "Retry the deploy step on a 5xx",
    "description": "Fixes the flaky staging deploy.",
    "base": "main",
    "branch": "fix/deploy-retry",
    "diff": null,
    "assignee": null,
    "comment": {
      "id": 7000001,
      "content": "Trace attached."
    },
    "changes": [
      {
        "field": "attachment",
        "new_value": "trace.log",
        "old_value": "",
        "field_text": "attachment",
        "type": "standard"
      }
    ],
    "issue": null,
    "repository": {
      "id": 700,
      "name": "example-repo",
      "description": null
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

## Type 19 — Pull Request Updated — merged or closed

merge (from the UI or by pushing the merge to the base branch) and close both arrive here, as a `status` change by id string (`1` Open, `2` Closed, `3` Merged). There is no separate merge or delete activity.

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
  "type": 19,
  "content": {
    "id": 90001,
    "number": 12,
    "summary": "Retry the deploy step on a 5xx",
    "description": "Fixes the flaky staging deploy.",
    "base": "main",
    "branch": "fix/deploy-retry",
    "diff": null,
    "assignee": null,
    "comment": {
      "id": 7000002,
      "content": ""
    },
    "changes": [
      {
        "field": "status",
        "new_value": "3",
        "old_value": "1",
        "field_text": "status",
        "type": "standard"
      }
    ],
    "issue": null,
    "repository": {
      "id": 700,
      "name": "example-repo",
      "description": null
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

## Type 19 — Pull Request Updated — assignee

`changes[].field` is `assignee` — not the issue side’s `assigner`

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
  "type": 19,
  "content": {
    "id": 90001,
    "number": 12,
    "summary": "Retry the deploy step on a 5xx",
    "description": "Fixes the flaky staging deploy.",
    "base": "main",
    "branch": "fix/deploy-retry",
    "diff": null,
    "assignee": null,
    "comment": {
      "id": 7000002,
      "content": ""
    },
    "changes": [
      {
        "field": "assignee",
        "new_value": "Chatbot",
        "old_value": "",
        "field_text": "assignee",
        "type": "standard"
      }
    ],
    "issue": null,
    "repository": {
      "id": 700,
      "name": "example-repo",
      "description": null
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

## Type 19 — Pull Request Updated — summary

the `PATCH`’s own `comment` text arrives as `content.comment.content`

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
  "type": 19,
  "content": {
    "id": 90001,
    "number": 12,
    "summary": "Retry the deploy step on a 5xx",
    "description": "Fixes the flaky staging deploy.",
    "base": "main",
    "branch": "fix/deploy-retry",
    "diff": null,
    "assignee": null,
    "comment": {
      "id": 7000002,
      "content": "Rewording the summary."
    },
    "changes": [
      {
        "field": "summary",
        "new_value": "Retry the deploy step on a 5xx",
        "old_value": "Retry the deploy step",
        "field_text": "summary",
        "type": "standard"
      }
    ],
    "issue": null,
    "repository": {
      "id": 700,
      "name": "example-repo",
      "description": null
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

## Type 21 — Pull Request Deleted (documented) / Merged (`backlog-js`)

200 Ignored — never observed on a real space, and the two sources disagree on what it even means, so it is not registered and not dispatched

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
  "type": 21,
  "content": {
    "id": 90001,
    "number": 12,
    "summary": "Retry the deploy step on a 5xx",
    "description": "Fixes the flaky staging deploy.",
    "base": "main",
    "branch": "fix/deploy-retry",
    "diff": null,
    "assignee": null,
    "comment": null,
    "changes": [],
    "issue": null,
    "repository": {
      "id": 700,
      "name": "example-repo",
      "description": null
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

## Type 12 — Git Pushed

200 Ignored — a push is not a conversation, and the payload carries no pull-request reference

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
  "type": 12,
  "content": {
    "repository": {
      "id": 700,
      "name": "example-repo",
      "description": null
    },
    "change_type": "update",
    "revision_type": "commit",
    "ref": "refs/heads/main",
    "revision_count": 1,
    "revisions": [
      {
        "rev": "0f1e2d3c4b5a69788796a5b4c3d2e1f009182736",
        "comment": "Merge"
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

