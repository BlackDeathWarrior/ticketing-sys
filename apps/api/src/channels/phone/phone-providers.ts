import { Injectable } from '@nestjs/common';
import type { PhoneProviderId } from '@tms/shared';
import { ElevenLabsProvider } from './elevenlabs/elevenlabs.provider';
import type { PhoneAgentProvider } from './phone-provider';
import { SarvamProvider } from './sarvam.provider';

/** Hands out the voice agent provider a call belongs to. */
@Injectable()
export class PhoneProviders {
  private readonly byId: Record<string, PhoneAgentProvider>;

  constructor(sarvam: SarvamProvider, elevenlabs: ElevenLabsProvider) {
    this.byId = { [sarvam.id]: sarvam, [elevenlabs.id]: elevenlabs };
  }

  get(id: PhoneProviderId): PhoneAgentProvider {
    const provider = this.byId[id];
    if (!provider) throw new Error(`No phone agent provider called ${id}`);
    return provider;
  }
}
