// M18 (fast preview): says whether the model on screen is a quick preview
// (some curves drawn coarser) or the full render, with a Render button (F6)
// for full detail. Bottom right of the viewport: the breadcrumb and drill-in
// banners use the bottom left, M10a's progress overlay the bottom center.

export interface RenderDetail {
  parts: number;
  reduced: number;
}

interface RenderDetailBadgeProps {
  detail: RenderDetail | null;
  rendering: boolean;
  onRender: () => void;
}

export function renderDetailText(detail: RenderDetail): { label: string; title: string } {
  if (detail.reduced === 0) {
    return { label: 'Full', title: 'Everything on screen is the full render, exactly what OpenSCAD makes.' };
  }
  const which = detail.reduced === detail.parts ? (detail.parts === 1 ? 'The part' : `All ${detail.parts} parts`) : `${detail.reduced} of ${detail.parts} parts`;
  return {
    label: 'Preview',
    title: `${which} on screen ${detail.reduced === 1 && detail.parts === 1 ? 'is' : 'are'} a quick preview: curves are drawn with fewer segments, so round parts look faceted and slightly smaller. Render (F6) draws everything at full detail.`,
  };
}

export function RenderDetailBadge({ detail, rendering, onRender }: RenderDetailBadgeProps) {
  if (!detail || detail.parts === 0) return null;
  const preview = detail.reduced > 0;
  const { label, title } = renderDetailText(detail);
  return (
    <div
      data-testid="render-detail"
      data-detail={preview ? 'preview' : 'full'}
      style={{
        position: 'absolute',
        right: 8,
        bottom: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        zIndex: 4,
        font: '12px system-ui, sans-serif',
      }}
    >
      <span
        title={title}
        style={{
          padding: '3px 8px',
          borderRadius: 4,
          background: preview ? 'rgba(201,138,20,0.92)' : 'rgba(40,44,50,0.85)',
          color: preview ? '#1b1405' : '#cfd3d8',
          fontWeight: preview ? 600 : 400,
          border: preview ? '1px solid #e0a82e' : '1px solid #3a3f47',
        }}
      >
        {label}
        {preview && detail.parts > 1 && detail.reduced < detail.parts ? ` · ${detail.reduced} of ${detail.parts}` : ''}
      </span>
      {preview && (
        <button onClick={onRender} disabled={rendering} title="Render everything at full detail (F6)">
          Render
        </button>
      )}
    </div>
  );
}
