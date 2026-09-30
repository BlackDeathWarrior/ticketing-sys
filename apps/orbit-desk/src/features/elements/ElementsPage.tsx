import { useState, type ReactNode } from 'react';
import type { Priority, TicketStatus } from '../../data/types';
import {
  AuroraDivider,
  Avatar,
  AvatarGroup,
  Badge,
  Button,
  Card,
  CardHeader,
  GradientText,
  Icon,
  iconNames,
  Input,
  Kbd,
  Meter,
  PriorityGlyph,
  SearchField,
  Select,
  SlaIndicator,
  Sparkline,
  StatusPill,
  Tabs,
  Textarea,
} from '../../components/ui';
import styles from './ElementsPage.module.css';

const colors = [
  { name: 'Void Canvas', value: '#030014', role: 'Page background' },
  { name: 'Midnight Surface', value: '#060317', role: 'Cards, nav, panels' },
  { name: 'Deep Indigo', value: '#10093a', role: 'Raised controls, active' },
  { name: 'Lilac White', value: '#f4f0ff', role: 'Primary text' },
  { name: 'Ash', value: '#a8a6b7', role: 'Secondary text' },
  { name: 'Fog', value: '#918ea0', role: 'Metadata, helpers' },
  { name: 'Dusk', value: '#72707b', role: 'Quiet labels' },
  { name: 'Steel', value: '#54525f', role: 'Disabled, off-state' },
  { name: 'Lavender Accent', value: '#9382ff', role: 'Links, focus, attention' },
  { name: 'Iris', value: '#5046e4', role: 'Single primary action' },
];

const typeScale = [
  { token: 'display', size: 72, family: 'display', sample: 'Think clearly' },
  { token: 'heading-lg', size: 56, family: 'display', sample: 'Think clearly' },
  { token: 'heading', size: 48, family: 'display', sample: 'Good morning, Maya.' },
  { token: 'heading-sm', size: 32, family: 'display', sample: '3 tickets need you first.' },
  { token: 'subheading', size: 24, family: 'display', sample: 'SSO login loops back to sign-in' },
  { token: 'body-lg', size: 18, family: 'body', sample: 'Here is the state of the support sky.' },
  { token: 'body', size: 16, family: 'body', sample: 'Customers see replies within the hour.' },
  { token: 'body-sm', size: 14, family: 'body', sample: 'Hana Ito · Northwind · Enterprise' },
  { token: 'caption', size: 12, family: 'body', sample: 'Updated 4m ago' },
];

const statuses: TicketStatus[] = ['open', 'in_progress', 'waiting', 'resolved'];
const priorities: Priority[] = ['urgent', 'high', 'medium', 'low'];

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.section} aria-labelledby={id}>
      <div className={styles.sectionHead}>
        <h2 id={id} className={styles.sectionTitle}>
          {title}
        </h2>
        <p className={styles.sectionText}>{description}</p>
      </div>
      {children}
    </section>
  );
}

