import React, { useMemo } from 'react';
import { Printer } from 'lucide-react';
import JsBarcode from 'jsbarcode';
import {
  DEFAULT_LABEL_LAYOUT,
  LABEL_LAYOUT_PRESETS,
  getLabelLayoutPreset,
  normalizeLabelLayout,
  resolveLabelPage,
  type LabelLayout,
} from '../../utils/labelLayout';
import { generateBarcodeLabelsPDFBlob, generateBarcodeSync } from '../../utils/barcodeGenerator';

interface BarcodeLabelLayoutConfigProps {
  value: LabelLayout | null | undefined;
  onChange: (layout: LabelLayout) => void;
}

const numberInputClass =
  'w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm focus:ring-blue-500 focus:border-blue-500';

interface NumberFieldProps {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  step?: number;
  min?: number;
  /** Rendered as the placeholder when the value is null (auto-derived). */
  autoHint?: string;
  disabled?: boolean;
}

const NumberField: React.FC<NumberFieldProps> = ({ label, value, onChange, step = 0.5, min = 0, autoHint, disabled }) => (
  <div>
    <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
    <input
      type="number"
      step={step}
      min={min}
      disabled={disabled}
      placeholder={autoHint}
      value={value === null ? '' : value}
      onChange={(e) => onChange(e.target.value === '' ? null : parseFloat(e.target.value))}
      className={`${numberInputClass} ${disabled ? 'bg-gray-50 text-gray-400' : ''}`}
    />
  </div>
);

/**
 * Editor for the lab's barcode label geometry.
 *
 * Everything here feeds a single LabelLayout object that drives both the
 * browser PDF and the ZPL sent to thermal printers, so what staff see in the
 * preview is what comes out of the printer at 100% scale.
 */
