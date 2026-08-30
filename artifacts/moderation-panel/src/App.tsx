import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpRight,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Command,
  Copy,
  FileText,
  ImagePlus,
  LayoutDashboard,
  LifeBuoy,
  ListChecks,
  LockKeyhole,
  Menu,
  MoreHorizontal,
  PanelLeftClose,
  Plus,
  Radio,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  ShieldEllipsis,
  Siren,
  SlidersHorizontal,
  TerminalSquare,
  TicketCheck,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import {
  getGetDiscordGuildSummaryQueryKey,
  getGetGuildConfigQueryKey,
  getListDiscordGuildsQueryKey,
  getListGuildAuditEventsQueryKey,
  getListGuildTemplatesQueryKey,
  useExecuteModerationAction,
  useGetDiscordGuildSummary,
  useGetGuildConfig,
  useListDiscordGuilds,
  useListGuildAuditEvents,
  useListGuildTemplates,
  useRequestUploadUrl,
  useSendGuildTemplate,
  useUpdateGuildConfig,
  useUpdateGuildTemplate,
  type AuditEvent,
  type DiscordGuild,
  type EmbedField,
  type EmbedTemplate,
  type GuildConfig,
  type GuildConfigInput,
} from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch, Link, useLocation, useParams, Router as WouterRouter } from 'wouter';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient();

type Notice = { tone: 'good' | 'bad'; text: string };

const moduleMeta: Record<string, { label: string; detail: string; icon: typeof ShieldCheck }> = {
  moderation: { label: 'Moderation', detail: 'Timeouts, bans, and audit trail', icon: ShieldCheck },
  welcome: { label: 'Welcome flow', detail: 'A considered first message', icon: Radio },
  tickets: { label: 'Ticketing', detail: 'Private support channels', icon: TicketCheck },
  antiNuke: { label: 'Anti-nuke', detail: 'Guardrails during an attack', icon: Siren },
};

const templateMeta: Record<string, { title: string; detail: string }> = {
  welcome: { title: 'Welcome', detail: 'First contact for new members' },
  rules: { title: 'Rules', detail: 'The shared agreement' },
  announcement: { title: 'Announcement', detail: 'High-signal server news' },
  ticket: { title: 'Ticket', detail: 'A focused support handoff' },
  antinuke: { title: 'Anti-nuke', detail: 'Recovery message for a locked room' },
};

function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

function formatNumber(value?: number) {
  return new Intl.NumberFormat('en-US').format(value ?? 0);
}

