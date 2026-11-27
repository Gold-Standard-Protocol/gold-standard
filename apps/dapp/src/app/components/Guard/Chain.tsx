import { ChainId } from '@goldstandard/models'
import { Button, ButtonProps } from '@goldstandard/ui'
import { useState, type FC } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'

interface ChainProps extends ButtonProps {
	chainId: ChainId | undefined
}

/** A declined wallet prompt is a choice, not a fault: it is swallowed in silence. */
const isUserRejection = (error: unknown): boolean =>
	error instanceof Error && (error.name === 'UserRejectedRequestError' || /user rejected|denied/i.test(error.message))

export const Chain: FC<ChainProps> = ({
	children,
	fullWidth = true,
	size = 'lg',
	chainId,
	...props
}) => {
	const { chain } = useAccount()
	const { switchChainAsync } = useSwitchChain()
	const [failure, setFailure] = useState<string>()

	if (!chainId) {
		return null
	}

	if (chain?.id !== chainId) {
		const switchChain = async () => {
			setFailure(undefined)
			try {
				await switchChainAsync?.({ chainId })
			} catch (error: unknown) {
				if (!isUserRejection(error)) setFailure('Your wallet could not switch network. Switch to the right network in the wallet itself and try again.')
			}
		}
		return (
			<div className="flex flex-col gap-2">
				<Button fullWidth={fullWidth} size={size} onClick={() => void switchChain()} {...props}>
					Switch Chain
				</Button>
				{failure && (
					<p role="alert" className="text-sm leading-relaxed text-destructive">
						{failure}
					</p>
				)}
			</div>
		)
	}

	// If all is good then show the next guard (children);
	return children
}
