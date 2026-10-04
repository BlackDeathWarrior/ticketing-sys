import { Injectable } from '@nestjs/common';
import type { PhoneAgentProvider, PhoneRecording, PhoneTranscript } from './phone-provider';
import { SarvamAgentsClient } from './sarvam-agents.client';

/** Sarvam's Voice Agent on a number rented from Sarvam (ADR 0039). */
@Injectable()
export class SarvamProvider implements PhoneAgentProvider {
  readonly id = 'sarvam' as const;

  constructor(private readonly client: SarvamAgentsClient) {}

  transcript(interactionId: string): Promise<PhoneTranscript | null> {
    return this.client.transcript(interactionId);
  }

  async recording(interactionId: string): Promise<PhoneRecording | null> {
    const wav = await this.client.recording(interactionId);
    return wav ? { audio: wav, type: 'audio/wav' } : null;
  }
}
