import { Link } from 'react-router-dom';

/**
 * Brand hallmark: an octagonal bevelled gold assay seal struck with the alchemical
 * G glyph (central gold point and vertical mint axis). Pairs with the matching
 * octagonal GSUSD dollar seal used for the token itself.
 */
function BrandMark() {
  return (
    <svg
      width="36"
      height="36"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className="h-9 w-9 shrink-0"
    >
      <defs>
        <linearGradient
          id="gs-wordmark-face"
          x1="10"
          y1="8"
          x2="54"
          y2="56"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#C6982E" />
          <stop offset="52%" stopColor="#A67A1D" />
          <stop offset="100%" stopColor="#835D13" />
        </linearGradient>
        <linearGradient
          id="gs-wordmark-rim"
          x1="7.5"
          y1="7.5"
          x2="56.5"
          y2="56.5"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#FBF0C4" stopOpacity="0.65" />
          <stop offset="50%" stopColor="#E6C367" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#6B4A0D" stopOpacity="0.48" />
        </linearGradient>
      </defs>
      <polygon points="20,3 44,3 61,20 61,44 44,61 20,61 3,44 3,20" fill="#B68A25" />
      <polygon points="3,20 20,3 21.85,7.5 7.5,21.85" fill="#F7E29C" />
      <polygon points="20,3 44,3 42.15,7.5 21.85,7.5" fill="#EED077" />
      <polygon points="3,44 3,20 7.5,21.85 7.5,42.15" fill="#DBB856" />
      <polygon points="44,3 61,20 56.5,21.85 42.15,7.5" fill="#C99F3A" />
      <polygon points="20,61 3,44 7.5,42.15 21.85,56.5" fill="#A57B20" />
      <polygon points="61,20 61,44 56.5,42.15 56.5,21.85" fill="#946C18" />
      <polygon points="44,61 20,61 21.85,56.5 42.15,56.5" fill="#866114" />
      <polygon points="61,44 44,61 42.15,56.5 56.5,42.15" fill="#7C5912" />
      <polygon
        points="21.85,7.5 42.15,7.5 56.5,21.85 56.5,42.15 42.15,56.5 21.85,56.5 7.5,42.15 7.5,21.85"
        fill="url(#gs-wordmark-face)"
        stroke="url(#gs-wordmark-rim)"
        strokeWidth="1"
      />
      <g transform="translate(0 1)" fill="#4D3306" fillOpacity="0.26">
        <path d="M 43.22 21.16 A 15.6 15.6 0 1 0 47.42 29.65 L 38.2 29.65 L 38.2 34.35 L 42.34 34.35 A 10.6 10.6 0 1 1 39.63 24.64 Z" />
        <circle cx="32" cy="32" r="3.2" />
        <rect x="30.2" y="11.4" width="3.6" height="5.2" />
        <rect x="30.2" y="47.4" width="3.6" height="5.2" />
      </g>
      <g fill="#FFFFFF">
        <path d="M 43.22 21.16 A 15.6 15.6 0 1 0 47.42 29.65 L 38.2 29.65 L 38.2 34.35 L 42.34 34.35 A 10.6 10.6 0 1 1 39.63 24.64 Z" />
        <circle cx="32" cy="32" r="3.2" />
        <rect x="30.2" y="11.4" width="3.6" height="5.2" />
        <rect x="30.2" y="47.4" width="3.6" height="5.2" />
      </g>
    </svg>
  );
}

export function Wordmark() {
  return (
    <Link
      to="/"
      className="group flex min-h-11 items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      aria-label="Gold Standard home"
    >
      <BrandMark />
      <span className="flex flex-col leading-none">
        <span className="whitespace-nowrap font-serif text-[1.2rem] font-semibold tracking-tight text-foreground">
          Gold Standard
        </span>
        <span className="mt-0.5 hidden whitespace-nowrap text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground min-[420px]:block">
          Gold-backed · GSUSD
        </span>
      </span>
    </Link>
  );
}
