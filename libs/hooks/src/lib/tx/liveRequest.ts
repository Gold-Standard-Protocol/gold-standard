/** Structural equality over the values a contract call carries: bigints, strings, numbers, arrays and plain objects. */
export function sameArgs(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b || a === null || b === null) return false;
	if (typeof a !== 'object' || typeof b !== 'object') return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, index) => sameArgs(item, b[index]));
	}
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => sameArgs(left[key], right[key]));
}

interface SimulationLike<TRequest> {
	data: { request: TRequest } | undefined;
	isPlaceholderData: boolean;
}

interface RequestLike {
	args?: readonly unknown[] | undefined;
	value?: bigint | undefined;
}

/**
 * The simulated request that may be signed right now, or undefined.
 *
 * `simulateQuery` keeps the previous simulation as placeholder data so the Confirm button
 * does not flicker while a new one runs, but a placeholder is by definition a request for
 * the previous inputs: typing 5000 then 50 showed "Minting 50" while the wallet was asked
 * to sign mint(5000). So a placeholder is never signable, and even settled data must carry
 * the arguments and value parsed from the inputs as they stand now.
 */
export function liveRequest<TRequest extends RequestLike>(
	simulation: SimulationLike<TRequest>,
	expectedArgs: readonly unknown[] | undefined,
	expectedValue: bigint | undefined = undefined
): TRequest | undefined {
	if (!simulation.data || simulation.isPlaceholderData || expectedArgs === undefined) return undefined;
	const { request } = simulation.data;
	if (!sameArgs(request.args, expectedArgs)) return undefined;
	if ((request.value ?? 0n) !== (expectedValue ?? 0n)) return undefined;
	return request;
}
