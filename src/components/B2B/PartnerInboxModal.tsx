import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Inbox, Loader2, MessageSquare, Package, RefreshCw, Search, X } from 'lucide-react';
import PartnerChatPanel from './PartnerChatPanel';
import MaterialRequestPanel from './MaterialRequestPanel';
import {
    PartnerThreadSummary,
    fetchLabThreadSummaries,
    fetchOpenMaterialRequestCounts,
    subscribeToLabPartnerActivity,
} from '../../utils/partnerCommsService';

export interface InboxAccount {
    id: string;
    name: string;
    code?: string | null;
}

interface PartnerInboxModalProps {
    labId: string;
    /** Every B2B account of the lab; those without a thread yet can be messaged from here */
    accounts: InboxAccount[];
    initialAccountId?: string | null;
    initialTab?: 'chat' | 'materials';
    onClose: () => void;
    /** Fired when counts change, so the caller can refresh its own badges */
    onCountsChanged?: () => void;
}

type InboxFilter = 'all' | 'unread';

interface InboxRow extends InboxAccount {
    summary: PartnerThreadSummary | null;
    unreadCount: number;
    openRequestCount: number;
}

const relativeTime = (value?: string | null) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';

    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    if (sameDay) return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';

    return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
};

/**
 * One place for every partner conversation: the lab picks an account on the
 * left and talks to it on the right, with the accounts that wrote last (and
 * unread ones first) at the top so nobody has to scan the account list.
 */
