import { useEffect, useState } from 'react';
import { type Hex } from 'viem';
import { useAccount, useBytecode } from 'wagmi';

/** How long a market swap signed from an ordinary wallet stays executable. */
export const SWAP_DEADLINE_SECONDS = 20 * 60;
/** A Safe proposes the swap and waits for its co-signers, so it gets a day. */
export const SAFE_SWAP_DEADLINE_SECONDS = 24 * 60 * 60;
/**
 * The deadline moves forward once per step rather than every render, so the arguments the
 * router call is simulated with stay put between steps and the request stays signable.
 */
export const SWAP_DEADLINE_STEP_SECONDS = 60;

/**
 * The unix time after which the router refuses the swap: the window counted from the start
 * of the current step, so it is never more than the window and never less than the window
 * minus one step away. Pure and exported for tests.
 */
export function swapDeadline(nowSeconds: number, windowSeconds: number): bigint {
	const stepStart = Math.floor(nowSeconds / SWAP_DEADLINE_STEP_SECONDS) * SWAP_DEADLINE_STEP_SECONDS;
	return BigInt(stepStart + windowSeconds);
}

/**
 * Whether bytecode at the connected address belongs to a contract account such as a Safe.
 * An EIP-7702 delegation (0xef0100 followed by an address) is an ordinary key that signs
 * alone, so it keeps the short window.
 */
export function isContractAccountCode(code: Hex | undefined): boolean {
	if (!code || code === '0x') return false;
	return !code.toLowerCase().startsWith('0xef0100');
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * The deadline for a market swap from the connected wallet.
 *
 * SwapRouter02 takes its deadline through multicall(deadline, data); without one a signed
 * swap that sat in the mempool, or in a Safe queue, could execute days later at whatever
 * the pool then paid down to the minimum. The window is 20 minutes, or 24 hours when the
 * account is a Safe: framed inside Safe{Wallet}, or any contract account reached through
 * WalletConnect, where co-signers need time.
 */
export function useSwapDeadline(): bigint {
	const { address, connector } = useAccount();
	const framedSafe = connector?.type === 'safe';
	const { data: code } = useBytecode({
		address,
		query: { enabled: !!address && !framedSafe, staleTime: Infinity },
	});
	const windowSeconds = framedSafe || isContractAccountCode(code) ? SAFE_SWAP_DEADLINE_SECONDS : SWAP_DEADLINE_SECONDS;

	const [now, setNow] = useState(nowSeconds);
	useEffect(() => {
		const untilNextStep = (SWAP_DEADLINE_STEP_SECONDS - (now % SWAP_DEADLINE_STEP_SECONDS)) * 1000;
		const timer = setTimeout(() => setNow(nowSeconds()), untilNextStep);
		// A background tab's timers are throttled; catch up the moment the page is seen again.
		const catchUp = () => {
			if (document.visibilityState === 'visible') setNow(nowSeconds());
		};
		document.addEventListener('visibilitychange', catchUp);
		return () => {
			clearTimeout(timer);
			document.removeEventListener('visibilitychange', catchUp);
		};
	}, [now]);

	return swapDeadline(now, windowSeconds);
}
