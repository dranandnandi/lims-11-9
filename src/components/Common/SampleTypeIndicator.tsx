import React from 'react';
import { useSampleTypeColors } from '../../contexts/SampleTypeColorsContext';

interface SampleTypeIndicatorProps {
    sampleType: string;
    sampleColor?: string;
    size?: 'sm' | 'md' | 'lg';
    showLabel?: boolean;
    className?: string;
    labColors?: Record<string, string>;
}

interface SampleConfig {
    type: string;
    cap: string;
    label: string;
    gradient: string;
    bodyFill?: string;
    contentFill?: string;
}

// Default vacutainer cap colors (CLSI order-of-draw standard).
// `lightBlue` (citrate) and `royalBlue` (trace elements) are different tubes —
// do not collapse them into one "blue".
const DEFAULT_VACUTAINER_CAPS: Record<string, { cap: string; label: string; gradient: string }> = {
    red: { cap: '#DC2626', label: 'Red Top', gradient: 'from-red-600 to-red-700' },
    purple: { cap: '#9333EA', label: 'Purple Top (EDTA)', gradient: 'from-purple-600 to-purple-700' },
    lavender: { cap: '#9333EA', label: 'Lavender Top (EDTA)', gradient: 'from-purple-600 to-purple-700' },
    green: { cap: '#16A34A', label: 'Green Top (Heparin)', gradient: 'from-green-600 to-green-700' },
    lightBlue: { cap: '#7EC8E3', label: 'Light Blue Top (Citrate)', gradient: 'from-sky-300 to-sky-400' },
    royalBlue: { cap: '#1D4ED8', label: 'Royal Blue Top (Trace Elements)', gradient: 'from-blue-700 to-blue-800' },
    yellow: { cap: '#EAB308', label: 'Yellow Top (ACD/SPS)', gradient: 'from-yellow-500 to-yellow-600' },
    gold: { cap: '#F59E0B', label: 'Gold Top (SST)', gradient: 'from-amber-500 to-amber-600' },
    gray: { cap: '#6B7280', label: 'Gray Top (Fluoride)', gradient: 'from-gray-500 to-gray-600' },
};

// Test groups store their tube colour as a name ('Red', 'Blue', 'Pink', ...).
// Painted raw as an SVG fill those CSS colours clash with the palette above, so
// resolve known names to the vacutainer hexes and let anything else (hex, rgb(),
// hsl(), an unlisted name) pass through untouched.
const CAP_COLOR_NAMES: Record<string, string> = {
    red: DEFAULT_VACUTAINER_CAPS.red.cap,
    purple: DEFAULT_VACUTAINER_CAPS.purple.cap,
    lavender: DEFAULT_VACUTAINER_CAPS.lavender.cap,
    green: DEFAULT_VACUTAINER_CAPS.green.cap,
    blue: DEFAULT_VACUTAINER_CAPS.royalBlue.cap,
    'light blue': DEFAULT_VACUTAINER_CAPS.lightBlue.cap,
    lightblue: DEFAULT_VACUTAINER_CAPS.lightBlue.cap,
    'royal blue': DEFAULT_VACUTAINER_CAPS.royalBlue.cap,
    royalblue: DEFAULT_VACUTAINER_CAPS.royalBlue.cap,
    yellow: DEFAULT_VACUTAINER_CAPS.yellow.cap,
    gold: DEFAULT_VACUTAINER_CAPS.gold.cap,
    gray: DEFAULT_VACUTAINER_CAPS.gray.cap,
    grey: DEFAULT_VACUTAINER_CAPS.gray.cap,
    pink: '#EC4899',
    orange: '#F97316',
    black: '#111827',
    white: '#F3F4F6',
    brown: '#92400E',
};

export const normalizeCapColor = (color?: string | null): string | undefined => {
    if (!color) return undefined;
    const key = color.trim().toLowerCase();
    return CAP_COLOR_NAMES[key] || color;
};

