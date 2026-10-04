import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestClient, uniq } from './helpers';

/**
 * Who is let in on the routes a phone agent calls (ADR 0039, 0040). Nothing
 * here reaches Sarvam or ElevenLabs: these are the desk's own doors.
 */
let t: TestClient;
let admin: string;

const HOOK_TOKEN = `hook-token-${uniq()}-0123456789`;
const CALL = { interactionId: uniq('call-'), phone: '919830012345' };
const tool = (name: string, token?: string) =>
  t.call('POST', `/phone/sarvam/tools/${name}`, { token, body: CALL });
const settings = (enabled: boolean) =>
  t.call('PUT', '/settings/channels/phone', {
    token: admin,
    body: {
      enabled,
      orgId: 'org-test',
      workspaceId: 'workspace-test',
      appId: 'app-test',
      appVersion: 1,
      connectionId: 'connection-test',
      agentPhoneNumber: '+918000000000',
    },
  });

beforeAll(async () => {
  t = await startApp();
  admin = await t.adminToken();
}, 60_000);

afterAll(async () => {
  await settings(false);
  await t.call('DELETE', '/settings/secrets/phone.hook_token', { token: admin });
  await t?.close();
});

describe("the phone agent's hooks", () => {
  it('do not exist until phone calls are switched on', async () => {
    expect((await settings(false)).status).toBe(200);
    expect((await tool('list_tools', HOOK_TOKEN)).status).toBe(404);
  });

  it('refuse everyone while no hook token is saved', async () => {
    expect((await settings(true)).status).toBe(200);
    expect((await tool('list_tools')).status).toBe(401);
    expect((await tool('list_tools', HOOK_TOKEN)).status).toBe(401);
  });

  it('let in the saved token and nothing else', async () => {
    const saved = await t.call('PUT', '/settings/secrets/phone.hook_token', {
      token: admin,
      body: { value: HOOK_TOKEN },
    });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain(HOOK_TOKEN);

    expect((await tool('list_tools')).status).toBe(401);
    expect((await tool('list_tools', `${HOOK_TOKEN}x`)).status).toBe(401);
    // A staff token is not the hook token.
    expect((await tool('list_tools', admin)).status).toBe(401);

    const ok = await tool('list_tools', HOOK_TOKEN);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await tool('no_such_tool', HOOK_TOKEN)).status).toBe(404);
  });
});

describe('call events from ElevenLabs', () => {
  it('are refused without a valid signature', async () => {
    const event = {
      type: 'post_call_transcription',
      data: { conversation_id: uniq('conv_') },
    };
    const unsigned = await t.call('POST', '/phone/elevenlabs/events', { body: event });
    expect(unsigned.status).toBe(401);
  });
});
