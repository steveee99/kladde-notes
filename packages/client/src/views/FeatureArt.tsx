import type { ReactNode } from 'react';

/*
 * Small pictures of the features for the features dialog: drawn with the Material 3 color roles, so they follow the
 * color scheme, and inline, because the CSP allows no images from elsewhere. viewBox 160 × 90.
 */

export type FeatureArtId =
  | 'para'
  | 'zettel'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'review'
  | 'heatmap'
  | 'favorites'
  | 'icons'
  | 'writingStats'
  | 'focus'
  | 'recipe'
  | 'database'
  | 'presentation'
  | 'callouts'
  | 'memory'
  | 'mcp'
  | 'notifications'
  | 'calendar'
  | 'shortcuts'
  | 'confluence';

/** A line of text as a rounded bar */
const Bar = ({ x, y, w, h = 4, className = 'fill-on-surface-variant', o = 0.45 }: { x: number; y: number; w: number; h?: number; className?: string; o?: number }) => (
  <rect x={x} y={y} width={w} height={h} rx={h / 2} className={className} fillOpacity={o} />
);

/** A surface card */
const Card = ({ x, y, w, h, r = 6, className = 'fill-surface-container-lowest' }: { x: number; y: number; w: number; h: number; r?: number; className?: string }) => (
  <rect x={x} y={y} width={w} height={h} rx={r} className={className} />
);