// Map sample types to visual representations (Specimen Types)
const getSampleConfig = (sampleType: string, labColors: Record<string, string> = {}): SampleConfig => {
    const type = sampleType?.toLowerCase().trim() || '';
    const has = (...keys: string[]) => keys.some(k => type.includes(k));
    // Whole-word match, for abbreviations short enough to appear inside other
    // words ('ct' is a substring of 'lactate', 'pet' of 'competitive', ...).
    const hasWord = (...keys: string[]) =>
        keys.some(k => new RegExp(`(^|[^a-z])${k}([^a-z]|$)`).test(type));

    // Lab-configured override replaces the cap colour only; the container shape
    // still follows the sample type.
    const labColorOverride = findLabColorOverride(type, labColors);
    const resolve = (config: SampleConfig): SampleConfig =>
        labColorOverride ? { ...config, cap: labColorOverride } : config;

    // --- Non-specimen: nothing is collected, so draw no container ---
    if (has('no sample', 'no specimen', 'not required')) {
        return resolve({ type: 'none', cap: '#9CA3AF', label: 'No Sample Required', gradient: 'from-gray-400 to-gray-500' });
    }

    // --- Imaging. Must precede the scope checks: 'fluoroscopy' contains 'scopy'. ---
    if (has('x ray', 'x-ray', 'xray')) {
        return resolve({ type: 'radiology-xray', cap: '#1D4ED8', label: 'X-Ray', gradient: 'from-blue-600 to-blue-700' });
    }
    if (hasWord('ct') || has('computed tomography')) {
        return resolve({ type: 'radiology-ct', cap: '#0F766E', label: 'CT Scan', gradient: 'from-teal-600 to-teal-700' });
    }
    if (has('usg', 'ultrasound', 'sonograph', 'doppler')) {
        return resolve({ type: 'radiology-usg', cap: '#7C3AED', label: 'USG', gradient: 'from-violet-600 to-violet-700' });
    }
    if (hasWord('mri', 'pet') || has('magnetic resonance', 'mammograph', 'dexa', 'bone densit', 'fluoroscop', 'angiograph')) {
        return resolve({ type: 'radiology-scan', cap: '#4338CA', label: 'Imaging', gradient: 'from-indigo-600 to-indigo-700' });
    }

    // --- Physiological recordings and scope procedures ---
    if (hasWord('ecg', 'ekg', 'eeg') || has('electrocardio', 'electroencephalo')) {
        return resolve({ type: 'procedure-trace', cap: '#BE123C', label: 'Recording', gradient: 'from-rose-600 to-rose-700' });
    }
    if (has('scopy', 'endoscop', 'colonoscop', 'bronchoscop')) {
        return resolve({ type: 'procedure-scope', cap: '#0E7490', label: 'Scope Procedure', gradient: 'from-cyan-700 to-cyan-800' });
    }

    // --- Non-blood specimen containers ---
    if (has('urine')) {
        return resolve({ type: 'urine', cap: '#EAB308', label: 'Urine Cup', gradient: 'from-yellow-500 to-yellow-600' });
    }
    if (has('stool', 'faece', 'fece')) {
        return resolve({ type: 'jar', cap: '#92400E', label: 'Stool Container', gradient: 'from-amber-800 to-amber-900', bodyFill: '#FEF3C7', contentFill: '#92400E' });
    }
    if (has('sputum', 'bronchial wash', 'gastric lavage')) {
        return resolve({ type: 'jar', cap: '#64748B', label: 'Sterile Container', gradient: 'from-slate-500 to-slate-600', bodyFill: '#F1F5F9', contentFill: '#94A3B8' });
    }
    if (has('tissue', 'biopsy', 'histopath', 'fnac')) {
        return resolve({ type: 'jar', cap: '#0E7490', label: 'Formalin Jar', gradient: 'from-cyan-700 to-cyan-800', bodyFill: '#ECFEFF', contentFill: '#FDE68A' });
    }
    if (has('swab')) {
        return resolve({ type: 'swab', cap: '#9CA3AF', label: 'Swab', gradient: 'from-gray-400 to-gray-500' });
    }
    // Sterile additive-free tube — CSF and serous fluids are not vacutainer draws
    if (has('csf', 'cerebrospinal', 'body fluid', 'ascitic', 'pleural', 'synovial', 'peritoneal')) {
        return resolve({ type: 'vacutainer', cap: '#E2E8F0', label: 'Sterile Plain Tube', gradient: 'from-slate-200 to-slate-300' });
    }

    // --- Vacutainer caps, most specific additive first.
    // Order is load-bearing: every '<additive> Plasma' value also contains
    // 'plasma', so the additive branches MUST be tested before the generic
    // plasma/heparin branch, or Fluoride and Citrated Plasma silently render as
    // green heparin tops.
    let capConfig = DEFAULT_VACUTAINER_CAPS.red;

    if (has('edta', 'purple', 'lavender', 'hba1c', 'hb1ac', 'cbc', 'haematolog', 'hematolog', 'whole blood', 'capillary')) {
        capConfig = DEFAULT_VACUTAINER_CAPS.purple;
    } else if (has('fluoride', 'oxalate', 'gray', 'grey', 'glucose', 'sugar', 'lactate')) {
        capConfig = DEFAULT_VACUTAINER_CAPS.gray;
    } else if (has('citrate', 'coagulation', 'light blue', 'aptt', 'prothrombin')) {
        capConfig = DEFAULT_VACUTAINER_CAPS.lightBlue;
    } else if (has('trace element', 'heavy metal', 'royal blue')) {
        capConfig = DEFAULT_VACUTAINER_CAPS.royalBlue;
    } else if (has('acd', 'blood culture')) {
        capConfig = DEFAULT_VACUTAINER_CAPS.yellow;
    } else if (has('serum', 'sst', 'gold', 'tiger', 'yellow', 'thyroid', 'tsh', 'hormone', 'biochem')) {
        capConfig = DEFAULT_VACUTAINER_CAPS.gold;
    } else if (has('plasma', 'green', 'heparin')) {
        capConfig = DEFAULT_VACUTAINER_CAPS.green;
    } else if (has('blood', 'red')) {
        capConfig = DEFAULT_VACUTAINER_CAPS.red;
    }

    return resolve({ type: 'vacutainer', ...capConfig });
};

