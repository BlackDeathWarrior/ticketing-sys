export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="10" fill="none" stroke="url(#logo-stroke)" strokeWidth="1.5" />
      <circle cx="16" cy="16" r="3" fill="#f4f0ff" />
      <circle cx="24.5" cy="9.5" r="1.75" fill="#f4f0ff" />
      <defs>
        <linearGradient id="logo-stroke" x1="0" y1="0" x2="32" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#e59cff" />
          <stop offset="0.5" stopColor="#ba9cff" />
          <stop offset="1" stopColor="#9cb2ff" />
        </linearGradient>
      </defs>
    </svg>
  );
}
