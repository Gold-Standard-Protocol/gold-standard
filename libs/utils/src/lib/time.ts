import dayjs from 'dayjs'

export function inXMinutesUnix(x: number): number {
	return dayjs().add(x, 'minute').unix()
}
