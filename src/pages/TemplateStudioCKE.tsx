import React, { useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react';
import { Combobox, Transition } from '@headlessui/react';

import {
  CheckCircle2,
  Eye,
  FileCode,
  FilePlus2,
  Loader2,
  Save,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  MoreVertical,
  Settings,
  Layers,
  X,
  Image,
  Type,
  ZoomIn,
  ZoomOut,
  Maximize2,
} from 'lucide-react';

import AIStudioModal from '../components/TemplateStudio/AIStudioModal';
import CompletenessModal from '../components/TemplateStudio/CompletenessModal';
import type { TemplateAuditResult } from '../components/TemplateStudio/TemplateAIAuditModal';
import PlaceholderPicker, { PlaceholderOption } from '../components/TemplateStudio/PlaceholderPicker';
import TemplateBuilderSidebar from '../components/TemplateStudio/TemplateBuilderSidebar';
import PDFPreviewModal from '../components/TemplateStudio/PDFPreviewModal';
import { useAuth } from '../contexts/AuthContext';
import { database, supabase, LabBrandingAsset, LabUserSignature } from '../utils/supabase';
import { ensureReportRegions } from '../utils/reportTemplateRegions';
import '../styles/report-baseline.css';

type PlaceholderGroup = 'lab' | 'test' | 'patient' | 'branding' | 'signature' | 'section' | 'extras';

interface LabTemplateRecord {
  id: string;
  template_name: string;
  template_description?: string | null;
  gjs_html?: string | null;
  gjs_css?: string | null;
  template_version?: number | null;
  updated_at?: string | null;
  is_default?: boolean | null;
  category?: string | null;
  test_group_id?: string | null;
  ai_verification_status?: string | null;
  ai_verification_summary?: string | null;
  ai_verification_details?: unknown;
  ai_verification_checked_at?: string | null;
  is_interpretation_only?: boolean | null;
}

interface TestGroupOption {
  id: string;
  name: string;
  category?: string | null;
  isActive?: boolean;
}

type RawTestGroupRow = {
  id: string;
  name: string;
  category?: string | null;
  is_active?: boolean | null;
};

interface AuditTestGroup {
  id: string;
  name: string;
  analytes: Array<{
    id: string;
    name: string;
    code: string;
    unit: string | null;
    reference_range: string | null;
  }>;
}

type RawTestGroupAnalyte = {
  analytes?: {
    id?: string | null;
    name?: string | null;
    code?: string | null;
    unit?: string | null;
    reference_range?: string | null;
  } | null;
  analyte_id?: string | null;
};

const REQUIRED_PLACEHOLDERS: Record<string, string> = {
  // Patient & Order (Critical)
  patientName: '{{patientName}}',
  patientAge: '{{patientAge}}',
  patientGender: '{{patientGender}}',
  patientId: '{{patientId}}',
  registrationDate: '{{registrationDate}}',
  locationName: '{{locationName}}',
  sampleCollectedAt: '{{sampleCollectedAt}}',
  approvedAt: '{{approvedAt}}',
  referringDoctorName: '{{referringDoctorName}}',
  reportDate: '{{reportDate}}',
  orderId: '{{orderId}}',

  // Approval/Signature (At least one required)
  approverName: '{{approverName}}',
  approverRole: '{{approverRole}}',
};

const PLACEHOLDER_REGEX = /{{\s*([^{}]+)\s*}}/g;

const slugPlaceholderKey = (value: string): string =>
  value
    .replace(/{{|}}/g, '')
    .replace(/^section:/i, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const BRANDING_TYPE_LABELS: Record<LabBrandingAsset['asset_type'], string> = {
  logo: 'Logo',
  header: 'Header',
  footer: 'Footer',
  watermark: 'Watermark',
  letterhead: 'Letterhead',
};



const toTitleCase = (value: string) =>
  value
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const normalizeSearchText = (value?: string | null) =>
  (value || '').toLowerCase().replace(/\s+/g, '').trim();

const parseVariantMap = (value: unknown): Record<string, string> => {
  if (!value) {
    return {};
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.entries(parsed as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, url]) => {
          if (typeof url === 'string' && url.length) {
            acc[key] = url;
          }
          return acc;
        }, {});
      }
    } catch (err) {
      console.warn('Failed to parse variant JSON', err);
    }
    return {};
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, url]) => {
      if (typeof url === 'string' && url.length) {
        acc[key] = url;
      }
      return acc;
    }, {});
  }

  return {};
};

const CKEDITOR_VERSION = '47.1.0';
const CKEDITOR_SCRIPT_URL = `https://cdn.ckeditor.com/ckeditor5/${CKEDITOR_VERSION}/ckeditor5.umd.js`;
const CKEDITOR_PREMIUM_SCRIPT_URL = `https://cdn.ckeditor.com/ckeditor5-premium-features/${CKEDITOR_VERSION}/ckeditor5-premium-features.umd.js`;
const CKEDITOR_CSS_URL = `https://cdn.ckeditor.com/ckeditor5/${CKEDITOR_VERSION}/ckeditor5.css`;
const CKEDITOR_PREMIUM_CSS_URL = `https://cdn.ckeditor.com/ckeditor5-premium-features/${CKEDITOR_VERSION}/ckeditor5-premium-features.css`;

const resourcePromises: Record<string, Promise<void> | undefined> = {};

const ensureStylesheet = (href: string) => {
  if (typeof window === 'undefined') {
    return Promise.resolve();
  }

  if (resourcePromises[href] !== undefined) {
    return resourcePromises[href]!;
  }

  resourcePromises[href] = new Promise<void>((resolve, reject) => {
    const existing = Array.from(document.getElementsByTagName('link')).find((link) => link.href === href);
    if (existing) {
      resolve();
      return;
    }

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.crossOrigin = 'anonymous';
    link.onload = () => resolve();
    link.onerror = () => reject(new Error(`Failed to load stylesheet: ${href}`));
    document.head.appendChild(link);
  });

  return resourcePromises[href];
};

// The CDN bundles are UMD. If anything on the page has defined an AMD loader or
// CommonJS-style globals, the UMD wrapper takes that branch and never assigns
// window.CKEDITOR — the script still fires `load`, so the failure is silent.
// Hide those globals for the duration of the script execution.
const withBrowserGlobalBranch = <T,>(run: () => T): T => {
  const w = window as any;
  const stashed: Array<[string, boolean, any]> = ['define', 'module', 'exports'].map((key) => [
    key,
    key in w,
    w[key],
  ]);
  const needsGuard = stashed.some(([, present]) => present);

  if (!needsGuard) {
    return run();
  }

  stashed.forEach(([key]) => {
    delete w[key];
  });

  const restore = () => {
    stashed.forEach(([key, present, value]) => {
      if (present) {
        w[key] = value;
      } else {
        delete w[key];
      }
    });
  };

  try {
    return run();
  } finally {
    // Scripts are loaded async, but the wrapper reads these synchronously while
    // executing, so restoring on the next macrotask is late enough.
    window.setTimeout(restore, 0);
  }
};

// `@ckeditor/ckeditor5-build-classic` (used by SectionEditor, statically imported
// by several routes) runs at app boot and claims globalThis.CKEDITOR_VERSION.
// The CDN bundle then hits its `ckeditor-duplicated-modules` guard and throws
// before it exports anything, leaving a half-built window.CKEDITOR. The two
// bundles are self-contained and drive separate editors on separate screens, so
// releasing the marker before injecting the CDN script is safe here — the CDN
// bundle sets it to its own version as it initialises.
const releaseDuplicateModuleGuard = () => {
  const w = globalThis as any;
  if (w.CKEDITOR_VERSION && w.CKEDITOR_VERSION !== CKEDITOR_VERSION) {
    console.debug(
      `Releasing CKEDITOR_VERSION marker (${w.CKEDITOR_VERSION}) so the CDN bundle ${CKEDITOR_VERSION} can initialise.`
    );
    delete w.CKEDITOR_VERSION;
  }
};

const ensureScript = (src: string) => {
  if (typeof window === 'undefined') {
    return Promise.resolve();
  }

  if (resourcePromises[src] !== undefined) {
    return resourcePromises[src]!;
  }

  const promise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      // A tag may exist but still be in flight — never assume it has executed.
      if (existing.dataset.limsLoaded === 'true') {
        resolve();
      } else {
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', () => reject(new Error(`Failed to load script: ${src}`)));
        // The tag may have finished before we attached listeners (e.g. after an
        // HMR reload reset the promise cache), so do not wait on it forever.
        window.setTimeout(() => resolve(), 15000);
      }
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = () => {
      script.dataset.limsLoaded = 'true';
      resolve();
    };
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    releaseDuplicateModuleGuard();
    withBrowserGlobalBranch(() => document.head.appendChild(script));
  });

  // Do not cache a rejection forever — a transient network failure should not
  // permanently poison the editor for the rest of the session.
  resourcePromises[src] = promise.catch((err) => {
    resourcePromises[src] = undefined;
    throw err;
  });

  return resourcePromises[src]!;
};

const waitForGlobal = async (name: 'CKEDITOR' | 'CKEDITOR_PREMIUM_FEATURES', timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = (window as any)[name];
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
};

const loadCkeditorResources = async () => {
  await Promise.all([
    ensureStylesheet(CKEDITOR_CSS_URL),
    ensureStylesheet(CKEDITOR_PREMIUM_CSS_URL),
    ensureScript(CKEDITOR_SCRIPT_URL),
  ]);

  const ckeditor = await waitForGlobal('CKEDITOR');
  if (!ckeditor?.ClassicEditor) {
    throw new Error(
      `CKEditor ${CKEDITOR_VERSION} loaded from ${CKEDITOR_SCRIPT_URL} but did not expose window.CKEDITOR.ClassicEditor. ` +
        `Globals present: CKEDITOR=${typeof (window as any).CKEDITOR}, define=${typeof (window as any).define}, ` +
        `module=${typeof (window as any).module}, exports=${typeof (window as any).exports}.`
    );
  }

  // Load premium features after base script is ready (they depend on CKEDITOR being defined)
  await ensureScript(CKEDITOR_PREMIUM_SCRIPT_URL).catch(() => {
    console.warn('CKEditor premium features failed to load — premium plugins (FormatPainter, etc.) will be unavailable.');
  });
  await waitForGlobal('CKEDITOR_PREMIUM_FEATURES', 5000);
};

interface PremiumEditorConfigOptions {
  initialData: string;
  licenseKey?: string;
  aiKey?: string;
}

const buildPremiumEditorConfig = (
  options: PremiumEditorConfigOptions,
  CKEDITOR: any,
  premiumFeatures: any
) => {
  const {
    Autoformat,
    AutoImage,
    AutoLink,
    Autosave,
    BalloonToolbar,
    Bold,
    // CKBox, // Removed - requires cloud services token
    // CKBoxImageEdit, // Removed - requires cloud services token
    // CloudServices, // Removed - requires cloud services token
    Code,
    CodeBlock,
    Emoji,
    Essentials,
    FindAndReplace,
    GeneralHtmlSupport,
    Heading,
    Alignment,
    Indent,
    IndentBlock,
    Subscript,
    Superscript,
    FontFamily,
    FontSize,
    FontColor,
    FontBackgroundColor,
    HorizontalLine,
    HtmlComment,
    // HtmlEmbed, // Removed - not allowed by license
    ImageBlock,
    ImageCaption,
    ImageInline,
    ImageInsert,
    ImageInsertViaUrl,
    ImageResize,
    ImageStyle,
    ImageTextAlternative,
    ImageToolbar,
    ImageUpload,
    Italic,
    Link,
    LinkImage,
    List,
    ListProperties,
    Mention,
    PageBreak,
    Paragraph,
    PasteFromOffice,
    PictureEditing,
    RemoveFormat,
    SelectAll,
    ShowBlocks,
    SourceEditing,
    SpecialCharacters,
    SpecialCharactersEssentials,
    Table,
    TableCaption,
    TableCellProperties,
    TableColumnResize,
    TableProperties,
    TableToolbar,
    TextTransformation,
    TodoList,
    WordCount,
  } = CKEDITOR;

  const {
    AIAssistant,
    OpenAITextAdapter,
    PasteFromOfficeEnhanced,
    SourceEditingEnhanced,
    Pagination,
    TableOfContents,
    MergeFields,
    FormatPainter,
    SlashCommand,
    Template,
  } = premiumFeatures;

  const aiEnabled = Boolean(options.aiKey && AIAssistant && OpenAITextAdapter);

  const toolbarItems = [
    'alignment',
    '|',
    'undo',
    'redo',
    '|',
    'findAndReplace',
    'selectAll',
    '|',
    ...(aiEnabled ? ['aiCommands', 'aiAssistant', '|'] : []),
    'sourceEditing',
    'showBlocks',
    '|',
    'heading',
    'alignment',
    '|',
    'fontFamily',
    'fontSize',
    '|',
    'bold',
    'italic',
    'subscript',
    'superscript',
    'code',
    'removeFormat',
    '|',
    'fontColor',
    'fontBackgroundColor',
    '|',
    'emoji',
    'specialCharacters',
    'link',
    'insertImage',
    // 'ckbox', // Removed - requires cloud token
    'insertTable',
    'horizontalLine',
    'pageBreak',
    'codeBlock',
    // 'htmlEmbed', // Removed - not allowed by license
    '|',
    'bulletedList',
    'numberedList',
    'todoList',
    '|',
    'outdent',
    'indent',
  ];

  const premiumToolbarItems: string[] = [];
  if (TableOfContents) premiumToolbarItems.push('tableOfContents');
  if (MergeFields) premiumToolbarItems.push('mergeField');
  if (FormatPainter) premiumToolbarItems.push('formatPainter');
  if (premiumToolbarItems.length) {
    toolbarItems.push('|', ...premiumToolbarItems);
  }

  // Build plugins array - add premium features conditionally (only if they exist)
  const plugins = [
    Autoformat,
    AutoImage,
    AutoLink,
    Autosave,
    BalloonToolbar,
    Bold,
    // CKBox, // Removed - requires cloud services token
    // CKBoxImageEdit, // Removed - requires cloud services token
    // CloudServices, // Removed - requires cloud services token
    Code,
    CodeBlock,
    Emoji,
    Essentials,
    FindAndReplace,
    GeneralHtmlSupport,
    Heading,
    Alignment,
    Indent,
    IndentBlock,
    Subscript,
    Superscript,
    FontFamily,
    FontSize,
    FontColor,
    FontBackgroundColor,
    HorizontalLine,
    HtmlComment,
    // HtmlEmbed, // Removed - not allowed by license
    ImageBlock,
    ImageCaption,
    ImageInline,
    ImageInsert,
    ImageInsertViaUrl,
    ImageResize,
    ImageStyle,
    ImageTextAlternative,
    ImageToolbar,
    ImageUpload,
    Italic,
    Link,
    LinkImage,
    List,
    ListProperties,
    Mention,
    PageBreak,
    Paragraph,
    PasteFromOffice, // Free version
    // PasteFromOfficeEnhanced, // PREMIUM - removed
    PictureEditing,
    RemoveFormat,
    SelectAll,
    ShowBlocks,
    SourceEditing, // Free version for HTML source editing
    // SourceEditingEnhanced, // PREMIUM - removed - use SourceEditing instead
    SpecialCharacters,
    SpecialCharactersEssentials,
    Table,
    TableCaption,
    TableCellProperties,
    TableColumnResize,
    TableProperties,
    TableToolbar,
    TextTransformation,
    TodoList,
    WordCount,
  ];

  // Add premium plugins (conditionally if they exist from the bundle)
  if (PasteFromOfficeEnhanced) plugins.push(PasteFromOfficeEnhanced);
  if (SourceEditingEnhanced) plugins.push(SourceEditingEnhanced);
  if (Pagination) plugins.push(Pagination);
  if (TableOfContents) plugins.push(TableOfContents);
  if (MergeFields) plugins.push(MergeFields);
  if (FormatPainter) plugins.push(FormatPainter);
  if (SlashCommand) plugins.push(SlashCommand);
  if (Template) plugins.push(Template);

  if (aiEnabled) {
    plugins.push(AIAssistant, OpenAITextAdapter);
  }

  const config: any = {
    toolbar: {
      items: toolbarItems,
      shouldNotGroupWhenFull: true,
    },
    plugins,
    balloonToolbar: aiEnabled
      ? ['aiAssistant', '|', 'bold', 'italic', 'subscript', 'superscript', 'alignment', '|', 'link', 'insertImage', '|', 'bulletedList', 'numberedList']
      : ['bold', 'italic', 'subscript', 'superscript', 'alignment', '|', 'link', 'insertImage', '|', 'bulletedList', 'numberedList'],
    initialData: options.initialData || '',
    licenseKey: options.licenseKey || '', // Use premium license from env
    placeholder: 'Type or paste your content here!',
    htmlSupport: {
      allow: [
        {
          name: /^.*$/,
          styles: true,
          attributes: true,
          classes: true,
        },
      ],
    },
    pagination: Pagination
      ? {
        pageWidth: '210mm',
        pageHeight: '297mm',
        pageMargins: {
          top: '15mm',
          bottom: '15mm',
          left: '15mm',
          right: '15mm',
        },
      }
      : undefined,
    image: {
      toolbar: [
        'toggleImageCaption',
        'imageTextAlternative',
        '|',
        'imageStyle:inline',
        'imageStyle:wrapText',
        'imageStyle:breakText',
        '|',
        'resizeImage',
        '|',
        'alignment:left',
        'alignment:center',
        'alignment:right',
        // 'ckboxImageEdit', // Removed - requires cloud token
      ],
    },
    table: {
      contentToolbar: [
        'tableColumn',
        'tableRow',
        'mergeTableCells',
        'tableProperties',
        'tableCellProperties',
        '|',
        'alignment',
        'bold',
        'italic',
      ],
      tableProperties: {
        defaultProperties: { borderStyle: 'solid', borderColor: '#e5e7eb', borderWidth: '1px', alignment: 'center' },
      },
      tableCellProperties: {
        defaultProperties: { horizontalAlignment: 'center', padding: '4px' },
      }
    },
    link: {
      addTargetToExternalLinks: true,
      defaultProtocol: 'https://',
      decorators: {
        toggleDownloadable: {
          mode: 'manual',
          label: 'Downloadable',
          attributes: {
            download: 'file',
          },
        },
      },
    },
    list: {
      properties: {
        styles: true,
        startIndex: true,
        reversed: true,
      },
    },
    alignment: {
      options: ['left', 'center', 'right', 'justify']
    },
    fontFamily: {
      options: [
        'default',
        'Inter, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica Neue, Arial, sans-serif',
        'Arial, Helvetica, sans-serif',
        'Times New Roman, Times, serif',
        'Georgia, serif',
      ],
      supportAllValues: true,
    },
    fontSize: {
      options: [10, 12, 14, 16, 18, 20, 24],
      supportAllValues: true,
    },
    fontColor: {
      columns: 8,
      documentColors: 16,
    },
    fontBackgroundColor: {
      columns: 8,
      documentColors: 16,
    },
    indentBlock: {
      offset: 24,
      unit: 'px',
    },
    mention: {
      feeds: [
        {
          marker: '{{',
          feed: [
            '{{patientName}}',
            '{{patientAge}}',
            '{{patientGender}}',
            '{{patientDOB}}',
            '{{patientId}}',
            '{{orderId}}',
            '{{sampleId}}',
            '{{registrationDate}}',
            '{{locationName}}',
            '{{sampleCollectedAt}}',
            '{{approvedAt}}',
            '{{referringDoctorName}}',
            '{{reportDate}}',
            '{{approverSignature}}',
            '{{approvedByName}}',
            '{{approverName}}',
            '{{approverRole}}',
            '{{labName}}',
            '{{labAddress}}',
            '{{labPhone}}',
            '{{labEmail}}',
            '{{labLogoUrl}}',
            '{{qr_code}}',
            '{{verifyUrl}}',
          ],
          minimumCharacters: 0,
        },
      ],
    },
    wordCount: {
      onUpdate: (stats: any) => {
        // Word count stats available: stats.words, stats.characters
        if (typeof window !== 'undefined' && (window as any).ckeditorWordCount) {
          (window as any).ckeditorWordCount = stats;
        }
      },
    },
  };

  if (aiEnabled) {
    config.ai = {
      assistant: {
        adapter: {
          openAI: {
            requestHeaders: {
              Authorization: `Bearer ${options.aiKey}`,
            },
          },
        },
      },
    };
  }

  // Cloud Services removed - not using CKBox or real-time collaboration
  // if (options.tokenUrl) {
  //   config.cloudServices = {
  //     tokenUrl: options.tokenUrl,
  //   };
  // }

  return config;
};