// Single source of truth for "what colour would this sample type be with no lab
// override?" — use this instead of re-declaring a defaults map elsewhere.
export const getDefaultSampleCapColor = (sampleType: string): string =>
    getSampleConfig(sampleType, {}).cap;

export const getSampleContainerLabel = (sampleType: string): string =>
    getSampleConfig(sampleType, {}).label;

// Find matching lab color override for a sample type
function findLabColorOverride(sampleType: string, labColors: Record<string, string>): string | null {
    if (!labColors || Object.keys(labColors).length === 0) return null;

    const type = sampleType.toLowerCase();

    // Direct match
    if (labColors[type]) return labColors[type];

    // Fall back to substring keys, longest (most specific) first. Object key
    // order is not meaningful here: a lab that configures both 'plasma' and
    // 'fluoride plasma' must get the fluoride colour for 'Fluoride Plasma',
    // not whichever key happened to be inserted first.
    const match = Object.keys(labColors)
        .filter(key => type.includes(key.toLowerCase()))
        .sort((a, b) => b.length - a.length)[0];

    return match ? labColors[match] : null;
}

const VacutainerTube: React.FC<{ config: any; size: string }> = ({ config, size }) => {
    const sizes = {
        sm: { width: 20, height: 40, capHeight: 8 },
        md: { width: 28, height: 56, capHeight: 12 },
        lg: { width: 36, height: 72, capHeight: 16 },
    };

    const { width, height, capHeight } = sizes[size as keyof typeof sizes];
    // '#' is not valid inside a url(#id) reference — strip it from the cap hex
    const gradId = `tube-grad-${String(config.cap).replace(/[^a-zA-Z0-9]/g, '')}`;

    return (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="inline-block" style={{ overflow: 'visible' }}>
            <defs>
                <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" style={{ stopColor: '#F3F4F6', stopOpacity: 0.9 }} />
                    <stop offset="50%" style={{ stopColor: '#FFFFFF', stopOpacity: 1 }} />
                    <stop offset="100%" style={{ stopColor: '#F3F4F6', stopOpacity: 0.9 }} />
                </linearGradient>
            </defs>

            {/* Glass tube body */}
            <rect
                x={width * 0.15}
                y={capHeight}
                width={width * 0.7}
                height={height - capHeight}
                rx={width * 0.1}
                fill={`url(#${gradId})`}
                stroke="#D1D5DB"
                strokeWidth="0.5"
            />

            {/* Cap — stroked so pale caps (sterile plain tube) stay visible */}
            <rect
                x={0}
                y={0}
                width={width}
                height={capHeight}
                rx={2}
                fill={config.cap}
                stroke="rgba(0,0,0,0.18)"
                strokeWidth="0.5"
            />
            {/* Cap highlight */}
            <rect
                x={width * 0.1}
                y={2}
                width={width * 0.2}
                height={capHeight - 4}
                fill="white"
                opacity="0.3"
                rx={1}
            />
        </svg>
    );
};

