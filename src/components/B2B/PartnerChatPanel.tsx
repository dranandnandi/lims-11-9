import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Download, FileText, Image as ImageIcon, Loader2, Paperclip, RefreshCw, Send, X } from 'lucide-react';
import {
    AccountMessage,
    MessageAttachment,
    PartnerViewer,
    fetchAccountMessages,
    getAttachmentUrl,
    getPartnerViewer,
    isUnreadFor,
    markThreadRead,
    sendAccountMessage,
    subscribeToAccountThread,
    uploadChatAttachment,
} from '../../utils/partnerCommsService';

interface PartnerChatPanelProps {
    accountId: string;
    labId: string;
    /** Shown in the empty state, e.g. the partner name on the lab side */
    counterpartyName?: string;
    /** Height of the scrolling message area */
    heightClass?: string;
}

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

const formatSize = (bytes?: number) => {
    if (!bytes || bytes <= 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatTimestamp = (value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('en-IN', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
    });
};

const dayLabel = (value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const AttachmentChip: React.FC<{ attachment: MessageAttachment; outgoing: boolean }> = ({ attachment, outgoing }) => {
    const [opening, setOpening] = useState(false);
    const isImage = (attachment.mime || '').startsWith('image/');

    const handleOpen = async () => {
        setOpening(true);
        try {
            const url = await getAttachmentUrl(attachment.path);
            if (url) window.open(url, '_blank', 'noopener');
            else alert('This attachment is no longer available');
        } finally {
            setOpening(false);
        }
    };

    return (
        <button
            type="button"
            onClick={handleOpen}
            disabled={opening}
            className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition-colors ${
                outgoing
                    ? 'border-blue-400/40 bg-blue-500/20 text-white hover:bg-blue-500/30'
                    : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
            } disabled:opacity-60`}
            title={attachment.name}
        >
            {opening ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            ) : isImage ? (
                <ImageIcon className="h-4 w-4 shrink-0" />
            ) : (
                <FileText className="h-4 w-4 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate font-medium">{attachment.name}</span>
            {attachment.size ? <span className="shrink-0 opacity-70">{formatSize(attachment.size)}</span> : null}
            <Download className="h-3.5 w-3.5 shrink-0 opacity-70" />
        </button>
    );
};

const PartnerChatPanel: React.FC<PartnerChatPanelProps> = ({
    accountId,
    labId,
    counterpartyName,
    heightClass = 'h-[380px]',
}) => {
    const [viewer, setViewer] = useState<PartnerViewer | null>(null);
    const [messages, setMessages] = useState<AccountMessage[]>([]);
    const [loading, setLoading] = useState(true);
    const [sending, setSending] = useState(false);
    const [draft, setDraft] = useState('');
    const [pendingFiles, setPendingFiles] = useState<File[]>([]);
    const [error, setError] = useState<string | null>(null);

    const fileInputRef = useRef<HTMLInputElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    // Read inside loadMessages without making the viewer a dependency of it
    const viewerSideRef = useRef<PartnerViewer['side'] | null>(null);

    const loadMessages = useCallback(async (options?: { silent?: boolean }) => {
        if (!accountId) return;
        if (!options?.silent) setLoading(true);
        try {
            const rows = await fetchAccountMessages(accountId);
            setMessages(rows);
            setError(null);

            // Only write read receipts when something is actually unread, so the
            // realtime subscription does not bounce an update straight back
            const side = viewerSideRef.current;
            if (side && rows.some((message) => isUnreadFor(message, side))) {
                await markThreadRead(accountId);
            }
        } catch (err: any) {
            console.error('Error loading chat:', err);
            setError(err.message || 'Could not load messages');
        } finally {
            setLoading(false);
        }
    }, [accountId]);

    useEffect(() => {
        let active = true;
        getPartnerViewer().then((result) => {
            if (!active) return;
            viewerSideRef.current = result?.side || null;
            setViewer(result);
        });
        return () => {
            active = false;
        };
    }, []);

    useEffect(() => {
        loadMessages();
    }, [loadMessages]);

    // The first load can land before the viewer resolves; settle read receipts once it does
    useEffect(() => {
        if (!viewer || !accountId) return;
        if (messages.some((message) => isUnreadFor(message, viewer.side))) {
            markThreadRead(accountId).then(() => loadMessages({ silent: true }));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewer]);

    useEffect(() => {
        if (!accountId) return;
        return subscribeToAccountThread(accountId, () => loadMessages({ silent: true }));
    }, [accountId, loadMessages]);

    // Keep the newest message in view
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ block: 'nearest' });
    }, [messages.length]);

    const grouped = useMemo(() => {
        const groups: { day: string; items: AccountMessage[] }[] = [];
        messages.forEach((message) => {
            const day = dayLabel(message.created_at);
            const last = groups[groups.length - 1];
            if (last && last.day === day) last.items.push(message);
            else groups.push({ day, items: [message] });
        });
        return groups;
    }, [messages]);

    const handleFilesPicked = (event: React.ChangeEvent<HTMLInputElement>) => {
        const picked = Array.from(event.target.files || []);
        const oversized = picked.filter((file) => file.size > MAX_ATTACHMENT_BYTES);
        if (oversized.length > 0) {
            setError(`${oversized[0].name} is larger than 15 MB`);
        }
        setPendingFiles((current) => [...current, ...picked.filter((file) => file.size <= MAX_ATTACHMENT_BYTES)]);
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const removePendingFile = (index: number) => {
        setPendingFiles((current) => current.filter((_, i) => i !== index));
    };

    const handleSend = async () => {
        if (!viewer || !accountId || !labId) return;
        if (!draft.trim() && pendingFiles.length === 0) return;

        setSending(true);
        setError(null);
        try {
            const attachments: MessageAttachment[] = [];
            for (const file of pendingFiles) {
                attachments.push(await uploadChatAttachment(accountId, file));
            }

            const message = await sendAccountMessage({
                labId,
                accountId,
                viewer,
                body: draft,
                attachments,
            });

            setMessages((current) => (current.some((item) => item.id === message.id) ? current : [...current, message]));
            setDraft('');
            setPendingFiles([]);
        } catch (err: any) {
            console.error('Error sending message:', err);
            setError(err.message || 'Could not send the message');
        } finally {
            setSending(false);
        }
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            handleSend();
        }
    };

    const viewerSide = viewer?.side;

    return (
        <div className="flex flex-col overflow-hidden rounded-lg border border-gray-200 bg-white">
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
                <div className="text-xs text-gray-500">
                    {viewerSide === 'lab'
                        ? 'Messages are visible to this partner in their portal'
                        : 'Messages are visible to the lab team'}
                </div>
                <button
                    type="button"
                    onClick={() => loadMessages()}
                    className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
                >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Refresh
                </button>
            </div>

            <div ref={scrollRef} className={`${heightClass} space-y-4 overflow-y-auto bg-gray-50 px-4 py-4`}>
                {loading ? (
                    <div className="flex h-full items-center justify-center text-sm text-gray-500">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading conversation...
                    </div>
                ) : messages.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center text-center text-sm text-gray-500">
                        <p className="font-medium text-gray-700">No messages yet</p>
                        <p className="mt-1 max-w-xs text-xs">
                            {viewerSide === 'lab'
                                ? `Start the conversation with ${counterpartyName || 'this partner'}. They will see it in their portal.`
                                : 'Send a message to the lab team. You can attach clinical history or other documents.'}
                        </p>
                    </div>
                ) : (
                    grouped.map((group) => (
                        <div key={group.day} className="space-y-3">
                            <div className="flex justify-center">
                                <span className="rounded-full bg-white px-3 py-0.5 text-[11px] font-medium text-gray-500 shadow-sm">
                                    {group.day}
                                </span>
                            </div>
                            {group.items.map((message) => {
                                const outgoing = message.sender_type === viewerSide;
                                return (
                                    <div key={message.id} className={`flex ${outgoing ? 'justify-end' : 'justify-start'}`}>
                                        <div
                                            className={`max-w-[80%] space-y-2 rounded-2xl px-3.5 py-2.5 shadow-sm ${
                                                outgoing
                                                    ? 'rounded-br-sm bg-blue-600 text-white'
                                                    : 'rounded-bl-sm border border-gray-200 bg-white text-gray-800'
                                            }`}
                                        >
                                            {!outgoing && message.sender_name && (
                                                <div className="text-[11px] font-semibold text-blue-700">
                                                    {message.sender_name}
                                                </div>
                                            )}
                                            {message.body && (
                                                <p className="whitespace-pre-wrap break-words text-sm leading-5">
                                                    {message.body}
                                                </p>
                                            )}
                                            {message.attachments.length > 0 && (
                                                <div className="space-y-1.5">
                                                    {message.attachments.map((attachment) => (
                                                        <AttachmentChip
                                                            key={attachment.path}
                                                            attachment={attachment}
                                                            outgoing={outgoing}
                                                        />
                                                    ))}
                                                </div>
                                            )}
                                            <div
                                                className={`text-right text-[10px] ${
                                                    outgoing ? 'text-blue-100' : 'text-gray-400'
                                                }`}
                                            >
                                                {formatTimestamp(message.created_at)}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ))
                )}
                <div ref={bottomRef} />
            </div>

            {error && (
                <div className="flex items-start gap-2 border-t border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="flex-1">{error}</span>
                    <button type="button" onClick={() => setError(null)} className="text-red-500 hover:text-red-700">
                        <X className="h-3.5 w-3.5" />
                    </button>
                </div>
            )}

            {pendingFiles.length > 0 && (
                <div className="flex flex-wrap gap-2 border-t border-gray-100 bg-white px-4 py-2">
                    {pendingFiles.map((file, index) => (
                        <span
                            key={`${file.name}-${index}`}
                            className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 py-1 pl-2.5 pr-1.5 text-xs text-blue-700"
                        >
                            <Paperclip className="h-3 w-3" />
                            <span className="max-w-[160px] truncate">{file.name}</span>
                            <span className="opacity-70">{formatSize(file.size)}</span>
                            <button
                                type="button"
                                onClick={() => removePendingFile(index)}
                                className="rounded-full p-0.5 hover:bg-blue-100"
                                aria-label={`Remove ${file.name}`}
                            >
                                <X className="h-3 w-3" />
                            </button>
                        </span>
                    ))}
                </div>
            )}

            <div className="flex items-end gap-2 border-t border-gray-200 bg-white px-3 py-3">
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    onChange={handleFilesPicked}
                    className="hidden"
                    accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.doc,.docx,.xls,.xlsx,.txt,.csv"
                />
                <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={sending}
                    className="rounded-lg border border-gray-200 p-2 text-gray-500 transition-colors hover:bg-gray-50 disabled:opacity-50"
                    title="Attach a file (clinical history, prescription, etc.)"
                >
                    <Paperclip className="h-4 w-4" />
                </button>
                <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={handleKeyDown}
                    rows={1}
                    placeholder="Type a message..."
                    className="max-h-32 min-h-[40px] flex-1 resize-y rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                />
                <button
                    type="button"
                    onClick={handleSend}
                    disabled={sending || (!draft.trim() && pendingFiles.length === 0)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
                >
                    {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    <span className="hidden sm:inline">{sending ? 'Sending' : 'Send'}</span>
                </button>
            </div>
        </div>
    );
};

export default PartnerChatPanel;