function formatTime(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function GuildMark({ guild, size = 'md' }: { guild: DiscordGuild; size?: 'sm' | 'md' | 'lg' }) {
  return guild.icon ? (
    <img
      src={guild.icon}
      alt=""
      data-testid={`img-guild-${guild.id}`}
      className={cn('rounded-[7px] object-cover ring-1 ring-black/10', size === 'sm' ? 'h-7 w-7' : size === 'lg' ? 'h-12 w-12' : 'h-9 w-9')}
    />
  ) : (
    <div
      data-testid={`avatar-guild-${guild.id}`}
      className={cn('flex shrink-0 items-center justify-center rounded-[7px] bg-[hsl(var(--primary))] font-mono font-medium text-[hsl(var(--primary-foreground))]', size === 'sm' ? 'h-7 w-7 text-[9px]' : size === 'lg' ? 'h-12 w-12 text-sm' : 'h-9 w-9 text-[11px]')}
    >
      {initials(guild.name)}
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-5" data-testid="loading-skeleton">
      <div className="skeleton h-8 w-52 rounded-md" />
      <div className="skeleton h-4 w-72 rounded-md" />
      <div className="grid gap-4 md:grid-cols-3">
        {[1, 2, 3].map((item) => <div key={item} className="skeleton h-32 rounded-xl" />)}
      </div>
      <div className="skeleton h-72 rounded-xl" />
    </div>
  );
}

function QueryError({ onRetry, label = 'Unable to load this view.' }: { onRetry: () => void; label?: string }) {
  return (
    <div className="flex min-h-[260px] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/60 p-8 text-center" data-testid="status-query-error">
      <CircleAlert className="mb-3 h-5 w-5 text-muted-foreground" />
      <p className="text-sm font-semibold">{label}</p>
      <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">The Discord connection did not return a response. Nothing was changed.</p>
      <button type="button" onClick={onRetry} data-testid="button-retry-query" className="mt-5 inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs font-semibold transition hover:bg-accent">
        <RefreshCw className="h-3.5 w-3.5" /> Retry connection
      </button>
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex min-h-[210px] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50 p-8 text-center" data-testid="status-empty">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-muted"><LockKeyhole className="h-4 w-4 text-muted-foreground" /></div>
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">{detail}</p>
    </div>
  );
}

function AppShell({ children, guilds, guildsLoading }: { children: ReactNode; guilds: DiscordGuild[]; guildsLoading: boolean }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const selectedGuildId = location.match(/^\/servers\/([^/]+)/)?.[1];
  const selectedGuild = guilds.find((guild) => guild.id === selectedGuildId);

  return (
    <div className="panel-noise min-h-[100dvh] bg-background text-foreground">
      <aside className={cn('fixed inset-y-0 left-0 z-50 flex w-[252px] flex-col border-r border-sidebar-border bg-sidebar transition-transform duration-300 md:translate-x-0', mobileOpen ? 'translate-x-0' : '-translate-x-full')} data-testid="sidebar-navigation">
        <div className="flex h-[76px] items-center justify-between border-b border-sidebar-border px-5">
          <Link href="/" data-testid="link-brand" className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-sidebar-primary text-sidebar-primary-foreground"><Command className="h-4 w-4" /></div>
            <div>
              <div className="text-[13px] font-extrabold tracking-tight text-sidebar-foreground">SENTINEL<span className="text-sidebar-foreground/50">/</span>CTRL</div>
              <div className="mono-label mt-0.5 text-sidebar-foreground/45">moderation console</div>
            </div>
          </Link>
          <button type="button" onClick={() => setMobileOpen(false)} data-testid="button-close-sidebar" className="rounded-md p-1.5 text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground md:hidden"><PanelLeftClose className="h-4 w-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-5">
          <div className="mb-3 px-2 mono-label text-sidebar-foreground/40">Workspace</div>
          <nav className="space-y-1">
            <Link href="/" onClick={() => setMobileOpen(false)} data-testid="link-overview" className={cn('flex items-center gap-3 rounded-md px-3 py-2.5 text-[12px] font-semibold transition', location === '/' ? 'bg-sidebar-primary text-sidebar-primary-foreground' : 'text-sidebar-foreground/65 hover:bg-sidebar-accent hover:text-sidebar-foreground')}>
              <LayoutDashboard className="h-4 w-4" /> Overview
            </Link>
          </nav>

          <div className="mb-3 mt-8 flex items-center justify-between px-2">
            <span className="mono-label text-sidebar-foreground/40">Connected servers</span>
            <span data-testid="text-server-count" className="font-mono text-[10px] text-sidebar-foreground/35">{guilds.length.toString().padStart(2, '0')}</span>
          </div>
          <div className="space-y-1">
            {guildsLoading && [1, 2, 3].map((item) => <div key={item} className="skeleton mx-2 h-9 rounded-md opacity-20" />)}
            {!guildsLoading && guilds.map((guild) => (
              <div key={guild.id} className="group">
                <Link href={`/servers/${guild.id}`} onClick={() => setMobileOpen(false)} data-testid={`link-server-${guild.id}`} className={cn('flex items-center gap-2.5 rounded-md px-2.5 py-2 transition', selectedGuildId === guild.id ? 'bg-sidebar-accent text-sidebar-foreground' : 'text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground')}>
                  <GuildMark guild={guild} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{guild.name}</span>
                  {selectedGuildId === guild.id && <ChevronRight className="h-3.5 w-3.5 text-sidebar-foreground/50" />}
                </Link>
                {selectedGuildId === guild.id && (
                  <div className="ml-[39px] mt-1 space-y-0.5 border-l border-sidebar-border pl-3">
                    <Link href={`/servers/${guild.id}`} data-testid={`link-server-command-${guild.id}`} className={cn('block rounded px-2 py-1.5 text-[11px]', location === `/servers/${guild.id}` ? 'bg-sidebar-primary/10 font-bold text-sidebar-foreground' : 'text-sidebar-foreground/45 hover:text-sidebar-foreground')}>Command center</Link>
                    <Link href={`/servers/${guild.id}/embeds`} data-testid={`link-server-embeds-${guild.id}`} className={cn('block rounded px-2 py-1.5 text-[11px]', location.endsWith('/embeds') ? 'bg-sidebar-primary/10 font-bold text-sidebar-foreground' : 'text-sidebar-foreground/45 hover:text-sidebar-foreground')}>Embed library</Link>
                    <Link href={`/servers/${guild.id}/settings`} data-testid={`link-server-settings-${guild.id}`} className={cn('block rounded px-2 py-1.5 text-[11px]', location.endsWith('/settings') ? 'bg-sidebar-primary/10 font-bold text-sidebar-foreground' : 'text-sidebar-foreground/45 hover:text-sidebar-foreground')}>Server settings</Link>
                  </div>
                )}
              </div>
            ))}
          </div>

          {!guildsLoading && guilds.length === 0 && <div className="px-2 text-[11px] leading-5 text-sidebar-foreground/40">No connected servers found.</div>}
        </div>
        <div className="border-t border-sidebar-border p-4">
          <div className="flex items-center gap-3 rounded-md bg-sidebar-accent/50 p-3">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-sidebar-primary text-[10px] font-bold text-sidebar-primary-foreground">OP</div>
            <div className="min-w-0 flex-1"><p data-testid="text-operator-name" className="truncate text-[11px] font-bold text-sidebar-foreground">Operator</p><p className="mono-label mt-0.5 text-sidebar-foreground/40">owner access</p></div>
            <button type="button" data-testid="button-operator-menu" className="text-sidebar-foreground/35 hover:text-sidebar-foreground"><MoreHorizontal className="h-4 w-4" /></button>
          </div>
        </div>
      </aside>
      {mobileOpen && <button type="button" aria-label="Close navigation" onClick={() => setMobileOpen(false)} data-testid="button-mobile-backdrop" className="fixed inset-0 z-40 bg-foreground/30 md:hidden" />}
      <main className="min-h-[100dvh] md:pl-[252px]">
        <header className="sticky top-0 z-30 flex h-[76px] items-center justify-between border-b border-border/80 bg-background/90 px-5 backdrop-blur-xl md:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <button type="button" onClick={() => setMobileOpen(true)} data-testid="button-open-sidebar" className="rounded-md p-2 hover:bg-accent md:hidden"><Menu className="h-4 w-4" /></button>
            {selectedGuild ? <><GuildMark guild={selectedGuild} size="sm" /><div className="min-w-0"><p className="truncate text-[12px] font-extrabold">{selectedGuild.name}</p><p className="mono-label mt-0.5 text-muted-foreground">server workspace</p></div></> : <div><p className="text-[12px] font-extrabold">All servers</p><p className="mono-label mt-0.5 text-muted-foreground">workspace overview</p></div>}
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-muted-foreground sm:flex"><Search className="h-3.5 w-3.5" /><span className="text-[11px]">Search commands</span><kbd className="ml-3 rounded border border-border px-1.5 py-0.5 font-mono text-[9px]">⌘ K</kbd></div>
            <button type="button" data-testid="button-notifications" className="relative rounded-md border border-border bg-card p-2 text-muted-foreground transition hover:bg-accent hover:text-foreground"><Bell className="h-4 w-4" /><span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-foreground" /></button>
          </div>
        </header>
        <div className="mx-auto max-w-[1440px] px-5 py-7 md:px-8 md:py-9">{children}</div>
      </main>
    </div>
  );
}

function SectionHeading({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail: string; action?: ReactNode }) {
  return <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
    <div><p className="mono-label mb-2 text-muted-foreground">{eyebrow}</p><h1 className="display-heading text-[31px] font-extrabold leading-none">{title}</h1><p className="mt-2 max-w-2xl text-[13px] leading-5 text-muted-foreground">{detail}</p></div>
    {action && <div className="shrink-0">{action}</div>}
  </div>;
}

function StatusPill({ children, quiet = false }: { children: ReactNode; quiet?: boolean }) {
  return <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-bold', quiet ? 'border-border bg-muted text-muted-foreground' : 'border-foreground/15 bg-foreground/[0.06] text-foreground')}><span className={cn('h-1.5 w-1.5 rounded-full', quiet ? 'bg-muted-foreground/50' : 'bg-foreground')} />{children}</span>;
}

function ActivityList({ events, empty = 'No recent activity recorded.' }: { events?: AuditEvent[]; empty?: string }) {
  if (!events?.length) return <EmptyState title="A quiet log" detail={empty} />;
  return <div className="divide-y divide-border" data-testid="list-audit-events">{events.slice(0, 8).map((event) => (
    <div key={event.id} className="flex items-start gap-3 py-3.5" data-testid={`row-audit-${event.id}`}>
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted"><TerminalSquare className="h-3.5 w-3.5 text-muted-foreground" /></div>
      <div className="min-w-0 flex-1"><p className="text-[12px] font-semibold">{event.action}</p><p className="mt-1 truncate text-[11px] text-muted-foreground">{event.subject}{event.actor ? ` · by ${event.actor}` : ''}</p></div>
      <time className="shrink-0 font-mono text-[9px] text-muted-foreground">{formatTime(event.createdAt)}</time>
    </div>
  ))}</div>;
}

function OverviewPage({ guilds, guildsLoading }: { guilds: DiscordGuild[]; guildsLoading: boolean }) {
  const primaryGuildId = guilds[0]?.id ?? '';
  const summaryQuery = useGetDiscordGuildSummary(primaryGuildId, { query: { enabled: Boolean(primaryGuildId), queryKey: getGetDiscordGuildSummaryQueryKey(primaryGuildId) } });
  const summary = summaryQuery.data;
  const recent = useMemo(() => guilds.flatMap(() => summary?.recentActions ?? []).slice(0, 6), [guilds, summary]);

  if (guildsLoading) return <PageSkeleton />;
  return <div className="reveal">
    <SectionHeading eyebrow="Command center / 01" title="Keep the room quiet." detail="A single view of your connected communities, active guardrails, and the last things Sentinel changed." action={<StatusPill>All systems nominal</StatusPill>} />
    <div className="mb-8 grid gap-3 sm:grid-cols-3">
      <div className="rounded-xl border border-border bg-card p-5"><p className="mono-label text-muted-foreground">Connected servers</p><p data-testid="text-overview-server-count" className="mt-3 text-3xl font-extrabold tracking-tight">{guilds.length.toString().padStart(2, '0')}</p><p className="mt-1 text-[11px] text-muted-foreground">Discord workspaces in scope</p></div>
      <div className="rounded-xl border border-border bg-card p-5"><p className="mono-label text-muted-foreground">Members in view</p><p data-testid="text-overview-member-count" className="mt-3 text-3xl font-extrabold tracking-tight">{formatNumber(guilds.reduce((total, guild) => total + guild.memberCount, 0))}</p><p className="mt-1 text-[11px] text-muted-foreground">Across connected servers</p></div>
      <div className="rounded-xl border border-border bg-primary p-5 text-primary-foreground"><p className="mono-label text-primary-foreground/60">Protection posture</p><p data-testid="status-protection-posture" className="mt-3 text-3xl font-extrabold tracking-tight">Ready</p><p className="mt-1 text-[11px] text-primary-foreground/60">Actions require your confirmation</p></div>
    </div>
    <div className="grid gap-5 xl:grid-cols-[1.35fr_.9fr]">
      <section className="rounded-xl border border-border bg-card" data-testid="section-connected-servers">
        <div className="flex items-center justify-between border-b border-border px-5 py-4"><div><p className="mono-label text-muted-foreground">Your network</p><h2 className="mt-1 text-sm font-extrabold">Connected servers</h2></div><span className="font-mono text-[10px] text-muted-foreground">LIVE</span></div>
        <div className="divide-y divide-border">
          {guilds.length ? guilds.map((guild, index) => <Link href={`/servers/${guild.id}`} key={guild.id} data-testid={`card-server-${guild.id}`} className="group flex items-center gap-3 px-5 py-4 transition hover:bg-accent/50">
            <GuildMark guild={guild} size="md" /><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="truncate text-[13px] font-bold">{guild.name}</p>{index === 0 && <StatusPill quiet>Primary</StatusPill>}</div><p className="mt-1 text-[11px] text-muted-foreground">{formatNumber(guild.memberCount)} members · Discord server</p></div><ArrowUpRight className="h-4 w-4 text-muted-foreground/40 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-foreground" />
          </Link>) : <div className="p-5"><EmptyState title="No servers in scope" detail="Connect Sentinel to a Discord server to begin configuring protection." /></div>}
        </div>
      </section>
      <section className="rounded-xl border border-border bg-card" data-testid="section-active-modules">
        <div className="border-b border-border px-5 py-4"><p className="mono-label text-muted-foreground">Protection layer</p><h2 className="mt-1 text-sm font-extrabold">Active safety modules</h2></div>
        <div className="p-5">{summaryQuery.isLoading ? <div className="space-y-3">{[1, 2, 3, 4].map((item) => <div key={item} className="skeleton h-11 rounded-md" />)}</div> : summaryQuery.isError ? <QueryError onRetry={() => summaryQuery.refetch()} /> : <div className="space-y-1.5">{(summary?.enabledModules ?? ['moderation', 'welcome', 'tickets', 'antiNuke']).map((module) => { const meta = moduleMeta[module] ?? { label: module, detail: 'Configured protection', icon: ShieldEllipsis }; const Icon = meta.icon; return <div key={module} className="flex items-center gap-3 rounded-md bg-muted/70 px-3 py-3"><div className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card"><Icon className="h-3.5 w-3.5" /></div><div className="min-w-0 flex-1"><p data-testid={`text-module-${module}`} className="text-[11px] font-bold">{meta.label}</p><p className="text-[10px] text-muted-foreground">{meta.detail}</p></div><span className="font-mono text-[9px] text-muted-foreground">ON</span></div>; })}</div>}</div>
      </section>
    </div>
    <section className="mt-5 rounded-xl border border-border bg-card" data-testid="section-recent-actions">
      <div className="flex items-center justify-between border-b border-border px-5 py-4"><div><p className="mono-label text-muted-foreground">Trace / recent</p><h2 className="mt-1 text-sm font-extrabold">Recent actions</h2></div><Clock3 className="h-4 w-4 text-muted-foreground" /></div>
      <div className="px-5">{summaryQuery.isError ? <QueryError onRetry={() => summaryQuery.refetch()} /> : <ActivityList events={recent} empty="Actions taken by Sentinel will appear here." />}</div>
    </section>
  </div>;
}

function ConfirmDialog({ title, detail, confirmLabel, pending, onConfirm, onCancel }: { title: string; detail: string; confirmLabel: string; pending?: boolean; onConfirm: () => void; onCancel: () => void }) {
  return <div className="fixed inset-0 z-[80] flex items-center justify-center bg-foreground/35 p-5 backdrop-blur-sm" role="dialog" aria-modal="true" data-testid="dialog-confirmation">
    <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl">
      <div className="mb-5 flex items-start justify-between"><div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground"><CircleAlert className="h-4 w-4" /></div><button type="button" onClick={onCancel} data-testid="button-close-confirmation" className="rounded-md p-1 text-muted-foreground hover:bg-accent"><X className="h-4 w-4" /></button></div>
      <h2 className="text-lg font-extrabold tracking-tight">{title}</h2><p className="mt-2 text-[12px] leading-5 text-muted-foreground">{detail}</p>
      <div className="mt-6 flex justify-end gap-2"><button type="button" onClick={onCancel} data-testid="button-cancel-confirmation" className="rounded-md border border-border px-3 py-2 text-xs font-bold hover:bg-accent">Cancel</button><button type="button" onClick={onConfirm} disabled={pending} data-testid="button-confirm-action" className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-xs font-bold text-primary-foreground disabled:opacity-50">{pending && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}{confirmLabel}</button></div>
    </div>
  </div>;
}

function ServerPage() {
  const { guildId = '' } = useParams<{ guildId: string }>();
  const summaryQuery = useGetDiscordGuildSummary(guildId, { query: { queryKey: getGetDiscordGuildSummaryQueryKey(guildId) } });
  const auditQuery = useListGuildAuditEvents(guildId, { query: { queryKey: getListGuildAuditEventsQueryKey(guildId) } });
  const moderationAction = useExecuteModerationAction();
  const [action, setAction] = useState<'ban' | 'kick' | 'timeout' | 'untimeout' | 'mute' | 'unmute'>('timeout');
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState('60');
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const summary = summaryQuery.data;

  const submitAction = () => {
    if (!userId.trim()) { setNotice({ tone: 'bad', text: 'A Discord user ID is required.' }); return; }
    setConfirming(true);
  };
  const executeAction = () => {
    moderationAction.mutate({ guildId, data: { action, userId: userId.trim(), reason: reason.trim() || undefined, durationMinutes: ['timeout', 'mute'].includes(action) ? Number(duration) || 60 : null } }, {
      onSuccess: (result) => { setConfirming(false); setNotice({ tone: result.success ? 'good' : 'bad', text: result.message || (result.success ? 'Action completed.' : 'Action was not completed.') }); setUserId(''); setReason(''); auditQuery.refetch(); },
      onError: () => { setConfirming(false); setNotice({ tone: 'bad', text: 'Discord rejected the action. Check permissions and try again.' }); },
    });
  };
  if (summaryQuery.isLoading) return <PageSkeleton />;
  if (summaryQuery.isError || !summary) return <QueryError onRetry={() => summaryQuery.refetch()} label="Unable to load server command center." />;
  return <div className="reveal">
    <SectionHeading eyebrow="Server workspace / 02" title={summary.guild.name} detail={`${formatNumber(summary.guild.memberCount)} members · ${summary.channelCount} channels · ${summary.roleCount} roles`} action={<Link href={`/servers/${guildId}/settings`} data-testid="link-open-server-settings" className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs font-bold transition hover:bg-accent"><Settings2 className="h-3.5 w-3.5" /> Configure server</Link>} />
    {notice && <div className={cn('mb-5 flex items-center justify-between rounded-md border px-3 py-3 text-xs font-semibold', notice.tone === 'good' ? 'border-foreground/20 bg-foreground/[0.04]' : 'border-foreground/35 bg-foreground/[0.08]')} data-testid="status-moderation-notice"><span className="flex items-center gap-2">{notice.tone === 'good' ? <Check className="h-3.5 w-3.5" /> : <CircleAlert className="h-3.5 w-3.5" />}{notice.text}</span><button type="button" onClick={() => setNotice(null)} data-testid="button-dismiss-notice"><X className="h-3.5 w-3.5" /></button></div>}
    <div className="grid gap-5 xl:grid-cols-[1.25fr_.75fr]">
      <section className="rounded-xl border border-border bg-card" data-testid="section-moderation-actions">
        <div className="flex items-center justify-between border-b border-border px-5 py-4"><div><p className="mono-label text-muted-foreground">Operator actions</p><h2 className="mt-1 text-sm font-extrabold">Moderate a member</h2></div><ShieldCheck className="h-4 w-4 text-muted-foreground" /></div>
        <div className="p-5">
          <div className="grid gap-4 sm:grid-cols-[.7fr_1.3fr]">
            <label className="space-y-2"><span className="text-[11px] font-bold">Action</span><select value={action} onChange={(event) => setAction(event.target.value as typeof action)} data-testid="select-moderation-action" className="h-10 w-full rounded-md border border-input bg-background px-3 text-xs font-semibold outline-none focus:border-foreground"><option value="timeout">Timeout</option><option value="mute">Mute</option><option value="kick">Kick</option><option value="ban">Ban</option><option value="untimeout">Remove timeout</option><option value="unmute">Unmute</option></select></label>
            <label className="space-y-2"><span className="text-[11px] font-bold">Discord user ID</span><input value={userId} onChange={(event) => setUserId(event.target.value)} data-testid="input-moderation-user-id" placeholder="e.g. 80351110224678912" className="h-10 w-full rounded-md border border-input bg-background px-3 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-foreground" /></label>
          </div>
          {['timeout', 'mute'].includes(action) && <label className="mt-4 block space-y-2"><span className="text-[11px] font-bold">Duration <span className="font-normal text-muted-foreground">(minutes)</span></span><input type="number" min="1" value={duration} onChange={(event) => setDuration(event.target.value)} data-testid="input-moderation-duration" className="h-10 w-full rounded-md border border-input bg-background px-3 text-xs outline-none focus:border-foreground" /></label>}
          <label className="mt-4 block space-y-2"><span className="text-[11px] font-bold">Internal reason <span className="font-normal text-muted-foreground">(optional)</span></span><textarea value={reason} onChange={(event) => setReason(event.target.value)} data-testid="textarea-moderation-reason" placeholder="Record the context for the audit trail." rows={3} className="w-full resize-none rounded-md border border-input bg-background px-3 py-2.5 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-foreground" /></label>
          <div className="mt-5 flex items-center justify-between border-t border-border pt-4"><p className="max-w-xs text-[10px] leading-4 text-muted-foreground">Sensitive actions are sent to Discord only after a second confirmation.</p><button type="button" onClick={submitAction} data-testid="button-review-moderation-action" className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 text-xs font-bold text-primary-foreground transition hover:opacity-90"><ShieldEllipsis className="h-3.5 w-3.5" /> Review action</button></div>
        </div>
      </section>
      <section className="rounded-xl border border-border bg-card" data-testid="section-server-posture">
        <div className="border-b border-border px-5 py-4"><p className="mono-label text-muted-foreground">Live posture</p><h2 className="mt-1 text-sm font-extrabold">Protection summary</h2></div>
        <div className="space-y-4 p-5"><div className="flex items-center justify-between rounded-md bg-muted p-4"><div><p className="text-[11px] font-bold">Active modules</p><p data-testid="text-active-module-count" className="mt-1 font-mono text-xl font-medium">{summary.enabledModules.length.toString().padStart(2, '0')}</p></div><ListChecks className="h-4 w-4 text-muted-foreground" /></div><div className="space-y-2">{summary.enabledModules.map((module) => <div key={module} className="flex items-center gap-2 text-[11px]"><Check className="h-3.5 w-3.5" /><span>{moduleMeta[module]?.label ?? module}</span><span className="ml-auto font-mono text-[9px] text-muted-foreground">ENABLED</span></div>)}</div><Link href={`/servers/${guildId}/embeds`} data-testid="link-open-embed-library" className="flex items-center justify-between border-t border-border pt-4 text-[11px] font-bold hover:underline"><span>Open embed library</span><ChevronRight className="h-3.5 w-3.5" /></Link></div>
      </section>
    </div>
    <section className="mt-5 rounded-xl border border-border bg-card" data-testid="section-server-audit">
      <div className="flex items-center justify-between border-b border-border px-5 py-4"><div><p className="mono-label text-muted-foreground">Trace / audit log</p><h2 className="mt-1 text-sm font-extrabold">Recent server activity</h2></div><Link href={`/servers/${guildId}/settings`} data-testid="link-audit-settings" className="text-[11px] font-bold text-muted-foreground hover:text-foreground">Manage defaults <ArrowUpRight className="ml-1 inline h-3 w-3" /></Link></div>
      <div className="px-5">{auditQuery.isLoading ? <div className="space-y-3 py-4">{[1, 2, 3].map((item) => <div key={item} className="skeleton h-10 rounded" />)}</div> : auditQuery.isError ? <QueryError onRetry={() => auditQuery.refetch()} /> : <ActivityList events={auditQuery.data} />}</div>
    </section>
    {confirming && <ConfirmDialog title={`Confirm ${action}`} detail={`This will ${action === 'untimeout' ? 'remove the timeout from' : action === 'unmute' ? 'unmute' : `${action}`} user ${userId}. The action will be recorded in the server audit trail.`} confirmLabel={`Confirm ${action}`} pending={moderationAction.isPending} onConfirm={executeAction} onCancel={() => setConfirming(false)} />}
  </div>;
}

function makeTemplateInput(template: EmbedTemplate): EmbedTemplate {
  return { ...template, fields: template.fields ?? [] };
}

function EmbedPreview({ template }: { template: EmbedTemplate }) {
  return <div className="overflow-hidden rounded-lg border border-border bg-background shadow-sm" data-testid={`preview-template-${template.key}`}>
    <div className="flex items-center gap-2 border-b border-border bg-muted/60 px-3 py-2"><div className="h-5 w-5 rounded-full bg-foreground/15" /><span className="text-[10px] font-bold"># announcements</span><span className="ml-auto font-mono text-[9px] text-muted-foreground">preview</span></div>
    <div className="p-3"><div className="border-l-[3px] border-foreground/60 bg-card px-3 py-3"><p className="text-[12px] font-extrabold">{template.name || 'Untitled embed'}</p><p className="mt-2 whitespace-pre-wrap text-[11px] leading-5 text-muted-foreground">{template.content || 'Your message content will appear here.'}</p>{template.fields?.length > 0 && <div className="mt-3 grid gap-2 border-t border-border pt-3">{template.fields.slice(0, 3).map((field, index) => <div key={`${field.name}-${index}`}><p className="text-[10px] font-bold">{field.name || 'Field'}</p><p className="mt-0.5 text-[10px] text-muted-foreground">{field.value || 'Field value'}</p></div>)}</div>}<p className="mt-3 border-t border-border pt-2 font-mono text-[9px] text-muted-foreground">{template.footer || 'Sentinel Control'}</p></div></div>
  </div>;
}

function EmbedEditor({ template, guildId, onSaved, onSent }: { template: EmbedTemplate; guildId: string; onSaved: (template: EmbedTemplate) => void; onSent: () => void }) {
  const [draft, setDraft] = useState(() => makeTemplateInput(template));
  const [sendChannel, setSendChannel] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const updateTemplate = useUpdateGuildTemplate();
  const sendTemplate = useSendGuildTemplate();
  useEffect(() => { setDraft(makeTemplateInput(template)); }, [template]);
  const setField = (key: keyof EmbedTemplate, value: string | boolean) => setDraft((current) => ({ ...current, [key]: value }));
  const updateField = (index: number, key: keyof EmbedField, value: string | boolean) => setDraft((current) => ({ ...current, fields: current.fields.map((field, itemIndex) => itemIndex === index ? { ...field, [key]: value } : field) }));
  const save = () => {
    updateTemplate.mutate({ guildId, templateKey: template.key as 'welcome' | 'rules' | 'announcement' | 'ticket' | 'antinuke', data: { name: draft.name, description: draft.description, color: draft.color, content: draft.content, fields: draft.fields, footer: draft.footer, enabled: draft.enabled } }, { onSuccess: (saved) => { onSaved(saved); setNotice({ tone: 'good', text: 'Embed saved.' }); }, onError: () => setNotice({ tone: 'bad', text: 'Embed could not be saved.' }) });
  };
  const send = () => {
    if (!sendChannel.trim()) { setNotice({ tone: 'bad', text: 'Add a channel ID before sending.' }); return; }
    sendTemplate.mutate({ guildId, templateKey: template.key as 'welcome' | 'rules' | 'announcement' | 'ticket' | 'antinuke', data: { channelId: sendChannel.trim() } }, { onSuccess: () => { setNotice({ tone: 'good', text: 'Embed sent to Discord.' }); onSent(); }, onError: () => setNotice({ tone: 'bad', text: 'Discord could not send this embed.' }) });
  };
  return <div className="grid gap-5 xl:grid-cols-[1fr_.82fr]" data-testid={`editor-template-${template.key}`}>
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-4"><div><p className="mono-label text-muted-foreground">{template.key}</p><h2 className="mt-1 text-sm font-extrabold">{templateMeta[template.key]?.title ?? template.name}</h2></div><label className="flex cursor-pointer items-center gap-2 text-[10px] font-bold"><input type="checkbox" checked={draft.enabled} onChange={(event) => setField('enabled', event.target.checked)} data-testid={`checkbox-template-enabled-${template.key}`} className="h-3.5 w-3.5 accent-[hsl(var(--foreground))]" /> Enabled</label></div>
      <div className="space-y-4 p-5">
        {notice && <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2 text-[11px] font-semibold" data-testid={`status-template-${template.key}`}><span>{notice.text}</span><button type="button" onClick={() => setNotice(null)} data-testid={`button-dismiss-template-notice-${template.key}`}><X className="h-3.5 w-3.5" /></button></div>}
        <label className="block space-y-2"><span className="text-[11px] font-bold">Name</span><input value={draft.name} onChange={(event) => setField('name', event.target.value)} data-testid={`input-template-name-${template.key}`} className="h-10 w-full rounded-md border border-input bg-background px-3 text-xs outline-none focus:border-foreground" /></label>
        <label className="block space-y-2"><span className="text-[11px] font-bold">Description</span><input value={draft.description} onChange={(event) => setField('description', event.target.value)} data-testid={`input-template-description-${template.key}`} className="h-10 w-full rounded-md border border-input bg-background px-3 text-xs outline-none focus:border-foreground" /></label>
        <label className="block space-y-2"><span className="text-[11px] font-bold">Message content</span><textarea rows={7} value={draft.content} onChange={(event) => setField('content', event.target.value)} data-testid={`textarea-template-content-${template.key}`} className="w-full resize-y rounded-md border border-input bg-background px-3 py-2.5 text-xs leading-5 outline-none focus:border-foreground" /></label>
        <div className="grid gap-4 sm:grid-cols-[1fr_1.4fr]"><label className="block space-y-2"><span className="text-[11px] font-bold">Accent</span><input value={draft.color} onChange={(event) => setField('color', event.target.value)} data-testid={`input-template-color-${template.key}`} className="h-10 w-full rounded-md border border-input bg-background px-3 text-xs outline-none focus:border-foreground" /></label><label className="block space-y-2"><span className="text-[11px] font-bold">Footer</span><input value={draft.footer} onChange={(event) => setField('footer', event.target.value)} data-testid={`input-template-footer-${template.key}`} className="h-10 w-full rounded-md border border-input bg-background px-3 text-xs outline-none focus:border-foreground" /></label></div>
        <div><div className="mb-2 flex items-center justify-between"><span className="text-[11px] font-bold">Fields</span><button type="button" onClick={() => setDraft((current) => ({ ...current, fields: [...current.fields, { name: '', value: '', inline: false }] }))} data-testid={`button-add-template-field-${template.key}`} className="inline-flex items-center gap-1 text-[10px] font-bold text-muted-foreground hover:text-foreground"><Plus className="h-3 w-3" /> Add field</button></div><div className="space-y-2">{draft.fields.map((field, index) => <div className="grid grid-cols-[1fr_1fr_auto] gap-2" key={`${template.key}-field-${index}`}><input value={field.name} onChange={(event) => updateField(index, 'name', event.target.value)} data-testid={`input-template-field-name-${template.key}-${index}`} placeholder="Name" className="h-9 min-w-0 rounded-md border border-input bg-background px-2.5 text-[11px] outline-none focus:border-foreground" /><input value={field.value} onChange={(event) => updateField(index, 'value', event.target.value)} data-testid={`input-template-field-value-${template.key}-${index}`} placeholder="Value" className="h-9 min-w-0 rounded-md border border-input bg-background px-2.5 text-[11px] outline-none focus:border-foreground" /><button type="button" onClick={() => setDraft((current) => ({ ...current, fields: current.fields.filter((_, itemIndex) => itemIndex !== index) }))} data-testid={`button-remove-template-field-${template.key}-${index}`} className="rounded-md px-2 text-muted-foreground hover:bg-accent hover:text-foreground"><Trash2 className="h-3.5 w-3.5" /></button></div>)}</div></div>
        <button type="button" onClick={save} disabled={updateTemplate.isPending} data-testid={`button-save-template-${template.key}`} className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 text-xs font-bold text-primary-foreground disabled:opacity-50"><Save className="h-3.5 w-3.5" /> {updateTemplate.isPending ? 'Saving…' : 'Save embed'}</button>
      </div>
    </div>
    <div className="space-y-5"><EmbedPreview template={draft} /><div className="rounded-xl border border-border bg-card p-5"><div className="flex items-center gap-2"><Send className="h-3.5 w-3.5" /><p className="text-[11px] font-extrabold">Send a test message</p></div><p className="mt-2 text-[10px] leading-4 text-muted-foreground">Post the current saved version into a Discord channel to verify permissions and layout.</p><input value={sendChannel} onChange={(event) => setSendChannel(event.target.value)} data-testid={`input-send-channel-${template.key}`} placeholder="Channel ID" className="mt-4 h-9 w-full rounded-md border border-input bg-background px-3 text-[11px] outline-none focus:border-foreground" /><button type="button" onClick={send} disabled={sendTemplate.isPending} data-testid={`button-send-template-${template.key}`} className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-[11px] font-bold hover:bg-accent disabled:opacity-50">{sendTemplate.isPending ? 'Sending…' : 'Send to Discord'}<ArrowUpRight className="h-3.5 w-3.5" /></button></div></div>
  </div>;
}

function EmbedsPage() {
  const { guildId = '' } = useParams<{ guildId: string }>();
  const templatesQuery = useListGuildTemplates(guildId, { query: { queryKey: getListGuildTemplatesQueryKey(guildId) } });
  const [selectedKey, setSelectedKey] = useState('welcome');
  const [templates, setTemplates] = useState<EmbedTemplate[]>([]);
  useEffect(() => { if (templatesQuery.data) setTemplates(templatesQuery.data); }, [templatesQuery.data]);
  if (templatesQuery.isLoading) return <PageSkeleton />;
  if (templatesQuery.isError) return <QueryError onRetry={() => templatesQuery.refetch()} label="Unable to load the embed library." />;
  const active = templates.find((template) => template.key === selectedKey) ?? templates[0];
  return <div className="reveal">
    <SectionHeading eyebrow="Server workspace / 03" title="Embed library" detail="Reusable messages with a consistent voice. Edit once, send when the moment calls for it." action={<Link href={`/servers/${guildId}`} data-testid="link-back-command-center" className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs font-bold hover:bg-accent"><ChevronRight className="h-3.5 w-3.5 rotate-180" /> Command center</Link>} />
    <div className="mb-5 flex gap-2 overflow-x-auto border-b border-border pb-3" data-testid="tabs-template-list">{Object.entries(templateMeta).map(([key, meta]) => { const template = templates.find((item) => item.key === key); return <button type="button" key={key} onClick={() => setSelectedKey(key)} data-testid={`tab-template-${key}`} className={cn('min-w-max rounded-md px-3 py-2 text-left transition', selectedKey === key ? 'bg-primary text-primary-foreground' : 'hover:bg-accent')}><span className="block text-[11px] font-extrabold">{template?.name || meta.title}</span><span className={cn('mt-1 block text-[9px]', selectedKey === key ? 'text-primary-foreground/60' : 'text-muted-foreground')}>{meta.detail}</span></button>; })}</div>
    {active ? <EmbedEditor template={active} guildId={guildId} onSaved={(saved) => setTemplates((current) => current.map((item) => item.key === saved.key ? saved : item))} onSent={() => undefined} /> : <EmptyState title="No templates yet" detail="Your API returned no reusable messages for this server." />}
  </div>;
}

function ToggleRow({ label, detail, checked, onChange, testId }: { label: string; detail: string; checked: boolean; onChange: (value: boolean) => void; testId: string }) {
  return <div className="flex items-center gap-4 rounded-md border border-border bg-card px-4 py-3"><div className="min-w-0 flex-1"><p className="text-[11px] font-bold">{label}</p><p className="mt-1 text-[10px] leading-4 text-muted-foreground">{detail}</p></div><button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} data-testid={testId} className={cn('relative h-5 w-9 shrink-0 rounded-full border transition', checked ? 'border-foreground bg-foreground' : 'border-border bg-muted')}><span className={cn('absolute top-0.5 h-3.5 w-3.5 rounded-full transition', checked ? 'left-[17px] bg-background' : 'left-0.5 bg-muted-foreground/50')} /></button></div>;
}

function SettingsPage() {
  const { guildId = '' } = useParams<{ guildId: string }>();
  const configQuery = useGetGuildConfig(guildId, { query: { queryKey: getGetGuildConfigQueryKey(guildId) } });
  const updateConfig = useUpdateGuildConfig();
  const requestUpload = useRequestUploadUrl();
  const [config, setConfig] = useState<GuildConfig | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => { if (configQuery.data && !config) setConfig(configQuery.data); }, [configQuery.data, config]);
  if (configQuery.isLoading) return <PageSkeleton />;
  if (configQuery.isError || !config) return <QueryError onRetry={() => configQuery.refetch()} label="Unable to load server settings." />;
  const patch = <K extends keyof GuildConfig>(section: K, values: Partial<GuildConfig[K]>) => setConfig((current) => current ? ({ ...current, [section]: { ...(current[section] as object), ...values } }) : current);
  const save = () => {
    const input: GuildConfigInput = { moderation: config.moderation, welcome: config.welcome, tickets: config.tickets, verification: config.verification, antiNuke: config.antiNuke };
    updateConfig.mutate({ guildId, data: input }, { onSuccess: (saved) => { setConfig(saved); setNotice({ tone: 'good', text: 'Server settings saved.' }); }, onError: () => setNotice({ tone: 'bad', text: 'Settings could not be saved.' }) });
  };
  const uploadMedia = (file: File) => {
    requestUpload.mutate({ data: { name: file.name, size: file.size, contentType: file.type || 'application/octet-stream' } }, { onSuccess: async (response) => { try { await fetch(response.uploadURL, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file }); setConfig((current) => current ? { ...current, welcome: { ...current.welcome, imagePath: response.objectPath, imageName: file.name } } : current); setNotice({ tone: 'good', text: 'Welcome media uploaded. Save settings to apply it.' }); } catch { setNotice({ tone: 'bad', text: 'Upload failed before completion.' }); } }, onError: () => setNotice({ tone: 'bad', text: 'Could not request an upload URL.' }) });
  };
  return <div className="reveal">
    <SectionHeading eyebrow="Server workspace / 04" title="Server settings" detail="Set the defaults that let Sentinel respond quickly without making decisions for you." action={<button type="button" onClick={save} disabled={updateConfig.isPending} data-testid="button-save-settings" className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-xs font-bold text-primary-foreground disabled:opacity-50"><Save className="h-3.5 w-3.5" /> {updateConfig.isPending ? 'Saving…' : 'Save changes'}</button>} />
    {notice && <div className="mb-5 flex items-center justify-between rounded-md border border-border bg-card px-3 py-3 text-xs font-semibold" data-testid="status-settings-notice"><span className="flex items-center gap-2">{notice.tone === 'good' ? <Check className="h-3.5 w-3.5" /> : <CircleAlert className="h-3.5 w-3.5" />}{notice.text}</span><button type="button" onClick={() => setNotice(null)} data-testid="button-dismiss-settings-notice"><X className="h-3.5 w-3.5" /></button></div>}
    <div className="grid gap-5 xl:grid-cols-2">
      <section className="rounded-xl border border-border bg-card" data-testid="section-moderation-settings"><div className="border-b border-border px-5 py-4"><p className="mono-label text-muted-foreground">01 / Defaults</p><h2 className="mt-1 text-sm font-extrabold">Moderation</h2></div><div className="space-y-4 p-5"><ToggleRow label="Send a private notice" detail="DM members when a moderation action is applied." checked={config.moderation.dmUsers} onChange={(value) => patch('moderation', { dmUsers: value })} testId="switch-moderation-dm" /><ToggleRow label="Delete command messages" detail="Remove command messages after Sentinel processes them." checked={Boolean(config.moderation.deleteCommandMessages)} onChange={(value) => patch('moderation', { deleteCommandMessages: value })} testId="switch-moderation-delete" /><label className="block space-y-2"><span className="text-[11px] font-bold">Default timeout <span className="font-normal text-muted-foreground">(hours)</span></span><input type="number" min="1" value={config.moderation.defaultTimeoutHours} onChange={(event) => patch('moderation', { defaultTimeoutHours: Number(event.target.value) || 1 })} data-testid="input-default-timeout-hours" className="h-10 w-full rounded-md border border-input bg-background px-3 text-xs outline-none focus:border-foreground" /></label><div className="grid gap-4 sm:grid-cols-2"><label className="block space-y-2"><span className="text-[11px] font-bold">Log channel ID</span><input value={config.moderation.logChannelId ?? ''} onChange={(event) => patch('moderation', { logChannelId: event.target.value || null })} data-testid="input-log-channel-id" className="h-10 w-full rounded-md border border-input bg-background px-3 text-xs outline-none focus:border-foreground" /></label><label className="block space-y-2"><span className="text-[11px] font-bold">Muted role ID</span><input value={config.moderation.mutedRoleId ?? ''} onChange={(event) => patch('moderation', { mutedRoleId: event.target.value || null })} data-testid="input-muted-role-id" className="h-10 w-full rounded-md border border-input bg-background px-3 text-xs outline-none focus:border-foreground" /></label></div></div></section>
      <section className="rounded-xl border border-border bg-card" data-testid="section-welcome-settings"><div className="border-b border-border px-5 py-4"><p className="mono-label text-muted-foreground">02 / Arrival</p><h2 className="mt-1 text-sm font-extrabold">Welcome flow</h2></div><div className="space-y-4 p-5"><ToggleRow label="Welcome messages" detail="Send a focused introduction when members arrive." checked={config.welcome.enabled} onChange={(value) => patch('welcome', { enabled: value })} testId="switch-welcome-enabled" /><ToggleRow label="Show member count" detail="Include the current server count in the welcome copy." checked={config.welcome.showMemberCount} onChange={(value) => patch('welcome', { showMemberCount: value })} testId="switch-welcome-member-count" /><label className="block space-y-2"><span className="text-[11px] font-bold">Welcome channel ID</span><input value={config.welcome.channelId ?? ''} onChange={(event) => patch('welcome', { channelId: event.target.value || null })} data-testid="input-welcome-channel-id" className="h-10 w-full rounded-md border border-input bg-background px-3 text-xs outline-none focus:border-foreground" /></label><label className="block space-y-2"><span className="text-[11px] font-bold">Message</span><textarea rows={4} value={config.welcome.message} onChange={(event) => patch('welcome', { message: event.target.value })} data-testid="textarea-welcome-message" className="w-full resize-none rounded-md border border-input bg-background px-3 py-2.5 text-xs leading-5 outline-none focus:border-foreground" /></label><div className="flex items-center justify-between rounded-md border border-dashed border-border px-3 py-3"><div className="flex min-w-0 items-center gap-2"><ImagePlus className="h-4 w-4 shrink-0 text-muted-foreground" /><div className="min-w-0"><p className="truncate text-[11px] font-bold">{config.welcome.imageName || 'Welcome media'}</p><p className="text-[10px] text-muted-foreground">{config.welcome.imagePath ? 'Uploaded and ready' : 'Optional image or banner'}</p></div></div><label className="cursor-pointer rounded-md border border-border px-2.5 py-1.5 text-[10px] font-bold hover:bg-accent"><input type="file" accept="image/*" onChange={(event) => event.target.files?.[0] && uploadMedia(event.target.files[0])} data-testid="input-welcome-media" className="sr-only" />{requestUpload.isPending ? 'Uploading…' : 'Choose file'}</label></div></div></section>
      <section className="rounded-xl border border-border bg-card" data-testid="section-ticket-settings"><div className="border-b border-border px-5 py-4"><p className="mono-label text-muted-foreground">03 / Support</p><h2 className="mt-1 text-sm font-extrabold">Ticketing</h2></div><div className="space-y-4 p-5"><ToggleRow label="Ticket channels" detail="Allow members to open private support threads." checked={config.tickets.enabled} onChange={(value) => patch('tickets', { enabled: value })} testId="switch-tickets-enabled" /><label className="block space-y-2"><span className="text-[11px] font-bold">Category ID</span><input value={config.tickets.categoryId ?? ''} onChange={(event) => patch('tickets', { categoryId: event.target.value || null })} data-testid="input-ticket-category-id" className="h-10 w-full rounded-md border border-input bg-background px-3 text-xs outline-none focus:border-foreground" /></label><div className="grid gap-4 sm:grid-cols-2"><label className="block space-y-2"><span className="text-[11px] font-bold">Support role ID</span><input value={config.tickets.supportRoleId ?? ''} onChange={(event) => patch('tickets', { supportRoleId: event.target.value || null })} data-testid="input-ticket-support-role-id" className="h-10 w-full rounded-md border border-input bg-background px-3 text-xs outline-none focus:border-foreground" /></label><label className="block space-y-2"><span className="text-[11px] font-bold">Transcript channel ID</span><input value={config.tickets.transcriptChannelId ?? ''} onChange={(event) => patch('tickets', { transcriptChannelId: event.target.value || null })} data-testid="input-ticket-transcript-channel-id" className="h-10 w-full rounded-md border border-input bg-background px-3 text-xs outline-none focus:border-foreground" /></label></div></div></section>
      <section className="rounded-xl border border-border bg-card" data-testid="section-antinuke-settings"><div className="border-b border-border px-5 py-4"><p className="mono-label text-muted-foreground">04 / Recovery</p><h2 className="mt-1 text-sm font-extrabold">Anti-nuke thresholds</h2></div><div className="space-y-4 p-5"><ToggleRow label="Anti-nuke protection" detail="Watch for destructive bursts and enter recovery mode." checked={config.antiNuke.enabled} onChange={(value) => patch('antiNuke', { enabled: value })} testId="switch-antinuke-enabled" /><ToggleRow label="Purge recent messages" detail="Clear the attack window when recovery is triggered." checked={config.antiNuke.purgeRecentMessages} onChange={(value) => patch('antiNuke', { purgeRecentMessages: value })} testId="switch-antinuke-purge" /><ToggleRow label="DM the reason" detail="Explain the recovery decision privately to affected members." checked={config.antiNuke.dmReason} onChange={(value) => patch('antiNuke', { dmReason: value })} testId="switch-antinuke-dm" /><div className="grid gap-4 sm:grid-cols-2"><label className="block space-y-2"><span className="text-[11px] font-bold">First timeout <span className="font-normal text-muted-foreground">(hours)</span></span><input type="number" min="1" value={config.antiNuke.firstTimeoutHours} onChange={(event) => patch('antiNuke', { firstTimeoutHours: Number(event.target.value) || 1 })} data-testid="input-antinuke-first-timeout" className="h-10 w-full rounded-md border border-input bg-background px-3 text-xs outline-none focus:border-foreground" /></label><label className="block space-y-2"><span className="text-[11px] font-bold">Second timeout <span className="font-normal text-muted-foreground">(days)</span></span><input type="number" min="1" value={config.antiNuke.secondTimeoutDays} onChange={(event) => patch('antiNuke', { secondTimeoutDays: Number(event.target.value) || 1 })} data-testid="input-antinuke-second-timeout" className="h-10 w-full rounded-md border border-input bg-background px-3 text-xs outline-none focus:border-foreground" /></label></div><label className="block space-y-2"><span className="text-[11px] font-bold">Bait channel ID</span><input value={config.antiNuke.baitChannelId ?? ''} onChange={(event) => patch('antiNuke', { baitChannelId: event.target.value || null })} data-testid="input-antinuke-bait-channel-id" className="h-10 w-full rounded-md border border-input bg-background px-3 text-xs outline-none focus:border-foreground" /></label></div></section>
    </div>
  </div>;
}

function Router() {
  const guildsQuery = useListDiscordGuilds({ query: { queryKey: getListDiscordGuildsQueryKey() } });
  const guilds = guildsQuery.data ?? [];
  return <AppShell guilds={guilds} guildsLoading={guildsQuery.isLoading}><ErrorBoundary resetKey={location.pathname}><Switch><Route path="/" component={() => <OverviewPage guilds={guilds} guildsLoading={guildsQuery.isLoading} />} /><Route path="/servers/:guildId/embeds" component={EmbedsPage} /><Route path="/servers/:guildId/settings" component={SettingsPage} /><Route path="/servers/:guildId" component={ServerPage} /><Route component={NotFound} /></Switch></ErrorBoundary></AppShell>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;