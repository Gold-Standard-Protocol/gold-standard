/** The one line under an amount field that says why the action is not yet available. */
export function AmountReason({ id, reason }: { id: string; reason: string | undefined }) {
	if (!reason) return null;
	return (
		<p id={id} role="status" aria-live="polite" className="mt-2 text-xs leading-relaxed text-destructive">
			{reason}
		</p>
	);
}