const UrineContainer: React.FC<{ config: any; size: string }> = ({ config, size }) => {
    const sizes = {
        sm: { width: 28, height: 28, capHeight: 6 },
        md: { width: 36, height: 36, capHeight: 8 },
        lg: { width: 44, height: 44, capHeight: 10 },
    };

    const { width, height, capHeight } = sizes[size as keyof typeof sizes];

    return (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="inline-block" style={{ overflow: 'visible' }}>
            <defs>
                <linearGradient id="urine-liquid-grad" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" style={{ stopColor: '#FDE68A', stopOpacity: 0.6 }} />
                    <stop offset="100%" style={{ stopColor: '#F59E0B', stopOpacity: 0.9 }} />
                </linearGradient>
            </defs>

            {/* Cup Body (Transparent plastic look) */}
            <path
                d={`M ${width * 0.15} ${capHeight} 
                   L ${width * 0.25} ${height} 
                   L ${width * 0.75} ${height} 
                   L ${width * 0.85} ${capHeight} Z`}
                fill="#F3F4F6"
                fillOpacity="0.4"
                stroke="#D1D5DB"
                strokeWidth="1"
            />

            {/* Liquid inside */}
            <path
                d={`M ${width * 0.22} ${capHeight + (height - capHeight) * 0.4} 
                   L ${width * 0.3} ${height - 2} 
                   L ${width * 0.7} ${height - 2} 
                   L ${width * 0.78} ${capHeight + (height - capHeight) * 0.4} Z`}
                fill="url(#urine-liquid-grad)"
            />

            {/* Screw Cap */}
            <rect
                x={0}
                y={0}
                width={width}
                height={capHeight}
                rx={1.5}
                fill={config.cap || '#DC2626'}
            />
            {/* Cap Ridges */}
            {[0.2, 0.4, 0.6, 0.8].map((pos) => (
                <line
                    key={pos}
                    x1={width * pos} y1={1}
                    x2={width * pos} y2={capHeight - 1}
                    stroke="rgba(0,0,0,0.1)"
                    strokeWidth="1"
                />
            ))}
        </svg>
    );
};

