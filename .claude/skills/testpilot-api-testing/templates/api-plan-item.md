# API plan item

Each API plan item is a contract 5.9 plan item (in `manifest.test_plan_items[]`
and `test-plan.md`) plus an entry in `audits/<audit-id>/api-plan.json` that the
runner executes. The two share the `test_plan_item_id`.

## `api-plan.json`

```json
{
  "audit_id": "AUD-20261110-01",
  "target": "example-api",
  "productionConfirmations": 0,
  "items": [
    {
      "test_plan_item_id": "TPI-001",
      "requirement_id": "REQ-LOCAL-001",
      "title": "List items as an authenticated user",
      "state_changing": false,
      "request": {
        "method": "GET",
        "path": "/api/items",
        "query": { "limit": 10 },
        "headers": {},
        "auth": "default"
      },
      "expect": {
        "status": 200,
        "headers": { "content-type": { "contains": "application/json" } },
        "body": {
          "$.items": { "type": "array", "maxItems": 10 },
          "$.items[*].id": { "format": "uuid" },
          "$.items[*].email": { "format": "email" }
        },
        "schema": { "$ref": "#/components/schemas/ItemList" },
        "contract": "report"
      },
      "capture": { "first_id": "$.items[0].id" }
    },
    {
      "test_plan_item_id": "TPI-002",
      "requirement_id": "REQ-LOCAL-002",
      "title": "Create an item (full mode only)",
      "state_changing": true,
      "action": { "action": "create_item", "target": "TP-API item" },
      "request": {
        "method": "POST",
        "path": "/api/items",
        "bodyType": "json",
        "body": { "name": "TP-API-${capture:run_id}" },
        "auth": "default"
      },
      "repeat": 2,
      "expect": { "status": [201, 409] }
    },
    {
      "test_plan_item_id": "TPI-003",
      "requirement_id": "REQ-LOCAL-003",
      "title": "GraphQL: viewer query",
      "state_changing": false,
      "request": {
        "method": "POST",
        "path": "/graphql",
        "bodyType": "graphql",
        "graphql": { "query": "query { viewer { id email } }", "variables": {} },
        "auth": "default"
      },
      "expect": { "status": 200, "graphqlErrors": "none", "body": { "$.data.viewer.id": { "type": "string" } } }
    }
  ]
}
```

## Fields

| Field | Meaning |
|---|---|
| `state_changing` | `true` for anything that writes. Needs `full` mode and an `action` matching `scope.state_changes.allowed_actions`. |
| `request.auth` | `default` (profile auth), `none`, `invalid` (a malformed token), `expired` (`auth.expiredTokenEnvVar`), `second` (`auth.secondAccount`). |
| `request.bodyType` | `json` (default for objects), `form` (urlencoded), `multipart`, `graphql`, `raw` (with `request.contentType`). |
| `${env:NAME}` | Resolved from the environment at run time; never written anywhere. |
| `${capture:name}` | A value captured by an earlier item (`capture`), or `run_id`. |
| `expect.status` | One status or a list of acceptable ones. |
| `expect.headers` | Header name → exact string, `{ "contains": … }` or `{ "regex": … }`. |
| `expect.body` | JSON path (`$.a.b[0].c`, `[*]` for each element) → rule: `type`, `format` (`uuid`, `email`, `date-time`, `date`, `uri`), `equals`, `pattern`, `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `required`, `notEmpty`. |
| `expect.schema` | Inline JSON schema or `{ "$ref": "#/components/schemas/X" }` into the profile's OpenAPI document. |
| `expect.contract` | `report` (default: spec deviations become observations), `fail` (they fail the item), `skip`. |
| `expect.graphqlErrors` | `none` or `present`. |
| `repeat` | Run the request this many times; `expect` applies to the last response, all responses are kept as evidence. |
| `capture` | name → JSON path in the last response, for later items. |

Each `request` reaches only the profile's `baseUrl`; absolute URLs to other
hosts are rejected.
