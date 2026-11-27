import { type ReactNode } from 'react';
import { TOKEN_LIST } from '@goldstandard/constants';

interface TokenPillProps {
	symbol: string;
	/** The token's own mark when the caller holds it; otherwise the token list's, by symbol. */
	image?: string;
	/** Shown after the symbol, such as the chevron of a token that can be changed. */
	trailing?: ReactNode;
	className?: string;
}

/**
 * The token named beside an amount field: its mark and its symbol. Every amount field names
 * its token with this one pill, at one size. The mark is decorative, since the symbol is the
 * name. A token that can be changed wraps the pill in a button (TokenInput).
 */
export function TokenPill({ symbol, image, trailing, className = '' }: TokenPillProps) {
	const mark = image ?? TOKEN_LIST.find((token) => token.symbol.toLowerCase() === symbol.toLowerCase())?.image;
	return (
		<span
			data-token-pill
			className={`flex shrink-0 items-center gap-2 rounded-full border border-border bg-card py-1 pr-3 text-sm font-medium ${mark ? 'pl-1' : 'pl-3'} ${className}`}
		>
			{mark && <img className="h-6 w-6 rounded-full" src={mark} alt="" />}
			{symbol}
			{trailing}
		</span>
	);
}
