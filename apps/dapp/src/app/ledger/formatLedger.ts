/**
 * Groups the thousands of a ledger figure for reading ("1234567.80" to "1,234,567.80"). The
 * API sends figures as decimal strings with two fraction digits and the dapp does no
 * arithmetic on them. Anything that is not a plain decimal is returned unchanged.
 */
export function formatFigure(raw: string): string {
	const match = /^(\d+)(\.\d+)?$/.exec(raw);
	if (!match) return raw;
	return match[1].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (match[2] ?? '');
}

/** True for a figure that is zero ("0", "0.00"), so an empty state can say so in words. */
export function isZeroFigure(raw: string): boolean {
	return /^0+(\.0+)?$/.test(raw);
}

/** A wei amount the API sent as a decimal string, or undefined when it is not one. */
export function parseWei(raw: string): bigint | undefined {
	return /^\d{1,78}$/.test(raw) ? BigInt(raw) : undefined;
}

const UTC_DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const UTC_TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });

/** A unix time in seconds as "14 Nov 2026, 12:00 UTC": the record is the same instant for every visitor. */
export function formatUtc(timestampSeconds: number): string {
	const date = new Date(timestampSeconds * 1000);
	return `${UTC_DATE.format(date)}, ${UTC_TIME.format(date)} UTC`;
}
