# ADR 0036: An AI helper for the tool forms

Status: accepted (2026-10-04).

## Context

Custom tools (ADR 0017) and MCP servers (ADR 0013) are added through forms that ask for a method, an address with placeholders, typed parameters, a risk tier and the parameter that carries the customer's email. A person who knows what the tool should do, but not what those words mean, cannot fill them in. The user asked for a small AI helper beside the forms: the person describes what they want and the AI does the form for them.

## Decision

- **The helper fills in the form; the person saves it.** `AiToolHelperService` (`apps/api/src/ai/ai-tool-helper.service.ts`) takes what the person wrote, the form as it stands, and answers with the fields it could fill in, a short message and a list of what is still needed. It stores nothing and creates nothing. Saving goes through the existing routes, with their checks: the address check on every save, the cross-field rules of `createCustomToolSchema`, the permissions.
- **It never switches a tool on.** The draft has no `enabled` field. A new tool starts switched off, as before.
- **It never takes a key.** The prompt forbids putting a key in the answer and tells the person not to paste one; a message that carries something shaped like a key is replaced (`leaksInternals`). Keys are saved after the tool exists, by someone with `settings:secrets` (ADR 0009).
- **It never invents an address.** The prompt tells the model to leave the address out and ask for it. The questions in `missing` are written for a person who will pass them on to whoever runs the system.
- **The model's answer is data.** It is parsed with `customToolDraftSchema` or `mcpServerDraftSchema` (`packages/shared/src/tool-helper.ts`): a field that does not fit is left out, never passed to the form. A suggested name that is already taken is removed and asked for again.
- **Two routes, the forms' own permissions.** `POST /ai/tool-helper/custom-tool` needs `tool:create`; `POST /ai/tool-helper/mcp-server` needs `tool:manage`. So the helper is offered exactly to the people who may save the form.
- **The `copilot` role.** The helper assists staff, like the reply suggestion, so it uses the same model role and needs no new model setting. Prompt version `tool-helper-v1`. Calls are in `llm_calls` like every model call; there is no `ai_runs` row, because nothing happens to a ticket.
- **In Orbit Desk** the helper is one component, `ToolHelper`, shown at the top of the custom tool dialog (new and edit) and above the "Add an MCP server" form. It keeps the exchange for the open form only; a second description changes the form instead of starting again.

- **"Check connection" changes nothing.** `ToolsService.checkCustom` asks whether the address in the form answers, saved or not: a lookup (GET) is sent with "test" in place of each value, and for anything else the system is only asked whether the address is there (OPTIONS). `checkServer` connects to an MCP server and counts the tools it lists, storing nothing. Both check the address like a save does, refuse redirects, and send a saved key only to the host it was saved for. The answer is a plain sentence plus the technical detail.
- **"Diagnose with AI" explains a failed check and saves it as a bug.** `AiToolHelperService.diagnose` gives the model what was tried and what came back, and asks for a likely cause and a few steps in plain words. The failure is then saved as a ticket through `InboundService.handle()`: channel `agent`, tag `tool-bug`, `metadata.kind = 'tool_problem'`, AI off, never classified, the sender a built-in "Tool checks (automatic reports)" customer. The address is the thread, so another failed try joins the same ticket while it is open. With no model available the check's own words stand in and the ticket is still made. A routing rule on the tag sends these tickets to whoever looks after integrations.

## Consequences

- With no model for the `copilot` role the helper answers that it is not available, and the forms work as before.
- What the person writes goes to the model provider. The panel says not to paste keys or passwords.
- The helper can be wrong about the risk tier or the customer parameter. The form shows both, and the prompt tells the model to choose the more careful tier when in doubt; the person who saves is responsible, as with a form filled in by hand.
- The work shipped compile-only, with no tests and no golden, by the user's standing decision. Treat it as untested until it has been tried by hand.
