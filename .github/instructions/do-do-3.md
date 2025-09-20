Looking at the OrderDetailsModal-based Result Page code and comparing it with the current Results.tsx implementation, here are the key features that need to be added or changed:

## Missing Features from OrderDetailsModal that need to be added:

### 1. **Sample Collection Toggles**
```typescript
// Add to ManualEntryForm.tsx
const handleMarkSampleCollected = useCallback(async () => {
  const result = await markSampleCollected(order.id);
  if (result.success) {
    toast.success('Sample marked as collected');
    // Refresh UI
  }
}, [order.id]);

const handleMarkSampleNotCollected = useCallback(async () => {
  const result = await database.orders.markSampleNotCollected(order.id);
  if (result.success) {
    toast.success('Sample collection status removed');
    // Refresh UI
  }
}, [order.id]);
```

### 2. **QR Code Generation & Label Printing**
```typescript
// Add to AIUploadPanel.tsx or create new component
import QRCodeLib from 'qrcode';

const generateQRCode = async (qrData: string) => {
  try {
    const qrImage = await QRCodeLib.toDataURL(qrData, {
      width: 200,
      margin: 2,
      color: { dark: '#000000', light: '#FFFFFF' }
    });
    return qrImage;
  } catch (error) {
    console.error('QR generation failed:', error);
    return '';
  }
};

// Print label function
const printSampleLabel = (order: Order) => {
  const printWindow = window.open('', '_blank');
  if (!printWindow) return;
  
  // Generate print HTML with QR code
  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Sample Label - ${order.sample_id}</title>
        <style>
          /* Print styles from OrderDetailsModal */
        </style>
      </head>
      <body>
        <!-- Label content with QR code -->
      </body>
    </html>
  `);
  printWindow.document.close();
  printWindow.print();
};
```

### 3. **Result Audit Modal**
```typescript
// Create components/Results/ResultAudit.tsx
interface ResultAuditProps {
  orderId: string;
  onClose: () => void;
}

export const ResultAudit: React.FC<ResultAuditProps> = ({ orderId, onClose }) => {
  // Implement audit trail display
  // Show result history, modifications, timestamps, users
};
```

### 4. **Attachment Preview with Multiple File Support**
```typescript
// Update AIUploadPanel.tsx
const [attachments, setAttachments] = useState<any[]>([]);
const [activeAttachment, setActiveAttachment] = useState<any | null>(null);

// Add attachment preview section
const AttachmentPreview = ({ attachment }: { attachment: any }) => {
  if (attachment.file_type?.startsWith('image/')) {
    return <img src={attachment.file_url} alt={attachment.original_filename} />;
  }
  if (attachment.file_type === 'application/pdf') {
    return <iframe src={`${attachment.file_url}#view=FitH`} />;
  }
  return <div>Preview not available</div>;
};
```

### 5. **Per-Panel Progress Tracking**
```typescript
// Add to Results.tsx
interface TestGroupProgress {
  test_group_id: string;
  test_group_name: string;
  total_analytes: number;
  completed_analytes: number;
  completion_percentage: number;
  panel_status: 'not_started' | 'in_progress' | 'completed';
}

// Progress chip component
const ProgressChip = ({ progress }: { progress: TestGroupProgress }) => (
  <div className="flex items-center space-x-2">
    <span className="text-sm">{progress.completed_analytes}/{progress.total_analytes}</span>
    <div className="w-24 bg-gray-200 rounded-full h-2">
      <div 
        className="bg-blue-600 h-2 rounded-full"
        style={{ width: `${progress.completion_percentage}%` }}
      />
    </div>
  </div>
);
```

### 6. **Scope Selection (Order vs Test-specific)**
```typescript
// Add to AIUploadPanel.tsx
const [uploadScope, setUploadScope] = useState<'order' | 'test'>('order');
const [selectedTestId, setSelectedTestId] = useState<string>('');

// Radio buttons for scope selection
<div className="flex items-center space-x-4 mb-3">
  <label className="flex items-center text-sm">
    <input
      type="radio"
      value="order"
      checked={uploadScope === 'order'}
      onChange={(e) => setUploadScope(e.target.value as 'order' | 'test')}
    />
    <span className="ml-2">Order Level</span>
  </label>
  <label className="flex items-center text-sm">
    <input
      type="radio"
      value="test"
      checked={uploadScope === 'test'}
      onChange={(e) => setUploadScope(e.target.value as 'order' | 'test')}
    />
    <span className="ml-2">Test Specific</span>
  </label>
