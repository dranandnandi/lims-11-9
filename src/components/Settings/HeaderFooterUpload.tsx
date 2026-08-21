import React, { useState, useEffect } from 'react';
import { Upload, Eye, Trash2, FileText, AlertCircle, CheckCircle } from 'lucide-react';
import { supabase } from '../../utils/supabase';

interface HeaderFooterUploadProps {
    entityType: 'lab' | 'location' | 'account';
    entityId: string;
    entityName: string;
}

interface Attachment {
    id: string;
    file_url: string;
    file_name: string;
    created_at: string;
}

/** null = inherit from the lab / auto-detect from what has been uploaded */
type LetterheadMode = 'background' | 'header_footer' | null;

const HeaderFooterUpload: React.FC<HeaderFooterUploadProps> = ({
    entityType,
    entityId,
    entityName,
}) => {
    const [headerAttachment, setHeaderAttachment] = useState<Attachment | null>(null);
    const [footerAttachment, setFooterAttachment] = useState<Attachment | null>(null);
    const [loading, setLoading] = useState(false);
    const [uploading, setUploading] = useState<'header' | 'footer' | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    // null = inherit / auto-detect from what has been uploaded
    const [letterheadMode, setLetterheadMode] = useState<LetterheadMode>(null);
    const [savingMode, setSavingMode] = useState(false);

    const entityTable = entityType === 'location' ? 'locations' : entityType === 'account' ? 'accounts' : 'labs';
    const supportsModeOverride = entityType === 'location' || entityType === 'account';

    useEffect(() => {
        loadAttachments();
        if (supportsModeOverride) loadLetterheadMode();
    }, [entityType, entityId]);

    const loadLetterheadMode = async () => {
        const { data, error: modeError } = await supabase
            .from(entityTable)
            .select('pdf_letterhead_mode')
            .eq('id', entityId)
            .maybeSingle();

        if (modeError) {
            // Column not deployed yet - keep the selector on "inherit"
            console.warn('Could not load letterhead mode:', modeError.message);
            return;
        }
        const mode = (data as any)?.pdf_letterhead_mode;
        setLetterheadMode(mode === 'background' || mode === 'header_footer' ? mode : null);
    };

    const handleModeChange = async (mode: LetterheadMode) => {
        const previous = letterheadMode;
        setLetterheadMode(mode);
        setSavingMode(true);
        setError(null);

        const { error: updateError } = await supabase
            .from(entityTable)
            .update({ pdf_letterhead_mode: mode })
            .eq('id', entityId);

        setSavingMode(false);

        if (updateError) {
            setLetterheadMode(previous);
            setError(updateError.message || 'Failed to save letterhead style');
            return;
        }

        setSuccess('Letterhead style saved!');
        setTimeout(() => setSuccess(null), 3000);
    };

    const loadAttachments = async () => {
        setLoading(true);
        try {
            // Fetch header
            const { data: headerData, error: headerError } = await supabase
                .from('attachments')
                .select('*')
                .eq('entity_type', entityType)
                .eq('entity_id', entityId)
                .eq('attachment_type', 'header')
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (headerError) throw headerError;
            setHeaderAttachment(headerData || null);

            // Fetch footer
            const { data: footerData, error: footerError } = await supabase
                .from('attachments')
                .select('*')
                .eq('entity_type', entityType)
                .eq('entity_id', entityId)
                .eq('attachment_type', 'footer')
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (footerError) throw footerError;
            setFooterAttachment(footerData || null);
        } catch (err) {
            console.error('Error loading attachments:', err);
        } finally {
            setLoading(false);
        }
    };

    const handleFileUpload = async (
        file: File,
        type: 'header' | 'footer'
    ) => {
        setUploading(type);
        setError(null);
        setSuccess(null);

        try {
            // Validate file
            const isHtml = file.name.toLowerCase().endsWith('.html');
            const isImage = /\.(jpg|jpeg|png)$/i.test(file.name);

            if (!isHtml && !isImage) {
                setError('Only HTML or Image files (PNG, JPG) are allowed');
                setUploading(null);
                return;
            }

            if (file.size > 2 * 1024 * 1024) { // 2MB
                setError('File size must be less than 2MB');
                setUploading(null);
                return;
            }

            let publicUrlToSave = '';
            let mimeTypeToSave = 'text/html'; // We always save as HTML wrapper

            if (isHtml) {
                // Direct HTML upload
                const filePath = `${entityType}s/${entityId}/${type}.html`;
                const { error: uploadError } = await supabase.storage
                    .from('attachments')
                    .upload(filePath, file, {
                        upsert: true,
                        contentType: 'text/html',
                    });

                if (uploadError) throw uploadError;

                const { data: { publicUrl } } = supabase.storage
                    .from('attachments')
                    .getPublicUrl(filePath);

                publicUrlToSave = publicUrl;
                mimeTypeToSave = 'text/html';
            } else {
                // Image upload - Upload as raw image
                const imageExtension = file.name.split('.').pop();
                // Use a timestamp to avoid cache issues if they update image
                const imagePath = `${entityType}s/${entityId}/${type}_img_${Date.now()}.${imageExtension}`;

                // 1. Upload Image
                const { error: imgUploadError } = await supabase.storage
                    .from('attachments')
                    .upload(imagePath, file, {
                        upsert: true,
                        contentType: file.type || 'image/png'
                    });

                if (imgUploadError) throw imgUploadError;

                const { data: { publicUrl: imgUrl } } = supabase.storage
                    .from('attachments')
                    .getPublicUrl(imagePath);

                publicUrlToSave = imgUrl; // Save image URL directly
                mimeTypeToSave = file.type || 'image/png';

                // Note: We are no longer wrapping in HTML file here.
                // The backend (generate-pdf-auto) will detect image MIME type or extension and wrap it dynamically.
            }

            // Fetch Lab ID for the record
            let labId = '';
            let relatedTable = '';

            if (entityType === 'lab') {
                labId = entityId;
                relatedTable = 'labs';
            } else {
                relatedTable = entityType === 'location' ? 'locations' : 'accounts';
                const { data: entityData } = await supabase
                    .from(relatedTable)
                    .select('lab_id')
                    .eq('id', entityId)
                    .single();

                if (entityData?.lab_id) {
                    labId = entityData.lab_id;
                } else {
                    // Fallback: try to get from user session if entity lookup fails
                    // or just let it fail if not found (better than inserting bad data)
                    console.error('Could not determine lab_id for entity');
                    throw new Error('Could not determine Lab ID');
                }
            }

            // Save to database
            const { data: attachmentData, error: dbError } = await supabase
                .from('attachments')
                .upsert({
                    entity_type: entityType,
                    entity_id: entityId,
                    attachment_type: type,
                    file_url: publicUrlToSave,
                    file_name: file.name, // Keep original filename for reference
                    file_size: file.size,
                    mime_type: mimeTypeToSave,

                    // Required fields for existing schema
                    related_table: relatedTable,
                    related_id: entityId,
                    lab_id: labId,
                }, {
                    onConflict: 'entity_type,entity_id,attachment_type'
                })
                .select()
                .single();

            if (dbError) throw dbError;

            // Update state
            if (type === 'header') {
                setHeaderAttachment(attachmentData);
            } else {
                setFooterAttachment(attachmentData);
            }

            setSuccess(`${type.charAt(0).toUpperCase() + type.slice(1)} uploaded successfully!`);

            // Clear success message after 3 seconds
            setTimeout(() => setSuccess(null), 3000);

        } catch (err: any) {
            console.error('Error uploading file:', err);
            setError(err.message || 'Failed to upload file');
        } finally {
            setUploading(null);
        }
    };

    const handleDelete = async (type: 'header' | 'footer') => {
        if (!confirm(`Are you sure you want to delete the ${type}?`)) return;

        try {
            const attachment = type === 'header' ? headerAttachment : footerAttachment;
            if (!attachment) return;

            // Delete from database
            const { error: dbError } = await supabase
                .from('attachments')
                .delete()
                .eq('id', attachment.id);

            if (dbError) throw dbError;

            // Delete from storage
            const filePath = `${entityType}s/${entityId}/${type}.html`;
            await supabase.storage
                .from('attachments')
                .remove([filePath]);

            // Update state
            if (type === 'header') {
                setHeaderAttachment(null);
            } else {
                setFooterAttachment(null);
            }

            setSuccess(`${type.charAt(0).toUpperCase() + type.slice(1)} deleted successfully!`);
            setTimeout(() => setSuccess(null), 3000);

        } catch (err: any) {
            console.error('Error deleting attachment:', err);
            setError(err.message || 'Failed to delete attachment');
        }
    };

    const handlePreview = (attachment: Attachment) => {
        window.open(attachment.file_url, '_blank');
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center p-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="border-b pb-4">
                <h3 className="text-lg font-semibold text-gray-900">Report Header & Footer</h3>
                <p className="text-sm text-gray-600 mt-1">
                    Customize the header and footer for PDF reports for <strong>{entityName}</strong>
                </p>
            </div>

            {/* Error/Success Messages */}
            {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center">
                    <AlertCircle className="h-5 w-5 text-red-500 mr-3" />
                    <span className="text-red-700 text-sm">{error}</span>
                </div>
            )}

            {success && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-center">
                    <CheckCircle className="h-5 w-5 text-green-500 mr-3" />
                    <span className="text-green-700 text-sm">{success}</span>
                </div>
            )}

            {/* Letterhead style - decides how the uploaded artwork is rendered */}
            {supportsModeOverride && (
                <div className="border border-gray-200 rounded-lg p-4">
                    <h4 className="font-medium text-gray-900 mb-1">Letterhead style</h4>
                    <p className="text-xs text-gray-500 mb-3">
                        Choose whether this {entityType}'s artwork prints as one full-page letterhead
                        (like the lab default) or as separate header and footer strips.
                    </p>
                    <div className="space-y-2">
                        {([
                            {
                                value: null as LetterheadMode,
                                title: 'Auto (recommended)',
                                desc: 'Full-page letterhead if only a header is uploaded; header + footer strips once a footer is uploaded.',
                            },
                            {
                                value: 'background' as LetterheadMode,
                                title: 'Full letterhead (whole page)',
                                desc: 'The header upload is a complete A4 letterhead and is printed as the page background on every page.',
                            },
                            {
                                value: 'header_footer' as LetterheadMode,
                                title: 'Separate header & footer',
                                desc: 'Header prints as a strip at the top and footer as a strip at the bottom of every page.',
                            },
                        ]).map((option) => (
                            <label
                                key={String(option.value)}
                                className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${letterheadMode === option.value
                                    ? 'border-blue-500 bg-blue-50'
                                    : 'border-gray-200 hover:bg-gray-50'
                                    }`}
                            >
                                <input
                                    type="radio"
                                    className="mt-1"
                                    name={`letterhead-mode-${entityId}`}
                                    checked={letterheadMode === option.value}
                                    disabled={savingMode}
                                    onChange={() => handleModeChange(option.value)}
                                />
                                <span>
                                    <span className="block text-sm font-medium text-gray-800">{option.title}</span>
                                    <span className="block text-xs text-gray-500">{option.desc}</span>
                                </span>
                            </label>
                        ))}
                    </div>
                    <p className="text-xs text-gray-500 mt-3">
                        Anything not uploaded here falls back to the lab's own header/footer.
                    </p>
                </div>
            )}

            {/* Header Upload */}
            <div className="border border-gray-200 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center">
                        <FileText className="h-5 w-5 text-blue-600 mr-2" />
                        <h4 className="font-medium text-gray-900">
                            {letterheadMode === 'background' || (letterheadMode === null && !footerAttachment)
                                ? 'Header / full letterhead'
                                : 'Header'}
                        </h4>
                    </div>
                    {headerAttachment && (
                        <span className="text-xs text-gray-500">
                            Uploaded: {new Date(headerAttachment.created_at).toLocaleDateString()}
                        </span>
                    )}
                </div>

                {headerAttachment ? (
                    <div className="bg-gray-50 rounded p-3 flex items-center justify-between">
                        <div className="flex items-center">
                            <FileText className="h-4 w-4 text-gray-400 mr-2" />
                            <span className="text-sm text-gray-700">{headerAttachment.file_name}</span>
                        </div>
                        <div className="flex items-center space-x-2">
                            <button
                                onClick={() => handlePreview(headerAttachment)}
                                className="p-2 text-blue-600 hover:bg-blue-50 rounded transition-colors"
                                title="Preview"
                            >
                                <Eye className="h-4 w-4" />
                            </button>
                            <button
                                onClick={() => handleDelete('header')}
                                className="p-2 text-red-600 hover:bg-red-50 rounded transition-colors"
                                title="Delete"
                            >
                                <Trash2 className="h-4 w-4" />
                            </button>
                        </div>
                    </div>
                ) : (
                    <label className="block">
                        <input
                            type="file"
                            accept=".html,.png,.jpg,.jpeg"
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) handleFileUpload(file, 'header');
                            }}
                            className="hidden"
                            disabled={uploading === 'header'}
                        />
                        <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:border-blue-500 transition-colors">
                            {uploading === 'header' ? (
                                <div className="flex items-center justify-center">
                                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
                                    <span className="ml-2 text-sm text-gray-600">Uploading...</span>
                                </div>
                            ) : (
                                <>
                                    <Upload className="h-8 w-8 text-gray-400 mx-auto mb-2" />
                                    <p className="text-sm text-gray-600">Click to upload header file</p>
                                    <p className="text-xs text-gray-500 mt-1">Accepts: HTML, PNG, JPG (Max: 2MB)</p>
                                </>
                            )}
                        </div>
                    </label>
                )}
            </div>

            {/* Footer Upload */}
            <div className="border border-gray-200 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center">
                        <FileText className="h-5 w-5 text-blue-600 mr-2" />
                        <h4 className="font-medium text-gray-900">Footer</h4>
                    </div>
                    {footerAttachment && (
                        <span className="text-xs text-gray-500">
                            Uploaded: {new Date(footerAttachment.created_at).toLocaleDateString()}
                        </span>
                    )}
                </div>

                {footerAttachment ? (
                    <div className="bg-gray-50 rounded p-3 flex items-center justify-between">
                        <div className="flex items-center">
                            <FileText className="h-4 w-4 text-gray-400 mr-2" />
                            <span className="text-sm text-gray-700">{footerAttachment.file_name}</span>
                        </div>
                        <div className="flex items-center space-x-2">
                            <button
                                onClick={() => handlePreview(footerAttachment)}
                                className="p-2 text-blue-600 hover:bg-blue-50 rounded transition-colors"
                                title="Preview"
                            >
                                <Eye className="h-4 w-4" />
                            </button>
                            <button
                                onClick={() => handleDelete('footer')}
                                className="p-2 text-red-600 hover:bg-red-50 rounded transition-colors"
                                title="Delete"
                            >
                                <Trash2 className="h-4 w-4" />
                            </button>
                        </div>
                    </div>
                ) : (
                    <label className="block">
                        <input
                            type="file"
                            accept=".html,.png,.jpg,.jpeg"
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) handleFileUpload(file, 'footer');
                            }}
                            className="hidden"
                            disabled={uploading === 'footer'}
                        />
                        <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:border-blue-500 transition-colors">
                            {uploading === 'footer' ? (
                                <div className="flex items-center justify-center">
                                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
                                    <span className="ml-2 text-sm text-gray-600">Uploading...</span>
                                </div>
                            ) : (
                                <>
                                    <Upload className="h-8 w-8 text-gray-400 mx-auto mb-2" />
                                    <p className="text-sm text-gray-600">Click to upload footer file</p>
                                    <p className="text-xs text-gray-500 mt-1">Accepts: HTML, PNG, JPG (Max: 2MB)</p>
                                </>
                            )}
                        </div>
                    </label>
                )}
            </div>

            {/* Help Text */}
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <h5 className="font-medium text-blue-900 mb-2">Template Variables</h5>
                <p className="text-sm text-blue-800 mb-2">
                    You can use the following variables in your HTML templates:
                </p>
                <ul className="text-xs text-blue-700 space-y-1 ml-4">
                    <li><code className="bg-blue-100 px-1 rounded">{'{{LAB_NAME}}'}</code> - Lab name</li>
                    <li><code className="bg-blue-100 px-1 rounded">{'{{LAB_LOGO}}'}</code> - Lab logo URL</li>
                    <li><code className="bg-blue-100 px-1 rounded">{'{{LAB_ADDRESS}}'}</code> - Lab address</li>
                    <li><code className="bg-blue-100 px-1 rounded">{'{{LAB_PHONE}}'}</code> - Lab phone</li>
                    {entityType === 'account' && (
                        <>
                            <li><code className="bg-blue-100 px-1 rounded">{'{{ACCOUNT_NAME}}'}</code> - Account name</li>
                            <li><code className="bg-blue-100 px-1 rounded">{'{{ACCOUNT_LOGO}}'}</code> - Account logo URL</li>
                        </>
                    )}
                    {entityType === 'location' && (
                        <li><code className="bg-blue-100 px-1 rounded">{'{{LOCATION_NAME}}'}</code> - Location name</li>
                    )}
                    <li><code className="bg-blue-100 px-1 rounded">{'{{GENERATED_DATE}}'}</code> - Report generation date</li>
                </ul>
            </div>
        </div>
    );
};

export default HeaderFooterUpload;
