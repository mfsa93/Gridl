import { useId } from "react";

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * The Gridl logo filling up with color from the bottom, for waits on the
 * database. A faint silhouette shows the empty shape; a wave-topped mask rises
 * over it. SVG's own animation drives the mask, since CSS does not reach inside
 * clip paths in every engine. With reduced motion the logo shows half full.
 */
export function LogoLoader({ size = 64, label }: { size?: number; label?: string }) {
  const id = useId().replace(/:/g, "");
  const fill = `logo-fill-${id}`;
  const shade = `logo-bg-${id}`;
  const still = reducedMotion();
  return (
    // Announced only when it carries its own label; a bare logo decorates a status shown elsewhere.
    <div className="logo-loader" role={label ? "status" : undefined} aria-live={label ? "polite" : undefined}>
      <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true">
        <defs>
          <linearGradient id={shade} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#3D8BFF" />
            <stop offset="0.55" stopColor="#2F5BF0" />
            <stop offset="1" stopColor="#4B2FCF" />
          </linearGradient>
          <clipPath id={fill}>
            {/* Clip paths take shapes, not groups: both motions sit on the wave, summed.
                It is twice the logo's width, so sliding one wave length loops without a seam. */}
            <path
              transform={still ? "translate(0 480)" : undefined}
              d="M-1024 40 Q-896 -20 -768 40 T-512 40 T-256 40 T0 40 T256 40 T512 40 T768 40 T1024 40 T1280 40 T1536 40 T1792 40 T2048 40 V1200 H-1024 Z"
            >
              {still ? null : (
                <>
                  <animateTransform
                    attributeName="transform"
                    type="translate"
                    values="0 960; 0 0; 0 0"
                    keyTimes="0; 0.78; 1"
                    calcMode="spline"
                    keySplines="0.45 0.05 0.35 1; 0 0 1 1"
                    dur="2.4s"
                    repeatCount="indefinite"
                  />
                  <animateTransform attributeName="transform" type="translate" from="0 0" to="512 0" dur="1.2s" repeatCount="indefinite" additive="sum" />
                </>
              )}
            </path>
          </clipPath>
        </defs>
        <g className="logo-empty">
          <LogoShapes background="currentColor" mono />
        </g>
        <g clipPath={`url(#${fill})`}>
          <LogoShapes background={`url(#${shade})`} />
        </g>
      </svg>
      {label ? <span>{label}</span> : null}
    </div>
  );
}

/** The app icon without its shadows: rounded square, table card, database badge. */
function LogoShapes({ background, mono = false }: { background: string; mono?: boolean }) {
  // The silhouette draws every part in the text color at two strengths.
  const light = mono ? "currentColor" : "#FFFFFF";
  const tint = mono ? "currentColor" : "#C9D6FF";
  const lightOpacity = mono ? 0.35 : 1;
  return (
    <>
      <rect x="100" y="100" width="824" height="824" rx="186" fill={background} />
      <rect x="226" y="330" width="572" height="430" rx="54" fill={light} fillOpacity={lightOpacity} />
      <rect x="226" y="330" width="572" height="96" fill={tint} fillOpacity={mono ? 0.6 : 1} />
      <rect x="226" y="524" width="572" height="98" fill={mono ? "currentColor" : "#2F6BFF"} fillOpacity={mono ? 0.6 : 0.92} />
      {mono ? null : (
        <g stroke="#B7C5F5" strokeWidth="7">
          <line x1="226" y1="426" x2="798" y2="426" />
          <line x1="226" y1="622" x2="798" y2="622" />
          <line x1="417" y1="330" x2="417" y2="760" />
          <line x1="607" y1="330" x2="607" y2="760" />
        </g>
      )}
      <g transform="translate(662 214)">
        <path d="M0 52 v86 c0 24 46 44 104 44 s104 -20 104 -44 v-86 z" fill={mono ? "currentColor" : "#EEF2FF"} fillOpacity={lightOpacity} />
        <ellipse cx="104" cy="52" rx="104" ry="44" fill={light} fillOpacity={mono ? 0.5 : 1} />
        <ellipse cx="104" cy="52" rx="74" ry="26" fill={tint} fillOpacity={mono ? 0.6 : 1} />
      </g>
    </>
  );
}