</div>
```

### 7. **Existing Result Display (Read-only)**
```typescript
// Add to ManualEntryForm.tsx
const [readonlyResults, setReadonlyResults] = useState<Record<string, any[]>>({});

// Fetch and display existing results
const fetchExistingResults = async (orderId: string) => {
  const { data } = await supabase
    .from('results')
    .select(`
      id, test_group_id, status,
      result_values (id, analyte_name, value, unit, reference_range, flag)
    `)
    .eq('order_id', orderId)
    .order('created_at', { ascending: false });
    
  // Group by test group
  const grouped = data?.reduce((acc, result) => {
    const key = result.test_group_id;
    if (!acc[key]) acc[key] = [];
    acc[key].push(...(result.result_values || []));
    return acc;
  }, {});
  
  setReadonlyResults(grouped || {});
};
```

### 8. **Flag Selection Dropdown**
```typescript
// Add to ManualEntryForm.tsx
const FLAG_OPTIONS = [
  { value: '', label: 'Normal' },
  { value: 'H', label: 'High' },
  { value: 'L', label: 'Low' },
  { value: 'C', label: 'Critical' }
];

// In the table row
<select
  value={value.flag || ''}
  onChange={(e) => updateFlag(index, e.target.value)}
  className="w-full px-2 py-2 border rounded"
>
  {FLAG_OPTIONS.map(option => (
    <option key={option.value} value={option.value}>
      {option.label}
    </option>
  ))}
