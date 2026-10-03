import type {
  CheckPhoneVerification,
  CreateTicket,
  EventResult,
  Identity,
  Incident,
  Message,
  PhoneVerificationChecked,
  PhoneVerificationStarted,
  Rating,
  ReportEvent,
  StartPhoneVerification,
  Ticket,
  TicketList,
  TicketState,
} from './types';

export interface TmsClientOptions {
  /** Where TMS is served, e.g. `https://support.example.com`. */
  baseUrl: string;
  /** An integration API key (`tms_sk_…`). Keep it on your server, never in a browser. */
  apiKey: string;
  /** Milliseconds before a request is given up. Default 10 000. */
  timeoutMs?: number;
  /** Defaults to the global `fetch` (Node 18+). */
  fetch?: typeof fetch;
}

/** A request the API refused. `status` is the HTTP status; 429 carries `retryAfter` seconds. */
export class TmsApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
    readonly retryAfter: number | null,
  ) {
    super(message);
    this.name = 'TmsApiError';
  }
}

interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  idempotencyKey?: string;
}

/**
 * The TMS integration API for one integration. Every method resolves with
 * the API's answer or rejects with a `TmsApiError` (or the network error).
 */
export class TmsClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TmsClientOptions) {
    this.base = `${options.baseUrl.replace(/\/+$/, '')}/api/v1`;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Who this key is. A cheap way to check the connection and the key. */
  whoAmI(): Promise<Identity> {
    return this.request('GET', '/integration');
  }

  readonly tickets = {
    /**
     * Raises a ticket for one of your users. With an `idempotencyKey`, a
     * retry of the same call returns the ticket made the first time.
     */
    create: (ticket: CreateTicket, opts: { idempotencyKey?: string } = {}): Promise<Ticket> =>
      this.request('POST', '/integration/tickets', {
        body: ticket,
        idempotencyKey: opts.idempotencyKey,
      }),

    get: (reference: string): Promise<Ticket> =>
      this.request('GET', `/integration/tickets/${encodeURIComponent(reference)}`),

    /**
     * Your tickets, newest first. `state` is where a ticket is in its life;
     * `customer` is your own id for a person, for "your requests" in your app.
     */
    list: (
      filter: {
        externalRef?: string;
        customer?: string;
        state?: TicketState;
        limit?: number;
        offset?: number;
      } = {},
    ): Promise<TicketList> => this.request('GET', '/integration/tickets', { query: filter }),

    /** What the customer wrote and was sent. `after` (a `createdAt`) returns only newer ones. */
    messages: (reference: string, opts: { after?: string } = {}): Promise<Message[]> =>
      this.request('GET', `/integration/tickets/${encodeURIComponent(reference)}/messages`, {
        query: opts,
      }),

    /** The customer's follow-up, written in your app. */
    addMessage: (
      reference: string,
      body: string,
      opts: { idempotencyKey?: string } = {},
    ): Promise<Message> =>
      this.request('POST', `/integration/tickets/${encodeURIComponent(reference)}/messages`, {
        body: { body },
        idempotencyKey: opts.idempotencyKey,
      }),

    /** The customer's rating (1 to 5) of a solved ticket, given in your app. */
    rate: (reference: string, rating: number, comment?: string): Promise<Rating> =>
      this.request('POST', `/integration/tickets/${encodeURIComponent(reference)}/rating`, {
        body: { rating, ...(comment ? { comment } : {}) },
      }),
  };

  readonly incidents = {
    /** Something of yours is failing. Reports with one fingerprint share one ticket. */
    report: (event: ReportEvent): Promise<EventResult> =>
      this.request('POST', '/integration/events', { body: { ...event, status: 'firing' } }),

    /** It has recovered. Resolves the incident, and its ticket if nobody has taken it. */
    resolve: (fingerprint: string, message?: string): Promise<EventResult> =>
      this.request('POST', '/integration/events', {
        body: { fingerprint, status: 'resolved', ...(message ? { message } : {}) },
      }),

    list: (filter: { status?: 'open' | 'resolved'; limit?: number } = {}): Promise<Incident[]> =>
      this.request('GET', '/integration/incidents', { query: filter }),
  };

  readonly customers = {
    /**
     * Sends a 6-digit code to the customer's WhatsApp. It works for 10 minutes;
     * a new code retires the earlier one. A 400, 409, 429 or 502 `TmsApiError`
     * says why nothing was sent. Needs the `integration:customer` scope.
     */
    startPhoneVerification: (input: StartPhoneVerification): Promise<PhoneVerificationStarted> =>
      this.request('POST', '/integration/customers/phone-verifications', { body: input }),

    /**
     * Checks the code the customer typed. On success the number is proven for
     * them. A 400 `TmsApiError` carries `body.reason`: `wrong-code`, `expired`,
     * `too-many-attempts` or `no-code`.
     */
    checkPhoneVerification: (input: CheckPhoneVerification): Promise<PhoneVerificationChecked> =>
      this.request('POST', '/integration/customers/phone-verifications/check', { body: input }),
  };

  private async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const query = Object.entries(opts.query ?? {})
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const res = await this.fetchImpl(`${this.base}${path}${query ? `?${query}` : ''}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        accept: 'application/json',
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const message =
        parsed && typeof parsed === 'object' && 'message' in parsed
          ? String((parsed as { message: unknown }).message)
          : `Request failed with status ${res.status}`;
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new TmsApiError(
        res.status,
        message,
        parsed,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      );
    }
    return parsed as T;
  }
}
