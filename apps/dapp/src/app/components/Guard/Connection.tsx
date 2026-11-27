import { useIsMounted } from "@goldstandard/hooks";
import { Button, ButtonProps, Dots } from "@goldstandard/ui";
import { type FC } from "react";
import { useAccount } from "wagmi";
import { ConnectButton } from "../ConnectButton";
import { useWalletUi } from "../../wallet/WalletUi";

export const Connection: FC<ButtonProps> = ({
  children,
  fullWidth = true,
  size = "lg",
  ...props
}) => {
  const isMounted = useIsMounted();
  const { isConnecting, isReconnecting, isDisconnected } = useAccount();
  const walletUi = useWalletUi();

  if (!isMounted) {
    return (
      <Button fullWidth={fullWidth} size={size} {...props}>
        <div className="h-[1ch]" />
      </Button>
    );
  }

  // While the wallet dialog has a request open, keep the very Connect button that opened
  // it (it shows its own busy state): replacing it would leave the dialog nowhere to
  // return focus when it closes.
  if (walletUi.pending) {
    return (
      <ConnectButton fullWidth={fullWidth} size={size} {...props}>
        Connect Wallet
      </ConnectButton>
    );
  }

  // Wagmi's "connecting" is not used here: it stays set while a cancelled browser wallet
  // prompt is still open, which would leave this button stuck.
  if (isReconnecting) {
    return (
      <Button fullWidth={fullWidth} size={size} disabled {...props}>
        <Dots>Checking Wallet</Dots>
      </Button>
    );
  }

  // Connecting outside an open dialog attempt (an abandoned prompt, or the first reconnect
  // check for a new visitor) offers Connect, never the action the guard protects.
  if (isDisconnected || isConnecting) {
    return (
      <ConnectButton fullWidth={fullWidth} size={size} {...props}>
        Connect Wallet
      </ConnectButton>
    );
  }

  // If all is good then show the next guard (children);
  return children;
};
