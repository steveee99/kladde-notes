import { useEffect, useState } from 'react';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const SIZE_CLASSES: Record<AvatarSize, string> = {
  xs: 'h-5 w-5 text-[10px]',
  sm: 'h-6 w-6 text-[11px]',
  md: 'h-8 w-8 text-xs',
  lg: 'h-10 w-10 text-sm',
  xl: 'h-16 w-16 text-xl',
};

/** Material 3 circular user avatar with primary-container initial fallback */
export function Avatar({
  name,
  avatarUrl,
  size = 'sm',
  active = false,
  className = '',
}: {
  name: string;
  avatarUrl?: string | null;
  size?: AvatarSize;
  active?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [avatarUrl]);

  const initial = (name.trim().charAt(0) || '?').toUpperCase();
  const ring = active ? 'ring-2 ring-accent ring-offset-2 ring-offset-surface' : '';

  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent-container font-semibold text-on-accent-container select-none ${SIZE_CLASSES[size]} ${ring} ${className}`}
      aria-hidden="true"
    >
      {avatarUrl && !failed ? (
        <img
          src={avatarUrl}
          alt={name}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span>{initial}</span>
      )}
    </span>
  );
}
