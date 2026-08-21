import React, { useState, useEffect } from 'react';
import { 
  Users, 
  RefreshCw, 
  CheckCircle, 
  XCircle, 
  Clock, 
  AlertTriangle,
  Download,
  Upload,
  Settings
} from 'lucide-react';
import { whatsappUserSync } from '../../utils/whatsappUserSync';
import { database } from '../../utils/supabase';

interface SyncStatusUser {
  id: string;
  name: string;
  email: string;
  whatsapp_sync_status: 'pending' | 'synced' | 'failed' | 'disabled';
  whatsapp_last_sync: string | null;
  whatsapp_user_id: string | null;
  whatsapp_sync_error: string | null;
}

const WhatsAppUserSyncManager: React.FC = () => {
  const [users, setUsers] = useState<SyncStatusUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [bulkSyncing, setBulkSyncing] = useState(false);
  const [currentLabId, setCurrentLabId] = useState<string | null>(null);
  const [syncStats, setSyncStats] = useState({
    total: 0,
    synced: 0,
    pending: 0,
    failed: 0,
    disabled: 0
  });

  useEffect(() => {
    loadSyncStatus();
    getCurrentLab();
  }, []);

  const getCurrentLab = async () => {
    try {
      const labId = await database.getCurrentUserLabId();
      setCurrentLabId(labId);
    } catch (error) {
      console.error('Failed to get current lab:', error);
    }
  };

  const loadSyncStatus = async () => {
    setLoading(true);
    try {
      const labId = await database.getCurrentUserLabId();
      const syncData = await whatsappUserSync.getSyncStatus(labId);
      setUsers(syncData);
      
      // Calculate stats. The column is nullable, so an unrecognised value has
      // to land somewhere — counting it as pending beats an NaN tile.
      const stats = syncData.reduce((acc, user) => {
        acc.total++;
        const bucket = user.whatsapp_sync_status;
        if (bucket === 'synced' || bucket === 'failed' || bucket === 'disabled') {
          acc[bucket]++;
        } else {
          acc.pending++;
        }
        return acc;
      }, { total: 0, synced: 0, pending: 0, failed: 0, disabled: 0 });
      
      setSyncStats(stats);
    } catch (error) {
      console.error('Failed to load sync status:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSyncUser = async (userId: string) => {
    setSyncing(userId);
    try {
      const result = await whatsappUserSync.syncUserToWhatsApp(userId);
      if (result.success) {
        alert('User synced successfully!');
      } else {
        alert(`Sync failed: ${result.message}`);
      }
      await loadSyncStatus();
    } catch (error) {
      console.error('Sync failed:', error);
      alert('Sync failed due to an error');
    } finally {
      setSyncing(null);
    }
  };

  const handleBulkSync = async () => {
    if (!currentLabId) {
      alert('No lab selected');
      return;
    }

    setBulkSyncing(true);
    try {
      const result = await whatsappUserSync.syncAllUsersInLab(currentLabId);
      alert(`Bulk sync completed: ${result.success} successful, ${result.failed} failed`);
      await loadSyncStatus();
    } catch (error) {
      console.error('Bulk sync failed:', error);
      alert('Bulk sync failed due to an error');
    } finally {
      setBulkSyncing(false);
    }
  };

  const handleRetryFailed = async () => {
    if (!currentLabId) {
      alert('No lab selected');
      return;
    }

    setBulkSyncing(true);
    try {
      const result = await whatsappUserSync.retryFailedSyncs(currentLabId);
      alert(`Retry completed: ${result.success} successful, ${result.failed} still failed`);
      await loadSyncStatus();
    } catch (error) {
      console.error('Retry failed:', error);
      alert('Retry operation failed');
    } finally {
      setBulkSyncing(false);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'synced':
        return <CheckCircle className="w-5 h-5 text-green-500" />;
      case 'failed':
        return <XCircle className="w-5 h-5 text-red-500" />;
      case 'pending':
        return <Clock className="w-5 h-5 text-yellow-500" />;
      case 'disabled':
        return <AlertTriangle className="w-5 h-5 text-gray-400" />;
      default:
        return <Clock className="w-5 h-5 text-gray-400" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'synced':
        return 'bg-green-100 text-green-800';
      case 'failed':
        return 'bg-red-100 text-red-800';
      case 'pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'disabled':
        return 'bg-gray-100 text-gray-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return 'Never';
    return new Date(dateString).toLocaleString();
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              <Users className="w-7 h-7" />
              WhatsApp User Sync Management
            </h1>
            <p className="text-gray-600 mt-1">
              Manage synchronization of LIMS users with WhatsApp backend database
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={loadSyncStatus}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <div className="bg-white p-4 rounded-lg border shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Total Users</p>
              <p className="text-2xl font-semibold text-gray-900">{syncStats.total}</p>
            </div>
            <Users className="w-8 h-8 text-blue-500" />
          </div>
        </div>

        <div className="bg-white p-4 rounded-lg border shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Synced</p>
              <p className="text-2xl font-semibold text-green-600">{syncStats.synced}</p>
            </div>
            <CheckCircle className="w-8 h-8 text-green-500" />
          </div>
        </div>

        <div className="bg-white p-4 rounded-lg border shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Pending</p>
              <p className="text-2xl font-semibold text-yellow-600">{syncStats.pending}</p>
            </div>
            <Clock className="w-8 h-8 text-yellow-500" />
          </div>
        </div>

        <div className="bg-white p-4 rounded-lg border shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Failed</p>
              <p className="text-2xl font-semibold text-red-600">{syncStats.failed}</p>
            </div>
            <XCircle className="w-8 h-8 text-red-500" />
          </div>
        </div>

        <div className="bg-white p-4 rounded-lg border shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Disabled</p>
              <p className="text-2xl font-semibold text-gray-600">{syncStats.disabled}</p>
            </div>
            <AlertTriangle className="w-8 h-8 text-gray-400" />
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex flex-wrap gap-3 mb-6">
        <button
          onClick={handleBulkSync}
          disabled={bulkSyncing || !currentLabId}
          className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
        >
          <Upload className="w-4 h-4" />
          {bulkSyncing ? 'Syncing All...' : 'Sync All Users'}
        </button>

        <button
          onClick={handleRetryFailed}
          disabled={bulkSyncing || syncStats.failed === 0}
          className="flex items-center gap-2 px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50"
        >
          <RefreshCw className="w-4 h-4" />
          Retry Failed ({syncStats.failed})
        </button>

        <button
          onClick={() => {/* TODO: Export functionality */}}
          className="flex items-center gap-2 px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700"
        >
          <Download className="w-4 h-4" />
          Export Report
        </button>

        <button
          onClick={() => {/* TODO: Settings modal */}}
          className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700"
        >
          <Settings className="w-4 h-4" />
          Settings
        </button>
      </div>

      {/* Users Table */}
      <div className="bg-white rounded-lg border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-900">User</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-900">Email</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-900">Sync Status</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-900">Last Sync</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-900">WhatsApp ID</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-900">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                    <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2" />
                    Loading sync status...
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                    No users found
                  </td>
                </tr>
              ) : (
                users.map((user) => (
                  <tr key={user.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{user.name}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{user.email}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {getStatusIcon(user.whatsapp_sync_status)}
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(user.whatsapp_sync_status)}`}>
                          {user.whatsapp_sync_status}
                        </span>
                      </div>
                      {user.whatsapp_sync_error && (
                        <div className="mt-1 text-xs text-red-600" title={user.whatsapp_sync_error}>
                          {user.whatsapp_sync_error.length > 50 
                            ? user.whatsapp_sync_error.substring(0, 50) + '...' 
                            : user.whatsapp_sync_error}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {formatDate(user.whatsapp_last_sync)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {user.whatsapp_user_id ? (
                        <span className="font-mono text-xs bg-gray-100 px-2 py-1 rounded">
                          {user.whatsapp_user_id.substring(0, 8)}...
                        </span>
                      ) : (
                        <span className="text-gray-400">Not synced</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleSyncUser(user.id)}
                        disabled={syncing === user.id}
                        className="inline-flex items-center gap-1 px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                      >
                        {syncing === user.id ? (
                          <>
                            <RefreshCw className="w-3 h-3 animate-spin" />
                            Syncing...
                          </>
                        ) : (
                          <>
                            <RefreshCw className="w-3 h-3" />
                            Sync
                          </>
                        )}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Help Text */}
      <div className="mt-6 bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="text-sm font-medium text-blue-900 mb-2">How it works:</h3>
        <ul className="text-sm text-blue-800 space-y-1">
          <li>• <strong>Pending:</strong> User not yet synced to WhatsApp backend</li>
          <li>• <strong>Synced:</strong> User successfully synchronized</li>
          <li>• <strong>Failed:</strong> Synchronization failed (hover over status for error details)</li>
          <li>• <strong>Disabled:</strong> User excluded from automatic synchronization</li>
        </ul>
      </div>
    </div>
  );
};

export default WhatsAppUserSyncManager;