const BarcodeLabelLayoutConfig: React.FC<BarcodeLabelLayoutConfigProps> = ({ value, onChange }) => {
  const layout = useMemo(() => normalizeLabelLayout(value ?? DEFAULT_LABEL_LAYOUT), [value]);
  const page = useMemo(() => resolveLabelPage(layout), [layout]);

  // Any manual edit detaches the layout from its preset.
  const update = (patch: Partial<LabelLayout>) =>
    onChange(normalizeLabelLayout({ ...layout, ...patch, preset: 'custom' }));

  const applyPreset = (key: string) => {
    const found = getLabelLayoutPreset(key);
    if (found) onChange({ ...found.layout });
  };

  const isSheet = page.perPage > 1;

  const previewScale = Math.min(320 / page.pageWidth, 260 / page.pageHeight);

  const handlePrintTest = () => {
    const sample = Array.from({ length: page.perPage }, (_, i) => ({
      sampleId: `TEST-${String(i + 1).padStart(3, '0')}`,
      barcodeDataUrl: generateBarcodeSync(JsBarcode, `TEST${String(i + 1).padStart(3, '0')}`, {
        width: 2,
        height: 50,
        displayValue: false,
        margin: 5,
      }),
      metadata: {
        sampleType: 'Serum',
        patientName: 'Test Patient',
        collectionDate: '01-Jan-26',
        collectionTime: '09:30',
        gender: 'M',
        age: 34,
        referredBy: 'Dr. Test',
        barcodeNumber: `TEST${String(i + 1).padStart(3, '0')}`,
      },
    }));

    const url = URL.createObjectURL(
      generateBarcodeLabelsPDFBlob(sample, { title: 'Label layout test', layout })
    );
    const win = window.open(url, '_blank');
    if (!win) {
      alert('Browser blocked the preview window. Please allow pop-ups for this site.');
      URL.revokeObjectURL(url);
      return;
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <div className="space-y-5">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Label stock</label>
        <select
          value={getLabelLayoutPreset(layout.preset) ? layout.preset : 'custom'}
          onChange={(e) => applyPreset(e.target.value)}
          className="w-full md:w-2/3 px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-blue-500 focus:border-blue-500"
        >
          {LABEL_LAYOUT_PRESETS.map((preset) => (
            <option key={preset.key} value={preset.key}>
              {preset.label}
            </option>
          ))}
          <option value="custom">Custom</option>
        </select>
        <p className="text-xs text-gray-500 mt-1">
          {getLabelLayoutPreset(layout.preset)?.description ??
            'Custom geometry. Adjust the fields below to match your label stock.'}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-6">
        <div className="space-y-4">
          <div>
            <h5 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Label</h5>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <NumberField label="Width (mm)" value={layout.widthMm} onChange={(v) => update({ widthMm: v ?? layout.widthMm })} />
              <NumberField label="Height (mm)" value={layout.heightMm} onChange={(v) => update({ heightMm: v ?? layout.heightMm })} />
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Orientation</label>
                <select
                  value={layout.orientation}
                  onChange={(e) => update({ orientation: e.target.value as LabelLayout['orientation'] })}
                  className={numberInputClass}
                >
                  <option value="landscape">Landscape</option>
                  <option value="portrait">Portrait</option>
                </select>
              </div>
              <NumberField
                label="Barcode height (mm)"
                value={layout.barcodeHeightMm}
                onChange={(v) => update({ barcodeHeightMm: v })}
                autoHint="Auto"
              />
            </div>
          </div>

          <div>
            <h5 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Sheet</h5>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <NumberField label="Columns" value={layout.columns} step={1} min={1} onChange={(v) => update({ columns: v ?? 1 })} />
              <NumberField label="Rows" value={layout.rows} step={1} min={1} onChange={(v) => update({ rows: v ?? 1 })} />
              <NumberField label="Column gap (mm)" value={layout.columnGapMm} onChange={(v) => update({ columnGapMm: v ?? 0 })} disabled={layout.columns < 2} />
              <NumberField label="Row gap (mm)" value={layout.rowGapMm} onChange={(v) => update({ rowGapMm: v ?? 0 })} disabled={layout.rows < 2} />
              <NumberField label="Sheet width (mm)" value={layout.pageWidthMm} onChange={(v) => update({ pageWidthMm: v })} autoHint="Fit label" />
              <NumberField label="Sheet height (mm)" value={layout.pageHeightMm} onChange={(v) => update({ pageHeightMm: v })} autoHint="Fit label" />
              <NumberField label="Top margin (mm)" value={layout.pageMarginTopMm} onChange={(v) => update({ pageMarginTopMm: v ?? 0 })} disabled={!isSheet} />
              <NumberField label="Left margin (mm)" value={layout.pageMarginLeftMm} onChange={(v) => update({ pageMarginLeftMm: v ?? 0 })} disabled={!isSheet} />
            </div>
          </div>

          <div>
            <h5 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Content</h5>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <NumberField label="Padding X (mm)" value={layout.paddingXMm} step={0.25} onChange={(v) => update({ paddingXMm: v ?? 0 })} />
              <NumberField label="Padding Y (mm)" value={layout.paddingYMm} step={0.25} onChange={(v) => update({ paddingYMm: v ?? 0 })} />
              <NumberField label="Font scale" value={layout.fontScale} step={0.05} min={0.4} onChange={(v) => update({ fontScale: v ?? 1 })} />
              <NumberField label="Printer DPI" value={layout.dpi} step={1} min={96} onChange={(v) => update({ dpi: v ?? 203 })} />
              <NumberField
                label="ZPL feed length (mm)"
                value={layout.zplLabelLengthMm}
                onChange={(v) => update({ zplLabelLengthMm: v })}
                autoHint="Label height"
              />
            </div>
            <p className="text-xs text-gray-400 mt-2">
              DPI and feed length only affect thermal printers driven through the LIMS Utility (ZPL). The browser PDF uses the millimetre values directly.
            </p>
          </div>
        </div>

        <div className="lg:w-[340px]">
          <h5 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Preview</h5>
          <div className="border border-gray-200 rounded-lg p-3 bg-gray-50">
            <div
              className="relative mx-auto bg-white border border-gray-300 shadow-sm"
              style={{ width: page.pageWidth * previewScale, height: page.pageHeight * previewScale }}
            >
              {Array.from({ length: page.perPage }, (_, i) => {
                const origin = page.cellOrigin(i);
                return (
                  <div
                    key={i}
                    className="absolute border border-dashed border-blue-400 bg-blue-50/60"
                    style={{
                      left: origin.x * previewScale,
                      top: origin.y * previewScale,
                      width: page.cellWidth * previewScale,
                      height: page.cellHeight * previewScale,
                    }}
                  />
                );
              })}
            </div>
            <p className="text-xs text-gray-600 mt-3 text-center">
              {page.perPage} label{page.perPage === 1 ? '' : 's'} per page &middot;{' '}
              {page.pageWidth.toFixed(1)} &times; {page.pageHeight.toFixed(1)} mm
            </p>
            <button
              type="button"
              onClick={handlePrintTest}
              className="mt-3 w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-blue-700 bg-white border border-blue-300 rounded-md hover:bg-blue-50"
            >
              <Printer className="h-4 w-4" />
              Open test sheet
            </button>
            <p className="text-xs text-gray-400 mt-2 text-center">
              Print it at 100% scale (no "fit to page") and measure a label to confirm the stock matches.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BarcodeLabelLayoutConfig;