const extractPlaceholders = (html: string): string[] => {
  const tokens = new Set<string>();
  if (!html) {
    return [];
  }

  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_REGEX.exec(html)) !== null) {
    const token = match[1]?.trim();
    if (token) {
      tokens.add(`{{${token}}}`);
    }
  }

  return Array.from(tokens);
};

const mapAuditStatusToVerification = (status: TemplateAuditResult['status']) => {
  switch (status) {
    case 'pass':
      return 'verified';
    case 'attention':
      return 'attention_needed';
    default:
      return 'changes_required';
  }
};

const RISKY_HTML_PATTERNS = [/<script/i, /javascript:/i, /onload\s*=/i, /onerror\s*=/i, /<iframe/i];

const hasRiskyMarkup = (html: string) => RISKY_HTML_PATTERNS.some((pattern) => pattern.test(html));

const findMissingPlaceholders = (
  beforeHtml: string,
  afterHtml: string,
  allowedRemovals: string[] = [],
  protectedPlaceholders?: string[]
): string[] => {
  const beforeSet = new Set(extractPlaceholders(beforeHtml));
  const afterSet = new Set(extractPlaceholders(afterHtml));
  const missing: string[] = [];
  const allowedSet = new Set(allowedRemovals);
  const protectedSet = protectedPlaceholders ? new Set(protectedPlaceholders) : beforeSet;

  beforeSet.forEach((token) => {
    if (!afterSet.has(token) && !allowedSet.has(token) && protectedSet.has(token)) {
      missing.push(token);
    }
  });

  return missing;
};

const buildInstructionFromAudit = (audit: TemplateAuditResult): string => {
  const lines: string[] = [];
  lines.push('Apply the audit findings to fix the lab report template.');
  if (audit.summary) {
    lines.push(`Audit summary: ${audit.summary}`);
  }

  if (audit.patientMetadata && audit.patientMetadata.missingColumns?.length) {
    lines.push(
      `Add the missing patient metadata columns: ${audit.patientMetadata.missingColumns.join(', ')} in the patient info table immediately after the header.`
    );
  }

  // Check for signature block using the updated audit schema
  if (audit.approvalSignature && audit.approvalSignature.missingSignaturePlaceholders?.length) {
    lines.push(`Add missing signature placeholders: ${audit.approvalSignature.missingSignaturePlaceholders.join(', ')}`);
  }

  if (audit.placeholders?.requiredMissing?.length) {
    lines.push(`Insert the missing required placeholders exactly as listed: ${audit.placeholders.requiredMissing.join(', ')}.`);
  }

  if (audit.placeholders?.unknownPlaceholders?.length) {
    lines.push(`Review unknown placeholders to ensure they are legitimate: ${audit.placeholders.unknownPlaceholders.join(', ')}.`);
  }

  if (audit.analyteCoverage?.referencedButUnknown?.length) {
    lines.push(
      `Remove or rename analyte placeholders not present in the linked test group: ${audit.analyteCoverage.referencedButUnknown.join(', ')}.`
    );
  }

  if (audit.analyteCoverage?.missingFromTemplate?.length) {
    lines.push(
      `Add analyte rows or placeholders for missing test group analytes: ${audit.analyteCoverage.missingFromTemplate.join(', ')}.`
    );
  }

  if (audit.recommendations?.length) {
    lines.push(`Follow these additional recommendations: ${audit.recommendations.join('; ')}.`);
  }

  lines.push('Keep all existing placeholders intact unless instructed otherwise and maintain an accessible, printable layout.');
  lines.push('Audit details (JSON):');
  lines.push(JSON.stringify(audit, null, 2));

  return lines.join('\n');
};