// Wide-mouth screw-cap jar: stool, sputum/sterile containers, formalin jars
const ScrewCapContainer: React.FC<{ config: any; size: string }> = ({ config, size }) => {
    const sizes = {
        sm: { width: 28, height: 32, capHeight: 6 },
        md: { width: 36, height: 40, capHeight: 8 },
        lg: { width: 44, height: 48, capHeight: 10 },
    };

    const { width, height, capHeight } = sizes[size as keyof typeof sizes];

    return (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="inline-block" style={{ overflow: 'visible' }}>
            {/* Wide container body */}
            <path
                d={`M ${width * 0.1} ${capHeight} 
                   L ${width * 0.2} ${height} 
                   L ${width * 0.8} ${height} 
                   L ${width * 0.9} ${capHeight} Z`}
                fill={config.bodyFill || '#FEF3C7'}
                fillOpacity="0.5"
                stroke="#D4D4D8"
                strokeWidth="1"
            />

            {/* Specimen content */}
            <path
                d={`M ${width * 0.22} ${capHeight + (height - capHeight) * 0.5}
                   L ${width * 0.3} ${height - 2}
                   L ${width * 0.7} ${height - 2}
                   L ${width * 0.78} ${capHeight + (height - capHeight) * 0.5} Z`}
                fill={config.contentFill || '#92400E'}
                fillOpacity="0.6"
            />

            {/* Screw cap */}
            <rect
                x={0}
                y={0}
                width={width}
                height={capHeight}
                rx={1.5}
                fill={config.cap || '#92400E'}
            />
            {/* Cap Ridges */}
            {[0.2, 0.4, 0.6, 0.8].map((pos) => (
                <line
                    key={pos}
                    x1={width * pos} y1={1}
                    x2={width * pos} y2={capHeight - 1}
                    stroke="rgba(0,0,0,0.1)"
                    strokeWidth="1"
                />
            ))}
        </svg>
    );
};

const SwabIcon: React.FC<{ config: any; size: string }> = ({ config, size }) => {
    const sizes = {
        sm: { width: 20, height: 40 },
        md: { width: 26, height: 56 },
        lg: { width: 32, height: 72 },
    };

    const { width, height } = sizes[size as keyof typeof sizes];

    return (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="inline-block">
            {/* Swab stick */}
            <rect
                x={width * 0.4}
                y={height * 0.3}
                width={width * 0.2}
                height={height * 0.65}
                fill="#D1D5DB"
                rx={width * 0.05}
            />

            {/* Cotton tip */}
            <ellipse
                cx={width * 0.5}
                cy={height * 0.15}
                rx={width * 0.35}
                ry={height * 0.15}
                fill="white"
                stroke="#E5E7EB"
                strokeWidth="1"
            />

            {/* Tube */}
            <rect
                x={width * 0.15}
                y={height * 0.35}
                width={width * 0.7}
                height={height * 0.6}
                rx={width * 0.1}
                fill="none"
                stroke={config.cap}
                strokeWidth="2"
                opacity="0.3"
            />
        </svg>
    );
};

const RadiologyIcon: React.FC<{ config: any; size: string; mode: 'xray' | 'ct' | 'usg' | 'scan' }> = ({ config, size, mode }) => {
    const sizes = {
        sm: { width: 26, height: 26 },
        md: { width: 34, height: 34 },
        lg: { width: 42, height: 42 },
    };

    const { width, height } = sizes[size as keyof typeof sizes];
    const cx = width / 2;
    const cy = height / 2;
    const stroke = config.cap || '#1D4ED8';

    if (mode === 'ct') {
        return (
            <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="inline-block">
                <circle cx={cx} cy={cy} r={width * 0.38} fill="white" stroke={stroke} strokeWidth="2" />
                <circle cx={cx} cy={cy} r={width * 0.18} fill="none" stroke={stroke} strokeWidth="2" strokeDasharray="2 2" />
                <rect x={width * 0.14} y={height * 0.43} width={width * 0.12} height={height * 0.14} rx="2" fill={stroke} opacity="0.8" />
            </svg>
        );
    }

    // Generic imaging: MRI, PET, mammography, DEXA, fluoroscopy, angiography
    if (mode === 'scan') {
        return (
            <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="inline-block">
                <rect x={width * 0.08} y={height * 0.18} width={width * 0.84} height={height * 0.64} rx={width * 0.22} fill="white" stroke={stroke} strokeWidth="2" />
                <rect x={width * 0.3} y={height * 0.06} width={width * 0.4} height={height * 0.88} rx="3" fill="white" stroke={stroke} strokeWidth="1.5" />
                <circle cx={cx} cy={cy} r={width * 0.1} fill={stroke} opacity="0.75" />
            </svg>
        );
    }

    if (mode === 'usg') {
        return (
            <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="inline-block">
                <rect x={width * 0.12} y={height * 0.12} width={width * 0.58} height={height * 0.5} rx="4" fill="white" stroke={stroke} strokeWidth="2" />
                <path d={`M ${width * 0.74} ${height * 0.46} Q ${width * 0.88} ${height * 0.58} ${width * 0.78} ${height * 0.8}`} fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" />
                <path d={`M ${width * 0.26} ${height * 0.42} Q ${width * 0.38} ${height * 0.26} ${width * 0.52} ${height * 0.42}`} fill="none" stroke={stroke} strokeWidth="2" />
            </svg>
        );
    }

    return (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="inline-block">
            <rect x={width * 0.12} y={height * 0.12} width={width * 0.76} height={height * 0.76} rx="5" fill="white" stroke={stroke} strokeWidth="2" />
            <line x1={width * 0.28} y1={height * 0.24} x2={width * 0.28} y2={height * 0.76} stroke={stroke} strokeWidth="2" />
            <line x1={width * 0.72} y1={height * 0.24} x2={width * 0.72} y2={height * 0.76} stroke={stroke} strokeWidth="2" />
            <line x1={width * 0.22} y1={height * 0.5} x2={width * 0.78} y2={height * 0.5} stroke={stroke} strokeWidth="2" />
        </svg>
    );
};

