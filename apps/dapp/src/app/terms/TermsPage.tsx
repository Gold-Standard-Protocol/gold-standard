import { Link } from 'react-router-dom';
import { SectionHeader } from '../components/marketing/Section';
import { TERMS_COPY } from '../content/terms';
import { Prose } from '../docs/components/DocComponents';
import { LEDGER_ENABLED } from '../ledger/ledgerFlag';
import { IS_MAINNET_BUILD } from '../lib/network';

const { software, isNot, risks, ownRisk, license, ledger } = TERMS_COPY;

/**
 * The terms as the project states them today: statements it already publishes elsewhere,
 * gathered on one page, the conditions on which the software is offered, and the Usage
 * Ledger clause the token policy makes part of them. Every word comes from content/terms.ts,
 * which names the source of each sourced statement.
 */
export default function TermsPage() {
	return (
		<div className="mx-auto w-full max-w-2xl animate-rise">
			<div className="mb-6">
				<SectionHeader title={TERMS_COPY.title} lead={TERMS_COPY.lead} as="h1" variant="stack" align="left" />
			</div>

			<Prose>
				<h2>{software.title}</h2>
				{software.statements.map((statement) => (
					<p key={statement.text}>{statement.text}</p>
				))}

				<h2>{isNot.title}</h2>
				<p>{isNot.lead}:</p>
				<ul>
					{isNot.items.map((item) => (
						<li key={item}>{item}</li>
					))}
				</ul>
				<p>{isNot.after.text}</p>

				<h2>{risks.title}</h2>
				<p>{risks.lead.text}</p>
				<ul>
					{risks.items.map((risk) => (
						<li key={risk.name}>
							<strong>{risk.name}</strong> {risk.text}
						</li>
					))}
				</ul>
				<p>
					{risks.experimental(!IS_MAINNET_BUILD)} {risks.others.text} Read{' '}
					{risks.readLinks.map((link, index) => (
						<span key={link.to}>
							<Link to={link.to}>{link.label}</Link>
							{index === 0 ? ', ' : index === 1 ? ' and ' : ' '}
						</span>
					))}
					{risks.readBefore}
				</p>
				<p>
					{risks.more} <Link to={risks.moreLink.to}>{risks.moreLink.label}</Link>
				</p>

				<h2 id="own-risk">{ownRisk.title}</h2>
				{ownRisk.statements.map((statement) => (
					<p key={statement}>{statement}</p>
				))}

				<h2 id="usage-ledger">{ledger.title}</h2>
				{ledger.statements.map((statement) => (
					<p key={statement.text}>{statement.text}</p>
				))}
				<p data-testid="terms-ledger-clause">
					<strong>{ledger.clause.text}</strong>
				</p>
				{LEDGER_ENABLED && (
					<p>
						<Link to={ledger.pageLink.to}>{ledger.pageLink.label}</Link>
					</p>
				)}

				<h2>{license.title}</h2>
				{license.statements.map((statement) => (
					<p key={statement.text}>{statement.text}</p>
				))}
			</Prose>
		</div>
	);
}