</select>
```

## Key Changes Needed:

### 1. **Update ManualEntryForm.tsx**
- Add sample collection toggles
- Add read-only result display below editable rows
- Add flag dropdown instead of auto-calculation only
- Add progress tracking per test group
- Fix the "Save Draft" to properly map analytes by ID

### 2. **Update AIUploadPanel.tsx**
- Add scope selection (order vs test)
- Add attachment list with preview
- Fix the save path to use proper result structure
- Add QR code generation and label printing

### 3. **Create New Components**
- `ResultAudit.tsx` - Audit trail modal
- `SampleLabel.tsx` - QR code label component
- `AttachmentPreview.tsx` - File preview component

### 4. **Update Results.tsx**
- Add proper test group filtering
- Add progress tracking view
- Fix the order structure to include all needed fields
- Add proper error handling

Here's the implementation plan:

````typescript
import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { supabase } from '../../utils/supabase';

interface ResultAuditProps {
  orderId: string;
  onClose: () => void;
}

export const ResultAudit: React.FC<ResultAuditProps> = ({ orderId, onClose }) => {
  const [auditEntries, setAuditEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAuditTrail();
  }, [orderId]);

  const fetchAuditTrail = async () => {
    try {
      const { data, error } = await supabase
        .from('result_audit_trail')
        .select(`
          *,
          users (email, full_name)
        `)
        .eq('order_id', orderId)
        .order('created_at', { ascending: false });

      if (!error) {
        setAuditEntries(data || []);
      }
    } catch (error) {
      console.error('Error fetching audit trail:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-xl font-semibold">Result Audit Trail</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-6 w-6" />
          </button>
        </div>
        
        <div className="p-6 overflow-y-auto max-h-[calc(90vh-80px)]">
          {loading ? (
            <div>Loading audit trail...</div>
          ) : auditEntries.length === 0 ? (
            <div>No audit entries found</div>
          ) : (
            <div className="space-y-4">
              {auditEntries.map((entry) => (
                <div key={entry.id} className="border-l-4 border-blue-400 pl-4">
                  <div className="text-sm text-gray-600">
                    {new Date(entry.created_at).toLocaleString()}
                  </div>
                  <div className="font-medium">{entry.action}</div>
                  <div className="text-sm text-gray-700">{entry.details}</div>
                  <div className="text-xs text-gray-500">
                    By: {entry.users?.full_name || entry.users?.email || 'Unknown'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
````

````typescript
import React, { useState, useEffect } from 'react';
import { TestTube2, QrCode, Printer } from 'lucide-react';
import QRCodeLib from 'qrcode';

interface SampleTrackingProps {
  order: {
    id: string;
    patient_name: string;
    sample_id?: string;
    color_code?: string;
    color_name?: string;
    qr_code_data?: string;
    order_date: string;
    tests: string[];
  };
}

export const SampleTracking: React.FC<SampleTrackingProps> = ({ order }) => {
  const [qrCodeImage, setQrCodeImage] = useState<string>('');

  useEffect(() => {
    generateQRCode();
  }, [order.qr_code_data]);

  const generateQRCode = async () => {
    if (!order.qr_code_data) return;
    try {
      const qrImage = await QRCodeLib.toDataURL(order.qr_code_data, {
        width: 200,
        margin: 2,
        color: { dark: '#000000', light: '#FFFFFF' }
      });
      setQrCodeImage(qrImage);
    } catch (error) {
      console.error('QR generation failed:', error);
    }
  };

  const printLabel = () => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Sample QR Code - ${order.sample_id || ''}</title>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <style>
            body { font-family: Arial, sans-serif; margin: 20px; text-align: center; }
            .qr-container { border: 2px solid #000; padding: 20px; display: inline-block; margin: 20px; }
            .qr-code { width: 200px; height: 200px; margin: 10px auto; }
            .sample-info { margin-top: 20px; text-align: left; }
            .sample-info div { margin: 5px 0; }
            .color-indicator { width: 30px; height: 30px; border-radius: 50%; display: inline-block; margin-right: 10px; vertical-align: middle; border: 2px solid #333; }
            @media print { body { margin: 0; } }
          </style>
        </head>
        <body>
          <div class="qr-container">
            <h2>Sample Tracking Label</h2>
            <img src="${qrCodeImage}" alt="QR Code" class="qr-code" />
            <div class="sample-info">
              <div><strong>Sample ID:</strong> ${order.sample_id || 'N/A'}</div>
              <div><strong>Patient:</strong> ${order.patient_name}</div>
              <div><strong>Order ID:</strong> ${order.id.slice(0, 8)}</div>
              <div>
                <strong>Sample Tube:</strong> 
                <span class="color-indicator" style="background-color: ${order.color_code}"></span>
                ${order.color_name || ''}
              </div>
              <div><strong>Order Date:</strong> ${new Date(order.order_date).toLocaleDateString()}</div>
              <div><strong>Tests:</strong> ${order.tests.join(', ')}</div>
            </div>
          </div>
          <script>
            window.onload = () => {
              window.print();
              window.onafterprint = () => window.close();
            }
          </script>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  if (!order.sample_id) return null;

  return (
    <div className="bg-green-50 border border-green-200 rounded-lg p-4">
      <h3 className="text-lg font-semibold mb-4 flex items-center">
        <TestTube2 className="h-5 w-5 mr-2 text-green-600" />
        Sample Tracking Information
      </h3>
      
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="flex items-center space-x-4">
          <div
            className="w-12 h-12 rounded-full border-4 border-gray-300 flex-shrink-0"
            style={{ backgroundColor: order.color_code }}
            title={`Sample Color: ${order.color_name}`}
          />
          <div>
            <div className="text-sm font-medium text-gray-700">Sample ID</div>
            <div className="text-lg font-bold text-green-900">{order.sample_id}</div>
            <div className="text-sm text-green-700">{order.color_name} Tube</div>
          </div>
        </div>

        <div>
          <div className="text-sm font-medium text-gray-700 mb-2 flex items-center justify-between">
            <div className="flex items-center">
              <QrCode className="h-4 w-4 mr-1" />
              QR Code
            </div>
            {order.qr_code_data && (
              <button
                onClick={printLabel}
                className="flex items-center px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                <Printer className="h-3 w-3 mr-1" />
                Print Label
              </button>
            )}
          </div>
          <div className="bg-white border-2 border-green-300 rounded-lg p-4 text-center">
            {qrCodeImage ? (
              <img src={qrCodeImage} alt="Sample QR Code" className="w-32 h-32 mx-auto" />
            ) : (
              <div className="text-sm text-gray-400">No QR data</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
````

The key differences to implement:

1. **Add proper sample tracking with QR codes**
2. **Add Result Audit modal functionality**
3. **Fix the save draft/submit to use proper result structure**
4. **Add attachment preview functionality**
5. **Add per-panel progress tracking**
6. **Add scope selection for uploads**
7. **Add flag dropdown selection**
8. **Add existing result display**

These changes will make the Results page match the OrderDetailsModal functionality while maintaining the page-based layout.