import React, { useEffect, useState } from 'react';
import { database } from '../../utils/supabase';
import type { SignatureSummary } from './SignatureCard';

const toBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const [, base64] = result.split(',');
      resolve(base64 || '');
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

interface SignatureEditorProps {
  signature: SignatureSummary;
  labId: string;
  apiBaseUrl?: string;
  onSuccess: () => void;
  onClose: () => void;
}

export const SignatureEditor: React.FC<SignatureEditorProps> = ({
  signature,
  labId,
  apiBaseUrl = '',
  onSuccess,
  onClose,
}) => {
  const [signatureName, setSignatureName] = useState(signature.signature_name || '');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const trimmedName = signatureName.trim();
    if (!trimmedName) {
      setError('Signature name is required');
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      if (file) {
        const base64Data = await toBase64(file);
        const response = await fetch(`${apiBaseUrl}/.netlify/functions/branding-upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            labId,
            userId: signature.user_id || signature.users?.id,
            signatureId: signature.id,
            signatureType: signature.signature_type,
            fileName: file.name,
            contentType: file.type,
            base64Data,
            assetName: trimmedName,
            usageContext: ['reports'],
          }),
        });

        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result?.success) {
          throw new Error(result?.error || 'Signature update failed');
        }
      } else if (trimmedName !== signature.signature_name) {
        const { error: updateError } = await database.userSignatures.update(signature.id, {
          signature_name: trimmedName,
        });
        if (updateError) {
          throw updateError;
        }
      }

      onSuccess();
    } catch (updateError) {
      const message = updateError instanceof Error ? updateError.message : 'Signature update failed';
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Edit signature</h2>
            <p className="mt-1 text-sm text-gray-500">Update the signature name or replace the image file.</p>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Signature name</label>
            <input
              type="text"
              value={signatureName}
              onChange={(event) => setSignatureName(event.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring"
              disabled={isSubmitting}
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              {previewUrl ? 'New signature file' : 'Current signature'}
            </label>

            {(previewUrl || signature.file_url || signature.text_signature) && (
              <div className="mb-2 overflow-hidden rounded-md border border-gray-200 bg-gray-50">
                {previewUrl || signature.file_url ? (
                  <img
                    src={previewUrl || signature.file_url}
                    alt={signatureName || 'Signature'}
                    className="h-24 w-full object-contain"
                  />
                ) : (
                  <p className="p-2 text-sm text-gray-700">{signature.text_signature}</p>
                )}
              </div>
            )}

            <label className="mt-1 mb-1 block text-sm font-medium text-gray-700">Replace signature file</label>
            <input
              type="file"
              accept="image/*"
              onChange={(event) => setFile(event.target.files?.[0] || null)}
              className="w-full text-sm"
              disabled={isSubmitting}
            />
            <p className="mt-1 text-xs text-gray-500">Leave empty to keep the current image.</p>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-70"
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Saving...' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
