import { Injectable } from '@nestjs/common';
import type { PhoneProviderId } from '@tms/shared';
import type { PhoneAgentProvider } from './phone-provider';
import { SarvamProvider } from './sarvam.provider';

/** Hands out the voice agent provider a call belongs to. */
@Injectable()
export class PhoneProviders {
  private readonly byId: Record<string, PhoneAgentProvider>;

  constructor(sarvam: SarvamProvider) {
    this.byId = { [sarvam.id]: sarvam };
  }

  get(id: PhoneProviderId): PhoneAgentProvider {
    const provider = this.byId[id];
    if (!provider) throw new Error(`No phone agent provider called ${id}`);
    return provider;
  }
}