const ProcedureIcon: React.FC<{ config: any; size: string; mode: 'trace' | 'scope' }> = ({ config, size, mode }) => {
    const sizes = {
        sm: { width: 26, height: 26 },
        md: { width: 34, height: 34 },
        lg: { width: 42, height: 42 },
    };

    const { width, height } = sizes[size as keyof typeof sizes];
    const stroke = config.cap || '#BE123C';

    // ECG / EEG — a waveform on a monitor, no specimen involved
    if (mode === 'trace') {
        return (
            <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="inline-block">
                <rect x={width * 0.08} y={height * 0.16} width={width * 0.84} height={height * 0.6} rx="4" fill="white" stroke={stroke} strokeWidth="2" />
                <path
                    d={`M ${width * 0.18} ${height * 0.48} L ${width * 0.34} ${height * 0.48} L ${width * 0.42} ${height * 0.28} L ${width * 0.52} ${height * 0.66} L ${width * 0.6} ${height * 0.48} L ${width * 0.82} ${height * 0.48}`}
                    fill="none"
                    stroke={stroke}
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
                <line x1={width * 0.34} y1={height * 0.88} x2={width * 0.66} y2={height * 0.88} stroke={stroke} strokeWidth="2" strokeLinecap="round" />
            </svg>
        );
    }

    // Endoscopy / colonoscopy / bronchoscopy — flexible scope with a lit tip
    return (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="inline-block">
            <path
                d={`M ${width * 0.18} ${height * 0.82} Q ${width * 0.2} ${height * 0.34} ${width * 0.52} ${height * 0.3} Q ${width * 0.82} ${height * 0.26} ${width * 0.8} ${height * 0.6}`}
                fill="none"
                stroke={stroke}
                strokeWidth="3"
                strokeLinecap="round"
            />
            <circle cx={width * 0.8} cy={height * 0.68} r={width * 0.11} fill={stroke} />
            <circle cx={width * 0.8} cy={height * 0.68} r={width * 0.04} fill="white" />
            <rect x={width * 0.08} y={height * 0.78} width={width * 0.22} height={height * 0.16} rx="2" fill={stroke} opacity="0.8" />
        </svg>
    );
};

