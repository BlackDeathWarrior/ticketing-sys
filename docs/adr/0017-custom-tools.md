# ADR 0017: Custom tools and who may create them

Status: accepted (2026-10-01)

## Context

Tools came only from MCP servers (ADR 0013). A company with a plain HTTP API had to write an MCP server before the AI could use it. The product owner asked for custom tools created in Settings, by admins, or by lower roles once they are given permission.

## Decision

**What a custom tool is**

- One HTTP request, described in Settings → Tools & MCP: a name, a title, a description (the AI decides from it), a method, an address and the values the AI fills in.
- `{name}` in the address is replaced by that value, escaped. Other values go in the query string for GET and DELETE, or in a JSON body for POST, PUT and PATCH.
- An optional key is sent as `Authorization: Bearer` or `X-Api-Key`. It is a secret (`tool.custom_<name>.token`), write-only, and only people with `settings:secrets` can set it.

**It runs through the existing gateway**

- Custom tools are rows in `tools` (with an `http` column) under one built-in holder in `mcp_servers` (`kind = custom`). The holder never appears in the server list.
- So everything from ADR 0013 applies unchanged: argument validation, the customer's email filled in by TMS and hidden from the model, risk tiers, approvals for transactional tools, `tool_calls`, audit and outbox.
- The model sees them as `custom__<name>`.

**Safety**

- The address is checked against private networks when saved and on every call. Hosts in `TOOL_PRIVATE_HOSTS` are the only exception.
- A placeholder can't be in the host name: where customer data goes is fixed by the person who defined the tool.
- Redirects are refused, answers are capped at 1 MB, and each call has a timeout.
- A 4xx answer is the system saying no and is passed to the AI. 5xx, 429 and network errors count against a circuit breaker, one per custom tool.
- New tools start switched off.

**Who may create them**

- New permission `tool:create`: create, edit, test, switch on and delete custom tools. Administrators have it.
- An admin can grant it to other roles under "Who can create custom tools" (`PUT` and `DELETE /roles/:key/permissions/tool:create`, needs `user:manage`).
- Only permissions in `DELEGABLE_PERMISSIONS` can be granted this way, and the administrator role can't be changed. Role permissions are otherwise fixed in code; the seed keeps delegated grants across deploys.
- MCP servers and keys stay with administrators (`tool:manage`, `settings:secrets`).
- A tool with call history can't be deleted, only switched off.

## Consequences

- A role with `tool:create` can make the AI send a customer's data to any public address the role chooses. Grant it to people you would trust with that.
- A custom tool is one request. Multi-step flows, pagination and response mapping need an MCP server.
- Custom headers other than the key are not supported.
- A grant takes effect within ten seconds on other API instances (the permission cache).
