import React, { useState } from 'react';
import { MessageSquare, Package, X } from 'lucide-react';
import PartnerChatPanel from './PartnerChatPanel';
import MaterialRequestPanel from './MaterialRequestPanel';

interface PartnerDeskModalProps {
    accountId: string;
    accountName: string;
    labId: string;
    initialTab?: 'chat' | 'materials';
    openRequestCount?: number;
    onClose: () => void;
}

/**
 * Lab-side desk for one franchise/B2B partner: the shared chat thread and the
 * material requests they have raised.
 */
const PartnerDeskModal: React.FC<PartnerDeskModalProps> = ({
    accountId,
    accountName,
    labId,
    initialTab = 'chat',
    openRequestCount = 0,
    onClose,
}) => {
    const [tab, setTab] = useState<'chat' | 'materials'>(initialTab);

    const tabClass = (value: 'chat' | 'materials') =>
        `flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
            tab === value
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
        }`;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-white shadow-xl">
                <div className="flex items-start justify-between border-b border-gray-200 px-6 py-4">
                    <div>
                        <h2 className="text-lg font-bold text-gray-900">{accountName}</h2>
                        <p className="text-sm text-gray-500">Partner desk - chat and material requests</p>
                    </div>
                    <button onClick={onClose} className="rounded-lg p-1 hover:bg-gray-100" aria-label="Close">
                        <X className="h-5 w-5 text-gray-500" />
                    </button>
                </div>

                <div className="flex gap-1 border-b border-gray-200 px-4">
                    <button type="button" onClick={() => setTab('chat')} className={tabClass('chat')}>
                        <MessageSquare className="h-4 w-4" />
                        Chat
                    </button>
                    <button type="button" onClick={() => setTab('materials')} className={tabClass('materials')}>
                        <Package className="h-4 w-4" />
                        Material Requests
                        {openRequestCount > 0 && (
                            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                                {openRequestCount}
                            </span>
                        )}
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto bg-gray-50 p-4">
                    {tab === 'chat' ? (
                        <PartnerChatPanel
                            accountId={accountId}
                            labId={labId}
                            counterpartyName={accountName}
                            heightClass="h-[420px]"
                        />
                    ) : (
                        <MaterialRequestPanel accountId={accountId} labId={labId} mode="lab" />
                    )}
                </div>
            </div>
        </div>
    );
};

export default PartnerDeskModal;