// Tests that need no specimen at all — draw an explicit "nothing to collect"
// marker rather than defaulting to a blood tube.
const NoSpecimenIcon: React.FC<{ config: any; size: string }> = ({ config, size }) => {
    const sizes = {
        sm: { width: 24, height: 24 },
        md: { width: 32, height: 32 },
        lg: { width: 40, height: 40 },
    };

    const { width, height } = sizes[size as keyof typeof sizes];
    const stroke = config.cap || '#9CA3AF';
    const r = width * 0.38;

    return (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="inline-block">
            <circle cx={width / 2} cy={height / 2} r={r} fill="white" stroke={stroke} strokeWidth="2" strokeDasharray="3 2.5" />
            <line
                x1={width / 2 - r * 0.6} y1={height / 2 + r * 0.6}
                x2={width / 2 + r * 0.6} y2={height / 2 - r * 0.6}
                stroke={stroke} strokeWidth="2" strokeLinecap="round"
            />
        </svg>
    );
};

export const SampleTypeIndicator: React.FC<SampleTypeIndicatorProps> = ({
    sampleType,
    sampleColor,
    size = 'md',
    showLabel = false,
    className = '',
    labColors: propLabColors,
}) => {
    const { colors: contextLabColors } = useSampleTypeColors();
    const labColors = propLabColors ?? contextLabColors;
    const baseConfig = getSampleConfig(sampleType, labColors);
    // Explicit per-record colour beats both the lab config and the defaults
    const resolvedColor = normalizeCapColor(sampleColor);
    const config = resolvedColor ? { ...baseConfig, cap: resolvedColor } : baseConfig;

    const renderIcon = () => {
        switch (config.type) {
            case 'urine':
                return <UrineContainer config={config} size={size} />;
            case 'jar':
                return <ScrewCapContainer config={config} size={size} />;
            case 'swab':
                return <SwabIcon config={config} size={size} />;
            case 'radiology-xray':
                return <RadiologyIcon config={config} size={size} mode="xray" />;
            case 'radiology-ct':
                return <RadiologyIcon config={config} size={size} mode="ct" />;
            case 'radiology-usg':
                return <RadiologyIcon config={config} size={size} mode="usg" />;
            case 'radiology-scan':
                return <RadiologyIcon config={config} size={size} mode="scan" />;
            case 'procedure-trace':
                return <ProcedureIcon config={config} size={size} mode="trace" />;
            case 'procedure-scope':
                return <ProcedureIcon config={config} size={size} mode="scope" />;
            case 'none':
                return <NoSpecimenIcon config={config} size={size} />;
            case 'vacutainer':
            default:
                return <VacutainerTube config={config} size={size} />;
        }
    };

    return (
        <div className={`inline-flex items-center gap-1.5 ${className}`}>
            <div className="flex items-center">
                {renderIcon()}
            </div>
            {showLabel && (
                <span className="text-xs font-medium text-gray-700 ml-1">
                    {config.label}
                </span>
            )}
        </div>
    );
};

// Helper component for displaying multiple sample types
export const SampleTypeGroup: React.FC<{
    samples: Array<{ sampleType: string; sampleColor?: string; count?: number }>;
    size?: 'sm' | 'md' | 'lg';
    maxDisplay?: number;
    labColors?: Record<string, string>;
}> = ({ samples, size = 'sm', maxDisplay = 3, labColors }) => {
    const uniqueSamples = Array.from(
        new Map(samples.map(s => [s.sampleType, s])).values()
    ).slice(0, maxDisplay);

    const remaining = samples.length - uniqueSamples.length;

    return (
        <div className="inline-flex items-center gap-1">
            {uniqueSamples.map((sample, idx) => (
                <div key={idx} className="relative">
                    <SampleTypeIndicator
                        sampleType={sample.sampleType}
                        sampleColor={sample.sampleColor}
                        size={size}
                        labColors={labColors}
                    />
                    {sample.count && sample.count > 1 && (
                        <span className="absolute -top-1 -right-1 bg-blue-500 text-white text-[10px] rounded-full w-4 h-4 flex items-center justify-center font-bold">
                            {sample.count}
                        </span>
                    )}
                </div>
            ))}
            {remaining > 0 && (
                <span className="text-xs text-gray-500 ml-1">+{remaining}</span>
            )}
        </div>
    );
};

export default SampleTypeIndicator;