const TemplateStudioCKE: React.FC = () => {
  const { user, loading: authLoading } = useAuth();
  const [labId, setLabId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<LabTemplateRecord[]>([]);
  const [templateMeta, setTemplateMeta] = useState<LabTemplateRecord | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [htmlContent, setHtmlContentState] = useState('');
  const [cssContent, setCssContent] = useState('');
  const [ckeditorInstance, setCkeditorInstance] = useState<any | null>(null);
  const [labDetails, setLabDetails] = useState<any | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [editorBooting, setEditorBooting] = useState(true);
  const [metadataDraft, setMetadataDraft] = useState({
    name: '',
    description: '',
    category: 'reports',
    testGroupId: '',
    isInterpretationOnly: false,
  });
  const [metadataSaving, setMetadataSaving] = useState(false);
  const [metadataMessage, setMetadataMessage] = useState<string | null>(null);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [testGroups, setTestGroups] = useState<TestGroupOption[]>([]);
  const [testGroupsLoading, setTestGroupsLoading] = useState(false);
  const [testGroupsError, setTestGroupsError] = useState<string | null>(null);
  const [isAIStudioOpen, setIsAIStudioOpen] = useState(false);
  const [isCompletenessOpen, setIsCompletenessOpen] = useState(false);
  const [isBuilderSidebarOpen, setIsBuilderSidebarOpen] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditResult, setAuditResult] = useState<TemplateAuditResult | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditImplementing, setAuditImplementing] = useState(false);
  const [placeholderPickerOpen, setPlaceholderPickerOpen] = useState(false);
  const [placeholderOptions, setPlaceholderOptions] = useState<PlaceholderOption[]>([]);
  const [placeholderLoading, setPlaceholderLoading] = useState(false);
  const [placeholderError, setPlaceholderError] = useState<string | null>(null);
  const [isSourcePreviewOpen, setIsSourcePreviewOpen] = useState(false);
  const [sourceCopyState, setSourceCopyState] = useState<'html' | 'css' | null>(null);
  const [isA4PreviewOpen, setIsA4PreviewOpen] = useState(false);
  const [isPdfPreviewOpen, setIsPdfPreviewOpen] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const setHtmlContent = useCallback(
    (value: string) => {
      setHtmlContentState(ensureReportRegions(value || ''));
    },
    [setHtmlContentState]
  );
  const [auditSuccessMessage, setAuditSuccessMessage] = useState<string | null>(null);
  const [auditRevertSnapshot, setAuditRevertSnapshot] = useState<{ html: string; css: string } | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true); // Default to collapsed for focus mode
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);
  const [templateSearchQuery, setTemplateSearchQuery] = useState('');
  const [testGroupQuery, setTestGroupQuery] = useState('');

  // Dropdown menu states for grouped actions
  const [showToolsMenu, setShowToolsMenu] = useState(false);
  const [showAIMenu, setShowAIMenu] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [settingsPanelOpen, setSettingsPanelOpen] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(100);

  const PATIENT_PLACEHOLDER_OPTIONS: PlaceholderOption[] = useMemo(
    () => [
      { id: 'patientName', label: 'Patient Name', placeholder: '{{patientName}}', group: 'patient' },
      { id: 'patientAge', label: 'Patient Age', placeholder: '{{patientAge}}', group: 'patient' },
      { id: 'patientGender', label: 'Patient Gender', placeholder: '{{patientGender}}', group: 'patient' },
      { id: 'patientDOB', label: 'Patient Date of Birth', placeholder: '{{patientDOB}}', group: 'patient' },
      { id: 'patientId', label: 'Patient ID', placeholder: '{{patientId}}', group: 'patient' },
      { id: 'referringDoctorName', label: 'Referring Doctor Name', placeholder: '{{referringDoctorName}}', group: 'patient' },
      { id: 'registrationDate', label: 'Registration Date', placeholder: '{{registrationDate}}', group: 'patient' },
      { id: 'locationName', label: 'Location / Collection Centre', placeholder: '{{locationName}}', group: 'patient' },
      { id: 'sampleCollectedAt', label: 'Sample Collected At', placeholder: '{{sampleCollectedAt}}', group: 'patient' },
      { id: 'approvedAt', label: 'Approved / Verified At', placeholder: '{{approvedAt}}', group: 'patient' },
      { id: 'orderId', label: 'Order ID', placeholder: '{{orderId}}', group: 'patient' },
      {
        id: 'approverSignature',
        label: 'Approver Signature (Dynamic)',
        placeholder: '{{approverSignature}}',
        group: 'signature',
        assetType: 'signature',
        preferredWidth: 160,
        preferredHeight: 55,
      },
      { id: 'approvedByName', label: 'Approved By Name', placeholder: '{{approvedByName}}', group: 'patient' },
      { id: 'approverName', label: 'Approver Name', placeholder: '{{approverName}}', group: 'patient' },
      { id: 'approverRole', label: 'Approver Role', placeholder: '{{approverRole}}', group: 'patient' },
    ],
    []
  );

  const LAB_META_PLACEHOLDER_OPTIONS: PlaceholderOption[] = useMemo(
    () => [
      { id: 'labName', label: 'Lab Name', placeholder: '{{labName}}', group: 'lab' },
      { id: 'labAddress', label: 'Lab Address', placeholder: '{{labAddress}}', group: 'lab' },
      { id: 'labPhone', label: 'Lab Phone', placeholder: '{{labPhone}}', group: 'lab' },
      { id: 'labEmail', label: 'Lab Email', placeholder: '{{labEmail}}', group: 'lab' },
      { id: 'labWebsite', label: 'Lab Website', placeholder: '{{labWebsite}}', group: 'lab' },
      { id: 'labLogoUrl', label: 'Lab Logo URL', placeholder: '{{labLogoUrl}}', group: 'lab' },
      { id: 'labSignatureImageUrl', label: 'Signature Image URL', placeholder: '{{labSignatureImageUrl}}', group: 'lab' },
    ],
    []
  );

  // Section content placeholders (doctor-filled content)
    const SECTION_PLACEHOLDER_OPTIONS: PlaceholderOption[] = useMemo(
      () => [
        { id: 'impression', label: 'Impression / Interpretation Summary', placeholder: '{{impression}}', group: 'section' },
        { id: 'findings', label: 'Findings / Observations', placeholder: '{{findings}}', group: 'section' },
        { id: 'conclusion', label: 'Conclusion', placeholder: '{{conclusion}}', group: 'section' },
        { id: 'recommendation', label: 'Recommendation / Suggestions', placeholder: '{{recommendation}}', group: 'section' },
        { id: 'clinical_history', label: 'Clinical History', placeholder: '{{clinical_history}}', group: 'section' },
        { id: 'technique', label: 'Technique / Methodology', placeholder: '{{technique}}', group: 'section' },
        { id: 'methodology', label: 'Methodology (Alias)', placeholder: '{{methodology}}', group: 'section' },
        { id: 'comments', label: 'Comments / Notes', placeholder: '{{comments}}', group: 'section' },
      ],
      []
    );

  // Signatory placeholders
  const SIGNATORY_PLACEHOLDER_OPTIONS: PlaceholderOption[] = useMemo(
    () => [
      {
        id: 'approverSignature',
        label: 'Approver Signature Image',
        placeholder: '{{approverSignature}}',
        group: 'signature',
        assetType: 'signature',
        preferredWidth: 160,
        preferredHeight: 55,
      },
      { id: 'approverName', label: 'Approver Name (Signatory)', placeholder: '{{approverName}}', group: 'signature' },
      { id: 'approvedByName', label: 'Approved By Name', placeholder: '{{approvedByName}}', group: 'signature' },
      { id: 'approverRole', label: 'Approver Role/Title', placeholder: '{{approverRole}}', group: 'signature' },
    ],
    []
  );

  const REPORT_EXTRAS_PLACEHOLDER_OPTIONS: PlaceholderOption[] = useMemo(
    () => [
      { id: 'qr_code', label: 'QR Code (Verification)', placeholder: '{{qr_code}}', group: 'extras' },
      { id: 'verifyUrl', label: 'Verification URL', placeholder: '{{verifyUrl}}', group: 'extras' },
    ],
    []
  );

  const DEFAULT_PLACEHOLDER_OPTIONS: PlaceholderOption[] = useMemo(
    () => [
      ...LAB_META_PLACEHOLDER_OPTIONS,
      ...PATIENT_PLACEHOLDER_OPTIONS,
      ...SECTION_PLACEHOLDER_OPTIONS,
      ...SIGNATORY_PLACEHOLDER_OPTIONS,
      ...REPORT_EXTRAS_PLACEHOLDER_OPTIONS,
    ],
    [LAB_META_PLACEHOLDER_OPTIONS, PATIENT_PLACEHOLDER_OPTIONS, SECTION_PLACEHOLDER_OPTIONS, SIGNATORY_PLACEHOLDER_OPTIONS, REPORT_EXTRAS_PLACEHOLDER_OPTIONS]
  );

  const filteredTestGroups = useMemo(() => {
    if (testGroupQuery === '') return testGroups;
    return testGroups.filter((group) =>
      group.name.toLowerCase().replace(/\s+/g, '').includes(testGroupQuery.toLowerCase().replace(/\s+/g, ''))
    );
  }, [testGroups, testGroupQuery]);

  const filteredTemplates = useMemo(() => {
    const searchLower = normalizeSearchText(templateSearchQuery);
    if (!searchLower) {
      return templates;
    }

    return templates.filter((template) => {
      const templateName = normalizeSearchText(template.template_name || 'Untitled Template');
      const templateDescription = normalizeSearchText(template.template_description || '');
      const templateCategory = normalizeSearchText(template.category || '');
      return (
        templateName.includes(searchLower) ||
        templateDescription.includes(searchLower) ||
        templateCategory.includes(searchLower)
      );
    });
  }, [templates, templateSearchQuery]);

  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const editorInstanceRef = useRef<any>(null);
  const htmlRef = useRef(htmlContent);
  const cssRef = useRef(cssContent);

  const ckeditorLicenseKey = import.meta.env.VITE_CKEDITOR_LICENSE_KEY as string | undefined;
  // const ckeditorTokenUrl = import.meta.env.VITE_CKEDITOR_TOKEN_URL as string | undefined; // Removed - not using cloud services
  const ckeditorAiApiKey = import.meta.env.VITE_CKEDITOR_AI_API_KEY as string | undefined;

  useEffect(() => {
    htmlRef.current = htmlContent;
  }, [htmlContent]);

  useEffect(() => {
    cssRef.current = cssContent;
  }, [cssContent]);

  useEffect(() => {
    if (isLoading || editorInstanceRef.current || typeof window === 'undefined') {
      return;
    }

    let isMounted = true;
    setEditorBooting(true);

    const waitForContainer = async () => {
      let attempts = 0;
      while (isMounted && !editorContainerRef.current && attempts < 40) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        attempts += 1;
      }

      if (!isMounted || !editorContainerRef.current) {
        throw new Error('Editor container not ready');
      }

      return editorContainerRef.current;
    };

    const initialiseEditor = async () => {
      try {
        await loadCkeditorResources();
        await waitForContainer();

        if (!isMounted || !editorContainerRef.current) {
          return;
        }

        const globalObject = window as unknown as {
          CKEDITOR?: any;
          CKEDITOR_PREMIUM_FEATURES?: any;
        };

        const CKEDITOR = globalObject.CKEDITOR;
        const premiumFeatures = globalObject.CKEDITOR_PREMIUM_FEATURES || {}; // Optional - use empty object if not available

        if (!CKEDITOR?.ClassicEditor) {
          throw new Error('CKEditor is not available on window.');
        }

        const editorConfig = buildPremiumEditorConfig(
          {
            initialData: htmlRef.current,
            licenseKey: ckeditorLicenseKey || '', // Use premium license from env
            // tokenUrl removed - not using cloud services
            aiKey: ckeditorAiApiKey,
          },
          CKEDITOR,
          premiumFeatures
        );

        const editor = await CKEDITOR.ClassicEditor.create(editorContainerRef.current, editorConfig);

        editor.editing.view.change((writer: any) => {
          const root = editor.editing.view.document.getRoot();
          writer.setStyle('min-height', '560px', root);
          writer.addClass('limsv2-report', root);
        });

        editor.model.document.on('change:data', () => {
          const data = editor.getData();
          if (htmlRef.current !== data) {
            htmlRef.current = data;
            setHtmlContent(data);
          }
        });

        editorInstanceRef.current = editor;
        setCkeditorInstance(editor);
        setEditorBooting(false);
      } catch (err) {
        console.error('Failed to initialise CKEditor premium editor:', err);
        if (isMounted) {
          setEditorBooting(false);
          setError(
            `Unable to load the premium editor. Please refresh and try again or contact support. (${
              err instanceof Error ? err.message : String(err)
            })`
          );
        }
      }
    };

    initialiseEditor();

    return () => {
      isMounted = false;
      const instance = editorInstanceRef.current;
      if (instance && typeof instance.destroy === 'function') {
        instance.destroy().catch((destroyErr: unknown) => {
          console.warn('Failed to cleanly destroy CKEditor instance:', destroyErr);
        });
      }
      editorInstanceRef.current = null;
    };
  }, [ckeditorAiApiKey, ckeditorLicenseKey, isLoading, selectedTemplateId]);

  // Toggle CKEditor toolbar visibility
  useEffect(() => {
    const toolbarElement = document.querySelector('.ck-editor__top');
    if (toolbarElement) {
      if (toolbarCollapsed) {
        toolbarElement.classList.add('toolbar-collapsed');
      } else {
        toolbarElement.classList.remove('toolbar-collapsed');
      }

      // Add close button to toolbar if not already present
      if (!toolbarElement.querySelector('.toolbar-close-btn')) {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'toolbar-close-btn';
        closeBtn.innerHTML = toolbarCollapsed ? '⬆️ Show' : '⬇️ Hide';
        closeBtn.title = toolbarCollapsed ? 'Show toolbar' : 'Hide toolbar';
        closeBtn.style.cssText = `
          position: absolute;
          top: 8px;
          right: 10px;
          background: #fee;
          border: 1px solid #fcc;
          border-radius: 4px;
          padding: 4px 10px;
          font-size: 11px;
          font-weight: 600;
          color: #c00;
          cursor: pointer;
          z-index: 10000;
          font-family: system-ui, -apple-system, sans-serif;
          transition: all 0.2s;
        `;
        closeBtn.onmouseenter = () => {
          closeBtn.style.background = '#fcc';
          closeBtn.style.borderColor = '#faa';
        };
        closeBtn.onmouseleave = () => {
          closeBtn.style.background = '#fee';
          closeBtn.style.borderColor = '#fcc';
        };
        closeBtn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          setToolbarCollapsed(prev => !prev);
        };
        toolbarElement.appendChild(closeBtn);
      } else {
        // Update existing button text
        const btn = toolbarElement.querySelector('.toolbar-close-btn') as HTMLButtonElement;
        if (btn) {
          btn.innerHTML = toolbarCollapsed ? '⬆️ Show' : '⬇️ Hide';
          btn.title = toolbarCollapsed ? 'Show toolbar' : 'Hide toolbar';
        }
      }
    }
  }, [toolbarCollapsed, ckeditorInstance]);

  const fetchAvailablePlaceholderOptions = useCallback(async (): Promise<PlaceholderOption[]> => {
    const aggregated: PlaceholderOption[] = [...LAB_META_PLACEHOLDER_OPTIONS];
    let addedSectionPlaceholders = false;

    if (labId) {
      try {
        const loadLabAnalytes = !templateMeta?.test_group_id;
        const [labParamsResult, brandingResult, signatureResult] = await Promise.all([
          loadLabAnalytes ? database.templateParameters.listLabParameters(labId) : Promise.resolve({ data: [], error: null }),
          (database as any).labBrandingAssets.getAll(labId),
          (database as any).userSignatures.getAll(user?.id, labId),
        ]);

        if (labParamsResult.error) {
          console.warn('Lab parameter fetch failed:', labParamsResult.error);
        } else if (labParamsResult.data?.length) {
          aggregated.push(
            ...(labParamsResult.data as any[]).map((item) => ({
              ...item,
              group: 'lab' as const,
            }))
          );
        }

        if (brandingResult.error) {
          console.warn('Branding asset fetch failed:', brandingResult.error);
        } else if (brandingResult.data?.length) {
          const byType = new Map<LabBrandingAsset['asset_type'], LabBrandingAsset>();

          (brandingResult.data as any[]).forEach((asset) => {
            if (!asset || !asset.file_url) {
              return;
            }
            const current = byType.get(asset.asset_type);
            if (!current || asset.is_default) {
              byType.set(asset.asset_type, asset);
            }
          });

          byType.forEach((asset, assetType) => {
            const friendlyType = BRANDING_TYPE_LABELS[assetType] || toTitleCase(assetType);
            const baseLabel = `Branding · ${friendlyType}`;
            const variantMap = parseVariantMap(asset.variants);
            const optimizedUrl = variantMap.optimized || asset.file_url;

            if (!optimizedUrl) {
              return;
            }

            const shouldConstrainWidth = assetType === 'header' || assetType === 'footer' || assetType === 'watermark';
            aggregated.push({
              id: `branding-${asset.id}-${variantMap.optimized ? 'optimized' : 'preferred'}`,
              label: `${baseLabel} (${variantMap.optimized ? 'Optimized' : 'Original'})`,
              placeholder: optimizedUrl,
              group: 'branding',
              assetType,
              variantKey: variantMap.optimized ? 'optimized' : 'original',
              preferredWidth: shouldConstrainWidth ? 1000 : null,
              preferredHeight: null,
              removeBackground: assetType === 'watermark',
            });
          });
        }

        if (signatureResult.error) {
          console.warn('Signature fetch failed:', signatureResult.error);
        } else if (signatureResult.data?.length) {
          const signatures = signatureResult.data as LabUserSignature[];
          const defaultSignature = signatures.find((sig) => sig.is_default) || signatures[0];

          if (defaultSignature) {
            const friendlyName = defaultSignature.signature_name || 'Signature';
            const baseLabel = `Signature · ${friendlyName}`;

            if (defaultSignature.file_url) {
              const variants = parseVariantMap(defaultSignature.variants);
              const optimizedSignature = variants.optimized || defaultSignature.file_url;

              aggregated.push({
                id: `signature-${defaultSignature.id}-${variants.optimized ? 'optimized' : 'preferred'}`,
                label: `${baseLabel} (${variants.optimized ? 'Optimized' : 'Original'})`,
                placeholder: optimizedSignature,
                group: 'signature',
                assetType: 'signature',
                variantKey: variants.optimized ? 'optimized' : 'original',
                preferredWidth: 200,
                preferredHeight: 200,
                removeBackground: true,
              });
            }

            if (defaultSignature.text_signature) {
              aggregated.push({
                id: `signature-${defaultSignature.id}-text`,
                label: `${baseLabel} (Text)`,
                placeholder: defaultSignature.text_signature,
                group: 'signature',
              });
            }
          }
        }
      } catch (err) {
        console.error('Failed to gather lab placeholders', err);
      }

      if (templateMeta?.test_group_id) {
        const { data: sectionRows, error: sectionError } = await database.templateSections.getByTestGroup(
          templateMeta.test_group_id
        );

        if (sectionError) {
          console.warn('Template section fetch failed:', sectionError);
        } else if (sectionRows?.length) {
          const sectionPlaceholders = sectionRows
            .filter((section: any) => section?.placeholder_key)
            .flatMap((section: any) => {
              const rawKey = String(section.placeholder_key || '').trim();
              const cleanKey = rawKey
                .replace(/^{{\s*/, '')
                .replace(/\s*}}$/, '')
                .replace(/^section:/i, '')
                .trim();
              const sectionKey = slugPlaceholderKey(cleanKey || rawKey);
              const token = `{{${sectionKey || cleanKey || rawKey}}}`;
              const label = section.section_name || toTitleCase(sectionKey || cleanKey || rawKey.replace(/{{|}}/g, '')) || 'Report Section';
              const options: PlaceholderOption[] = [{
                id: `section-${section.id || rawKey}`,
                label,
                placeholder: token,
                group: 'section' as const,
              }];

              const rawConfig = section.section_config;
              const sectionConfig = typeof rawConfig === 'string'
                ? (() => {
                  try {
                    return JSON.parse(rawConfig);
                  } catch {
                    return null;
                  }
                })()
                : rawConfig;
              const cascadeLevels = Array.isArray(sectionConfig?.cascade_levels)
                ? sectionConfig.cascade_levels
                : [];

              const addCascadeLevelPlaceholders = (levels: any[]) => {
                levels.forEach((level: any) => {
                  const levelKey = slugPlaceholderKey(level?.label || level?.id || '');
                  if (sectionKey && levelKey) {
                    options.push({
                      id: `section-${section.id || rawKey}-${level.id || levelKey}`,
                      label: `${label} - ${level.label || toTitleCase(levelKey)}`,
                      placeholder: `{{${sectionKey}_${levelKey}}}`,
                      group: 'section',
                    });
                  }

                  (level?.options || []).forEach((option: any) => {
                    if (Array.isArray(option?.sub_levels)) {
                      addCascadeLevelPlaceholders(option.sub_levels);
                    }
                  });
                });
              };

              addCascadeLevelPlaceholders(cascadeLevels);
              return options;
            });

          if (sectionPlaceholders.length) {
            aggregated.push(...sectionPlaceholders);
            addedSectionPlaceholders = true;
          }
        }

        const { data: testParams, error: testError } = await database.templateParameters.listTestGroupParameters(
          templateMeta.test_group_id
        );
        if (testError) {
          console.warn('Test group parameter fetch failed:', testError);
        } else if (testParams?.length) {
          console.log('Raw testParams from API:', testParams);
          const mappedParams = testParams.flatMap((item: any) => {
            const base = {
              ...item,
              group: 'test' as const,
            };

            // Main value placeholder (already includes _VALUE suffix from API)
            const mainOption = { ...base };

            const valueType = (item.valueType || '').toString().toLowerCase();
            const isDescriptive = ['qualitative', 'semi_quantitative', 'descriptive'].includes(valueType);

            // Use placeholderBase if available (new ANALYTE_CODE pattern), otherwise extract from placeholder
            // The main placeholder is already {{ANALYTE_CODE_VALUE}}, so we need the base without _VALUE
            const basePlaceholderName = item.placeholderBase
              ? item.placeholderBase
              : base.placeholder.replace(/^{{|_VALUE}}$|}}$/g, '');

            // Generate variations matching backend RPC pattern:
            // _UNIT, _REFERENCE (not _REF_RANGE), _FLAG
            const variations = isDescriptive
              ? []
              : [
                { suffix: '_UNIT', labelSuffix: 'Unit', sample: item.unit },
                { suffix: '_REFERENCE', labelSuffix: 'Reference', sample: item.referenceRange },
                { suffix: '_FLAG', labelSuffix: 'Flag', sample: 'High/Low' },
                { suffix: '_METHOD', labelSuffix: 'Method', sample: item.method || 'Photometry' },
              ];

            const extras = variations.map((v) => ({
              ...base,
              id: `${base.id}${v.suffix}`,
              label: `${base.label} (${v.labelSuffix})`,
              placeholder: `{{${basePlaceholderName}${v.suffix}}}`,
              unit: v.suffix === '_UNIT' ? item.unit : null,
              referenceRange: v.suffix === '_REFERENCE' ? item.referenceRange : null,
            }));

            return [mainOption, ...extras];
          });
          console.log('Mapped testParams with group and variations:', mappedParams);
          aggregated.push(...mappedParams);
        }
      }
    }

    if (!templateMeta?.test_group_id && !addedSectionPlaceholders) {
      aggregated.push(...SECTION_PLACEHOLDER_OPTIONS);
    }

    aggregated.push(...PATIENT_PLACEHOLDER_OPTIONS);

    console.log('Aggregated before deduplication:', aggregated);
    console.log('Test group items before dedup:', aggregated.filter(o => o.group === 'test'));

    const uniqueByPlaceholder = new Map<string, PlaceholderOption>();
    aggregated.forEach((option) => {
      const existing = uniqueByPlaceholder.get(option.placeholder);
      if (!existing) {
        uniqueByPlaceholder.set(option.placeholder, option);
        return;
      }

      // If groups differ, prioritize: test > lab > others
      if (existing.group !== option.group) {
        let finalGroup: PlaceholderGroup;
        if (option.group === 'test' || existing.group === 'test') {
          finalGroup = 'test'; // Test group takes highest priority
        } else if (option.group === 'lab' || existing.group === 'lab') {
          finalGroup = 'lab'; // Lab takes second priority
        } else {
          finalGroup = option.group || existing.group || 'lab';
        }

        uniqueByPlaceholder.set(option.placeholder, {
          ...existing,
          group: finalGroup,
        });
      }
    });

    const finalOptions = Array.from(uniqueByPlaceholder.values());
    console.log('Final options after dedup:', finalOptions);
    console.log('Test group items after dedup:', finalOptions.filter(o => o.group === 'test'));
    return finalOptions;
  }, [
    LAB_META_PLACEHOLDER_OPTIONS,
    PATIENT_PLACEHOLDER_OPTIONS,
    REPORT_EXTRAS_PLACEHOLDER_OPTIONS,
    SECTION_PLACEHOLDER_OPTIONS,
    labId,
    templateMeta?.test_group_id,
    user?.id,
  ]);

  const loadPlaceholderOptions = useCallback(async () => {
    setPlaceholderLoading(true);
    setPlaceholderError(null);

    try {
      const options = await fetchAvailablePlaceholderOptions();
      setPlaceholderOptions(options);
    } catch (err) {
      console.error('Placeholder option fetch failed:', err);
      setPlaceholderOptions(DEFAULT_PLACEHOLDER_OPTIONS);
      setPlaceholderError('Unable to load lab/test placeholders. Showing default placeholder set instead.');
    } finally {
      setPlaceholderLoading(false);
    }
  }, [DEFAULT_PLACEHOLDER_OPTIONS, fetchAvailablePlaceholderOptions]);

  useEffect(() => {
    if (!placeholderPickerOpen && !isBuilderSidebarOpen) {
      return;
    }
    loadPlaceholderOptions().catch((err) => {
      console.warn('Placeholder loader rejected:', err);
    });
  }, [loadPlaceholderOptions, placeholderPickerOpen, isBuilderSidebarOpen]);

  // Reload placeholder options when template or test_group_id changes
  useEffect(() => {
    if ((placeholderPickerOpen || isBuilderSidebarOpen) && templateMeta?.id) {
      loadPlaceholderOptions().catch((err) => {
        console.warn('Placeholder reload on template change failed:', err);
      });
    }
  }, [templateMeta?.test_group_id, templateMeta?.id, placeholderPickerOpen, isBuilderSidebarOpen, loadPlaceholderOptions]);

  useEffect(() => {
    const editor = editorInstanceRef.current;
    if (!editor || typeof editor.getData !== 'function' || typeof editor.setData !== 'function') {
      return;
    }

    const currentData = editor.getData();
    if (currentData !== htmlContent) {
      editor.setData(htmlContent || '');
    }
  }, [htmlContent]);

  const handleInsertPlaceholder = useCallback(
    (option: PlaceholderOption) => {
      const instance = ckeditorInstance || editorInstanceRef.current;
      if (!instance) {
        setPlaceholderError('Editor is not ready yet. Try again in a moment.');
        return;
      }

      const token = option.placeholder;
      if (!token || typeof token !== 'string') {
        setPlaceholderError('Selected placeholder did not include any content to insert.');
        return;
      }

      const isImagePlaceholder = option.group === 'branding' || option.group === 'signature';

      try {
        instance.model.change((writer: any) => {
          const selection = instance.model.document.selection;

          if (isImagePlaceholder) {
            const attributes: Record<string, string> = {
              src: token,
              alt: option.label || 'Lab asset',
            };

            const styleSegments: string[] = [];

            if (option.preferredWidth) {
              const constrainedWidth = Math.max(option.preferredWidth, 1);
              attributes.width = String(constrainedWidth);
              styleSegments.push(`width:${constrainedWidth}px`, `max-width:${constrainedWidth}px`);
              if (!option.preferredHeight) {
                styleSegments.push('height:auto');
              }
            }

            if (option.preferredHeight) {
              const constrainedHeight = Math.max(option.preferredHeight, 1);
              attributes.height = String(constrainedHeight);
              styleSegments.push(`height:${constrainedHeight}px`);
            }

            if (option.preferredWidth || option.preferredHeight) {
              styleSegments.push('object-fit:contain');
            }

            if (option.removeBackground) {
              styleSegments.push('background:none transparent', 'background-image:none');
            }

            // Add background layer styling for watermarks
            if (option.assetType === 'watermark') {
              styleSegments.push(
                'position:absolute',
                'top:50%',
                'left:50%',
                'transform:translate(-50%, -50%)',
                'z-index:1',
                'opacity:0.15',
                'pointer-events:none'
              );
            }

            if (!option.preferredWidth && !option.preferredHeight) {
              styleSegments.push('max-width:100%', 'height:auto');
            }

            if (styleSegments.length) {
              attributes.style = Array.from(new Set(styleSegments)).join(';');
            }

            const imageElement = writer.createElement('imageBlock', attributes);
            instance.model.insertContent(imageElement, selection);
            return;
          }

          // For QR code placeholder, insert as a visual block
          // The wrapper div is stripped by the edge function after {{qr_code}} is rendered
          if (token === '{{qr_code}}') {
            const qrHtml = `<div class="qr-verify" data-lims-placeholder="qr_code" style="display:inline-block;border:2px dashed #aaa;border-radius:4px;padding:6px;text-align:center;min-width:70px;min-height:70px;background:#f5f5f5;vertical-align:bottom;">{{qr_code}}</div>`;
            const viewFragment = instance.data.processor.toView(qrHtml);
            const modelFragment = instance.data.toModel(viewFragment);
            instance.model.insertContent(modelFragment, selection);
          // For signature placeholders, insert as image tag instead of plain text
          } else if (token === '{{approverSignature}}' || token === '{{approvedBySignature}}') {
            const imgHtml = `<img class="ck-signature-img" src="${token}" alt="Approver Signature" width="160" height="55" style="display:block;width:160px;max-width:160px;height:55px;object-fit:contain;" onerror="this.style.visibility='hidden'" />`;
            const viewFragment = instance.data.processor.toView(imgHtml);
            const modelFragment = instance.data.toModel(viewFragment);
            instance.model.insertContent(modelFragment, selection);
          } else {
            const insertPosition = selection.getFirstPosition();
            if (insertPosition) {
              writer.insertText(token, insertPosition);
            } else {
              const textNode = writer.createText(token);
              instance.model.insertContent(textNode, selection);
            }
          }
        });

        // Do NOT close picker — keep open so user can fill next table cell
        setPlaceholderError(null);
      } catch (err) {
        console.error('Failed to insert placeholder:', err);
        setPlaceholderError('Unable to insert placeholder. Click inside a table cell in the editor first, then click a placeholder button.');
      }
    },
    [ckeditorInstance]
  );

  const handleCopySource = useCallback(
    async (variant: 'html' | 'css') => {
      const value = variant === 'html' ? htmlContent : cssContent;
      try {
        await navigator.clipboard.writeText(value || '');
        setSourceCopyState(variant);
        window.setTimeout(() => setSourceCopyState(null), 2000);
      } catch (err) {
        console.warn('Failed to copy source', err);
        setSourceCopyState(null);
      }
    },
    [cssContent, htmlContent]
  );

  const handleConvertToWatermark = useCallback(() => {
    const instance = ckeditorInstance || editorInstanceRef.current;
    if (!instance) {
      alert('Editor is not ready');
      return;
    }

    try {
      instance.model.change((writer: any) => {
        const selection = instance.model.document.selection;
        const selectedElement = selection.getSelectedElement();

        if (!selectedElement || !selectedElement.is('element', 'imageBlock')) {
          alert('Please select an image first to convert it to a watermark');
          return;
        }

        // Apply watermark styling
        const watermarkStyles = [
          'position:absolute',
          'top:50%',
          'left:50%',
          'transform:translate(-50%, -50%)',
          'z-index:1',
          'opacity:0.15',
          'pointer-events:none',
          'max-width:80%',
          'height:auto',
          'background:none transparent',
          'background-image:none'
        ].join(';');

        writer.setAttribute('style', watermarkStyles, selectedElement);
        writer.setAttribute('class', 'report-watermark', selectedElement);

        alert('✅ Image converted to watermark background layer!\n\nThe image now has:\n• Low opacity (15%)\n• Centered position\n• Behind content (z-index: 1)\n• Content will appear above it (z-index: 3)');
      });
    } catch (err) {
      console.error('Failed to convert to watermark:', err);
      alert('Failed to apply watermark styling. Please try again.');
    }
  }, [ckeditorInstance]);

  const handleAddImageOverlay = useCallback(() => {
    const instance = ckeditorInstance || editorInstanceRef.current;
    if (!instance) {
      alert('Editor is not ready');
      return;
    }

    try {
      const selection = instance.model.document.selection;
      const selectedElement = selection.getSelectedElement();

      if (!selectedElement || !selectedElement.is('element', 'imageBlock')) {
        alert('Please select an image first to add text overlay');
        return;
      }

      const overlayText = prompt('Enter the text to display over the image:', 'Sample Overlay Text');
      if (!overlayText) return;

      const imageUrl = selectedElement.getAttribute('src');

      // Create HTML with image and overlay text
      const overlayHtml = `
        <div style="position:relative;display:inline-block;max-width:100%;">
          <img src="${imageUrl}" style="display:block;width:100%;height:auto;" />
          <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10;background:rgba(0,0,0,0.6);color:white;padding:12px 24px;border-radius:8px;font-size:18px;font-weight:bold;text-align:center;white-space:nowrap;">
            ${overlayText}
          </div>
        </div>
      `;

      instance.model.change((writer: any) => {
        // Convert HTML to CKEditor model
        const viewFragment = instance.data.processor.toView(overlayHtml);
        const modelFragment = instance.data.toModel(viewFragment);

        // Replace the selected image with the overlay container
        const parent = selectedElement.parent;
        const index = parent.getChildIndex(selectedElement);

        writer.remove(selectedElement);
        writer.insert(modelFragment, parent, index);
      });

      alert('✅ Text overlay added to image!\n\nYou can edit the HTML to customize:\n• Text content\n• Colors\n• Position\n• Background\n• Font size');
    } catch (err) {
      console.error('Failed to add image overlay:', err);
      alert('Failed to add overlay. Please try again.');
    }
  }, [ckeditorInstance]);

  // Handle HTML generated from report upload
  const handleReportUploadGenerated = useCallback((html: string, matchedAnalytes: string[], notes: string) => {
    const instance = ckeditorInstance || editorInstanceRef.current;
    if (!instance) {
      // Fallback: set directly to state
      setHtmlContent(html);
      setSaveMessage(`Template generated from report. ${matchedAnalytes.length} analytes matched.`);
      return;
    }

    try {
      // Set the HTML content in the editor
      instance.setData(html);
      setHtmlContent(html);
      setSaveMessage(`Template generated from report. ${matchedAnalytes.length} analytes matched. Review and save when ready.`);
    } catch (err) {
      console.error('Failed to apply generated HTML:', err);
      // Fallback: set directly to state
      setHtmlContent(html);
      setSaveMessage('Template generated. Review and save when ready.');
    }
  }, [ckeditorInstance, setHtmlContent]);

  const identityId = user?.id;

  useEffect(() => {
    let isActive = true;

    const bootstrap = async () => {
      if (!identityId) {
        if (isActive) {
          setIsLoading(false);
          setTemplateMeta(null);
        }
        return;
      }

      try {
        if (isActive) {
          setIsLoading(true);
          setError(null);
        }

        const currentLabId = await database.getCurrentUserLabId();

        if (!isActive) {
          return;
        }

        if (!currentLabId) {
          setLabId(null);
          setTemplateMeta(null);
          setError('Unable to determine lab context for your account. Please contact support.');
          return;
        }

        setLabId(currentLabId);

        const { data: templateRows, error: templatesError } = await database.labTemplates.list(currentLabId);
        console.log('📋 Template fetch result:', { templateRows, templatesError, currentLabId });
        if (templatesError) {
          throw templatesError;
        }

        const normalizedTemplates = (templateRows || []) as LabTemplateRecord[];
        console.log('📋 Normalized templates:', normalizedTemplates);
        let templateRecord = (normalizedTemplates.find((tpl) => tpl.is_default) || normalizedTemplates[0]) as
          | LabTemplateRecord
          | undefined;

        if (!templateRecord) {
          const { data: createdTemplate, error: createError } = await database.labTemplates.create({
            labId: currentLabId,
            name: 'Default Lab Template',
            description: 'Auto-generated default template for this lab.',
            category: 'reports',
          });

          if (createError || !createdTemplate) {
            throw createError || new Error('Template creation failed');
          }

          templateRecord = createdTemplate as LabTemplateRecord;
          normalizedTemplates.push(templateRecord);
        }

        if (!isActive) {
          return;
        }

        setTemplates(normalizedTemplates);
        setTemplateMeta(templateRecord);
        setSelectedTemplateId(templateRecord?.id || null);
        setHtmlContent(templateRecord?.gjs_html || '');
        setCssContent(templateRecord?.gjs_css || '');
        setLastSavedAt(templateRecord?.updated_at ? new Date(templateRecord.updated_at) : null);
        setSaveError(null);
      } catch (err) {
        console.error('Failed to initialize CKEditor Template Studio:', err);
        if (isActive) {
          setTemplateMeta(null);
          setError('Unable to load or create a lab template. Please try again or contact support.');
        }
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    };

    if (!authLoading) {
      bootstrap();
    }

    return () => {
      isActive = false;
    };
  }, [authLoading, identityId]);

  useEffect(() => {
    if (!saveMessage) {
      return;
    }

    const timer = window.setTimeout(() => setSaveMessage(null), 4000);
    return () => window.clearTimeout(timer);
  }, [saveMessage]);

  useEffect(() => {
    if (!metadataMessage) {
      return;
    }

    const timer = window.setTimeout(() => setMetadataMessage(null), 4000);
    return () => window.clearTimeout(timer);
  }, [metadataMessage]);

  useEffect(() => {
    if (!templateMeta) {
      setMetadataDraft({
        name: '',
        description: '',
        category: 'reports',
        testGroupId: '',
        isInterpretationOnly: false,
      });
      setAuditResult(null);
      return;
    }

    setMetadataDraft({
      name: templateMeta.template_name || '',
      description: templateMeta.template_description || '',
      category: templateMeta.category || 'reports',
      testGroupId: templateMeta.test_group_id || '',
      isInterpretationOnly: templateMeta.is_interpretation_only ?? false,
    });

    if (templateMeta.ai_verification_details) {
      if (typeof templateMeta.ai_verification_details === 'string') {
        try {
          const parsed = JSON.parse(templateMeta.ai_verification_details) as TemplateAuditResult;
          setAuditResult(parsed);
        } catch (err) {
          console.warn('Failed to parse stored AI verification details:', err);
          setAuditResult(null);
        }
      } else {
        setAuditResult(templateMeta.ai_verification_details as TemplateAuditResult);
      }
    } else {
      setAuditResult(null);
    }
  }, [templateMeta]);

  useEffect(() => {
    if (!labId) {
      setTestGroups([]);
      return;
    }

    // Fetch Lab Details for Preview
    const fetchLabDetails = async () => {
      try {
        const { data, error } = await supabase
          .from('labs')
          .select('name, address, phone, email')
          .eq('id', labId)
          .single();

        if (data) {
          setLabDetails(data);
        }
      } catch (err) {
        console.warn('Failed to fetch lab details for preview:', err);
      }
    };
    fetchLabDetails();

    let isActive = true;

    const fetchTestGroups = async () => {
      setTestGroupsLoading(true);
      setTestGroupsError(null);

      const { data, error: testGroupError } = await database.testGroups.listByLab(labId);

      if (!isActive) {
        return;
      }

      if (testGroupError) {
        console.error('Failed to load test groups for CKEditor Template Studio:', testGroupError);
        setTestGroupsError('Unable to load test groups. Linking is temporarily unavailable.');
        setTestGroups([]);
      } else {
        const rawGroups = Array.isArray(data) ? (data as RawTestGroupRow[]) : [];
        const mapped = rawGroups.map((group) => ({
          id: group.id,
          name: group.name,
          category: group.category ?? null,
          isActive: group.is_active ?? true,
        }));
        setTestGroups(mapped);
      }

      setTestGroupsLoading(false);
    };

    fetchTestGroups();

    return () => {
      isActive = false;
    };
  }, [labId]);

  const verificationStatusBadge = useMemo(() => {
    const status = templateMeta?.ai_verification_status;
    if (!status) {
      return null;
    }

    const map: Record<string, { label: string; classes: string }> = {
      verified: {
        label: 'AI Verified',
        classes: 'border border-emerald-200 bg-emerald-50 text-emerald-700',
      },
      attention_needed: {
        label: 'Needs Attention',
        classes: 'border border-amber-200 bg-amber-50 text-amber-700',
      },
      changes_required: {
        label: 'Requires Changes',
        classes: 'border border-red-200 bg-red-50 text-red-700',
      },
      pass: {
        label: 'AI Pass',
        classes: 'border border-emerald-200 bg-emerald-50 text-emerald-700',
      },
      attention: {
        label: 'Needs Attention',
        classes: 'border border-amber-200 bg-amber-50 text-amber-700',
      },
      fail: {
        label: 'Requires Changes',
        classes: 'border border-red-200 bg-red-50 text-red-700',
      },
    };

    return map[status] || {
      label: status,
      classes: 'border border-gray-200 bg-gray-100 text-gray-700',
    };
  }, [templateMeta?.ai_verification_status]);

  const editorAdapter = useMemo(
    () => ({
      getHtml: () => {
        const instance = editorInstanceRef.current || ckeditorInstance;
        return instance?.getData?.() ?? htmlRef.current;
      },
      getCss: () => cssRef.current,
      setComponents: (value: string) => {
        setHtmlContent(value);
        const instance = editorInstanceRef.current || ckeditorInstance;
        if (instance?.setData) {
          instance.setData(value);
        } else {
          htmlRef.current = value;
        }
      },
      setStyle: (value: string) => {
        setCssContent(value || '');
      },
    }),
    [ckeditorInstance, setHtmlContent, setCssContent]
  );

  const handleTemplateSelect = useCallback(
    (templateId: string) => {
      console.log('🔄 Template select triggered:', templateId);
      const template = templates.find((tpl) => tpl.id === templateId);
      console.log('📄 Found template:', template?.template_name);
      if (!template) {
        console.warn('❌ Template not found for ID:', templateId);
        return;
      }

      // Get the HTML content
      const htmlContent = template.gjs_html || '';
      console.log('💾 Loading HTML content (length):', htmlContent.length);

      // Update all state - React will remount editor due to key change
      setSelectedTemplateId(templateId);
      setTemplateMeta(template);
      setHtmlContent(htmlContent);
      setCssContent(template.gjs_css || '');
      htmlRef.current = htmlContent;
      cssRef.current = template.gjs_css || '';

      setLastSavedAt(template?.updated_at ? new Date(template.updated_at) : null);
      setSaveMessage(null);
      setSaveError(null);
      setAuditSuccessMessage(null);
      setAuditRevertSnapshot(null);

      console.log('✅ Template state updated, editor will remount');
    },
    [templates, setHtmlContent, setCssContent]
  );

  const handleCreateTemplate = useCallback(async () => {
    if (!labId) {
      return;
    }

    const timestamp = new Date().toISOString().slice(0, 10);
    const baseName = `New Template ${timestamp}`;
    const existingNames = new Set(
      templates
        .map((tpl) => tpl.template_name?.trim().toLowerCase())
        .filter((name): name is string => Boolean(name))
    );

    let candidateName = baseName;
    let suffix = 2;
    while (existingNames.has(candidateName.trim().toLowerCase())) {
      candidateName = `${baseName} (${suffix})`;
      suffix += 1;
    }

    try {
      const { data, error: createError } = await database.labTemplates.create({
        labId,
        name: candidateName,
        description: 'New template created from CKEditor Template Studio',
        category: 'reports',
      });

      if (createError || !data) {
        throw createError || new Error('Unable to create template');
      }

      const createdTemplate = data as LabTemplateRecord;
      setTemplates((prev) => [...prev, createdTemplate]);
      setSelectedTemplateId(createdTemplate.id);
      setTemplateMeta(createdTemplate);
      setHtmlContent(createdTemplate.gjs_html || '');
      setCssContent(createdTemplate.gjs_css || '');
      const instance = editorInstanceRef.current || ckeditorInstance;
      if (instance?.setData) {
        instance.setData(createdTemplate.gjs_html || '');
      }
      setLastSavedAt(createdTemplate.updated_at ? new Date(createdTemplate.updated_at) : null);
      setSaveMessage(null);
      setSaveError(null);
    } catch (createErr) {
      console.error('Failed to create template:', createErr);
      const duplicateName =
        createErr && typeof createErr === 'object' && 'code' in createErr && (createErr as { code?: string }).code === '23505';
      setSaveError(
        duplicateName
          ? 'A template with the same name already exists. Please rename the existing template or try again.'
          : 'Unable to create a new template right now. Please try again later.'
      );
    }
  }, [ckeditorInstance, labId, templates]);

  const handleSave = useCallback(async () => {
    if (!templateMeta) {
      return;
    }

    if (!labId) {
      setSaveError('Lab context missing. Please reload and try again.');
      return;
    }

    const instance = editorInstanceRef.current || ckeditorInstance;
    const currentHtml = instance?.getData?.() ?? htmlContent;
    const currentCss = cssContent;

    setIsSaving(true);
    setSaveError(null);
    setSaveMessage(null);

    try {
      const { data, error: saveErrorResponse } = await database.labTemplates.saveProject({
        templateId: templateMeta.id,
        labId,
        project: null,
        html: currentHtml,
        css: currentCss,
        components: null,
        styles: null,
        userId: identityId ?? null,
      });

      if (saveErrorResponse || !data) {
        throw saveErrorResponse || new Error('Save failed');
      }

      const savedTemplate = data as LabTemplateRecord;
      setTemplateMeta(savedTemplate);
      setTemplates((prev) => prev.map((tpl) => (tpl.id === savedTemplate.id ? savedTemplate : tpl)));
      setLastSavedAt(savedTemplate.updated_at ? new Date(savedTemplate.updated_at) : new Date());
      setSaveMessage('Template saved successfully.');
      setSaveError(null);
    } catch (err) {
      console.error('Failed to save template:', err);
      setSaveError('Unable to save the template. Please try again.');
    } finally {
      setIsSaving(false);
    }
  }, [ckeditorInstance, cssContent, htmlContent, identityId, labId, templateMeta]);

  const handleMetadataSave = useCallback(async () => {
    if (!templateMeta) {
      return;
    }

    setMetadataSaving(true);
    setMetadataError(null);
    setMetadataMessage(null);

    try {
      const { data, error: updateError } = await database.labTemplates.updateMetadata({
        templateId: templateMeta.id,
        labId: labId || undefined,
        name: metadataDraft.name,
        description: metadataDraft.description,
        category: metadataDraft.category,
        testGroupId: metadataDraft.testGroupId || null,
        isInterpretationOnly: metadataDraft.isInterpretationOnly,
        userId: identityId ?? null,
      });

      if (updateError || !data) {
        throw updateError || new Error('Metadata update failed');
      }

      const updatedTemplate = data as LabTemplateRecord;
      setTemplateMeta(updatedTemplate);
      setTemplates((prev) => prev.map((tpl) => (tpl.id === updatedTemplate.id ? updatedTemplate : tpl)));
      setMetadataMessage('Template details updated.');
    } catch (err) {
      console.error('Failed to update template metadata:', err);
      setMetadataError('Unable to update template details. Please try again.');
    } finally {
      setMetadataSaving(false);
    }
  }, [identityId, labId, metadataDraft, templateMeta]);

  const handleRunAudit = useCallback(async () => {
    if (auditLoading) {
      return;
    }

    if (!labId) {
      setAuditError('Lab context missing. Please reload and try again.');
      setIsCompletenessOpen(true);
      return;
    }

    if (!templateMeta) {
      setAuditError('Template is not ready. Select a template and try again.');
      setIsCompletenessOpen(true);
      return;
    }

    const instance = editorInstanceRef.current || ckeditorInstance;
    const html = instance?.getData?.() ?? htmlContent;
    const css = cssContent;

    if (!html.trim()) {
      setAuditError('Template is empty. Add content before running the audit.');
      setIsCompletenessOpen(true);
      return;
    }

    setIsCompletenessOpen(true);
    setAuditLoading(true);
    setAuditError(null);
    setAuditSuccessMessage(null);

    const placeholders = extractPlaceholders(html);

    let availablePlaceholderCatalog = placeholderOptions;
    if (!availablePlaceholderCatalog.length) {
      try {
        availablePlaceholderCatalog = await fetchAvailablePlaceholderOptions();
      } catch (catalogError) {
        console.warn('Placeholder catalog fetch for audit failed:', catalogError);
        availablePlaceholderCatalog = DEFAULT_PLACEHOLDER_OPTIONS;
      }
    }

    const auditPlaceholderCatalog = Array.from(
      new Map(
        availablePlaceholderCatalog
          .filter((option) => {
            const group = option.group ?? 'lab';
            // Only include patient, test, and signature groups
            // Explicitly exclude branding (header/footer) and lab details
            return ['patient', 'test', 'signature', 'section'].includes(group);
          })
          .map((option) => [
            option.placeholder,
            {
              placeholder: option.placeholder,
              label: option.label,
              group: option.group ?? 'lab',
              unit: option.unit ?? null,
              referenceRange: option.referenceRange ?? null,
            },
          ])
      ).values()
    );

    let normalizedTestGroup: AuditTestGroup | null = null;

    if (templateMeta.test_group_id) {
      const { data: testGroupData, error: testGroupError } = await database.testGroups.getById(templateMeta.test_group_id);
      if (testGroupError) {
        console.warn('Failed to load linked test group for audit:', testGroupError);
      } else if (testGroupData) {
        const raw = testGroupData as {
          id: string;
          name: string;
          test_group_analytes?: RawTestGroupAnalyte[];
        };
        const analytes = Array.isArray(raw.test_group_analytes) ? raw.test_group_analytes : [];
        normalizedTestGroup = {
          id: raw.id,
          name: raw.name,
          analytes: analytes.map((entry) => ({
            id: entry.analytes?.id ?? entry.analyte_id ?? '',
            name: entry.analytes?.name ?? '',
            code: entry.analytes?.code ?? '',
            unit: entry.analytes?.unit ?? null,
            reference_range: entry.analytes?.reference_range ?? null,
          })),
        };
      }
    }

    try {
      const endpoint = import.meta.env.VITE_TEMPLATE_AUDIT_ENDPOINT || '/.netlify/functions/template-audit';

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          templateName: templateMeta.template_name || 'Template',
          labId,
          html,
          css,
          placeholders,
          availablePlaceholders: auditPlaceholderCatalog,
          requiredPlaceholders: REQUIRED_PLACEHOLDERS,
          testGroup: normalizedTestGroup,
        }),
      });

      const rawText = await response.text();

      if (!response.ok) {
        let errorMessage = 'Audit request failed.';
        try {
          const parsed = rawText ? JSON.parse(rawText) : null;
          errorMessage = parsed?.error || errorMessage;
        } catch (parseErr) {
          console.warn('Failed to parse audit error payload:', parseErr);
        }
        throw new Error(errorMessage);
      }

      let payload: unknown = {};
      try {
        payload = rawText ? JSON.parse(rawText) : {};
      } catch (error) {
        console.error('Audit response parse error:', error);
        throw new Error('Audit response was not valid JSON.');
      }

      const payloadWithAudit = payload as { audit?: TemplateAuditResult };
      const auditPayload: TemplateAuditResult = payloadWithAudit.audit || (payload as TemplateAuditResult);
      setAuditResult(auditPayload);

      try {
        const verificationStatus = mapAuditStatusToVerification(auditPayload.status);
        const { data: updatedTemplate, error: verificationError } = await database.labTemplates.updateVerification({
          templateId: templateMeta.id,
          labId,
          status: verificationStatus,
          summary: auditPayload.summary,
          details: auditPayload,
          checkedAt: new Date().toISOString(),
          userId: identityId ?? null,
        });

        if (verificationError) {
          throw verificationError;
        }

        if (updatedTemplate) {
          setTemplateMeta(updatedTemplate as LabTemplateRecord);
          setTemplates((prev) => prev.map((tpl) => (tpl.id === templateMeta.id ? (updatedTemplate as LabTemplateRecord) : tpl)));
        }
      } catch (verificationErr) {
        console.error('Audit completed but failed to save verification status:', verificationErr);
        setAuditError('Audit completed but storing the verification status failed. Please try again.');
      }
    } catch (err) {
      console.error('AI audit failed:', err);
      const message = err instanceof Error ? err.message : 'Unexpected error during audit. Please try again.';
      setAuditError(message);
    } finally {
      setAuditLoading(false);
    }
  }, [
    DEFAULT_PLACEHOLDER_OPTIONS,
    auditLoading,
    ckeditorInstance,
    fetchAvailablePlaceholderOptions,
    htmlContent,
    cssContent,
    identityId,
    labId,
    placeholderOptions,
    templateMeta,
  ]);

  const handleImplementAudit = useCallback(async () => {
    if (auditImplementing) {
      return;
    }

    if (!auditResult) {
      setAuditError('Run an audit before implementing changes.');
      setIsCompletenessOpen(true);
      return;
    }

    const instance = editorInstanceRef.current || ckeditorInstance;
    const currentHtml = instance?.getData?.() ?? htmlContent;
    const currentCss = cssContent;

    if (!currentHtml.trim()) {
      setAuditError('Template is empty. Add content before implementing fixes.');
      setIsCompletenessOpen(true);
      return;
    }

    setAuditImplementing(true);
    setAuditError(null);
    setAuditSuccessMessage(null);

    const instruction = buildInstructionFromAudit(auditResult);

    try {
      const endpoint = import.meta.env.VITE_TEMPLATE_AI_ENDPOINT || '/.netlify/functions/template-editor';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          templateName: templateMeta?.template_name || 'Template',
          instruction,
          prompt: instruction,
          html: currentHtml,
          css: currentCss,
          labId: labId ?? '',
          labContext: labId ?? '',
          history: [
            {
              role: 'user',
              content: 'System generated instructions based on audit findings. Apply these updates precisely.',
            },
          ],
        }),
      });

      const rawText = await response.text();
      let payload: unknown = {};

      try {
        payload = rawText ? JSON.parse(rawText) : {};
      } catch (error) {
        console.error('AI implementation response parse error:', error);
        throw new Error('AI implementation response was not valid JSON.');
      }

      if (!response.ok) {
        const payloadWithError = payload as { error?: string };
        const errorMessage = payloadWithError.error || rawText || 'AI implementation request failed.';
        throw new Error(errorMessage);
      }

      const payloadWithContent = payload as { html?: unknown; css?: unknown };
      const nextHtml = typeof payloadWithContent.html === 'string' ? payloadWithContent.html : '';
      const nextCss = typeof payloadWithContent.css === 'string' ? payloadWithContent.css : '';

      if (!nextHtml.trim()) {
        throw new Error('AI response did not include HTML to apply.');
      }

      if (hasRiskyMarkup(nextHtml)) {
        throw new Error('AI response blocked due to unsafe markup (scripts or inline handlers).');
      }

      const allowedRemovals = [
        ...(auditResult.analyteCoverage?.referencedButUnknown || []),
        ...(auditResult.placeholders?.unknownPlaceholders || []),
      ];
      const protectedPlaceholders = Array.from(new Set(Object.values(REQUIRED_PLACEHOLDERS)));
      const missingPlaceholders = findMissingPlaceholders(currentHtml, nextHtml, allowedRemovals, protectedPlaceholders);

      // Apply changes even if placeholders are missing - let user fix in next audit
      let warningMessage = '';
      if (missingPlaceholders.length) {
        warningMessage = ` ⚠️ Warning: Some required placeholders were removed: ${missingPlaceholders.join(', ')}. Please review and fix in the next audit cycle.`;
        console.warn('AI removed required placeholders:', missingPlaceholders);
      }

      setAuditRevertSnapshot({ html: currentHtml, css: currentCss });
      setHtmlContent(nextHtml);
      setCssContent(nextCss || '');
      if (instance?.setData) {
        instance.setData(nextHtml);
      }

      setSaveMessage(`AI changes applied in the editor. Remember to save the template.${warningMessage}`);

      await handleRunAudit();

      setAuditSuccessMessage('AI changes applied. The audit was rerun with the updated template.');
    } catch (err) {
      console.error('Failed to implement audit recommendations:', err);
      setAuditError(err instanceof Error ? err.message : 'Unable to implement audit recommendations.');
    } finally {
      setAuditImplementing(false);
    }
  }, [
    auditImplementing,
    auditResult,
    ckeditorInstance,
    cssContent,
    handleRunAudit,
    htmlContent,
    labId,
    templateMeta?.template_name,
  ]);

  const handleRevertAuditImplementation = useCallback(() => {
    if (!auditRevertSnapshot) {
      return;
    }

    setHtmlContent(auditRevertSnapshot.html || '');
    setCssContent(auditRevertSnapshot.css || '');
    const instance = editorInstanceRef.current || ckeditorInstance;
    if (instance?.setData) {
      instance.setData(auditRevertSnapshot.html || '');
    }
    setAuditSuccessMessage('Reverted the last AI implementation.');
    setAuditError(null);
    setAuditRevertSnapshot(null);
  }, [auditRevertSnapshot, ckeditorInstance]);

  const handleDeleteTemplate = useCallback(async () => {
    if (!selectedTemplateId || !labId) {
      return;
    }

    setIsDeleting(true);
    try {
      const { error } = await database.labTemplates.delete(selectedTemplateId);

      if (error) {
        console.error('Failed to delete template:', error);
        alert('Failed to delete template. Please try again.');
        return;
      }

      // Refresh templates list
      const { data: updatedTemplates } = await database.labTemplates.list(labId);
      setTemplates(updatedTemplates || []);

      // Clear current template if it was deleted
      if (updatedTemplates && updatedTemplates.length > 0) {
        const firstTemplate = updatedTemplates[0];
        setSelectedTemplateId(firstTemplate.id);
        await handleTemplateSelect(firstTemplate.id);
      } else {
        // No templates left, clear everything
        setSelectedTemplateId(null);
        setTemplateMeta(null);
        setHtmlContent('');
        setCssContent('');
        setMetadataDraft({ name: '', description: '', category: '', testGroupId: '', isInterpretationOnly: false });
      }

      setIsDeleteConfirmOpen(false);
    } catch (err) {
      console.error('Unexpected error deleting template:', err);
      alert('An unexpected error occurred. Please try again.');
    } finally {
      setIsDeleting(false);
    }
  }, [selectedTemplateId, labId, handleTemplateSelect]);

  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading CKEditor Template Studio…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-xl rounded-md border border-red-200 bg-red-50 px-4 py-6 text-center text-sm text-red-700">
        {error}
      </div>
    );
  }

  const attachedTestGroup = templateMeta?.test_group_id
    ? testGroups.find((group) => group.id === templateMeta.test_group_id) || null
    : null;

  return (
    <div className="flex h-screen w-full flex-col bg-white overflow-hidden">
      <style>{`
        :root {
          --ck-z-default: 100;
          --ck-z-modal: 999999;
        }
        .ck-balloon-panel,
        .ck-dropdown__panel,
        .ck-body-wrapper {
          z-index: 999999 !important;
        }
        /* Custom scrollbar for main content */
        main::-webkit-scrollbar {
          width: 12px;
          height: 12px;
        }
        main::-webkit-scrollbar-track {
          background: #e5e7eb;
          border-radius: 6px;
        }
        main::-webkit-scrollbar-thumb {
          background: #6b7280;
          border-radius: 6px;
          border: 2px solid #e5e7eb;
        }
        main::-webkit-scrollbar-thumb:hover {
          background: #4b5563;
        }
        main::-webkit-scrollbar-corner {
          background: #e5e7eb;
        }
        /* Force horizontal scrollbar visibility */
        main {
          overflow-x: auto !important;
          overflow-y: auto !important;
        }
        /* CKEditor container should stretch with the layout */
        .ck-editor {
          width: 100% !important;
          min-width: 0 !important;
        }
        .ck-editor__main {
          width: 100% !important;
          min-width: 0 !important;
          overflow: visible !important;
        }
        .ck-content {
          width: 100% !important;
          max-width: 100% !important;
          min-width: 0 !important;
          overflow: visible !important;
        }
        /* Ensure the editor container participates in flex sizing */
        .editor-wrapper {
          width: 100%;
          min-width: 0;
          display: block;
        }
        /* Make CKEditor toolbar sticky */
        .ck-editor__top {
          position: sticky !important;
          top: 0 !important;
          z-index: 1000 !important;
          background: white !important;
          border-bottom: 1px solid #e5e7eb !important;
          transition: transform 0.3s ease, opacity 0.3s ease !important;
        }
        /* Hide toolbar when collapsed */
        .ck-editor__top.toolbar-collapsed {
          transform: translateY(-100%) !important;
          opacity: 0 !important;
          pointer-events: none !important;
        }
        /* Make toolbar wrap in multiple rows */
        .ck-toolbar {
          flex-wrap: wrap !important;
          max-height: none !important;
        }
        .ck-toolbar__items {
          flex-wrap: wrap !important;
        }
        /* Toolbar toggle button */
        .toolbar-toggle-btn {
          position: fixed;
          top: 10px;
          right: 10px;
          z-index: 1002;
          background: white;
          border: 1px solid #d1d5db;
          border-radius: 6px;
          padding: 6px 12px;
          font-size: 11px;
          font-weight: 600;
          color: #374151;
          cursor: pointer;
          box-shadow: 0 1px 3px rgba(0,0,0,0.1);
          transition: all 0.2s;
        }
        .toolbar-toggle-btn:hover {
          background: #f3f4f6;
          border-color: #9ca3af;
        }
        /* Style placeholders in editor for better readability */
        .ck-content td,
        .ck-content th {
          word-break: break-word !important;
          overflow-wrap: break-word !important;
        }
        /* Make placeholder text smaller and wrap in table cells */
        .ck-content td:has(span:only-child),
        .ck-content td span {
          font-size: 11px !important;
          line-height: 1.3 !important;
          word-break: break-all !important;
        }
        /* Highlight placeholders with subtle background */
        .ck-content td:has([data-placeholder]),
        .ck-content td > span:first-child:last-child {
          background-color: #fef3c7 !important;
          padding: 2px 4px !important;
          border-radius: 2px !important;
          font-family: 'Courier New', monospace !important;
        }

      `}</style>
      {/* Compact Header - Single Row */}
      <div className="shrink-0 border-b border-gray-200 bg-white px-4 py-2 w-full">
        <div className="flex items-center justify-between gap-4">
          {/* Left: Template Selector */}
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center gap-2">
              <Layers className="h-5 w-5 text-blue-600 shrink-0" />
              <div className="flex flex-col gap-1 min-w-[240px]">
                <input
                  type="text"
                  value={templateSearchQuery}
                  onChange={(event) => setTemplateSearchQuery(event.target.value)}
                  placeholder="Search templates (e.g., tsh)..."
                  className="w-full rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <select
                  value={selectedTemplateId || ''}
                  onChange={(event) => handleTemplateSelect(event.target.value)}
                  className="text-sm font-semibold text-gray-900 bg-transparent border-0 focus:ring-0 cursor-pointer pr-8 max-w-[250px] truncate"
                >
                  {filteredTemplates.length > 0 ? (
                    filteredTemplates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.template_name || 'Untitled Template'}
                      </option>
                    ))
                  ) : (
                    <option value="" disabled>
                      No templates found
                    </option>
                  )}
                </select>
              </div>
            </div>
            {verificationStatusBadge ? (
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${verificationStatusBadge.classes}`}>
                <CheckCircle2 className="h-3 w-3" />
                {verificationStatusBadge.label}
              </span>
            ) : null}
            {lastSavedAt && (
              <span className="text-[10px] text-gray-400 hidden md:inline">
                Saved {lastSavedAt.toLocaleTimeString()}
              </span>
            )}
          </div>

          {/* Center: Primary Actions */}
          <div className="flex items-center gap-1.5 text-xs">
            {/* Save Button - Always visible */}
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 font-medium text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-emerald-400"
            >
              <Save className="h-3.5 w-3.5" />
              {isSaving ? 'Saving…' : 'Save'}
            </button>

            {/* Preview Button */}
            <button
              type="button"
              onClick={() => setIsPdfPreviewOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-orange-200 bg-orange-50 px-3 py-1.5 font-medium text-orange-700 transition hover:bg-orange-100"
            >
              <Eye className="h-3.5 w-3.5" />
              Preview
            </button>

            {/* Zoom Controls */}
            <div className="flex items-center gap-1 px-2 border-l border-gray-200 ml-1">
              <button
                type="button"
                onClick={() => setZoomLevel(Math.max(50, zoomLevel - 25))}
                className="p-1 hover:bg-gray-100 rounded text-gray-500 transition-colors"
                title="Zoom Out"
              >
                <ZoomOut className="h-4 w-4" />
              </button>
              <span className="text-[10px] font-bold text-gray-500 min-w-[32px] text-center">
                {zoomLevel}%
              </span>
              <button
                type="button"
                onClick={() => setZoomLevel(Math.min(200, zoomLevel + 25))}
                className="p-1 hover:bg-gray-100 rounded text-gray-500 transition-colors"
                title="Zoom In"
              >
                <ZoomIn className="h-4 w-4" />
              </button>
            </div>

            {/* Tools Dropdown */}
            <div className="relative">
              <button
                type="button"
                onClick={() => { setShowToolsMenu(!showToolsMenu); setShowAIMenu(false); setShowMoreMenu(false); }}
                className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 font-medium text-gray-700 transition hover:bg-gray-50"
              >
                <Settings className="h-3.5 w-3.5" />
                Tools
                <ChevronDown className="h-3 w-3" />
              </button>
              {showToolsMenu && (
                <div className="absolute top-full left-0 mt-1 w-48 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1">
                  <button onClick={() => { setPlaceholderPickerOpen(true); setShowToolsMenu(false); }} className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2">
                    <Layers className="h-4 w-4 text-gray-500" /> Placeholders
                  </button>
                  <button onClick={() => { setIsSourcePreviewOpen(true); setShowToolsMenu(false); }} className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2">
                    <FileCode className="h-4 w-4 text-gray-500" /> View Source
                  </button>
                  <button onClick={() => { handleConvertToWatermark(); setShowToolsMenu(false); }} className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2">
                    <Image className="h-4 w-4 text-gray-500" /> Send to Background
                  </button>
                  <button onClick={() => { handleAddImageOverlay(); setShowToolsMenu(false); }} className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2">
                    <Type className="h-4 w-4 text-gray-500" /> Add Text Overlay
                  </button>
                  <div className="border-t border-gray-100 my-1" />
                  <button onClick={() => { setToolbarCollapsed((v) => !v); setShowToolsMenu(false); }} className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50">
                    {toolbarCollapsed ? '▲ Show Editor Toolbar' : '▼ Hide Editor Toolbar'}
                  </button>
                </div>
              )}
            </div>

            {/* AI Dropdown */}
            <div className="relative">
              <button
                type="button"
                onClick={() => { setShowAIMenu(!showAIMenu); setShowToolsMenu(false); setShowMoreMenu(false); }}
                className="inline-flex items-center gap-1 rounded-md border border-purple-300 bg-purple-50 px-3 py-1.5 font-medium text-purple-700 transition hover:bg-purple-100"
              >
                <Sparkles className="h-3.5 w-3.5" />
                AI
                <ChevronDown className="h-3 w-3" />
              </button>
              {showAIMenu && (
                <div className="absolute top-full left-0 mt-1 w-52 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1">
                  <button onClick={() => { setIsBuilderSidebarOpen(true); setShowAIMenu(false); }} className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-blue-500" /> Template Builder
                  </button>
                  <button onClick={() => { setIsAIStudioOpen(true); setShowAIMenu(false); }} className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-indigo-500" /> AI Studio
                  </button>
                  <div className="border-t border-gray-100 my-1" />
                  <button onClick={() => { setIsCompletenessOpen(true); setShowAIMenu(false); }} className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2">
                    <Wand2 className="h-4 w-4 text-purple-500" /> Check Completeness
                  </button>
                </div>
              )}
            </div>

            {/* More Menu */}
            <div className="relative">
              <button
                type="button"
                onClick={() => { setShowMoreMenu(!showMoreMenu); setShowToolsMenu(false); setShowAIMenu(false); }}
                className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1.5 font-medium text-gray-700 transition hover:bg-gray-50"
              >
                <MoreVertical className="h-4 w-4" />
              </button>
              {showMoreMenu && (
                <div className="absolute top-full right-0 mt-1 w-48 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1">
                  <button onClick={() => { handleCreateTemplate(); setShowMoreMenu(false); }} className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2">
                    <FilePlus2 className="h-4 w-4 text-gray-500" /> New Template
                  </button>
                  <button
                    onClick={() => { setIsDeleteConfirmOpen(true); setShowMoreMenu(false); }}
                    disabled={!selectedTemplateId || templates.length <= 1}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-red-50 text-red-600 flex items-center gap-2 disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" /> Delete Template
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Right: Settings Panel Toggle */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSidebarCollapsed((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${sidebarCollapsed
                ? 'border border-gray-300 text-gray-700 hover:bg-gray-50'
                : 'bg-blue-600 text-white hover:bg-blue-700'
                }`}
              title="Template Settings & Details"
            >
              <Settings className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{sidebarCollapsed ? 'Settings' : 'Hide Settings'}</span>
            </button>
          </div>
        </div>

        {/* License Warning - Compact */}
        {!ckeditorLicenseKey && (
          <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800">
            CKEditor license key not configured. Set <span className="font-mono">VITE_CKEDITOR_LICENSE_KEY</span> in your environment.
          </div>
        )}
      </div>

      {/* Click outside to close dropdowns */}
      {(showToolsMenu || showAIMenu || showMoreMenu) && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => { setShowToolsMenu(false); setShowAIMenu(false); setShowMoreMenu(false); }}
        />
      )}

      <div className="flex w-full flex-1 overflow-hidden relative bg-slate-50">
        {/* Main Editor Area - Full Width if sidebar is collapsed */}
        <main className="flex-1 relative px-8 py-10 transition-all duration-300 min-w-0 overflow-auto">
          {saveError ? (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {saveError}
            </div>
          ) : null}

          <div className="editor-wrapper flex flex-col items-center pb-20 min-w-[1000px]">
            <div
              className="relative rounded-lg border border-gray-200 bg-white shadow-sm"
              style={{
                width: '1000px',
                minWidth: '1000px',
                transform: `scale(${zoomLevel / 100})`,
                transformOrigin: 'top center',
                transition: 'transform 0.2s ease-in-out',
                // Explicitly set the space taken by the scaled editor to prevent layout jumping
                marginRight: '0',
                marginBottom: zoomLevel < 100 ? `calc(800px * ${(100 - zoomLevel) / 100} * -1)` : '0'
              }}
            >
              {editorBooting ? (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/80">
                  <div className="flex items-center gap-2 text-sm text-gray-600">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Initialising editor…
                  </div>
                </div>
              ) : null}
              <div key={selectedTemplateId || 'new-template'} ref={editorContainerRef} className="min-h-[700px]" />
            </div>

            <details className="mt-8 w-full max-w-[1000px] border border-gray-200 rounded-lg bg-white overflow-hidden group shadow-sm">
              <summary className="flex items-center gap-2 px-4 py-2 cursor-pointer hover:bg-gray-50 transition-colors list-none select-none border-b border-transparent group-open:border-gray-100">
                <ChevronRight className="w-4 h-4 text-gray-400 group-open:rotate-90 transition-transform" />
                <span className="text-xs font-semibold uppercase tracking-wide text-gray-600">Custom CSS (Optional)</span>
              </summary>
              <div className="p-4">
                <textarea
                  value={cssContent}
                  onChange={(event) => setCssContent(event.target.value)}
                  className="h-48 w-full rounded-md border border-gray-300 px-3 py-2 text-xs font-mono bg-gray-50 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="/* Add template-specific styles here */"
                  spellCheck={false}
                />
              </div>
            </details>
          </div>

          {saveMessage ? (
            <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 max-w-2xl">
              {saveMessage}
            </p>
          ) : null}
        </main>

        {/* Push-out Settings Panel */}
        <div
          className={`shrink-0 overflow-hidden border-l border-gray-200 bg-white shadow-xl transition-all duration-300 ease-in-out relative z-30 ${sidebarCollapsed ? 'w-0' : 'w-80'
            }`}
        >
          <div className={`w-80 h-full flex flex-col transition-opacity duration-300 ${sidebarCollapsed ? 'opacity-0' : 'opacity-100'}`}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50">
              <h3 className="font-semibold text-gray-900">Template Settings</h3>
              <button
                onClick={() => setSidebarCollapsed(true)}
                className="p-1 hover:bg-gray-200 rounded-full text-gray-500 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-6">
              {/* Template Metadata Form */}
              <section className="space-y-4">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">General Details</h4>
                <div className="space-y-3 text-sm">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Name</label>
                    <input
                      type="text"
                      value={metadataDraft.name}
                      onChange={(event) =>
                        setMetadataDraft((prev) => ({ ...prev, name: event.target.value }))
                      }
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Description</label>
                    <textarea
                      value={metadataDraft.description}
                      onChange={(event) =>
                        setMetadataDraft((prev) => ({ ...prev, description: event.target.value }))
                      }
                      rows={3}
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Category</label>
                    <input
                      type="text"
                      value={metadataDraft.category}
                      onChange={(event) =>
                        setMetadataDraft((prev) => ({ ...prev, category: event.target.value }))
                      }
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                  <div className="flex items-center gap-2 mt-4 mb-2 bg-blue-50/50 p-2 rounded-md border border-blue-100">
                    <input
                      type="checkbox"
                      id="interpretationOnly"
                      checked={metadataDraft.isInterpretationOnly}
                      onChange={(event) =>
                        setMetadataDraft((prev) => ({ ...prev, isInterpretationOnly: event.target.checked }))
                      }
                      className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <label htmlFor="interpretationOnly" className="text-xs font-medium text-gray-700 select-none cursor-pointer">
                      Interpretation Only Mode
                    </label>
                  </div>
                  <p className="text-[10px] text-gray-500 mb-4 px-1 leading-relaxed">
                    If checked, this template will be appended to the bottom of the default generated report table instead of replacing the entire layout. Useful for clinical interpretations or comments.
                  </p>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Linked Test Group</label>
                    <Combobox
                      value={testGroups.find(g => g.id === metadataDraft.testGroupId) || null}
                      onChange={(group: TestGroupOption | null) => {
                        setMetadataDraft(prev => ({ ...prev, testGroupId: group ? group.id : '' }));
                      }}
                      nullable
                    >
                      <div className="relative">
                        <div className="relative w-full cursor-default overflow-hidden rounded-md border border-gray-300 bg-white text-left text-xs focus-within:ring-1 focus-within:ring-blue-500 focus-within:border-blue-500">
                          <Combobox.Input
                            className="w-full border-none py-2 pl-3 pr-10 text-xs leading-5 text-gray-900 focus:ring-0"
                            displayValue={(group: TestGroupOption | null) => group?.name || ''}
                            onChange={(event) => setTestGroupQuery(event.target.value)}
                            placeholder="Type to search test groups..."
                          />
                          <Combobox.Button className="absolute inset-y-0 right-0 flex items-center pr-2">
                            <ChevronDown className="h-4 w-4 text-gray-400" aria-hidden="true" />
                          </Combobox.Button>
                        </div>
                        <Transition
                          as={Fragment}
                          leave="transition ease-in duration-100"
                          leaveFrom="opacity-100"
                          leaveTo="opacity-0"
                          afterLeave={() => setTestGroupQuery('')}
                        >
                          <Combobox.Options className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md bg-white py-1 text-xs shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none">
                            <Combobox.Option
                              value={null}
                              className={({ active }) =>
                                `relative cursor-default select-none py-2 pl-3 pr-4 ${active ? 'bg-blue-600 text-white' : 'text-gray-900'
                                }`
                              }
                            >
                              Not linked
                            </Combobox.Option>
                            {testGroupsLoading ? (
                              <div className="relative cursor-default select-none py-2 px-4 text-gray-500">
                                Loading...
                              </div>
                            ) : filteredTestGroups.length === 0 && testGroupQuery !== '' ? (
                              <div className="relative cursor-default select-none py-2 px-4 text-gray-700">
                                Nothing found.
                              </div>
                            ) : (
                              filteredTestGroups.map((group) => (
                                <Combobox.Option
                                  key={group.id}
                                  className={({ active }) =>
                                    `relative cursor-default select-none py-2 pl-10 pr-4 ${active ? 'bg-blue-600 text-white' : 'text-gray-900'
                                    }`
                                  }
                                  value={group}
                                >
                                  {({ selected, active }) => (
                                    <>
                                      <div className="flex items-center justify-between gap-2">
                                        <span className={`block truncate ${selected ? 'font-medium' : 'font-normal'}`}>
                                          {group.name}
                                        </span>
                                        <span
                                          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                                            group.isActive
                                              ? (active ? 'bg-white/20 text-white' : 'bg-emerald-100 text-emerald-700')
                                              : (active ? 'bg-white/20 text-white' : 'bg-rose-100 text-rose-700')
                                          }`}
                                        >
                                          Active: {group.isActive ? 'True' : 'False'}
                                        </span>
                                      </div>
                                      {selected ? (
                                        <span className={`absolute inset-y-0 left-0 flex items-center pl-3 ${active ? 'text-white' : 'text-blue-600'}`}>
                                          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                                        </span>
                                      ) : null}
                                    </>
                                  )}
                                </Combobox.Option>
                              ))
                            )}
                          </Combobox.Options>
                        </Transition>
                      </div>
                    </Combobox>
                    {attachedTestGroup && (
                      <p className="mt-1 text-[10px] text-blue-600">
                        Currently linked to: {attachedTestGroup.name} (Active: {attachedTestGroup.isActive ? 'True' : 'False'})
                      </p>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={handleMetadataSave}
                    disabled={metadataSaving}
                    className="w-full mt-2 rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-xs font-medium text-blue-700 transition hover:bg-blue-100 disabled:opacity-50"
                  >
                    {metadataSaving ? 'Saving Details…' : 'Save Details'}
                  </button>

                  {metadataMessage && (
                    <div className="flex items-center gap-2 text-[10px] text-emerald-600 bg-emerald-50 p-2 rounded border border-emerald-100">
                      <CheckCircle2 className="w-3 h-3" /> {metadataMessage}
                    </div>
                  )}
                </div>
              </section>

              <hr className="border-gray-100" />

              {/* Audit Summary Section */}
              {auditResult && (
                <section className="space-y-3">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Compliance & Audit</h4>
                  <div className="bg-purple-50 rounded-lg p-3 border border-purple-100">
                    <div className="flex items-start gap-2">
                      <CheckCircle2 className="w-4 h-4 text-purple-600 mt-0.5 shrink-0" />
                      <div>
                        <p className="text-xs font-semibold text-purple-900">Last Audit Result</p>
                        <p className="text-xs text-purple-800 mt-1 leading-relaxed">{auditResult.summary}</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsCompletenessOpen(true)}
                      className="mt-3 w-full rounded border border-purple-200 bg-white px-3 py-1.5 text-[11px] font-medium text-purple-700 hover:bg-purple-50 transition-colors"
                    >
                      Check Completeness
                    </button>
                  </div>
                </section>
              )}
            </div>
          </div>
        </div>

        {
          placeholderPickerOpen ? (
            <PlaceholderPicker
              options={placeholderOptions}
              onInsert={handleInsertPlaceholder}
              onClose={() => setPlaceholderPickerOpen(false)}
              onRefresh={loadPlaceholderOptions}
              loading={placeholderLoading}
              errorMessage={placeholderError}
            />
          ) : null
        }

        {
          isSourcePreviewOpen ? (
            <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 px-4">
              <div className="w-full max-w-4xl rounded-lg border border-gray-200 bg-white shadow-xl">
                <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
                  <div>
                    <h2 className="text-sm font-semibold text-gray-900">Template Source Preview</h2>
                    <p className="text-[11px] text-gray-500">Copy HTML or CSS directly without leaving the editor.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setIsSourcePreviewOpen(false);
                      setSourceCopyState(null);
                    }}
                    className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100"
                  >
                    Close
                  </button>
                </div>
                <div className="grid gap-4 px-5 py-4 lg:grid-cols-2">
                  <section className="flex flex-col">
                    <div className="mb-2 flex items-center justify-between">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">HTML</h3>
                      <button
                        type="button"
                        onClick={() => handleCopySource('html')}
                        className="rounded-md border border-gray-300 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-100"
                      >
                        {sourceCopyState === 'html' ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                    <textarea
                      value={htmlContent}
                      readOnly
                      spellCheck={false}
                      className="h-64 resize-none rounded-md border border-gray-300 bg-gray-50 p-3 text-xs font-mono text-gray-800 focus:outline-none"
                    />
                  </section>
                  <section className="flex flex-col">
                    <div className="mb-2 flex items-center justify-between">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">CSS</h3>
                      <button
                        type="button"
                        onClick={() => handleCopySource('css')}
                        className="rounded-md border border-gray-300 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-100"
                      >
                        {sourceCopyState === 'css' ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                    <textarea
                      value={cssContent}
                      readOnly
                      spellCheck={false}
                      className="h-64 resize-none rounded-md border border-gray-300 bg-gray-50 p-3 text-xs font-mono text-gray-800 focus:outline-none"
                      placeholder="/* No custom CSS yet */"
                    />
                  </section>
                </div>
              </div>
            </div>
          ) : null
        }

        {
          isA4PreviewOpen ? (
            <div className="fixed inset-0 z-[200000] flex items-center justify-center bg-black/60 px-4">
              <div className="h-[90vh] w-full max-w-6xl rounded-lg border border-gray-200 bg-white shadow-2xl">
                <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900">A4 Full View Preview</h2>
                    <p className="text-sm text-gray-500">Complete A4 document preview with actual dimensions</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsA4PreviewOpen(false)}
                    className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100"
                  >
                    Close
                  </button>
                </div>

                <div className="flex h-[calc(90vh-80px)] overflow-hidden">
                  {/* A4 Preview Container */}
                  <div className="flex-1 overflow-auto bg-gray-100 p-8">
                    <div className="mx-auto bg-white shadow-lg" style={{
                      width: '210mm',
                      minHeight: '297mm',
                      padding: '20mm',
                      position: 'relative'
                    }}>
                      {/* Template Content with proper CSS injection */}
                      <div
                        dangerouslySetInnerHTML={{
                          __html: `
                        <style>
                          /* Reset and base styles for A4 preview */
                          * {
                            box-sizing: border-box;
                          }
                          
                          body, div, p, h1, h2, h3, h4, h5, h6, table, tr, td, th {
                            margin: 0;
                            padding: 0;
                          }
                          
                          /* Typography */
                          body {
                            font-family: 'Arial', 'Helvetica', sans-serif;
                            font-size: 14px;
                            line-height: 1.6;
                            color: #000;
                            background: transparent;
                          }
                          
                          /* Headings */
                          h1 { font-size: 18px; font-weight: bold; margin-bottom: 12px; }
                          h2 { font-size: 16px; font-weight: bold; margin-bottom: 10px; }
                          h3 { font-size: 14px; font-weight: bold; margin-bottom: 8px; }
                          h4 { font-size: 12px; font-weight: bold; margin-bottom: 6px; }
                          h5, h6 { font-size: 11px; font-weight: bold; margin-bottom: 4px; }
                          
                          /* Paragraphs */
                          p {
                            margin-bottom: 8px;
                            text-align: left;
                          }

                          /* Figures */
                          figure {
                            margin: 0;
                          }
                          
                          /* Tables */
                          table {
                            width: 100%;
                            border-collapse: collapse;
                            margin-bottom: 16px;
                            font-size: 11px;
                          }
                          
                          table, th, td {
                            border: 1px solid #000;
                          }
                          
                          th, td {
                            padding: 6px 8px;
                            text-align: left;
                            vertical-align: top;
                          }
                          
                          th {
                            background-color: #f5f5f5;
                            font-weight: bold;
                          }
                          
                          /* Lists */
                          ul, ol {
                            margin: 8px 0;
                            padding-left: 20px;
                          }
                          
                          li {
                            margin-bottom: 4px;
                          }
                          
                          /* Images */
                          img {
                            max-width: 100%;
                            height: auto;
                            display: block;
                            margin: 8px 0;
                          }
                          
                          /* Divs and containers */
                          div {
                            margin-bottom: 4px;
                          }
                          
                          /* Text formatting */
                          strong, b {
                            font-weight: bold;
                          }
                          
                          em, i {
                            font-style: italic;
                          }
                          
                          /* Links */
                          a {
                            color: #0066cc;
                            text-decoration: underline;
                          }
                          
                          /* Horizontal rules */
                          hr {
                            border: none;
                            border-top: 1px solid #000;
                            margin: 16px 0;
                          }
                          
                          /* Blockquotes */
                          blockquote {
                            margin: 8px 0;
                            padding-left: 16px;
                            border-left: 3px solid #ccc;
                            font-style: italic;
                          }
                          
                          /* Code blocks */
                          pre, code {
                            font-family: 'Courier New', monospace;
                            font-size: 10px;
                            background-color: #f8f8f8;
                            padding: 4px;
                            border: 1px solid #ddd;
                          }
                          
                          pre {
                            white-space: pre-wrap;
                            margin: 8px 0;
                            padding: 8px;
                          }
                          
                          /* Page breaks */
                          .page-break {
                            page-break-after: always;
                            break-after: page;
                            display: block;
                            height: 0;
                            border-top: 2px dashed #999;
                            margin: 20px 0;
                            position: relative;
                          }
                          
                          .page-break::after {
                            content: 'Page Break';
                            position: absolute;
                            top: -10px;
                            left: 50%;
                            transform: translateX(-50%);
                            background: white;
                            padding: 0 8px;
                            font-size: 10px;
                            color: #666;
                          }
                          
                          /* Hide merge field placeholders (double curly braces) in preview */
                          *[data-placeholder],
                          .ck-placeholder {
                            background: transparent !important;
                            color: inherit !important;
                          }
                          
                          /* Custom CSS from template */
                          ${cssContent || ''}
                        </style>
                        ${htmlContent || '<p>No content available</p>'}
                      `
                        }}
                      />
                    </div>
                  </div>

                  {/* Information Panel */}
                  <div className="w-80 border-l border-gray-200 bg-gray-50 p-6">
                    <h3 className="text-sm font-semibold text-gray-900 mb-4">A4 Document Info</h3>

                    <div className="space-y-3 text-sm">
                      <div>
                        <dt className="font-medium text-gray-700">Paper Size</dt>
                        <dd className="text-gray-600">A4 (210 × 297 mm)</dd>
                      </div>

                      <div>
                        <dt className="font-medium text-gray-700">Margins</dt>
                        <dd className="text-gray-600">20mm all sides</dd>
                      </div>

                      <div>
                        <dt className="font-medium text-gray-700">Content Area</dt>
                        <dd className="text-gray-600">170 × 257 mm</dd>
                      </div>

                      <div>
                        <dt className="font-medium text-gray-700">Template</dt>
                        <dd className="text-gray-600">{templateMeta?.template_name || 'Untitled'}</dd>
                      </div>

                      {templateMeta?.template_description && (
                        <div>
                          <dt className="font-medium text-gray-700">Description</dt>
                          <dd className="text-gray-600">{templateMeta.template_description}</dd>
                        </div>
                      )}

                      <div className="pt-4 border-t border-gray-200">
                        <dt className="font-medium text-gray-700 mb-2">CSS Applied</dt>
                        <dd className="text-xs text-gray-500 font-mono bg-gray-100 p-2 rounded">
                          {cssContent ? 'Custom CSS active' : 'No custom CSS'}
                        </dd>
                      </div>

                      <div className="pt-4">
                        <button
                          type="button"
                          onClick={() => {
                            const printWindow = window.open('', '_blank');
                            if (printWindow) {
                              // Extract body content only - header/footer come from PDF.co overlay
                              const bodyRegion = document.querySelector('[data-report-region="body"]') || editorContainerRef.current;
                              let bodyHtml = bodyRegion?.innerHTML || 'Place body content here';

                              // Render placeholders with sample data
                              const sampleContext = {
                                // Patient Details
                                patientName: 'John Doe',
                                patientAge: '45 Years',
                                patientGender: 'Male',
                                patientId: 'PID-2024-001',
                                patientMobile: '+1 234 567 8900',
                                patientAddress: '123 Main St, Springfield, IL',

                                // Visit/Order Details
                                visitDate: '26 Nov 2025',
                                registrationDate: '26 Nov 2025',
                                sampleCollectedAt: '26 Nov 2025, 10:30 AM',
                                sampleReceivedAt: '26 Nov 2025, 11:00 AM',
                                reportDate: '26 Nov 2025, 02:30 PM',
                                approvedAt: '26 Nov 2025, 02:45 PM',
                                orderId: 'ORD-2024-00123',
                                labNumber: 'LAB-123',
                                referringDoctorName: 'Dr. Robert Smith, MD',
                                referringDoctorId: 'DOC-555',

                                // Location/Lab Details (for internal logic)
                                // Location/Lab Details (for internal logic)
                                locationName: 'Main Diagnostic Center',

                                // Lab Info for Header (Actual or Dummy)
                                labName: labDetails?.name || 'City Diagnostic Labs',
                                labAddress: labDetails?.address || '456 Healthcare Ave, Medical District, NY 10001',
                                labPhone: labDetails?.phone || '(555) 123-4567',
                                labEmail: labDetails?.email || 'results@citydiagnostics.com',
                                labWebsite: labDetails?.website || 'www.citydiagnostics.com',

                                  // Dynamic Content Placeholders
                                  crpResult: '66',
                                  crpUnit: 'mg/L',
                                  crpRefRange: '< 5',
                                  crpRemarks: 'Elevated levels indicating inflammation.',
                                  technique: 'Photometry (Enzymatic)',
                                  methodology: 'Photometry (Enzymatic)',

                                // Analytes shown in user feedback
                                ANALYTE_EOS_VALUE: '0.45',
                                ANALYTE_EOS_UNIT: '10^9/L',
                                ANALYTE_EOS_REFERENCE_RANGE: '0.04 - 0.54',
                                ANALYTE_WBC_VALUE: '7.5',
                                ANALYTE_WBC_UNIT: '10^9/L',
                                ANALYTE_RBC_VALUE: '4.8',

                                // Signatures & Approvers
                                approverSignature: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e4/John_Hancock_Signature.svg/1200px-John_Hancock_Signature.svg.png',
                                approvedByName: 'Dr. Sarah Johnson, PhD',
                                approverDesignation: 'Senior Pathologist',
                                signatoryName: 'Dr. Sarah Johnson, PhD',
                                signatoryDesignation: 'Senior Pathologist',
                                technicianName: 'Jane Technician',




                                // Common Table Headers
                                testNameHeader: 'Test Description',
                                resultHeader: 'Result',
                                unitHeader: 'Units',
                                refRangeHeader: 'Reference Range'
                              };

                              // Helper to generate a dummy barcode URL
                              const barcodeUrl = 'https://bwipjs-api.metafloor.com/?bcid=code128&text=ORD-2024-00123&scale=2&height=10&incltext';

                              // Simple placeholder replacement (regex-based for print preview)
                              const replacePlaceholders = (html: string) => {
                                let result = html;

                                // 1. Replace known context keys
                                Object.entries(sampleContext).forEach(([key, value]) => {
                                  const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'gi'); // Case insensitive replacement
                                  result = result.replace(regex, String(value));
                                });

                                // 2. Handle patterns that might be missing from context but are common
                                result = result.replace(/\{\{lab_name\}\}/gi, sampleContext.labName);
                                result = result.replace(/\{\{lab_address\}\}/gi, sampleContext.labAddress);

                                // 3. Handle signature injection if {{approverSignature}} is used in an img src
                                result = result.replace(/src="\{\{approverSignature\}\}"/gi, `src="${sampleContext.approverSignature}"`);

                                // 4. Generic fallback for unknown ANALYTE_ placeholders to avoid ugly {{...}}
                                result = result.replace(/\{\{ANALYTE_[A-Z0-9_]+_VALUE\}\}/g, '25.5');
                                result = result.replace(/\{\{ANALYTE_[A-Z0-9_]+_UNIT\}\}/g, 'mg/dL');
                                result = result.replace(/\{\{ANALYTE_[A-Z0-9_]+_REFERENCE_RANGE\}\}/g, '10.0 - 40.0');
                                result = result.replace(/\{\{ANALYTE_[A-Z0-9_]+_REFERENCE\}\}/g, '10.0 - 40.0');
                                result = result.replace(/\{\{ANALYTE_[A-Z0-9_]+_FLAG\}\}/g, 'Normal');
                                result = result.replace(/\{\{ANALYTE_[A-Z0-9_]+_METHOD\}\}/g, 'Photometry');

                                // 5. Generic fallback for new suffixes
                                result = result.replace(/\{\{[A-Za-z0-9_]+_UNIT\}\}/g, 'mg/dL');
                                result = result.replace(/\{\{[A-Za-z0-9_]+_REF_RANGE\}\}/g, '10 - 40');
                                result = result.replace(/\{\{[A-Za-z0-9_]+_FLAG\}\}/g, 'Normal');
                                result = result.replace(/\{\{[A-Za-z0-9_]+_NOTE\}\}/g, 'Sample note');
                                result = result.replace(/\{\{[A-Za-z0-9_]+_METHOD\}\}/g, 'Photometry');

                                return result;
                              };



                              // UNWRAP TABLES FROM FIGURES
                              // The gray box issue is caused by CKEditor's <figure> wrapper handling
                              const tempDiv = document.createElement('div');
                              tempDiv.innerHTML = bodyHtml;

                              const figures = tempDiv.querySelectorAll('figure.table');
                              figures.forEach(figure => {
                                const table = figure.querySelector('table');
                                if (table) {
                                  figure.replaceWith(table);
                                }
                              });

                              bodyHtml = tempDiv.innerHTML;

                              bodyHtml = replacePlaceholders(bodyHtml);

                              printWindow.document.write(`
                            <html>
                              <head>
                                <title>Print Preview - ${templateMeta?.template_name || 'Untitled'}</title>
                                <base href="${window.location.origin}/" />
                                <style>
                                  /* Page layout controlled by PDF.co API parameters - no hardcoded margins */
                                  @page { 
                                    size: A4;
                                  }
                                  
                                  /* Reset and base styles */
                                  * {
                                    box-sizing: border-box;
                                  }
                                  
                                  body, div, p, h1, h2, h3, h4, h5, h6, table, tr, td, th {
                                    margin: 0;
                                    padding: 0;
                                  }
                                  
                                  body {
                                    font-family: 'Arial', 'Helvetica', sans-serif;
                                    font-size: 12px;
                                    line-height: 1.4;
                                    color: #000;
                                    background: white;
                                  }
                                  
                                  /* Typography */
                                  h1 { font-size: 18px; font-weight: bold; margin-bottom: 12px; }
                                  h2 { font-size: 16px; font-weight: bold; margin-bottom: 10px; }
                                  h3 { font-size: 14px; font-weight: bold; margin-bottom: 8px; }
                                  h4 { font-size: 12px; font-weight: bold; margin-bottom: 6px; }
                                  h5, h6 { font-size: 11px; font-weight: bold; margin-bottom: 4px; }
                                  
                                  p {
                                    margin-bottom: 8px;
                                    text-align: left;
                                  }
                                  
                                  /* Tables */
                                  table {
                                    width: 100%;
                                    border-collapse: collapse;
                                    margin-bottom: 16px;
                                    font-size: 11px;
                                  }
                                  
                                  table, th, td {
                                    border: 1px solid #000;
                                  }
                                  
                                  th, td {
                                    padding: 6px 8px;
                                    text-align: left;
                                    vertical-align: top;
                                  }
                                  
                                  th {
                                    background-color: #f5f5f5;
                                    font-weight: bold;
                                  }
                                  
                                  /* Lists */
                                  ul, ol {
                                    margin: 8px 0;
                                    padding-left: 20px;
                                  }
                                  
                                  li {
                                    margin-bottom: 4px;
                                  }
                                  
                                  /* Images */
                                  img {
                                    max-width: 100%;
                                    height: auto;
                                    display: block;
                                    margin: 8px 0;
                                  }
                                  
                                  /* Text formatting */
                                  strong, b { font-weight: bold; }
                                  em, i { font-style: italic; }
                                  
                                  /* Links */
                                  a {
                                    color: #0066cc;
                                    text-decoration: underline;
                                  }
                                  
                                  /* Horizontal rules */
                                  hr {
                                    border: none;
                                    border-top: 1px solid #000;
                                    margin: 16px 0;
                                  }
                                  
                                  /* Blockquotes */
                                  blockquote {
                                    margin: 8px 0;
                                    padding-left: 16px;
                                    border-left: 3px solid #ccc;
                                    font-style: italic;
                                  }
                                  
                                  /* Code blocks */
                                  pre, code {
                                    font-family: 'Courier New', monospace;
                                    font-size: 10px;
                                    background-color: #f8f8f8;
                                    padding: 4px;
                                    border: 1px solid #ddd;
                                  }
                                  
                                  pre {
                                    white-space: pre-wrap;
                                    margin: 8px 0;
                                    padding: 8px;
                                  }
                                  
                                  /* Page breaks - visible in print */
                                  .page-break {
                                    page-break-after: always;
                                    break-after: page;
                                    display: block;
                                    height: 1px;
                                    background: transparent;
                                    border: none;
                                  }
                                  
                                  @media print {
                                    .page-break {
                                      page-break-after: always;
                                      break-after: page;
                                    }
                                  }
                                  
                                  @media screen {
                                    .page-break {
                                      border-top: 2px dashed #999;
                                      margin: 20mm 0;
                                      position: relative;
                                    }
                                    .page-break::after {
                                      content: 'Page Break';
                                      position: absolute;
                                      top: -10px;
                                      left: 50%;
                                      transform: translateX(-50%);\n                                      background: white;
                                      padding: 0 8px;
                                      font-size: 10px;
                                      color: #666;
                                    }
                                  }
                                  
                                  /* Custom CSS from template */
                                  ${cssContent || ''}
                                  
                                  /* PDF Layout Structure */
                                  .pdf-container {
                                    width: 210mm;
                                    min-height: 297mm;
                                    margin: 0 auto;
                                    background: white;
                                    position: relative;
                                  }
                                  
                                  .pdf-header {
                                    min-height: 100px;
                                    padding: 16px 36px;
                                    border-bottom: 1px solid rgba(0, 0, 0, 0.1);
                                    background: white;
                                  }
                                  
                                  .pdf-body {
                                    padding: 48px 36px;
                                    min-height: calc(297mm - 200px);
                                  }
                                  
                                  .pdf-footer {
                                    min-height: 80px;
                                    padding: 16px 36px;
                                    border-top: 1px solid rgba(0, 0, 0, 0.1);
                                    background: white;
                                    position: absolute;
                                    bottom: 0;
                                    left: 0;
                                    right: 0;
                                  }
                                  
                                  @media print {
                                    .pdf-header {
                                      position: fixed;
                                      top: 0;
                                      left: 0;
                                      right: 0;
                                    }
                                    
                                    .pdf-footer {
                                      position: fixed;
                                      bottom: 0;
                                      left: 0;
                                      right: 0;
                                    }
                                    
                                    .pdf-body {
                                      padding-top: 160px;
                                      padding-bottom: 140px;
                                    }
                                  }
                                </style>
                              </head>
                              <body>
                                <div class="pdf-container">
                                  <div class="pdf-header">
                                    <div style="display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #333; padding-bottom: 15px; margin-bottom: 20px;">
                                      <div style="flex: 1;">
                                        <div style="font-size: 24px; font-weight: bold; color: #1a56db; margin-bottom: 5px;">${sampleContext.labName}</div>
                                        <div style="font-size: 12px; color: #555; line-height: 1.4;">
                                          ${sampleContext.labAddress}<br>
                                          Ph: ${sampleContext.labPhone} | Email: ${sampleContext.labEmail}<br>
                                          ${sampleContext.labWebsite}
                                        </div>
                                      </div>
                                      <div style="text-align: right;">
                                        <div style="background: #f0f0f0; padding: 5px 10px; border-radius: 4px; display: inline-block; margin-bottom: 5px;">
                                          <span style="font-weight: bold; font-size: 12px;">LAB No: ${sampleContext.labNumber}</span>
                                        </div>
                                        <br>
                                        <img src="${barcodeUrl}" alt="Barcode" style="height: 35px; width: auto; margin-top: 5px;" />
                                      </div>
                                    </div>
                                  </div>
                                  
                                  <div class="pdf-body">
                                    ${bodyHtml}
                                  
                                    <!-- Dummy End of Report Line if not present -->
                                    ${!bodyHtml.includes('End of Report') ? `
                                    <div style="margin-top: 30px; text-align: center; font-size: 11px; color: #888; border-top: 1px dotted #ccc; padding-top: 10px;">
                                      *** End of Report ***
                                    </div>
                                    ` : ''}
                                  </div>
                                  
                                  <div class="pdf-footer">
                                    <div style="border-top: 2px solid #333; padding-top: 10px; margin-top: 10px; display: flex; justify-content: space-between; align-items: center; font-size: 10px; color: #666;">
                                      <div style="text-align: left;">
                                        Generated on: ${new Date().toLocaleString()}<br>
                                        This is a system generated report.
                                      </div>
                                      <div style="text-align: right;">
                                        Page <span class="pageNumber">1</span> of <span class="totalPages">1</span>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              </body>
                            </html>
                          `);
                              printWindow.document.close();
                              printWindow.print();
                            }
                          }}
                          className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                        >
                          Print Preview
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : null
        }

        {
          isDeleteConfirmOpen ? (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
              <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white shadow-2xl">
                <div className="flex items-center gap-3 border-b border-gray-200 px-6 py-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100">
                    <Trash2 className="h-5 w-5 text-red-600" />
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900">Delete Template</h2>
                    <p className="text-sm text-gray-500">This action cannot be undone</p>
                  </div>
                </div>

                <div className="px-6 py-4">
                  <p className="text-sm text-gray-700 mb-4">
                    Are you sure you want to delete the template <strong>"{templateMeta?.template_name || 'Untitled Template'}"</strong>?
                    This will permanently remove the template and all its versions.
                  </p>

                  <div className="flex justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => setIsDeleteConfirmOpen(false)}
                      disabled={isDeleting}
                      className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleDeleteTemplate}
                      disabled={isDeleting}
                      className="inline-flex items-center gap-2 rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-red-400"
                    >
                      {isDeleting ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Deleting...
                        </>
                      ) : (
                        <>
                          <Trash2 className="h-4 w-4" />
                          Delete Template
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : null
        }

        <AIStudioModal
          open={isAIStudioOpen}
          onClose={() => setIsAIStudioOpen(false)}
          editor={editorAdapter}
          templateName={templateMeta?.template_name || 'Template'}
          labId={labId || ''}
          testGroupId={templateMeta?.test_group_id || undefined}
          onApplied={() => setSaveMessage('AI changes applied in the editor. Review and save when ready.')}
          onHtmlGenerated={handleReportUploadGenerated}
        />

        <CompletenessModal
          open={isCompletenessOpen}
          onClose={() => setIsCompletenessOpen(false)}
          editor={editorAdapter}
          placeholderOptions={placeholderOptions}
          labId={labId || ''}
          templateName={templateMeta?.template_name || 'Template'}
        />

        <TemplateBuilderSidebar
          open={isBuilderSidebarOpen}
          onClose={() => setIsBuilderSidebarOpen(false)}
          editor={editorAdapter}
          templateName={templateMeta?.template_name || 'Template'}
          labId={labId || ''}
          testGroupId={templateMeta?.test_group_id || undefined}
          placeholderOptions={placeholderOptions}
          onRefreshPlaceholders={loadPlaceholderOptions}
          placeholderLoading={placeholderLoading}
        />



        <PDFPreviewModal
          open={isPdfPreviewOpen}
          onClose={() => setIsPdfPreviewOpen(false)}
          htmlContent={htmlContent}
          cssContent={cssContent}
          labId={labId || ''}
        />
      </div>
    </div>
  );
};

export default TemplateStudioCKE;
