# Phase 8c demo checklist: custom tools

Prerequisites: `pnpm docker:up && pnpm sample:load`. Sign in to Orbit Desk (http://localhost:8081) as `admin@example.com` and open **Settings → Tools & MCP**.

## A custom tool

1. **Custom tools** lists the sample tool "Store systems status".
2. Click **New custom tool** and fill in:
   - Title "Warehouse check", name `warehouse_check`;
   - what it does, in a sentence;
   - method GET, address `http://fake-providers:4010/{path}`;
   - **Add a value**: name `path`.
3. **Create tool.** It starts switched off.
4. **Test** with `{"path": "health"}`. The result shows `"status": "ok"`.
5. Set **AI may use it** to Yes.
6. Try an internal address such as `http://10.0.0.5/health`: it is refused.

For a real system, choose a key header, save the tool, then add the key on the tool's row.

## Letting another role create tools

1. Under **Who can create custom tools**, tick **Team lead**.
2. Sign in as `maya.lindqvist@tms.example` (password `Sample-Passw0rd!`). Settings now shows one tab, with the custom tools only.
3. Create a tool as Maya. It shows "Created by Maya Lindqvist".
4. Maya still can't add MCP servers or keys.
5. Untick **Team lead** as the admin. Maya loses access within seconds.

## A custom MCP server

1. Under **Add an MCP server**, enter a name and `http://fake-providers:4010/mcp`.
2. **Sync tools** fails until the key is saved: the card shows "Last sync failed".
3. Save the token `demo-store-token`, then **Sync tools**. Its tools appear, switched off.
4. **Test** "Order status" with customer `maria.lopez@example.com` and `{"order_id": "DS-20517"}`.