const ART: Record<FeatureArtId, ReactNode> = {
  para: (
    <>
      {(['fill-primary', 'fill-tertiary', 'fill-secondary', 'fill-outline'] as const).map((c, i) => (
        <g key={c}>
          <Card x={12 + i * 35} y={14} w={31} h={62} />
          <rect x={12 + i * 35} y={14} width={31} height={12} rx={6} className={c} />
          <rect x={12 + i * 35} y={20} width={31} height={6} className={c} />
          <text x={27.5 + i * 35} y={23.5} textAnchor="middle" fontSize={8} fontWeight={700} className="fill-surface">
            {'PARA'[i]}
          </text>
          <Bar x={17 + i * 35} y={33} w={21} />
          <Bar x={17 + i * 35} y={41} w={16} />
          <Bar x={17 + i * 35} y={49} w={19} />
        </g>
      ))}
    </>
  ),
  zettel: (
    <>
      <path d="M42 30 L80 58 L118 28 M80 58 L118 66" className="stroke-primary" strokeWidth={2} fill="none" strokeOpacity={0.7} />
      {[
        [20, 14],
        [58, 46],
        [98, 12],
        [98, 52],
      ].map(([x, y], i) => (
        <g key={i}>
          <Card x={x} y={y} w={42} h={26} r={4} />
          <Bar x={x + 5} y={y + 5} w={20} h={4} className="fill-primary" o={0.9} />
          <Bar x={x + 5} y={y + 13} w={32} h={3} />
          <Bar x={x + 5} y={y + 19} w={24} h={3} />
        </g>
      ))}
    </>
  ),
  daily: (
    <>
      <Card x={44} y={10} w={72} h={70} />
      <rect x={44} y={10} width={72} height={18} rx={6} className="fill-primary" />
      <rect x={44} y={22} width={72} height={6} className="fill-primary" />
      <text x={80} y={23} textAnchor="middle" fontSize={9} fontWeight={600} className="fill-on-primary">
        MO
      </text>
      <text x={80} y={52} textAnchor="middle" fontSize={22} fontWeight={600} className="fill-on-surface">
        19
      </text>
      <Bar x={54} y={60} w={52} />
      <Bar x={54} y={68} w={38} />
    </>
  ),
  weekly: (
    <>
      <Card x={22} y={14} w={116} h={62} />
      <text x={32} y={30} fontSize={9} fontWeight={600} className="fill-primary">
        W47
      </text>
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <g key={i}>
          <rect x={32 + i * 14.5} y={38} width={11} height={28} rx={3} className={i === 3 ? 'fill-primary' : 'fill-secondary-container'} />
          <Bar x={34 + i * 14.5} y={58} w={7} h={3} className={i === 3 ? 'fill-on-primary' : 'fill-on-secondary-container'} o={0.7} />
        </g>
      ))}
    </>
  ),
  monthly: (
    <>
      <Card x={40} y={8} w={80} h={74} />
      <rect x={40} y={8} width={80} height={16} rx={6} className="fill-tertiary" />
      <rect x={40} y={18} width={80} height={6} className="fill-tertiary" />
      <text x={80} y={20} textAnchor="middle" fontSize={8} fontWeight={600} className="fill-on-tertiary">
        2026-11
      </text>
      {Array.from({ length: 20 }, (_, i) => (
        <circle key={i} cx={50 + (i % 5) * 15} cy={34 + Math.floor(i / 5) * 12} r={3.5} className={i === 12 ? 'fill-tertiary' : 'fill-on-surface-variant'} fillOpacity={i === 12 ? 1 : 0.3} />
      ))}
    </>
  ),
  review: (
    <>
      <Card x={30} y={10} w={100} h={70} />
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <circle cx={44} cy={24 + i * 14} r={5} className={i < 3 ? 'fill-primary' : 'stroke-outline'} fill={i < 3 ? undefined : 'none'} strokeWidth={1.5} />
          {i < 3 && <path d={`M41.5 ${24 + i * 14} l2 2 l3.5 -4`} className="stroke-on-primary" strokeWidth={1.5} fill="none" strokeLinecap="round" />}
          <Bar x={55} y={22 + i * 14} w={[52, 40, 58, 34][i]} />
        </g>
      ))}
      <circle cx={122} cy={14} r={11} className="fill-tertiary" />
      <text x={122} y={18} textAnchor="middle" fontSize={11} fontWeight={700} className="fill-on-tertiary">
        7
      </text>
    </>
  ),
  heatmap: (
    <>
      <Card x={8} y={14} w={144} h={62} />
      {Array.from({ length: 7 * 17 }, (_, k) => {
        const col = Math.floor(k / 7);
        const row = k % 7;
        const level = (col * 7 + row * 3 + ((col * row) % 5)) % 5;
        return <rect key={k} x={15 + col * 8} y={20 + row * 7.5} width={6} height={6} rx={1.5} className={level ? 'fill-primary' : 'fill-outline-variant'} fillOpacity={level ? 0.2 + level * 0.2 : 0.6} />;
      })}
    </>
  ),
  favorites: (
    <>
      <Card x={30} y={10} w={100} h={70} />
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <path
            transform={`translate(${42} ${26 + i * 18}) scale(0.5)`}
            d="M0 -12 L3.5 -4 L12 -3.5 L5.5 2.5 L7.5 11 L0 6.5 L-7.5 11 L-5.5 2.5 L-12 -3.5 L-3.5 -4 Z"
            className={i < 2 ? 'fill-warn' : 'fill-outline-variant'}
          />
          <Bar x={54} y={24 + i * 18} w={[56, 44, 50][i]} />
        </g>
      ))}
    </>
  ),
  icons: (
    <>
      <Card x={30} y={10} w={100} h={70} />
      {['🚀', '📚', '💡', '🌱'].map((e, i) => (
        <g key={e}>
          <text x={i % 2 ? 50 : 40} y={27 + i * 15} fontSize={10}>
            {e}
          </text>
          <Bar x={(i % 2 ? 50 : 40) + 14} y={22 + i * 15} w={[50, 36, 42, 30][i]} />
        </g>
      ))}
    </>
  ),
  writingStats: (
    <>
      <Card x={30} y={8} w={100} h={74} />
      <Bar x={40} y={18} w={60} h={6} className="fill-on-surface" o={0.8} />
      <Bar x={40} y={30} w={80} />
      <Bar x={40} y={38} w={72} />
      <Bar x={40} y={46} w={76} />
      <rect x={38} y={60} width={84} height={14} rx={7} className="fill-secondary-container" />
      <text x={80} y={69.5} textAnchor="middle" fontSize={7} className="fill-on-secondary-container">
        342 · 1 980 · 2 min
      </text>
    </>
  ),
  focus: (
    <>
      <rect x={0} y={0} width={160} height={90} className="fill-surface-container-lowest" />
      <Bar x={45} y={16} w={70} o={0.15} />
      <Bar x={45} y={24} w={62} o={0.15} />
      <Bar x={45} y={38} w={70} className="fill-on-surface" o={0.85} />
      <Bar x={45} y={46} w={66} className="fill-on-surface" o={0.85} />
      <Bar x={45} y={54} w={48} className="fill-on-surface" o={0.85} />
      <rect x={93} y={52} width={1.5} height={8} className="fill-primary" />
      <Bar x={45} y={68} w={64} o={0.15} />
      <Bar x={45} y={76} w={56} o={0.15} />
    </>
  ),
  recipe: (
    <>
      <Card x={24} y={10} w={112} h={70} />
      <rect x={30} y={16} width={44} height={58} rx={4} className="fill-tertiary-container" />
      {/* A steaming bowl */}
      <path d="M36 48 h32 a16 16 0 0 1 -32 0 Z" className="fill-tertiary" />
      <rect x={34} y={46} width={36} height={3} rx={1.5} className="fill-tertiary" />
      <path d="M45 40 q-3 -4 0 -8 q3 -4 0 -8 M52 40 q-3 -4 0 -8 q3 -4 0 -8 M59 40 q-3 -4 0 -8 q3 -4 0 -8" className="stroke-tertiary" strokeWidth={1.8} fill="none" strokeLinecap="round" strokeOpacity={0.7} />
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <circle cx={84} cy={24 + i * 12} r={2} className="fill-primary" />
          <Bar x={90} y={22 + i * 12} w={[34, 26, 38, 22][i]} />
        </g>
      ))}
    </>
  ),
  database: (
    <>
      <Card x={14} y={12} w={132} h={66} />
      <rect x={14} y={12} width={132} height={14} rx={6} className="fill-surface-container-highest" />
      <rect x={14} y={20} width={132} height={6} className="fill-surface-container-highest" />
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <path d={`M14 ${40 + i * 13} H146`} className="stroke-outline-variant" strokeWidth={1} />
          <Bar x={22} y={31 + i * 13} w={[36, 28, 32][i]} />
          <rect x={70} y={29.5 + i * 13} width={26} height={8} rx={4} className={['fill-primary-container', 'fill-tertiary-container', 'fill-ok-container'][i]} />
          <Bar x={108} y={31 + i * 13} w={[22, 30, 18][i]} />
        </g>
      ))}
      <Bar x={22} y={17} w={24} className="fill-on-surface" o={0.7} />
      <Bar x={70} y={17} w={20} className="fill-on-surface" o={0.7} />
      <Bar x={108} y={17} w={22} className="fill-on-surface" o={0.7} />
      <path d="M64 12 V78 M102 12 V78" className="stroke-outline-variant" strokeWidth={1} />
    </>
  ),
  presentation: (
    <>
      <rect x={18} y={8} width={124} height={70} rx={6} className="fill-primary-container" />
      <Bar x={30} y={20} w={62} h={8} className="fill-on-primary-container" o={0.9} />
      <circle cx={34} cy={40} r={2.5} className="fill-primary" />
      <Bar x={42} y={38} w={48} h={4.5} className="fill-on-primary-container" o={0.6} />
      <circle cx={34} cy={52} r={2.5} className="fill-primary" />
      <Bar x={42} y={50} w={38} h={4.5} className="fill-on-primary-container" o={0.6} />
      <circle cx={34} cy={64} r={2.5} className="fill-primary" />
      <Bar x={42} y={62} w={44} h={4.5} className="fill-on-primary-container" o={0.6} />
      <rect x={100} y={36} width={32} height={32} rx={4} className="fill-tertiary" fillOpacity={0.85} />
      <path d="M104 64 l9 -12 l7 8 l4 -5 l6 9 Z" className="fill-on-tertiary" fillOpacity={0.8} />
      <rect x={58} y={82} width={44} height={6} rx={3} className="fill-surface-container-highest" />
      <circle cx={72} cy={85} r={1.6} className="fill-primary" />
      <circle cx={80} cy={85} r={1.6} className="fill-outline" />
      <circle cx={88} cy={85} r={1.6} className="fill-outline" />
    </>
  ),
  callouts: (
    <>
      <rect x={22} y={10} width={116} height={36} rx={6} className="fill-warn-container" />
      <rect x={22} y={10} width={3.5} height={36} rx={1.75} className="fill-warn" />
      <path d="M36 25 l5 -9 l5 9 Z" className="fill-warn" />
      <Bar x={52} y={18} w={44} h={5} className="fill-on-warn-container" o={0.9} />
      <Bar x={36} y={31} w={88} className="fill-on-warn-container" o={0.55} />
      <Bar x={36} y={38} w={64} className="fill-on-warn-container" o={0.55} />
      <rect x={22} y={52} width={116} height={22} rx={6} className="fill-primary-container" />
      <rect x={22} y={52} width={3.5} height={22} rx={1.75} className="fill-primary" />
      <circle cx={41} cy={63} r={4.5} className="fill-primary" />
      <Bar x={52} y={60.5} w={50} h={5} className="fill-on-primary-container" o={0.9} />
      <path d="M122 60.5 l4 4 l4 -4" className="stroke-on-primary-container" strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  memory: (
    <>
      <path d="M50 45 L80 22 L112 40 L94 70 L58 68 Z M80 22 L94 70 M50 45 L112 40" className="stroke-primary" strokeWidth={1.5} fill="none" strokeOpacity={0.55} />
      {[
        [50, 45, 'fill-primary'],
        [80, 22, 'fill-tertiary'],
        [112, 40, 'fill-primary'],
        [94, 70, 'fill-secondary'],
        [58, 68, 'fill-tertiary'],
      ].map(([x, y, c]) => (
        <circle key={`${x}-${y}`} cx={x as number} cy={y as number} r={7} className={c as string} />
      ))}
      <rect x={114} y={60} width={34} height={14} rx={7} className="fill-warn-container" />
      <text x={131} y={70} textAnchor="middle" fontSize={8} fontWeight={600} className="fill-on-warn-container">
        Rule
      </text>
    </>
  ),
  mcp: (
    <>
      <rect x={18} y={24} width={44} height={40} rx={12} className="fill-primary" />
      <circle cx={32} cy={42} r={4} className="fill-on-primary" />
      <circle cx={48} cy={42} r={4} className="fill-on-primary" />
      <path d="M33 53 q7 5 14 0" className="stroke-on-primary" strokeWidth={2} fill="none" strokeLinecap="round" />
      <path d="M40 24 v-8" className="stroke-primary" strokeWidth={2} />
      <circle cx={40} cy={14} r={3} className="fill-primary" />
      <path d="M66 44 H92" className="stroke-outline" strokeWidth={2} strokeDasharray="4 3" />
      <path d="M88 40 l5 4 l-5 4" className="stroke-outline" strokeWidth={2} fill="none" />
      <Card x={98} y={16} w={46} h={58} />
      <Bar x={105} y={24} w={26} h={5} className="fill-on-surface" o={0.75} />
      <Bar x={105} y={35} w={32} />
      <Bar x={105} y={43} w={28} />
      <Bar x={105} y={51} w={32} />
      <Bar x={105} y={59} w={20} />
    </>
  ),
  notifications: (
    <>
      <rect x={52} y={6} width={56} height={84} rx={10} className="fill-surface-container-lowest stroke-outline-variant" strokeWidth={1.5} />
      <rect x={58} y={22} width={44} height={20} rx={6} className="fill-primary-container" />
      <circle cx={66} cy={32} r={4} className="fill-primary" />
      <Bar x={74} y={27} w={22} h={3.5} className="fill-on-primary-container" o={0.8} />
      <Bar x={74} y={34} w={16} h={3} className="fill-on-primary-container" o={0.5} />
      <rect x={58} y={46} width={44} height={16} rx={6} className="fill-surface-container-high" />
      <Bar x={63} y={52} w={30} h={3.5} />
      <circle cx={104} cy={12} r={7} className="fill-error" />
      <text x={104} y={15} textAnchor="middle" fontSize={8} fontWeight={700} className="fill-on-error">
        3
      </text>
    </>
  ),
  calendar: (
    <>
      <Card x={24} y={10} w={112} h={72} />
      <rect x={24} y={10} width={112} height={14} rx={6} className="fill-secondary-container" />
      <rect x={24} y={18} width={112} height={6} className="fill-secondary-container" />
      {Array.from({ length: 21 }, (_, k) => (
        <rect key={k} x={30 + (k % 7) * 15} y={29 + Math.floor(k / 7) * 17} width={12} height={14} rx={2} className="fill-surface-container-high" />
      ))}
      <rect x={45} y={33} width={12} height={4} rx={2} className="fill-primary" />
      <rect x={90} y={50} width={12} height={4} rx={2} className="fill-tertiary" />
      <rect x={105} y={50} width={12} height={4} rx={2} className="fill-tertiary" />
      <rect x={60} y={67} width={12} height={4} rx={2} className="fill-error" />
    </>
  ),
  shortcuts: (
    <>
      <rect x={52} y={6} width={56} height={84} rx={10} className="fill-surface-container-lowest stroke-outline-variant" strokeWidth={1.5} />
      {(['fill-primary', 'fill-tertiary', 'fill-warn', 'fill-ok', 'fill-secondary', 'fill-error'] as const).map((c, i) => (
        <g key={c}>
          <rect x={58 + (i % 2) * 23} y={16 + Math.floor(i / 2) * 22} width={21} height={19} rx={5} className={c} fillOpacity={0.85} />
          <Bar x={62 + (i % 2) * 23} y={29 + Math.floor(i / 2) * 22} w={10} h={3} className="fill-surface" o={0.9} />
        </g>
      ))}
    </>
  ),
  confluence: (
    <>
      <Card x={14} y={18} w={46} h={56} />
      <Bar x={21} y={26} w={26} h={5} className="fill-on-surface" o={0.75} />
      <Bar x={21} y={37} w={32} />
      <Bar x={21} y={45} w={28} />
      <Bar x={21} y={53} w={32} />
      <path d="M66 46 H92" className="stroke-primary" strokeWidth={2.5} />
      <path d="M87 40 l7 6 l-7 6" className="stroke-primary" strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M110 62 a12 12 0 0 1 -1 -24 a16 16 0 0 1 30 -2 a11 11 0 0 1 4 26 Z"
        className="fill-primary-container stroke-primary"
        strokeWidth={1.5}
      />
      <path d="M118 50 l5 5 l9 -10" className="stroke-primary" strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
};

/** The picture of a feature; `className` sets its size */
export function FeatureArt({ id, className = '' }: { id: FeatureArtId; className?: string }) {
  return (
    <svg viewBox="0 0 160 90" aria-hidden="true" focusable="false" className={`block bg-surface-container ${className}`} preserveAspectRatio="xMidYMid meet">
      {ART[id]}
    </svg>
  );
}