export function ElementsPage() {
  const [tab, setTab] = useState<'day' | 'week' | 'month'>('week');

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <Badge tone="ai" icon="sparkle">
          Design system
        </Badge>
        <h1 className={styles.heading}>
          The <GradientText>constellation</GradientText> kit
        </h1>
        <p className={styles.lede}>
          Every element Orbit Desk is built from — tokens, controls and ticket signals — drawn from
          one starlit violet palette. Medium weight, inset glows, a single lavender voice.
        </p>
      </header>

      <AuroraDivider />

      <Section
        id="el-colors"
        title="Color"
        description="A monochrome violet night with one chromatic signal. No semantic reds, greens or yellows."
      >
        <div className={styles.swatches}>
          {colors.map((c) => (
            <div key={c.name} className={styles.swatch}>
              <span className={styles.chip} style={{ background: c.value }} />
              <span className={styles.swatchName}>{c.name}</span>
              <code className={styles.code}>{c.value}</code>
              <span className={styles.swatchRole}>{c.role}</span>
            </div>
          ))}
          <div className={styles.swatch}>
            <span className={styles.gradientStroke} />
            <span className={styles.swatchName}>Cosmic gradient</span>
            <code className={styles.code}>#e59cff → #9cb2ff</code>
            <span className={styles.swatchRole}>Accent text & strokes only</span>
          </div>
          <div className={styles.swatch}>
            <span className={styles.auroraChip}>
              <AuroraDivider vertical />
            </span>
            <span className={styles.swatchName}>Aurora</span>
            <code className={styles.code}>#b7a4fb → #8562ff</code>
            <span className={styles.swatchRole}>Dividers, edge highlights</span>
          </div>
        </div>
      </Section>

      <Section
        id="el-type"
        title="Typography"
        description="Headings in a medium-weight display face (AeonikPro → DM Sans); UI and body in Inter. Weights 400 and 500 only."
      >
        <Card padding="none" className={styles.typeCard}>
          {typeScale.map((t) => (
            <div key={t.token} className={styles.typeRow}>
              <span className={styles.typeMeta}>
                {t.token}
                <span>{t.size}px</span>
              </span>
              <span
                className={t.family === 'display' ? styles.display : styles.body}
                style={{ fontSize: `var(--text-${t.token})` }}
              >
                {t.sample}
              </span>
            </div>
          ))}
        </Card>
      </Section>

      <Section
        id="el-buttons"
        title="Buttons"
        description="5px radius. Iris is reserved for one primary action per view; Deep Indigo is the everyday control."
      >
        <Card className={styles.stack}>
          <div className={styles.row}>
            <Button variant="primary" icon="plus">
              New ticket
            </Button>
            <Button variant="secondary">Assign to me</Button>
            <Button variant="ghost">Cancel</Button>
            <Button variant="link">Learn more</Button>
          </div>
          <div className={styles.row}>
            <Button variant="primary" size="sm" icon="plus">
              New ticket
            </Button>
            <Button variant="secondary" size="sm" icon="filter">
              Filter
            </Button>
            <Button variant="ghost" size="sm" icon="more" iconOnly>
              More actions
            </Button>
            <Button variant="secondary" icon="settings" iconOnly>
              Settings
            </Button>
          </div>
          <div className={styles.row}>
            <Button variant="primary" disabled>
              Disabled
            </Button>
            <Button variant="secondary" disabled>
              Disabled
            </Button>
            <Button variant="ghost" disabled>
              Disabled
            </Button>
          </div>
        </Card>
      </Section>

      <Section
        id="el-signals"
        title="Ticket signals"
        description="State is carried by glyph shape, label and opacity. Lavender marks only what needs a human now."
      >
        <div className={styles.grid3}>
          <Card>
            <CardHeader title="Status" />
            <div className={styles.column}>
              {statuses.map((s) => (
                <StatusPill key={s} status={s} />
              ))}
            </div>
          </Card>
          <Card>
            <CardHeader title="Priority" />
            <div className={styles.column}>
              {priorities.map((p) => (
                <PriorityGlyph key={p} priority={p} showLabel />
              ))}
            </div>
          </Card>
          <Card>
            <CardHeader title="SLA" />
            <div className={styles.column}>
              <SlaIndicator minutes={-6} />
              <SlaIndicator minutes={18} />
              <SlaIndicator minutes={380} />
              <SlaIndicator minutes={null} />
            </div>
          </Card>
        </div>
      </Section>

      <Section
        id="el-badges"
        title="Badges & tags"
        description="32px pills. The AI badge carries an iris rim and an inner violet glow."
      >
        <Card className={styles.row}>
          <Badge tone="ai" icon="sparkle">
            Triage assistant
          </Badge>
          <Badge tone="ai">Wall of love</Badge>
          <Badge>#sso</Badge>
          <Badge>#billing</Badge>
          <Badge>Enterprise</Badge>
        </Card>
      </Section>

      <Section
        id="el-inputs"
        title="Inputs"
        description="5px radius, hairline rim, lavender focus ring."
      >
        <Card className={styles.grid2}>
          <Input
            id="el-subject"
            label="Subject"
            placeholder="What does the customer need?"
            hint="Keep it short — it becomes the ticket title."
          />
          <div className={styles.group}>
            <span className={styles.groupLabel}>Search</span>
            <SearchField aria-label="Search example" placeholder="Search tickets…" shortcut="/" />
          </div>
          <Select
            id="el-priority"
            label="Priority"
            defaultValue="high"
            options={priorities.map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) }))}
          />
          <Input id="el-disabled" label="Disabled" placeholder="Not editable" disabled />
          <div className={styles.span2}>
            <Textarea id="el-reply" label="Reply" placeholder="Reply to Hana…" rows={3} />
          </div>
        </Card>
      </Section>

      <Section
        id="el-controls"
        title="Controls & identity"
        description="Segmented tabs, avatars in quiet indigo steps, keyboard hints and capacity meters."
      >
        <div className={styles.grid2}>
          <Card className={styles.stack}>
            <Tabs
              label="Range"
              value={tab}
              onChange={setTab}
              items={[
                { value: 'day', label: 'Today' },
                { value: 'week', label: 'This week', count: 142 },
                { value: 'month', label: 'This month' },
              ]}
            />
            <div className={styles.row}>
              <Kbd>/</Kbd>
              <span className={styles.caption}>Search</span>
              <Kbd>⌘</Kbd>
              <Kbd>Enter</Kbd>
              <span className={styles.caption}>Send</span>
              <Kbd>Esc</Kbd>
              <span className={styles.caption}>Close</span>
            </div>
            <div className={styles.meters}>
              <Meter value={6} max={12} label="Example: half capacity" />
              <Meter value={13} max={14} label="Example: near capacity" />
            </div>
          </Card>
          <Card className={styles.stack}>
            <div className={styles.row}>
              <Avatar initials="ML" name="Maya Lindqvist" size={40} highlight />
              <Avatar initials="JR" name="Jonah Reyes" size={32} />
              <Avatar initials="AT" name="Aiko Tanaka" size={28} />
              <Avatar initials="PN" name="Priya Natarajan" size={24} />
            </div>
            <AvatarGroup
              people={[
                { initials: 'ML', name: 'Maya Lindqvist' },
                { initials: 'JR', name: 'Jonah Reyes' },
                { initials: 'AT', name: 'Aiko Tanaka' },
                { initials: 'SO', name: 'Sam Okafor' },
                { initials: 'PN', name: 'Priya Natarajan' },
                { initials: 'LM', name: 'Leo Martin' },
              ]}
              size={32}
            />
          </Card>
        </div>
      </Section>

      <Section
        id="el-cards"
        title="Cards & surfaces"
        description="16px radius. Elevation is an inset rim-light, never a drop shadow."
      >
        <div className={styles.grid3}>
          <Card>
            <p className={styles.caption}>Default · Midnight + shadow-lg</p>
            <p className={styles.statValue}>94.2%</p>
            <div className={styles.rowBetween}>
              <span className={styles.caption}>SLA met</span>
              <Sparkline
                data={[90, 91.4, 91, 92.2, 92.8, 92.5, 93.1, 93.6, 93.9, 94.2]}
                width={96}
                height={32}
                label="SLA trend"
              />
            </div>
          </Card>
          <Card tone="raised">
            <div className={styles.quoteHead}>
              <Avatar initials="HI" size={40} />
              <div>
                <p className={styles.quoteName}>Hana Ito</p>
                <p className={styles.caption}>@hana · Northwind</p>
              </div>
            </div>
            <p className={styles.quote}>
              Fixed within 20 minutes of reporting. <span className={styles.mention}>@Priya</span>{' '}
              kept us posted the whole way — this is how support should feel.
            </p>
          </Card>
          <Card tone="flat" className={styles.flatCard}>
            <Icon name="target" size={24} className={styles.featureIcon} />
            <p className={styles.featureTitle}>Flat feature block</p>
            <p className={styles.featureText}>
              No surface at all — content floats directly on the canvas, as in the feature grid.
            </p>
            <Button variant="link">Learn more</Button>
          </Card>
        </div>
      </Section>

      <Section
        id="el-icons"
        title="Iconography"
        description="Outlined, 1.5px stroke, 24px grid, no fills."
      >
        <Card className={styles.icons}>
          {iconNames.map((name) => (
            <span key={name} className={styles.iconCell} title={name}>
              <Icon name={name} size={20} />
              <span>{name}</span>
            </span>
          ))}
        </Card>
      </Section>
    </div>
  );
}
