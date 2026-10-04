import { useEffect } from 'react';
import { StatusLight } from '../../components/ui';
import { useSession } from '../../lib/session';
import { useGet } from '../../lib/useGet';

interface Identity {
  type: string;
  value: string;
  verified: boolean;
}

/**
 * The customer's phone number with a light: green when the number was proven
 * to be theirs (a code they typed in an app that knows them, or a colleague
 * who vouched for it), grey when it is only what a channel reported. The label
 * says the same in words. A proven number is what lets the AI use order and
 * cart tools for a WhatsApp sender (ADR 0034).
 */
export function CustomerPhone({
  customerId,
  phone,
  liveTick,
}: {
  customerId: string;
  /** The number on the ticket's customer, shown when the record cannot be read. */
  phone: string | null;
  liveTick: number;
}) {
  const { can } = useSession();
  const customer = useGet<{ identities?: Identity[] }>(
    can('customer:read') ? `/customers/${customerId}` : null,
  );
  const reload = customer.reload;
  useEffect(() => {
    if (liveTick) void reload();
  }, [liveTick, reload]);

  const phones = (customer.data?.identities ?? []).filter((i) => i.type === 'phone');
  const proven = phones.find((i) => i.verified);
  const shown = proven?.value ?? phones[0]?.value ?? phone;
  if (!shown) return null;
  const number = shown.startsWith('+') ? shown : `+${shown}`;
  return (
    <div data-phone-verified={proven ? 'yes' : 'no'}>
      <dt>Phone</dt>
      <dd>
        {number}{' '}
        {customer.data && (
          <StatusLight
            state={proven ? 'ok' : 'off'}
            label={proven ? 'Number verified' : 'Not verified'}
          />
        )}
      </dd>
    </div>
  );
}
