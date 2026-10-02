import { useEffect, useState } from 'react';
import { Tabs } from '../../components/ui';
import { useSession } from '../../lib/session';
import { CustomersPanel } from '../admin/CustomersPanel';
import { IntegrationsPanel } from '../integrations/IntegrationsPanel';
import { PeoplePanel } from '../admin/PeoplePanel';
import { SystemPanel } from '../admin/SystemPanel';
import { TicketSetupPanel } from '../admin/TicketSetupPanel';
import { AiPanel } from './AiPanel';
import { ChannelsPanel } from './ChannelsPanel';
import { type SettingsTab, visibleTabs } from './logic';
import { ModelsPanel } from './ModelsPanel';
import { MySettingsPanel } from './MySettingsPanel';
import { ToolsPanel } from '../tools/ToolsPanel';
import { ProvidersPanel } from './ProvidersPanel';
import { RoutingPanel } from './RoutingPanel';
import { SlaSettingsPanel } from './SlaSettingsPanel';
import styles from './Settings.module.css';
import { UsagePanel } from './UsagePanel';

function tabFromHash(): string | undefined {
  return window.location.hash.replace(/^#\/?/, '').split('/')[1];
}

/** Settings (#/settings/<tab>): AI, channels, customers, tools, integrations, routing, SLA, ticket setup and people. Tabs are limited to what the user may manage. */
export function SettingsPage() {
  const { can } = useSession();
  const tabs = visibleTabs(can);
  const pick = (value: string | undefined): SettingsTab =>
    // Without a tab in the address: the first workspace tab the person manages, else their own.
    (tabs.find((t) => t.value === value)?.value ??
      tabs.find((t) => t.value !== 'me')?.value ??
      'me') as SettingsTab;
  const [tab, setTab] = useState<SettingsTab>(() => pick(tabFromHash()));

  useEffect(() => {
    const onHash = () => setTab(pick(tabFromHash()));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (!tabs.length) {
    return (
      <div className={styles.page}>
        <header className={styles.hero}>
          <h1 className={styles.heading}>Settings</h1>
          <p className={styles.lede}>You don't have access to any settings.</p>
        </header>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>Settings</p>
        <h1 className={styles.heading}>{tabs.length > 1 ? 'Workspace settings' : 'My settings'}</h1>
        <p className={styles.lede}>
          {tabs.length > 1
            ? 'The AI agent and its models, channels, tools and integrations, routing and SLA, ticket setup and people, and your own settings. Keys are write-only: after saving, only their last four characters are shown.'
            : 'How Orbit Desk behaves for you. These follow you to any browser you sign in on.'}
        </p>
      </header>
      <Tabs
        className={styles.tabs}
        label="Settings sections"
        items={tabs.map(({ value, label }) => ({ value, label }))}
        value={tab}
        onChange={(next) => {
          setTab(next);
          window.history.replaceState(null, '', `#/settings/${next}`);
        }}
      />
      <div role="tabpanel" aria-label={tabs.find((t) => t.value === tab)?.label}>
        {tab === 'me' && <MySettingsPanel />}
        {tab === 'providers' && <ProvidersPanel />}
        {tab === 'models' && <ModelsPanel />}
        {tab === 'ai' && <AiPanel />}
        {tab === 'channels' && <ChannelsPanel />}
        {tab === 'tools' && <ToolsPanel />}
        {tab === 'integrations' && <IntegrationsPanel />}
        {tab === 'routing' && <RoutingPanel />}
        {tab === 'sla' && <SlaSettingsPanel />}
        {tab === 'customers' && <CustomersPanel />}
        {tab === 'tickets' && <TicketSetupPanel />}
        {tab === 'people' && <PeoplePanel />}
        {tab === 'usage' && <UsagePanel />}
        {tab === 'system' && <SystemPanel />}
      </div>
    </div>
  );
}
