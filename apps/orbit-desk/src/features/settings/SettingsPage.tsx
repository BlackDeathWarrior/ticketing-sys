import { useEffect, useState } from 'react';
import { Tabs } from '../../components/ui';
import { useSession } from '../../lib/session';
import { AiPanel } from './AiPanel';
import { ChannelsPanel } from './ChannelsPanel';
import { type SettingsTab, visibleTabs } from './logic';
import { ModelsPanel } from './ModelsPanel';
import { ToolsPanel } from '../tools/ToolsPanel';
import { ProvidersPanel } from './ProvidersPanel';
import { RoutingPanel } from './RoutingPanel';
import { SlaSettingsPanel } from './SlaSettingsPanel';
import styles from './Settings.module.css';
import { UsagePanel } from './UsagePanel';

function tabFromHash(): string | undefined {
  return window.location.hash.replace(/^#\/?/, '').split('/')[1];
}

/** Settings (#/settings/<tab>): AI, channels, tools, routing and SLA. Tabs are limited to what the user may manage. */
export function SettingsPage() {
  const { can } = useSession();
  const tabs = visibleTabs(can);
  const pick = (value: string | undefined): SettingsTab =>
    (tabs.find((t) => t.value === value)?.value ?? tabs[0]?.value ?? 'providers') as SettingsTab;
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
        <h1 className={styles.heading}>Workspace settings</h1>
        <p className={styles.lede}>
          The AI agent and its models, channel and tool credentials, routing and SLA. Keys are
          write-only: after saving, only their last four characters are shown.
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
        {tab === 'providers' && <ProvidersPanel />}
        {tab === 'models' && <ModelsPanel />}
        {tab === 'ai' && <AiPanel />}
        {tab === 'channels' && <ChannelsPanel />}
        {tab === 'tools' && <ToolsPanel />}
        {tab === 'routing' && <RoutingPanel />}
        {tab === 'sla' && <SlaSettingsPanel />}
        {tab === 'usage' && <UsagePanel />}
      </div>
    </div>
  );
}