const PartnerInboxModal: React.FC<PartnerInboxModalProps> = ({
    labId,
    accounts,
    initialAccountId = null,
    initialTab = 'chat',
    onClose,
    onCountsChanged,
}) => {
    const [summaries, setSummaries] = useState<Record<string, PartnerThreadSummary>>({});
    const [openRequestCounts, setOpenRequestCounts] = useState<Record<string, number>>({});
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState<InboxFilter>('all');
    const [selectedId, setSelectedId] = useState<string | null>(initialAccountId);
    const [tab, setTab] = useState<'chat' | 'materials'>(initialTab);

    const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const load = useCallback(async (options?: { silent?: boolean }) => {
        if (!labId) return;
        if (options?.silent) setRefreshing(true);
        else setLoading(true);
        try {
            const [threads, openRequests] = await Promise.all([
                fetchLabThreadSummaries(labId),
                fetchOpenMaterialRequestCounts(labId),
            ]);
            setSummaries(threads);
            setOpenRequestCounts(openRequests);
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, [labId]);

    useEffect(() => {
        load();
    }, [load]);

    // Anything a partner writes — or a read receipt this modal itself triggers —
    // lands here; debounced so a burst of changes causes one refresh
    useEffect(() => {
        if (!labId) return;
        return subscribeToLabPartnerActivity(labId, () => {
            if (reloadTimer.current) clearTimeout(reloadTimer.current);
            reloadTimer.current = setTimeout(() => load({ silent: true }), 600);
        });
    }, [labId, load]);

    useEffect(() => () => {
        if (reloadTimer.current) clearTimeout(reloadTimer.current);
    }, []);

    const rows = useMemo<InboxRow[]>(() => {
        const term = search.trim().toLowerCase();

        return accounts
            .map((account) => ({
                ...account,
                summary: summaries[account.id] || null,
                unreadCount: summaries[account.id]?.unreadCount || 0,
                openRequestCount: openRequestCounts[account.id] || 0,
            }))
            .filter((row) => {
                if (filter === 'unread' && row.unreadCount === 0 && row.openRequestCount === 0) return false;
                if (!term) return true;
                return (
                    row.name.toLowerCase().includes(term) ||
                    (row.code || '').toLowerCase().includes(term) ||
                    (row.summary?.lastMessagePreview || '').toLowerCase().includes(term)
                );
            })
            .sort((a, b) => {
                // Unread first, then most recent activity, then accounts never messaged
                if ((a.unreadCount > 0) !== (b.unreadCount > 0)) return a.unreadCount > 0 ? -1 : 1;
                const aTime = a.summary?.lastMessageAt ? new Date(a.summary.lastMessageAt).getTime() : 0;
                const bTime = b.summary?.lastMessageAt ? new Date(b.summary.lastMessageAt).getTime() : 0;
                if (aTime !== bTime) return bTime - aTime;
                return a.name.localeCompare(b.name);
            });
    }, [accounts, summaries, openRequestCounts, search, filter]);

    // Land on the busiest thread when opened without a specific account
    useEffect(() => {
        if (selectedId || loading || rows.length === 0) return;
        setSelectedId(rows[0].id);
    }, [selectedId, loading, rows]);

    const selected = useMemo(
        () => accounts.find((account) => account.id === selectedId) || null,
        [accounts, selectedId]
    );

    const totalUnread = useMemo(
        () => Object.values(summaries).reduce((sum, thread) => sum + thread.unreadCount, 0),
        [summaries]
    );

    const handleClose = () => {
        onCountsChanged?.();
        onClose();
    };

    const tabClass = (value: 'chat' | 'materials') =>
        `flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
            tab === value
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
        }`;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="flex h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg bg-white shadow-xl">
                <div className="flex items-start justify-between border-b border-gray-200 px-6 py-4">
                    <div className="flex items-center gap-3">
                        <Inbox className="h-5 w-5 text-blue-600" />
                        <div>
                            <h2 className="text-lg font-bold text-gray-900">Partner Inbox</h2>
                            <p className="text-sm text-gray-500">
                                All B2B chats and material requests in one place
                                {totalUnread > 0 ? ` - ${totalUnread} unread message${totalUnread === 1 ? '' : 's'}` : ''}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-1">
                        <button
                            onClick={() => load({ silent: true })}
                            className="rounded-lg p-1 hover:bg-gray-100"
                            title="Refresh"
                        >
                            <RefreshCw className={`h-4 w-4 text-gray-500 ${refreshing ? 'animate-spin' : ''}`} />
                        </button>
                        <button onClick={handleClose} className="rounded-lg p-1 hover:bg-gray-100" aria-label="Close">
                            <X className="h-5 w-5 text-gray-500" />
                        </button>
                    </div>
                </div>

                <div className="flex min-h-0 flex-1">
                    {/* Thread list */}
                    <div className="flex w-80 shrink-0 flex-col border-r border-gray-200 bg-gray-50">
                        <div className="space-y-2 border-b border-gray-200 p-3">
                            <div className="relative">
                                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                                <input
                                    type="text"
                                    value={search}
                                    onChange={(event) => setSearch(event.target.value)}
                                    placeholder="Search accounts or messages..."
                                    className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm focus:ring-2 focus:ring-blue-500"
                                />
                            </div>
                            <div className="flex gap-1">
                                {(['all', 'unread'] as InboxFilter[]).map((value) => (
                                    <button
                                        key={value}
                                        type="button"
                                        onClick={() => setFilter(value)}
                                        className={`rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors ${
                                            filter === value
                                                ? 'bg-blue-600 text-white'
                                                : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'
                                        }`}
                                    >
                                        {value === 'unread' ? 'Needs attention' : 'All accounts'}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="min-h-0 flex-1 overflow-y-auto">
                            {loading ? (
                                <div className="flex items-center justify-center gap-2 p-6 text-sm text-gray-500">
                                    <Loader2 className="h-4 w-4 animate-spin" /> Loading threads...
                                </div>
                            ) : rows.length === 0 ? (
                                <p className="p-6 text-center text-sm text-gray-500">
                                    {filter === 'unread' ? 'Nothing needs attention right now.' : 'No accounts found.'}
                                </p>
                            ) : (
                                rows.map((row) => {
                                    const active = row.id === selectedId;
                                    return (
                                        <button
                                            key={row.id}
                                            type="button"
                                            onClick={() => {
                                                setSelectedId(row.id);
                                                setTab('chat');
                                            }}
                                            className={`w-full border-b border-gray-100 px-3 py-3 text-left transition-colors ${
                                                active ? 'bg-white shadow-inner' : 'hover:bg-white/70'
                                            }`}
                                        >
                                            <div className="flex items-start justify-between gap-2">
                                                <span
                                                    className={`truncate text-sm ${
                                                        row.unreadCount > 0 ? 'font-bold text-gray-900' : 'font-medium text-gray-800'
                                                    }`}
                                                >
                                                    {row.name}
                                                </span>
                                                <span className="shrink-0 text-[11px] text-gray-400">
                                                    {relativeTime(row.summary?.lastMessageAt)}
                                                </span>
                                            </div>
                                            <div className="mt-0.5 flex items-center justify-between gap-2">
                                                <span
                                                    className={`truncate text-xs ${
                                                        row.unreadCount > 0 ? 'font-medium text-gray-700' : 'text-gray-500'
                                                    }`}
                                                >
                                                    {row.summary?.lastMessagePreview
                                                        ? `${row.summary.lastMessageFrom === 'lab' ? 'You: ' : ''}${row.summary.lastMessagePreview}`
                                                        : 'No messages yet'}
                                                </span>
                                                <span className="flex shrink-0 items-center gap-1">
                                                    {row.openRequestCount > 0 && (
                                                        <span
                                                            className="flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800"
                                                            title={`${row.openRequestCount} open material request(s)`}
                                                        >
                                                            <Package className="h-3 w-3" />
                                                            {row.openRequestCount}
                                                        </span>
                                                    )}
                                                    {row.unreadCount > 0 && (
                                                        <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
                                                            {row.unreadCount}
                                                        </span>
                                                    )}
                                                </span>
                                            </div>
                                        </button>
                                    );
                                })
                            )}
                        </div>
                    </div>

                    {/* Conversation */}
                    <div className="flex min-w-0 flex-1 flex-col">
                        {selected ? (
                            <>
                                <div className="border-b border-gray-200 px-5 pt-3">
                                    <div className="flex items-baseline gap-2">
                                        <h3 className="text-base font-semibold text-gray-900">{selected.name}</h3>
                                        {selected.code && <span className="text-xs text-gray-500">{selected.code}</span>}
                                    </div>
                                    <div className="mt-1 flex gap-1">
                                        <button type="button" onClick={() => setTab('chat')} className={tabClass('chat')}>
                                            <MessageSquare className="h-4 w-4" />
                                            Chat
                                        </button>
                                        <button type="button" onClick={() => setTab('materials')} className={tabClass('materials')}>
                                            <Package className="h-4 w-4" />
                                            Material Requests
                                            {(openRequestCounts[selected.id] || 0) > 0 && (
                                                <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                                                    {openRequestCounts[selected.id]}
                                                </span>
                                            )}
                                        </button>
                                    </div>
                                </div>

                                <div className="min-h-0 flex-1 overflow-y-auto bg-gray-50 p-4">
                                    {tab === 'chat' ? (
                                        <PartnerChatPanel
                                            key={selected.id}
                                            accountId={selected.id}
                                            labId={labId}
                                            counterpartyName={selected.name}
                                            heightClass="h-[calc(88vh-290px)]"
                                        />
                                    ) : (
                                        <MaterialRequestPanel key={selected.id} accountId={selected.id} labId={labId} mode="lab" />
                                    )}
                                </div>
                            </>
                        ) : (
                            <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-gray-500">
                                Pick a partner on the left to open the conversation.
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default PartnerInboxModal;
