import { type FC, type ReactNode } from 'react';

interface ReadyProps {
  children: ReactNode;
  // tag: string
}
// If this gets mounted it sets checker approved to true
const Ready: FC<ReadyProps> = ({ children }) => {
  // const { setApproved } = useApprovedActions(tag)
  // const config = useConfig()

  // useEffect(() => {
  // 	setApproved(true)
  // 	return () => {
  // 		setApproved(false)
  // 	}
  // }, [setApproved])

  // useEffect(() => {
  // 	const unwatchAccountListener = watchAccount(config, {
  // 		onChange: () => {
  // 			setApproved(true)
  // 		},
  // 	})

  // 	return () => {
  // 		unwatchAccountListener()
  // 	}
  // }, [setApproved, config])

  return children;
};

export { Ready, type ReadyProps };
