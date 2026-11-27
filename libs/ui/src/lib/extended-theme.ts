import { type Config } from 'tailwindcss'

export const extendedTheme = {
	fontFamily: {
		sans: ['var(--font-sans)'],
		serif: ['var(--font-serif)'],
		mono: ['var(--font-mono)'],
	},
	backgroundColor: {
		'primary-gradient': 'hsla(var(--primary-gradient), 5, 50%)',
	},
	boxShadow: {
		xs: '0 1px 2px 0 hsl(40 14% 12% / 0.04)',
		sm: '0 1px 2px 0 hsl(40 14% 12% / 0.05), 0 1px 3px 0 hsl(40 14% 12% / 0.04)',
		card: '0 1px 2px hsl(40 14% 12% / 0.04), 0 8px 24px -12px hsl(40 14% 12% / 0.12)',
		lift: '0 2px 4px hsl(40 14% 12% / 0.05), 0 16px 40px -16px hsl(40 14% 12% / 0.22)',
	},
	colors: {
		gold: {
			'50': '#fafaec',
			'100': '#f3f3ce',
			'200': '#e8e5a0',
			'300': '#dad16a',
			'400': '#cebd41',
			'500': '#bfa833',
			'600': '#957a26',
			'700': '#846524',
			'800': '#6e5225',
			'900': '#5f4524',
			'950': '#372511',
		},
		border: 'hsl(var(--border) / <alpha-value>)',
		input: {
			DEFAULT: 'hsl(var(--input) / <alpha-value>)',
			invalid: 'hsl(var(--input-invalid) / <alpha-value>)',
		},
		ring: {
			DEFAULT: 'hsl(var(--ring) / <alpha-value>)',
			invalid: 'hsl(var(--foreground-destructive) / <alpha-value>)',
		},
		background: 'hsl(var(--background) / <alpha-value>)',
		foreground: {
			DEFAULT: 'hsl(var(--foreground) / <alpha-value>)',
			destructive: 'hsl(var(--foreground-destructive) / <alpha-value>)',
		},
		primary: {
			DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
			foreground: 'hsl(var(--primary-foreground) / <alpha-value>)',
		},
		secondary: {
			DEFAULT: 'hsl(var(--secondary) / <alpha-value>)',
			foreground: 'hsl(var(--secondary-foreground) / <alpha-value>)',
		},
		destructive: {
			DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
			foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)',
		},
		success: {
			DEFAULT: 'hsl(var(--success) / <alpha-value>)',
			foreground: 'hsl(var(--success-foreground) / <alpha-value>)',
			soft: 'hsl(var(--success-soft) / <alpha-value>)',
		},
		warning: {
			DEFAULT: 'hsl(var(--warning) / <alpha-value>)',
			foreground: 'hsl(var(--warning-foreground) / <alpha-value>)',
			soft: 'hsl(var(--warning-soft) / <alpha-value>)',
		},
		danger: {
			DEFAULT: 'hsl(var(--danger) / <alpha-value>)',
			foreground: 'hsl(var(--danger-foreground) / <alpha-value>)',
			soft: 'hsl(var(--danger-soft) / <alpha-value>)',
		},
		muted: {
			DEFAULT: 'hsl(var(--muted) / <alpha-value>)',
			foreground: 'hsl(var(--muted-foreground) / <alpha-value>)',
		},
		accent: {
			DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
			foreground: 'hsl(var(--accent-foreground) / <alpha-value>)',
		},
		popover: {
			DEFAULT: 'hsl(var(--popover) / <alpha-value>)',
			foreground: 'hsl(var(--popover-foreground) / <alpha-value>)',
		},
		card: {
			DEFAULT: 'hsl(var(--card) / <alpha-value>)',
			foreground: 'hsl(var(--card-foreground) / <alpha-value>)',
		},
	},
	borderColor: {
		DEFAULT: 'hsl(var(--border) / <alpha-value>)',
	},
	borderRadius: {
		'2xl': 'calc(var(--radius) + 8px)',
		xl: 'calc(var(--radius) + 4px)',
		lg: 'var(--radius)',
		md: 'calc(var(--radius) - 2px)',
		sm: 'calc(var(--radius) - 4px)',
	},
	fontSize: {
		// 1rem = 16px
		/** 80px size / 84px high / bold */
		mega: ['5rem', { lineHeight: '5.25rem', fontWeight: '700' }],
		/** 56px size / 62px high / bold */
		h1: ['3.5rem', { lineHeight: '3.875rem', fontWeight: '700' }],
		/** 40px size / 48px high / bold */
		h2: ['2.5rem', { lineHeight: '3rem', fontWeight: '700' }],
		/** 32px size / 36px high / bold */
		h3: ['2rem', { lineHeight: '2.25rem', fontWeight: '700' }],
		/** 28px size / 36px high / bold */
		h4: ['1.75rem', { lineHeight: '2.25rem', fontWeight: '700' }],
		/** 24px size / 32px high / bold */
		h5: ['1.5rem', { lineHeight: '2rem', fontWeight: '700' }],
		/** 16px size / 20px high / bold */
		h6: ['1rem', { lineHeight: '1.25rem', fontWeight: '700' }],

		/** 32px size / 36px high / normal */
		'body-2xl': ['2rem', { lineHeight: '2.25rem' }],
		/** 28px size / 36px high / normal */
		'body-xl': ['1.75rem', { lineHeight: '2.25rem' }],
		/** 24px size / 32px high / normal */
		'body-lg': ['1.5rem', { lineHeight: '2rem' }],
		/** 20px size / 28px high / normal */
		'body-md': ['1.25rem', { lineHeight: '1.75rem' }],
		/** 16px size / 20px high / normal */
		'body-sm': ['1rem', { lineHeight: '1.25rem' }],
		/** 14px size / 18px high / normal */
		'body-xs': ['0.875rem', { lineHeight: '1.125rem' }],
		/** 12px size / 16px high / normal */
		'body-2xs': ['0.75rem', { lineHeight: '1rem' }],

		/** 18px size / 24px high / semibold */
		caption: ['1.125rem', { lineHeight: '1.5rem', fontWeight: '600' }],
		/** 12px size / 16px high / bold */
		button: ['0.75rem', { lineHeight: '1rem', fontWeight: '700' }],
	},
} satisfies Config['theme']
